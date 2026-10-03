import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { aliasBinding } from "../src/demo-copy";
import type { Env } from "../src/env";
import worker from "../src/index";
import { DEMO_UNAVAILABLE } from "../src/permit";
import { libraryName } from "../src/workspace";
import { FakeWorkspace } from "./fake-artifacts";
import { memoryD1 } from "./memory-d1";
import { serveWorker } from "./serve";

const BANNED =
	/\b(git|repos?|branches?|commits?|push(?:ed|ing)?|pull|merge[ds]?|fork(?:ed|ing)?|squash(?:ed|ing)?|rebase[ds]?|clon(?:e|ed|ing)|tokens?|prs?|pr)\b/i;

function visible(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"');
}

function sessionCookie(response: Response): string {
	const cookies = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
	const match = cookies.find((item) => item.startsWith("stylebook="));
	return (match ?? "").split(";")[0] ?? "";
}

function suggestionFor(html: string, why: string): string {
	const at = html.indexOf(why);
	return html.slice(at, at + 900).match(/name="suggestion" value="([^"]+)"/)?.[1] ?? "";
}

describe("the front door", () => {
	let workspace: FakeWorkspace;
	let db: D1Database;
	let origin = "";
	let close: () => Promise<void> = async () => {};
	const state = { cap: "5", perIp: "8" };
	const inbox: { text?: string }[] = [];
	let live: Env;

	beforeAll(async () => {
		workspace = await FakeWorkspace.start();
		db = memoryD1();
		live = {
			WORKSPACE: workspace.binding,
			DEMO_KEY: "secret",
			DB: db,
			SUGGESTIONS: {} as Env["SUGGESTIONS"],
			ARRIVALS: {} as Env["ARRIVALS"],
			get MAX_DEMO_COPIES_PER_DAY() {
				return state.cap;
			},
			get MAX_DEMO_COPIES_PER_IP_PER_DAY() {
				return state.perIp;
			},
			EMAIL: {
				async send(message) {
					inbox.push(message);
					return { messageId: "1" };
				},
			},
		};
		const server = await serveWorker(live);
		origin = server.url;
		close = server.close;
	});

	afterAll(async () => {
		await close();
		await workspace.stop();
	});

	it("shows the landing page, with the jargon kept to the footer", async () => {
		const response = await fetch(`${origin}/`);
		expect(response.status).toBe(200);
		const html = await response.text();
		const text = visible(html);
		expect(BANNED.test(text), text.match(BANNED)?.[0]).toBe(false);
		const footAt = html.indexOf("<footer");
		expect(footAt).toBeGreaterThan(0);
		const above = html.slice(0, footAt).toLowerCase();
		expect(above).not.toContain("open source");
		expect(above).not.toContain("repository");
		expect(above).not.toMatch(/\bgit\b/);
		expect(html.slice(footAt).toLowerCase()).toContain("open source");
		expect(html.slice(footAt)).toContain("https://github.com/a-makelky/stylebook");
		expect(html).toContain("Try the demo");
		expect(html).toContain("Start a workspace");
		expect(html).toContain('href="/sign-in"');
		expect(html).toContain("A shared, versioned library of your team's AI skills");
		expect(html).toContain("Invite your team");
		expect(html).toContain("Connect your agents");
		expect(html).toContain("Do not guess a name the transcript does not spell.");
		expect(html).toContain("Written by Researcher for Editor");
		expect(html).toContain("Keep every name tied to the transcript.");
		expect(html).toContain('class="mark blue"');
		expect(html).toContain("@media (max-width: 640px)");
		expect(html).toContain(".doors { flex-direction: column; align-items: stretch; }");
		expect(html).not.toContain("Sign out");
	});

	it("opens an isolated demo as Editor, an Admin, and counts the work", async () => {
		const first = await fetch(`${origin}/try`, { method: "POST", redirect: "manual" });
		expect(first.status).toBe(303);
		expect(first.headers.get("location")).toBe("/");
		const firstCookie = sessionCookie(first);
		const sourceBefore = workspace.git("demo-library", "rev-parse", "HEAD").trim();
		const started = Date.now();
		const second = await fetch(`${origin}/try`, { method: "POST", redirect: "manual" });
		const forkMs = Date.now() - started;
		expect(second.status).toBe(303);
		expect(forkMs).toBeLessThan(15_000);
		const secondCookie = sessionCookie(second);
		expect(firstCookie).not.toBe(secondCookie);

		const copies = await db
			.prepare(`SELECT workspace_id FROM demo_copies ORDER BY created_at`)
			.bind()
			.all<{ workspace_id: string }>();
		const ids = (copies.results ?? []).map((row) => row.workspace_id);
		expect(ids).toHaveLength(2);
		expect(ids[0]).not.toBe("demo");
		expect(ids[1]).not.toBe(ids[0]);

		const editor = await db
			.prepare(`SELECT name, role FROM actors WHERE workspace_id = ?1 AND kind = 'person'`)
			.bind(ids[0])
			.first<{ name: string; role: string }>();
		expect(editor).toEqual({ name: "Editor", role: "admin" });

		const page = await fetch(`${origin}/`, { headers: { Cookie: firstCookie } });
		const html = await page.text();
		expect(visible(html).match(BANNED)).toBeNull();
		expect(html).toContain("Keep every name tied to the transcript.");
		expect(html).toContain("Written by Researcher for Editor");
		expect(html).toContain("Publish</button>");
		expect(html).toContain("Ask an agent to combine them");
		expect(html).not.toContain("Start here");
		const name = suggestionFor(html, "Keep every name tied to the transcript.");
		expect(name.startsWith(`${ids[0]}-sug-`)).toBe(true);

		const published = await fetch(`${origin}/publish`, {
			method: "POST",
			redirect: "manual",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: firstCookie },
			body: `item=${encodeURIComponent("skills/interview-to-draft/SKILL.md")}&suggestion=${encodeURIComponent(name)}`,
		});
		expect(published.status).toBe(303);
		expect(published.headers.get("location")).toContain("Published");
		const changed = workspace.git(libraryName(ids[0]!), "show", "main:skills/interview-to-draft/SKILL.md");
		expect(changed).toContain("Do not guess a name the transcript does not spell.");
		const other = workspace.git(libraryName(ids[1]!), "show", "main:skills/interview-to-draft/SKILL.md");
		expect(other).not.toContain("Do not guess a name the transcript does not spell.");
		expect(workspace.git("demo-library", "rev-parse", "HEAD").trim()).toBe(sourceBefore);

		const ops = await db
			.prepare(`SELECT COALESCE(SUM(count), 0) AS n FROM workspace_operations WHERE workspace_id = ?1`)
			.bind(ids[0])
			.first<{ n: number }>();
		expect(ops?.n ?? 0).toBeGreaterThan(0);

		state.cap = String(ids.length);
		const full = await fetch(`${origin}/try`, { method: "POST", redirect: "manual" });
		expect(full.status).toBe(429);
		expect(await full.text()).toContain("The demo is full for today.");
		state.cap = "5";
	}, 120_000);

	it("deletes an expired demo copy on the scheduled job", async () => {
		const row = await db
			.prepare(`SELECT workspace_id FROM demo_copies ORDER BY created_at LIMIT 1`)
			.bind()
			.first<{ workspace_id: string }>();
		const id = row?.workspace_id ?? "";
		expect(id).not.toBe("");
		await db.prepare(`UPDATE demo_copies SET expires_at = ?1 WHERE workspace_id = ?2`).bind("2000-01-01T00:00:00.000Z", id).run();
		await worker.scheduled!({ cron: "17 * * * *", scheduledTime: Date.now(), noRetry() {} }, live);
		const left = await db.prepare(`SELECT workspace_id FROM demo_copies WHERE workspace_id = ?1`).bind(id).first();
		expect(left).toBeNull();
		expect(() => workspace.git(libraryName(id), "rev-parse", "HEAD")).toThrow();
		expect(workspace.git("demo-library", "rev-parse", "HEAD").trim()).not.toBe("");
		const home = await fetch(`${origin}/`);
		expect(await home.text()).toContain("Try the demo");
	});

	it("welcomes a new workspace and explains an empty list of suggestions", async () => {
		const started = await fetch(`${origin}/start`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "workspace=North&email=ada.front@stylebook.invalid",
		});
		expect(started.status).toBe(200);
		const secret = inbox.at(-1)?.text?.match(/\/s\/([0-9a-f]{64})/)?.[1] ?? "";
		const signed = await fetch(`${origin}/s/${secret}`, { method: "POST", redirect: "manual" });
		const cookie = sessionCookie(signed);
		const home = await fetch(`${origin}/`, { headers: { Cookie: cookie } });
		const html = await home.text();
		expect(visible(html).match(BANNED)).toBeNull();
		expect(html).toContain("Start here");
		expect(html).toContain("Read a skill.");
		expect(html).toContain('href="/people">Invite someone');
		expect(html).toContain('href="/connect">Connect an agent');
		expect(html).toContain("No suggestions yet.");
		expect(html).toContain("A suggestion arrives when a person or an agent proposes a change.");
		const dismissed = await fetch(`${origin}/welcome`, {
			method: "POST",
			redirect: "manual",
			headers: { Cookie: cookie },
		});
		expect(dismissed.status).toBe(303);
		const after = await (await fetch(`${origin}/`, { headers: { Cookie: cookie } })).text();
		expect(after).not.toContain("Start here");
		expect(after).toContain("No suggestions yet.");
	});

	it("keeps a signed-in session when Try the demo is clicked", async () => {
		const before = await db.prepare(`SELECT COUNT(*) AS n FROM demo_copies`).bind().first<{ n: number }>();
		const started = await fetch(`${origin}/start`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "workspace=Kept&email=kept.front@stylebook.invalid",
		});
		expect(started.status).toBe(200);
		const secret = inbox.at(-1)?.text?.match(/\/s\/([0-9a-f]{64})/)?.[1] ?? "";
		const signed = await fetch(`${origin}/s/${secret}`, { method: "POST", redirect: "manual" });
		const cookie = sessionCookie(signed);
		const tried = await fetch(`${origin}/try`, { method: "POST", redirect: "manual", headers: { Cookie: cookie } });
		expect(tried.status).toBe(303);
		expect(tried.headers.get("location")).toBe("/");
		expect(tried.headers.get("set-cookie")).toBeNull();
		const after = await db.prepare(`SELECT COUNT(*) AS n FROM demo_copies`).bind().first<{ n: number }>();
		expect(after?.n).toBe(before?.n);
		const home = await (await fetch(`${origin}/`, { headers: { Cookie: cookie } })).text();
		expect(home).toContain("Kept");
		expect(home).toContain("Sign out");
	});

	it("closes invite, backups, agent keys, and connect on a demo copy", async () => {
		state.cap = "80";
		state.perIp = "8";
		const opened = await fetch(`${origin}/try`, {
			method: "POST",
			redirect: "manual",
			headers: { "CF-Connecting-IP": "203.0.113.50" },
		});
		expect(opened.status).toBe(303);
		const cookie = sessionCookie(opened);
		const people = await (await fetch(`${origin}/people`, { headers: { Cookie: cookie } })).text();
		expect(people).toContain(DEMO_UNAVAILABLE);
		expect(people).not.toContain('action="/invite"');
		expect(people).not.toContain("New key");
		const connect = await (await fetch(`${origin}/connect`, { headers: { Cookie: cookie } })).text();
		expect(connect).toContain(DEMO_UNAVAILABLE);
		expect(connect).not.toContain("Add custom connector");
		const backups = await (await fetch(`${origin}/backups`, { headers: { Cookie: cookie } })).text();
		expect(backups).toContain(DEMO_UNAVAILABLE);
		expect(backups).toContain("Download");
		expect(backups).not.toContain("Connect GitHub");
		expect(backups).not.toContain('action="/backups/other"');
		const invited = await fetch(`${origin}/invite`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
			body: "email=guest.front@stylebook.invalid&role=member",
		});
		expect(await invited.text()).toContain(DEMO_UNAVAILABLE);
		const waiting = await db
			.prepare(`SELECT id FROM invitations WHERE email = ?1`)
			.bind("guest.front@stylebook.invalid")
			.first();
		expect(waiting).toBeNull();
		const keyed = await fetch(`${origin}/agents`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
			body: "name=Extra&tool=other",
		});
		const keyedHtml = await keyed.text();
		expect(keyedHtml).toContain(DEMO_UNAVAILABLE);
		expect(keyedHtml).not.toContain("shown once");
		const mirrored = await fetch(`${origin}/backups/other`, {
			method: "POST",
			redirect: "manual",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
			body: "address=https://example.invalid/library.git&login=stylebook&secret=hidden",
		});
		expect(mirrored.status).toBe(303);
		expect(new URL(mirrored.headers.get("location") ?? "", origin).searchParams.get("notice")).toBe(DEMO_UNAVAILABLE);
		const mirror = await db.prepare(`SELECT workspace_id FROM backup_mirrors`).bind().first();
		expect(mirror).toBeNull();
	});

	it("counts the day's copies and one network in the same statement", async () => {
		state.cap = "80";
		state.perIp = "1";
		const forwarded = await fetch(`${origin}/try`, {
			method: "POST",
			redirect: "manual",
			headers: { "X-Forwarded-For": "198.51.100.8" },
		});
		expect(forwarded.status).toBe(429);
		expect(await forwarded.text()).toContain("from this network today");
		const burst = await Promise.all(
			[1, 2, 3, 4].map(() =>
				fetch(`${origin}/try`, {
					method: "POST",
					redirect: "manual",
					headers: { "CF-Connecting-IP": "203.0.113.60" },
				}),
			),
		);
		expect(burst.filter((response) => response.status === 303)).toHaveLength(1);
		const refused = burst.filter((response) => response.status === 429);
		expect(refused).toHaveLength(3);
		expect(await refused[0]!.text()).toContain("from this network today");
		const before = await db.prepare(`SELECT COUNT(*) AS n FROM demo_copies`).bind().first<{ n: number }>();
		state.perIp = "40";
		state.cap = String((before?.n ?? 0) + 1);
		const raced = await Promise.all(
			["203.0.113.71", "203.0.113.72", "203.0.113.73", "203.0.113.74"].map((ip) =>
				fetch(`${origin}/try`, {
					method: "POST",
					redirect: "manual",
					headers: { "CF-Connecting-IP": ip },
				}),
			),
		);
		expect(raced.filter((response) => response.status === 303)).toHaveLength(1);
		expect(raced.filter((response) => response.status === 429)).toHaveLength(3);
		const after = await db.prepare(`SELECT COUNT(*) AS n FROM demo_copies`).bind().first<{ n: number }>();
		expect(after?.n).toBe((before?.n ?? 0) + 1);
		state.cap = "80";
		state.perIp = "40";
	}, 120_000);

	it("deletes every row for a copy and sweeps leftover repos", async () => {
		state.cap = "80";
		state.perIp = "40";
		const opened = await fetch(`${origin}/try`, {
			method: "POST",
			redirect: "manual",
			headers: { "CF-Connecting-IP": "203.0.113.90" },
		});
		expect(opened.status).toBe(303);
		const row = await db
			.prepare(`SELECT workspace_id FROM demo_copies WHERE ip = ?1 ORDER BY created_at DESC LIMIT 1`)
			.bind("203.0.113.90")
			.first<{ workspace_id: string }>();
		const id = row?.workspace_id ?? "";
		expect(id).toMatch(/^d[a-z0-9]{7}$/);
		const now = new Date().toISOString();
		const actor = `${id}editor`;
		await db
			.prepare(
				`INSERT INTO backup_mirrors (workspace_id, kind, address, updated_at) VALUES (?1, 'other', 'https://example.invalid/library.git', ?2)`,
			)
			.bind(id, now)
			.run();
		await db
			.prepare(`INSERT INTO backup_states (state_hash, workspace_id, actor_id, created_at) VALUES (?1, ?2, ?3, ?4)`)
			.bind(`state-${id}`, id, actor, now)
			.run();
		await db
			.prepare(
				`INSERT INTO workspace_audit (workspace_id, actor_id, actor_name, action, detail, at) VALUES (?1, ?2, 'Editor', 'mirror-connect', 'Started connecting.', ?3)`,
			)
			.bind(id, actor, now)
			.run();
		await db
			.prepare(`INSERT INTO service_audit (at, action, workspace_id, detail) VALUES (?1, 'note', ?2, 'demo')`)
			.bind(now, id)
			.run();
		await db
			.prepare(
				`INSERT INTO sign_in_links (token_hash, email, purpose, workspace_id, created_at, expires_at) VALUES (?1, 'visitor.demo@stylebook.invalid', 'invite', ?2, ?3, ?3)`,
			)
			.bind(`link-${id}`, id, now)
			.run();
		await db
			.prepare(
				`INSERT INTO arrivals (repo_name, ref_name, edition_id, kind, arrived_at, recorded_at) VALUES (?1, 'main', ?2, 'push', ?3, ?3)`,
			)
			.bind(`${id}-library`, `edition-${id}`, now)
			.run();
		await workspace.binding.create("dorphan1-library", { description: "leftover" });
		await workspace.binding.create("dorphan1-sug-left", { description: "leftover" });
		const kept = await db
			.prepare(`SELECT workspace_id FROM demo_copies WHERE workspace_id != ?1 LIMIT 1`)
			.bind(id)
			.first<{ workspace_id: string }>();
		expect(kept?.workspace_id).toBeTruthy();
		await db.prepare(`UPDATE demo_copies SET expires_at = ?1 WHERE workspace_id = ?2`).bind("2000-01-01T00:00:00.000Z", id).run();
		await worker.scheduled!({ cron: "17 * * * *", scheduledTime: Date.now(), noRetry() {} }, live);
		expect(await db.prepare(`SELECT workspace_id FROM demo_copies WHERE workspace_id = ?1`).bind(id).first()).toBeNull();
		expect(await db.prepare(`SELECT workspace_id FROM backup_mirrors WHERE workspace_id = ?1`).bind(id).first()).toBeNull();
		expect(await db.prepare(`SELECT workspace_id FROM backup_states WHERE workspace_id = ?1`).bind(id).first()).toBeNull();
		expect(await db.prepare(`SELECT workspace_id FROM workspace_audit WHERE workspace_id = ?1`).bind(id).first()).toBeNull();
		expect(await db.prepare(`SELECT workspace_id FROM service_audit WHERE workspace_id = ?1`).bind(id).first()).toBeNull();
		expect(await db.prepare(`SELECT workspace_id FROM sign_in_links WHERE workspace_id = ?1`).bind(id).first()).toBeNull();
		expect(await db.prepare(`SELECT repo_name FROM arrivals WHERE repo_name = ?1`).bind(`${id}-library`).first()).toBeNull();
		expect(await db.prepare(`SELECT id FROM workspaces WHERE id = ?1`).bind(id).first()).toBeNull();
		expect(await db.prepare(`SELECT id FROM actors WHERE workspace_id = ?1`).bind(id).first()).toBeNull();
		expect(() => workspace.git(libraryName(id), "rev-parse", "HEAD")).toThrow();
		expect(() => workspace.git("dorphan1-library", "rev-parse", "HEAD")).toThrow();
		expect(() => workspace.git("dorphan1-sug-left", "rev-parse", "HEAD")).toThrow();
		expect(workspace.git("demo-library", "rev-parse", "HEAD").trim()).not.toBe("");
		expect(workspace.git(libraryName(kept!.workspace_id), "rev-parse", "HEAD").trim()).not.toBe("");
		expect(
			await db.prepare(`SELECT workspace_id FROM demo_copies WHERE workspace_id = ?1`).bind(kept!.workspace_id).first(),
		).not.toBeNull();
	});
});

describe("the shared demo library stays read-only", () => {
	it("forwards reads and throws on anything else", async () => {
		const calls: string[] = [];
		const shared = {
			async readFile() {
				calls.push("read");
				return { async arrayBuffer() { return new Uint8Array([1]).buffer; } };
			},
			async log() {
				calls.push("log");
				return [];
			},
			async readTree() {
				calls.push("tree");
				return [];
			},
			async listFiles() {
				calls.push("list");
				return [];
			},
			async fork() {
				calls.push("fork");
			},
			async createToken() {
				calls.push("token");
			},
		};
		const binding = {
			async get(name: string) {
				calls.push(`get:${name}`);
				return shared;
			},
		};
		const aliased = aliasBinding(
			binding as unknown as Artifacts,
			new Map([["d1234567-library", shared as unknown as ArtifactsRepo]]),
		);
		const repo = await aliased.get("d1234567-library");
		await repo.readFile({ ref: "main", path: "skills/a" });
		await repo.log({ ref: "main", limit: 1 });
		await repo.readTree("abc");
		// The generated binding types have no listFiles. The allow-list still
		// forwards that name, and the generated types win for what is called.
		await (repo as unknown as { listFiles: () => Promise<unknown> }).listFiles();
		await expect(repo.fork("elsewhere")).rejects.toThrow("DEMO_LIBRARY_READONLY");
		await expect((repo as unknown as { createToken: () => Promise<void> }).createToken()).rejects.toThrow(
			"DEMO_LIBRARY_READONLY",
		);
		expect(calls).toEqual(["read", "log", "tree", "list"]);
		await aliased.get("demo-library");
		expect(calls).toContain("get:demo-library");
	});
});
