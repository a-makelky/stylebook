import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashKey } from "../src/actors";
import type { Env } from "../src/env";
import { emailFromAccessJwt, signAccessJwt, signInMode, verifiedEmail } from "../src/identity";
import { permit, type Action, type PermitInput } from "../src/permit";
import { STARTER_SKILL, STARTER_SKILL_PATH } from "../src/seed";
import { recordOperations } from "../src/usage";
import { FakeWorkspace } from "./fake-artifacts";
import { memoryD1 } from "./memory-d1";
import { serveWorker } from "./serve";

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "stylebook-test-audience";
const STARTER = "ada.north@stylebook.invalid";
const MEMBER = "member.north@stylebook.invalid";
const WAITING = "waiting.north@stylebook.invalid";
const SERVICE = "service.admin@stylebook.invalid";
const CANARY_LINE = "A line only the library should hold.";

function refused(result: { ok: true } | { ok: false; sentence: string }): string {
	return result.ok ? "" : result.sentence;
}

function keyPair(generated: CryptoKey | CryptoKeyPair): CryptoKeyPair {
	if (!("privateKey" in generated)) throw new Error("expected a key pair");
	return generated;
}

function person(role: "admin" | "member", extra: Partial<PermitInput> = {}): PermitInput {
	return {
		actor: { kind: "person", removedAt: null },
		role,
		action: "read",
		settings: { membersCanPublish: false, suspended: false },
		...extra,
	};
}

function cookie(response: Response, name: string): string {
	const cookies = response.headers.getSetCookie?.() ?? [];
	const match = cookies.find((item) => item.startsWith(`${name}=`));
	return (match ?? "").split(";")[0] ?? "";
}

function secretOf(header: string): string {
	const value = header.slice(header.indexOf("=") + 1);
	return decodeURIComponent(value);
}

describe("one permission function", () => {
	const off = { membersCanPublish: false, suspended: false };
	const on = { membersCanPublish: true, suspended: false };

	it("follows the roles table with the switch off and on", () => {
		const admin = person("admin", { settings: off, starter: true });
		const memberOff = person("member", { settings: off });
		const memberOn = person("member", { settings: on });
		const allowed = (input: PermitInput) => permit(input).ok;

		for (const action of ["read", "suggest", "connect-agent"] as Action[]) {
			expect(allowed({ ...admin, action })).toBe(true);
			expect(allowed({ ...memberOff, action })).toBe(true);
		}
		for (const action of ["publish", "decline", "combine", "keep"] as Action[]) {
			expect(allowed({ ...admin, action })).toBe(true);
			expect(allowed({ ...memberOff, action })).toBe(false);
			expect(refused(permit({ ...memberOff, action }))).toBe(
				"Only an Admin can publish here. You can suggest this change instead.",
			);
			expect(allowed({ ...memberOn, action })).toBe(true);
			expect(allowed({ ...memberOn, action, locked: true })).toBe(false);
			expect(refused(permit({ ...memberOn, action, locked: true }))).toBe("Only an Admin can publish a locked page.");
			expect(allowed({ ...admin, action, locked: true })).toBe(true);
		}
		expect(allowed({ ...admin, action: "lock" })).toBe(true);
		expect(allowed({ ...memberOn, action: "lock" })).toBe(false);
		expect(allowed({ ...admin, action: "unlock" })).toBe(true);
		expect(allowed({ ...memberOff, action: "rename-agent", own: true })).toBe(true);
		expect(allowed({ ...admin, action: "rename-agent", own: false })).toBe(false);
		expect(allowed({ ...memberOff, action: "revoke-agent", own: true })).toBe(true);
		expect(allowed({ ...memberOff, action: "revoke-agent", own: false })).toBe(false);
		expect(allowed({ ...admin, action: "revoke-agent", own: false })).toBe(true);
		for (const action of ["invite", "change-role", "remove-person", "rename-workspace", "members-can-publish"] as Action[]) {
			expect(allowed({ ...admin, action })).toBe(true);
			expect(allowed({ ...memberOn, action })).toBe(false);
		}
		expect(allowed({ ...admin, action: "change-role", targetStarter: true })).toBe(false);
		expect(allowed({ ...admin, action: "remove-person", targetStarter: true })).toBe(false);
		expect(allowed({ ...admin, action: "delete-workspace", starter: true })).toBe(true);
		expect(allowed({ ...admin, action: "delete-workspace", starter: false })).toBe(false);
		expect(allowed({ ...memberOn, action: "delete-workspace", starter: false })).toBe(false);
		expect(permit({ ...memberOff, action: "read", settings: { ...off, suspended: true } }).ok).toBe(true);
		expect(refused(permit({ ...admin, action: "publish", settings: { ...off, suspended: true } }))).toBe(
			"This workspace is read-only.",
		);
	});

	it("never lets an agent publish, decline, combine, invite, or change settings", () => {
		const agent = {
			actor: { kind: "agent" as const, removedAt: null },
			role: "admin" as const,
			settings: on,
			own: true,
			starter: true,
		};
		expect(permit({ ...agent, action: "read" }).ok).toBe(true);
		expect(permit({ ...agent, action: "suggest" }).ok).toBe(true);
		expect(refused(permit({ ...agent, action: "publish" }))).toBe("An agent cannot publish.");
		expect(refused(permit({ ...agent, action: "keep" }))).toBe("An agent cannot publish.");
		expect(refused(permit({ ...agent, action: "decline" }))).toBe("An agent cannot decline.");
		expect(refused(permit({ ...agent, action: "combine" }))).toBe("An agent cannot combine.");
		expect(refused(permit({ ...agent, action: "invite" }))).toBe("An agent cannot invite someone.");
		expect(refused(permit({ ...agent, action: "change-role" }))).toBe("An agent cannot invite someone.");
		expect(refused(permit({ ...agent, action: "lock" }))).toBe("An agent cannot change the workspace.");
		expect(refused(permit({ ...agent, action: "members-can-publish" }))).toBe("An agent cannot change the workspace.");
		expect(refused(permit({ ...agent, action: "delete-workspace" }))).toBe("An agent cannot change the workspace.");
		expect(refused(permit({ ...agent, role: "member", action: "publish", settings: on }))).toBe("An agent cannot publish.");
	});
});

describe("Access identity", () => {
	let privateKey: CryptoKey;
	let env: Env;

	beforeAll(async () => {
		const pair = keyPair(
			await crypto.subtle.generateKey(
				{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
				true,
				["sign", "verify"],
			),
		);
		privateKey = pair.privateKey;
		const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
		env = {
			WORKSPACE: {} as Artifacts,
			DB: {} as D1Database,
			SUGGESTIONS: {} as Env["SUGGESTIONS"],
			ARRIVALS: {} as Env["ARRIVALS"],
			SIGN_IN: "access",
			TEAM_DOMAIN: TEAM,
			POLICY_AUD: AUD,
			ACCESS_JWKS: JSON.stringify({ keys: [{ ...jwk, kid: "test", alg: "RS256", use: "sig" }] }),
			SERVICE_ADMINS: SERVICE,
		};
	});

	async function token(email: string, extra: Record<string, unknown> = {}): Promise<string> {
		return signAccessJwt(privateKey, "test", {
			email,
			iss: TEAM,
			aud: AUD,
			exp: Math.floor(Date.now() / 1000) + 600,
			...extra,
		});
	}

	it("trusts a signed token and ignores an unverified email header", async () => {
		expect(signInMode(env)).toBe("access");
		expect(signInMode({ ...env, SIGN_IN: undefined })).toBe("link");
		const jwt = await token(STARTER);
		expect(await emailFromAccessJwt(jwt, env)).toBe(STARTER);
		const request = new Request("https://stylebook.test/enter", {
			headers: { "Cf-Access-Authenticated-User-Email": STARTER },
		});
		expect(await verifiedEmail(request, env)).toBeNull();
		expect(await verifiedEmail(new Request("https://stylebook.test/enter", { headers: { "Cf-Access-Jwt-Assertion": jwt } }), env)).toBe(
			STARTER,
		);
		const flipped = jwt.slice(0, -4) + (jwt.endsWith("aaaa") ? "bbbb" : "aaaa");
		expect(await emailFromAccessJwt(flipped, env)).toBeNull();
		expect(await emailFromAccessJwt(await token(STARTER, { aud: "other" }), env)).toBeNull();
		expect(await emailFromAccessJwt(await token(STARTER, { iss: "https://other.example" }), env)).toBeNull();
		expect(await emailFromAccessJwt(await token(STARTER, { exp: Math.floor(Date.now() / 1000) - 120 }), env)).toBeNull();
		const identity = await verifiedEmail(new Request("https://stylebook.test/enter"), env, {
			access: { async getIdentity() { return { email: "From.Access@Stylebook.invalid" }; } },
		});
		expect(identity).toBe("from.access@stylebook.invalid");
	});
});

describe("roles on the screen, the Git route, and MCP", () => {
	let workspace: FakeWorkspace;
	let db: D1Database;
	let origin = "";
	let close: () => Promise<void> = async () => {};
	let privateKey: CryptoKey;
	const env: Env = {
		WORKSPACE: {} as Artifacts,
		DB: {} as D1Database,
		SUGGESTIONS: {} as Env["SUGGESTIONS"],
		ARRIVALS: {} as Env["ARRIVALS"],
		DEMO_KEY: "secret",
		SIGN_IN: "access",
		TEAM_DOMAIN: TEAM,
		POLICY_AUD: AUD,
		SERVICE_ADMINS: SERVICE,
		MAX_WORKSPACES: "40",
		MAX_PEOPLE: "25",
		MAX_AGENTS: "40",
		MAX_OPEN_SUGGESTIONS: "200",
		EMAIL: {
			async send() {
				throw new Error("email links are switched off");
			},
		},
	};
	let starterCookie = "";
	let memberCookie = "";
	let library = "";
	let agentKey = "";
	let memberId = "";
	let suggestionCopy = "";

	beforeAll(async () => {
		const pair = keyPair(
			await crypto.subtle.generateKey(
				{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
				true,
				["sign", "verify"],
			),
		);
		privateKey = pair.privateKey;
		const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
		env.ACCESS_JWKS = JSON.stringify({ keys: [{ ...jwk, kid: "test", alg: "RS256", use: "sig" }] });
		workspace = await FakeWorkspace.start();
		db = memoryD1();
		env.WORKSPACE = workspace.binding;
		env.DB = db;
		const server = await serveWorker(env);
		origin = server.url;
		close = server.close;
	});

	afterAll(async () => {
		await close();
		await workspace.stop();
	});

	async function jwt(email: string): Promise<string> {
		return signAccessJwt(privateKey, "test", {
			email,
			iss: TEAM,
			aud: AUD,
			exp: Math.floor(Date.now() / 1000) + 600,
		});
	}

	function form(path: string, body: string, session = "", method = "POST"): Promise<Response> {
		return fetch(`${origin}${path}`, {
			method,
			redirect: "manual",
			headers: {
				...(session ? { Cookie: session } : {}),
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body,
		});
	}

	async function enter(email: string): Promise<Response> {
		return fetch(`${origin}/enter`, {
			redirect: "manual",
			headers: { "Cf-Access-Jwt-Assertion": await jwt(email) },
		});
	}

	async function mcp(key: string, name: string, args: Record<string, unknown> = {}) {
		const response = await fetch(`${origin}/mcp`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
		});
		const body = (await response.json()) as { result: { content: { text: string }[]; isError: boolean } };
		return body.result.content[0]?.text ?? "";
	}

	async function gitWrite(key: string): Promise<string> {
		const response = await fetch(`${origin}/git/${library}.git/git-receive-pack`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/x-git-receive-pack-request",
			},
			body: "0000",
		});
		return `${response.status} ${await response.text()}`;
	}

	async function gitAccess(key: string, write: boolean): Promise<string> {
		const response = await fetch(`${origin}/git/access`, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ name: library, write }),
		});
		return `${response.status} ${await response.text()}`;
	}

	it("keeps the landing, health, MCP, and Git route public", async () => {
		const landing = await fetch(`${origin}/`);
		expect(landing.status).toBe(200);
		const landingHtml = await landing.text();
		expect(landingHtml).toContain("Sign in");
		expect(landingHtml).toContain('href="/enter"');
		expect(landingHtml).toContain("Try the demo");
		expect(landingHtml).not.toContain("Sign out");
		const health = await fetch(`${origin}/health`);
		expect(health.status).toBe(200);
		const mcpOpen = await fetch(`${origin}/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		});
		expect(mcpOpen.status).toBe(200);
		const gitOpen = await fetch(`${origin}/git/missing-library.git/info/refs?service=git-upload-pack`);
		expect(gitOpen.status).toBe(401);
		expect(await gitOpen.text()).toContain("Missing or unknown key");
		const mailed = await form("/sign-in", "email=ada.north@stylebook.invalid");
		expect(mailed.status).toBe(404);
		expect(await mailed.text()).toContain("Sign in");
	});

	it("maps a verified email to a workspace, an invitation, or a start", async () => {
		const unsigned = await fetch(`${origin}/enter`, {
			headers: { "Cf-Access-Authenticated-User-Email": STARTER },
		});
		expect(unsigned.status).toBe(401);
		const arrived = await enter(STARTER);
		expect(arrived.status).toBe(200);
		const arrivedHtml = await arrived.text();
		expect(arrivedHtml).toContain("Start a workspace");
		const seen = cookie(arrived, "stylebook_seen");
		expect(seen.startsWith("stylebook_seen=")).toBe(true);
		const started = await form("/start", "workspace=Northwind", seen);
		expect(started.status).toBe(303);
		starterCookie = cookie(started, "stylebook");
		expect(starterCookie.startsWith("stylebook=")).toBe(true);
		const home = await fetch(`${origin}/`, { headers: { Cookie: starterCookie } });
		const homeHtml = await home.text();
		expect(homeHtml).toContain("Northwind");
		expect(homeHtml).toContain("Interview to draft");
		expect(homeHtml).toContain('href="/people">People</a>');
		const startedRow = await db
			.prepare(`SELECT id FROM workspaces WHERE name = ?1 AND deleted_at IS NULL`)
			.bind("Northwind")
			.first<{ id: string }>();
		library = `${startedRow?.id ?? ""}-library`;
		expect(library.endsWith("-library")).toBe(true);
		expect(library).not.toBe("-library");

		const invited = await form("/invite", `email=${encodeURIComponent(MEMBER)}&role=member`, starterCookie);
		const invitedHtml = await invited.text();
		expect(invitedHtml).toContain("They will join when they sign in.");
		expect(invitedHtml).toContain(MEMBER);
		expect(invitedHtml).toContain("Started this workspace");
		expect(invitedHtml).not.toContain("Send an invite");
		const waiting = await form("/invite", `email=${encodeURIComponent(WAITING)}&role=admin`, starterCookie);
		const waitingHtml = await waiting.text();
		expect(waitingHtml).toContain(WAITING);
		const peopleHtml = waitingHtml.includes("invitations/cancel")
			? waitingHtml
			: await (await fetch(`${origin}/people`, { headers: { Cookie: starterCookie } })).text();
		const waitingId = [...peopleHtml.matchAll(/action="\/invitations\/cancel"><input type="hidden" name="id" value="([^"]+)"/g)].at(-1)?.[1] ?? "";
		expect(waitingId).not.toBe("");
		const cancelled = await form("/invitations/cancel", `id=${encodeURIComponent(waitingId)}`, starterCookie);
		const afterCancel = await cancelled.text();
		expect(afterCancel).not.toContain(WAITING);
		expect(afterCancel).toContain(MEMBER);

		const memberArrived = await enter(MEMBER);
		const memberHtml = await memberArrived.text();
		expect(memberHtml).toContain("You have an invitation to Northwind.");
		const memberSeen = cookie(memberArrived, "stylebook_seen");
		const joined = await form("/join", `workspace=${encodeURIComponent(library.replace(/-library$/, ""))}`, memberSeen);
		expect(joined.status).toBe(303);
		memberCookie = cookie(joined, "stylebook");
		const memberHome = await (await fetch(`${origin}/people`, { headers: { Cookie: memberCookie } })).text();
		expect(memberHome).toContain(MEMBER);
		expect(memberHome).toContain("Member");
		expect(memberHome).not.toContain("Change role");
		expect(memberHome).not.toContain(">Invite<");
		expect(memberHome).not.toContain("Members can publish");
		expect(memberHome).toContain("Connect your AI tools");

		const again = await enter(STARTER);
		expect(again.status).toBe(200);
		expect(await again.text()).toContain('http-equiv="refresh"');
		expect(cookie(again, "stylebook").startsWith("stylebook=")).toBe(true);

		const signedOut = await form("/sign-out", "", starterCookie);
		expect(signedOut.status).toBe(303);
		expect(signedOut.headers.get("Location")).toBe(`${TEAM}/cdn-cgi/access/logout`);
		const returned = await enter(STARTER);
		starterCookie = cookie(returned, "stylebook");
	});

	it("rejects a state-changing post from another site", async () => {
		const id = library.replace(/-library$/, "");
		const adminHeaders = {
			"Cf-Access-Jwt-Assertion": await jwt(SERVICE),
			"Content-Type": "application/x-www-form-urlencoded",
		};
		const byOrigin = await fetch(`${origin}/admin`, {
			method: "POST",
			redirect: "manual",
			headers: { ...adminHeaders, Origin: "https://evil.example" },
			body: `workspace=${encodeURIComponent(id)}&action=delete&confirm=${encodeURIComponent(id)}`,
		});
		expect(byOrigin.status).toBe(403);
		expect(await byOrigin.text()).toContain("That request came from another site.");
		const bySite = await fetch(`${origin}/admin`, {
			method: "POST",
			redirect: "manual",
			headers: { ...adminHeaders, "Sec-Fetch-Site": "cross-site" },
			body: `workspace=${encodeURIComponent(id)}&action=suspend&suspended=no`,
		});
		expect(bySite.status).toBe(403);
		expect(await bySite.text()).toContain("That request came from another site.");
		const settings = await fetch(`${origin}/settings`, {
			method: "POST",
			headers: {
				Cookie: starterCookie,
				"Content-Type": "application/x-www-form-urlencoded",
				Origin: "https://evil.example",
			},
			body: "name=Hijacked&members_can_publish=yes",
		});
		expect(settings.status).toBe(403);
		expect(await settings.text()).toContain("That request came from another site.");
		const otherSite = await fetch(`${origin}/invite`, {
			method: "POST",
			headers: {
				Cookie: starterCookie,
				"Content-Type": "application/x-www-form-urlencoded",
				"Sec-Fetch-Site": "same-site",
			},
			body: "email=forged.north@stylebook.invalid&role=admin",
		});
		expect(otherSite.status).toBe(403);
		const allowed = await fetch(`${origin}/invitations/cancel`, {
			method: "POST",
			headers: {
				Cookie: starterCookie,
				"Content-Type": "application/x-www-form-urlencoded",
				Origin: origin,
				"Sec-Fetch-Site": "same-origin",
			},
			body: "id=missing",
		});
		expect(allowed.status).toBe(200);
		expect(await allowed.text()).toContain("That invitation is not waiting.");
		const home = await (await fetch(`${origin}/`, { headers: { Cookie: starterCookie } })).text();
		expect(home).toContain("Northwind");
		expect(home).not.toContain("Hijacked");
		const forged = await db
			.prepare(`SELECT id FROM invitations WHERE email = ?1 AND cancelled_at IS NULL AND accepted_at IS NULL`)
			.bind("forged.north@stylebook.invalid")
			.first<{ id: string }>();
		expect(forged).toBeNull();
	});

	it("lets a member join a second workspace and switch between both", async () => {
		const straight = await enter(MEMBER);
		expect(straight.status).toBe(200);
		expect(await straight.text()).toContain('http-equiv="refresh"');
		expect(cookie(straight, "stylebook").startsWith("stylebook=")).toBe(true);
		const host = "east.host@stylebook.invalid";
		const arrived = await enter(host);
		const seen = cookie(arrived, "stylebook_seen");
		const started = await form("/start", "workspace=Eastwind", seen);
		expect(started.status).toBe(303);
		const hostCookie = cookie(started, "stylebook");
		const invited = await form("/invite", `email=${encodeURIComponent(MEMBER)}&role=member`, hostCookie);
		expect(await invited.text()).toContain("They will join when they sign in.");
		const chooser = await enter(MEMBER);
		expect(chooser.status).toBe(200);
		const chooserHtml = await chooser.text();
		expect(chooserHtml).toContain("Open Northwind");
		expect(chooserHtml).toContain("Join Eastwind");
		const eastId = chooserHtml.match(/action="\/join"><input type="hidden" name="workspace" value="([^"]+)"/)?.[1] ?? "";
		expect(eastId).not.toBe("");
		const joined = await form("/join", `workspace=${encodeURIComponent(eastId)}`, cookie(chooser, "stylebook_choose"));
		expect(joined.status).toBe(303);
		const eastCookie = cookie(joined, "stylebook");
		const eastPeople = await (await fetch(`${origin}/people`, { headers: { Cookie: eastCookie } })).text();
		expect(eastPeople).toContain("Eastwind");
		expect(eastPeople).toContain(MEMBER);
		const northId = library.replace(/-library$/, "");
		const back = await enter(MEMBER);
		const backHtml = await back.text();
		expect(backHtml).toContain("Open Northwind");
		expect(backHtml).toContain("Open Eastwind");
		expect(backHtml).not.toContain("Join Eastwind");
		const openedNorth = await form("/choose", `workspace=${encodeURIComponent(northId)}`, cookie(back, "stylebook_choose"));
		expect(openedNorth.status).toBe(303);
		const northPeople = await (await fetch(`${origin}/people`, { headers: { Cookie: cookie(openedNorth, "stylebook") } })).text();
		expect(northPeople).toContain("Northwind");
		expect(northPeople).not.toContain("Eastwind");
		const again = await enter(MEMBER);
		const openedEast = await form("/choose", `workspace=${encodeURIComponent(eastId)}`, cookie(again, "stylebook_choose"));
		expect(openedEast.status).toBe(303);
		const switched = await (await fetch(`${origin}/people`, { headers: { Cookie: cookie(openedEast, "stylebook") } })).text();
		expect(switched).toContain("Eastwind");
		expect(switched).not.toContain("Northwind");
	});

	it("enforces invite, role, remove, and the starter", async () => {
		const people = await (await fetch(`${origin}/people`, { headers: { Cookie: starterCookie } })).text();
		memberId = people.match(/action="\/people\/remove"><input type="hidden" name="id" value="([^"]+)"/)?.[1] ?? "";
		expect(memberId).not.toBe("");
		expect(people).toContain('onchange="this.form.requestSubmit()"');
		expect(people).not.toContain("Change role");
		const promoted = await form("/people/role", `id=${encodeURIComponent(memberId)}&role=admin`, starterCookie);
		expect(await promoted.text()).toContain("Member North is now an Admin.");
		const demoted = await form("/people/role", `id=${encodeURIComponent(memberId)}&role=member`, starterCookie);
		expect(await demoted.text()).toContain("Member North is now a Member.");
		expect(people).not.toMatch(/Started this workspace[\s\S]{0,200}Change role/);
		const selfRow = await db.prepare(`SELECT id FROM actors WHERE email = ?1 AND removed_at IS NULL`).bind(STARTER).first<{ id: string }>();
		const self = selfRow?.id ?? "";
		expect(self).not.toBe("");
		const demoteStarter = await form("/people/role", `id=${encodeURIComponent(self)}&role=member`, starterCookie);
		expect(await demoteStarter.text()).toContain("The person who started this workspace stays an Admin.");
		const removeStarter = await form("/people/remove", `id=${encodeURIComponent(self)}`, starterCookie);
		expect(await removeStarter.text()).toContain("The person who started this workspace cannot be removed.");
		const memberInvite = await form("/invite", `email=other.north@stylebook.invalid&role=member`, memberCookie);
		expect(await memberInvite.text()).toContain("Only an Admin can invite someone.");
		const memberRole = await form("/people/role", `id=${encodeURIComponent(memberId)}&role=admin`, memberCookie);
		expect(await memberRole.text()).toContain("Only an Admin can change a role.");
		const memberRemove = await form("/people/remove", `id=${encodeURIComponent(memberId)}`, memberCookie);
		expect(await memberRemove.text()).toContain("Only an Admin can remove someone.");
		const memberSettings = await form("/settings", "name=Renamed&members_can_publish=yes", memberCookie);
		expect(await memberSettings.text()).toContain("Only an Admin can change this workspace.");
		const memberDelete = await form("/workspace/delete", "name=Northwind", memberCookie);
		expect(await memberDelete.text()).toContain("Only the person who started this workspace can delete it.");
		const wrongName = await form("/workspace/delete", "name=Nope", starterCookie);
		expect(await wrongName.text()).toContain("Type the workspace name to delete it.");
	});

	it("keeps publish, decline, combine, lock, and Git writes to the role", async () => {
		const connected = await form("/agents", "name=Researcher&tool=cursor", starterCookie);
		const connectedHtml = await connected.text();
		agentKey = connectedHtml.match(/<code>([0-9a-f]{64})<\/code>/)?.[1] ?? "";
		expect(agentKey).toHaveLength(64);
		expect(connectedHtml).toContain("Cursor");
		expect(connectedHtml).toContain("Researcher");

		const suggested = await mcp(agentKey, "suggest_change", {
			path: STARTER_SKILL_PATH,
			content: `${STARTER_SKILL}\n\n${CANARY_LINE}\n`,
			why: "A closing line.",
			session: "roles",
		});
		const copy = suggested.match(/Saved suggestion (\S+)/)?.[1] ?? "";
		suggestionCopy = copy;
		expect(copy).not.toBe("");

		for (const name of ["publish", "decline", "combine", "invite"] as const) {
			const text = await mcp(agentKey, name, { path: STARTER_SKILL_PATH });
			expect(text).toMatch(/An agent cannot/);
		}
		expect(await mcp(agentKey, "list_library")).toContain(STARTER_SKILL_PATH);
		expect(await mcp(secretOf(memberCookie), "publish", { path: STARTER_SKILL_PATH })).toContain(
			"Only an Admin can publish here.",
		);
		expect(await mcp(secretOf(memberCookie), "invite")).toContain("Only an Admin can invite someone.");
		expect(await mcp(secretOf(starterCookie), "publish", { path: STARTER_SKILL_PATH })).toBe("Do that from the page.");

		const publishBody = `item=${encodeURIComponent(STARTER_SKILL_PATH)}&suggestion=${encodeURIComponent(copy)}`;
		const memberPublish = await form("/publish", publishBody, memberCookie);
		expect(memberPublish.status).toBe(403);
		expect(await memberPublish.text()).toContain("Only an Admin can publish here. You can suggest this change instead.");
		const agentPublish = await form("/publish", publishBody, `stylebook=${agentKey}`);
		expect(await agentPublish.text()).toContain("An agent cannot publish.");
		const agentDecline = await form("/decline", publishBody, `stylebook=${agentKey}`);
		expect(await agentDecline.text()).toContain("An agent cannot decline.");
		const agentCombine = await form(
			"/resolve",
			`${publishBody}&mode=combine`,
			`stylebook=${agentKey}`,
		);
		expect(await agentCombine.text()).toContain("An agent cannot combine.");
		const agentInvite = await form("/invite", "email=a@stylebook.invalid&role=member", `stylebook=${agentKey}`);
		expect(await agentInvite.text()).toContain("An agent cannot invite someone.");
		const agentSettings = await form("/settings", "name=Northwind&members_can_publish=yes", `stylebook=${agentKey}`);
		expect(await agentSettings.text()).toContain("An agent cannot change the workspace.");
		const memberLock = await form("/lock", `item=${encodeURIComponent(STARTER_SKILL_PATH)}`, memberCookie);
		expect((memberLock.headers.get("Location") ?? "").replace(/\+/g, " ")).toContain("Only an Admin can lock a page.");

		expect(await gitWrite(agentKey)).toContain("An agent cannot publish.");
		expect(await gitAccess(agentKey, true)).toContain("An agent cannot publish.");
		expect(await gitWrite(secretOf(memberCookie))).toContain("Only an Admin can publish here.");
		expect(await gitAccess(secretOf(memberCookie), true)).toContain("Only an Admin can publish here.");
		const read = await fetch(`${origin}/git/${library}.git/info/refs?service=git-upload-pack`, {
			headers: { Authorization: `Bearer ${agentKey}` },
		});
		expect(read.status).not.toBe(403);

		const saved = await form(
			"/settings",
			"name=Northwind&members_can_publish=yes",
			starterCookie,
		);
		expect(await saved.text()).toContain("When this is off, members suggest and an Admin publishes.");
		expect(await mcp(secretOf(memberCookie), "decline", { path: STARTER_SKILL_PATH })).toBe("Do that from the page.");
		const memberNow = await form("/publish", publishBody, memberCookie);
		expect(memberNow.status).toBe(303);

		const locked = await form("/lock", `item=${encodeURIComponent(STARTER_SKILL_PATH)}`, starterCookie);
		expect(locked.status).toBe(303);
		const page = await (await fetch(`${origin}/?item=${encodeURIComponent(STARTER_SKILL_PATH)}`, { headers: { Cookie: starterCookie } })).text();
		expect(page).toContain("Locked");
		expect(page).toContain(".ways { display: flex; flex-direction: column;");
		expect(page).toContain("@media (min-width: 1100px)");
		expect(page).toContain(".ways { flex-direction: row; align-items: stretch; }");

		const second = await mcp(agentKey, "suggest_change", {
			path: STARTER_SKILL_PATH,
			content: `${STARTER_SKILL}\n\n${CANARY_LINE}\nAnother line.\n`,
			why: "A second line.",
			session: "roles-two",
		});
		const secondCopy = second.match(/Saved suggestion (\S+)/)?.[1] ?? "";
		const blocked = await form(
			"/publish",
			`item=${encodeURIComponent(STARTER_SKILL_PATH)}&suggestion=${encodeURIComponent(secondCopy)}`,
			memberCookie,
		);
		expect(await blocked.text()).toContain("Only an Admin can publish a locked page.");
		expect(await gitWrite(secretOf(memberCookie))).toContain("Only an Admin can publish a locked page.");
		expect(await gitAccess(secretOf(memberCookie), true)).toContain("Only an Admin can publish a locked page.");
		const adminWrite = await gitWrite(secretOf(starterCookie));
		expect(adminWrite).not.toContain("Only an Admin");
		expect(adminWrite).not.toContain("An agent cannot");
		const adminAccess = await gitAccess(secretOf(starterCookie), true);
		expect(adminAccess.startsWith("200")).toBe(true);

		const memberPage = await (await fetch(`${origin}/?item=${encodeURIComponent(STARTER_SKILL_PATH)}`, { headers: { Cookie: memberCookie } })).text();
		expect(memberPage).toContain("Locked");
		expect(memberPage).not.toContain("Lock this page");
	});

	it("refuses a suspended agent's write to its own suggestion", async () => {
		expect(suggestionCopy).toContain("-sug-");
		const id = library.replace(/-library$/, "");
		const headers = {
			"Cf-Access-Jwt-Assertion": await jwt(SERVICE),
			"Content-Type": "application/x-www-form-urlencoded",
		};
		const suspend = await fetch(`${origin}/admin`, {
			method: "POST",
			redirect: "manual",
			headers,
			body: `workspace=${encodeURIComponent(id)}&action=suspend&suspended=no`,
		});
		expect(suspend.status).toBe(303);
		const pushed = await fetch(`${origin}/git/${suggestionCopy}.git/git-receive-pack`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${agentKey}`,
				"Content-Type": "application/x-git-receive-pack-request",
			},
			body: "0000",
		});
		expect(pushed.status).toBe(403);
		expect(await pushed.text()).toContain("This workspace is read-only.");
		const access = await fetch(`${origin}/git/access`, {
			method: "POST",
			headers: { Authorization: `Bearer ${agentKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({ name: suggestionCopy, write: true }),
		});
		expect(access.status).toBe(403);
		expect(await access.text()).toContain("This workspace is read-only.");
		const resume = await fetch(`${origin}/admin`, {
			method: "POST",
			redirect: "manual",
			headers,
			body: `workspace=${encodeURIComponent(id)}&action=suspend&suspended=yes`,
		});
		expect(resume.status).toBe(303);
	});

	it("lists workspaces for a service admin without names, emails, or library text", async () => {
		const id = library.replace(/-library$/, "");
		await recordOperations(db, id, "read", 12_000);
		const denied = await fetch(`${origin}/admin`, { headers: { "Cf-Access-Jwt-Assertion": await jwt(STARTER) } });
		expect(denied.status).toBe(404);
		expect(await denied.text()).not.toContain("Northwind");
		const admin = await fetch(`${origin}/admin`, { headers: { "Cf-Access-Jwt-Assertion": await jwt(SERVICE) } });
		expect(admin.status).toBe(200);
		const html = await admin.text();
		expect(html).not.toContain("Northwind");
		expect(html).not.toContain("Eastwind");
		expect(html).not.toContain("Spare");
		expect(html).toContain(id);
		expect(html).toContain("Type the workspace id");
		expect(html).toContain("2 people");
		expect(html).toContain("1 agent");
		expect(html).toMatch(/\$0\.\d{2}/);
		expect(html).toContain("signed in this month");
		expect(html).not.toContain(STARTER);
		expect(html).not.toContain(MEMBER);
		expect(html).not.toContain("Ada North");
		expect(html).not.toContain("Member North");
		expect(html).not.toContain(CANARY_LINE);
		expect(html).not.toContain("Interview to draft");
		expect(html).not.toContain(SERVICE);

		const limits = await fetch(`${origin}/admin`, {
			method: "POST",
			redirect: "manual",
			headers: {
				"Cf-Access-Jwt-Assertion": await jwt(SERVICE),
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: `workspace=${encodeURIComponent(id)}&action=limits&people=3&agents=4&suggestions=5`,
		});
		expect(limits.status).toBe(303);
		const suspended = await fetch(`${origin}/admin`, {
			method: "POST",
			redirect: "manual",
			headers: {
				"Cf-Access-Jwt-Assertion": await jwt(SERVICE),
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: `workspace=${encodeURIComponent(id)}&action=suspend&suspended=no`,
		});
		expect(suspended.status).toBe(303);
		const quiet = await form("/publish", `item=${encodeURIComponent(STARTER_SKILL_PATH)}&suggestion=missing`, starterCookie);
		expect(await quiet.text()).toContain("This workspace is read-only.");
		await fetch(`${origin}/admin`, {
			method: "POST",
			redirect: "manual",
			headers: {
				"Cf-Access-Jwt-Assertion": await jwt(SERVICE),
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: `workspace=${encodeURIComponent(id)}&action=suspend&suspended=yes`,
		});

		for (let n = 0; n < 40; n++) {
			await db.prepare(`INSERT OR IGNORE INTO sign_ins (email_hash, month) VALUES (?1, ?2)`).bind(`hash-${n}`, new Date().toISOString().slice(0, 7)).run();
		}
		const warned = await (await fetch(`${origin}/admin`, { headers: { "Cf-Access-Jwt-Assertion": await jwt(SERVICE) } })).text();
		expect(warned).toContain("plans to host sign-in itself");
		expect(warned).toContain("Changed the limits.");
		expect(warned).toContain("Suspended the workspace.");
		expect(warned).not.toContain(STARTER);

		const spareEmail = "spare.north@stylebook.invalid";
		const spareArrived = await enter(spareEmail);
		const spareSeen = cookie(spareArrived, "stylebook_seen");
		const spareStarted = await form("/start", "workspace=Spare", spareSeen);
		expect(spareStarted.status).toBe(303);
		const spareCookie = cookie(spareStarted, "stylebook");
		const spareHome = await fetch(`${origin}/`, { headers: { Cookie: spareCookie } });
		expect(spareHome.status).toBe(200);
		const spareRow = await db.prepare(`SELECT id FROM workspaces WHERE name = ?1 AND deleted_at IS NULL`).bind("Spare").first<{ id: string }>();
		const spareId = spareRow?.id ?? "";
		expect(spareId).not.toBe("");
		const beforeDelete = await env.WORKSPACE.list({ limit: 200 });
		expect(beforeDelete.repos.some((repo) => repo.name === `${spareId}-library`)).toBe(true);
		const named = await fetch(`${origin}/admin`, {
			method: "POST",
			redirect: "manual",
			headers: {
				"Cf-Access-Jwt-Assertion": await jwt(SERVICE),
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: `workspace=${encodeURIComponent(spareId)}&action=delete&confirm=Spare`,
		});
		expect(named.status).toBe(400);
		const namedHtml = await named.text();
		expect(namedHtml).toContain("Type the workspace id to delete it.");
		expect(namedHtml).not.toContain("Spare");
		const removed = await fetch(`${origin}/admin`, {
			method: "POST",
			redirect: "manual",
			headers: {
				"Cf-Access-Jwt-Assertion": await jwt(SERVICE),
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: `workspace=${encodeURIComponent(spareId)}&action=delete&confirm=${encodeURIComponent(spareId)}`,
		});
		expect(removed.status).toBe(303);
		const afterDelete = await env.WORKSPACE.list({ limit: 200 });
		expect(afterDelete.repos.some((repo) => repo.name.startsWith(`${spareId}-`))).toBe(false);
		const after = await (await fetch(`${origin}/admin`, { headers: { "Cf-Access-Jwt-Assertion": await jwt(SERVICE) } })).text();
		expect(after).toContain("Deleted the workspace.");
		expect(after).not.toContain("Spare");
		expect(after).not.toContain(spareEmail);
		const gone = await fetch(`${origin}/`, { headers: { Cookie: spareCookie } });
		const goneHtml = await gone.text();
		expect(goneHtml).toContain("Sign in");
		expect(goneHtml).toContain("Try the demo");
		expect(goneHtml).not.toContain("Spare");
		expect(goneHtml).not.toContain("Sign out");
		const auditRows = await db
			.prepare(`SELECT action, actor_hash, detail FROM service_audit`)
			.bind()
			.all<{ action: string; actor_hash: string | null; detail: string }>();
		const rows = auditRows.results ?? [];
		expect(rows.length).toBeGreaterThan(0);
		const actorHash = await hashKey(SERVICE);
		for (const row of rows) {
			expect(row.actor_hash).toBe(actorHash);
			expect(row.detail.includes("@")).toBe(false);
		}
		expect(rows.map((row) => row.action).sort()).toEqual(
			expect.arrayContaining(["limits", "suspend", "resume", "delete"]),
		);
	});
});
