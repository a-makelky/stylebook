// Workspace audit rows and the saved backup link. The secret column is ciphertext.

import { hashKey, type Actor } from "./actors";

export type MirrorKind = "github" | "other";

export interface MirrorRow {
	kind: MirrorKind;
	address: string;
	tokenCipher: string | null;
	installationId: string | null;
	login: string | null;
	keepCurrent: boolean;
	lastOkAt: string | null;
	lastError: string | null;
	updatedAt: string;
}

interface MirrorSql {
	kind: string;
	address: string;
	token_cipher: string | null;
	github_installation_id: string | null;
	login: string | null;
	keep_current: number;
	last_ok_at: string | null;
	last_error: string | null;
	updated_at: string;
}

function fromRow(row: MirrorSql): MirrorRow {
	return {
		kind: row.kind === "github" ? "github" : "other",
		address: row.address,
		tokenCipher: row.token_cipher,
		installationId: row.github_installation_id,
		login: row.login,
		keepCurrent: row.keep_current === 1,
		lastOkAt: row.last_ok_at,
		lastError: row.last_error,
		updatedAt: row.updated_at,
	};
}

const MIRROR_COLUMNS = `kind, address, token_cipher, github_installation_id, login, keep_current, last_ok_at, last_error, updated_at`;

export async function readMirror(db: D1Database, workspaceId: string, kind: MirrorKind): Promise<MirrorRow | null> {
	const row = await db
		.prepare(`SELECT ${MIRROR_COLUMNS} FROM backup_mirrors WHERE workspace_id = ?1 AND kind = ?2`)
		.bind(workspaceId, kind)
		.first<MirrorSql>();
	return row ? fromRow(row) : null;
}

export async function keptMirrors(db: D1Database, workspaceId: string): Promise<MirrorRow[]> {
	const rows = await db
		.prepare(
			`SELECT ${MIRROR_COLUMNS} FROM backup_mirrors
       WHERE workspace_id = ?1 AND keep_current = 1 AND address != ''`,
		)
		.bind(workspaceId)
		.all<MirrorSql>();
	return (rows.results ?? []).map(fromRow);
}

export async function saveMirror(
	db: D1Database,
	workspaceId: string,
	row: {
		kind: MirrorKind;
		address: string;
		tokenCipher: string | null;
		installationId: string | null;
		login: string | null;
		keepCurrent: boolean;
	},
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.prepare(
			`INSERT INTO backup_mirrors
        (workspace_id, kind, address, token_cipher, github_installation_id, login, keep_current, last_ok_at, last_error, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, ?8)
       ON CONFLICT(workspace_id, kind) DO UPDATE SET
         address = excluded.address,
         token_cipher = excluded.token_cipher,
         github_installation_id = excluded.github_installation_id,
         login = excluded.login,
         keep_current = excluded.keep_current,
         last_error = NULL,
         updated_at = excluded.updated_at`,
		)
		.bind(
			workspaceId,
			row.kind,
			row.address,
			row.tokenCipher,
			row.installationId,
			row.login,
			row.keepCurrent ? 1 : 0,
			now,
		)
		.run();
}

export async function setMirrorKeep(db: D1Database, workspaceId: string, kind: MirrorKind, keep: boolean): Promise<void> {
	await db
		.prepare(`UPDATE backup_mirrors SET keep_current = ?1, updated_at = ?2 WHERE workspace_id = ?3 AND kind = ?4`)
		.bind(keep ? 1 : 0, new Date().toISOString(), workspaceId, kind)
		.run();
}

export async function markMirror(
	db: D1Database,
	workspaceId: string,
	kind: MirrorKind,
	result: { ok: true; at: string } | { ok: false; sentence: string },
): Promise<void> {
	if (result.ok) {
		await db
			.prepare(
				`UPDATE backup_mirrors SET last_ok_at = ?1, last_error = NULL, updated_at = ?1
         WHERE workspace_id = ?2 AND kind = ?3`,
			)
			.bind(result.at, workspaceId, kind)
			.run();
		return;
	}
	await db
		.prepare(`UPDATE backup_mirrors SET last_error = ?1, updated_at = ?2 WHERE workspace_id = ?3 AND kind = ?4`)
		.bind(result.sentence, new Date().toISOString(), workspaceId, kind)
		.run();
}

export async function removeMirror(db: D1Database, workspaceId: string, kind: MirrorKind): Promise<void> {
	await db.prepare(`DELETE FROM backup_mirrors WHERE workspace_id = ?1 AND kind = ?2`).bind(workspaceId, kind).run();
}

export async function writeAudit(db: D1Database, actor: Actor, action: string, detail: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO workspace_audit (workspace_id, actor_id, actor_name, action, detail, at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
		)
		.bind(actor.workspaceId, actor.id, actor.name, action, detail, new Date().toISOString())
		.run();
}

export async function saveGithubState(db: D1Database, state: string, actor: Actor): Promise<void> {
	const now = new Date().toISOString();
	await db
		.prepare(`INSERT INTO backup_states (state_hash, workspace_id, actor_id, created_at) VALUES (?1, ?2, ?3, ?4)`)
		.bind(await hashKey(state), actor.workspaceId, actor.id, now)
		.run();
}

/** Take a state once. States older than 15 minutes are ignored. */
export async function takeGithubState(
	db: D1Database,
	state: string,
	actor: Actor,
): Promise<boolean> {
	const row = await db
		.prepare(`SELECT workspace_id, actor_id, created_at FROM backup_states WHERE state_hash = ?1`)
		.bind(await hashKey(state))
		.first<{ workspace_id: string; actor_id: string; created_at: string }>();
	await db.prepare(`DELETE FROM backup_states WHERE state_hash = ?1`).bind(await hashKey(state)).run();
	if (!row || row.workspace_id !== actor.workspaceId || row.actor_id !== actor.id) return false;
	return Date.now() - Date.parse(row.created_at) < 15 * 60 * 1000;
}
