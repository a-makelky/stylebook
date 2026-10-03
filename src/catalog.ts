// Skills, workflows, and the team's connections, read from the library.

import type { Env } from "./env";
import { ensureLibrary, listPaths, readBytes } from "./workspace";
import { zipStore } from "./zip";

export interface LibraryPrompt {
	name: string;
	title: string;
	description: string;
	path: string;
	text: string;
}

export interface TeamConnection {
	name: string;
	url: string;
}

const SECRET_QUERY = /(?:^|&)(?:access_)?(?:token|key|secret|password)=/i;

function descriptionOf(text: string): string {
	for (const line of text.split("\n")) {
		if (line.startsWith("description:")) return line.slice("description:".length).trim();
	}
	return "";
}

function titleOf(path: string, text: string): string {
	for (const line of text.split("\n")) {
		if (line.startsWith("# ")) return line.slice(2).trim();
	}
	const file = path.split("/").at(-1) ?? path;
	return file.replace(/\.md$/i, "").replace(/[-_]+/g, " ");
}

function promptName(path: string): string {
	const folder = path.split("/").at(-2);
	const file = (path.split("/").at(-1) ?? path).replace(/\.md$/i, "");
	const raw = path.startsWith("skills/") && folder ? folder : file;
	const cleaned = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return cleaned || "page";
}

/** A public address only. Query secrets and sign-in material are dropped. */
export function publicServerUrl(value: string): string | null {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		if (url.username || url.password) return null;
		if (url.search && SECRET_QUERY.test(url.search.slice(1))) return null;
		return url.toString();
	} catch {
		return null;
	}
}

export function parseTeamConnections(text: string): TeamConnection[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return [];
	}
	if (!parsed || typeof parsed !== "object") return [];
	const servers = (parsed as { mcpServers?: unknown }).mcpServers;
	if (!servers || typeof servers !== "object") return [];
	const connections: TeamConnection[] = [];
	for (const [name, value] of Object.entries(servers)) {
		if (!value || typeof value !== "object") continue;
		const url = (value as { url?: unknown }).url;
		if (typeof url !== "string") continue;
		const safe = publicServerUrl(url);
		if (!safe) continue;
		const clean = name.replace(/[\r\n]+/g, " ").trim().slice(0, 80);
		if (!clean) continue;
		connections.push({ name: clean, url: safe });
	}
	return connections;
}

async function readText(env: Env, workspaceId: string, path: string): Promise<string | null> {
	const library = await ensureLibrary(env.WORKSPACE, workspaceId);
	const bytes = await readBytes(library.repo, path);
	return bytes ? new TextDecoder().decode(bytes) : null;
}

export async function libraryPrompts(env: Env, workspaceId: string): Promise<LibraryPrompt[]> {
	const library = await ensureLibrary(env.WORKSPACE, workspaceId);
	const paths = (await listPaths(library.repo)).filter(
		(path) => path.startsWith("skills/") || path.startsWith("workflows/"),
	);
	const prompts: LibraryPrompt[] = [];
	const used = new Set<string>();
	for (const path of paths) {
		if (!path.endsWith(".md")) continue;
		const bytes = await readBytes(library.repo, path);
		if (!bytes) continue;
		const text = new TextDecoder().decode(bytes);
		let name = promptName(path);
		if (used.has(name)) name = `${name}-${prompts.length + 1}`;
		used.add(name);
		prompts.push({
			name,
			title: titleOf(path, text),
			description: descriptionOf(text) || titleOf(path, text),
			path,
			text,
		});
	}
	return prompts;
}

export async function teamConnections(env: Env, workspaceId: string): Promise<TeamConnection[]> {
	const text = await readText(env, workspaceId, "connections/servers.json");
	if (!text) return [];
	return parseTeamConnections(text);
}

export async function skillZip(env: Env, workspaceId: string): Promise<Uint8Array> {
	const library = await ensureLibrary(env.WORKSPACE, workspaceId);
	const paths = (await listPaths(library.repo)).filter((path) => path.startsWith("skills/") && path.endsWith("/SKILL.md"));
	const files: { name: string; data: Uint8Array }[] = [];
	for (const path of paths) {
		const data = await readBytes(library.repo, path);
		if (data) files.push({ name: path, data });
	}
	return zipStore(files);
}

export function toolLabel(raw: string): string {
	const clean = raw.replace(/[\r\n]+/g, " ").trim();
	const lower = clean.toLowerCase();
	if (!clean) return "Your tool";
	if (lower.includes("claude") && lower.includes("code")) return "Claude Code";
	if (lower.includes("visual studio") || lower.includes("vscode")) return "VS Code";
	if (lower.includes("chatgpt") || lower.includes("openai")) return "ChatGPT";
	if (lower.includes("codex")) return "Codex";
	if (lower.includes("cursor")) return "Cursor";
	if (lower.includes("claude")) return "Claude";
	return clean.slice(0, 40);
}
