// One scripted agent session: its own suggestion copy, a write token minted
// only for that copy, and one saved change. A hosted model is not used.
// https://developers.cloudflare.com/artifacts/concepts/best-practices/

import { applyEdit, editAt, type EditKind } from "./edits";
import { gatewayRemote } from "./gateway";
import { publishSavedEdition } from "./git";
import { editionNote } from "./notes";
import { describeError, type Failure } from "./redact";
import { STARTER_SKILL_PATH } from "./seed";
import {
	ensureLibrary,
	ensureSuggestion,
	listEditions,
	readBytes,
	suggestionName,
	type GetReport,
	type WaitOptions,
} from "./workspace";

const PUBLISH_ATTEMPTS = 3;
const AGENT_EMAIL = "agent@stylebook.invalid";

/** How a session reaches the Git route. The key is the actor's Stylebook key. */
export interface SessionGateway {
	origin: string;
	key: string;
	actorName: string;
	ownerName: string;
	model: string;
}

export interface SessionParams {
	actor: string;
	session: string;
	editIndex: number;
	runId: string;
	/** Set by the route. The session pushes through the Git route as this actor. */
	gateway: SessionGateway;
}

export interface SessionResult {
	ok: boolean;
	name: string;
	actor: string;
	session: string;
	edit: { index: number; section: string; kind: EditKind; summary: string };
	startedAt: string;
	endedAt: string;
	elapsedMs: number;
	forkStartedAt: string | null;
	forkEndedAt: string | null;
	forkMs: number | null;
	afterFork: GetReport | null;
	source: string | null;
	created: boolean;
	libraryTip: string | null;
	libraryEditionCount: number | null;
	parentEdition: string | null;
	edition: string | null;
	editionCount: number | null;
	/** The new edition's parent is the library tip this copy was made from. */
	onTopOfLibrary: boolean;
	alreadyApplied: boolean;
	/** The notes commit, when the edition's note was pushed. */
	noteCommit: string | null;
	failures: Failure[];
}

function finish(
	partial: Omit<SessionResult, "endedAt" | "elapsedMs">,
	startedMs: number,
): SessionResult {
	const endedAt = new Date().toISOString();
	return { ...partial, endedAt, elapsedMs: Date.now() - startedMs };
}

export async function runSuggestionSession(
	workspace: Artifacts,
	params: SessionParams,
	wait?: WaitOptions,
): Promise<SessionResult> {
	const startedMs = Date.now();
	const startedAt = new Date(startedMs).toISOString();
	const edit = editAt(params.editIndex);
	const name = suggestionName(params.actor, params.session);
	const failures: Failure[] = [];
	const base = {
		name,
		actor: params.actor,
		session: params.session,
		edit: {
			index: params.editIndex,
			section: edit.section,
			kind: edit.kind,
			summary: edit.summary,
		},
		startedAt,
		forkStartedAt: null as string | null,
		forkEndedAt: null as string | null,
		forkMs: null as number | null,
		afterFork: null as GetReport | null,
		source: null as string | null,
		created: false,
		libraryTip: null as string | null,
		libraryEditionCount: null as number | null,
		parentEdition: null as string | null,
		edition: null as string | null,
		editionCount: null as number | null,
		onTopOfLibrary: false,
		alreadyApplied: false,
		noteCommit: null as string | null,
		failures,
	};

	try {
		const library = await ensureLibrary(workspace, wait);
		const libraryEditions = await listEditions(library.repo);
		const libraryTip = libraryEditions[0]?.id ?? null;
		base.libraryTip = libraryTip;
		base.libraryEditionCount = libraryEditions.length;

		const forkStartedMs = Date.now();
		base.forkStartedAt = new Date(forkStartedMs).toISOString();
		const suggestion = await ensureSuggestion(workspace, library.repo, name, wait);
		base.forkEndedAt = new Date().toISOString();
		base.forkMs = Date.now() - forkStartedMs;
		base.afterFork = suggestion.afterFork ?? null;
		base.created = suggestion.created;

		const info = await suggestion.repo.info();
		base.source = info.source;

		const currentBytes = await readBytes(suggestion.repo, STARTER_SKILL_PATH);
		if (!currentBytes) {
			failures.push({
				attempt: 1,
				code: "MISSING_FILE",
				message: `${STARTER_SKILL_PATH} is missing from the copy`,
			});
			return finish({ ...base, ok: false }, startedMs);
		}
		const current = new TextDecoder().decode(currentBytes);
		const next = applyEdit(current, edit);
		if (next === null) {
			failures.push({
				attempt: 1,
				code: "EDIT_ANCHOR_MISSING",
				message: `Could not apply edit ${params.editIndex} (${edit.section})`,
			});
			return finish({ ...base, ok: false }, startedMs);
		}

		const copyEditions = await listEditions(suggestion.repo, 20);
		const copyTip = copyEditions[0]?.id ?? null;
		if (next === current) {
			base.alreadyApplied = true;
			base.edition = copyTip;
			base.parentEdition = null;
			base.editionCount = copyEditions.length;
			base.onTopOfLibrary = false;
			return finish({ ...base, ok: true }, startedMs);
		}

		const author = { name: params.gateway.actorName, email: AGENT_EMAIL };
		let edition: string | null = null;
		for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt++) {
			try {
				const saved = await publishSavedEdition({
					remote: gatewayRemote(params.gateway.origin, name),
					token: params.gateway.key,
					path: STARTER_SKILL_PATH,
					content: next,
					message: edit.summary,
					author,
					hasHistory: true,
					note: {
						text: editionNote({
							actor: params.gateway.actorName,
							onBehalfOf: params.gateway.ownerName,
							model: params.gateway.model,
							runId: params.runId,
							intent: edit.summary,
						}),
					},
				});
				edition = saved.edition;
				base.noteCommit = saved.noteCommit;
				break;
			} catch (error) {
				failures.push(describeError(error, attempt));
				if (attempt === PUBLISH_ATTEMPTS) {
					return finish({ ...base, ok: false, edition }, startedMs);
				}
			}
		}

		const saved = await suggestion.repo.log({ ref: "main", limit: 1 });
		const tip = saved[0];
		base.edition = tip?.hash ?? edition;
		base.parentEdition = tip?.parents[0] ?? null;
		base.editionCount = copyEditions.length + 1;
		base.onTopOfLibrary = Boolean(
			base.edition && base.parentEdition && base.parentEdition === libraryTip && base.edition !== libraryTip,
		);
		return finish({ ...base, ok: base.onTopOfLibrary && Boolean(base.noteCommit) }, startedMs);
	} catch (error) {
		failures.push(describeError(error, failures.length + 1));
		return finish({ ...base, ok: false }, startedMs);
	}
}
