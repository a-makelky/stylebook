// A workspace is one Artifacts namespace. It holds the team's library and one
// suggestion copy per actor per session. Copies are made with fork(), which
// keeps them in the source namespace and records where they came from.
// https://developers.cloudflare.com/artifacts/api/workers-binding/
// https://developers.cloudflare.com/artifacts/concepts/best-practices/

export const LIBRARY = "library";
export const DEFAULT_BRANCH = "main";

/** Error codes that mean "this repo exists but is not ready yet". */
const NOT_READY = new Set([
	"CREATE_IN_PROGRESS",
	"IMPORT_IN_PROGRESS",
	"FORK_IN_PROGRESS",
]);

export function errorCode(error: unknown): string | undefined {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = (error as { code: unknown }).code;
		return typeof code === "string" ? code : undefined;
	}
	return undefined;
}

function slug(value: string): string {
	const cleaned = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned || "x";
}

/**
 * Name for one actor's one session, following the naming pattern Cloudflare
 * recommends (stable identifiers, one repo per unit of work). Repo names may
 * use letters, digits, `.`, `_` and `-`, and must start with a letter or digit.
 */
export function suggestionName(actor: string, session: string): string {
	return `sug-${slug(actor)}-${slug(session)}`.slice(0, 63);
}

/** Prefix of every copy that belongs to one actor. The trailing hyphen keeps `sug-a-` from matching `sug-agent-`. */
export function copyPrefix(actorId: string): string {
	return `sug-${slug(actorId)}-`;
}

/**
 * Actor ids have no hyphens, so the actor is exactly the segment between
 * `sug-` and the next hyphen. A prefix test alone would let actor "a" open
 * copies of an actor whose id starts with "a-".
 */
export function ownsCopy(actorId: string, repoName: string): boolean {
	if (!/^[a-z0-9]+$/.test(actorId)) return false;
	if (!repoName.startsWith(copyPrefix(actorId))) return false;
	return repoName.split("-")[1] === actorId;
}

export interface WaitOptions {
	attempts?: number;
	delayMs?: number;
}

/** What get() did while a repo was not ready yet. */
export interface GetReport {
	/** Error codes get() threw before it returned a handle, in order. */
	codes: string[];
	attempts: number;
	elapsedMs: number;
}

/**
 * Get a repo handle. Returns null if the repo does not exist. Retries while
 * the service reports the repo as still being created or forked.
 * https://developers.cloudflare.com/artifacts/api/workers-binding/
 */
export async function getRepo(
	workspace: Artifacts,
	name: string,
	wait: WaitOptions = {},
	report?: GetReport,
): Promise<ArtifactsRepo | null> {
	const attempts = wait.attempts ?? 20;
	const delayMs = wait.delayMs ?? 250;
	const started = Date.now();

	for (let attempt = 1; ; attempt++) {
		try {
			const repo = await workspace.get(name);
			if (report) {
				report.attempts = attempt;
				report.elapsedMs = Date.now() - started;
			}
			return repo;
		} catch (error) {
			const code = errorCode(error);
			if (report && code) report.codes.push(code);
			if (code === "NOT_FOUND") {
				if (report) {
					report.attempts = attempt;
					report.elapsedMs = Date.now() - started;
				}
				return null;
			}
			if (code && NOT_READY.has(code) && attempt < attempts) {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				continue;
			}
			throw error;
		}
	}
}

export interface Library {
	repo: ArtifactsRepo;
	created: boolean;
}

/** Get the workspace's library, creating it on first use. */
export async function ensureLibrary(
	workspace: Artifacts,
	wait?: WaitOptions,
): Promise<Library> {
	const existing = await getRepo(workspace, LIBRARY, wait);
	if (existing) return { repo: existing, created: false };

	let created = true;
	try {
		await workspace.create(LIBRARY, {
			description: "Team library: skills, MCP definitions and workflows",
			setDefaultBranch: DEFAULT_BRANCH,
		});
	} catch (error) {
		// Another request created it first. That is fine.
		if (errorCode(error) !== "ALREADY_EXISTS") throw error;
		created = false;
	}

	const repo = await getRepo(workspace, LIBRARY, wait);
	if (!repo) throw new Error("The library could not be created");
	return { repo, created };
}

export interface WriteAccess {
	remote: string;
	/** Write token for this repo only. It expires after `ttlSeconds`. */
	token: string;
}

/**
 * Mint a short-lived write token for one repo. Call this only when a write is
 * about to happen; the token is never returned to callers of the Worker.
 */
export async function writeAccess(
	repo: ArtifactsRepo,
	ttlSeconds = 300,
): Promise<WriteAccess> {
	const [info, token] = await Promise.all([
		repo.info(),
		repo.createToken("write", ttlSeconds),
	]);
	return { remote: info.remote, token: token.plaintext };
}

export interface SuggestionCopy {
	repo: ArtifactsRepo;
	name: string;
	/** False when a copy with this name already existed and was reused. */
	created: boolean;
	/**
	 * What get() did after fork() returned. Absent when the copy already
	 * existed and fork() was not called.
	 */
	afterFork?: GetReport;
}

/** Make a suggestion copy of the library for one actor's one session. */
export async function ensureSuggestion(
	workspace: Artifacts,
	library: ArtifactsRepo,
	name: string,
	wait?: WaitOptions,
): Promise<SuggestionCopy> {
	const existing = await getRepo(workspace, name, wait);
	if (existing) return { repo: existing, name, created: false };

	let created = true;
	try {
		await library.fork(name, {
			description: "Suggestion copy of the library",
			defaultBranchOnly: true,
		});
	} catch (error) {
		if (errorCode(error) !== "ALREADY_EXISTS") throw error;
		created = false;
	}

	// The binding documents that get() throws FORK_IN_PROGRESS while a copy is
	// still being made. Time that window from the moment fork() returns.
	const afterFork: GetReport = { codes: [], attempts: 0, elapsedMs: 0 };
	const repo = await getRepo(workspace, name, wait, afterFork);
	if (!repo) throw new Error(`The suggestion copy ${name} could not be created`);
	return { repo, name, created, afterFork };
}

/** Read one file's bytes at a branch, tag or edition ID. Null if it is not there. */
export async function readBytes(
	repo: ArtifactsRepo,
	path: string,
	ref: string = DEFAULT_BRANCH,
): Promise<Uint8Array | null> {
	const blob = await repo.readFile({ ref, path });
	return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

export interface Edition {
	id: string;
	message: string;
	author: string;
	savedAt: string;
}

/** Every repo name in the workspace. The binding pages with a cursor. */
export async function listRepoNames(workspace: Artifacts): Promise<string[]> {
	const names: string[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 20; page++) {
		const result = await workspace.list({ limit: 200, cursor });
		for (const repo of result.repos) names.push(repo.name);
		if (!result.cursor) break;
		cursor = result.cursor;
	}
	return names;
}

/** Paths of the files at one edition. Directories are walked with readTree. */
export async function listPaths(repo: ArtifactsRepo, ref = DEFAULT_BRANCH): Promise<string[]> {
	const commits = await repo.log({ ref, limit: 1 });
	const tip = commits[0];
	if (!tip) return [];
	const paths: string[] = [];
	async function walk(hash: string, prefix: string): Promise<void> {
		const entries = await repo.readTree(hash);
		if (!entries) return;
		for (const entry of entries) {
			const path = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.type === "tree") await walk(entry.hash, path);
			else if (entry.type === "blob" || entry.type === "exec") paths.push(path);
		}
	}
	await walk(tip.treeHash, "");
	return paths.sort();
}

/** A repo's editions, newest first. */
export async function listEditions(
	repo: ArtifactsRepo,
	limit = 20,
): Promise<Edition[]> {
	const commits = await repo.log({ ref: DEFAULT_BRANCH, limit });
	return commits.map((commit) => ({
		id: commit.hash,
		message: commit.message,
		author: commit.author.name,
		savedAt: new Date(commit.authoredAt * 1000).toISOString(),
	}));
}
