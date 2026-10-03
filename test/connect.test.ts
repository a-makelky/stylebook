import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerActor } from "../src/actors";
import { displayServerName, parseTeamConnections, publicServerUrl, toolLabel } from "../src/catalog";
import { zipEntries, zipEntryAllowed, zipStore } from "../src/zip";
import type { Env } from "../src/env";
import { writtenBy } from "../src/review";
import { STARTER_SKILL_PATH } from "../src/seed";
import { openSession } from "../src/teams";
import { FakeWorkspace } from "./fake-artifacts";
import { memoryD1 } from "./memory-d1";
import { memoryKv } from "./memory-kv";
import { serveWorker } from "./serve";

const BANNED =
	/\b(git|repos?|branches?|commits?|push(?:ed|ing)?|pull|merge[ds]?|fork(?:ed|ing)?|squash(?:ed|ing)?|rebase[ds]?|clon(?:e|ed|ing)|tokens?|prs?|pr)\b/i;

function visible(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<pre\b[^>]*\bdata-setup\b[^>]*>[\s\S]*?<\/pre>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"');
}

function cookiesOf(response: Response): string {
	return response.headers
		.getSetCookie()
		.map((item) => item.split(";")[0] ?? "")
		.filter(Boolean)
		.join("; ");
}

function mergedCookie(session: string, response: Response): string {
	const more = cookiesOf(response);
	return more ? `${session}; ${more}` : session;
}

describe("team connections stay public", () => {
	it("drops secrets and keeps a plain address", () => {
		expect(publicServerUrl("https://user:secret@example.com/mcp")).toBeNull();
		expect(publicServerUrl("https://example.com/mcp?token=abc")).toBeNull();
		expect(publicServerUrl("https://mcp.notion.com/mcp")).toBe("https://mcp.notion.com/mcp");
		const parsed = parseTeamConnections(
			JSON.stringify({
				mcpServers: {
					notion: { url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer hidden" } },
					leaky: { url: "https://example.com/mcp?access_token=no" },
				},
			}),
		);
		expect(parsed).toEqual([{ name: "notion", url: "https://mcp.notion.com/mcp" }]);
		expect(displayServerName("notion")).toBe("Notion");
		expect(displayServerName("my_server")).toBe("My Server");
		expect(JSON.stringify(parsed)).not.toContain("hidden");
		expect(JSON.stringify(parsed)).not.toContain("access_token");
	});

	it("names a tool from what it calls itself", () => {
		expect(toolLabel("Claude")).toBe("Claude");
		expect(toolLabel("claude-code")).toBe("Claude Code");
		expect(toolLabel("Visual Studio Code")).toBe("VS Code");
		expect(writtenBy("Claude for Dana", "Dana")).toBe("Written by Claude for Dana");
		expect(writtenBy("Researcher", "Editor")).toBe("Written by Researcher for Editor");
	});
});

describe("skill download stays inside the library", () => {
	it("skips a name that climbs out", () => {
		expect(zipEntryAllowed("skills/../secret")).toBe(false);
		expect(zipEntryAllowed("skills\\secret")).toBe(false);
		expect(zipEntryAllowed("/etc/passwd")).toBe(false);
		expect(zipEntryAllowed("skills/interview-to-draft/SKILL.md")).toBe(true);
		const kept = zipEntries([
			{ name: "skills/../secret", data: new Uint8Array([1]) },
			{ name: "skills\\secret", data: new Uint8Array([1]) },
			{ name: "/etc/passwd", data: new Uint8Array([1]) },
			{ name: "skills/ok/SKILL.md", data: new Uint8Array([2]) },
		]);
		expect(kept.map((file) => file.name)).toEqual(["skills/ok/SKILL.md"]);
	});

	it("stops after the file count and the total size", () => {
		const files = [1, 2, 3].map((n) => ({ name: `skills/${n}/SKILL.md`, data: new Uint8Array(10) }));
		expect(zipEntries(files, { maxFiles: 2, maxBytes: 1000 })).toHaveLength(2);
		expect(zipEntries(files, { maxFiles: 10, maxBytes: 25 })).toHaveLength(2);
	});

	it("marks the entry name as UTF-8", () => {
		const zip = zipStore([{ name: "skills/café/SKILL.md", data: new Uint8Array([1]) }]);
		const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		expect(view.getUint16(6, true) & 0x800).toBe(0x800);
		let central = -1;
		for (let index = 0; index < zip.length - 4; index++) {
			if (view.getUint32(index, true) === 0x02014b50) {
				central = index;
				break;
			}
		}
		expect(central).toBeGreaterThan(0);
		expect(view.getUint16(central + 8, true) & 0x800).toBe(0x800);
	});
});

describe("sign in from a tool", () => {
	let workspace: FakeWorkspace;
	let db: D1Database;
	let origin = "";
	let close: () => Promise<void> = async () => {};
	let session = "";
	const env: Env = {
		WORKSPACE: {} as Artifacts,
		DEMO_KEY: "secret",
		DB: {} as D1Database,
		SUGGESTIONS: {} as Env["SUGGESTIONS"],
		ARRIVALS: {} as Env["ARRIVALS"],
		SIGN_IN: "access",
		OAUTH_KV: memoryKv(),
		MAX_WORKSPACES: "40",
		MAX_PEOPLE: "25",
		MAX_AGENTS: "40",
		MAX_OPEN_SUGGESTIONS: "200",
	};

	beforeAll(async () => {
		workspace = await FakeWorkspace.start();
		db = memoryD1();
		env.WORKSPACE = workspace.binding;
		env.DB = db;
		const actor = await registerActor(db, {
			id: "dana",
			kind: "person",
			name: "Dana",
			workspaceId: "north",
			email: "dana@stylebook.invalid",
			role: "admin",
			key: "dana-person-key-0001",
		});
		await db.prepare(`UPDATE workspaces SET name = 'North' WHERE id = 'north'`).bind().run();
		session = `stylebook=${encodeURIComponent(await openSession(db, actor))}`;
		const server = await serveWorker(env);
		origin = server.url;
		close = server.close;
	}, 30_000);

	afterAll(async () => {
		await close();
		await workspace.stop();
	});

	it("asks a signed-out person to sign in, then shows consent and credits the tool", async () => {
		const home = await fetch(`${origin}/`, { headers: { Cookie: session } });
		expect(home.status).toBe(200);
		expect(await home.text()).toContain("Interview to draft");

		const resource = `${origin}/mcp`;
		const unsigned = await fetch(`${origin}/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		});
		expect(unsigned.status).toBe(401);
		expect(unsigned.headers.get("WWW-Authenticate") ?? "").toContain("resource_metadata");

		const redirectUri = "http://127.0.0.1:33418/callback";
		const registered = await fetch(`${origin}/oauth/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_name: "Claude",
				redirect_uris: [redirectUri],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			}),
		});
		expect(registered.status).toBe(201);
		const client = (await registered.json()) as { client_id: string };
		expect(client.client_id).toBeTruthy();

		const verifier = randomBytes(32).toString("base64url");
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		const authorize = new URL("/authorize", origin);
		authorize.searchParams.set("response_type", "code");
		authorize.searchParams.set("client_id", client.client_id);
		authorize.searchParams.set("redirect_uri", redirectUri);
		authorize.searchParams.set("code_challenge", challenge);
		authorize.searchParams.set("code_challenge_method", "S256");
		authorize.searchParams.set("scope", "suggest");
		authorize.searchParams.set("resource", resource);
		authorize.searchParams.set("state", "abc");

		const signedOut = await fetch(authorize, { redirect: "manual" });
		expect(signedOut.status).toBe(303);
		expect(signedOut.headers.get("Location")).toBe("/enter");
		expect(cookiesOf(signedOut)).toContain("stylebook_return=");

		const consent = await fetch(authorize, { headers: { Cookie: session }, redirect: "manual" });
		expect(consent.status).toBe(200);
		const consentHtml = await consent.text();
		expect(visible(consentHtml)).toContain("This returns you to 127.0.0.1");
		expect(consentHtml).toContain('<h1 class="return">This returns you to 127.0.0.1</h1>');
		expect(visible(consentHtml)).toContain(
			"An app calling itself 'Claude' is asking. Only approve if you just added Stylebook to that app.",
		);
		expect(visible(consentHtml)).toContain("Claude (registered as Claude)");
		expect(visible(consentHtml)).toContain("the North library");
		expect(visible(consentHtml)).toContain("Claude for Dana");
		expect(visible(consentHtml)).toContain("It cannot publish.");
		expect(consentHtml).not.toContain("The name is not checked");
		expect(BANNED.test(visible(consentHtml))).toBe(false);
		const handle = consentHtml.match(/name="handle" value="([^"]+)"/)?.[1] ?? "";
		expect(handle).not.toBe("");
		const workspaceField = consentHtml.match(/name="workspace" value="([^"]+)"/)?.[1] ?? "";
		expect(workspaceField).toBe("north");

		const waiting = await fetch(`${origin}/connect`, { headers: { Cookie: session } });
		const waitingHtml = await waiting.text();
		expect(waitingHtml).toContain("Which tool do you use?");
		expect(waitingHtml).toContain('aria-current="page">Claude');
		expect(waitingHtml).toContain("Waiting for your first connection");
		expect(waitingHtml).toContain("Add custom connector");
		expect(waitingHtml).toContain(">Copy<");
		expect(waitingHtml).toContain(">More<");
		expect(waitingHtml).toContain(">Notion<");
		expect(waitingHtml).toContain("https://mcp.notion.com/mcp");
		expect(waitingHtml).toContain("Download skills");
		expect(waitingHtml).toContain(">Other<");
		expect(waitingHtml).not.toContain("Business, Enterprise, and Edu");
		expect(waitingHtml).not.toContain("claude mcp add --transport http stylebook");
		expect(BANNED.test(visible(waitingHtml))).toBe(false);
		expect(visible(waitingHtml).toLowerCase()).not.toContain("header");

		const wrongWorkspace = await fetch(`${origin}/authorize`, {
			method: "POST",
			redirect: "manual",
			headers: { Cookie: mergedCookie(session, consent), "Content-Type": "application/x-www-form-urlencoded" },
			body: `handle=${encodeURIComponent(handle)}&decision=approve&workspace=south`,
		});
		expect(wrongWorkspace.status).toBe(403);
		expect(await wrongWorkspace.text()).toContain("Approve this for the workspace you are in.");

		const approved = await fetch(`${origin}/authorize`, {
			method: "POST",
			redirect: "manual",
			headers: { Cookie: mergedCookie(session, consent), "Content-Type": "application/x-www-form-urlencoded" },
			body: `handle=${encodeURIComponent(handle)}&decision=approve&workspace=${encodeURIComponent(workspaceField)}`,
		});
		expect(approved.status).toBe(302);
		const location = new URL(approved.headers.get("Location") ?? "");
		expect(location.searchParams.get("state")).toBe("abc");
		const code = location.searchParams.get("code") ?? "";
		expect(code).not.toBe("");

		const tokenResponse = await fetch(`${origin}/oauth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: redirectUri,
				client_id: client.client_id,
				code_verifier: verifier,
				resource,
			}),
		});
		expect(tokenResponse.status).toBe(200);
		const token = (await tokenResponse.json()) as { access_token?: string };
		expect(token.access_token).toBeTruthy();

		const headers = {
			Authorization: `Bearer ${token.access_token}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		const call = (method: string, params: unknown) =>
			fetch(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });

		const init = await call("initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "Claude", version: "1.2.3" },
		});
		expect(init.status).toBe(200);

		const connected = await fetch(`${origin}/connect`, { headers: { Cookie: session } });
		const connectedHtml = await connected.text();
		expect(connectedHtml).toContain("Connected as");
		expect(connectedHtml).toContain("Claude for Dana");

		const prompts = await call("prompts/list", {});
		const promptBody = (await prompts.json()) as { result: { prompts: { name: string }[] } };
		expect(promptBody.result.prompts.map((item) => item.name)).toContain("interview-to-draft");
		expect(promptBody.result.prompts.map((item) => item.name)).toContain("feature-article");

		const skill = await call("tools/call", { name: "get_skill", arguments: { name: "interview-to-draft" } });
		const skillBody = (await skill.json()) as { result: { content: { text: string }[] } };
		expect(skillBody.result.content[0]?.text).toContain("Interview to draft");

		const connections = await call("tools/call", { name: "list_team_connections", arguments: {} });
		const connectionText = JSON.stringify(await connections.json());
		expect(connectionText).toContain("https://mcp.notion.com/mcp");
		expect(connectionText).not.toContain("Bearer");

		const blocked = await call("tools/call", { name: "publish", arguments: { path: STARTER_SKILL_PATH } });
		const blockedText = JSON.stringify(await blocked.json());
		expect(blockedText).toContain("An agent cannot publish.");

		const suggested = await call("tools/call", {
			name: "suggest_change",
			arguments: {
				path: STARTER_SKILL_PATH,
				content: "A suggestion from Claude for Dana.\n",
				why: "Try the sign-in connection.",
				session: "first",
			},
		});
		const suggestedText = JSON.stringify(await suggested.json());
		expect(suggestedText).toContain("Saved suggestion");
		const edition = suggestedText.match(/as edition ([0-9a-f]{40})/)?.[1] ?? "";
		expect(edition).toHaveLength(40);
		const who = await fetch(`${origin}/who?edition=${edition}`, { headers: { Cookie: session } });
		const whoBody = (await who.json()) as { actor?: { name?: string }; note?: { model?: string; actor?: string; onBehalfOf?: string } };
		expect(whoBody.actor?.name).toBe("Claude for Dana");
		expect(whoBody.note?.actor).toBe("Claude for Dana");
		expect(whoBody.note?.onBehalfOf).toBe("Dana");
		expect(whoBody.note?.model).toContain("1.2.3");

		const zip = await fetch(`${origin}/connect/skills.zip`, { headers: { Cookie: session } });
		expect(zip.headers.get("Content-Type")).toContain("zip");
		const bytes = new TextDecoder().decode(await zip.arrayBuffer());
		expect(bytes).toContain("skills/interview-to-draft/SKILL.md");
		expect(bytes).not.toContain("workflows/feature-article.md");

		const people = await fetch(`${origin}/people`, { headers: { Cookie: session } });
		const peopleHtml = await people.text();
		expect(peopleHtml).toContain("Claude for Dana");
		expect(peopleHtml).toContain("Connect your AI tools");
		const agentId = peopleHtml.match(/action="\/agents\/revoke"><input type="hidden" name="id" value="([^"]+)"/)?.[1] ?? "";
		expect(agentId).not.toBe("");
		const revoked = await fetch(`${origin}/agents/revoke`, {
			method: "POST",
			headers: { Cookie: session, "Content-Type": "application/x-www-form-urlencoded" },
			body: `id=${encodeURIComponent(agentId)}`,
		});
		expect(await revoked.text()).toContain("The key no longer works.");
		const after = await call("tools/list", {});
		expect(after.status).toBe(401);
	}, 60_000);

	it("shows one tool at a time and remembers the choice", async () => {
		const chatgpt = await fetch(`${origin}/connect?tool=chatgpt`, { headers: { Cookie: session } });
		const chatgptHtml = await chatgpt.text();
		expect(chatgptHtml).toContain("Business, Enterprise, and Edu");
		expect(chatgptHtml).not.toContain("Add custom connector");
		expect(chatgpt.headers.getSetCookie().join("\n")).toContain("stylebook_tool=chatgpt");
		const remembered = await fetch(`${origin}/connect`, {
			headers: { Cookie: `${session}; stylebook_tool=claude-code` },
		});
		const rememberedHtml = await remembered.text();
		expect(rememberedHtml).toContain("claude mcp add --transport http stylebook");
		expect(rememberedHtml).not.toContain("Add custom connector");
		const vscode = await fetch(`${origin}/connect?tool=vscode`, { headers: { Cookie: session } });
		expect(await vscode.text()).toContain("vscode:mcp/install?");
	});

	it("shows the registered name escaped, and rejects a loose registration", async () => {
		const spoofName = "Claude <b>not</b>";
		const redirectUri = "http://127.0.0.1:33418/callback";
		const spoofed = await fetch(`${origin}/oauth/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_name: spoofName,
				redirect_uris: [redirectUri],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			}),
		});
		expect(spoofed.status).toBe(201);
		const spoof = (await spoofed.json()) as { client_id: string };
		const verifier = randomBytes(32).toString("base64url");
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		const authorize = new URL("/authorize", origin);
		authorize.searchParams.set("response_type", "code");
		authorize.searchParams.set("client_id", spoof.client_id);
		authorize.searchParams.set("redirect_uri", redirectUri);
		authorize.searchParams.set("code_challenge", challenge);
		authorize.searchParams.set("code_challenge_method", "S256");
		authorize.searchParams.set("scope", "suggest");
		authorize.searchParams.set("resource", `${origin}/mcp`);
		authorize.searchParams.set("state", "spoof");
		const consent = await fetch(authorize, { headers: { Cookie: session } });
		const html = await consent.text();
		expect(html).toContain("Claude &lt;b&gt;not&lt;/b&gt;");
		expect(html).not.toContain("<b>not</b>");
		expect(visible(html)).toContain("Claude (registered as Claude <b>not</b>)");

		const longName = await fetch(`${origin}/oauth/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_name: "A".repeat(81),
				redirect_uris: [redirectUri],
				token_endpoint_auth_method: "none",
			}),
		});
		expect(longName.status).toBe(400);
		const many = await fetch(`${origin}/oauth/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_name: "Claude",
				redirect_uris: Array.from({ length: 9 }, (_, index) => `https://example.com/cb/${index}`),
				token_endpoint_auth_method: "none",
			}),
		});
		expect(many.status).toBe(400);
		const secret = await fetch(`${origin}/oauth/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_name: "Claude",
				redirect_uris: [redirectUri],
				token_endpoint_auth_method: "client_secret_basic",
			}),
		});
		expect(secret.status).toBe(400);
		const omitted = await fetch(`${origin}/oauth/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_name: "Claude",
				redirect_uris: [redirectUri],
			}),
		});
		expect(omitted.status).toBe(400);
	});

	it("caps registrations from one network", async () => {
		const before = await db.prepare(`SELECT COUNT(*) AS n FROM oauth_registrations`).bind().first<{ n: number }>();
		const previous = env.MAX_OAUTH_REGISTRATIONS_PER_IP_PER_HOUR;
		env.MAX_OAUTH_REGISTRATIONS_PER_IP_PER_HOUR = String((before?.n ?? 0) + 1);
		try {
			const redirectUri = "http://127.0.0.1:33418/callback";
			const body = {
				client_name: "Claude",
				redirect_uris: [redirectUri],
				token_endpoint_auth_method: "none",
			};
			const allowed = await fetch(`${origin}/oauth/register`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(allowed.status).toBe(201);
			const blocked = await fetch(`${origin}/oauth/register`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(blocked.status).toBe(429);
		} finally {
			env.MAX_OAUTH_REGISTRATIONS_PER_IP_PER_HOUR = previous;
		}
	});

	it("reuses the same app and never replaces a hand-made key", async () => {
		const hand = await registerActor(db, {
			id: "handmade",
			kind: "agent",
			name: "Claude for Dana",
			workspaceId: "north",
			ownerId: "dana",
			model: "Claude",
			key: "hand-made-key-000000000001",
		});
		const handKeys = async () =>
			(
				await db
					.prepare(`SELECT key_hash FROM actor_keys WHERE actor_id = ?1`)
					.bind(hand.id)
					.all<{ key_hash: string }>()
			).results ?? [];
		const before = await handKeys();
		expect(before).toHaveLength(1);

		const redirectUri = "http://127.0.0.1:43111/callback";
		const resource = `${origin}/mcp`;
		const register = async (name: string) => {
			const response = await fetch(`${origin}/oauth/register`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					client_name: name,
					redirect_uris: [redirectUri],
					grant_types: ["authorization_code", "refresh_token"],
					response_types: ["code"],
					token_endpoint_auth_method: "none",
				}),
			});
			expect(response.status).toBe(201);
			return (await response.json()) as { client_id: string };
		};
		const approve = async (clientId: string) => {
			const verifier = randomBytes(32).toString("base64url");
			const challenge = createHash("sha256").update(verifier).digest("base64url");
			const authorize = new URL("/authorize", origin);
			authorize.searchParams.set("response_type", "code");
			authorize.searchParams.set("client_id", clientId);
			authorize.searchParams.set("redirect_uri", redirectUri);
			authorize.searchParams.set("code_challenge", challenge);
			authorize.searchParams.set("code_challenge_method", "S256");
			authorize.searchParams.set("scope", "suggest");
			authorize.searchParams.set("resource", resource);
			authorize.searchParams.set("state", "again");
			const consent = await fetch(authorize, { headers: { Cookie: session } });
			const html = await consent.text();
			const handle = html.match(/name="handle" value="([^"]+)"/)?.[1] ?? "";
			const approved = await fetch(`${origin}/authorize`, {
				method: "POST",
				redirect: "manual",
				headers: { Cookie: mergedCookie(session, consent), "Content-Type": "application/x-www-form-urlencoded" },
				body: `handle=${encodeURIComponent(handle)}&decision=approve&workspace=north`,
			});
			expect(approved.status).toBe(302);
			const mapped = await db
				.prepare(`SELECT agent_id FROM oauth_agents WHERE client_id = ?1 AND owner_id = 'dana'`)
				.bind(clientId)
				.first<{ agent_id: string }>();
			return mapped?.agent_id ?? "";
		};

		const first = await register("Claude");
		const firstAgent = await approve(first.client_id);
		expect(firstAgent).not.toBe("");
		expect(firstAgent).not.toBe(hand.id);
		const named = await db.prepare(`SELECT name FROM actors WHERE id = ?1`).bind(firstAgent).first<{ name: string }>();
		expect(named?.name).toBe("Claude for Dana (2)");
		const firstKeys = async () =>
			(
				await db
					.prepare(`SELECT key_hash FROM actor_keys WHERE actor_id = ?1`)
					.bind(firstAgent)
					.all<{ key_hash: string }>()
			).results ?? [];
		expect(await firstKeys()).toHaveLength(1);
		expect(await handKeys()).toEqual(before);

		const again = await approve(first.client_id);
		expect(again).toBe(firstAgent);
		expect(await firstKeys()).toHaveLength(1);
		expect(await handKeys()).toEqual(before);

		const second = await register("Claude");
		const secondAgent = await approve(second.client_id);
		expect(secondAgent).not.toBe(firstAgent);
		const secondName = await db.prepare(`SELECT name FROM actors WHERE id = ?1`).bind(secondAgent).first<{ name: string }>();
		expect(secondName?.name).toBe("Claude for Dana (3)");
		expect(await handKeys()).toEqual(before);
	}, 60_000);

	it("switches workspace on submit, not when the page opens", async () => {
		await registerActor(db, {
			id: "danasouth",
			kind: "person",
			name: "Dana",
			workspaceId: "south",
			email: "dana@stylebook.invalid",
			role: "admin",
			key: "dana-south-key-00000001",
		});
		await db.prepare(`UPDATE workspaces SET name = 'South' WHERE id = 'south'`).bind().run();
		const redirectUri = "http://127.0.0.1:43112/callback";
		const registered = await fetch(`${origin}/oauth/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_name: "Claude",
				redirect_uris: [redirectUri],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			}),
		});
		expect(registered.status).toBe(201);
		const client = (await registered.json()) as { client_id: string };
		const verifier = randomBytes(32).toString("base64url");
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		const authorize = new URL("/authorize", origin);
		authorize.searchParams.set("response_type", "code");
		authorize.searchParams.set("client_id", client.client_id);
		authorize.searchParams.set("redirect_uri", redirectUri);
		authorize.searchParams.set("code_challenge", challenge);
		authorize.searchParams.set("code_challenge_method", "S256");
		authorize.searchParams.set("scope", "suggest");
		authorize.searchParams.set("resource", `${origin}/mcp`);
		authorize.searchParams.set("state", "switch");
		authorize.searchParams.set("workspace", "south");
		const opened = await fetch(authorize, { headers: { Cookie: session } });
		const openedHtml = await opened.text();
		expect(visible(openedHtml)).toContain("the North library");
		expect(visible(openedHtml)).not.toContain("the South library");
		expect(openedHtml).toContain("Open South");
		expect(openedHtml).not.toMatch(/href="[^"]*workspace=/);
		expect(opened.headers.getSetCookie().join("\n")).not.toContain("stylebook=");

		authorize.searchParams.delete("workspace");
		const switched = await fetch(`${origin}/authorize`, {
			method: "POST",
			redirect: "manual",
			headers: { Cookie: session, "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				decision: "switch",
				workspace: "south",
				return: `${authorize.pathname}${authorize.search}`,
			}),
		});
		expect(switched.status).toBe(303);
		const next = cookiesOf(switched);
		expect(next).toContain("stylebook=");
		const south = await fetch(new URL(switched.headers.get("Location") ?? "", origin), { headers: { Cookie: next } });
		expect(visible(await south.text())).toContain("the South library");
	}, 60_000);
});
