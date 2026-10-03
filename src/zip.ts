// A zip of stored files, uncompressed. Workers can build this without a package.

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function u16(view: DataView, offset: number, value: number) {
	view.setUint16(offset, value, true);
}

function u32(view: DataView, offset: number, value: number) {
	view.setUint32(offset, value, true);
}

/** Bit 11: the entry name is UTF-8. */
const UTF8_NAME = 0x800;

export const SKILL_ZIP_MAX_FILES = 200;
export const SKILL_ZIP_MAX_BYTES = 8 * 1024 * 1024;

/** A library path that can safely become a zip entry name. */
export function zipEntryAllowed(name: string): boolean {
	if (!name || name.length > 240) return false;
	if (name.startsWith("/") || name.includes("\\") || name.includes("..")) return false;
	const parts = name.split("/");
	if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
	return true;
}

/** Drop unsafe names, then stop at the file count and the total size. */
export function zipEntries(
	files: { name: string; data: Uint8Array }[],
	limits: { maxFiles: number; maxBytes: number } = {
		maxFiles: SKILL_ZIP_MAX_FILES,
		maxBytes: SKILL_ZIP_MAX_BYTES,
	},
): { name: string; data: Uint8Array }[] {
	const kept: { name: string; data: Uint8Array }[] = [];
	let total = 0;
	for (const file of files) {
		if (!zipEntryAllowed(file.name)) continue;
		if (kept.length >= limits.maxFiles) break;
		if (total + file.data.byteLength > limits.maxBytes) break;
		kept.push(file);
		total += file.data.byteLength;
	}
	return kept;
}

/** A zip archive. Names use forward slashes and are marked UTF-8. Nothing is compressed. */
export function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
	const encoder = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;
	for (const file of files) {
		const name = encoder.encode(file.name);
		const crc = crc32(file.data);
		const local = new Uint8Array(30 + name.length);
		const localView = new DataView(local.buffer);
		u32(localView, 0, 0x04034b50);
		u16(localView, 4, 20);
		u16(localView, 6, UTF8_NAME);
		u16(localView, 8, 0);
		u32(localView, 14, crc);
		u32(localView, 18, file.data.length);
		u32(localView, 22, file.data.length);
		u16(localView, 26, name.length);
		local.set(name, 30);
		locals.push(local, file.data);

		const central = new Uint8Array(46 + name.length);
		const centralView = new DataView(central.buffer);
		u32(centralView, 0, 0x02014b50);
		u16(centralView, 4, 20);
		u16(centralView, 6, 20);
		u16(centralView, 8, UTF8_NAME);
		u16(centralView, 10, 0);
		u32(centralView, 16, crc);
		u32(centralView, 20, file.data.length);
		u32(centralView, 24, file.data.length);
		u16(centralView, 28, name.length);
		u32(centralView, 42, offset);
		central.set(name, 46);
		centrals.push(central);
		offset += local.length + file.data.length;
	}
	const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
	const end = new Uint8Array(22);
	const endView = new DataView(end.buffer);
	u32(endView, 0, 0x06054b50);
	u16(endView, 8, files.length);
	u16(endView, 10, files.length);
	u32(endView, 12, centralSize);
	u32(endView, 16, offset);
	const total = offset + centralSize + end.length;
	const out = new Uint8Array(total);
	let cursor = 0;
	for (const part of locals) {
		out.set(part, cursor);
		cursor += part.length;
	}
	for (const part of centrals) {
		out.set(part, cursor);
		cursor += part.length;
	}
	out.set(end, cursor);
	return out;
}

export interface ZipEntry {
	name: string;
	data: Uint8Array;
}

export const NOT_A_BACKUP = "This is not a Stylebook backup.";
export const UPLOAD_TOO_BIG = "This backup is larger than Stylebook can restore.";

export class ZipError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ZipError";
	}
}

function safeZipName(name: string): boolean {
	if (!name || name.length > 300) return false;
	if (name.startsWith("/") || name.includes("\\") || name.includes("\0")) return false;
	const parts = name.split("/");
	return parts.every((part) => part !== "" && part !== ".." && part !== ".");
}

/**
 * Read a stored zip. Refuses a name that climbs out of the folder, a compressed
 * entry, and a total larger than `maxBytes`.
 */
export function unzipStore(bytes: Uint8Array, maxBytes: number, maxEntries = 10_000): ZipEntry[] {
	if (bytes.byteLength < 22) throw new ZipError(NOT_A_BACKUP);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let end = -1;
	const scanFrom = Math.max(0, bytes.byteLength - 22 - 65535);
	for (let offset = bytes.byteLength - 22; offset >= scanFrom; offset--) {
		if (view.getUint32(offset, true) === 0x06054b50) {
			end = offset;
			break;
		}
	}
	if (end < 0) throw new ZipError(NOT_A_BACKUP);
	const count = view.getUint16(end + 10, true);
	const directorySize = view.getUint32(end + 12, true);
	const directoryOffset = view.getUint32(end + 16, true);
	if (count > maxEntries) throw new ZipError(UPLOAD_TOO_BIG);
	if (directoryOffset + directorySize > bytes.byteLength) throw new ZipError(NOT_A_BACKUP);

	const entries: ZipEntry[] = [];
	let cursor = directoryOffset;
	let total = 0;
	const decoder = new TextDecoder();
	for (let index = 0; index < count; index++) {
		if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== 0x02014b50) {
			throw new ZipError(NOT_A_BACKUP);
		}
		const method = view.getUint16(cursor + 10, true);
		const compressed = view.getUint32(cursor + 20, true);
		const size = view.getUint32(cursor + 24, true);
		const nameLength = view.getUint16(cursor + 28, true);
		const extra = view.getUint16(cursor + 30, true);
		const comment = view.getUint16(cursor + 32, true);
		const localOffset = view.getUint32(cursor + 42, true);
		const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
		cursor += 46 + nameLength + extra + comment;
		if (!safeZipName(name) || name.endsWith("/")) continue;
		if (method !== 0 || compressed !== size) throw new ZipError(NOT_A_BACKUP);
		if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== 0x04034b50) {
			throw new ZipError(NOT_A_BACKUP);
		}
		const localName = view.getUint16(localOffset + 26, true);
		const localExtra = view.getUint16(localOffset + 28, true);
		const start = localOffset + 30 + localName + localExtra;
		const data = bytes.subarray(start, start + size);
		if (start + size > bytes.byteLength) throw new ZipError(NOT_A_BACKUP);
		if (crc32(data) !== view.getUint32(localOffset + 14, true)) throw new ZipError(NOT_A_BACKUP);
		total += size;
		if (total > maxBytes) throw new ZipError(UPLOAD_TOO_BIG);
		entries.push({ name, data: data.slice() });
	}
	return entries;
}
