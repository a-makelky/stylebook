// A short-lived credential for one copy. Git clients send it as the password.
// The route checks it, then mints the repo token Artifacts expects.
// https://developers.cloudflare.com/artifacts/api/git-protocol/
// https://developers.cloudflare.com/artifacts/concepts/best-practices/

import { actorById, actorByKey, allows, hashKey, refusal, type Actor } from "./actors";
import type { Env } from "./env";
import { getRepo, libraryName } from "./workspace";

export interface Grant {
	actor: Actor;
	repoName: string;
	canWrite: boolean;
	expiresAt: string;
}

function randomToken(write: boolean): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${write ? "sbw" : "sbr"}_${hex}`;
}

/** Store a credential for one actor and one copy. The plaintext is not stored. */
export async function issueGrant(
	db: D1Database,
	actor: Actor,
	repoName: string,
	canWrite: boolean,
	ttlSeconds: number,
): Promise<string> {
	const token = randomToken(canWrite);
	const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
	await db
		.prepare(
			`INSERT INTO access_grants (token_hash, actor_id, repo_name, can_write, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
		)
		.bind(await hashKey(token), actor.id, repoName, canWrite ? 1 : 0, expiresAt)
		.run();
	return token;
}

export async function grantByToken(db: D1Database, token: string): Promise<Grant | null> {
	const row = await db
		.prepare(
			`SELECT actor_id, repo_name, can_write, expires_at
       FROM access_grants WHERE token_hash = ?1`,
		)
		.bind(await hashKey(token))
		.first<{ actor_id: string; repo_name: string; can_write: number; expires_at: string }>();
	if (!row) return null;
	if (Date.parse(row.expires_at) <= Date.now()) return null;
	const actor = await actorById(db, row.actor_id);
	if (!actor) return null;
	return {
		actor,
		repoName: row.repo_name,
		canWrite: row.can_write === 1,
		expiresAt: row.expires_at,
	};
}

export async function handleAccess(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json({ ok: false, error: "Use POST." }, { status: 405 });
	}
	const header = request.headers.get("Authorization") ?? "";
	const key = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
	if (!key) return Response.json({ ok: false, error: "Missing or unknown key." }, { status: 401 });
	const actor = await actorByKey(env.DB, key);
	if (!actor) return Response.json({ ok: false, error: "Missing or unknown key." }, { status: 401 });

	const body = (await request.json().catch(() => ({}))) as { name?: unknown; write?: unknown };
	const name = typeof body.name === "string" && body.name ? body.name : libraryName(actor.workspaceId);
	const write = body.write === true;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name)) {
		return Response.json({ ok: false, error: "That name is not a copy in the workspace." }, { status: 400 });
	}
	if (!allows(actor, name, write)) {
		return Response.json({ ok: false, error: refusal(name, write) }, { status: 403 });
	}

	const repo = await getRepo(env.WORKSPACE, name);
	if (!repo) return Response.json({ ok: false, error: "That copy does not exist." }, { status: 404 });

	const ttlSeconds = write ? 300 : 600;
	const token = await issueGrant(env.DB, actor, name, write, ttlSeconds);
	const origin = new URL(request.url).origin;
	// The remote is the Stylebook Git route. The Artifacts remote stays inside the Worker.
	return Response.json({
		ok: true,
		remote: `${origin.replace(/\/$/, "")}/git/${name}.git`,
		username: "stylebook",
		token,
		write,
		expiresIn: ttlSeconds,
	});
}
