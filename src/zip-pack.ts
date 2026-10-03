// A stored (uncompressed) zip. The Worker has no zip library. Method 0 is
// enough for a library of text, and any zip tool opens it.

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const UTF8 = 0x0800;

export interface ZipEntry {
	name: string;
	data: Uint8Array;
}

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		crc ^= data[i]!;
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(date: Date): { time: number; day: number } {
	const year = Math.max(date.getUTCFullYear(), 1980);
	const time =
		(date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
	const day = ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
	return { time, day };
}

function u16(view: DataView, offset: number, value: number) {
	view.setUint16(offset, value, true);
}

function u32(view: DataView, offset: number, value: number) {
	view.setUint32(offset, value, true);
}

function concat(parts: Uint8Array[]): Uint8Array {
	const length = parts.reduce((total, part) => total + part.byteLength, 0);
	const out = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

/** Pack files. Names are relative and use `/`. */
export function zipStore(entries: ZipEntry[], now = new Date()): Uint8Array {
	const stamp = dosTime(now);
	const encoder = new TextEncoder();
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = encoder.encode(entry.name);
		const crc = crc32(entry.data);
		const local = new Uint8Array(30 + name.byteLength);
		const view = new DataView(local.buffer);
		u32(view, 0, LOCAL);
		u16(view, 4, 20);
		u16(view, 6, UTF8);
		u16(view, 8, 0);
		u16(view, 10, stamp.time);
		u16(view, 12, stamp.day);
		u32(view, 14, crc);
		u32(view, 18, entry.data.byteLength);
		u32(view, 22, entry.data.byteLength);
		u16(view, 26, name.byteLength);
		u16(view, 28, 0);
		local.set(name, 30);
		locals.push(local, entry.data);

		const central = new Uint8Array(46 + name.byteLength);
		const centralView = new DataView(central.buffer);
		u32(centralView, 0, CENTRAL);
		u16(centralView, 4, 20);
		u16(centralView, 6, 20);
		u16(centralView, 8, UTF8);
		u16(centralView, 10, 0);
		u16(centralView, 12, stamp.time);
		u16(centralView, 14, stamp.day);
		u32(centralView, 16, crc);
		u32(centralView, 20, entry.data.byteLength);
		u32(centralView, 24, entry.data.byteLength);
		u16(centralView, 28, name.byteLength);
		u16(centralView, 30, 0);
		u16(centralView, 32, 0);
		u16(centralView, 34, 0);
		u16(centralView, 36, 0);
		u32(centralView, 38, 0);
		u32(centralView, 42, offset);
		central.set(name, 46);
		centrals.push(central);
		offset += local.byteLength + entry.data.byteLength;
	}
	const directory = concat(centrals);
	const end = new Uint8Array(22);
	const endView = new DataView(end.buffer);
	u32(endView, 0, END);
	u16(endView, 4, 0);
	u16(endView, 6, 0);
	u16(endView, 8, entries.length);
	u16(endView, 10, entries.length);
	u32(endView, 12, directory.byteLength);
	u32(endView, 16, offset);
	u16(endView, 20, 0);
	return concat([...locals, directory, end]);
}

export const NOT_A_BACKUP = "This is not a Stylebook backup.";
export const UPLOAD_TOO_BIG = "This backup is larger than Stylebook can restore.";

export class ZipError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ZipError";
	}
}

function safeName(name: string): boolean {
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
		if (view.getUint32(offset, true) === END) {
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
		if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== CENTRAL) {
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
		if (!safeName(name) || name.endsWith("/")) continue;
		if (method !== 0 || compressed !== size) throw new ZipError(NOT_A_BACKUP);
		if (localOffset + 30 > bytes.byteLength || view.getUint32(localOffset, true) !== LOCAL) {
			throw new ZipError(NOT_A_BACKUP);
		}
		const localName = view.getUint16(localOffset + 26, true);
		const localExtra = view.getUint16(localOffset + 28, true);
		const start = localOffset + 30 + localName + localExtra;
		const data = bytes.subarray(start, start + size);
		if (start + size > bytes.byteLength) throw new ZipError(NOT_A_BACKUP);
		if (crc32(data) !== view.getUint32(localOffset + 14, true)) {
			throw new ZipError(NOT_A_BACKUP);
		}
		total += size;
		if (total > maxBytes) throw new ZipError(UPLOAD_TOO_BIG);
		entries.push({ name, data });
	}
	return entries;
}
