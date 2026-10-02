import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashKey } from "../src/actors";
import type { Env } from "../src/env";
import { LIMIT_MESSAGE } from "../src/limits";
import { STARTER_SKILL, STARTER_SKILL_PATH } from "../src/seed";
import { operationCounts } from "../src/usage";
import { FakeWorkspace } from "./fake-artifacts";
import { memoryD1 } from "./memory-d1";
import { serveWorker } from "./serve";

const BANNED =
	/\b(git|repos?|branches?|commits?|push(?:ed|ing)?|pull|merge[ds]?|fork(?:ed|ing)?|squash(?:ed|ing)?|rebase[ds]?|clon(?:e|ed|ing)|tokens?|prs?|pr)\b/i;

function visible(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<pre\b[^>]*\bdata-setup\b[^>]*>[\s\S]*?<\/pre>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&");
}

function sessionCookie(response: Response): string {
	const cookies = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
	const match = cookies.find((item) => item.startsWith("stylebook="));
	return (match ?? "").split(";")[0] ?? "";
}

function chooseCookie(response: Response): string {
	const cookies = response.headers.getSetCookie?.() ?? [];
	const match = cookies.find((item) => item.startsWith("stylebook_choose="));
	return (match ?? "").split(";")[0] ?? "";
}

describe("workspaces, sign-in, invites and agents", () => {
	let workspace: FakeWorkspace;
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
		MAX_PEOPLE: "25",
		MAX_AGENTS: "40",
		MAX_OPEN_SUGGESTIONS: "200",
		MAX_SIGN_IN_EMAILS_PER_HOUR: "30",
		MAX_SIGN_IN_EMAILS_PER_IP_PER_HOUR: "80",
		EMAIL: {
			async send(message) {
				const to = typeof message.to === "string" ? message.to : message.to.email;
				inbox.push({ to, text: message.text });
				return { messageId: "1" };
			},
		},
	};

	beforeAll(async () => {
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

	async function linkFor(email: string): Promise<string> {
		const letter = [...inbox].reverse().find((item) => item.to === email);
		const secret = letter?.text?.match(/\/s\/([0-9a-f]{64})/)?.[1] ?? "";
		expect(secret).toHaveLength(64);
		const stored = await db
			.prepare(`SELECT token_hash FROM sign_in_links WHERE token_hash = ?1`)
			.bind(secret)
			.first();
		expect(stored).toBeNull();
		const hashed = await db
			.prepare(`SELECT token_hash FROM sign_in_links WHERE token_hash = ?1`)
			.bind(await hashKey(secret))
			.first();
		expect(hashed).not.toBeNull();
		return secret;
	}

	async function openWorkspace(name: string, email: string): Promise<string> {
		const started = await fetch(`${origin}/start`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: `workspace=${encodeURIComponent(name)}&email=${encodeURIComponent(email)}`,
		});
		expect(started.status).toBe(200);
		const secret = await linkFor(email);
		const signed = await fetch(`${origin}/s/${secret}`, { redirect: "manual" });
		expect(signed.status).toBe(303);
		const cookie = sessionCookie(signed);
		expect(cookie.startsWith("stylebook=")).toBe(true);
		const again = await fetch(`${origin}/s/${secret}`);
		expect(await again.text()).toContain("already used");
		return cookie;
	}

	it("keeps two workspaces from seeing each other", async () => {
		const north = await openWorkspace("North", "north@stylebook.invalid");
		const northPage = await fetch(`${origin}/`, { headers: { Cookie: north } });
		const northHtml = await northPage.text();
		expect(visible(northHtml)).toContain("North");
		expect(northHtml).toContain("Interview to draft");
		expect(BANNED.test(visible(northHtml))).toBe(false);

		const connected = await fetch(`${origin}/agents`, {
			method: "POST",
			headers: { Cookie: north, "Content-Type": "application/x-www-form-urlencoded" },
			body: "name=Researcher&tool=cursor",
		});
		const shown = await connected.text();
		expect(BANNED.test(visible(shown))).toBe(false);
		const agentKey = shown.match(/<code>([0-9a-f]{64})<\/code>/)?.[1] ?? "";
		const library = shown.match(/\/git\/([a-z0-9-]+)\.git/)?.[1] ?? "";
		expect(library.endsWith("-library")).toBe(true);
		const northId = library.replace(/-library$/, "");

		const south = await openWorkspace("South", "south@stylebook.invalid");
		const southConnected = await fetch(`${origin}/agents`, {
			method: "POST",
			headers: { Cookie: south, "Content-Type": "application/x-www-form-urlencoded" },
			body: "name=Proofreader&tool=other",
		});
		const southHtml = await southConnected.text();
		const southKey = southHtml.match(/<code>([0-9a-f]{64})<\/code>/)?.[1] ?? "";
		const southLibrary = southHtml.match(/\/git\/([a-z0-9-]+)\.git/)?.[1] ?? "";
		expect(southLibrary).not.toBe(library);

		const added = `${STARTER_SKILL}\n\nNorth only line.\n`;
		const suggested = await fetch(`${origin}/mcp`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${agentKey}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "suggest_change",
					arguments: { path: STARTER_SKILL_PATH, content: added, why: "A line only North should see.", session: "one" },
				},
			}),
		});
		const suggestedBody = (await suggested.json()) as { result: { content: { text: string }[]; isError: boolean } };
		expect(suggestedBody.result.isError, suggestedBody.result.content[0]?.text).toBe(false);
		const copy = suggestedBody.result.content[0]?.text.match(/Saved suggestion (\S+)/)?.[1] ?? "";
		expect(copy.startsWith(`${northId}-sug-`)).toBe(true);

		const published = await fetch(`${origin}/publish`, {
			method: "POST",
			redirect: "manual",
			headers: { Cookie: north, "Content-Type": "application/x-www-form-urlencoded" },
			body: `item=${encodeURIComponent(STARTER_SKILL_PATH)}&suggestion=${encodeURIComponent(copy)}`,
		});
		expect(published.status).toBe(303);

		const northAfter = await (await fetch(`${origin}/`, { headers: { Cookie: north } })).text();
		const southAfter = await (await fetch(`${origin}/`, { headers: { Cookie: south } })).text();
		expect(northAfter).toContain("North only line.");
		expect(southAfter).not.toContain("North only line.");
		expect(southAfter).not.toContain(copy);

		const listed = await fetch(`${origin}/mcp`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${southKey}`,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "list_suggestions", arguments: { path: STARTER_SKILL_PATH } },
			}),
		});
		const listedText = JSON.stringify(await listed.json());
		expect(listedText).not.toContain(copy);
		expect(listedText).not.toContain("North only line.");

		const denied = await fetch(`${origin}/git/${library}.git/info/refs?service=git-upload-pack`, {
			headers: { Authorization: `Bearer ${southKey}` },
		});
		expect(denied.status).toBe(403);
		const allowed = await fetch(`${origin}/git/${library}.git/info/refs?service=git-upload-pack`, {
			headers: { Authorization: `Bearer ${agentKey}` },
		});
		expect(allowed.status).not.toBe(403);

		const counts = await operationCounts(db, northId);
		expect((counts.get ?? 0) + (counts.read ?? 0)).toBeGreaterThan(0);

		env.MAX_WORKSPACES = "2";
		const blocked = await fetch(`${origin}/start`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "workspace=East&email=east@stylebook.invalid",
		});
		expect(blocked.status).toBe(429);
		expect(await blocked.text()).toContain(LIMIT_MESSAGE.workspaces);
		env.MAX_WORKSPACES = "40";
	}, 60_000);

	it("invites a colleague into the same workspace and remove ends the session", async () => {
		const owner = await openWorkspace("Studio", "owner@stylebook.invalid");
		const invited = await fetch(`${origin}/invite`, {
			method: "POST",
			headers: { Cookie: owner, "Content-Type": "application/x-www-form-urlencoded" },
			body: "email=colleague@stylebook.invalid",
		});
		expect(invited.status).toBe(200);
		const secret = await linkFor("colleague@stylebook.invalid");
		const joined = await fetch(`${origin}/s/${secret}`, { redirect: "manual" });
		const colleague = sessionCookie(joined);
		const home = await (await fetch(`${origin}/`, { headers: { Cookie: colleague } })).text();
		expect(home).toContain("Studio");

		const people = await (await fetch(`${origin}/people`, { headers: { Cookie: owner } })).text();
		const personId = people.match(/action="\/people\/remove"><input type="hidden" name="id" value="([^"]+)"/)?.[1] ?? "";
		expect(personId).not.toBe("");
		await fetch(`${origin}/people/remove`, {
			method: "POST",
			headers: { Cookie: owner, "Content-Type": "application/x-www-form-urlencoded" },
			body: `id=${encodeURIComponent(personId)}`,
		});
		const lockedOut = await fetch(`${origin}/`, { headers: { Cookie: colleague } });
		expect(lockedOut.status).toBe(401);
	}, 60_000);

	it("asks which workspace when one address belongs to two", async () => {
		const email = "shared@stylebook.invalid";
		await openWorkspace("First", email);
		await openWorkspace("Second", email);
		const sent = await fetch(`${origin}/sign-in`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: `email=${encodeURIComponent(email)}`,
		});
		expect(sent.status).toBe(200);
		const secret = await linkFor(email);
		const opened = await fetch(`${origin}/s/${secret}`, { redirect: "manual" });
		expect(opened.status).toBe(200);
		const choice = chooseCookie(opened);
		expect(choice.startsWith("stylebook_choose=")).toBe(true);
		const page = await opened.text();
		expect(page).toContain("Open First");
		expect(page).toContain("Open Second");
		expect(BANNED.test(visible(page))).toBe(false);
		const id = page.match(/name="workspace" value="([^"]+)"/)?.[1] ?? "";
		const picked = await fetch(`${origin}/choose`, {
			method: "POST",
			redirect: "manual",
			headers: { Cookie: choice, "Content-Type": "application/x-www-form-urlencoded" },
			body: `workspace=${encodeURIComponent(id)}`,
		});
		expect(picked.status).toBe(303);
		expect(sessionCookie(picked).startsWith("stylebook=")).toBe(true);
	}, 60_000);

	it("refuses another sign-in email after the hourly limit", async () => {
		env.MAX_SIGN_IN_EMAILS_PER_HOUR = "2";
		const email = "limited@stylebook.invalid";
		const send = () =>
			fetch(`${origin}/sign-in`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.9" },
				body: `email=${encodeURIComponent(email)}`,
			});
		expect((await send()).status).toBe(200);
		expect((await send()).status).toBe(200);
		const blocked = await send();
		expect(blocked.status).toBe(429);
		expect(await blocked.text()).toContain(LIMIT_MESSAGE.signIn);
		env.MAX_SIGN_IN_EMAILS_PER_HOUR = "30";
	});

	it("states the people, agent and suggestion limits in plain language", async () => {
		const cookie = await openWorkspace("Limits", "limits@stylebook.invalid");
		env.MAX_PEOPLE = "1";
		const invite = await fetch(`${origin}/invite`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
			body: "email=extra@stylebook.invalid",
		});
		expect(await invite.text()).toContain(LIMIT_MESSAGE.people);
		env.MAX_PEOPLE = "25";

		env.MAX_AGENTS = "1";
		const first = await fetch(`${origin}/agents`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
			body: "name=One&tool=cursor",
		});
		const key = (await first.text()).match(/<code>([0-9a-f]{64})<\/code>/)?.[1] ?? "";
		const second = await fetch(`${origin}/agents`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
			body: "name=Two&tool=cursor",
		});
		expect(await second.text()).toContain(LIMIT_MESSAGE.agents);
		env.MAX_AGENTS = "40";

		env.MAX_OPEN_SUGGESTIONS = "1";
		const call = (session: string) =>
			fetch(`${origin}/mcp`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${key}`,
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: {
						name: "suggest_change",
						arguments: {
							path: STARTER_SKILL_PATH,
							content: `${STARTER_SKILL}\n\n${session}\n`,
							why: `Note ${session}.`,
							session,
						},
					},
				}),
			});
		const saved = (await (await call("alpha")).json()) as { result: { isError: boolean } };
		expect(saved.result.isError).toBe(false);
		const capped = (await (await call("beta")).json()) as { result: { isError: boolean; content: { text: string }[] } };
		expect(capped.result.isError).toBe(true);
		expect(capped.result.content[0]?.text).toContain(LIMIT_MESSAGE.openSuggestions);
		env.MAX_OPEN_SUGGESTIONS = "200";
	}, 60_000);

	it("expires a sign-in link", async () => {
		const email = "expires@stylebook.invalid";
		await fetch(`${origin}/start`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: `workspace=Late&email=${encodeURIComponent(email)}`,
		});
		const secret = await linkFor(email);
		await db
			.prepare(`UPDATE sign_in_links SET expires_at = ?1 WHERE token_hash = ?2`)
			.bind("2000-01-01T00:00:00.000Z", await hashKey(secret))
			.run();
		const opened = await fetch(`${origin}/s/${secret}`);
		expect(await opened.text()).toContain("expired");
	});
});
