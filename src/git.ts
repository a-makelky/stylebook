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
	/** Repo-scoped write token, as Artifacts returns it. */
	token: string;
	/** Repository-relative path of the file to write. */
	path: string;
	content: string;
	message: string;
	author: Author;
	/** False for a repo with no editions yet; true to add on top of existing ones. */
	hasHistory: boolean;
	branch?: string;
}

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

/** Write one file as a new edition and return the new edition's ID. */
export async function publishFile(input: PublishInput): Promise<string> {
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

	const result = await git.push({
		fs,
		http,
		dir,
		url: input.remote,
		ref: branch,
		onAuth,
	});
	if (!result.ok) {
		throw new Error(`Publishing was rejected: ${result.error ?? "unknown reason"}`);
	}

	return edition;
}
