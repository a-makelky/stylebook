// One visitor, one copy of the Demo workspace. fork() keeps the copy in the
// same namespace and records where it came from.
// https://developers.cloudflare.com/artifacts/api/workers-binding/
// https://developers.cloudflare.com/artifacts/concepts/best-practices/
//
// Copies last 24 hours. A Cron Trigger deletes them.
// https://developers.cloudflare.com/workers/configuration/cron-triggers/
// https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
//
// Their Artifacts calls are counted in the same usage table as a team.
// https://developers.cloudflare.com/artifacts/platform/pricing/

import { registerActor } from "./actors";
import { seedOpenSuggestions, seededSuggestionNames } from "./demo-seed";
import type { Env } from "./env";
import { LIMIT_MESSAGE, limitsOf } from "./limits";
import { describeError } from "./redact";
import { openSession } from "./teams";
import { trackUsage } from "./usage";
import { deleteWorkspaceRepos, errorCode, getRepo, libraryName, REPO_NAME_LIMIT } from "./workspace";

export const DEMO_SOURCE_ID = "demo";
const DEMO_TTL_MS = 24 * 60 * 60 * 1000;

export interface OpenedDemo {
	secret: string;
	workspaceId: string;
}

function randomKey(): string {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function demoWorkspaceId(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
	const bytes = new Uint8Array(7);
	crypto.getRandomValues(bytes);
	let id = "d";
	for (const byte of bytes) id += alphabet[byte % alphabet.length]!;
	return id;
}

function utcDayStart(now = new Date()): string {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/** The seeded suggestion repos, renamed into the visitor's workspace. */
export function demoDestRepo(workspaceId: string, sourceName: string): string | null {
	if (sourceName === libraryName(DEMO_SOURCE_ID)) return libraryName(workspaceId);
	const prefix = `${DEMO_SOURCE_ID}-sug-`;
	if (!sourceName.startsWith(prefix)) return null;
	if (!seededSuggestionNames(DEMO_SOURCE_ID).includes(sourceName)) return null;
	const name = `${workspaceId}-sug-${sourceName.slice(prefix.length)}`;
	return name.length <= REPO_NAME_LIMIT ? name : null;
}

async function demoCopiesToday(env: Env, now: Date): Promise<number> {
	const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM demo_copies WHERE created_at >= ?1`)
		.bind(utcDayStart(now))
		.first<{ n: number }>();
	return row?.n ?? 0;
}

async function ensureDemoSource(env: Env, origin: string): Promise<void> {
	const library = await getRepo(env.WORKSPACE, libraryName(DEMO_SOURCE_ID));
	const seeded = await Promise.all(
		seededSuggestionNames(DEMO_SOURCE_ID).map((name) => getRepo(env.WORKSPACE, name)),
	);
	if (library && seeded.every(Boolean)) return;
	await seedOpenSuggestions(env, origin, {
		personKey: randomKey(),
		researcherKey: randomKey(),
		proofreaderKey: randomKey(),
		workspaceId: DEMO_SOURCE_ID,
		workspaceName: "Demo",
	});
}

async function forkSeeded(workspace: Artifacts, workspaceId: string): Promise<void> {
	const library = await getRepo(workspace, libraryName(DEMO_SOURCE_ID));
	if (!library) throw new Error("The demo library is not ready.");
	const jobs: Promise<unknown>[] = [
		library.fork(libraryName(workspaceId), {
			description: "Demo copy of the library",
			defaultBranchOnly: true,
		}),
	];
	for (const sourceName of seededSuggestionNames(DEMO_SOURCE_ID)) {
		const dest = demoDestRepo(workspaceId, sourceName);
		if (!dest) continue;
		jobs.push(
			(async () => {
				const repo = await getRepo(workspace, sourceName);
				if (!repo) return;
				await repo.fork(dest, {
					description: "Demo copy of a suggestion",
					defaultBranchOnly: true,
				});
			})(),
		);
	}
	await Promise.all(jobs);
	await getRepo(workspace, libraryName(workspaceId));
	await Promise.all(
		seededSuggestionNames(DEMO_SOURCE_ID).map(async (sourceName) => {
			const dest = demoDestRepo(workspaceId, sourceName);
			if (dest) await getRepo(workspace, dest);
		}),
	);
}

async function copyPushes(db: D1Database, workspaceId: string): Promise<void> {
	const rows = await db
		.prepare(
			`SELECT repo_name, ref_name, edition_id, actor_id, actor_name, actor_kind,
              owner_id, owner_name, model, accepted_at
       FROM gateway_pushes
       WHERE workspace_id = ?1 AND (repo_name = ?2 OR repo_name LIKE ?3)`,
		)
		.bind(DEMO_SOURCE_ID, libraryName(DEMO_SOURCE_ID), `${DEMO_SOURCE_ID}-sug-%`)
		.all<{
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
		}>();
	for (const row of rows.results ?? []) {
		const dest = demoDestRepo(workspaceId, row.repo_name);
		if (!dest) continue;
		await db
			.prepare(
				`INSERT OR IGNORE INTO gateway_pushes
          (repo_name, ref_name, edition_id, actor_id, actor_name, actor_kind, owner_id, owner_name, model, accepted_at, workspace_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
			)
			.bind(
				dest,
				row.ref_name,
				row.edition_id,
				row.actor_id,
				row.actor_name,
				row.actor_kind,
				row.owner_id,
				row.owner_name,
				row.model,
				row.accepted_at,
				workspaceId,
			)
			.run();
	}
}

async function purgeDemoRows(db: D1Database, workspaceId: string): Promise<void> {
	const actors = await db
		.prepare(`SELECT id FROM actors WHERE workspace_id = ?1`)
		.bind(workspaceId)
		.all<{ id: string }>();
	for (const actor of actors.results ?? []) {
		await db.prepare(`DELETE FROM actor_keys WHERE actor_id = ?1`).bind(actor.id).run();
		await db.prepare(`DELETE FROM sessions WHERE actor_id = ?1`).bind(actor.id).run();
		await db.prepare(`DELETE FROM declines WHERE actor_id = ?1`).bind(actor.id).run();
		await db.prepare(`DELETE FROM access_grants WHERE actor_id = ?1`).bind(actor.id).run();
	}
	await db.prepare(`DELETE FROM oauth_agents WHERE workspace_id = ?1`).bind(workspaceId).run();
	await db.prepare(`DELETE FROM actors WHERE workspace_id = ?1`).bind(workspaceId).run();
	await db.prepare(`DELETE FROM gateway_pushes WHERE workspace_id = ?1`).bind(workspaceId).run();
	await db.prepare(`DELETE FROM invitations WHERE workspace_id = ?1`).bind(workspaceId).run();
	await db.prepare(`DELETE FROM locked_pages WHERE workspace_id = ?1`).bind(workspaceId).run();
	await db.prepare(`DELETE FROM workspace_operations WHERE workspace_id = ?1`).bind(workspaceId).run();
	await db.prepare(`DELETE FROM workspace_operation_months WHERE workspace_id = ?1`).bind(workspaceId).run();
	await db.prepare(`DELETE FROM demo_copies WHERE workspace_id = ?1`).bind(workspaceId).run();
	await db.prepare(`DELETE FROM workspaces WHERE id = ?1`).bind(workspaceId).run();
}

/** Delete one visitor copy. The shared Demo workspace is never deleted here. */
export async function deleteDemoCopy(env: Env, workspaceId: string): Promise<void> {
	if (workspaceId === DEMO_SOURCE_ID || !/^[a-z][a-z0-9]{2,15}$/.test(workspaceId)) return;
	const row = await env.DB.prepare(`SELECT workspace_id FROM demo_copies WHERE workspace_id = ?1`)
		.bind(workspaceId)
		.first();
	if (!row) return;
	try {
		await deleteWorkspaceRepos(env.WORKSPACE, workspaceId);
	} catch (error) {
		if (errorCode(error) !== "NOT_FOUND") throw error;
	}
	await purgeDemoRows(env.DB, workspaceId);
}

/** Delete every demo copy whose 24 hours are up. Returns how many were removed. */
export async function deleteExpiredDemos(env: Env, now = new Date()): Promise<number> {
	const due = await env.DB.prepare(`SELECT workspace_id FROM demo_copies WHERE expires_at <= ?1`)
		.bind(now.toISOString())
		.all<{ workspace_id: string }>();
	let deleted = 0;
	let failed = 0;
	for (const row of due.results ?? []) {
		try {
			await deleteDemoCopy(env, row.workspace_id);
			deleted += 1;
		} catch (error) {
			failed += 1;
			const failure = describeError(error);
			console.error(failure.code, failure.message);
		}
	}
	if (failed > 0) throw new Error("A demo copy could not be deleted.");
	return deleted;
}

/**
 * Sign the visitor in as Editor, an Admin, on a new copy of the Demo workspace.
 * No email and no Cloudflare Access. Operations are counted on this copy.
 */
export async function createDemoCopy(env: Env, origin: string, now = new Date()): Promise<OpenedDemo | { message: string }> {
	const limit = limitsOf(env).demoCopiesPerDay;
	if ((await demoCopiesToday(env, now)) >= limit) return { message: LIMIT_MESSAGE.demo };
	await ensureDemoSource(env, origin);

	let workspaceId = "";
	for (let attempt = 0; attempt < 5; attempt++) {
		const id = demoWorkspaceId();
		const taken = await env.DB.prepare(`SELECT id FROM workspaces WHERE id = ?1`).bind(id).first();
		if (!taken) {
			workspaceId = id;
			break;
		}
	}
	if (!workspaceId) return { message: "The demo could not be opened. Try again." };

	const createdAt = now.toISOString();
	const expiresAt = new Date(now.getTime() + DEMO_TTL_MS).toISOString();
	await env.DB.prepare(
		`INSERT INTO workspaces (id, name, created_at, welcome_pending) VALUES (?1, 'Demo', ?2, 0)`,
	)
		.bind(workspaceId, createdAt)
		.run();
	await env.DB.prepare(`INSERT INTO demo_copies (workspace_id, created_at, expires_at) VALUES (?1, ?2, ?3)`)
		.bind(workspaceId, createdAt, expiresAt)
		.run();

	const tracked = trackUsage(env.WORKSPACE, env.DB, workspaceId);
	const counted: Env = { ...env, WORKSPACE: tracked.binding };
	try {
		await forkSeeded(counted.WORKSPACE, workspaceId);
		await copyPushes(env.DB, workspaceId);
		const editor = await registerActor(env.DB, {
			id: `${workspaceId}editor`,
			kind: "person",
			name: "Editor",
			workspaceId,
			role: "admin",
			key: randomKey(),
		});
		await registerActor(env.DB, {
			id: `${workspaceId}researcher`,
			kind: "agent",
			name: "Researcher",
			workspaceId,
			ownerId: editor.id,
			model: "researcher",
			key: randomKey(),
		});
		await registerActor(env.DB, {
			id: `${workspaceId}proofreader`,
			kind: "agent",
			name: "Proofreader",
			workspaceId,
			ownerId: editor.id,
			model: "proofreader",
			key: randomKey(),
		});
		const secret = await openSession(env.DB, editor);
		await tracked.flush();
		return { secret, workspaceId };
	} catch (error) {
		await tracked.flush().catch(() => {});
		await deleteDemoCopy(env, workspaceId).catch(() => {});
		throw error;
	}
}
