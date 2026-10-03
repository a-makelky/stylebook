// A workspace is one team: its own library, people, agents and history.
// The Artifacts namespace is shared. The workspace id is the repo prefix.

import { actorById, hashKey, listActors, registerActor, type Actor } from "./actors";
import { toolLabel } from "./catalog";
import { revokeGrants } from "./access";
import type { Env } from "./env";
import { LIMIT_MESSAGE, limitsOf } from "./limits";
import { authorize, effectiveLimits, pendingInvitations, type Invitation } from "./roles";
import type { Role } from "./permit";
import { claimSignInSend, normalizeEmail, rememberLink, sendStoredLink, takeLink, type StoredLink } from "./mail";
import { deleteWorkspaceRepos, libraryName } from "./workspace";

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

/** Demo copies expire and are not a team's workspace. */
const COUNTED_WORKSPACES = `(SELECT COUNT(*) FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM demo_copies d WHERE d.workspace_id = w.id))`;

export async function countWorkspaces(db: D1Database): Promise<number> {
	const row = await db.prepare(`SELECT COUNT(*) AS n FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM demo_copies d WHERE d.workspace_id = w.id)`).bind().first<{ n: number }>();
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
       AND ${COUNTED_WORKSPACES} + (SELECT COUNT(*) FROM workspace_starts WHERE workspace_id IS NULL) < ?7`,
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
     WHERE ${COUNTED_WORKSPACES} < ?4`,
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
	role?: Role,
): Promise<Actor | { message: string }> {
	const normalized = normalizeEmail(email);
	if (!normalized) return { message: "Enter an email address." };
	const existing = (await memberships(env.DB, normalized)).find((item) => item.workspace.id === workspaceId);
	if (existing) return existing.actor;
	if ((await countMembers(env.DB, workspaceId, "person")) >= (await effectiveLimits(env, workspaceId)).people) {
		return { message: LIMIT_MESSAGE.people };
	}
	const actor = await registerActor(env.DB, {
		id: newActorId("person"),
		kind: "person",
		name: name?.trim() || nameFromEmail(normalized),
		workspaceId,
		email: normalized,
		role,
		key: newKey(),
	});
	if (role) {
		await env.DB.prepare(`UPDATE actors SET role = ?1 WHERE id = ?2`).bind(role, actor.id).run();
		actor.role = role;
	}
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

async function revokeOauthGrants(env: Env, actorId: string): Promise<void> {
	const oauth = env.OAUTH_PROVIDER;
	if (!oauth) return;
	let cursor: string | undefined;
	do {
		const listed = await oauth.listUserGrants(actorId, cursor ? { cursor } : undefined);
		for (const grant of listed.items) await oauth.revokeGrant(grant.id, actorId);
		cursor = listed.cursor;
	} while (cursor);
}

async function dropActorAccess(env: Env, actorId: string): Promise<void> {
	await revokeOauthGrants(env, actorId);
	await revokeGrants(env.DB, actorId);
	await env.DB.prepare(`DELETE FROM sessions WHERE actor_id = ?1`).bind(actorId).run();
	await env.DB.prepare(`DELETE FROM actor_keys WHERE actor_id = ?1`).bind(actorId).run();
}

export async function removePerson(env: Env, actor: Actor, personId: string): Promise<string | null> {
	const decision = await authorize(env, actor, "remove-person", null, { targetId: personId });
	if (!decision.ok) return decision.sentence;
	if (personId === actor.id) return "You cannot remove yourself.";
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
	const decision = await authorize(env, owner, "connect-agent");
	if (!decision.ok) return { message: decision.sentence };
	if ((await countMembers(env.DB, owner.workspaceId, "agent")) >= (await effectiveLimits(env, owner.workspaceId)).agents) {
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

async function currentKeyHash(db: D1Database, actorId: string): Promise<string | null> {
	const row = await db
		.prepare(`SELECT key_hash FROM actor_keys WHERE actor_id = ?1 ORDER BY created_at DESC LIMIT 1`)
		.bind(actorId)
		.first<{ key_hash: string }>();
	return row?.key_hash ?? null;
}

async function unusedAgentName(db: D1Database, workspaceId: string, base: string): Promise<string> {
	const taken = new Set(
		(await listActors(db, workspaceId)).filter((agent) => agent.kind === "agent").map((agent) => agent.name),
	);
	if (!taken.has(base)) return base;
	for (let number = 2; number < 100; number++) {
		const suffix = ` (${number})`;
		const name = `${base.slice(0, 80 - suffix.length)}${suffix}`;
		if (!taken.has(name)) return name;
	}
	return base.slice(0, 80);
}

/**
 * An approved sign-in. The same OAuth client reconnects to its own agent and
 * keeps the key it already has. A different client gets a new agent. A key
 * made by hand is never replaced.
 */
export async function connectSignedInAgent(
	env: Env,
	owner: Actor,
	toolRaw: string,
	clientId: string,
): Promise<{ actor: Actor; keyHash: string } | { message: string }> {
	if (owner.kind !== "person" || owner.removedAt) return { message: "Sign in to connect a tool." };
	const client = clientId.trim();
	if (!client || client.length > 2000 || /[\r\n]/.test(client)) return { message: "This app could not be verified." };
	const tool = toolLabel(toolRaw).slice(0, 40);
	const decision = await authorize(env, owner, "connect-agent");
	if (!decision.ok) return { message: decision.sentence };
	const mapped = await env.DB.prepare(
		`SELECT agent_id FROM oauth_agents WHERE client_id = ?1 AND owner_id = ?2 AND workspace_id = ?3`,
	)
		.bind(client, owner.id, owner.workspaceId)
		.first<{ agent_id: string }>();
	if (mapped) {
		const agent = await actorById(env.DB, mapped.agent_id);
		if (
			agent &&
			!agent.removedAt &&
			agent.kind === "agent" &&
			agent.ownerId === owner.id &&
			agent.workspaceId === owner.workspaceId
		) {
			const existingHash = await currentKeyHash(env.DB, agent.id);
			if (existingHash) return { actor: agent, keyHash: existingHash };
			const key = newKey();
			const keyHash = await hashKey(key);
			await env.DB.prepare(`INSERT INTO actor_keys (key_hash, actor_id, created_at) VALUES (?1, ?2, ?3)`)
				.bind(keyHash, agent.id, new Date().toISOString())
				.run();
			return { actor: agent, keyHash };
		}
	}
	if ((await countMembers(env.DB, owner.workspaceId, "agent")) >= (await effectiveLimits(env, owner.workspaceId)).agents) {
		return { message: LIMIT_MESSAGE.agents };
	}
	const base = `${tool} for ${owner.name}`.replace(/[\r\n]+/g, " ").trim().slice(0, 80);
	const name = await unusedAgentName(env.DB, owner.workspaceId, base);
	const key = newKey();
	const actor = await registerActor(env.DB, {
		id: newActorId("agent"),
		kind: "agent",
		name,
		workspaceId: owner.workspaceId,
		ownerId: owner.id,
		model: tool,
		key,
	});
	await env.DB.prepare(
		`INSERT INTO oauth_agents (client_id, owner_id, workspace_id, agent_id) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(client_id, owner_id, workspace_id) DO UPDATE SET agent_id = excluded.agent_id`,
	)
		.bind(client, owner.id, owner.workspaceId, actor.id)
		.run();
	return { actor, keyHash: await hashKey(key) };
}

/** The agent's own person, or an Admin revoking it. */
export async function canManageAgent(env: Env, person: Actor, agent: Actor): Promise<boolean> {
	if (person.kind !== "person" || person.removedAt) return false;
	if (agent.kind !== "agent" || agent.removedAt || agent.workspaceId !== person.workspaceId) return false;
	const decision = await authorize(env, person, "revoke-agent", null, { own: agent.ownerId === person.id });
	return decision.ok;
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
	const decision = await authorize(env, owner, "rename-agent", null, { own: agent?.ownerId === owner.id });
	if (!decision.ok) return decision.sentence;
	if (!agent || agent.kind !== "agent" || agent.workspaceId !== owner.workspaceId || agent.ownerId !== owner.id) {
		return "That agent is not yours.";
	}
	await env.DB.prepare(`UPDATE actors SET name = ?1 WHERE id = ?2`).bind(clean, agent.id).run();
	return null;
}

export async function revokeAgentKey(env: Env, owner: Actor, agentId: string): Promise<string | null> {
	const agent = await actorById(env.DB, agentId);
	const decision = await authorize(env, owner, "revoke-agent", null, { own: agent?.ownerId === owner.id });
	if (!decision.ok) return decision.sentence;
	if (!agent || agent.kind !== "agent" || agent.workspaceId !== owner.workspaceId) {
		return "That agent is not in this workspace.";
	}
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
	const agent = await actorById(env.DB, agentId);
	if (!agent || agent.kind !== "agent" || agent.workspaceId !== owner.workspaceId || agent.ownerId !== owner.id) {
		return { message: "That agent is not yours." };
	}
	const decision = await authorize(env, owner, "connect-agent");
	if (!decision.ok) return { message: decision.sentence };
	const key = newKey();
	await revokeOauthGrants(env, agent.id);
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

export async function finishWorkspaceStart(env: Env, email: string, name: string): Promise<{ joined: Joined } | { message: string }> {
	const created = await createWorkspace(env, name);
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
		.bind(created.id, email)
		.run();
	const person = await addPerson(env, created.id, email, undefined, "admin");
	if ("message" in person) return { message: person.message };
	await env.DB.prepare(`UPDATE actors SET role = 'admin' WHERE id = ?1`).bind(person.id).run();
	await env.DB.prepare(`UPDATE workspaces SET owner_id = ?1 WHERE id = ?2 AND owner_id IS NULL`)
		.bind(person.id, created.id)
		.run();
	person.role = "admin";
	created.ownerId = person.id;
	await env.DB.prepare(`UPDATE workspaces SET welcome_pending = 1 WHERE id = ?1`).bind(created.id).run();
	return { joined: { actor: person, workspace: created, secret: await openSession(env.DB, person) } };
}

async function startFromLink(env: Env, link: StoredLink): Promise<{ joined: Joined } | { message: string }> {
	return finishWorkspaceStart(env, link.email, link.workspaceName ?? "");
}

async function inviteFromLink(env: Env, link: StoredLink): Promise<{ joined: Joined } | { message: string }> {
	if (!link.workspaceId) return { message: "That link has expired or was already used." };
	const workspace = await workspaceById(env.DB, link.workspaceId);
	if (!workspace) return { message: "That link has expired or was already used." };
	const waiting = (await pendingInvitations(env.DB, link.email)).find((item) => item.workspaceId === workspace.id);
	const person = await addPerson(env, workspace.id, link.email, undefined, waiting?.role ?? "member");
	if ("message" in person) return { message: person.message };
	if (waiting) {
		await env.DB.prepare(`UPDATE invitations SET accepted_at = ?1 WHERE id = ?2`)
			.bind(new Date().toISOString(), waiting.id)
			.run();
	}
	return { joined: { actor: person, workspace, secret: await openSession(env.DB, person) } };
}

export async function invitePerson(
	env: Env,
	actor: Actor,
	email: string,
	role: Role,
): Promise<{ invitation: Invitation } | { message: string }> {
	const decision = await authorize(env, actor, "invite");
	if (!decision.ok) return { message: decision.sentence };
	const normalized = normalizeEmail(email);
	if (!normalized) return { message: "Enter an email address." };
	const chosen: Role = role === "admin" ? "admin" : "member";
	const already = (await memberships(env.DB, normalized)).find((item) => item.workspace.id === actor.workspaceId);
	if (already) return { message: "That person is already in this workspace." };
	if ((await countMembers(env.DB, actor.workspaceId, "person")) >= (await effectiveLimits(env, actor.workspaceId)).people) {
		return { message: LIMIT_MESSAGE.people };
	}
	const existing = await env.DB.prepare(
		`SELECT id FROM invitations
     WHERE workspace_id = ?1 AND email = ?2 AND cancelled_at IS NULL AND accepted_at IS NULL`,
	)
		.bind(actor.workspaceId, normalized)
		.first<{ id: string }>();
	if (existing) {
		await env.DB.prepare(`UPDATE invitations SET role = ?1 WHERE id = ?2`).bind(chosen, existing.id).run();
	} else {
		await env.DB.prepare(
			`INSERT INTO invitations (id, workspace_id, email, role, invited_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
		)
			.bind(newActorId("person"), actor.workspaceId, normalized, chosen, actor.id, new Date().toISOString())
			.run();
	}
	const invitation = (await pendingInvitations(env.DB, normalized)).find((item) => item.workspaceId === actor.workspaceId);
	if (!invitation) return { message: "The invitation could not be stored." };
	return { invitation };
}

export async function cancelInvitation(env: Env, actor: Actor, invitationId: string): Promise<string | null> {
	const decision = await authorize(env, actor, "invite");
	if (!decision.ok) return decision.sentence;
	const row = await env.DB.prepare(
		`SELECT id FROM invitations WHERE id = ?1 AND workspace_id = ?2 AND cancelled_at IS NULL AND accepted_at IS NULL`,
	)
		.bind(invitationId, actor.workspaceId)
		.first();
	if (!row) return "That invitation is not waiting.";
	await env.DB.prepare(`UPDATE invitations SET cancelled_at = ?1 WHERE id = ?2`)
		.bind(new Date().toISOString(), invitationId)
		.run();
	return null;
}

export async function acceptInvitation(env: Env, email: string, workspaceId: string): Promise<Joined | { message: string }> {
	const waiting = (await pendingInvitations(env.DB, email)).find((item) => item.workspaceId === workspaceId);
	if (!waiting) return { message: "That invitation is not waiting." };
	const workspace = await workspaceById(env.DB, workspaceId);
	if (!workspace) return { message: "That invitation is not waiting." };
	const person = await addPerson(env, workspaceId, email, undefined, waiting.role);
	if ("message" in person) return { message: person.message };
	await env.DB.prepare(`UPDATE invitations SET accepted_at = ?1 WHERE id = ?2`)
		.bind(new Date().toISOString(), waiting.id)
		.run();
	return { actor: person, workspace, secret: await openSession(env.DB, person) };
}

export async function changeRole(env: Env, actor: Actor, personId: string, role: Role): Promise<string | null> {
	const decision = await authorize(env, actor, "change-role", null, { targetId: personId });
	if (!decision.ok) return decision.sentence;
	const person = await actorById(env.DB, personId);
	if (!person || person.kind !== "person" || person.workspaceId !== actor.workspaceId || person.removedAt) {
		return "That person is not in this workspace.";
	}
	const chosen: Role = role === "admin" ? "admin" : "member";
	if (chosen === "member") {
		const admins = await env.DB.prepare(
			`SELECT COUNT(*) AS n FROM actors
       WHERE workspace_id = ?1 AND kind = 'person' AND role = 'admin' AND removed_at IS NULL AND id != ?2`,
		)
			.bind(actor.workspaceId, personId)
			.first<{ n: number }>();
		if ((admins?.n ?? 0) < 1) return "There is always at least one Admin.";
	}
	await env.DB.prepare(`UPDATE actors SET role = ?1 WHERE id = ?2`).bind(chosen, personId).run();
	return null;
}

export async function saveWorkspaceSettings(
	env: Env,
	actor: Actor,
	name: string,
	membersCanPublish: boolean,
): Promise<string | null> {
	const renaming = await authorize(env, actor, "rename-workspace");
	if (!renaming.ok) return renaming.sentence;
	const publishing = await authorize(env, actor, "members-can-publish");
	if (!publishing.ok) return publishing.sentence;
	const clean = cleanWorkspaceName(name);
	if (!clean) return "Give the workspace a short name.";
	await env.DB.prepare(`UPDATE workspaces SET name = ?1, members_can_publish = ?2 WHERE id = ?3`)
		.bind(clean, membersCanPublish ? 1 : 0, actor.workspaceId)
		.run();
	return null;
}

export async function deleteWorkspace(env: Env, actor: Actor, typedName: string): Promise<string | null> {
	const decision = await authorize(env, actor, "delete-workspace");
	if (!decision.ok) return decision.sentence;
	const workspace = await workspaceById(env.DB, actor.workspaceId);
	if (!workspace || typedName.trim() !== workspace.name) return "Type the workspace name to delete it.";
	await deleteWorkspaceRepos(env.WORKSPACE, actor.workspaceId);
	const now = new Date().toISOString();
	const people = await env.DB.prepare(`SELECT id FROM actors WHERE workspace_id = ?1`).bind(actor.workspaceId).all<{ id: string }>();
	for (const person of people.results ?? []) await dropActorAccess(env, person.id);
	await env.DB.prepare(`UPDATE actors SET removed_at = ?1 WHERE workspace_id = ?2 AND removed_at IS NULL`)
		.bind(now, actor.workspaceId)
		.run();
	await env.DB.prepare(`UPDATE workspaces SET deleted_at = ?1 WHERE id = ?2`).bind(now, actor.workspaceId).run();
	return null;
}

export async function noteUsed(env: Env, actorId: string): Promise<void> {
	await env.DB.prepare(`UPDATE actors SET last_used_at = ?1 WHERE id = ?2`).bind(new Date().toISOString(), actorId).run();
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
