import { afterAll, beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { publishFile, tokenSecret } from "../src/git";
import { STARTER_SKILL, STARTER_SKILL_PATH } from "../src/seed";
import { runTracer } from "../src/tracer";
import { LIBRARY, suggestionName } from "../src/workspace";
import { FakeWorkspace } from "./fake-artifacts";

const WAIT = { attempts: 5, delayMs: 5 };

let workspace: FakeWorkspace;

beforeAll(async () => {
	workspace = await FakeWorkspace.start();
});

afterAll(async () => {
	await workspace.stop();
});

describe("names and tokens", () => {
	it("builds a repo-safe suggestion name", () => {
		expect(suggestionName("Cursor Cloud", "Run #42")).toBe("sug-cursor-cloud-run-42");
		expect(suggestionName("", "")).toBe("sug-x-x");
		expect(suggestionName("a".repeat(80), "b").length).toBeLessThanOrEqual(63);
	});

	it("strips the expiry from a token", () => {
		expect(tokenSecret("art_v1_abc?expires=1760000000")).toBe("art_v1_abc");
		expect(tokenSecret("art_v1_abc")).toBe("art_v1_abc");
	});
});

describe("tracer 1", () => {
	it("creates the library, publishes the first edition, and copies it with a real fork", async () => {
		const result = await runTracer(workspace.binding, {
			actor: "demo-agent",
			session: "one",
			wait: WAIT,
		});

		expect(result.library.created).toBe(true);
		expect(result.library.editions).toHaveLength(1);
		expect(result.library.publishedEdition).toBe(result.library.editions[0]!.id);

		expect(result.suggestion.name).toBe("sug-demo-agent-one");
		expect(result.suggestion.created).toBe(true);
		expect(result.suggestion.source).toBe(`artifacts:${workspace.namespace}/${LIBRARY}`);
		expect(workspace.forkCalls).toContain("sug-demo-agent-one");

		expect(result.readBack.identical).toBe(true);
		expect(result.readBack.librarySha256).toBe(result.readBack.suggestionSha256);
		expect(result.note).toBeNull();

		// Check against Git itself, not only against our own reader.
		expect(workspace.git(LIBRARY, "show", `main:${STARTER_SKILL_PATH}`)).toBe(STARTER_SKILL);
		expect(workspace.git("sug-demo-agent-one", "show", `main:${STARTER_SKILL_PATH}`)).toBe(
			STARTER_SKILL,
		);
	});

	it("keeps full history in a copy once the library has two editions", async () => {
		const result = await runTracer(workspace.binding, {
			actor: "demo-agent",
			session: "two",
			addEdition: true,
			wait: WAIT,
		});

		expect(result.library.created).toBe(false);
		expect(result.library.editions).toHaveLength(2);
		expect(result.suggestion.editions).toHaveLength(2);
		expect(result.suggestion.editions.map((edition) => edition.id)).toEqual(
			result.library.editions.map((edition) => edition.id),
		);
		expect(result.readBack.identical).toBe(true);
		expect(result.readBack.preview).toContain("interview-to-draft");
		expect(workspace.git(LIBRARY, "show", `main:${STARTER_SKILL_PATH}`)).toContain(
			"- Edition 2: revision note added by the demo.",
		);
		expect(workspace.git(LIBRARY, "rev-list", "--count", "main").trim()).toBe("2");
	});

	it("is safe to run again for the same session, and says when an old copy differs", async () => {
		const forksBefore = workspace.forkCalls.length;
		const result = await runTracer(workspace.binding, {
			actor: "demo-agent",
			session: "one",
			wait: WAIT,
		});

		expect(workspace.forkCalls.length).toBe(forksBefore);
		expect(result.suggestion.created).toBe(false);
		expect(result.library.publishedEdition).toBeNull();
		expect(result.suggestion.editions).toHaveLength(1);
		expect(result.readBack.identical).toBe(false);
		expect(result.note).toMatch(/already existed/);
	});

	it("waits for a copy that is still being made", async () => {
		workspace.forkDelayCalls = 2;
		try {
			const result = await runTracer(workspace.binding, {
				actor: "slow",
				session: "fork",
				wait: WAIT,
			});
			expect(result.suggestion.created).toBe(true);
			expect(result.readBack.identical).toBe(true);
		} finally {
			workspace.forkDelayCalls = 0;
		}
	});
});

describe("publishing", () => {
	it("refuses a token that belongs to a different repo", async () => {
		const copy = await workspace.binding.get("sug-demo-agent-two");
		const copyToken = await copy.createToken("write", 60);
		const library = await workspace.binding.get(LIBRARY);
		const libraryInfo = await library.info();

		await expect(
			publishFile({
				remote: libraryInfo.remote,
				token: copyToken.plaintext,
				path: STARTER_SKILL_PATH,
				content: "should never land",
				message: "Should be refused",
				author: { name: "Test", email: "test@example.invalid" },
				hasHistory: true,
			}),
		).rejects.toThrow();
		expect(workspace.git(LIBRARY, "rev-list", "--count", "main").trim()).toBe("2");
	});
});

describe("worker routes", () => {
	const call = (path: string, init: RequestInit, key?: string) =>
		worker.fetch(new Request(`https://stylebook.test${path}`, init), {
			WORKSPACE: workspace.binding,
			DEMO_KEY: key,
		});

	it("answers the health check", async () => {
		const response = await call("/health", { method: "GET" }, "k");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, name: "stylebook" });
	});

	it("refuses the demo when no key is configured", async () => {
		const response = await call("/demo/tracer", { method: "POST" });
		expect(response.status).toBe(503);
	});

	it("refuses the demo without the right key", async () => {
		const missing = await call("/demo/tracer", { method: "POST" }, "secret");
		expect(missing.status).toBe(401);
		const wrong = await call(
			"/demo/tracer",
			{ method: "POST", headers: { Authorization: "Bearer nope" } },
			"secret",
		);
		expect(wrong.status).toBe(401);
	});

	it("runs the tracer with the right key and returns no secrets", async () => {
		const response = await call(
			"/demo/tracer",
			{
				method: "POST",
				headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
				body: JSON.stringify({ actor: "route", session: "check" }),
			},
			"secret",
		);
		expect(response.status).toBe(200);
		const text = await response.text();
		const body = JSON.parse(text) as { ok: boolean; suggestion: { name: string } };
		expect(body.ok).toBe(true);
		expect(body.suggestion.name).toBe("sug-route-check");
		expect(text).not.toContain("art_v1_");
		expect(text).not.toContain("127.0.0.1");
	});
});
