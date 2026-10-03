// In-memory file system for isomorphic-git inside a Worker.
// Adapted from the Cloudflare Artifacts isomorphic-git example:
// https://developers.cloudflare.com/artifacts/examples/isomorphic-git/
// Changes from the example:
// - errors carry a Node-style `code`, which isomorphic-git reads to tell
//   "not found" from a real failure;
// - `readlink` and `symlink` exist, because isomorphic-git binds both when it
//   wraps a file system and fails on startup without them.

type Entry =
	| { kind: "dir"; children: Set<string>; mtimeMs: number }
	| { kind: "file"; data: Uint8Array; mtimeMs: number }
	| { kind: "link"; target: string; mtimeMs: number };

function fsError(code: string, path: string): Error {
	const error = new Error(`${code}: ${path}`) as Error & { code: string };
	error.code = code;
	return error;
}

class MemoryStats {
	constructor(readonly entry: Entry) {}

	get size() {
		if (this.entry.kind === "file") return this.entry.data.byteLength;
		if (this.entry.kind === "link") return this.entry.target.length;
		return 0;
	}

	get mtimeMs() {
		return this.entry.mtimeMs;
	}

	get ctimeMs() {
		return this.entry.mtimeMs;
	}

	get mode() {
		if (this.entry.kind === "file") return 0o100644;
		if (this.entry.kind === "link") return 0o120000;
		return 0o040000;
	}

	isFile() {
		return this.entry.kind === "file";
	}

	isDirectory() {
		return this.entry.kind === "dir";
	}

	isSymbolicLink() {
		return this.entry.kind === "link";
	}
}

export class MemoryFS {
	private encoder = new TextEncoder();
	private decoder = new TextDecoder();
	private entries = new Map<string, Entry>([
		["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }],
	]);

	promises = {
		readFile: this.readFile.bind(this),
		writeFile: this.writeFile.bind(this),
		unlink: this.unlink.bind(this),
		readdir: this.readdir.bind(this),
		mkdir: this.mkdir.bind(this),
		rmdir: this.rmdir.bind(this),
		stat: this.stat.bind(this),
		lstat: this.lstat.bind(this),
		readlink: this.readlink.bind(this),
		symlink: this.symlink.bind(this),
	};

	private normalize(input: string) {
		const segments: string[] = [];
		for (const part of input.split("/")) {
			if (!part || part === ".") continue;
			if (part === "..") {
				segments.pop();
				continue;
			}
			segments.push(part);
		}
		return `/${segments.join("/")}`;
	}

	private parent(path: string) {
		const parts = this.normalize(path).split("/").filter(Boolean);
		parts.pop();
		return parts.length ? `/${parts.join("/")}` : "/";
	}

	private basename(path: string) {
		return this.normalize(path).split("/").filter(Boolean).pop() ?? "";
	}

	private requireEntry(path: string) {
		const entry = this.entries.get(this.normalize(path));
		if (!entry) throw fsError("ENOENT", path);
		return entry;
	}

	private requireDir(path: string) {
		const entry = this.requireEntry(path);
		if (entry.kind !== "dir") throw fsError("ENOTDIR", path);
		return entry;
	}

	async mkdir(path: string, options?: { recursive?: boolean } | number) {
		const target = this.normalize(path);
		if (target === "/") return;

		const recursive =
			typeof options === "object" && options !== null && options.recursive;
		const parent = this.parent(target);

		if (!this.entries.has(parent)) {
			if (!recursive) throw fsError("ENOENT", parent);
			await this.mkdir(parent, { recursive: true });
		}

		const existing = this.entries.get(target);
		if (existing) {
			if (existing.kind === "dir" && recursive) return;
			throw fsError("EEXIST", target);
		}

		this.entries.set(target, {
			kind: "dir",
			children: new Set(),
			mtimeMs: Date.now(),
		});
		this.requireDir(parent).children.add(this.basename(target));
	}

	async writeFile(path: string, data: string | Uint8Array | ArrayBuffer) {
		const target = this.normalize(path);
		await this.mkdir(this.parent(target), { recursive: true });

		const bytes =
			typeof data === "string"
				? this.encoder.encode(data)
				: data instanceof Uint8Array
					? data
					: new Uint8Array(data);

		this.entries.set(target, {
			kind: "file",
			data: bytes,
			mtimeMs: Date.now(),
		});
		this.requireDir(this.parent(target)).children.add(this.basename(target));
	}

	async readFile(path: string, options?: string | { encoding?: string }) {
		const entry = this.requireEntry(path);
		if (entry.kind !== "file") throw fsError("EISDIR", path);

		const encoding = typeof options === "string" ? options : options?.encoding;
		return encoding ? this.decoder.decode(entry.data) : entry.data;
	}

	async readdir(path: string) {
		return [...this.requireDir(path).children].sort();
	}

	async unlink(path: string) {
		const target = this.normalize(path);
		const entry = this.requireEntry(target);
		if (entry.kind === "dir") throw fsError("EISDIR", path);

		this.entries.delete(target);
		this.requireDir(this.parent(target)).children.delete(this.basename(target));
	}

	async rmdir(path: string) {
		const target = this.normalize(path);
		const entry = this.requireDir(target);
		if (entry.children.size > 0) throw fsError("ENOTEMPTY", path);

		this.entries.delete(target);
		this.requireDir(this.parent(target)).children.delete(this.basename(target));
	}

	async stat(path: string) {
		const entry = this.requireEntry(path);
		if (entry.kind === "link") {
			const target = entry.target.startsWith("/")
				? entry.target
				: `${this.parent(path)}/${entry.target}`;
			return new MemoryStats(this.requireEntry(target));
		}
		return new MemoryStats(entry);
	}

	async lstat(path: string) {
		return new MemoryStats(this.requireEntry(path));
	}

	async readlink(path: string) {
		const entry = this.requireEntry(path);
		if (entry.kind !== "link") throw fsError("EINVAL", path);
		return entry.target;
	}

	/** Every file under `root`, with paths relative to it. */
	filesUnder(root: string): { path: string; data: Uint8Array }[] {
		const base = this.normalize(root);
		const prefix = base === "/" ? "/" : `${base}/`;
		const files: { path: string; data: Uint8Array }[] = [];
		for (const [path, entry] of this.entries) {
			if (entry.kind !== "file" || !path.startsWith(prefix)) continue;
			const relative = path.slice(prefix.length);
			if (!relative) continue;
			files.push({ path: relative, data: entry.data });
		}
		files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
		return files;
	}

	async symlink(target: string, path: string) {
		const location = this.normalize(path);
		if (this.entries.has(location)) throw fsError("EEXIST", path);
		await this.mkdir(this.parent(location), { recursive: true });
		this.entries.set(location, { kind: "link", target, mtimeMs: Date.now() });
		this.requireDir(this.parent(location)).children.add(this.basename(location));
	}
}
