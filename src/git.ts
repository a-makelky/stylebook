// Writing to a library. The Artifacts binding reads repos but does not write
// files, so writes go through Git. Inside a Worker that means isomorphic-git
// on an in-memory file system.
// https://developers.cloudflare.com/artifacts/examples/isomorphic-git/

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memory-fs";

export interface Author {
	name: string;
	email: string;
}

export interface PublishInput {
	/** HTTPS Git remote of the repo to write to. */
	remote: string;
	/** Repo-scoped write token, as Artifacts returns it, or a Stylebook key for the Git route. */
	token: string;
	/** Repository-relative path of the file to write. */
	path: string;
	content: string;
	message: string;
	author: Author;
	/** False for a repo with no editions yet; true to add on top of existing ones. */
	hasHistory: boolean;
	branch?: string;
	/**
	 * Called once the local edition exists, immediately before it is sent.
	 * Used to start other work so it overlaps the send. It is not awaited.
	 */
	beforePush?: () => void;
	/** Marks the moment the send starts and the moment it returns. */
	mark?: (phase: "push-start" | "push-end") => void;
	/** When set, a git note is written for the new edition and pushed under refs/notes/*. */
	note?: { text: string };
}

export interface PublishOutcome {
	edition: string;
	noteCommit: string | null;
}

/** A note ref, used to see whether a push of refs/notes/* is reported. */
export const NOTES_REF = "refs/notes/stylebook";

/**
 * Artifacts tokens look like `art_v1_<secret>?expires=<unix seconds>`.
 * Git Basic auth wants only the secret.
 */
export function tokenSecret(token: string): string {
	return token.split("?expires=")[0] ?? token;
}

function auth(token: string) {
	const password = tokenSecret(token);
	return () => ({ username: "x", password });
}

function gitHeaders(): { "User-Agent": string } {
	// A fresh object every call. isomorphic-git writes Authorization onto the
	// headers object it is given, and a shared object would reuse the first key.
	return { "User-Agent": "stylebook" };
}

async function pushRef(
	fs: MemoryFS,
	remote: string,
	ref: string,
	onAuth: () => { username: string; password: string },
): Promise<void> {
	const result = await git.push({
		fs,
		http,
		dir: "/work",
		url: remote,
		ref,
		remoteRef: ref,
		onAuth,
		headers: gitHeaders(),
	});
	if (!result.ok) {
		throw new Error(`Publishing was rejected: ${result.error ?? "unknown reason"}`);
	}
}

/** Write one file as a new edition and, when asked, a note for it. */
export async function publishSavedEdition(input: PublishInput): Promise<PublishOutcome> {
	const branch = input.branch ?? "main";
	const dir = "/work";
	const fs = new MemoryFS();
	const onAuth = auth(input.token);

	if (input.hasHistory) {
		// Depth 1 is enough: the new edition's parent is the tip we just fetched,
		// and the server already has everything behind it.
		await git.clone({
			fs,
			http,
			dir,
			url: input.remote,
			ref: branch,
			singleBranch: true,
			depth: 1,
			onAuth,
			headers: gitHeaders(),
		});
	} else {
		await git.init({ fs, dir, defaultBranch: branch });
	}

	await fs.promises.writeFile(`${dir}/${input.path}`, input.content);
	await git.add({ fs, dir, filepath: input.path });
	const edition = await git.commit({
		fs,
		dir,
		message: input.message,
		author: input.author,
	});

	let noteCommit: string | null = null;
	if (input.note) {
		noteCommit = await writeNote(fs, input.remote, onAuth, edition, input.note.text, input.author);
	}

	input.beforePush?.();
	input.mark?.("push-start");
	await pushRef(fs, input.remote, branch, onAuth);
	if (noteCommit) {
		try {
			await pushRef(fs, input.remote, NOTES_REF, onAuth);
		} catch {
			// The edition is already saved. A missing note does not undo it.
			noteCommit = null;
		}
	}
	input.mark?.("push-end");

	return { edition, noteCommit };
}

/** Write one file as a new edition and return the new edition's ID. */
export async function publishFile(input: PublishInput): Promise<string> {
	const saved = await publishSavedEdition(input);
	return saved.edition;
}

export interface PreparedFile {
	path: string;
	content: string;
}

export interface PrepareContext {
	tip: string | null;
	read(path: string): Promise<string | null>;
}

export type PrepareOutcome = { files: PreparedFile[]; message: string; note?: string } | { stop: string };

const PUBLISH_ATTEMPTS = 3;

/**
 * A note sits on its own ref, so a shallow clone of main does not contain it.
 * Fetch that ref first when it already exists, then add the note on top.
 * Otherwise the send is not a fast-forward and the note is refused.
 * https://developers.cloudflare.com/artifacts/concepts/best-practices/
 */
async function writeNote(
	fs: MemoryFS,
	remote: string,
	onAuth: () => { username: string; password: string },
	edition: string,
	note: string,
	author: Author,
): Promise<string> {
	try {
		await git.fetch({
			fs,
			http,
			dir: "/work",
			url: remote,
			ref: NOTES_REF,
			singleBranch: true,
			depth: 1,
			onAuth,
			headers: gitHeaders(),
		});
	} catch {
		// The first note on a copy. There is no ref to fetch yet.
	}
	return git.addNote({
		fs,
		dir: "/work",
		oid: edition,
		ref: NOTES_REF,
		note,
		author,
		force: true,
	});
}

function raced(reason: string): boolean {
	return /non-fast-forward|rejected|cannot lock|failed to lock|failed to push|failed to update ref|not updated/i.test(
		reason,
	);
}

/**
 * Clone the current edition, decide the files from that edition, then send.
 * If another publish lands first, the send is refused and the whole step runs
 * again against the new edition. A `stop` result sends nothing.
 */
export async function publishPrepared(input: {
	remote: string;
	token: string;
	author: Author;
	hasHistory: boolean;
	prepare: (tree: PrepareContext) => Promise<PrepareOutcome>;
}): Promise<{ edition: string; noteCommit: string | null } | { stopped: string }> {
	let history = input.hasHistory;
	for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt++) {
		const dir = "/work";
		const fs = new MemoryFS();
		const onAuth = auth(input.token);
		if (history) {
			await git.clone({
				fs,
				http,
				dir,
				url: input.remote,
				ref: "main",
				singleBranch: true,
				depth: 1,
				onAuth,
				headers: gitHeaders(),
			});
		} else {
			await git.init({ fs, dir, defaultBranch: "main" });
		}
		let tip: string | null = null;
		if (history) {
			try {
				tip = await git.resolveRef({ fs, dir, ref: "HEAD" });
			} catch {
				tip = null;
			}
		}
		const prepared = await input.prepare({
			tip,
			async read(path: string) {
				try {
					const data = await fs.promises.readFile(`${dir}/${path}`, "utf8");
					return typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array);
				} catch {
					return null;
				}
			},
		});
		if ("stop" in prepared) return { stopped: prepared.stop };

		for (const file of prepared.files) {
			await fs.promises.writeFile(`${dir}/${file.path}`, file.content);
			await git.add({ fs, dir, filepath: file.path });
		}
		const edition = await git.commit({
			fs,
			dir,
			message: prepared.message,
			author: input.author,
		});
		let noteCommit: string | null = null;
		if (prepared.note) {
			noteCommit = await writeNote(fs, input.remote, onAuth, edition, prepared.note, input.author);
		}
		try {
			await pushRef(fs, input.remote, "main", onAuth);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (attempt < PUBLISH_ATTEMPTS && raced(reason)) {
				history = true;
				continue;
			}
			throw error;
		}
		if (noteCommit) {
			try {
				await pushRef(fs, input.remote, NOTES_REF, onAuth);
			} catch {
				noteCommit = null;
			}
		}
		return { edition, noteCommit };
	}
	return { stopped: "The library changed while this was publishing. Nothing was lost. Try again." };
}
