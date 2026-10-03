// What a restore keeps from an uploaded backup's .git directory.
// A config, a hook, or an alternates file is never copied. A fresh config is
// written instead, so a backup cannot point later sends at another host.
// Loose objects and packfiles are inflated under a byte budget and the
// inflater stops once that budget is passed.

import { Inflate } from "node:zlib";
import { NOT_A_BACKUP } from "./zip";

export const EXPANDS_TOO_FAR = "This backup expands to more than Stylebook can restore.";

export const FRESH_GIT_CONFIG = `[core]
	repositoryformatversion = 0
	filemode = false
	bare = false
	logallrefupdates = true
	symlinks = false
	ignorecase = true
`;

const LOOSE = /^objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/;
const PACK = /^objects\/pack\/[A-Za-z0-9._-]+\.(?:pack|idx|rev|keep|mtimes|bitmap)$/;

export class BackupGitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BackupGitError";
	}
}

/** Paths under `.git/` that a restore may copy. Everything else is dropped. */
export function keptGitRelative(path: string): boolean {
	if (path === "HEAD" || path === "packed-refs") return true;
	if (LOOSE.test(path) || PACK.test(path)) return true;
	if (!path.startsWith("refs/")) return false;
	const parts = path.split("/");
	if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
	return /^refs\/[A-Za-z0-9._/-]+$/.test(path);
}

function inflateLimited(
	data: Uint8Array,
	offset: number,
	budget: number,
): Promise<{ inflated: number; consumed: number }> {
	return new Promise((resolve, reject) => {
		const inflator = new Inflate();
		let inflated = 0;
		let settled = false;
		const finish = (error: BackupGitError | null, value?: { inflated: number; consumed: number }) => {
			if (settled) return;
			settled = true;
			if (error) reject(error);
			else resolve(value!);
		};
		inflator.on("data", (chunk: Uint8Array) => {
			inflated += chunk.length;
			if (inflated > budget) {
				inflator.destroy();
				finish(new BackupGitError(EXPANDS_TOO_FAR));
			}
		});
		inflator.on("error", () => finish(new BackupGitError(NOT_A_BACKUP)));
		inflator.on("end", () => finish(null, { inflated, consumed: inflator.bytesWritten }));
		inflator.on("close", () => {
			if (!settled) finish(new BackupGitError(EXPANDS_TOO_FAR));
		});
		try {
			inflator.end(data.subarray(offset));
		} catch {
			finish(new BackupGitError(NOT_A_BACKUP));
		}
	});
}

async function measureLoose(data: Uint8Array, budget: number): Promise<number> {
	const result = await inflateLimited(data, 0, budget);
	if (result.consumed !== data.byteLength) throw new BackupGitError(NOT_A_BACKUP);
	return result.inflated;
}

function readPackHeader(
	data: Uint8Array,
	offset: number,
	limit: number,
): { size: number; next: number } {
	if (offset >= limit) throw new BackupGitError(NOT_A_BACKUP);
	let cursor = offset;
	let byte = data[cursor]!;
	const type = (byte >> 4) & 7;
	if (type < 1 || type > 7) throw new BackupGitError(NOT_A_BACKUP);
	let size = byte & 15;
	let shift = 4;
	cursor += 1;
	let steps = 0;
	while (byte & 0x80) {
		if (cursor >= limit || ++steps > 10) throw new BackupGitError(NOT_A_BACKUP);
		byte = data[cursor]!;
		cursor += 1;
		const add = (byte & 0x7f) * 2 ** shift;
		if (!Number.isFinite(add) || size > Number.MAX_SAFE_INTEGER - add) {
			throw new BackupGitError(EXPANDS_TOO_FAR);
		}
		size += add;
		shift += 7;
	}
	if (type === 6) {
		if (cursor >= limit) throw new BackupGitError(NOT_A_BACKUP);
		byte = data[cursor]!;
		cursor += 1;
		steps = 0;
		while (byte & 0x80) {
			if (cursor >= limit || ++steps > 10) throw new BackupGitError(NOT_A_BACKUP);
			byte = data[cursor]!;
			cursor += 1;
		}
	} else if (type === 7) {
		cursor += 20;
		if (cursor > limit) throw new BackupGitError(NOT_A_BACKUP);
	}
	return { size, next: cursor };
}

async function measurePack(data: Uint8Array, budget: number): Promise<number> {
	if (data.byteLength < 32) throw new BackupGitError(NOT_A_BACKUP);
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	if (view.getUint32(0) !== 0x5041434b) throw new BackupGitError(NOT_A_BACKUP);
	const version = view.getUint32(4);
	if (version !== 2 && version !== 3) throw new BackupGitError(NOT_A_BACKUP);
	const count = view.getUint32(8);
	if (count > 100_000) throw new BackupGitError(EXPANDS_TOO_FAR);
	const end = data.byteLength - 20;
	let cursor = 12;
	let used = 0;
	for (let index = 0; index < count; index++) {
		const header = readPackHeader(data, cursor, end);
		if (header.size > budget - used) throw new BackupGitError(EXPANDS_TOO_FAR);
		const inflated = await inflateLimited(data, header.next, budget - used);
		used += inflated.inflated;
		if (used > budget) throw new BackupGitError(EXPANDS_TOO_FAR);
		cursor = header.next + inflated.consumed;
		if (cursor > end) throw new BackupGitError(NOT_A_BACKUP);
	}
	if (cursor !== end) throw new BackupGitError(NOT_A_BACKUP);
	return used;
}

/** Inflate every loose object and pack. Stops once `budget` bytes are exceeded. */
export async function measureGitObjects(
	files: { path: string; data: Uint8Array }[],
	budget: number,
): Promise<void> {
	let used = 0;
	for (const file of files) {
		const remaining = budget - used;
		if (remaining < 0) throw new BackupGitError(EXPANDS_TOO_FAR);
		if (LOOSE.test(file.path)) used += await measureLoose(file.data, remaining);
		else if (file.path.endsWith(".pack")) used += await measurePack(file.data, remaining);
		if (used > budget) throw new BackupGitError(EXPANDS_TOO_FAR);
	}
}
