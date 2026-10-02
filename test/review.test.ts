import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { registerActor } from "../src/actors";
import { changedSections, combineChanges, merge3, sameLinesConflict } from "../src/diff";
import type { Env } from "../src/env";
import worker from "../src/index";
import { STARTER_SKILL, STARTER_SKILL_PATH } from "../src/seed";
import { recordPush } from "../src/audit";
import { SUGGESTION_READS } from "../src/review";
import { LIBRARY, readBytes } from "../src/workspace";
import { FakeWorkspace } from "./fake-artifacts";
import { memoryD1 } from "./memory-d1";
import { serveWorker } from "./serve";

const PERSON_KEY = "review-person-key-0001";
const AGENT_KEY = "review-agent-key-00001";
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

function assertClean(html: string) {
	const text = visible(html);
	const found = text.match(BANNED);
	expect(found, text.slice(0, 500)).toBeNull();
}

describe("compare and combine", () => {
	const step = "1. Read the whole transcript before writing anything.";
	const left = STARTER_SKILL.replace(step, "1. Read the whole transcript, including the small talk, before writing anything.");
	const right = STARTER_SKILL.replace(step, "1. Read the whole transcript twice before writing anything.");
	const added = STARTER_SKILL.replace(
		"## Never\n",
		"## Never\n\n- Keep a second list of what was left out.\n",
	);

	it("flags a shared section and a shared line", () => {
		expect(changedSections(STARTER_SKILL, left)).toContain("Steps");
		expect(changedSections(STARTER_SKILL, added)).toContain("Never");
		expect(sameLinesConflict(STARTER_SKILL, left, right)).toBe(true);
		expect(sameLinesConflict(STARTER_SKILL, left, added)).toBe(false);
		const clean = merge3(STARTER_SKILL, left, added);
		expect(clean.ok).toBe(true);
		if (clean.ok) {
			expect(clean.text).toContain("including the small talk");
			expect(clean.text).toContain("what was left out");
		}
	});

	it("keeps both sections, in order, when a combination is asked for", () => {
		const combined = combineChanges(STARTER_SKILL, left, right);
		const first = combined.indexOf("including the small talk");
		const second = combined.indexOf("Read the whole transcript twice");
		expect(first).toBeGreaterThan(-1);
		expect(second).toBeGreaterThan(first);
		expect(combined.indexOf("## Steps")).toBeLessThan(first);
	});
});

describe("review screen", () => {
	let workspace: FakeWorkspace;
	let db: D1Database;
	let origin = "";
	let close: () => Promise<void> = async () => {};
	let cookie = "";

	const env = (): Env => ({
		WORKSPACE: workspace.binding,
		DEMO_KEY: "secret",
		DB: db,
		SUGGESTIONS: {} as Env["SUGGESTIONS"],
		ARRIVALS: {} as Env["ARRIVALS"],
	});

	beforeAll(async () => {
		workspace = await FakeWorkspace.start();
		db = memoryD1();
		await registerActor(db, { id: "reviewer", kind: "person", name: "Editor", key: PERSON_KEY });
		await registerActor(db, {
			id: "pencil",
			kind: "agent",
			name: "Cursor",
			ownerId: "reviewer",
			model: "cursor",
			key: AGENT_KEY,
		});
		const server = await serveWorker(env());
		origin = server.url;
		close = server.close;
	});

	afterAll(async () => {
		await close();
		await workspace.stop();
	});

	async function post(path: string, body: string, headers: Record<string, string> = {}) {
		return fetch(`${origin}${path}`, {
			method: "POST",
			redirect: "manual",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, ...headers },
			body,
		});
	}

	it("signs in with a Stylebook key and publishes the sample library", async () => {
		const anon = await fetch(`${origin}/`);
		expect(anon.status).toBe(200);
		const signIn = await anon.text();
		expect(signIn).toContain("Stylebook key");
		assertClean(signIn);
		expect(signIn).toContain("@media (max-width: 1099px)");
		expect(signIn).toContain(".page { order: 1; }");
		expect(signIn).toContain(".suggestions { order: 2; }");
		expect(signIn).toContain(".contents { order: 3; }");

		const refused = await fetch(`${origin}/sign-in`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "key=secret",
		});
		expect(refused.status).toBe(401);

		const signed = await fetch(`${origin}/sign-in`, {
			method: "POST",
			redirect: "manual",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: `key=${encodeURIComponent(PERSON_KEY)}`,
		});
		expect(signed.status).toBe(303);
		const set = signed.headers.get("set-cookie") ?? "";
		expect(set).toContain("HttpOnly");
		expect(set).toContain("Secure");
		expect(set).toContain("SameSite=Strict");
		cookie = set.split(";")[0] ?? "";

		const desk = await fetch(`${origin}/`, { headers: { Cookie: cookie } });
		const html = await desk.text();
		assertClean(html);
		expect(html).toContain("Interview to draft");
		expect(html).toContain("Feature article");
		expect(html).toContain("Edition 1");
		const file = await readBytes(await workspace.binding.get(LIBRARY), STARTER_SKILL_PATH);
		expect(new TextDecoder().decode(file!)).toBe(STARTER_SKILL);
	}, 60_000);

	it("flags an overlap, refuses a messy publish, and offers three ways out", async () => {
		const step = "1. Read the whole transcript before writing anything.";
		const left = STARTER_SKILL.replace(step, "1. Read the whole transcript, including the small talk, before writing anything.");
		const right = STARTER_SKILL.replace(step, "1. Read the whole transcript twice before writing anything.");
		for (const [session, content, why] of [
			["001", left, "Mention the small talk."],
			["007", right, "Ask for a second read."],
		] as const) {
			const saved = await fetch(`${origin}/suggestion`, {
				method: "POST",
				headers: { Authorization: `Bearer ${AGENT_KEY}`, "Content-Type": "application/json" },
				body: JSON.stringify({ session, path: STARTER_SKILL_PATH, content, why }),
			});
			expect(saved.status, await saved.clone().text()).toBe(200);
		}

		const page = await fetch(`${origin}/?item=${encodeURIComponent(STARTER_SKILL_PATH)}&suggestion=sug-pencil-001`, {
			headers: { Cookie: cookie },
		});
		const html = await page.text();
		assertClean(html);
		expect(html).toContain("This and Suggestion 7 both change");
		expect(html).toContain("<em>Steps</em>");
		expect(html).toContain("Written by Cursor for Editor");
		expect(html).toContain("Mention the small talk.");
		expect(html).toContain("2 suggestions");
		expect(html).toContain('class="mark blue"');
		expect(html).toContain('class="mark red"');

		const before = workspace.git(LIBRARY, "rev-parse", "HEAD").trim();
		const published = await post(
			"/publish",
			`item=${encodeURIComponent(STARTER_SKILL_PATH)}&suggestion=sug-pencil-001`,
		);
		expect(published.status).toBe(303);
		expect(published.headers.get("location")).toContain("Nothing");
		expect(workspace.git(LIBRARY, "rev-parse", "HEAD").trim()).toBe(before);

		const kept = await post(
			"/resolve",
			`item=${encodeURIComponent(STARTER_SKILL_PATH)}&suggestion=sug-pencil-001&mode=keep-other`,
		);
		expect(kept.status).toBe(303);
		expect(new URL(kept.headers.get("location") ?? "/", origin).searchParams.get("notice")).toContain(
			"Kept the other",
		);
		const afterOther = new TextDecoder().decode((await readBytes(await workspace.binding.get(LIBRARY), STARTER_SKILL_PATH))!);
		expect(afterOther).toContain("Read the whole transcript twice");
		expect(afterOther).not.toContain("including the small talk");

		const again = await fetch(`${origin}/suggestion`, {
			method: "POST",
			headers: { Authorization: `Bearer ${AGENT_KEY}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				session: "003",
				path: STARTER_SKILL_PATH,
				content: left.replace("including the small talk", "including the pauses"),
				why: "Mention the pauses.",
			}),
		});
		expect(again.status).toBe(200);
		const keptThis = await post(
			"/resolve",
			`item=${encodeURIComponent(STARTER_SKILL_PATH)}&suggestion=sug-pencil-003&mode=keep-this`,
		);
		expect(keptThis.status).toBe(303);
		const afterThis = new TextDecoder().decode((await readBytes(await workspace.binding.get(LIBRARY), STARTER_SKILL_PATH))!);
		expect(afterThis).toContain("including the pauses");

		await post("/decline", `item=${encodeURIComponent(STARTER_SKILL_PATH)}&suggestion=sug-pencil-001`);
		await post("/decline", `item=${encodeURIComponent(STARTER_SKILL_PATH)}&suggestion=sug-pencil-007`);
		const freshLeft = afterThis.replace("including the pauses", "including the small talk");
		const freshRight = afterThis.replace("including the pauses", "including the asides");
		await fetch(`${origin}/suggestion`, {
			method: "POST",
			headers: { Authorization: `Bearer ${AGENT_KEY}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				session: "011",
				path: STARTER_SKILL_PATH,
				content: freshLeft,
				why: "Bring back the small talk.",
			}),
		});
		await fetch(`${origin}/suggestion`, {
			method: "POST",
			headers: { Authorization: `Bearer ${AGENT_KEY}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				session: "012",
				path: STARTER_SKILL_PATH,
				content: freshRight,
				why: "Mention the asides.",
			}),
		});
		const combined = await post(
			"/resolve",
			`item=${encodeURIComponent(STARTER_SKILL_PATH)}&suggestion=sug-pencil-011&mode=combine`,
		);
		expect(combined.status).toBe(303);
		const location = combined.headers.get("location") ?? "";
		expect(location).toContain("suggestion=sug-pencil-combine-");
		const copy = new URL(location, origin).searchParams.get("suggestion")!;
		const info = await (await workspace.binding.get(copy)).info();
		expect(info.source).toBe(`artifacts:${workspace.namespace}/library`);
		const combinedText = new TextDecoder().decode((await readBytes(await workspace.binding.get(copy), STARTER_SKILL_PATH))!);
		expect(combinedText.indexOf("including the small talk")).toBeGreaterThan(-1);
		expect(combinedText.indexOf("including the asides")).toBeGreaterThan(combinedText.indexOf("including the small talk"));

		const view = await fetch(`${origin}${location}`, { headers: { Cookie: cookie } });
		const viewHtml = await view.text();
		assertClean(viewHtml);
		expect(viewHtml).toContain('class="mark green"');
		expect(viewHtml).toContain("Combined both changes, in order");

		const shipped = await post("/publish", `item=${encodeURIComponent(STARTER_SKILL_PATH)}&suggestion=${encodeURIComponent(copy)}`);
		expect(shipped.status).toBe(303);
		expect(new URL(shipped.headers.get("location") ?? "/", origin).searchParams.get("notice")).toContain(
			"Published as edition",
		);
		const finalText = new TextDecoder().decode((await readBytes(await workspace.binding.get(LIBRARY), STARTER_SKILL_PATH))!);
		expect(finalText).toContain("including the small talk");
		expect(finalText).toContain("including the asides");
		const history = await fetch(`${origin}/?item=${encodeURIComponent(STARTER_SKILL_PATH)}`, { headers: { Cookie: cookie } });
		const historyHtml = await history.text();
		assertClean(historyHtml);
		const newest = historyHtml.match(/Edition \d+\. [^<]+/)?.[0] ?? "";
		expect(newest).toContain("Written by Cursor for Editor, approved by Editor.");
	}, 60_000);

	it("retries a second publish so neither change is lost", async () => {
		const brief = "skills/research-brief/SKILL.md";
		const current = new TextDecoder().decode((await readBytes(await workspace.binding.get(LIBRARY), brief))!);
		const left = current.replace("## Steps\n", "## Steps\n\n- Count the sources.\n");
		const right = current.replace("## Never\n", "## Never\n\n- Do not invent a source.\n");
		const make = async (session: string, content: string) => {
			const saved = await fetch(`${origin}/suggestion`, {
				method: "POST",
				headers: { Authorization: `Bearer ${AGENT_KEY}`, "Content-Type": "application/json" },
				body: JSON.stringify({ session, path: brief, content, why: `Add a line for ${session}.` }),
			});
			expect(saved.status, await saved.clone().text()).toBe(200);
		};
		await make("021", left);
		await make("022", right);
		const [one, two] = await Promise.all([
			post("/publish", `item=${encodeURIComponent(brief)}&suggestion=sug-pencil-021`),
			post("/publish", `item=${encodeURIComponent(brief)}&suggestion=sug-pencil-022`),
		]);
		expect([one.status, two.status]).toEqual([303, 303]);
		const text = new TextDecoder().decode((await readBytes(await workspace.binding.get(LIBRARY), brief))!);
		expect(text).toContain("Count the sources.");
		expect(text).toContain("Do not invent a source.");
	}, 60_000);

	it("puts who behind a Stylebook key and locks the library for an agent", async () => {
		const edition = workspace.git(LIBRARY, "rev-parse", "HEAD").trim();
		const open = await worker.fetch(new Request(`https://stylebook.test/who?edition=${edition}`), env());
		expect(open.status).toBe(401);
		const demo = await worker.fetch(
			new Request(`https://stylebook.test/who?edition=${edition}`, {
				headers: { Authorization: "Bearer secret" },
			}),
			env(),
		);
		expect(demo.status).toBe(401);
		const named = await worker.fetch(
			new Request(`https://stylebook.test/who?edition=${edition}`, {
				headers: { Authorization: `Bearer ${PERSON_KEY}` },
			}),
			env(),
		);
		expect(named.status).toBe(200);

		const agentPage = await fetch(`${origin}/`, { headers: { Authorization: `Bearer ${AGENT_KEY}` } });
		const html = await agentPage.text();
		assertClean(html);
		expect(html).toContain("Locked");
		const denied = await fetch(`${origin}/publish`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${AGENT_KEY}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: `item=${encodeURIComponent(STARTER_SKILL_PATH)}&suggestion=sug-pencil-001`,
		});
		expect(denied.status).toBe(403);
	});

	it("reads a page of copies instead of every copy", async () => {
		const editor = { id: "reviewer", kind: "person" as const, name: "Editor", ownerId: null, model: null };
		for (let index = 0; index < 40; index++) {
			await recordPush(db, {
				repoName: `sug-reviewer-old${index}`,
				refName: "refs/heads/main",
				editionId: index.toString(16).padStart(40, "a"),
				actor: editor,
				owner: editor,
				acceptedAt: `2020-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
			});
		}
		workspace.gets = [];
		const response = await fetch(`${origin}/?item=${encodeURIComponent(STARTER_SKILL_PATH)}`, {
			headers: { Cookie: cookie },
		});
		expect(response.status).toBe(200);
		const html = await response.text();
		assertClean(html);
		const names = new Set(workspace.gets.filter((name) => name.startsWith("sug-")));
		expect(names.size).toBeLessThanOrEqual(SUGGESTION_READS + 1);
		expect(names.size).toBeLessThan(40);
		expect(html).toContain("Older suggestions");
	});
});
