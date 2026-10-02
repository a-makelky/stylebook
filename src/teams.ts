// A workspace is one team: its own library, people, agents and history.
// The Artifacts namespace is shared. The workspace id is the repo prefix.

import { actorById, hashKey, registerActor, type Actor } from "./actors";
import type { Env } from "./env";
import { LIMIT_MESSAGE, limitsOf } from "./limits";
import { normalizeEmail, rememberLink, takeLink, type StoredLink } from "./mail";
import { libraryName } from "./workspace";

const SESSION_TTL_SECONDS = 1_209_600;

export interface WorkspaceRecord {
	id: string;
	name: string;
}

export function cleanWorkspaceName(value: string): string | null {
	const name = value.replace(/[\r\n]+/g, " ").trim();
	if (name.length < 1 || name.length > 60) return null;
	return name;
}

export function newWorkspaceId(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	const bytes = new Uint8Array(7);
	crypto.getRandomValues(bytes);
	let id = "w";
	for (const byte of bytes) id += alphabet[byte % alphabet.length]!;
	return id;
}

function newActorId(kind: "person" | "agent"): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	const bytes = new Uint8Array(10);
	crypto.getRandomValues(bytes);
	let id = kind === "person" ? "p" : "a";
	for (const byte of bytes) id += alphabet[byte % alphabet.length]!;
	return id;
}

export function newKey(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function nameFromEmail(email: string): string {
	const local = email.split("@")[0] ?? "";
	const words = local.replace(/[^a-zA-Z0-9]+/g, " ").trim();
	if (!words) return "Colleague";
	const titled = words.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
	return titled.slice(0, 40);
}

export async function workspaceById(db: D1Database, id: string): Promise<WorkspaceRecord | null> {
	const row = await db.prepare(`SELECT id, name FROM workspaces WHERE id = ?1`).bind(id).first<WorkspaceRecord>();
	return row ?? null;
}

export async function countWorkspaces(db: D1Database): Promise<number> {
	const row = await db.prepare(`SELECT COUNT(*) AS n FROM workspaces`).bind().first<{ n: number }>();
	return row?.n ?? 0;
}

export async function countMembers(db: D1Database, workspaceId: string, kind: "person" | "agent"): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM actors WHERE workspace_id = ?1 AND kind = ?2 AND removed_at IS NULL`,
		)
		.bind(workspaceId, kind)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

export async function openSuggestionCount(db: D1Database, workspaceId: string): Promise<number> {
	const row = await db
		.prepare(
			`SELECT COUNT(DISTINCT repo_name) AS n FROM gateway_pushes
       WHERE workspace_id = ?1 AND ref_name = 'refs/heads/main' AND repo_name LIKE ?2`,
		)
		.bind(workspaceId, `${workspaceId}-sug-%`)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

export async function memberships(db: D1Database, email: string): Promise<{ actor: Actor; workspace: WorkspaceRecord }[]> {
	const rows = await db
		.prepare(
			`SELECT a.id AS actor_id, w.id AS workspace_id, w.name AS workspace_name
       FROM actors a
       JOIN workspaces w ON w.id = a.workspace_id
       WHERE a.email = ?1 AND a.kind = 'person' AND a.removed_at IS NULL
       ORDER BY a.created_at`,
		)
		.bind(email)
		.all<{ actor_id: string; workspace_id: string; workspace_name: string }>();
	const found: { actor: Actor; workspace: WorkspaceRecord }[] = [];
	for (const row of rows.results ?? []) {
		const actor = await actorInWorkspace(db, row.workspace_id, row.actor_id);
		if (!actor) continue;
		found.push({ actor, workspace: { id: row.workspace_id, name: row.workspace_name } });
	}
	return found;
}

async function actorInWorkspace(db: D1Database, workspaceId: string, actorId: string): Promise<Actor | null> {
	const actor = await actorById(db, actorId);
	if (!actor || actor.workspaceId !== workspaceId || actor.removedAt) return null;
	return actor;
}

export async function createWorkspace(env: Env, name: string): Promise<WorkspaceRecord | { message: string }> {
	const clean = cleanWorkspaceName(name);
	if (!clean) return { message: "Give the workspace a short name." };
	if ((await countWorkspaces(env.DB)) >= limitsOf(env).workspaces) return { message: LIMIT_MESSAGE.workspaces };
	const id = newWorkspaceId();
	const now = new Date().toISOString();
	await env.DB.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES (?1, ?2, ?3)`).bind(id, clean, now).run();
	return { id, name: clean };
}

export async function addPerson(
	env: Env,
	workspaceId: string,
	email: string,
	name?: string,
): Promise<Actor | { message: string }> {
	const normalized = normalizeEmail(email);
	if (!normalized) return { message: "Enter an email address." };
	const existing = (await memberships(env.DB, normalized)).find((item) => item.workspace.id === workspaceId);
	if (existing) return existing.actor;
	if ((await countMembers(env.DB, workspaceId, "person")) >= limitsOf(env).people) {
		return { message: LIMIT_MESSAGE.people };
	}
	const actor = await registerActor(env.DB, {
		id: newActorId("person"),
		kind: "person",
		name: name?.trim() || nameFromEmail(normalized),
		workspaceId,
		email: normalized,
		key: newKey(),
	});
	return actor;
}

export async function openSession(db: D1Database, actor: Actor): Promise<string> {
	const secret = newKey();
	const now = new Date();
	const expires = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
	await db
		.prepare(
			`INSERT INTO sessions (token_hash, actor_id, workspace_id, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
		)
		.bind(await hashKey(secret), actor.id, actor.workspaceId, now.toISOString(), expires)
		.run();
	return secret;
}

export async function actorBySession(db: D1Database, secret: string): Promise<Actor | null> {
	if (secret.length < 16) return null;
	const row = await db
		.prepare(
			`SELECT actor_id, expires_at FROM sessions WHERE token_hash = ?1`,
		)
		.bind(await hashKey(secret))
		.first<{ actor_id: string; expires_at: string }>();
	if (!row || row.expires_at <= new Date().toISOString()) return null;
	const actor = await actorById(db, row.actor_id);
	if (!actor || actor.removedAt) return null;
	return actor;
}

export async function endSession(db: D1Database, secret: string): Promise<void> {
	await db.prepare(`DELETE FROM sessions WHERE token_hash = ?1`).bind(await hashKey(secret)).run();
}

export async function removePerson(env: Env, actor: Actor, personId: string): Promise<string | null> {
	if (actor.kind !== "person") return "Only a person can remove someone.";
	if (personId === actor.id) return "You cannot remove yourself.";
	const person = await actorById(env.DB, personId);
	if (!person || person.workspaceId !== actor.workspaceId || person.kind !== "person" || person.removedAt) {
		return "That person is not in this workspace.";
	}
	const now = new Date().toISOString();
	await env.DB.prepare(`UPDATE actors SET removed_at = ?1 WHERE id = ?2`).bind(now, person.id).run();
	await env.DB.prepare(`DELETE FROM sessions WHERE actor_id = ?1`).bind(person.id).run();
	await env.DB.prepare(`DELETE FROM actor_keys WHERE actor_id = ?1`).bind(person.id).run();
	const agents = await env.DB.prepare(
		`SELECT id FROM actors WHERE owner_id = ?1 AND workspace_id = ?2 AND kind = 'agent'`,
	)
		.bind(person.id, actor.workspaceId)
		.all<{ id: string }>();
	for (const agent of agents.results ?? []) {
		await env.DB.prepare(`DELETE FROM actor_keys WHERE actor_id = ?1`).bind(agent.id).run();
	}
	return null;
}

export async function connectAgent(
	env: Env,
	owner: Actor,
	name: string,
	tool: string,
): Promise<{ actor: Actor; key: string } | { message: string }> {
	if (owner.kind !== "person" || owner.removedAt) return { message: "Sign in to connect an agent." };
	const clean = name.replace(/[\r\n]+/g, " ").trim();
	if (!clean || clean.length > 80) return { message: "Give the agent a short name." };
	const model = tool === "claude" ? "Claude Code" : tool === "cursor" ? "Cursor" : "Another tool";
	if ((await countMembers(env.DB, owner.workspaceId, "agent")) >= limitsOf(env).agents) {
		return { message: LIMIT_MESSAGE.agents };
	}
	const key = newKey();
	const actor = await registerActor(env.DB, {
		id: newActorId("agent"),
		kind: "agent",
		name: clean,
		workspaceId: owner.workspaceId,
		ownerId: owner.id,
		model,
		key,
	});
	return { actor, key };
}

export async function renameAgent(env: Env, owner: Actor, agentId: string, name: string): Promise<string | null> {
	const clean = name.replace(/[\r\n]+/g, " ").trim();
	if (!clean || clean.length > 80) return "Give the agent a short name.";
	const agent = await actorById(env.DB, agentId);
	if (!agent || agent.kind !== "agent" || agent.workspaceId !== owner.workspaceId || agent.ownerId !== owner.id) {
		return "That agent is not yours.";
	}
	await env.DB.prepare(`UPDATE actors SET name = ?1 WHERE id = ?2`).bind(clean, agent.id).run();
	return null;
}

export async function revokeAgentKey(env: Env, owner: Actor, agentId: string): Promise<string | null> {
	const agent = await actorById(env.DB, agentId);
	if (!agent || agent.kind !== "agent" || agent.workspaceId !== owner.workspaceId || agent.ownerId !== owner.id) {
		return "That agent is not yours.";
	}
	await env.DB.prepare(`DELETE FROM actor_keys WHERE actor_id = ?1`).bind(agent.id).run();
	return null;
}

export async function freshAgentKey(
	env: Env,
	owner: Actor,
	agentId: string,
): Promise<{ key: string } | { message: string }> {
	const agent = await actorById(env.DB, agentId);
	if (!agent || agent.kind !== "agent" || agent.workspaceId !== owner.workspaceId || agent.ownerId !== owner.id) {
		return { message: "That agent is not yours." };
	}
	const key = newKey();
	await env.DB.prepare(`DELETE FROM actor_keys WHERE actor_id = ?1`).bind(agent.id).run();
	await env.DB.prepare(`INSERT INTO actor_keys (key_hash, actor_id, created_at) VALUES (?1, ?2, ?3)`)
		.bind(await hashKey(key), agent.id, new Date().toISOString())
		.run();
	return { key };
}

export interface Joined {
	actor: Actor;
	workspace: WorkspaceRecord;
	secret: string;
}

/** Turn a sign-in link into a session, or a choice when the address is in more than one workspace. */
export async function joinFromLink(
	env: Env,
	secret: string,
): Promise<{ joined: Joined } | { choose: { secret: string; workspaces: WorkspaceRecord[] } } | { message: string }> {
	const link = await takeLink(env, secret);
	if (!link) return { message: "That link has expired or was already used." };
	if (link.purpose === "start") return startFromLink(env, link);
	if (link.purpose === "invite") return inviteFromLink(env, link);
	if (link.purpose === "sign-in" || link.purpose === "choose") {
		const homes = await memberships(env.DB, link.email);
		if (homes.length === 0) return { message: "That link has expired or was already used." };
		if (homes.length === 1 || link.purpose === "choose") {
			const only = homes[0]!;
			const picked = link.workspaceId ? homes.find((item) => item.workspace.id === link.workspaceId) : only;
			const home = picked ?? only;
			if (link.purpose === "choose" && !link.workspaceId) {
				return { message: "Choose a workspace." };
			}
			return { joined: { actor: home.actor, workspace: home.workspace, secret: await openSession(env.DB, home.actor) } };
		}
		const choice = await rememberLink(env, link.email, "choose");
		return { choose: { secret: choice, workspaces: homes.map((item) => item.workspace) } };
	}
	return { message: "That link has expired or was already used." };
}

async function startFromLink(env: Env, link: StoredLink): Promise<{ joined: Joined } | { message: string }> {
	const created = await createWorkspace(env, link.workspaceName ?? "");
	if ("message" in created) return { message: created.message };
	const person = await addPerson(env, created.id, link.email);
	if ("message" in person) return { message: person.message };
	return { joined: { actor: person, workspace: created, secret: await openSession(env.DB, person) } };
}

async function inviteFromLink(env: Env, link: StoredLink): Promise<{ joined: Joined } | { message: string }> {
	if (!link.workspaceId) return { message: "That link has expired or was already used." };
	const workspace = await workspaceById(env.DB, link.workspaceId);
	if (!workspace) return { message: "That link has expired or was already used." };
	const person = await addPerson(env, workspace.id, link.email);
	if ("message" in person) return { message: person.message };
	return { joined: { actor: person, workspace, secret: await openSession(env.DB, person) } };
}

export async function chooseWorkspace(env: Env, email: string, workspaceId: string): Promise<Joined | { message: string }> {
	const homes = await memberships(env.DB, email);
	const home = homes.find((item) => item.workspace.id === workspaceId);
	if (!home) return { message: "That workspace is not yours." };
	return { actor: home.actor, workspace: home.workspace, secret: await openSession(env.DB, home.actor) };
}

export function libraryRepo(workspaceId: string): string {
	return libraryName(workspaceId);
}
