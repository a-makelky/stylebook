// A D1 stand-in backed by Node's built-in SQLite, with the same migrations the
// Worker applies. Tests use it. It is not the live D1 database.

import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

export function memoryD1(): D1Database {
	const db = new DatabaseSync(":memory:");
	const root = join(import.meta.dirname, "..", "migrations");
	for (const file of readdirSync(root).filter((name) => name.endsWith(".sql")).sort()) {
		db.exec(readFileSync(join(root, file), "utf8"));
	}

	return {
		prepare(sql: string) {
			return {
				bind(...values: unknown[]) {
					// Node's SQLite binds `?` but not `?1`. D1 reuses a numbered
					// placeholder, so each `?1` is expanded to the same argument.
					const numbered = [...sql.matchAll(/\?(\d+)/g)];
					const statement = db.prepare(sql.replace(/\?\d+/g, "?"));
					const args = (
						numbered.length > 0 ? numbered.map((match) => values[Number(match[1]) - 1]) : values
					) as never[];
					return {
						async run() {
							const info = statement.run(...args);
							return {
								success: true,
								meta: { changes: Number(info.changes ?? 0), last_row_id: Number(info.lastInsertRowid ?? 0) },
							};
						},
						async first<T>() {
							const row = statement.get(...args);
							return (row as T | undefined) ?? null;
						},
						async all<T>() {
							return { success: true, results: statement.all(...args) as T[] };
						},
					};
				},
			};
		},
	} as unknown as D1Database;
}
