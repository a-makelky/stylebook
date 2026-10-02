// Two live questions that are not part of the 25 sessions:
// a copy made while a library push is in flight, and one push of refs/notes/*.

import { NOTES_REF, publishFile, publishNotesRef } from "./git";
import { describeError, type Failure } from "./redact";
import { DEMO_AUTHOR } from "./tracer";
import {
	ensureSuggestion,
	errorCode,
	suggestionName,
	writeAccess,
	type WaitOptions,
} from "./workspace";

export const PROBE_PATH = "desk/probe.md";
const PROBE_BODY = "This edition exists so a copy can be made while the library is being saved.\n";

export interface ProbeResult {
	libraryPush: {
		startedAt: string | null;
		endedAt: string | null;
		edition: string | null;
		failures: Failure[];
	};
	fork: {
		name: string;
		startedAt: string | null;
		endedAt: string | null;
		created: boolean;
		source: string | null;
		codes: string[];
		failures: Failure[];
	};
	/** True when the fork call and the library push were in flight together. */
	overlapped: boolean;
}

export async function probeForkDuringPush(
	workspace: Artifacts,
	library: ArtifactsRepo,
	actor: string,
	runId: string,
	wait?: WaitOptions,
): Promise<ProbeResult> {
	const name = suggestionName(actor, `${runId}-inflight`);
	const result: ProbeResult = {
		libraryPush: { startedAt: null, endedAt: null, edition: null, failures: [] },
		fork: {
			name,
			startedAt: null,
			endedAt: null,
			created: false,
			source: null,
			codes: [],
			failures: [],
		},
		overlapped: false,
	};

	let forkPromise: Promise<void> | null = null;
	const access = await writeAccess(library, 120);
	try {
		result.libraryPush.edition = await publishFile({
			remote: access.remote,
			token: access.token,
			path: PROBE_PATH,
			content: PROBE_BODY,
			message: "Save a library edition while a copy is made",
			author: DEMO_AUTHOR,
			hasHistory: true,
			beforePush: () => {
				forkPromise = (async () => {
					result.fork.startedAt = new Date().toISOString();
					try {
						const suggestion = await ensureSuggestion(workspace, library, name, wait);
						result.fork.created = suggestion.created;
						result.fork.codes = suggestion.afterFork?.codes ?? [];
						const info = await suggestion.repo.info();
						result.fork.source = info.source;
					} catch (error) {
						const code = errorCode(error);
						if (code) result.fork.codes.push(code);
						result.fork.failures.push(describeError(error));
					} finally {
						result.fork.endedAt = new Date().toISOString();
					}
				})();
			},
			mark: (phase) => {
				const now = new Date().toISOString();
				if (phase === "push-start") result.libraryPush.startedAt = now;
				if (phase === "push-end") result.libraryPush.endedAt = now;
			},
		});
	} catch (error) {
		result.libraryPush.failures.push(describeError(error));
	}
	if (forkPromise) await forkPromise;
	if (!result.libraryPush.endedAt) result.libraryPush.endedAt = new Date().toISOString();
	if (!result.libraryPush.startedAt) result.libraryPush.startedAt = result.libraryPush.endedAt;

	const pushStart = Date.parse(result.libraryPush.startedAt);
	const pushEnd = Date.parse(result.libraryPush.endedAt);
	const forkStart = result.fork.startedAt ? Date.parse(result.fork.startedAt) : NaN;
	const forkEnd = result.fork.endedAt ? Date.parse(result.fork.endedAt) : NaN;
	result.overlapped =
		!Number.isNaN(forkStart) &&
		!Number.isNaN(forkEnd) &&
		forkStart < pushEnd &&
		forkEnd > pushStart;
	return result;
}

export interface NotesResult {
	repoName: string | null;
	ref: string;
	target: string | null;
	pushed: boolean;
	failures: Failure[];
}

/** Push one notes ref on a copy that already exists. Does not change its main line. */
export async function pushNotesOnCopy(repo: ArtifactsRepo, repoName: string): Promise<NotesResult> {
	const result: NotesResult = {
		repoName,
		ref: NOTES_REF,
		target: null,
		pushed: false,
		failures: [],
	};
	try {
		const access = await writeAccess(repo, 120);
		const pushed = await publishNotesRef({ remote: access.remote, token: access.token });
		result.ref = pushed.ref;
		result.target = pushed.target;
		result.pushed = true;
	} catch (error) {
		result.failures.push(describeError(error));
	}
	return result;
}
