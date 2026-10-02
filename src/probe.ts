// Two live questions that are not part of the 25 sessions:
// a copy made while a library push is in flight, and one push of refs/notes/*.

import { publishFile, type Author } from "./git";
import { describeError, type Failure } from "./redact";
import {
	ensureSuggestion,
	errorCode,
	suggestionName,
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
	workspaceId: string,
	actor: string,
	runId: string,
	access: { remote: string; token: string; author: Author },
	wait?: WaitOptions,
): Promise<ProbeResult> {
	const name = suggestionName(workspaceId, actor, `${runId}-inflight`);
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
	try {
		result.libraryPush.edition = await publishFile({
			remote: access.remote,
			token: access.token,
			path: PROBE_PATH,
			content: PROBE_BODY,
			message: "Save a library edition while a copy is made",
			author: access.author,
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
