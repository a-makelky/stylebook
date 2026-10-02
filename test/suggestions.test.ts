import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { matchArrivals, toArrival, type ArrivalRow } from "../src/arrivals";
import { EDIT_COUNT, editAt, applyEdit } from "../src/edits";
import type { Env } from "../src/env";
import worker from "../src/index";
import { NOTES_REF } from "../src/git";
import { describeError, sanitize } from "../src/redact";
import { STARTER_SKILL, withRevisionNote, STARTER_SKILL_PATH } from "../src/seed";
import { inlineLauncher, runSwarm, timingOf, type ArrivalLog } from "../src/swarm";
import { LIBRARY } from "../src/workspace";
import { ArrivalWorkflow } from "../src/workflows";
import type { WorkflowStep } from "cloudflare:workers";
import { FakeWorkspace } from "./fake-artifacts";

const WAIT = { attempts: 5, delayMs: 5 };
const ACCOUNT = "deadbeefdeadbeefdeadbeefdeadbeef";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const emptyLog: ArrivalLog = {
	async listSince() {
		return [];
	},
};

describe("scripted edits", () => {
	it("has 100 distinct changes, with overlap on Steps and changes elsewhere", () => {
		expect(EDIT_COUNT).toBe(100);
		const seen = new Set<string>();
		const sections = new Set<string>();
		const kinds = new Set<string>();
		for (let index = 0; index < EDIT_COUNT; index++) {
			const edit = editAt(index);
			const next = applyEdit(STARTER_SKILL, edit);
			const noted = applyEdit(withRevisionNote(STARTER_SKILL, 2), edit);
			expect(next, edit.summary).not.toBeNull();
			expect(next).not.toBe(STARTER_SKILL);
			expect(noted).not.toBeNull();
			expect(noted).not.toBe(withRevisionNote(STARTER_SKILL, 2));
			seen.add(next!);
			if (index < 25) {
				sections.add(edit.section);
				kinds.add(edit.kind);
			}
		}
		expect(seen.size).toBe(EDIT_COUNT);
		const first = Array.from({ length: 25 }, (_, index) => editAt(index));
		expect(first.filter((edit) => edit.section === "Steps").length).toBeGreaterThanOrEqual(2);
		expect(new Set(first.map((edit) => edit.section)).size).toBeGreaterThanOrEqual(3);
		expect(kinds.has("add")).toBe(true);
		expect(kinds.has("reword")).toBe(true);
		expect(kinds.has("remove")).toBe(true);
		expect(sections.has("Steps")).toBe(true);
	});
});

describe("push events", () => {
	const event = {
		type: "cf.artifacts.repo.pushed",
		source: { type: "artifacts.repo", namespace: "stylebook-demo", repoName: "sug-agent-one" },
		payload: {
			ref: "refs/heads/main",
			before: "0000000000000000000000000000000000000000",
			after: SHA,
			commits: [
				{
					id: SHA,
					message: "Tighten a step",
					timestamp: "2026-10-02T18:00:00.000Z",
				},
			],
		},
		metadata: {
			accountId: ACCOUNT,
			eventTimestamp: "2026-10-02T18:00:01.000Z",
		},
	};

	it("reads the documented event and does not keep the account id", () => {
		const row = toArrival(event, "2026-10-02T18:00:02.000Z", "inst");
		expect(row).toMatchObject({
			repoName: "sug-agent-one",
			refName: "refs/heads/main",
			editionId: SHA,
			kind: "suggestion",
			arrivedAt: "2026-10-02T18:00:01.000Z",
		});
		expect(JSON.stringify(row)).not.toContain(ACCOUNT);
		expect(row.detail).toContain("metadata.accountId");
	});

	it("classes library pushes and notes refs", () => {
		const library = toArrival(
			{
				source: { repoName: "library" },
				payload: { ref: "refs/heads/main", after: SHA },
			},
			"2026-10-02T18:00:02.000Z",
			"inst",
		);
		expect(library.kind).toBe("library");

		const notes = toArrival(
			{
				source: { repoName: "sug-agent-one" },
				payload: { ref: "refs/notes/stylebook", after: SHA },
			},
			"2026-10-02T18:00:02.000Z",
			"inst",
		);
		expect(notes.kind).toBe("notes");
	});

	it("matches one row per expected push", () => {
		const expected = [
			{ repoName: "library", refName: "refs/heads/main", editionId: SHA, kind: "library" as const },
			{ repoName: "sug-a", refName: "refs/heads/main", editionId: SHA, kind: "suggestion" as const },
		];
		const rows: ArrivalRow[] = [
			{
				repoName: "library",
				refName: "refs/heads/main",
				editionId: SHA,
				kind: "library",
				arrivedAt: "t",
				recordedAt: "t",
				detail: null,
			},
		];
		const matched = matchArrivals(expected, rows);
		expect(matched.missing).toEqual([expected[1]]);
		expect(matched.extras).toEqual([]);
	});
});

describe("secrets stay out of responses", () => {
	it("drops remotes and tokens", () => {
		const clean = sanitize({
			ok: true,
			remote: "https://example.test/library.git",
			nested: { token: "art_v1_secret?expires=1", note: "see https://example.test/x and art_v1_abc" },
		});
		const text = JSON.stringify(clean);
		expect(text).not.toContain("remote");
		expect(text).not.toContain("art_v1_");
		expect(text).not.toContain("https://");
		expect(text).toContain("<url>");
		expect(text).toContain("<token>");
	});

	it("records an error code without the raw remote", () => {
		const error = Object.assign(new Error("push https://acct.example/r.git failed"), {
			code: "HTTP_401",
		});
		expect(describeError(error)).toEqual({
			attempt: 1,
			code: "HTTP_401",
			message: "push <url> failed",
		});
	});
});

describe("many sessions at once", () => {
	let workspace: FakeWorkspace;

	beforeAll(async () => {
		workspace = await FakeWorkspace.start();
	});

	afterAll(async () => {
		await workspace.stop();
	});

	it("overlaps sessions, each with one edition on top of the library", async () => {
		const report = await runSwarm({
			workspace: workspace.binding,
			launcher: inlineLauncher(workspace.binding),
			arrivals: emptyLog,
			n: 8,
			actor: "agent",
			runId: "local01",
			arrivalWaitMs: 0,
			runner: "inline",
		});

		expect(report.sessions).toHaveLength(8);
		expect(report.sessions.every((session) => session.ok)).toBe(true);
		expect(report.probe.fork.created).toBe(true);
		expect(report.probe.fork.failures).toEqual([]);
		expect(report.probe.libraryPush.failures).toEqual([]);
		expect(report.probe.fork.source).toBe(`artifacts:${workspace.namespace}/${LIBRARY}`);
		expect(report.libraryTipBeforeSessions).toBe(report.probe.libraryPush.edition);
		expect(report.libraryTipAfterSessions).toBe(report.libraryTipBeforeSessions);

		const sum = report.sessions.reduce((total, session) => total + session.elapsedMs, 0);
		expect(report.sessionsWallClockMs).toBeLessThan(sum);
		expect(report.timing.forks.count).toBe(8);
		expect(report.timing.sections.steps).toBeGreaterThanOrEqual(2);
		expect(report.timing.sections.other.length).toBeGreaterThanOrEqual(2);
		expect(report.timing.kinds.add).toBeGreaterThan(0);
		expect(report.timing.kinds.reword).toBeGreaterThan(0);
		expect(report.timing.kinds.remove).toBeGreaterThan(0);

		for (const session of report.sessions) {
			expect(session.source).toBe(`artifacts:${workspace.namespace}/${LIBRARY}`);
			expect(session.onTopOfLibrary).toBe(true);
			expect(session.parentEdition).toBe(report.libraryTipBeforeSessions);
			expect(session.created).toBe(true);
			expect(session.editionCount).toBe((session.libraryEditionCount ?? 0) + 1);
			const copy = workspace.git(session.name, "show", `main:${STARTER_SKILL_PATH}`);
			const library = workspace.git(LIBRARY, "show", `main:${STARTER_SKILL_PATH}`);
			expect(copy).not.toBe(library);
		}

		const texts = report.sessions.map((session) =>
			workspace.git(session.name, "show", `main:${STARTER_SKILL_PATH}`),
		);
		expect(new Set(texts).size).toBe(texts.length);

		expect(report.notes.pushed).toBe(true);
		expect(report.notes.ref).toBe(NOTES_REF);
		expect(workspace.git(report.notes.repoName!, "show-ref")).toContain(NOTES_REF);
		expect(report.arrivals.missing.length).toBeGreaterThan(0);

		const text = JSON.stringify(report);
		expect(text).not.toContain("art_v1_");
		expect(text).not.toContain("127.0.0.1");
	}, 120_000);

	it("treats serial sessions as not overlapping", () => {
		const timing = timingOf([
			{
				...stubSession("a", "2026-10-02T18:00:00.000Z", "2026-10-02T18:00:04.000Z"),
			},
			{
				...stubSession("b", "2026-10-02T18:00:05.000Z", "2026-10-02T18:00:09.000Z"),
			},
		]);
		expect(timing.allOverlap).toBe(false);

		const together = timingOf([
			stubSession("a", "2026-10-02T18:00:00.000Z", "2026-10-02T18:00:08.000Z"),
			stubSession("b", "2026-10-02T18:00:01.000Z", "2026-10-02T18:00:07.000Z"),
		]);
		expect(together.allOverlap).toBe(true);
		expect(together.forks.wallClockMs).toBe(2000);
	});
});

function stubSession(
	name: string,
	startedAt: string,
	endedAt: string,
): import("../src/session").SessionResult {
	return {
		ok: true,
		name,
		actor: "agent",
		session: name,
		edit: { index: 0, section: "Steps", kind: "reword", summary: "x" },
		startedAt,
		endedAt,
		elapsedMs: Date.parse(endedAt) - Date.parse(startedAt),
		forkStartedAt: startedAt,
		forkEndedAt: new Date(Date.parse(startedAt) + 1000).toISOString(),
		forkMs: 1000,
		afterFork: null,
		source: null,
		created: true,
		libraryTip: null,
		libraryEditionCount: 1,
		parentEdition: null,
		edition: null,
		editionCount: 2,
		onTopOfLibrary: true,
		alreadyApplied: false,
		failures: [],
	};
}

describe("arrival workflow", () => {
	it("writes one row from the push event and nothing else", async () => {
		const bound: unknown[][] = [];
		const db = {
			prepare() {
				return {
					bind(...values: unknown[]) {
						return {
							async run() {
								bound.push(values);
								return { success: true };
							},
						};
					},
				};
			},
		} as unknown as D1Database;

		const workflow = new ArrivalWorkflow({} as ExecutionContext, { DB: db } as Env);
		await workflow.run(
			{
				payload: {
					source: { repoName: "sug-agent-one" },
					payload: { ref: "refs/heads/main", after: SHA },
					metadata: { accountId: ACCOUNT, eventTimestamp: "2026-10-02T18:00:01.000Z" },
				},
				timestamp: new Date("2026-10-02T18:00:02.000Z"),
				instanceId: "inst-1",
				workflowName: "stylebook-arrival",
			},
			{
				async do(_name: string, callback: () => Promise<unknown>) {
					return callback();
				},
			} as unknown as WorkflowStep,
		);

		expect(bound).toHaveLength(1);
		expect(JSON.stringify(bound)).not.toContain(ACCOUNT);
		expect(bound[0]?.[0]).toBe("sug-agent-one");
		expect(bound[0]?.[3]).toBe("suggestion");
		expect(bound[0]?.[2]).toBe(SHA);
	});
});

describe("suggestions route", () => {
	let workspace: FakeWorkspace;

	beforeAll(async () => {
		workspace = await FakeWorkspace.start();
	});

	afterAll(async () => {
		await workspace.stop();
	});

	const call = (init: RequestInit, env: Partial<Env> = {}) =>
		worker.fetch(new Request("https://stylebook.test/demo/suggestions", init), {
			WORKSPACE: workspace.binding,
			DEMO_KEY: "secret",
			DB: unusedDb,
			SUGGESTIONS: unusedWorkflow,
			ARRIVALS: unusedWorkflow,
			...env,
		} as Env);

	it("refuses a caller without the demo key", async () => {
		const missing = await call({ method: "POST" }, { DEMO_KEY: undefined });
		expect(missing.status).toBe(503);
		const wrong = await call({
			method: "POST",
			headers: { Authorization: "Bearer nope" },
		});
		expect(wrong.status).toBe(401);
	});

	it("rejects a count outside 1 to 100", async () => {
		const response = await call({
			method: "POST",
			headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
			body: JSON.stringify({ n: 101 }),
		});
		expect(response.status).toBe(400);
	});

	it("scrubs a failure that contains a remote and a token", async () => {
		const response = await worker.fetch(
			new Request("https://stylebook.test/demo/suggestions", {
				method: "POST",
				headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
				body: JSON.stringify({ n: 1 }),
			}),
			{
				WORKSPACE: {
					async get() {
						throw Object.assign(
							new Error("no https://acct.example/library.git art_v1_secret"),
							{ code: "BOOM" },
						);
					},
				} as unknown as Artifacts,
				DEMO_KEY: "secret",
				DB: unusedDb,
				SUGGESTIONS: unusedWorkflow,
				ARRIVALS: unusedWorkflow,
			} as Env,
		);
		expect(response.status).toBe(500);
		const text = await response.text();
		expect(text).not.toContain("art_v1_");
		expect(text).not.toContain("https://");
		expect(text).toContain("BOOM");
	});
});

const unusedDb = { prepare() { throw new Error("not used"); } } as unknown as D1Database;
const unusedWorkflow = {
	async create() { throw new Error("not used"); },
	async get() { throw new Error("not used"); },
} as unknown as Workflow;
