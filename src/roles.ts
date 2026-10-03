// Loads a workspace's settings and asks the one permission function.

import { actorById, hashKey, type Actor } from "./actors";
import type { Env } from "./env";
import { limitsOf, type Limits } from "./limits";
import {
	permit,
	type Action,
	type PermitResult,
	type Role,
	type WorkspaceSettings,
} from "./permit";
import { isLibraryName, isSuggestionName } from "./workspace";

export interface WorkspaceState extends WorkspaceSettings {
	id: string;
	name: string;
	ownerId: string | null;
	createdAt: string;
	deletedAt: string | null;
	limitPeople: number | null;
	limitAgents: number | null;
	limitSuggestions: number | null;
}

interface WorkspaceRow {
	id: string;
	name: string;
	owner_id: string | null;
	created_at: string;
	members_can_publish: number;
	suspended: number;
	deleted_at: string | null;
	limit_people: number | null;
	limit_agents: number | null;
	limit_suggestions: number | null;
}

const WORKSPACE_COLUMNS = `id, name, owner_id, created_at, members_can_publish, suspended, deleted_at,
  limit_people, limit_agents, limit_suggestions`;

export function monthKey(now = new Date()): string {
	return now.toISOString().slice(0, 7);
}

export async function workspaceState(db: D1Database, id: string): Promise<WorkspaceState | null> {
	const row = await db.prepare(`SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = ?1`).bind(id).first<WorkspaceRow>();
	if (!row || row.deleted_at) return null;
	return {
		id: row.id,
		name: row.name,
		ownerId: row.owner_id,
		createdAt: row.created_at,
		membersCanPublish: row.members_can_publish === 1,
		suspended: row.suspended === 1,
		deletedAt: row.deleted_at,
		limitPeople: row.limit_people,
		limitAgents: row.limit_agents,
		limitSuggestions: row.limit_suggestions,
	};
}

export async function effectiveLimits(env: Env, workspaceId: string): Promise<Limits> {
	const base = limitsOf(env);
	const state = await workspaceState(env.DB, workspaceId);
	if (!state) return base;
	return {
		...base,
		people: state.limitPeople ?? base.people,
		agents: state.limitAgents ?? base.agents,
		openSuggestions: state.limitSuggestions ?? base.openSuggestions,
	};
}

export async function personRole(db: D1Database, actor: Actor): Promise<Role> {
	if (actor.kind === "agent") {
		if (!actor.ownerId) return "member";
		const owner = await actorById(db, actor.ownerId);
		if (!owner || owner.removedAt) return "member";
		return owner.role === "admin" ? "admin" : "member";
	}
	return actor.role === "admin" ? "admin" : "member";
}

export async function pageLocked(db: D1Database, workspaceId: string, path: string): Promise<boolean> {
	const row = await db
		.prepare(`SELECT path FROM locked_pages WHERE workspace_id = ?1 AND path = ?2`)
		.bind(workspaceId, path)
		.first();
	return Boolean(row);
}

export async function anyPageLocked(db: D1Database, workspaceId: string): Promise<boolean> {
	const row = await db
		.prepare(`SELECT path FROM locked_pages WHERE workspace_id = ?1 LIMIT 1`)
		.bind(workspaceId)
		.first();
	return Boolean(row);
}

export async function lockedPaths(db: D1Database, workspaceId: string): Promise<string[]> {
	const rows = await db
		.prepare(`SELECT path FROM locked_pages WHERE workspace_id = ?1 ORDER BY path`)
		.bind(workspaceId)
		.all<{ path: string }>();
	return (rows.results ?? []).map((row) => row.path);
}

export async function authorize(
	env: Env,
	actor: Actor,
	action: Action,
	path?: string | null,
	extra?: { targetId?: string; own?: boolean },
): Promise<PermitResult> {
	const state = await workspaceState(env.DB, actor.workspaceId);
	if (!state) return { ok: false, sentence: "That workspace is not here." };
	if (actor.kind === "agent" && actor.ownerId) {
		const owner = await actorById(env.DB, actor.ownerId);
		if (!owner || owner.removedAt) return { ok: false, sentence: "That agent is not in this workspace." };
	}
	const role = await personRole(env.DB, actor);
	let locked = false;
	if (path && (action === "publish" || action === "keep" || action === "combine" || action === "decline" || action === "lock" || action === "unlock")) {
		locked = await pageLocked(env.DB, actor.workspaceId, path);
	} else if (!path && (action === "publish" || action === "keep" || action === "combine" || action === "decline") && role !== "admin") {
		locked = await anyPageLocked(env.DB, actor.workspaceId);
	}
	const targetId = extra?.targetId;
	return permit({
		actor,
		role,
		action,
		path,
		settings: state,
		locked,
		starter: state.ownerId === actor.id,
		targetStarter: Boolean(targetId && state.ownerId === targetId),
		own: extra?.own ?? false,
	});
}

/**
 * A library write is a publish. A write to a suggestion copy is a suggest,
 * so suspension, a removed owner, and a deleted workspace apply there too.
 */
export async function authorizeRepo(
	env: Env,
	actor: Actor,
	repoName: string,
	write: boolean,
): Promise<PermitResult> {
	if (!write) return { ok: true };
	if (isLibraryName(repoName)) return authorize(env, actor, "publish");
	if (isSuggestionName(repoName)) return authorize(env, actor, "suggest");
	return { ok: true };
}

export async function setPageLock(env: Env, actor: Actor, path: string, lock: boolean): Promise<string | null> {
	const decision = await authorize(env, actor, lock ? "lock" : "unlock", path);
	if (!decision.ok) return decision.sentence;
	if (lock) {
		await env.DB.prepare(
			`INSERT INTO locked_pages (workspace_id, path, locked_by, locked_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(workspace_id, path) DO UPDATE SET locked_by = excluded.locked_by, locked_at = excluded.locked_at`,
		)
			.bind(actor.workspaceId, path, actor.id, new Date().toISOString())
			.run();
	} else {
		await env.DB.prepare(`DELETE FROM locked_pages WHERE workspace_id = ?1 AND path = ?2`)
			.bind(actor.workspaceId, path)
			.run();
	}
	return null;
}

export async function recordSignIn(db: D1Database, email: string): Promise<void> {
	await db
		.prepare(`INSERT OR IGNORE INTO sign_ins (email_hash, month) VALUES (?1, ?2)`)
		.bind(await hashKey(email), monthKey())
		.run();
}

export async function signInCount(db: D1Database, month = monthKey()): Promise<number> {
	const row = await db.prepare(`SELECT COUNT(*) AS n FROM sign_ins WHERE month = ?1`).bind(month).first<{ n: number }>();
	return row?.n ?? 0;
}

export interface Invitation {
	id: string;
	workspaceId: string;
	workspaceName: string;
	email: string;
	role: Role;
	createdAt: string;
}

export async function pendingInvitations(db: D1Database, email: string): Promise<Invitation[]> {
	const rows = await db
		.prepare(
			`SELECT i.id, i.workspace_id, w.name AS workspace_name, i.email, i.role, i.created_at
       FROM invitations i
       JOIN workspaces w ON w.id = i.workspace_id
       WHERE i.email = ?1 AND i.cancelled_at IS NULL AND i.accepted_at IS NULL AND w.deleted_at IS NULL
       ORDER BY i.created_at`,
		)
		.bind(email)
		.all<{ id: string; workspace_id: string; workspace_name: string; email: string; role: string; created_at: string }>();
	return (rows.results ?? []).map((row) => ({
		id: row.id,
		workspaceId: row.workspace_id,
		workspaceName: row.workspace_name,
		email: row.email,
		role: row.role === "admin" ? "admin" : "member",
		createdAt: row.created_at,
	}));
}

export async function invitationsForWorkspace(db: D1Database, workspaceId: string): Promise<Invitation[]> {
	const rows = await db
		.prepare(
			`SELECT i.id, i.workspace_id, w.name AS workspace_name, i.email, i.role, i.created_at
       FROM invitations i
       JOIN workspaces w ON w.id = i.workspace_id
       WHERE i.workspace_id = ?1 AND i.cancelled_at IS NULL AND i.accepted_at IS NULL
       ORDER BY i.created_at`,
		)
		.bind(workspaceId)
		.all<{ id: string; workspace_id: string; workspace_name: string; email: string; role: string; created_at: string }>();
	return (rows.results ?? []).map((row) => ({
		id: row.id,
		workspaceId: row.workspace_id,
		workspaceName: row.workspace_name,
		email: row.email,
		role: row.role === "admin" ? "admin" : "member",
		createdAt: row.created_at,
	}));
}

export function serviceAdminEmails(env: Env): Set<string> {
	return new Set(
		(env.SERVICE_ADMINS ?? "")
			.split(",")
			.map((item) => item.trim().toLowerCase())
			.filter((item) => item.includes("@")),
	);
}

export function isServiceAdmin(env: Env, email: string): boolean {
	return serviceAdminEmails(env).has(email.trim().toLowerCase());
}
