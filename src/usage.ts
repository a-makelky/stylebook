// Counts Artifacts operations per workspace. The binding is unchanged; this
// only records what this Worker already calls.
// https://developers.cloudflare.com/artifacts/platform/pricing/
//
// The binding is an RPC stub. A method taken off the stub and then invoked
// with `.call`, `.apply`, or `.bind` asks the stub for a method of that name,
// which it does not have. Call it as `stub[name](...)` so `this` stays the stub.

import type { Env } from "./env";

export async function recordOperations(
	db: D1Database,
	workspaceId: string,
	operation: string,
	count = 1,
): Promise<void> {
	if (count < 1) return;
	await db
		.prepare(
			`INSERT INTO workspace_operations (workspace_id, operation, count)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(workspace_id, operation) DO UPDATE SET count = count + ?3`,
		)
		.bind(workspaceId, operation, count)
		.run();
}

export async function operationCounts(
	db: D1Database,
	workspaceId: string,
): Promise<Record<string, number>> {
	const rows = await db
		.prepare(`SELECT operation, count FROM workspace_operations WHERE workspace_id = ?1`)
		.bind(workspaceId)
		.all<{ operation: string; count: number }>();
	const counts: Record<string, number> = {};
	for (const row of rows.results ?? []) counts[row.operation] = row.count;
	return counts;
}

const READ_METHODS = new Set(["readFile", "readTree", "log", "info", "listTokens"]);

type Stub = Record<string, (...args: unknown[]) => Promise<unknown>>;

function callStub(target: object, name: string, args: unknown[]): Promise<unknown> {
	return (target as Stub)[name](...args);
}

function wrapRepo(repo: ArtifactsRepo, tally: (operation: string) => void): ArtifactsRepo {
	return new Proxy(repo, {
		get(target, prop, receiver) {
			if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
			if (prop === "fork") {
				return async (...args: unknown[]) => {
					tally("fork");
					return callStub(target, prop, args);
				};
			}
			if (prop === "createToken") {
				return async (scope: string, ...args: unknown[]) => {
					tally(scope === "write" ? "write" : "read");
					return callStub(target, prop, [scope, ...args]);
				};
			}
			if (READ_METHODS.has(prop)) {
				return async (...args: unknown[]) => {
					tally("read");
					return callStub(target, prop, args);
				};
			}
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => callStub(target, prop, args);
		},
	});
}

/**
 * A binding that counts get, create, list, read, write and fork for one
 * workspace. Call `flush` before the response is sent.
 */
export function trackUsage(
	workspace: Artifacts,
	db: D1Database,
	workspaceId: string,
): { binding: Artifacts; flush: () => Promise<void> } {
	const counts = new Map<string, number>();
	const tally = (operation: string) => counts.set(operation, (counts.get(operation) ?? 0) + 1);
	const binding = new Proxy(workspace, {
		get(target, prop, receiver) {
			if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
			if (prop === "get") {
				return async (name: string) => {
					tally("get");
					const repo = (await callStub(target, prop, [name])) as ArtifactsRepo | null;
					return repo ? wrapRepo(repo, tally) : repo;
				};
			}
			if (prop === "create" || prop === "list") {
				return async (...args: unknown[]) => {
					tally(prop);
					return callStub(target, prop, args);
				};
			}
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => callStub(target, prop, args);
		},
	});
	return {
		binding,
		flush: async () => {
			for (const [operation, count] of counts) {
				await recordOperations(db, workspaceId, operation, count);
			}
			counts.clear();
		},
	};
}

export function scopedEnv(env: Env, workspaceId: string): { env: Env; flush: () => Promise<void> } {
	const tracked = trackUsage(env.WORKSPACE, env.DB, workspaceId);
	return { env: { ...env, WORKSPACE: tracked.binding }, flush: tracked.flush };
}
