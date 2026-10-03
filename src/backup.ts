// A workspace download is a zip of the library. The same folder is a Git
// repository: full history, with notes, and no email addresses in that history.
// https://developers.cloudflare.com/artifacts/examples/isomorphic-git/
// https://developers.cloudflare.com/artifacts/concepts/best-practices/

import git from "isomorphic-git";
import { listActors, type Actor } from "./actors";
import { BackupGitError, FRESH_GIT_CONFIG, keptGitRelative, measureGitObjects } from "./backup-git";
import { backupLimits } from "./limits";
import type { Env } from "./env";
import { NOTES_REF } from "./git";
import { MemoryFS } from "./memory-fs";
import { cloneHistory, deliverWithRetries, WORK } from "./mirror";
import { parseEditionNote } from "./notes";
import { plainDate } from "./review";
import {
	addPerson,
	cleanWorkspaceName,
	createWorkspace,
	releaseWorkspaceStart,
	reserveWorkspaceStart,
} from "./teams";
import { NOT_A_BACKUP, UPLOAD_TOO_BIG, unzipStore, zipStore, ZipError, type ZipEntry } from "./zip";
import {
	deleteWorkspaceRepos,
	ensureLibrary,
	getRepo,
	isSuggestionName,
	libraryName,
	listRepoNames,
	repoInWorkspace,
	writeAccess,
} from "./workspace";

export const DOWNLOAD_TOO_BIG = "This workspace is larger than a backup can hold.";
const EXPORT_EMAIL = "backup";

export interface DownloadFile {
	zip: Uint8Array;
	filename: string;
	bytes: number;
	ms: number;
}

interface HistoryLine {
	heading: string;
	when: string;
	who: string;
	reason: string | null;
}

function stripEmails(value: string): string {
	return value.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "…").trim();
}

function dayStamp(when: Date): string {
	return when.toISOString().slice(0, 10);
}

export function backupFolderName(workspaceName: string, when: Date): string {
	const slug = workspaceName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
	return `${slug || "workspace"}-${dayStamp(when)}`;
}

export function aboutBackup(workspaceName: string, when: Date, suggestions: boolean): string {
	const taken = plainDate(when.toISOString());
	const extra = suggestions ? "\nOpen suggestions are in suggestions/, each with its note.\n" : "";
	return `# About this backup

This is a Stylebook backup of the ${workspaceName} workspace, taken ${taken}.

The folder is the library as it is now: skills, workflows and connections. HISTORY.md lists every edition, newest first. people.md lists names and roles. Email addresses, agent keys and sign-in data are not included.

To bring it back into Stylebook, an Admin opens Backups and chooses Restore, then uploads this file. That starts a new workspace. It does not change an existing one. People and agents are invited again.

A Git tool can open this same folder. Its history lists every edition, and the notes are kept under the name stylebook:

    git log
    git notes --ref=stylebook
${extra}`;
}

export function peopleDocument(people: { name: string; role: string }[]): string {
	const lines = people.map((person) => `- ${stripEmails(person.name) || "Someone"}, ${person.role}`);
	return `# People\n\n${lines.join("\n")}\n`;
}

function historyDocument(editions: HistoryLine[], suggestions: HistoryLine[]): string {
	const block = (line: HistoryLine) => {
		const reason = line.reason ? `\nReason: ${line.reason}` : "";
		return `## ${line.heading}\n${line.when}\n${line.who}${reason}\n`;
	};
	const open =
		suggestions.length === 0
			? ""
			: `\n# Open suggestions\n\n${suggestions.map(block).join("\n")}`;
	return `# History\n\n${editions.map(block).join("\n")}${open}`;
}

async function filesAt(fs: MemoryFS, oid: string): Promise<Map<string, Uint8Array>> {
	const files = new Map<string, Uint8Array>();
	await git.walk({
		fs,
		dir: WORK,
		trees: [git.TREE({ ref: oid })],
		map: async (filepath, entries) => {
			const entry = entries?.[0];
			if (!entry || filepath === ".") return;
			if ((await entry.type()) !== "blob") return;
			const content = await entry.content();
			if (content) files.set(filepath, content);
		},
	});
	return files;
}

async function noteText(fs: MemoryFS, oid: string): Promise<string | null> {
	try {
		const text = await git.readNote({ fs, dir: WORK, oid, ref: NOTES_REF });
		return typeof text === "string" ? text : new TextDecoder().decode(text);
	} catch {
		return null;
	}
}

async function historyOf(
	fs: MemoryFS,
	approvers: Map<string, string>,
): Promise<{ lines: HistoryLine[]; commits: Awaited<ReturnType<typeof git.log>> }> {
	const commits = await git.log({ fs, dir: WORK, ref: "main" });
	const total = commits.length;
	const lines: HistoryLine[] = [];
	for (let index = 0; index < commits.length; index++) {
		const commit = commits[index]!;
		const note = parseEditionNote((await noteText(fs, commit.oid)) ?? "");
		const approver = stripEmails(approvers.get(commit.oid) ?? commit.commit.author.name) || "Someone";
		const writer = note ? stripEmails(note.actor) : "";
		const owner = note ? stripEmails(note.onBehalfOf) : "";
		const who =
			writer && owner && writer !== approver
				? `Written by ${writer} for ${owner}, approved by ${approver}.`
				: `Approved by ${approver}.`;
		const when = plainDate(new Date(commit.commit.author.timestamp * 1000).toISOString());
		lines.push({
			heading: `Edition ${total - index}`,
			when,
			who,
			reason: note ? stripEmails(note.intent) || null : null,
		});
	}
	return { lines, commits };
}

async function rewriteHistory(source: MemoryFS, commits: Awaited<ReturnType<typeof git.log>>): Promise<MemoryFS> {
	const dest = new MemoryFS();
	await git.init({ fs: dest, dir: WORK, defaultBranch: "main" });
	const ordered = [...commits].reverse();
	let previous = new Set<string>();
	const renamed = new Map<string, string>();
	for (const commit of ordered) {
		const files = await filesAt(source, commit.oid);
		for (const path of previous) {
			if (files.has(path)) continue;
			try {
				await git.remove({ fs: dest, dir: WORK, filepath: path });
			} catch {
				// A path that was never added is already absent.
			}
		}
		for (const [path, data] of files) {
			await dest.promises.writeFile(`${WORK}/${path}`, data);
			await git.add({ fs: dest, dir: WORK, filepath: path });
		}
		previous = new Set(files.keys());
		const author = {
			name: stripEmails(commit.commit.author.name) || "Stylebook",
			email: EXPORT_EMAIL,
			timestamp: commit.commit.author.timestamp,
			timezoneOffset: commit.commit.author.timezoneOffset,
		};
		let oid: string;
		try {
			oid = await git.commit({
				fs: dest,
				dir: WORK,
				message: stripEmails(commit.commit.message) || "Saved an edition.",
				author,
				committer: author,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			if (!/no changes/i.test(message)) throw error;
			oid = await git.resolveRef({ fs: dest, dir: WORK, ref: "HEAD" });
		}
		renamed.set(commit.oid, oid);
	}
	for (const commit of ordered) {
		const text = await noteText(source, commit.oid);
		const oid = renamed.get(commit.oid);
		if (!text || !oid) continue;
		const author = { name: "Stylebook", email: EXPORT_EMAIL };
		await git.addNote({
			fs: dest,
			dir: WORK,
			oid,
			ref: NOTES_REF,
			note: `${stripEmails(text)}\n`,
			author,
			committer: author,
			force: true,
		});
	}
	return dest;
}

async function suggestionExports(
	env: Env,
	workspaceId: string,
	libraryOids: Set<string>,
): Promise<{ lines: HistoryLine[]; folders: { path: string; data: Uint8Array }[] }> {
	const names = (await listRepoNames(env.WORKSPACE))
		.filter((name) => repoInWorkspace(workspaceId, name) && isSuggestionName(name))
		.sort();
	const lines: HistoryLine[] = [];
	const folders: { path: string; data: Uint8Array }[] = [];
	let number = 0;
	for (const name of names) {
		const repo = await getRepo(env.WORKSPACE, name);
		if (!repo) continue;
		const access = await repo.createToken("read", 300);
		const info = await repo.info();
		const copy = await cloneHistory(info.remote, access.plaintext);
		let head = "";
		try {
			head = await git.resolveRef({ fs: copy, dir: WORK, ref: "HEAD" });
		} catch {
			continue;
		}
		if (libraryOids.has(head)) continue;
		number += 1;
		const logged = await git.log({ fs: copy, dir: WORK, depth: 1 });
		const tip = logged[0];
		const note = tip ? parseEditionNote((await noteText(copy, tip.oid)) ?? "") : null;
		const writer = stripEmails(note?.actor || tip?.commit.author.name || "") || "Someone";
		const owner = stripEmails(note?.onBehalfOf || "") || writer;
		const when = tip ? plainDate(new Date(tip.commit.author.timestamp * 1000).toISOString()) : "";
		const reason = note ? stripEmails(note.intent) || null : tip ? stripEmails(tip.commit.message.split("\n")[0] ?? "") || null : null;
		lines.push({
			heading: `Suggestion ${number}`,
			when,
			who: `Written by ${writer} for ${owner}.`,
			reason,
		});
		const files = await filesAt(copy, head);
		for (const [path, data] of files) {
			folders.push({ path: `suggestions/${number}/${path}`, data });
		}
		const noteBody = `Written by ${writer} for ${owner}.${reason ? `\nReason: ${reason}` : ""}\n`;
		folders.push({ path: `suggestions/${number}/NOTE.md`, data: new TextEncoder().encode(noteBody) });
	}
	return { lines, folders };
}

export async function downloadWorkspace(
	env: Env,
	actor: Actor,
	includeSuggestions: boolean,
	now = new Date(),
): Promise<DownloadFile | { sentence: string }> {
	const started = Date.now();
	const cap = backupLimits(env).backupBytes;
	const repo = await getRepo(env.WORKSPACE, libraryName(actor.workspaceId));
	if (!repo) return { sentence: "This workspace has no library yet." };
	const access = await repo.createToken("read", 300);
	const info = await repo.info();
	const source = await cloneHistory(info.remote, access.plaintext);
	if (totalBytes(source.filesUnder(WORK)) > cap) return { sentence: DOWNLOAD_TOO_BIG };
	const approverRows = await env.DB.prepare(
		`SELECT edition_id, actor_name FROM gateway_pushes
     WHERE repo_name = ?1 AND ref_name = 'refs/heads/main'
     ORDER BY id`,
	)
		.bind(libraryName(actor.workspaceId))
		.all<{ edition_id: string; actor_name: string }>();
	const approvers = new Map<string, string>();
	for (const row of approverRows.results ?? []) approvers.set(row.edition_id, row.actor_name);
	const { lines, commits } = await historyOf(source, approvers);
	if (commits.length === 0) return { sentence: "This workspace has no library yet." };
	const suggestions = includeSuggestions
		? await suggestionExports(env, actor.workspaceId, new Set(commits.map((commit) => commit.oid)))
		: { lines: [], folders: [] };
	const people = (await listActors(env.DB, actor.workspaceId))
		.filter((person) => person.kind === "person" && !person.removedAt)
		.map((person) => ({
			name: person.name,
			role: person.role === "admin" ? "Admin" : "Member",
		}))
		.sort((left, right) => left.name.localeCompare(right.name));
	const workspace = await env.DB.prepare(`SELECT name FROM workspaces WHERE id = ?1`)
		.bind(actor.workspaceId)
		.first<{ name: string }>();
	const workspaceName = workspace?.name ?? "Workspace";
	const dest = await rewriteHistory(source, commits);
	const folder = backupFolderName(workspaceName, now);
	await dest.promises.writeFile(`${WORK}/HISTORY.md`, historyDocument(lines, suggestions.lines));
	await dest.promises.writeFile(`${WORK}/people.md`, peopleDocument(people));
	await dest.promises.writeFile(
		`${WORK}/ABOUT-THIS-BACKUP.md`,
		aboutBackup(workspaceName, now, suggestions.lines.length > 0),
	);
	for (const file of suggestions.folders) {
		await dest.promises.writeFile(`${WORK}/${file.path}`, file.data);
	}
	const entries = dest.filesUnder(WORK).map((file) => ({
		name: `${folder}/${file.path}`,
		data: file.data,
	}));
	if (storedZipBytes(entries) > cap) return { sentence: DOWNLOAD_TOO_BIG };
	const zip = zipStore(entries);
	return {
		zip,
		filename: `${folder}.zip`,
		bytes: zip.byteLength,
		ms: Date.now() - started,
	};
}

function totalBytes(files: { data: Uint8Array }[]): number {
	let total = 0;
	for (const file of files) total += file.data.byteLength;
	return total;
}

/** Stored-zip size, including the headers, before the archive is built. */
function storedZipBytes(entries: { name: string; data: Uint8Array }[]): number {
	const encoder = new TextEncoder();
	let total = 22;
	for (const entry of entries) {
		const name = encoder.encode(entry.name).byteLength;
		total += 76 + name * 2 + entry.data.byteLength;
	}
	return total;
}

function safeHead(data: Uint8Array): boolean {
	const text = new TextDecoder().decode(data).trim();
	return text === "ref: refs/heads/main" || /^[0-9a-f]{40}$/.test(text);
}

export async function loadBackup(
	bytes: Uint8Array,
	limits: { uploadBytes: number; inflatedBytes: number },
): Promise<{ fs: MemoryFS } | { sentence: string }> {
	if (bytes.byteLength > limits.uploadBytes) return { sentence: UPLOAD_TOO_BIG };
	let entries: ZipEntry[];
	try {
		entries = unzipStore(bytes, limits.uploadBytes);
	} catch (error) {
		if (error instanceof ZipError) return { sentence: error.message };
		return { sentence: NOT_A_BACKUP };
	}
	const head = entries.find((entry) => entry.name === ".git/HEAD" || entry.name.endsWith("/.git/HEAD"));
	if (!head || !safeHead(head.data)) return { sentence: NOT_A_BACKUP };
	const root = head.name.slice(0, head.name.length - ".git/HEAD".length);
	const about = entries.find((entry) => entry.name === `${root}ABOUT-THIS-BACKUP.md`);
	if (!about || !new TextDecoder().decode(about.data).includes("Stylebook backup")) {
		return { sentence: NOT_A_BACKUP };
	}
	const plain: { relative: string; data: Uint8Array }[] = [];
	const gitFiles: { path: string; data: Uint8Array }[] = [];
	for (const entry of entries) {
		if (!entry.name.startsWith(root)) continue;
		const relative = entry.name.slice(root.length);
		if (!relative) continue;
		if (relative === ".git" || relative.startsWith(".git/")) {
			const gitPath = relative.slice(".git/".length);
			if (keptGitRelative(gitPath)) gitFiles.push({ path: gitPath, data: entry.data });
			continue;
		}
		plain.push({ relative, data: entry.data });
	}
	const shaped = plain.some(
		(file) =>
			file.relative.startsWith("skills/") ||
			file.relative.startsWith("workflows/") ||
			file.relative.startsWith("connections/"),
	);
	if (!shaped || !gitFiles.some((file) => file.path === "HEAD")) return { sentence: NOT_A_BACKUP };
	try {
		await measureGitObjects(gitFiles, limits.inflatedBytes);
	} catch (error) {
		if (error instanceof BackupGitError) return { sentence: error.message };
		return { sentence: NOT_A_BACKUP };
	}
	const fs = new MemoryFS();
	for (const file of plain) await fs.promises.writeFile(`${WORK}/${file.relative}`, file.data);
	for (const file of gitFiles) await fs.promises.writeFile(`${WORK}/.git/${file.path}`, file.data);
	await fs.promises.writeFile(`${WORK}/.git/config`, FRESH_GIT_CONFIG);
	let oid = "";
	try {
		oid = await git.resolveRef({ fs, dir: WORK, ref: "refs/heads/main" });
	} catch {
		return { sentence: NOT_A_BACKUP };
	}
	const files = await filesAt(fs, oid);
	const inHistory = [...files.keys()].some(
		(path) => path.startsWith("skills/") || path.startsWith("workflows/") || path.startsWith("connections/"),
	);
	if (!inHistory) return { sentence: NOT_A_BACKUP };
	return { fs };
}

/**
 * Start a new workspace from a backup. The current workspace is left as it is.
 * People and agents are not copied. The person who uploads it is the Admin.
 */
export async function startFromBackup(
	env: Env,
	actor: Actor,
	bytes: Uint8Array,
	requestedName: string,
	ip: string,
): Promise<{ actor: Actor; workspaceName: string } | { sentence: string }> {
	const loaded = await loadBackup(bytes, backupLimits(env));
	if ("sentence" in loaded) return loaded;
	return startFromHistory(env, actor, loaded.fs, requestedName, ip, "refs/heads/main");
}

export async function startFromHistory(
	env: Env,
	actor: Actor,
	fs: MemoryFS,
	requestedName: string,
	ip: string,
	localBranch = "refs/heads/main",
): Promise<{ actor: Actor; workspaceName: string } | { sentence: string }> {
	if (!actor.email) return { sentence: "Sign in again to start a workspace." };
	const name = cleanWorkspaceName(requestedName);
	if (!name) return { sentence: "Give the workspace a short name." };
	const reserved = await reserveWorkspaceStart(env, actor.email, ip);
	if ("message" in reserved) return { sentence: reserved.message };
	const created = await createWorkspace(env, name);
	if ("message" in created) {
		await releaseWorkspaceStart(env, reserved.id);
		return { sentence: created.message };
	}
	const fail = async (sentence: string) => {
		await deleteWorkspaceRepos(env.WORKSPACE, created.id).catch(() => undefined);
		await env.DB.prepare(`DELETE FROM actors WHERE workspace_id = ?1`).bind(created.id).run();
		await env.DB.prepare(`DELETE FROM workspace_starts WHERE workspace_id = ?1 OR id = ?2`).bind(created.id, reserved.id).run();
		await env.DB.prepare(`DELETE FROM workspaces WHERE id = ?1`).bind(created.id).run();
		return { sentence };
	};
	try {
		await env.DB.prepare(
			`UPDATE workspace_starts SET workspace_id = ?1 WHERE id = ?2 AND workspace_id IS NULL`,
		)
			.bind(created.id, reserved.id)
			.run();
		const person = await addPerson(env, created.id, actor.email, actor.name, "admin");
		if ("message" in person) return fail(person.message);
		await env.DB.prepare(`UPDATE actors SET role = 'admin' WHERE id = ?1`).bind(person.id).run();
		await env.DB.prepare(`UPDATE workspaces SET owner_id = ?1 WHERE id = ?2`).bind(person.id, created.id).run();
		person.role = "admin";
		const library = await ensureLibrary(env.WORKSPACE, created.id);
		const access = await writeAccess(library.repo);
		const sent = await deliverWithRetries({
			fs,
			destRemote: access.remote,
			destSecret: access.token,
			destUsername: "x",
			branch: { local: localBranch, remote: "refs/heads/main" },
		});
		if (!sent.ok) return fail(sent.sentence);
		return { actor: { ...person, workspaceId: created.id }, workspaceName: created.name };
	} catch {
		return fail("The backup could not be restored. Nothing was changed.");
	}
}

function isIpLiteral(host: string): boolean {
	const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	if (bare.includes(":")) return true;
	if (/^\d+$/.test(bare)) return true;
	const parts = bare.split(".");
	if (parts.length !== 4) return false;
	return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function blockedHost(host: string, pageHost: string): boolean {
	const name = host.toLowerCase().replace(/\.$/, "");
	const page = pageHost.toLowerCase().split(":")[0] ?? "";
	if (!name || name === page) return true;
	if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local")) return true;
	if (name === "stylebook.dev" || name.endsWith(".stylebook.dev")) return true;
	if (name === "workers.dev" || name.endsWith(".workers.dev")) return true;
	if (name === "artifacts.cloudflare.net" || name.endsWith(".artifacts.cloudflare.net")) return true;
	if (name.endsWith(".internal")) return true;
	return isIpLiteral(name);
}

/** An https address for one repository. No address, no private host, no redirect target we would follow. */
export function cleanBackupAddress(value: string, pageHost: string): string | null {
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "https:") return null;
	if (url.username || url.password || url.search || url.hash) return null;
	if (blockedHost(url.hostname, pageHost)) return null;
	if (!url.pathname || url.pathname === "/") return null;
	return url.toString();
}
