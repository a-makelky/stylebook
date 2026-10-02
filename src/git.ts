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
		// The note is a separate commit on refs/notes/*, so the edition itself
		// does not change. https://developers.cloudflare.com/artifacts/concepts/best-practices/
		noteCommit = await git.addNote({
			fs,
			dir,
			oid: edition,
			ref: NOTES_REF,
			note: input.note.text,
			author: input.author,
			force: true,
		});
	}

	input.beforePush?.();
	input.mark?.("push-start");
	await pushRef(fs, input.remote, branch, onAuth);
	if (noteCommit) await pushRef(fs, input.remote, NOTES_REF, onAuth);
	input.mark?.("push-end");

	return { edition, noteCommit };
}

/** Write one file as a new edition and return the new edition's ID. */
export async function publishFile(input: PublishInput): Promise<string> {
	const saved = await publishSavedEdition(input);
	return saved.edition;
}
