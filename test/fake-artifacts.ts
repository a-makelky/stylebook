// A stand-in for the Artifacts Workers binding, backed by bare Git repos on
// disk and the local Git server. It covers only the methods Stylebook uses and
// follows the generated binding types (worker-configuration.d.ts).
//
// The 2026-10-02 live run (docs/runs/2026-10-02-tracer-1.md) confirmed two
// choices the public docs leave unspecified: info().source is
// `artifacts:<namespace>/<repo>`, and the first get() after fork() returns
// does not report FORK_IN_PROGRESS for a small copy. Those are no longer
// guesses. A non-zero forkDelayCalls only exercises the error code the
// generated types still document.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGitServer, type GitServer, type Scope } from "./git-server";

function artifactsError(code: string, message: string): Error {
	const error = new Error(message) as Error & { code: string };
	error.name = "ArtifactsError";
	error.code = code;
	return error;
}

interface RepoRecord {
	id: string;
	description: string | null;
	source: string | null;
	createdAt: string;
	tokens: Map<string, Scope>;
	/** How many more get() calls should report "still forking". */
	notReadyFor: number;
}

export class FakeWorkspace {
	readonly namespace = "test-workspace";
	readonly root = mkdtempSync(join(tmpdir(), "stylebook-test-"));
	private repos = new Map<string, RepoRecord>();
	private server!: GitServer;
	/**
	 * Number of get() calls a new fork reports FORK_IN_PROGRESS for.
	 * The live service did not report that code after fork() returned, so
	 * the default is 0.
	 */
	forkDelayCalls = 0;
	forkCalls: string[] = [];

	static async start(): Promise<FakeWorkspace> {
		const workspace = new FakeWorkspace();
		workspace.server = await startGitServer(
			workspace.root,
			(repo, needs, secret) => {
				const scope = secret
					? workspace.repos.get(repo)?.tokens.get(secret)
					: undefined;
				return scope === "write" || (scope === "read" && needs === "read");
			},
		);
		return workspace;
	}

	async stop(): Promise<void> {
		await this.server.close();
		rmSync(this.root, { recursive: true, force: true });
	}

	/** The object to pass where the Worker expects `env.WORKSPACE`. */
	get binding(): Artifacts {
		return this as unknown as Artifacts;
	}

	gitDir(name: string): string {
		return join(this.root, `${name}.git`);
	}

	git(name: string, ...args: string[]): string {
		return execFileSync("git", ["--git-dir", this.gitDir(name), ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	}

	remote(name: string): string {
		return `${this.server.url}/${name}.git`;
	}

	mintToken(name: string, scope: Scope, ttlSeconds: number) {
		const secret = `art_v1_${randomBytes(20).toString("hex")}`;
		const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
		this.record(name).tokens.set(secret, scope);
		return {
			id: randomBytes(8).toString("hex"),
			plaintext: `${secret}?expires=${expires}`,
			scope,
			expiresAt: new Date(expires * 1000).toISOString(),
		};
	}

	record(name: string): RepoRecord {
		const record = this.repos.get(name);
		if (!record) throw artifactsError("NOT_FOUND", `Repo ${name} not found`);
		return record;
	}

	private register(name: string, description: string | null, source: string | null) {
		this.repos.set(name, {
			id: randomBytes(8).toString("hex"),
			description,
			source,
			createdAt: new Date().toISOString(),
			tokens: new Map(),
			notReadyFor: 0,
		});
	}

	async create(
		name: string,
		opts: { description?: string; setDefaultBranch?: string } = {},
	) {
		if (this.repos.has(name)) {
			throw artifactsError("ALREADY_EXISTS", `Repo ${name} already exists`);
		}
		const branch = opts.setDefaultBranch ?? "main";
		execFileSync("git", ["init", "--bare", "-b", branch, this.gitDir(name)], {
			stdio: "ignore",
		});
		this.git(name, "config", "http.receivepack", "true");
		this.register(name, opts.description ?? null, null);
		return {
			id: this.record(name).id,
			name,
			description: opts.description ?? null,
			defaultBranch: branch,
			remote: this.remote(name),
			token: this.mintToken(name, "write", 3600).plaintext,
		};
	}

	async get(name: string) {
		const record = this.record(name);
		if (record.notReadyFor > 0) {
			record.notReadyFor -= 1;
			throw artifactsError("FORK_IN_PROGRESS", `Repo ${name} is still forking`);
		}
		return new FakeRepo(this, name) as unknown as ArtifactsRepo;
	}

	forkFrom(sourceName: string, name: string, description: string | null) {
		this.forkCalls.push(name);
		if (this.repos.has(name) || existsSync(this.gitDir(name))) {
			throw artifactsError("ALREADY_EXISTS", `Repo ${name} already exists`);
		}
		execFileSync(
			"git",
			["clone", "--bare", "--quiet", this.gitDir(sourceName), this.gitDir(name)],
			{ stdio: "ignore" },
		);
		this.git(name, "config", "http.receivepack", "true");
		this.register(name, description, `artifacts:${this.namespace}/${sourceName}`);
		this.record(name).notReadyFor = this.forkDelayCalls;
	}
}

class FakeRepo {
	constructor(
		private workspace: FakeWorkspace,
		private name: string,
	) {}

	async info() {
		const record = this.workspace.record(this.name);
		return {
			id: record.id,
			name: this.name,
			description: record.description,
			defaultBranch: "main",
			createdAt: record.createdAt,
			updatedAt: record.createdAt,
			lastPushAt: null,
			source: record.source,
			readOnly: false,
			remote: this.workspace.remote(this.name),
		};
	}

	async createToken(scope: Scope = "write", ttl = 86400) {
		return this.workspace.mintToken(this.name, scope, ttl);
	}

	async fork(name: string, opts: { description?: string } = {}) {
		this.workspace.forkFrom(this.name, name, opts.description ?? null);
		return {
			id: this.workspace.record(name).id,
			name,
			description: opts.description ?? null,
			defaultBranch: "main",
			remote: this.workspace.remote(name),
			token: this.workspace.mintToken(name, "write", 3600).plaintext,
		};
	}

	async log(opts: { ref?: string; limit?: number; offset?: number } = {}) {
		const ref = opts.ref ?? "HEAD";
		let output: string;
		try {
			output = this.workspace.git(
				this.name,
				"log",
				"--first-parent",
				`--max-count=${opts.limit ?? 50}`,
				`--skip=${opts.offset ?? 0}`,
				"--format=%H%x1f%T%x1f%an%x1f%ae%x1f%cn%x1f%ce%x1f%P%x1f%at%x1f%ct%x1f%B%x1e",
				ref,
			);
		} catch {
			// The binding returns an empty array when the ref cannot be resolved.
			return [];
		}
		return output
			.split("\x1e")
			.map((entry) => entry.replace(/^\n/, ""))
			.filter(Boolean)
			.map((entry) => {
				const [hash, treeHash, an, ae, cn, ce, parents, at, ct, body] =
					entry.split("\x1f");
				return {
					hash: hash!,
					treeHash: treeHash!,
					message: (body ?? "").replace(/\n$/, ""),
					author: { name: an!, email: ae! },
					committer: { name: cn!, email: ce! },
					parents: parents ? parents.split(" ") : [],
					authoredAt: Number(at),
					committedAt: Number(ct),
				};
			});
	}

	async readFile(args: { ref: string; path: string }) {
		try {
			const bytes = execFileSync(
				"git",
				["--git-dir", this.workspace.gitDir(this.name), "show", `${args.ref}:${args.path}`],
				{ stdio: ["ignore", "pipe", "ignore"] },
			);
			return new Blob([bytes]);
		} catch {
			return null;
		}
	}
}
