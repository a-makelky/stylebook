// A D1 stand-in backed by Node's built-in SQLite, with the same migrations the
// Worker applies. Tests use it. It is not the live D1 database.

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

export function memoryD1(): D1Database {
	const db = new DatabaseSync(":memory:");
	const root = join(import.meta.dirname, "..", "migrations");
	for (const file of ["0001_arrivals.sql", "0002_actors.sql"]) {
		db.exec(readFileSync(join(root, file), "utf8"));
	}

	return {
		prepare(sql: string) {
			return {
				bind(...values: unknown[]) {
					// Node's SQLite binds `?` but not `?1`. D1 accepts both.
					const statement = db.prepare(sql.replace(/\?\d+/g, "?"));
					const args = values as never[];
					return {
						async run() {
							statement.run(...args);
							return { success: true };
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
