// One request starts N suggestion sessions at once.
//
// Each session is its own Workflow instance. A Queue consumer only raises
// concurrency after a batch finishes, so a single burst can be drained by the
// first consumer before another one starts:
// https://developers.cloudflare.com/queues/configuration/consumer-concurrency/
// Workflow instances can be created at 100 per second per workflow, and
// Workers Paid runs up to 50,000 at once. Each step is its own invocation, so
// one isomorphic-git write does not share memory with the others:
// https://developers.cloudflare.com/workflows/reference/limits/
//
// Pushes are recorded by a different Workflow, started by the namespace-wide
// push trigger, not by this file:
// https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/

import {
	listArrivalsSince,
	matchArrivals,
	type ArrivalRow,
	type ExpectedPush,
} from "./arrivals";
import { EDIT_COUNT } from "./edits";
import { NOTES_REF, publishFile } from "./git";
import { probeForkDuringPush, pushNotesOnCopy, type NotesResult, type ProbeResult } from "./probe";
import { describeError, redact, type Failure } from "./redact";
import { STARTER_SKILL, STARTER_SKILL_PATH } from "./seed";
import { runSuggestionSession, type SessionParams, type SessionResult } from "./session";
import { DEMO_AUTHOR } from "./tracer";
import { ensureLibrary, getRepo, suggestionName, writeAccess, LIBRARY } from "./workspace";

export const MAX_SESSIONS = 100;
const MAIN_REF = "refs/heads/main";

export interface SessionHandle {
	status(): Promise<{
		status: string;
		output?: SessionResult;
		error?: { name?: string; message?: string };
	}>;
}

export interface SessionLauncher {
	start(params: SessionParams): Promise<SessionHandle>;
}

export interface ArrivalLog {
	listSince(iso: string): Promise<ArrivalRow[]>;
}

export function d1ArrivalLog(db: D1Database): ArrivalLog {
	return { listSince: (iso) => listArrivalsSince(db, iso) };
}

/** Runs the session in this isolate. Tests use it. Production uses Workflows. */
export function inlineLauncher(workspace: Artifacts): SessionLauncher {
	return {
		async start(params) {
			const output = await runSuggestionSession(workspace, params);
			return {
				async status() {
					return { status: "complete", output };
				},
			};
		},
	};
}

export interface SwarmOptions {
	workspace: Artifacts;
	launcher: SessionLauncher;
	arrivals: ArrivalLog;
	n: number;
	actor: string;
	runId?: string;
	/** How the sessions are actually started. The route uses Workflow instances. */
	runner?: SwarmReport["runner"];
	/** How long to wait for the push Workflow to write arrival rows. */
	arrivalWaitMs?: number;
	pollMs?: number;
}

export interface SwarmReport {
	ok: boolean;
	runId: string;
	actor: string;
	n: number;
	runner: "workflow-instances" | "inline";
	startedAt: string;
	endedAt: string;
	wallClockMs: number;
	sessionsWallClockMs: number;
	seededEdition: string | null;
	libraryTipBeforeSessions: string | null;
	libraryTipAfterSessions: string | null;
	probe: ProbeResult;
	sessions: SessionResult[];
	timing: SessionTiming;
	notes: NotesResult;
	arrivals: {
		waitedMs: number;
		rows: ArrivalRow[];
		missing: ExpectedPush[];
		extras: ArrivalRow[];
	};
	failures: Failure[];
}

export interface SessionTiming {
	allOverlap: boolean;
	earliestStart: string | null;
	latestStart: string | null;
	earliestEnd: string | null;
	latestEnd: string | null;
	spanMs: number | null;
	forks: {
		count: number;
		wallClockMs: number | null;
		fastestMs: number | null;
		slowestMs: number | null;
	};
	sections: { steps: number; other: string[] };
	kinds: { add: number; reword: number; remove: number };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function span(start: string | null, end: string | null): number | null {
	if (!start || !end) return null;
	const ms = Date.parse(end) - Date.parse(start);
	return Number.isNaN(ms) ? null : ms;
}

export function timingOf(sessions: SessionResult[]): SessionTiming {
	const started = sessions.map((session) => session.startedAt).filter(Boolean).sort();
	const ended = sessions.map((session) => session.endedAt).filter(Boolean).sort();
	const earliestStart = started[0] ?? null;
	const latestStart = started[started.length - 1] ?? null;
	const earliestEnd = ended[0] ?? null;
	const latestEnd = ended[ended.length - 1] ?? null;
	const allOverlap = Boolean(
		latestStart && earliestEnd && Date.parse(latestStart) < Date.parse(earliestEnd),
	);

	const forks = sessions.filter((session) => session.forkStartedAt && session.forkEndedAt);
	const forkStarts = forks.map((session) => session.forkStartedAt!).sort();
	const forkEnds = forks.map((session) => session.forkEndedAt!).sort();
	const durations = forks
		.map((session) => session.forkMs)
		.filter((ms): ms is number => typeof ms === "number");

	const other = [...new Set(sessions.map((session) => session.edit.section).filter((s) => s !== "Steps"))];
	return {
		allOverlap,
		earliestStart,
		latestStart,
		earliestEnd,
		latestEnd,
		spanMs: span(earliestStart, latestEnd),
		forks: {
			count: forks.length,
			wallClockMs: span(forkStarts[0] ?? null, forkEnds[forkEnds.length - 1] ?? null),
			fastestMs: durations.length ? Math.min(...durations) : null,
			slowestMs: durations.length ? Math.max(...durations) : null,
		},
		sections: {
			steps: sessions.filter((session) => session.edit.section === "Steps").length,
			other,
		},
		kinds: {
			add: sessions.filter((session) => session.edit.kind === "add").length,
			reword: sessions.filter((session) => session.edit.kind === "reword").length,
			remove: sessions.filter((session) => session.edit.kind === "remove").length,
		},
	};
}

function failedSession(params: SessionParams, failures: Failure[]): SessionResult {
	const now = new Date().toISOString();
	const edit = {
		index: params.editIndex,
		section: "unknown",
		kind: "add" as const,
		summary: "The session did not start",
	};
	return {
		ok: false,
		name: suggestionName(params.actor, params.session),
		actor: params.actor,
		session: params.session,
		edit,
		startedAt: now,
		endedAt: now,
		elapsedMs: 0,
		forkStartedAt: null,
		forkEndedAt: null,
		forkMs: null,
		afterFork: null,
		source: null,
		created: false,
		libraryTip: null,
		libraryEditionCount: null,
		parentEdition: null,
		edition: null,
		editionCount: null,
		onTopOfLibrary: false,
		alreadyApplied: false,
		failures,
	};
}

async function startAll(
	launcher: SessionLauncher,
	params: SessionParams[],
	failures: Failure[],
): Promise<{ params: SessionParams; handle: SessionHandle | null; failures: Failure[] }[]> {
	return Promise.all(
		params.map(async (item) => {
			const itemFailures: Failure[] = [];
			for (let attempt = 1; attempt <= 3; attempt++) {
				try {
					const handle = await launcher.start(item);
					return { params: item, handle, failures: itemFailures };
				} catch (error) {
					itemFailures.push(describeError(error, attempt));
					if (attempt < 3) await sleep(200 * attempt);
				}
			}
			return { params: item, handle: null, failures: itemFailures };
		}),
	);
}

async function waitForSessions(
	started: { params: SessionParams; handle: SessionHandle | null; failures: Failure[] }[],
	deadlineMs: number,
): Promise<SessionResult[]> {
	const pending = started.filter((item) => item.handle);
	const results: SessionResult[] = started
		.filter((item) => !item.handle)
		.map((item) => failedSession(item.params, item.failures));
	const done = new Set<SessionHandle>();

	while (pending.some((item) => item.handle && !done.has(item.handle)) && Date.now() < deadlineMs) {
		await Promise.all(
			pending.map(async (item) => {
				if (!item.handle || done.has(item.handle)) return;
				const status = await item.handle.status();
				if (status.status === "complete") {
					done.add(item.handle);
					if (status.output) {
						results.push({ ...status.output, failures: [...item.failures, ...status.output.failures] });
					} else {
						const failure: Failure = {
							attempt: 1,
							code: "NO_OUTPUT",
							message: "The session finished without a result",
						};
						results.push(failedSession(item.params, [...item.failures, failure]));
					}
					return;
				}
				if (status.status === "errored" || status.status === "terminated") {
					done.add(item.handle);
					const failure: Failure = {
						attempt: 1,
						code: status.error?.name ?? status.status,
						message: redact(status.error?.message ?? status.status),
					};
					results.push(failedSession(item.params, [...item.failures, failure]));
				}
			}),
		);
		if (pending.some((item) => item.handle && !done.has(item.handle))) await sleep(1000);
	}

	for (const item of pending) {
		if (item.handle && !done.has(item.handle)) {
			const failure: Failure = {
				attempt: 1,
				code: "TIMEOUT",
				message: "The session was still running when the wait ended",
			};
			results.push(failedSession(item.params, [...item.failures, failure]));
		}
	}

	return results.sort((a, b) => a.edit.index - b.edit.index);
}

export async function runSwarm(options: SwarmOptions): Promise<SwarmReport> {
	if (!Number.isInteger(options.n) || options.n < 1 || options.n > MAX_SESSIONS) {
		throw new Error(`n must be a whole number from 1 to ${MAX_SESSIONS}`);
	}
	if (options.n > EDIT_COUNT) {
		throw new Error(`Only ${EDIT_COUNT} distinct edits are defined`);
	}

	const startedMs = Date.now();
	const startedAt = new Date(startedMs).toISOString();
	const runId = options.runId ?? crypto.randomUUID().slice(0, 8);
	const failures: Failure[] = [];
	const arrivalWaitMs = options.arrivalWaitMs ?? 90_000;

	const library = await ensureLibrary(options.workspace);
	const before = await listEditionsOf(library.repo);
	let seededEdition: string | null = null;
	if (before.length === 0) {
		const access = await writeAccess(library.repo, 120);
		seededEdition = await publishFile({
			remote: access.remote,
			token: access.token,
			path: STARTER_SKILL_PATH,
			content: STARTER_SKILL,
			message: "Add the interview-to-draft skill",
			author: DEMO_AUTHOR,
			hasHistory: false,
		});
	}

	const probe = await probeForkDuringPush(
		options.workspace,
		library.repo,
		options.actor,
		runId,
	);
	failures.push(...probe.libraryPush.failures, ...probe.fork.failures);

	const libraryTipBeforeSessions = (await listEditionsOf(library.repo))[0] ?? null;
	const sessionsStartedMs = Date.now();
	const params: SessionParams[] = Array.from({ length: options.n }, (_, index) => ({
		actor: options.actor,
		session: `${runId}-${String(index + 1).padStart(3, "0")}`,
		editIndex: index,
		runId,
	}));
	const launched = await startAll(options.launcher, params, failures);
	const sessions = await waitForSessions(launched, sessionsStartedMs + 180_000);
	const sessionsWallClockMs = Date.now() - sessionsStartedMs;
	for (const session of sessions) failures.push(...session.failures);

	const libraryTipAfterSessions = (await listEditionsOf(library.repo))[0] ?? null;

	let notes: NotesResult = {
		repoName: null,
		ref: NOTES_REF,
		target: null,
		pushed: false,
		failures: [],
	};
	const notesHost = sessions.find((session) => session.ok);
	if (notesHost) {
		const repo = await getRepo(options.workspace, notesHost.name);
		if (repo) notes = await pushNotesOnCopy(repo, notesHost.name);
		else {
			notes.failures.push({
				attempt: 1,
				code: "NOT_FOUND",
				message: "The copy for the notes push could not be opened",
			});
		}
	}
	failures.push(...notes.failures);

	const expected: ExpectedPush[] = [];
	if (seededEdition) {
		expected.push({
			repoName: LIBRARY,
			refName: MAIN_REF,
			editionId: seededEdition,
			kind: "library",
		});
	}
	if (probe.libraryPush.edition) {
		expected.push({
			repoName: LIBRARY,
			refName: MAIN_REF,
			editionId: probe.libraryPush.edition,
			kind: "library",
		});
	}
	for (const session of sessions) {
		if (session.edition && session.ok) {
			expected.push({
				repoName: session.name,
				refName: MAIN_REF,
				editionId: session.edition,
				kind: "suggestion",
			});
		}
	}
	if (notes.pushed && notes.repoName && notes.target) {
		expected.push({
			repoName: notes.repoName,
			refName: notes.ref,
			editionId: notes.target,
			kind: "notes",
		});
	}

	const arrivalStarted = Date.now();
	let rows = await options.arrivals.listSince(startedAt);
	let matched = matchArrivals(expected, rows);
	while (matched.missing.length > 0 && Date.now() - arrivalStarted < arrivalWaitMs) {
		await sleep(options.pollMs ?? 2000);
		rows = await options.arrivals.listSince(startedAt);
		matched = matchArrivals(expected, rows);
	}

	const endedAt = new Date().toISOString();
	const sessionsOk = sessions.length === options.n && sessions.every((session) => session.ok);
	return {
		ok: sessionsOk && probe.fork.created && probe.fork.failures.length === 0,
		runId,
		actor: options.actor,
		n: options.n,
		runner: options.runner ?? "inline",
		startedAt,
		endedAt,
		wallClockMs: Date.now() - startedMs,
		sessionsWallClockMs,
		seededEdition,
		libraryTipBeforeSessions,
		libraryTipAfterSessions,
		probe,
		sessions,
		timing: timingOf(sessions),
		notes,
		arrivals: {
			waitedMs: Date.now() - arrivalStarted,
			rows,
			missing: matched.missing,
			extras: matched.extras,
		},
		failures,
	};
}

async function listEditionsOf(repo: ArtifactsRepo): Promise<string[]> {
	const commits = await repo.log({ ref: "main", limit: 20 });
	return commits.map((commit) => commit.hash);
}

export function workflowLauncher(suggestions: Workflow<SessionParams>): SessionLauncher {
	return {
		async start(params) {
			const instance = await suggestions.create({
				id: `s-${params.runId}-${String(params.editIndex).padStart(3, "0")}`,
				params,
			});
			return {
				async status() {
					const current = await instance.status();
					return {
						status: current.status,
						output: current.output as SessionResult | undefined,
						error: current.error
							? { name: current.error.name, message: current.error.message }
							: undefined,
					};
				},
			};
		},
	};
}
