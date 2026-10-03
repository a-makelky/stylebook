// Send a library's history to a backup. The remote branch is always
// `stylebook`. The send is never a force push, and no other branch is updated.
// https://developers.cloudflare.com/artifacts/examples/isomorphic-git/
// https://developers.cloudflare.com/artifacts/concepts/best-practices/
// https://developers.cloudflare.com/artifacts/api/workers-binding/
// https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { openSecret } from "./backup-crypto";
import { keptMirrors, markMirror, readMirror, type MirrorKind, type MirrorRow } from "./backup-store";
import type { Env } from "./env";
import { NOTES_REF, tokenSecret } from "./git";
import { githubInstallationToken, GITHUB_NOT_READY, githubReady } from "./github-app";
import { MemoryFS } from "./memory-fs";
import { getRepo, libraryName } from "./workspace";

export type { MirrorKind };

export const WORK = "/work";
/** The only branch a backup is sent to. */
export const MIRROR_BRANCH = "stylebook";
export const MIRROR_REF = `refs/heads/${MIRROR_BRANCH}`;
export const DIVERGED = "This backup has changes that are not in the workspace. Nothing was sent.";
export const SEND_FAILED = "The backup could not be sent. Try again.";
const ATTEMPTS = 3;

export interface DeliverInput {
	fs: MemoryFS;
	destRemote: string;
	destSecret: string;
	destUsername: string;
	/** Local ref and the ref it may update. Nothing else is sent. */
	branch: { local: string; remote: string };
}

export type DeliverResult = { ok: true } | { ok: false; sentence: string; diverged: boolean };

function headers(): { "User-Agent": string } {
	return { "User-Agent": "stylebook" };
}

function auth(username: string, secret: string): () => { username: string; password: string } {
	const password = tokenSecret(secret);
	return () => ({ username, password });
}

/** Full history of one branch, plus notes when the library has them. */
export async function cloneHistory(
	remote: string,
	secret: string,
	username = "x",
	ref = "main",
): Promise<MemoryFS> {
	const fs = new MemoryFS();
	const onAuth = auth(username, secret);
	await git.clone({
		fs,
		http,
		dir: WORK,
		url: remote,
		ref,
		singleBranch: true,
		onAuth,
		headers: headers(),
	});
	try {
		const listed = await git.listServerRefs({
			http,
			url: remote,
			onAuth,
			headers: headers(),
			protocolVersion: 1,
			prefix: NOTES_REF,
		});
		const tip = listed.find((item) => item.ref === NOTES_REF)?.oid;
		if (!tip) return fs;
		await git.fetch({
			fs,
			http,
			dir: WORK,
			url: remote,
			remoteRef: NOTES_REF,
			singleBranch: true,
			onAuth,
			headers: headers(),
		});
		await git.writeRef({ fs, dir: WORK, ref: NOTES_REF, value: tip, force: true });
	} catch {
		// A library with no notes is still a complete backup of its editions.
	}
	return fs;
}

async function remoteTip(
	remote: string,
	onAuth: () => { username: string; password: string },
	ref: string,
): Promise<string | null> {
	try {
		const listed = await git.listServerRefs({
			http,
			url: remote,
			onAuth,
			headers: headers(),
			protocolVersion: 1,
			prefix: ref,
		});
		const oid = listed.find((item) => item.ref === ref)?.oid ?? null;
		if (!oid || oid === "0000000000000000000000000000000000000000") return null;
		return oid;
	} catch {
		return null;
	}
}

async function hasCommit(fs: MemoryFS, ref: string, oid: string): Promise<boolean> {
	try {
		const log = await git.log({ fs, dir: WORK, ref });
		return log.some((commit) => commit.oid === oid);
	} catch {
		return false;
	}
}

type RefCheck = "send" | "same" | "absent" | "diverged";

async function checkRef(fs: MemoryFS, input: DeliverInput, local: string, remoteRef: string): Promise<RefCheck> {
	let localId: string | null = null;
	try {
		localId = await git.resolveRef({ fs, dir: WORK, ref: local });
	} catch {
		localId = null;
	}
	const remoteId = await remoteTip(input.destRemote, auth(input.destUsername, input.destSecret), remoteRef);
	if (!localId && !remoteId) return "absent";
	if (!localId && remoteId) return "diverged";
	if (!remoteId) return "send";
	if (remoteId === localId) return "same";
	if (await hasCommit(fs, local, remoteId)) return "send";
	return "diverged";
}

async function pushRef(fs: MemoryFS, input: DeliverInput, local: string, remoteRef: string): Promise<void> {
	const result = await git.push({
		fs,
		http,
		dir: WORK,
		url: input.destRemote,
		ref: local,
		remoteRef,
		onAuth: auth(input.destUsername, input.destSecret),
		headers: headers(),
	});
	if (!result.ok) {
		const reason = result.error ?? "";
		if (/non-fast-forward|reject|hook|uptodate|up-to-date/i.test(reason)) {
			throw new Error("diverged");
		}
		throw new Error("send");
	}
}

/**
 * Send one branch and the notes. Stops when the backup has history this
 * workspace does not have. Does not force, and does not send any other ref.
 */
export async function deliverHistory(input: DeliverInput): Promise<DeliverResult> {
	const branch = await checkRef(input.fs, input, input.branch.local, input.branch.remote);
	const notes = await checkRef(input.fs, input, NOTES_REF, NOTES_REF);
	if (branch === "diverged" || notes === "diverged") {
		return { ok: false, sentence: DIVERGED, diverged: true };
	}
	try {
		if (branch === "send") await pushRef(input.fs, input, input.branch.local, input.branch.remote);
		if (notes === "send") await pushRef(input.fs, input, NOTES_REF, NOTES_REF);
	} catch (error) {
		const message = error instanceof Error ? error.message : "";
		if (message === "diverged") return { ok: false, sentence: DIVERGED, diverged: true };
		throw error;
	}
	return { ok: true };
}

export async function deliverWithRetries(input: DeliverInput, attempts = ATTEMPTS): Promise<DeliverResult> {
	let failed: DeliverResult = { ok: false, sentence: SEND_FAILED, diverged: false };
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await deliverHistory(input);
		} catch {
			failed = { ok: false, sentence: SEND_FAILED, diverged: false };
		}
	}
	return failed;
}

/** Point a local `stylebook` ref at main and send that, plus notes. */
export async function sendMirror(input: {
	sourceRemote: string;
	sourceSecret: string;
	destRemote: string;
	destSecret: string;
	destUsername: string;
}): Promise<DeliverResult> {
	const fs = await cloneHistory(input.sourceRemote, input.sourceSecret);
	const main = await git.resolveRef({ fs, dir: WORK, ref: "refs/heads/main" });
	await git.writeRef({ fs, dir: WORK, ref: MIRROR_REF, value: main, force: true });
	return deliverWithRetries({
		fs,
		destRemote: input.destRemote,
		destSecret: input.destSecret,
		destUsername: input.destUsername,
		branch: { local: MIRROR_REF, remote: MIRROR_REF },
	});
}

export function mirrorUsername(address: string, kind: MirrorKind, login: string | null): string {
	let host = "";
	try {
		host = new URL(address).hostname;
	} catch {
		host = "";
	}
	if (kind === "github" && host === "github.com") return "x-access-token";
	return login?.trim() || "stylebook";
}

async function credentials(
	env: Env,
	mirror: MirrorRow,
): Promise<{ secret: string; username: string } | { sentence: string }> {
	const username = mirrorUsername(mirror.address, mirror.kind, mirror.login);
	if (mirror.tokenCipher) {
		if (!env.BACKUP_KEY) return { sentence: "Backups to another service are not set up on this server yet." };
		try {
			return { secret: await openSecret(env.BACKUP_KEY, mirror.tokenCipher), username };
		} catch {
			return { sentence: "The saved secret could not be read. Disconnect and save it again." };
		}
	}
	if (mirror.kind !== "github") return { sentence: "Save a secret for this backup first." };
	if (!githubReady(env)) return { sentence: GITHUB_NOT_READY };
	if (!mirror.installationId) return { sentence: "Connect GitHub first." };
	const token = await githubInstallationToken(env, mirror.installationId);
	if (!token) return { sentence: "GitHub could not be reached. Try again." };
	return { secret: token, username: "x-access-token" };
}

/**
 * Send the workspace library to one saved backup. The Artifacts remote stays
 * inside this function: it contains the account id and is not logged.
 */
export async function runMirror(env: Env, workspaceId: string, kind: MirrorKind): Promise<DeliverResult> {
	const mirror = await readMirror(env.DB, workspaceId, kind);
	if (!mirror || !mirror.address) {
		return { ok: false, sentence: "Choose where to back up first.", diverged: false };
	}
	const creds = await credentials(env, mirror);
	if ("sentence" in creds) {
		await markMirror(env.DB, workspaceId, kind, { ok: false, sentence: creds.sentence });
		return { ok: false, sentence: creds.sentence, diverged: false };
	}
	const repo = await getRepo(env.WORKSPACE, libraryName(workspaceId));
	if (!repo) {
		const sentence = "This workspace has no library yet.";
		await markMirror(env.DB, workspaceId, kind, { ok: false, sentence });
		return { ok: false, sentence, diverged: false };
	}
	let result: DeliverResult;
	try {
		const [info, token] = await Promise.all([repo.info(), repo.createToken("read", 300)]);
		result = await sendMirror({
			sourceRemote: info.remote,
			sourceSecret: token.plaintext,
			destRemote: mirror.address,
			destSecret: creds.secret,
			destUsername: creds.username,
		});
	} catch {
		result = { ok: false, sentence: SEND_FAILED, diverged: false };
	}
	if (result.ok) await markMirror(env.DB, workspaceId, kind, { ok: true, at: new Date().toISOString() });
	else await markMirror(env.DB, workspaceId, kind, { ok: false, sentence: result.sentence });
	return result;
}

/** After a library publish, send again where an Admin asked to keep the backup current. */
export async function mirrorKeptLibraries(env: Env, repoName: string, refName: string): Promise<void> {
	const match = /^([a-z][a-z0-9]{2,15})-library$/.exec(repoName);
	if (!match || refName !== "refs/heads/main") return;
	const workspaceId = match[1]!;
	const mirrors = await keptMirrors(env.DB, workspaceId);
	for (const mirror of mirrors) {
		await runMirror(env, workspaceId, mirror.kind);
	}
}
