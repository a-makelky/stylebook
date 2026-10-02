// Turn a push event into one arrival row. The public event example is the
// queue payload (type, source, payload, metadata):
// https://developers.cloudflare.com/artifacts/guides/event-subscriptions/
// The docs do not say which of those objects a Workflow trigger places on
// event.payload. The parser looks for the repo, ref, and edition wherever
// they sit, and records only key names when it cannot tell. It never copies
// accountId, a token, or a remote URL.

import { isLibraryName } from "./workspace";

export type ArrivalKind = "library" | "suggestion" | "notes" | "other" | "unparsed";

export interface ArrivalRow {
	repoName: string;
	refName: string;
	editionId: string;
	kind: ArrivalKind;
	arrivedAt: string;
	recordedAt: string;
	detail: string | null;
}

export interface ExpectedPush {
	repoName: string;
	refName: string;
	editionId: string;
	kind: ArrivalKind;
}

interface Found {
	repoName: string | null;
	refName: string | null;
	editionId: string | null;
	arrivedAt: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return null;
}

function isSha(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

const SKIP_VALUES = new Set([
	"accountId",
	"account_id",
	"token",
	"plaintext",
	"remote",
	"password",
	"authorization",
	"headers",
]);

function walk(value: unknown, found: Found, depth: number) {
	const record = asRecord(value);
	if (!record || depth > 6) return;

	if (typeof record.repoName === "string") found.repoName ??= record.repoName;
	if (typeof record.repo_name === "string") found.repoName ??= record.repo_name;
	if (typeof record.ref === "string" && record.ref.startsWith("refs/")) {
		found.refName ??= record.ref;
	}
	if (isSha(record.after)) found.editionId ??= record.after;
	// The event's own timestamp is when the push arrived. A commit timestamp is
	// only a fallback, and must not replace it if the payload is walked first.
	if (typeof record.eventTimestamp === "string") found.arrivedAt = record.eventTimestamp;

	if (Array.isArray(record.commits) && record.commits.length > 0) {
		const last = asRecord(record.commits[record.commits.length - 1]);
		if (last) {
			if (!found.editionId && isSha(last.id)) found.editionId = last.id;
			if (!found.arrivedAt && typeof last.timestamp === "string") found.arrivedAt = last.timestamp;
		}
	}

	for (const [key, child] of Object.entries(record)) {
		if (SKIP_VALUES.has(key)) continue;
		walk(child, found, depth + 1);
	}
}

function keyPaths(value: unknown, prefix = "", depth = 0): string[] {
	const record = asRecord(value);
	if (!record || depth > 3) return [];
	const paths: string[] = [];
	for (const key of Object.keys(record).slice(0, 24)) {
		const path = prefix ? `${prefix}.${key}` : key;
		paths.push(path);
		if (SKIP_VALUES.has(key)) continue;
		paths.push(...keyPaths(record[key], path, depth + 1));
	}
	return paths;
}

export function arrivalKind(repoName: string, refName: string): ArrivalKind {
	if (refName.startsWith("refs/notes/")) return "notes";
	if (repoName === "library" || isLibraryName(repoName)) return "library";
	if (repoName.startsWith("sug-") || repoName.includes("-sug-")) return "suggestion";
	return "other";
}

/**
 * Build the row the arrival Workflow stores. `instanceId` keeps two unparsed
 * events from collapsing into one row.
 */
export function toArrival(input: unknown, recordedAt: string, instanceId: string): ArrivalRow {
	const found: Found = { repoName: null, refName: null, editionId: null, arrivedAt: null };
	walk(input, found, 0);
	const paths = keyPaths(input).slice(0, 40).join(",");
	const repoName = found.repoName ?? "unparsed";
	const refName = found.refName ?? "unparsed";
	const parsed = Boolean(found.repoName && found.refName && found.editionId);
	const kind = parsed ? arrivalKind(repoName, refName) : "unparsed";
	const notes: string[] = [];
	if (!parsed) notes.push("unparsed");
	if (!found.editionId) notes.push("edition-missing");
	if (!found.arrivedAt) notes.push("time-missing");
	if (paths) notes.push(`keys=${paths}`);
	return {
		repoName,
		refName,
		editionId: found.editionId ?? `missing-${instanceId}`,
		kind,
		arrivedAt: found.arrivedAt ?? recordedAt,
		recordedAt,
		detail: notes.join("; ").slice(0, 500),
	};
}

export async function insertArrival(db: D1Database, row: ArrivalRow): Promise<void> {
	await db
		.prepare(
			`INSERT OR IGNORE INTO arrivals
        (repo_name, ref_name, edition_id, kind, arrived_at, recorded_at, detail)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
		)
		.bind(
			row.repoName,
			row.refName,
			row.editionId,
			row.kind,
			row.arrivedAt,
			row.recordedAt,
			row.detail,
		)
		.run();
}

export async function listArrivalsSince(db: D1Database, since: string): Promise<ArrivalRow[]> {
	const result = await db
		.prepare(
			`SELECT repo_name, ref_name, edition_id, kind, arrived_at, recorded_at, detail
       FROM arrivals
       WHERE recorded_at >= ?1
       ORDER BY id ASC`,
		)
		.bind(since)
		.all<{
			repo_name: string;
			ref_name: string;
			edition_id: string;
			kind: string;
			arrived_at: string;
			recorded_at: string;
			detail: string | null;
		}>();
	return (result.results ?? []).map((row) => ({
		repoName: row.repo_name,
		refName: row.ref_name,
		editionId: row.edition_id,
		kind: row.kind as ArrivalKind,
		arrivedAt: row.arrived_at,
		recordedAt: row.recorded_at,
		detail: row.detail,
	}));
}

export function matchArrivals(
	expected: ExpectedPush[],
	rows: ArrivalRow[],
): { missing: ExpectedPush[]; extras: ArrivalRow[] } {
	const used = new Set<number>();
	const missing: ExpectedPush[] = [];
	for (const want of expected) {
		const index = rows.findIndex(
			(row, i) =>
				!used.has(i) &&
				row.repoName === want.repoName &&
				row.refName === want.refName &&
				row.editionId === want.editionId &&
				row.kind === want.kind,
		);
		if (index === -1) missing.push(want);
		else used.add(index);
	}
	return { missing, extras: rows.filter((_, index) => !used.has(index)) };
}
