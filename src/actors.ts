// People and agents. A Stylebook key is stored only as a SHA-256 hash.
// Attribution uses the actor that owns the key, not the name a client types.

import { LIBRARY, ownsCopy } from "./workspace";

export type ActorKind = "person" | "agent";

export interface Actor {
	id: string;
	kind: ActorKind;
	name: string;
	ownerId: string | null;
	model: string | null;
}

export interface ActorInput {
	id: string;
	kind: ActorKind;
	name: string;
	ownerId?: string | null;
	model?: string | null;
	key: string;
}

// No hyphens: a copy is named `sug-<actor>-<session>`, and the session part
// may contain hyphens, so an actor id with a hyphen could match the start of
// another actor's copies ("a" would own "sug-a-b-1", which belongs to "a-b").
const ID_PATTERN = /^[a-z][a-z0-9]{0,23}$/;

export async function hashKey(key: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rowToActor(row: {
	id: string;
	kind: string;
	name: string;
	owner_id: string | null;
	model: string | null;
}): Actor {
	return {
		id: row.id,
		kind: row.kind === "agent" ? "agent" : "person",
		name: row.name,
		ownerId: row.owner_id,
		model: row.model,
	};
}

export async function actorById(db: D1Database, id: string): Promise<Actor | null> {
	const row = await db
		.prepare(`SELECT id, kind, name, owner_id, model FROM actors WHERE id = ?1`)
		.bind(id)
		.first<{ id: string; kind: string; name: string; owner_id: string | null; model: string | null }>();
	return row ? rowToActor(row) : null;
}

export async function actorByKey(db: D1Database, key: string): Promise<Actor | null> {
	const hash = await hashKey(key);
	const row = await db
		.prepare(
			`SELECT a.id, a.kind, a.name, a.owner_id, a.model
       FROM actor_keys k
       JOIN actors a ON a.id = k.actor_id
       WHERE k.key_hash = ?1`,
		)
		.bind(hash)
		.first<{ id: string; kind: string; name: string; owner_id: string | null; model: string | null }>();
	return row ? rowToActor(row) : null;
}

export async function listActors(db: D1Database): Promise<Actor[]> {
	const result = await db
		.prepare(`SELECT id, kind, name, owner_id, model FROM actors ORDER BY created_at, id`)
		.bind()
		.all<{ id: string; kind: string; name: string; owner_id: string | null; model: string | null }>();
	return (result.results ?? []).map(rowToActor);
}

/**
 * An agent may read the library and read and write its own copies.
 * A person may also publish, which is a write to the library, and may read
 * every copy. A person does not write another actor's copy.
 */
export function allows(actor: Actor, repoName: string, write: boolean): boolean {
	if (repoName === LIBRARY) {
		if (!write) return true;
		return actor.kind === "person";
	}
	if (ownsCopy(actor.id, repoName)) return true;
	if (actor.kind === "person" && !write) return true;
	return false;
}

export function refusal(repoName: string, write: boolean): string {
	if (repoName === LIBRARY && write) return "This key cannot change the library.";
	if (write) return "This key cannot change that copy.";
	return "This key cannot open that copy.";
}

function cleanName(name: string): string {
	return name.replace(/[\r\n]+/g, " ").trim();
}

export async function registerActor(db: D1Database, input: ActorInput): Promise<Actor> {
	if (!ID_PATTERN.test(input.id)) throw new Error("Actor id must be a short lowercase name of letters and digits.");
	const name = cleanName(input.name);
	if (!name || name.length > 80) throw new Error("Actor name must be a short line.");
	if (input.kind !== "person" && input.kind !== "agent") throw new Error("Actor kind must be person or agent.");
	if (input.key.length < 16 || input.key.length > 200) throw new Error("Key length is not allowed.");
	if (input.kind === "agent") {
		if (!input.ownerId || !ID_PATTERN.test(input.ownerId)) throw new Error("An agent needs an owner.");
		if (input.ownerId === input.id) throw new Error("An agent cannot own itself.");
		const owner = await actorById(db, input.ownerId);
		if (!owner || owner.kind !== "person") throw new Error("The owner must be a person who is already registered.");
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
			`INSERT INTO actors (id, kind, name, owner_id, model, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, model = excluded.model`,
		)
		.bind(input.id, input.kind, name, ownerId, model, now)
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
