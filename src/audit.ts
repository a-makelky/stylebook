// The Git route records each accepted push. The arrival Workflow confirms the
// row from the push event, matching repo + ref + edition, never the clock.
// A push event with no gateway row is a push the route did not see.

import type { Actor } from "./actors";

export interface GatewayPush {
	repoName: string;
	refName: string;
	editionId: string;
	actorId: string;
	actorName: string;
	actorKind: string;
	ownerId: string;
	ownerName: string;
	model: string | null;
	acceptedAt: string;
	confirmedAt: string | null;
}

export interface UnseenPush {
	repoName: string;
	refName: string;
	editionId: string;
	flaggedAt: string;
}

export interface AuditSnapshot {
	gateway: GatewayPush[];
	unseen: UnseenPush[];
}

interface GatewayRow {
	repo_name: string;
	ref_name: string;
	edition_id: string;
	actor_id: string;
	actor_name: string;
	actor_kind: string;
	owner_id: string;
	owner_name: string;
	model: string | null;
	accepted_at: string;
	confirmed_at: string | null;
}

function toGateway(row: GatewayRow): GatewayPush {
	return {
		repoName: row.repo_name,
		refName: row.ref_name,
		editionId: row.edition_id,
		actorId: row.actor_id,
		actorName: row.actor_name,
		actorKind: row.actor_kind,
		ownerId: row.owner_id,
		ownerName: row.owner_name,
		model: row.model,
		acceptedAt: row.accepted_at,
		confirmedAt: row.confirmed_at,
	};
}

export async function recordPush(
	db: D1Database,
	input: {
		repoName: string;
		refName: string;
		editionId: string;
		actor: Actor;
		owner: Actor;
		acceptedAt: string;
	},
): Promise<void> {
	await db
		.prepare(
			`INSERT OR IGNORE INTO gateway_pushes
        (repo_name, ref_name, edition_id, actor_id, actor_name, actor_kind, owner_id, owner_name, model, accepted_at, workspace_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
		)
		.bind(
			input.repoName,
			input.refName,
			input.editionId,
			input.actor.id,
			input.actor.name,
			input.actor.kind,
			input.owner.id,
			input.owner.name,
			input.actor.model,
			input.acceptedAt,
			input.actor.workspaceId,
		)
		.run();
}

export type ReconcileResult = "confirmed" | "flagged" | "pending";

/**
 * Match one push event to a gateway row. `final` is the last try: only then
 * is a missing row flagged, so a slow gateway write is not called a bypass.
 */
export async function reconcilePush(
	db: D1Database,
	repoName: string,
	refName: string,
	editionId: string,
	now: string,
	final: boolean,
): Promise<ReconcileResult> {
	const found = await db
		.prepare(
			`SELECT id FROM gateway_pushes WHERE repo_name = ?1 AND ref_name = ?2 AND edition_id = ?3`,
		)
		.bind(repoName, refName, editionId)
		.first();
	if (found) {
		await db
			.prepare(
				`INSERT OR IGNORE INTO push_confirmations
          (repo_name, ref_name, edition_id, confirmed_at)
         VALUES (?1, ?2, ?3, ?4)`,
			)
			.bind(repoName, refName, editionId, now)
			.run();
		return "confirmed";
	}
	if (!final) return "pending";
	await db
		.prepare(
			`INSERT OR IGNORE INTO unseen_pushes (repo_name, ref_name, edition_id, flagged_at)
       VALUES (?1, ?2, ?3, ?4)`,
		)
		.bind(repoName, refName, editionId, now)
		.run();
	return "flagged";
}

const GATEWAY_SINCE = `SELECT g.repo_name, g.ref_name, g.edition_id, g.actor_id, g.actor_name, g.actor_kind,
            g.owner_id, g.owner_name, g.model, g.accepted_at, c.confirmed_at
     FROM gateway_pushes g
     LEFT JOIN push_confirmations c
       ON c.repo_name = g.repo_name AND c.ref_name = g.ref_name AND c.edition_id = g.edition_id
     WHERE g.accepted_at >= ?1
     ORDER BY g.id`;

const UNSEEN_SINCE = `SELECT u.repo_name, u.ref_name, u.edition_id, u.flagged_at
     FROM unseen_pushes u
     WHERE u.flagged_at >= ?1
       AND NOT EXISTS (
         SELECT 1 FROM gateway_pushes g
         WHERE g.repo_name = u.repo_name AND g.ref_name = u.ref_name AND g.edition_id = u.edition_id
       )
     ORDER BY u.flagged_at`;

export async function auditSince(db: D1Database, since: string): Promise<AuditSnapshot> {
	const gateway = await db.prepare(GATEWAY_SINCE).bind(since).all<GatewayRow>();
	const unseen = await db
		.prepare(UNSEEN_SINCE)
		.bind(since)
		.all<{ repo_name: string; ref_name: string; edition_id: string; flagged_at: string }>();
	return {
		gateway: (gateway.results ?? []).map(toGateway),
		unseen: (unseen.results ?? []).map((row) => ({
			repoName: row.repo_name,
			refName: row.ref_name,
			editionId: row.edition_id,
			flaggedAt: row.flagged_at,
		})),
	};
}

export interface RecentCopy {
	id: number;
	repoName: string;
	editionId: string;
	acceptedAt: string;
	actorId: string;
	actorName: string;
	ownerName: string;
}

/**
 * Newest suggestion copies the Git route has accepted, one row per copy.
 * `before` is the last row already shown, as `acceptedAt|id`.
 */
export async function recentCopies(
	db: D1Database,
	workspaceId: string,
	before: string | null,
	limit: number,
): Promise<RecentCopy[]> {
	const split = before?.split("|") ?? [];
	const beforeAt = split[0] || null;
	const beforeId = Number(split[1] ?? "0");
	const hasCursor = Boolean(beforeAt) && Number.isFinite(beforeId);
	const like = `${workspaceId}-sug-%`;
	const statement = hasCursor
		? db
				.prepare(
					`SELECT g.id, g.repo_name, g.edition_id, g.accepted_at, g.actor_id, g.actor_name, g.owner_name
           FROM gateway_pushes g
           INNER JOIN (
             SELECT repo_name, MAX(id) AS id
             FROM gateway_pushes
             WHERE ref_name = 'refs/heads/main' AND workspace_id = ?1 AND repo_name LIKE ?2
             GROUP BY repo_name
           ) latest ON latest.id = g.id
           WHERE g.accepted_at < ?3 OR (g.accepted_at = ?4 AND g.id < ?5)
           ORDER BY g.accepted_at DESC, g.id DESC
           LIMIT ?6`,
				)
				.bind(workspaceId, like, beforeAt, beforeAt, beforeId, limit)
		: db
				.prepare(
					`SELECT g.id, g.repo_name, g.edition_id, g.accepted_at, g.actor_id, g.actor_name, g.owner_name
           FROM gateway_pushes g
           INNER JOIN (
             SELECT repo_name, MAX(id) AS id
             FROM gateway_pushes
             WHERE ref_name = 'refs/heads/main' AND workspace_id = ?1 AND repo_name LIKE ?2
             GROUP BY repo_name
           ) latest ON latest.id = g.id
           ORDER BY g.accepted_at DESC, g.id DESC
           LIMIT ?3`,
				)
				.bind(workspaceId, like, limit);
	const rows = await statement.all<{
		id: number;
		repo_name: string;
		edition_id: string;
		accepted_at: string;
		actor_id: string;
		actor_name: string;
		owner_name: string;
	}>();
	return (rows.results ?? []).map((row) => ({
		id: row.id,
		repoName: row.repo_name,
		editionId: row.edition_id,
		acceptedAt: row.accepted_at,
		actorId: row.actor_id,
		actorName: row.actor_name,
		ownerName: row.owner_name,
	}));
}

export function copyCursor(row: Pick<RecentCopy, "acceptedAt" | "id">): string {
	return `${row.acceptedAt}|${row.id}`;
}

export async function pushForEdition(
	db: D1Database,
	editionId: string,
	workspaceId?: string,
): Promise<GatewayPush | null> {
	const row = await db
		.prepare(
			`SELECT g.repo_name, g.ref_name, g.edition_id, g.actor_id, g.actor_name, g.actor_kind,
              g.owner_id, g.owner_name, g.model, g.accepted_at, c.confirmed_at
       FROM gateway_pushes g
       LEFT JOIN push_confirmations c
         ON c.repo_name = g.repo_name AND c.ref_name = g.ref_name AND c.edition_id = g.edition_id
       WHERE g.edition_id = ?1
         AND (?2 IS NULL OR g.workspace_id = ?2)
       ORDER BY CASE g.ref_name WHEN 'refs/heads/main' THEN 0 ELSE 1 END, g.id DESC
       LIMIT 1`,
		)
		.bind(editionId, workspaceId ?? null)
		.first<GatewayRow>();
	return row ? toGateway(row) : null;
}

export async function isUnseen(
	db: D1Database,
	repoName: string,
	refName: string,
	editionId: string,
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS found FROM unseen_pushes u
       WHERE u.repo_name = ?1 AND u.ref_name = ?2 AND u.edition_id = ?3
         AND NOT EXISTS (
           SELECT 1 FROM gateway_pushes g
           WHERE g.repo_name = u.repo_name AND g.ref_name = u.ref_name AND g.edition_id = u.edition_id
         )`,
		)
		.bind(repoName, refName, editionId)
		.first();
	return Boolean(row);
}
