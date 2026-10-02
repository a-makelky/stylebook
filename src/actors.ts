// People and agents. A Stylebook key is stored only as a SHA-256 hash.
// Attribution uses the actor that owns the key, not the name a client types.

import { isLibraryName, ownsCopy, repoInWorkspace } from "./workspace";

export type ActorKind = "person" | "agent";

export interface Actor {
	id: string;
	kind: ActorKind;
	name: string;
	ownerId: string | null;
	model: string | null;
	workspaceId: string;
	email: string | null;
	removedAt: string | null;
}

export interface ActorInput {
	id: string;
	kind: ActorKind;
	name: string;
	workspaceId: string;
	ownerId?: string | null;
	model?: string | null;
	email?: string | null;
	key: string;
}

// No hyphens: a copy is named `{workspace}-sug-<actor>-<session>`, and the
// session part may contain hyphens, so an actor id with a hyphen could match
// the start of another actor's copies.
const ID_PATTERN = /^[a-z][a-z0-9]{0,23}$/;

export async function hashKey(key: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface ActorRow {
	id: string;
	kind: string;
	name: string;
	owner_id: string | null;
	model: string | null;
	workspace_id: string | null;
	email: string | null;
	removed_at: string | null;
}

const ACTOR_COLUMNS = `id, kind, name, owner_id, model, workspace_id, email, removed_at`;

function rowToActor(row: ActorRow): Actor | null {
	if (!row.workspace_id) return null;
	return {
		id: row.id,
		kind: row.kind === "agent" ? "agent" : "person",
		name: row.name,
		ownerId: row.owner_id,
		model: row.model,
		workspaceId: row.workspace_id,
		email: row.email,
		removedAt: row.removed_at,
	};
}

export async function actorById(db: D1Database, id: string): Promise<Actor | null> {
	const row = await db
		.prepare(`SELECT ${ACTOR_COLUMNS} FROM actors WHERE id = ?1`)
		.bind(id)
		.first<ActorRow>();
	return row ? rowToActor(row) : null;
}

export async function actorByKey(db: D1Database, key: string): Promise<Actor | null> {
	const hash = await hashKey(key);
	const row = await db
		.prepare(
			`SELECT a.id, a.kind, a.name, a.owner_id, a.model, a.workspace_id, a.email, a.removed_at
       FROM actor_keys k
       JOIN actors a ON a.id = k.actor_id
       WHERE k.key_hash = ?1 AND a.removed_at IS NULL`,
		)
		.bind(hash)
		.first<ActorRow>();
	return row ? rowToActor(row) : null;
}

export async function listActors(db: D1Database, workspaceId?: string): Promise<Actor[]> {
	const result = workspaceId
		? await db
				.prepare(
					`SELECT ${ACTOR_COLUMNS} FROM actors
           WHERE workspace_id = ?1 AND removed_at IS NULL
           ORDER BY created_at, id`,
				)
				.bind(workspaceId)
				.all<ActorRow>()
		: await db
				.prepare(`SELECT ${ACTOR_COLUMNS} FROM actors WHERE removed_at IS NULL ORDER BY created_at, id`)
				.bind()
				.all<ActorRow>();
	return (result.results ?? []).map(rowToActor).filter((actor): actor is Actor => actor !== null);
}

/**
 * An agent may read the library and read and write its own copies.
 * A person may also publish, which is a write to the library, and may read
 * every copy. A person does not write another actor's copy.
 */
export function allows(actor: Actor, repoName: string, write: boolean): boolean {
	if (actor.removedAt) return false;
	if (!repoInWorkspace(actor.workspaceId, repoName)) return false;
	if (isLibraryName(repoName)) {
		if (!write) return true;
		return actor.kind === "person";
	}
	if (ownsCopy(actor.workspaceId, actor.id, repoName)) return true;
	if (actor.kind === "person" && !write) return true;
	return false;
}

export function refusal(repoName: string, write: boolean): string {
	if (isLibraryName(repoName) && write) return "This key cannot change the library.";
	if (write) return "This key cannot change that copy.";
	return "This key cannot open that copy.";
}

function cleanName(name: string): string {
	return name.replace(/[\r\n]+/g, " ").trim();
}

export async function registerActor(db: D1Database, input: ActorInput): Promise<Actor> {
	if (!ID_PATTERN.test(input.id)) throw new Error("Actor id must be a short lowercase name of letters and digits.");
	if (!/^[a-z][a-z0-9]{2,15}$/.test(input.workspaceId)) throw new Error("Workspace id must be a short lowercase name.");
	const name = cleanName(input.name);
	if (!name || name.length > 80) throw new Error("Actor name must be a short line.");
	if (input.kind !== "person" && input.kind !== "agent") throw new Error("Actor kind must be person or agent.");
	if (input.key.length < 16 || input.key.length > 200) throw new Error("Key length is not allowed.");
	const email = input.email ? input.email.trim().toLowerCase() : null;
	if (input.kind === "agent") {
		if (!input.ownerId || !ID_PATTERN.test(input.ownerId)) throw new Error("An agent needs an owner.");
		if (input.ownerId === input.id) throw new Error("An agent cannot own itself.");
		const owner = await actorById(db, input.ownerId);
		if (!owner || owner.kind !== "person" || owner.removedAt) {
			throw new Error("The owner must be a person who is already registered.");
		}
		if (owner.workspaceId !== input.workspaceId) throw new Error("An agent stays in its owner's workspace.");
		const model = cleanName(input.model ?? "");
		if (!model || model.length > 40) throw new Error("An agent needs a model name.");
		input = { ...input, model };
	} else if (input.ownerId) {
		throw new Error("A person has no owner.");
	}

	const existing = await actorById(db, input.id);
	if (existing && existing.kind !== input.kind) {
		throw new Error("That actor already exists as a different kind.");
	}
	const now = new Date().toISOString();
	const model = input.kind === "agent" ? input.model ?? null : null;
	const ownerId = input.kind === "agent" ? input.ownerId ?? null : null;
	await db
		.prepare(
			`INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?1, ?2, ?3)`,
		)
		.bind(input.workspaceId, input.workspaceId, now)
		.run();
	await db
		.prepare(
			`INSERT INTO actors (id, kind, name, owner_id, model, workspace_id, email, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         model = excluded.model,
         email = COALESCE(excluded.email, actors.email),
         workspace_id = excluded.workspace_id`,
		)
		.bind(input.id, input.kind, name, ownerId, model, input.workspaceId, email, now)
		.run();

	const hash = await hashKey(input.key);
	const keyOwner = await db
		.prepare(`SELECT actor_id FROM actor_keys WHERE key_hash = ?1`)
		.bind(hash)
		.first<{ actor_id: string }>();
	if (keyOwner && keyOwner.actor_id !== input.id) throw new Error("That key is already in use.");
	if (!keyOwner) {
		await db
			.prepare(`INSERT INTO actor_keys (key_hash, actor_id, created_at) VALUES (?1, ?2, ?3)`)
			.bind(hash, input.id, now)
			.run();
	}

	const stored = await actorById(db, input.id);
	if (!stored) throw new Error("The actor could not be stored.");
	return stored;
}

/** The person an actor works for. A person is their own owner. */
export async function ownerOf(db: D1Database, actor: Actor): Promise<Actor> {
	if (!actor.ownerId) return actor;
	return (await actorById(db, actor.ownerId)) ?? actor;
}
