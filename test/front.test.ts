import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
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
	const state = { cap: "5" };
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
		expect(html).toContain(">Publish<");
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
});
