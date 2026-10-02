// A workspace is one team: its own library, people, agents and history.
// The Artifacts namespace is shared. The workspace id is the repo prefix.

import { actorById, hashKey, registerActor, type Actor } from "./actors";
import { revokeGrants } from "./access";
import type { Env } from "./env";
import { LIMIT_MESSAGE, limitsOf } from "./limits";
import { claimSignInSend, normalizeEmail, rememberLink, sendStoredLink, takeLink, type StoredLink } from "./mail";
import { libraryName } from "./workspace";

const SESSION_TTL_SECONDS = 1_209_600;

export interface WorkspaceRecord {
	id: string;
	name: string;
	ownerId: string | null;
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
	const row = await db
		.prepare(`SELECT id, name, owner_id FROM workspaces WHERE id = ?1`)
		.bind(id)
		.first<{ id: string; name: string; owner_id: string | null }>();
	return row ? { id: row.id, name: row.name, ownerId: row.owner_id } : null;
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
			`SELECT a.id AS actor_id, w.id AS workspace_id, w.name AS workspace_name, w.owner_id
       FROM actors a
       JOIN workspaces w ON w.id = a.workspace_id
       WHERE a.email = ?1 AND a.kind = 'person' AND a.removed_at IS NULL
       ORDER BY a.created_at`,
		)
		.bind(email)
		.all<{ actor_id: string; workspace_id: string; workspace_name: string; owner_id: string | null }>();
	const found: { actor: Actor; workspace: WorkspaceRecord }[] = [];
	for (const row of rows.results ?? []) {
		const actor = await actorInWorkspace(db, row.workspace_id, row.actor_id);
		if (!actor) continue;
		found.push({
			actor,
			workspace: { id: row.workspace_id, name: row.workspace_name, ownerId: row.owner_id },
		});
	}
	return found;
}

async function actorInWorkspace(db: D1Database, workspaceId: string, actorId: string): Promise<Actor | null> {
	const actor = await actorById(db, actorId);
	if (!actor || actor.workspaceId !== workspaceId || actor.removedAt) return null;
	return actor;
}

function wrote(result: D1Result): number {
	return result.meta?.changes ?? 0;
}

function utcDayStart(now = new Date()): string {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/**
 * Hold a place for one new workspace. The count and the insert are one
 * statement, so a burst of /start requests cannot all pass.
 * https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
 */
export async function reserveWorkspaceStart(
	env: Env,
	email: string,
	ip: string,
): Promise<{ id: number } | { message: string }> {
	const limits = limitsOf(env);
	const now = new Date().toISOString();
	const dayStart = utcDayStart();
	const result = await env.DB.prepare(
		`INSERT INTO workspace_starts (email, ip, started_at)
     SELECT ?1, ?2, ?3
     WHERE (SELECT COUNT(*) FROM workspace_starts WHERE email = ?1) < ?4
       AND (SELECT COUNT(*) FROM workspace_starts WHERE ip = ?2 AND started_at >= ?5) < ?6
       AND (SELECT COUNT(*) FROM workspaces) + (SELECT COUNT(*) FROM workspace_starts WHERE workspace_id IS NULL) < ?7`,
	)
		.bind(email, ip, now, limits.workspacesPerEmail, dayStart, limits.workspacesPerIpPerDay, limits.workspaces)
		.run();
	if (wrote(result) < 1) return { message: await workspaceStartRefusal(env, email, ip) };
	return { id: result.meta?.last_row_id ?? 0 };
}

async function workspaceStartRefusal(env: Env, email: string, ip: string): Promise<string> {
	const limits = limitsOf(env);
	const byEmail = await env.DB.prepare(`SELECT COUNT(*) AS n FROM workspace_starts WHERE email = ?1`)
		.bind(email)
		.first<{ n: number }>();
	if ((byEmail?.n ?? 0) >= limits.workspacesPerEmail) return LIMIT_MESSAGE.workspacesPerEmail;
	const byIp = await env.DB.prepare(
		`SELECT COUNT(*) AS n FROM workspace_starts WHERE ip = ?1 AND started_at >= ?2`,
	)
		.bind(ip, utcDayStart())
		.first<{ n: number }>();
	if ((byIp?.n ?? 0) >= limits.workspacesPerIpPerDay) return LIMIT_MESSAGE.workspacesPerIp;
	return LIMIT_MESSAGE.workspaces;
}

export async function releaseWorkspaceStart(env: Env, id: number): Promise<void> {
	await env.DB.prepare(`DELETE FROM workspace_starts WHERE id = ?1 AND workspace_id IS NULL`).bind(id).run();
}

export async function createWorkspace(env: Env, name: string): Promise<WorkspaceRecord | { message: string }> {
	const clean = cleanWorkspaceName(name);
	if (!clean) return { message: "Give the workspace a short name." };
	const limits = limitsOf(env);
	const id = newWorkspaceId();
	const now = new Date().toISOString();
	const inserted = await env.DB.prepare(
		`INSERT INTO workspaces (id, name, created_at)
     SELECT ?1, ?2, ?3
     WHERE (SELECT COUNT(*) FROM workspaces) < ?4`,
	)
		.bind(id, clean, now, limits.workspaces)
		.run();
	if (wrote(inserted) < 1) return { message: LIMIT_MESSAGE.workspaces };
	const count = await countWorkspaces(env.DB);
	if (count >= limits.workspaces * 0.8 && count - 1 < limits.workspaces * 0.8) {
		console.log(JSON.stringify({ event: "workspace_cap", count, cap: limits.workspaces }));
	}
	return { id, name: clean, ownerId: null };
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

async function dropActorAccess(env: Env, actorId: string): Promise<void> {
	await revokeGrants(env.DB, actorId);
	await env.DB.prepare(`DELETE FROM sessions WHERE actor_id = ?1`).bind(actorId).run();
	await env.DB.prepare(`DELETE FROM actor_keys WHERE actor_id = ?1`).bind(actorId).run();
}

export async function removePerson(env: Env, actor: Actor, personId: string): Promise<string | null> {
	if (actor.kind !== "person" || actor.removedAt) return "Only a person can remove someone.";
	const workspace = await workspaceById(env.DB, actor.workspaceId);
	if (!workspace || workspace.ownerId !== actor.id) {
		return "Only the person who started this workspace can remove someone.";
	}
	if (personId === actor.id || personId === workspace.ownerId) {
		return "The person who started this workspace cannot be removed.";
	}
	const person = await actorById(env.DB, personId);
	if (!person || person.workspaceId !== actor.workspaceId || person.kind !== "person" || person.removedAt) {
		return "That person is not in this workspace.";
	}
	const now = new Date().toISOString();
	await env.DB.prepare(`UPDATE actors SET removed_at = ?1 WHERE id = ?2`).bind(now, person.id).run();
	await dropActorAccess(env, person.id);
	const agents = await env.DB.prepare(
		`SELECT id FROM actors WHERE owner_id = ?1 AND workspace_id = ?2 AND kind = 'agent'`,
	)
		.bind(person.id, actor.workspaceId)
		.all<{ id: string }>();
	for (const agent of agents.results ?? []) {
		await dropActorAccess(env, agent.id);
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

/** The agent's own person, or the person who started the workspace. */
export async function canManageAgent(env: Env, person: Actor, agent: Actor): Promise<boolean> {
	if (person.kind !== "person" || person.removedAt) return false;
	if (agent.kind !== "agent" || agent.removedAt || agent.workspaceId !== person.workspaceId) return false;
	if (agent.ownerId === person.id) return true;
	const workspace = await workspaceById(env.DB, person.workspaceId);
	return workspace?.ownerId === person.id;
}

async function managedAgent(env: Env, person: Actor, agentId: string): Promise<Actor | null> {
	const agent = await actorById(env.DB, agentId);
	if (!agent || !(await canManageAgent(env, person, agent))) return null;
	return agent;
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
	const agent = await managedAgent(env, owner, agentId);
	if (!agent) return "That agent is not yours.";
	await dropActorAccess(env, agent.id);
	return null;
}

export async function removeAgent(env: Env, owner: Actor, agentId: string): Promise<string | null> {
	const agent = await managedAgent(env, owner, agentId);
	if (!agent) return "That agent is not yours.";
	await env.DB.prepare(`UPDATE actors SET removed_at = ?1 WHERE id = ?2`).bind(new Date().toISOString(), agent.id).run();
	await dropActorAccess(env, agent.id);
	return null;
}

export async function freshAgentKey(
	env: Env,
	owner: Actor,
	agentId: string,
): Promise<{ key: string } | { message: string }> {
	const agent = await managedAgent(env, owner, agentId);
	if (!agent) return { message: "That agent is not yours." };
	const key = newKey();
	await revokeGrants(env.DB, agent.id);
	await env.DB.prepare(`DELETE FROM actor_keys WHERE actor_id = ?1`).bind(agent.id).run();
	await env.DB.prepare(`INSERT INTO actor_keys (key_hash, actor_id, created_at) VALUES (?1, ?2, ?3)`)
		.bind(await hashKey(key), agent.id, new Date().toISOString())
		.run();
	return { key };
}

/**
 * Send a sign-in link only when the address is already in a workspace.
 * The caller returns before this finishes, so every address takes the same reply.
 */
export async function deliverSignIn(env: Env, origin: string, email: string, ip: string): Promise<void> {
	try {
		if (!env.EMAIL) return;
		const normalized = normalizeEmail(email);
		if (!normalized) return;
		if (!(await claimSignInSend(env, normalized, ip))) return;
		const homes = await memberships(env.DB, normalized);
		if (homes.length === 0) return;
		await sendStoredLink(env, origin, { email: normalized, purpose: "sign-in" });
	} catch {
		console.log(JSON.stringify({ event: "sign_in_send_failed" }));
	}
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
	await env.DB.prepare(
		`UPDATE workspace_starts SET workspace_id = ?1
     WHERE id = (
       SELECT id FROM workspace_starts
       WHERE email = ?2 AND workspace_id IS NULL
       ORDER BY id
       LIMIT 1
     )`,
	)
		.bind(created.id, link.email)
		.run();
	const person = await addPerson(env, created.id, link.email);
	if ("message" in person) return { message: person.message };
	await env.DB.prepare(`UPDATE workspaces SET owner_id = ?1 WHERE id = ?2 AND owner_id IS NULL`)
		.bind(person.id, created.id)
		.run();
	created.ownerId = person.id;
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
