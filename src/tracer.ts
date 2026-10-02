// Tracer 1: one thin path through every layer.
// library -> suggestion copy (a real fork) -> read back -> compare -> history.

import { publishFile, type Author } from "./git";
import { STARTER_SKILL, STARTER_SKILL_PATH, withRevisionNote } from "./seed";
import {
	ensureLibrary,
	ensureSuggestion,
	listEditions,
	readBytes,
	suggestionName,
	writeAccess,
	type Edition,
	type WaitOptions,
} from "./workspace";

export interface TracerOptions {
	actor: string;
	session: string;
	workspaceId?: string;
	/** Add one more edition to the library before making the copy. */
	addEdition?: boolean;
	wait?: WaitOptions;
}

export interface TracerResult {
	library: {
		created: boolean;
		publishedEdition: string | null;
		editions: Edition[];
	};
	suggestion: {
		name: string;
		created: boolean;
		/** Where the copy came from, as Artifacts records it. */
		source: string | null;
		editions: Edition[];
	};
	readBack: {
		path: string;
		bytes: number;
		librarySha256: string;
		suggestionSha256: string;
		/** True when the copy's file is byte-identical to the library's. */
		identical: boolean;
		preview: string;
	};
	/**
	 * What the live binding did while making the copy. Null when this call
	 * reused a copy and did not call fork().
	 */
	afterFork: {
		codes: string[];
		attempts: number;
		elapsedMs: number;
	} | null;
	note: string | null;
}

// Placeholder identity for demo writes. Real actors arrive with the next tracer.
export const DEMO_AUTHOR: Author = {
	name: "Stylebook demo",
	email: "demo@stylebook.invalid",
};

async function sha256(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

export async function runTracer(
	workspace: Artifacts,
	options: TracerOptions,
): Promise<TracerResult> {
	const workspaceId = options.workspaceId ?? "trace";
	const library = await ensureLibrary(workspace, workspaceId, options.wait);
	const before = await listEditions(library.repo);

	let publishedEdition: string | null = null;
	if (before.length === 0) {
		publishedEdition = await publishFile({
			...(await writeAccess(library.repo)),
			path: STARTER_SKILL_PATH,
			content: STARTER_SKILL,
			message: "Add the interview-to-draft skill",
			author: DEMO_AUTHOR,
			hasHistory: false,
		});
	} else if (options.addEdition) {
		const current = await readBytes(library.repo, STARTER_SKILL_PATH);
		const text = current ? new TextDecoder().decode(current) : STARTER_SKILL;
		publishedEdition = await publishFile({
			...(await writeAccess(library.repo)),
			path: STARTER_SKILL_PATH,
			content: withRevisionNote(text, before.length + 1),
			message: `Add revision note for edition ${before.length + 1}`,
			author: DEMO_AUTHOR,
			hasHistory: true,
		});
	}

	const name = suggestionName(workspaceId, options.actor, options.session);
	const suggestion = await ensureSuggestion(
		workspace,
		library.repo,
		name,
		options.wait,
	);

	const [libraryBytes, suggestionBytes, info, libraryEditions, suggestionEditions] =
		await Promise.all([
			readBytes(library.repo, STARTER_SKILL_PATH),
			readBytes(suggestion.repo, STARTER_SKILL_PATH),
			suggestion.repo.info(),
			listEditions(library.repo),
			listEditions(suggestion.repo),
		]);

	if (!libraryBytes) {
		throw new Error(`${STARTER_SKILL_PATH} is missing from the library`);
	}
	if (!suggestionBytes) {
		throw new Error(`${STARTER_SKILL_PATH} is missing from ${name}`);
	}

	const identical = sameBytes(libraryBytes, suggestionBytes);
	const note =
		!identical && !suggestion.created
			? "This copy already existed and was made before the library's latest edition, so it differs from the library."
			: null;

	return {
		library: {
			created: library.created,
			publishedEdition,
			editions: libraryEditions,
		},
		suggestion: {
			name,
			created: suggestion.created,
			source: info.source,
			editions: suggestionEditions,
		},
		readBack: {
			path: STARTER_SKILL_PATH,
			bytes: suggestionBytes.byteLength,
			librarySha256: await sha256(libraryBytes),
			suggestionSha256: await sha256(suggestionBytes),
			identical,
			preview: new TextDecoder().decode(suggestionBytes).slice(0, 240),
		},
		afterFork: suggestion.afterFork ?? null,
		note,
	};
}
