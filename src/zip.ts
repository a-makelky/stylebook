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

/** A zip archive. Names use forward slashes. Nothing is compressed. */
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
