import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantByToken, issueGrant } from "../src/access";
import { actorById, hashKey, registerActor } from "../src/actors";
import { pushForEdition } from "../src/audit";
import type { Env } from "../src/env";
import { LIMIT_MESSAGE } from "../src/limits";
import worker from "../src/index";
import { FakeWorkspace } from "./fake-artifacts";
import { memoryD1 } from "./memory-d1";
import { serveWorker } from "./serve";

function sessionCookie(response: Response): string {
	const cookies = response.headers.getSetCookie?.() ?? [];
	const match = cookies.find((item) => item.startsWith("stylebook="));
	return (match ?? "").split(";")[0] ?? "";
}

describe("review fixes for workspaces", () => {
	let db: D1Database;
	let origin = "";
	let close: () => Promise<void> = async () => {};
	const inbox: { to: string; text?: string }[] = [];
	const env: Env = {
		WORKSPACE: {} as Artifacts,
		DEMO_KEY: "secret",
		DB: {} as D1Database,
		SUGGESTIONS: {} as Env["SUGGESTIONS"],
		ARRIVALS: {} as Env["ARRIVALS"],
		MAX_WORKSPACES: "40",
		MAX_WORKSPACES_PER_EMAIL: "2",
		MAX_WORKSPACES_PER_IP_PER_DAY: "5",
		MAX_PEOPLE: "25",
		MAX_AGENTS: "40",
		MAX_OPEN_SUGGESTIONS: "200",
		MAX_SIGN_IN_EMAILS_PER_HOUR: "30",
		MAX_SIGN_IN_EMAILS_PER_IP_PER_HOUR: "80",
		MAX_SIGN_IN_EMAILS_GLOBAL_PER_HOUR: "100",
		EMAIL: {
			async send(message) {
				const to = typeof message.to === "string" ? message.to : message.to.email;
				inbox.push({ to, text: message.text });
				return { messageId: "1" };
			},
		},
	};

	beforeAll(async () => {
		const workspace = await FakeWorkspace.start();
		db = memoryD1();
		env.WORKSPACE = workspace.binding;
		env.DB = db;
		const server = await serveWorker(env);
		origin = server.url;
		close = async () => {
			await server.close();
			await workspace.stop();
		};
	});

	afterAll(async () => {
		await close();
	});

	async function linkFor(email: string): Promise<string> {
		const letter = [...inbox].reverse().find((item) => item.to === email);
		const secret = letter?.text?.match(/\/s\/([0-9a-f]{64})/)?.[1] ?? "";
		expect(secret).toHaveLength(64);
		return secret;
	}

	async function start(name: string, email: string, ip: string): Promise<Response> {
		return fetch(`${origin}/start`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip },
			body: `workspace=${encodeURIComponent(name)}&email=${encodeURIComponent(email)}`,
		});
	}

	async function confirm(secret: string): Promise<Response> {
		return fetch(`${origin}/s/${secret}`, { method: "POST", redirect: "manual" });
	}

	it("lets only the workspace owner remove people, and not the owner", async () => {
		const started = await start("Owner desk", "owner-fix@stylebook.invalid", "203.0.113.10");
		expect(started.status).toBe(200);
		const ownerSecret = await linkFor("owner-fix@stylebook.invalid");
		const ownerIn = await confirm(ownerSecret);
		const owner = sessionCookie(ownerIn);
		const invited = await fetch(`${origin}/invite`, {
			method: "POST",
			headers: { Cookie: owner, "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.10" },
			body: "email=member-fix@stylebook.invalid",
		});
		expect(invited.status).toBe(200);
		const memberSecret = await linkFor("member-fix@stylebook.invalid");
		const memberIn = await confirm(memberSecret);
		const member = sessionCookie(memberIn);

		const ownerPage = await (await fetch(`${origin}/people`, { headers: { Cookie: owner } })).text();
		const memberPage = await (await fetch(`${origin}/people`, { headers: { Cookie: member } })).text();
		expect(ownerPage).toContain('action="/people/remove"');
		expect(memberPage).not.toContain('action="/people/remove"');

		const ownerId =
			(
				await db
					.prepare(`SELECT id FROM actors WHERE email = ?1 AND removed_at IS NULL`)
					.bind("owner-fix@stylebook.invalid")
					.first<{ id: string }>()
			)?.id ?? "";
		const memberId =
			(
				await db
					.prepare(`SELECT id FROM actors WHERE email = ?1 AND removed_at IS NULL`)
					.bind("member-fix@stylebook.invalid")
					.first<{ id: string }>()
			)?.id ?? "";
		const refused = await fetch(`${origin}/people/remove`, {
			method: "POST",
			headers: { Cookie: member, "Content-Type": "application/x-www-form-urlencoded" },
			body: `id=${encodeURIComponent(ownerId)}`,
		});
		expect(await refused.text()).toContain("Only the person who started this workspace can remove someone.");
		const stillThere = await db
			.prepare(`SELECT removed_at FROM actors WHERE id = ?1`)
			.bind(ownerId)
			.first<{ removed_at: string | null }>();
		expect(stillThere?.removed_at).toBeNull();

		const ownerKept = await fetch(`${origin}/people/remove`, {
			method: "POST",
			headers: { Cookie: owner, "Content-Type": "application/x-www-form-urlencoded" },
			body: `id=${encodeURIComponent(ownerId)}`,
		});
		expect(await ownerKept.text()).toContain("cannot be removed");

		const connected = await fetch(`${origin}/agents`, {
			method: "POST",
			headers: { Cookie: member, "Content-Type": "application/x-www-form-urlencoded" },
			body: "name=Clerk&tool=cursor",
		});
		const agentId = (await connected.text()).match(/name="id" value="([^"]+)"/)?.[1] ?? "";
		expect(agentId).not.toBe("");
		const revoked = await fetch(`${origin}/agents/revoke`, {
			method: "POST",
			headers: { Cookie: owner, "Content-Type": "application/x-www-form-urlencoded" },
			body: `id=${encodeURIComponent(agentId)}`,
		});
		expect(await revoked.text()).toContain("The key no longer works.");
		const keys = await db
			.prepare(`SELECT COUNT(*) AS n FROM actor_keys WHERE actor_id = ?1`)
			.bind(agentId)
			.first<{ n: number }>();
		expect(keys?.n).toBe(0);

		const removed = await fetch(`${origin}/people/remove`, {
			method: "POST",
			headers: { Cookie: owner, "Content-Type": "application/x-www-form-urlencoded" },
			body: `id=${encodeURIComponent(memberId)}`,
		});
		expect(await removed.text()).not.toContain("not in this workspace");
		const gone = await fetch(`${origin}/`, { headers: { Cookie: member } });
		expect(await gone.text()).toContain("Start a workspace");
	}, 60_000);

	it("counts a burst of sign-in sends in one step, including a global cap", async () => {
		const previousHour = env.MAX_SIGN_IN_EMAILS_PER_HOUR;
		const previousGlobal = env.MAX_SIGN_IN_EMAILS_GLOBAL_PER_HOUR;
		try {
			env.MAX_SIGN_IN_EMAILS_PER_HOUR = "3";
			env.MAX_SIGN_IN_EMAILS_GLOBAL_PER_HOUR = "100";
			const email = "burst-fix@stylebook.invalid";
			const responses = await Promise.all(
				Array.from({ length: 12 }, () =>
					fetch(`${origin}/sign-in`, {
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.21" },
						body: `email=${encodeURIComponent(email)}`,
					}),
				),
			);
			const bodies = await Promise.all(responses.map((response) => response.text()));
			expect(new Set(responses.map((response) => response.status))).toEqual(new Set([200]));
			expect(bodies.every((body) => body.includes("If that address is in a workspace, a link is on its way."))).toBe(
				true,
			);
			const byEmail = await db
				.prepare(`SELECT COUNT(*) AS n FROM sign_in_sends WHERE email = ?1`)
				.bind(email)
				.first<{ n: number }>();
			expect(byEmail?.n).toBe(3);

			const before = await db.prepare(`SELECT COUNT(*) AS n FROM sign_in_sends`).bind().first<{ n: number }>();
			env.MAX_SIGN_IN_EMAILS_PER_HOUR = "30";
			env.MAX_SIGN_IN_EMAILS_GLOBAL_PER_HOUR = String((before?.n ?? 0) + 4);
			await Promise.all(
				Array.from({ length: 10 }, (_, index) =>
					fetch(`${origin}/sign-in`, {
						method: "POST",
						headers: {
							"Content-Type": "application/x-www-form-urlencoded",
							"CF-Connecting-IP": `203.0.113.${30 + index}`,
						},
						body: `email=${encodeURIComponent(`global-${index}@stylebook.invalid`)}`,
					}),
				),
			);
			const after = await db.prepare(`SELECT COUNT(*) AS n FROM sign_in_sends`).bind().first<{ n: number }>();
			expect((after?.n ?? 0) - (before?.n ?? 0)).toBe(4);
		} finally {
			env.MAX_SIGN_IN_EMAILS_PER_HOUR = previousHour;
			env.MAX_SIGN_IN_EMAILS_GLOBAL_PER_HOUR = previousGlobal;
		}
	});

	it("caps workspaces per email and per network, and logs the global threshold without addresses", async () => {
		const logs: string[] = [];
		const original = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.map((item) => String(item)).join(" "));
		};
		try {
			env.MAX_WORKSPACES_PER_EMAIL = "2";
			const burst = await Promise.all(
				Array.from({ length: 8 }, () => start("Parallel", "two-fix@stylebook.invalid", "203.0.113.40")),
			);
			const burstText = await Promise.all(burst.map((response) => response.text()));
			const held = await db
				.prepare(`SELECT COUNT(*) AS n FROM workspace_starts WHERE email = ?1`)
				.bind("two-fix@stylebook.invalid")
				.first<{ n: number }>();
			expect(held?.n).toBe(2);
			expect(burstText.some((text) => text.includes(LIMIT_MESSAGE.workspacesPerEmail))).toBe(true);

			env.MAX_WORKSPACES_PER_IP_PER_DAY = "2";
			const ips = await Promise.all(
				["a", "b", "c", "d"].map((name) => start("Net", `${name}-net@stylebook.invalid`, "203.0.113.41")),
			);
			const ipText = await Promise.all(ips.map((response) => response.text()));
			const fromIp = await db
				.prepare(`SELECT COUNT(*) AS n FROM workspace_starts WHERE ip = ?1`)
				.bind("203.0.113.41")
				.first<{ n: number }>();
			expect(fromIp?.n).toBe(2);
			expect(ipText.some((text) => text.includes(LIMIT_MESSAGE.workspacesPerIp))).toBe(true);

			await db.prepare(`DELETE FROM workspace_starts WHERE workspace_id IS NULL`).bind().run();
			const existing = await db.prepare(`SELECT COUNT(*) AS n FROM workspaces`).bind().first<{ n: number }>();
			const cap = (existing?.n ?? 0) + 5;
			env.MAX_WORKSPACES = String(cap);
			env.MAX_WORKSPACES_PER_EMAIL = "20";
			env.MAX_WORKSPACES_PER_IP_PER_DAY = "20";
			for (let index = 0; index < 5; index += 1) {
				const email = `cap-${index}@stylebook.invalid`;
				const response = await start(`Cap ${index}`, email, "203.0.113.42");
				expect(response.status).toBe(200);
				await confirm(await linkFor(email));
			}
			const line = logs.find((item) => item.includes("workspace_cap"));
			expect(line).toBeTruthy();
			expect(line).not.toContain("@");
			expect(line).not.toContain("203.0.113.42");
			expect(line).toContain(`"cap":${cap}`);
		} finally {
			console.log = original;
			env.MAX_WORKSPACES = "40";
			env.MAX_WORKSPACES_PER_EMAIL = "2";
			env.MAX_WORKSPACES_PER_IP_PER_DAY = "5";
		}
	}, 60_000);

	it("shows a confirm page and creates the workspace only on POST", async () => {
		const name = "Zephyrique";
		const email = "scan-fix@stylebook.invalid";
		const before = await db.prepare(`SELECT COUNT(*) AS n FROM workspaces`).bind().first<{ n: number }>();
		expect((await start(name, email, "203.0.113.50")).status).toBe(200);
		const letter = [...inbox].reverse().find((item) => item.to === email);
		expect(letter?.text ?? "").not.toContain(name);
		const secret = await linkFor(email);
		const preview = await fetch(`${origin}/s/${secret}`, { redirect: "manual" });
		expect(preview.status).toBe(200);
		expect(sessionCookie(preview)).toBe("");
		const previewText = await preview.text();
		expect(previewText).toContain("Open your new workspace");
		expect(previewText).not.toContain(name);
		const during = await db.prepare(`SELECT COUNT(*) AS n FROM workspaces`).bind().first<{ n: number }>();
		expect(during?.n).toBe(before?.n);
		const opened = await confirm(secret);
		expect(opened.status).toBe(303);
		const after = await db.prepare(`SELECT COUNT(*) AS n FROM workspaces`).bind().first<{ n: number }>();
		expect(after?.n).toBe((before?.n ?? 0) + 1);
		const again = await confirm(secret);
		expect(await again.text()).toContain("already used");
	});

	it("leaves a typed name out of start mail and quotes a safe invite name", async () => {
		const email = "quote-fix@stylebook.invalid";
		expect((await start("Quote Desk", email, "203.0.113.60")).status).toBe(200);
		const owner = sessionCookie(await confirm(await linkFor(email)));
		const safe = await fetch(`${origin}/invite`, {
			method: "POST",
			headers: { Cookie: owner, "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.60" },
			body: "email=safe-fix@stylebook.invalid",
		});
		expect(safe.status).toBe(200);
		const safeLetter = [...inbox].reverse().find((item) => item.to === "safe-fix@stylebook.invalid");
		expect(safeLetter?.text).toContain('to "Quote Desk"');
		const preview = await fetch(`${origin}/s/${await linkFor("safe-fix@stylebook.invalid")}`);
		expect(await preview.text()).toContain("Sign in to Quote Desk");

		await db.prepare(`UPDATE workspaces SET name = ?1 WHERE name = ?2`).bind("Visit http://evil.test", "Quote Desk").run();
		const unsafe = await fetch(`${origin}/invite`, {
			method: "POST",
			headers: { Cookie: owner, "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.60" },
			body: "email=unsafe-fix@stylebook.invalid",
		});
		expect(unsafe.status).toBe(200);
		const unsafeLetter = [...inbox].reverse().find((item) => item.to === "unsafe-fix@stylebook.invalid");
		expect(unsafeLetter?.text ?? "").not.toContain("evil.test");
		expect(unsafeLetter?.text ?? "").toContain("Open this link to sign in.");
	});

	it("answers every sign-in the same way and sends after the reply", async () => {
		const known = "known-fix@stylebook.invalid";
		expect((await start("Known", known, "203.0.113.70")).status).toBe(200);
		await confirm(await linkFor(known));
		const unknown = "unknown-fix@stylebook.invalid";
		const send = (email: string) =>
			fetch(`${origin}/sign-in`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.71" },
				body: `email=${encodeURIComponent(email)}`,
			});
		const knownResponse = await send(known);
		const unknownResponse = await send(unknown);
		expect(knownResponse.status).toBe(unknownResponse.status);
		const knownText = await knownResponse.text();
		const unknownText = await unknownResponse.text();
		expect(knownText).toBe(unknownText);
		expect(knownText).toContain("If that address is in a workspace, a link is on its way.");
		expect(inbox.some((item) => item.to === known)).toBe(true);
		expect(inbox.some((item) => item.to === unknown)).toBe(false);

		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const original = env.EMAIL;
		env.EMAIL = {
			async send(message) {
				await gate;
				const to = typeof message.to === "string" ? message.to : message.to.email;
				inbox.push({ to, text: message.text });
				return { messageId: "hung" };
			},
		};
		try {
			const pending: Promise<unknown>[] = [];
			const ctx = {
				waitUntil(promise: Promise<unknown>) {
					pending.push(promise);
				},
				passThroughOnException() {},
				props: {},
			} as ExecutionContext;
			const responsePromise = worker.fetch(
				new Request("https://stylebook.test/sign-in", {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.72" },
					body: `email=${encodeURIComponent(known)}`,
				}),
				env,
				ctx,
			);
			const winner = await Promise.race([
				responsePromise.then(() => "response"),
				new Promise((resolve) => setTimeout(() => resolve("timeout"), 400)),
			]);
			expect(winner).toBe("response");
			const response = await responsePromise;
			expect(response.status).toBe(200);
			expect(await response.text()).toContain("If that address is in a workspace, a link is on its way.");
			release();
			await Promise.all(pending);
		} finally {
			env.EMAIL = original;
		}
	});

	it("drops Git credentials when a key is revoked, replaced, or the actor is removed", async () => {
		const email = "grant-fix@stylebook.invalid";
		expect((await start("Grants", email, "203.0.113.80")).status).toBe(200);
		const owner = sessionCookie(await confirm(await linkFor(email)));
		const connected = await fetch(`${origin}/agents`, {
			method: "POST",
			headers: { Cookie: owner, "Content-Type": "application/x-www-form-urlencoded" },
			body: "name=Runner&tool=cursor",
		});
		const html = await connected.text();
		const agentKey = html.match(/<code>([0-9a-f]{64})<\/code>/)?.[1] ?? "";
		const agentId = html.match(/name="id" value="([^"]+)"/)?.[1] ?? "";
		const actor = await db
			.prepare(`SELECT id, workspace_id FROM actors WHERE id = ?1`)
			.bind(agentId)
			.first<{ id: string; workspace_id: string }>();
		expect(actor).not.toBeNull();
		const full = await actorById(db, agentId);
		expect(full).not.toBeNull();
		const token = await issueGrant(db, full!, `${actor!.workspace_id}-library`, false, 600);
		const before = await grantByToken(db, token);
		expect(before?.actor.id).toBe(agentId);

		const revoked = await fetch(`${origin}/agents/revoke`, {
			method: "POST",
			headers: { Cookie: owner, "Content-Type": "application/x-www-form-urlencoded" },
			body: `id=${encodeURIComponent(agentId)}`,
		});
		expect(revoked.status).toBe(200);
		expect(await grantByToken(db, token)).toBeNull();
		const left = await db
			.prepare(`SELECT COUNT(*) AS n FROM access_grants WHERE actor_id = ?1`)
			.bind(agentId)
			.first<{ n: number }>();
		expect(left?.n).toBe(0);
		const basic = Buffer.from(`stylebook:${token}`).toString("base64");
		const git = await fetch(`${origin}/git/${actor!.workspace_id}-library.git/info/refs?service=git-upload-pack`, {
			headers: { Authorization: `Basic ${basic}` },
		});
		expect(git.status).toBe(401);

		const fresh = await fetch(`${origin}/agents/key`, {
			method: "POST",
			headers: { Cookie: owner, "Content-Type": "application/x-www-form-urlencoded" },
			body: `id=${encodeURIComponent(agentId)}`,
		});
		expect(fresh.status).toBe(200);
		const again = await issueGrant(db, full!, `${actor!.workspace_id}-library`, false, 600);
		await fetch(`${origin}/agents/key`, {
			method: "POST",
			headers: { Cookie: owner, "Content-Type": "application/x-www-form-urlencoded" },
			body: `id=${encodeURIComponent(agentId)}`,
		});
		expect(await grantByToken(db, again)).toBeNull();

		await db
			.prepare(`INSERT INTO access_grants (token_hash, actor_id, repo_name, can_write, expires_at) VALUES (?1, ?2, ?3, 0, ?4)`)
			.bind(await hashKey("orphan-grant-token-value"), agentId, `${actor!.workspace_id}-library`, "2099-01-01T00:00:00.000Z")
			.run();
		await db.prepare(`DELETE FROM actor_keys WHERE actor_id = ?1`).bind(agentId).run();
		expect(await grantByToken(db, "orphan-grant-token-value")).toBeNull();
		expect(agentKey).toHaveLength(64);
	});

	it("refuses to move an actor between workspaces, including from the demo routes", async () => {
		await registerActor(db, {
			id: "stayput",
			kind: "person",
			name: "Stay",
			workspaceId: "alphaone",
			key: "a".repeat(32),
		});
		await expect(
			registerActor(db, {
				id: "stayput",
				kind: "person",
				name: "Moved",
				workspaceId: "betatwo",
				key: "b".repeat(32),
			}),
		).rejects.toThrow(/another workspace/);
		const stayed = await db
			.prepare(`SELECT workspace_id, name FROM actors WHERE id = ?1`)
			.bind("stayput")
			.first<{ workspace_id: string; name: string }>();
		expect(stayed).toEqual({ workspace_id: "alphaone", name: "Stay" });

		const denied = await fetch(`${origin}/demo/actors`, {
			method: "POST",
			headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
			body: JSON.stringify({
				actors: [{ id: "outsider", kind: "person", name: "Out", workspaceId: "gammthree", key: "c".repeat(32) }],
			}),
		});
		expect(denied.status).toBe(403);
		const created = await db.prepare(`SELECT id FROM actors WHERE id = ?1`).bind("outsider").first();
		expect(created).toBeNull();
	});

	it("looks up who published inside the workspace", async () => {
		const edition = "a".repeat(40);
		const insert = async (workspaceId: string, repo: string) => {
			await db
				.prepare(
					`INSERT INTO gateway_pushes
            (repo_name, ref_name, edition_id, actor_id, actor_name, actor_kind, owner_id, owner_name, model, accepted_at, workspace_id)
           VALUES (?1, 'refs/heads/main', ?2, 'stayput', 'Stay', 'person', 'stayput', 'Stay', NULL, ?3, ?4)`,
				)
				.bind(repo, edition, new Date().toISOString(), workspaceId)
				.run();
		};
		await insert("alphawork", "alphawork-library");
		await insert("betawork", "betawork-library");
		const found = await pushForEdition(db, edition, "alphawork");
		expect(found?.repoName).toBe("alphawork-library");
		const other = await pushForEdition(db, edition, "betawork");
		expect(other?.repoName).toBe("betawork-library");
		const missing = await pushForEdition(db, edition, "nowhere");
		expect(missing).toBeNull();
	});

	it("puts the signed-in header on one line with the page", async () => {
		const email = "header-fix@stylebook.invalid";
		expect((await start("Header", email, "203.0.113.90")).status).toBe(200);
		const cookie = sessionCookie(await confirm(await linkFor(email)));
		const html = await (await fetch(`${origin}/`, { headers: { Cookie: cookie } })).text();
		expect(html).toMatch(/<header>[\s\S]*class="wordmark"[\s\S]*class="account"[\s\S]*People and agents[\s\S]*Sign out[\s\S]*<\/header>/);
		expect(html).toContain(".account");
		expect(html).toContain("font-size: 16px");
		expect(html).toContain("flex-wrap: wrap");
		expect(html).not.toMatch(/<p class="meta bar">/);
	}, 60_000);

	it("renames a Demo workspace person to Editor", async () => {
		await db
			.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES ('demofix', 'Demo', ?1)`)
			.bind(new Date().toISOString())
			.run();
		await db
			.prepare(
				`INSERT INTO actors (id, kind, name, workspace_id, email, created_at)
         VALUES ('demoperson', 'person', 'Demo', 'demofix', 'demo-person@stylebook.invalid', ?1)`,
			)
			.bind(new Date().toISOString())
			.run();
		await db
			.prepare(
				`UPDATE actors SET name = 'Editor'
         WHERE kind = 'person' AND name = 'Demo' AND removed_at IS NULL
           AND workspace_id IN (SELECT id FROM workspaces WHERE name = 'Demo')`,
			)
			.bind()
			.run();
		const renamed = await db.prepare(`SELECT name FROM actors WHERE id = 'demoperson'`).bind().first<{ name: string }>();
		expect(renamed?.name).toBe("Editor");
	});
});
