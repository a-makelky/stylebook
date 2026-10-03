// A KV stand-in for the OAuth provider. Tests use it. It is not the live namespace.

interface Stored {
	value: string;
	expiresAt?: number;
}

export function memoryKv(): KVNamespace {
	const rows = new Map<string, Stored>();

	function live(key: string): Stored | null {
		const row = rows.get(key);
		if (!row) return null;
		if (row.expiresAt !== undefined && row.expiresAt <= Date.now()) {
			rows.delete(key);
			return null;
		}
		return row;
	}

	return {
		async get(key: string, type?: unknown) {
			const row = live(key);
			if (!row) return null;
			const option = typeof type === "string" ? type : type && typeof type === "object" && "type" in type ? (type as { type?: string }).type : undefined;
			if (option === "json") return JSON.parse(row.value);
			if (option === "arrayBuffer") return new TextEncoder().encode(row.value).buffer;
			if (option === "stream") return new Blob([row.value]).stream();
			return row.value;
		},
		async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream, options?: { expirationTtl?: number; expiration?: number }) {
			let text: string;
			if (typeof value === "string") text = value;
			else if (value instanceof ArrayBuffer) text = new TextDecoder().decode(value);
			else if (ArrayBuffer.isView(value)) text = new TextDecoder().decode(value);
			else text = await new Response(value).text();
			let expiresAt: number | undefined;
			if (options?.expirationTtl) expiresAt = Date.now() + options.expirationTtl * 1000;
			else if (options?.expiration) expiresAt = options.expiration * 1000;
			rows.set(key, { value: text, expiresAt });
		},
		async delete(key: string) {
			rows.delete(key);
		},
		async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
			const prefix = options?.prefix ?? "";
			const names = [...rows.keys()].filter((key) => key.startsWith(prefix) && live(key)).sort();
			const start = options?.cursor ? Number(options.cursor) : 0;
			const limit = options?.limit ?? names.length;
			const slice = names.slice(start, start + limit);
			const next = start + limit < names.length ? String(start + limit) : undefined;
			return {
				keys: slice.map((name) => ({ name })),
				list_complete: !next,
				cursor: next,
				cacheStatus: null,
			};
		},
	} as unknown as KVNamespace;
}
