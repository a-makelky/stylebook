import { execFileSync } from "node:child_process";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowStep } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealSecret, openSecret } from "../src/backup-crypto";
import { BACKUP_ADMIN_LINE, BACKUP_POSTS, lastBackedUp } from "../src/backups-page";
import { DOWNLOAD_TOO_BIG } from "../src/backup";
import { saveMirror } from "../src/backup-store";
import type { Env } from "../src/env";
import { publishFile } from "../src/git";
import { canCreateRepository, githubAppJwt, privateRepositoryBody } from "../src/github-app";
import { signAccessJwt } from "../src/identity";
import { DIVERGED } from "../src/mirror";
import { editionNote } from "../src/notes";
import { permit, type Action } from "../src/permit";
import { NOT_A_BACKUP, UPLOAD_TOO_BIG, unzipStore, zipStore } from "../src/zip-pack";
import { ensureSuggestion, suggestionName, writeAccess } from "../src/workspace";
import { ArrivalWorkflow } from "../src/workflows";
import { FakeWorkspace } from "./fake-artifacts";
import { startGitServer, type GitServer } from "./git-server";
import { memoryD1 } from "./memory-d1";
import { serveWorker } from "./serve";

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "stylebook-test-audience";
const ADMIN_EMAIL = "ada.north@stylebook.invalid";
const MEMBER_EMAIL = "member.north@stylebook.invalid";
const MIRROR_SECRET = "mirror-secret-value";
const BANNED = ["git", "repo", "branch", "commit", "push", "pull", "merge", "fork", "pr", "squash", "rebase", "clone", "token"];

function bannedWords(html: string): string[] {
	const text = html.replace(/GitHub/g, "");
	return BANNED.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(text));
}

function cookie(response: Response, name: string): string {
	const cookies = response.headers.getSetCookie?.() ?? [];
	const match = cookies.find((item) => item.startsWith(`${name}=`));
	return (match ?? "").split(";")[0] ?? "";
}

function keyPair(generated: CryptoKey | CryptoKeyPair): CryptoKeyPair {
	if (!("privateKey" in generated)) throw new Error("expected a key pair");
	return generated;
}

function git(dir: string, args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function bare(dir: string, args: string[]): string {
	return execFileSync("git", ["--git-dir", dir, ...args], { encoding: "utf8" });
}

describe("backup rules", () => {
	const off = { membersCanPublish: false, suspended: false };

	it("lets only an Admin download, back up, and restore, including a read-only workspace", () => {
		const admin = {
			actor: { kind: "person" as const, removedAt: null },
			role: "admin" as const,
			settings: off,
		};
		const member = { ...admin, role: "member" as const };
		const agent = { ...admin, actor: { kind: "agent" as const, removedAt: null } };
		for (const action of ["export", "mirror", "restore"] as Action[]) {
			expect(permit({ ...admin, action }).ok).toBe(true);
			expect(permit({ ...admin, action, settings: { ...off, suspended: true } }).ok).toBe(true);
			expect(permit({ ...member, action }).ok).toBe(false);
			expect(permit({ ...agent, action }).ok).toBe(false);
		}
	});

	it("says when a backup last succeeded", () => {
		const now = new Date("2026-10-03T12:00:00.000Z");
		expect(lastBackedUp(new Date(now.getTime() - 180_000).toISOString(), now)).toBe("Last backed up 3 minutes ago");
	});

	it("never asks for a public repository", () => {
		const body = privateRepositoryBody(" Northwind notes ");
		expect(body).toEqual({ name: "Northwind-notes", private: true, auto_init: false });
		expect(JSON.stringify(body)).not.toContain("public");
		expect(canCreateRepository({ contents: "write" } as { administration?: string })).toBe(false);
		expect(canCreateRepository({ administration: "write" })).toBe(true);
	});

	it("asks the GitHub App for contents write only", () => {
		const manifest = JSON.parse(readFileSync(new URL("../docs/github-app-manifest.json", import.meta.url), "utf8")) as {
			public: boolean;
			default_permissions: Record<string, string>;
			redirect_url: string;
		};
		expect(manifest.public).toBe(false);
		expect(manifest.default_permissions).toEqual({ contents: "write" });
		expect(manifest.redirect_url).toBe("https://stylebook.dev/backups/github/setup");
	});

	it("signs a GitHub App token from a PKCS#1 key and a PKCS#8 key", async () => {
		const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
		const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
		const now = 1_700_000_000;
		for (const pem of [pkcs1, pkcs8]) {
			const token = await githubAppJwt("4242", pem, now);
			const [header, payload, signature] = token.split(".");
			expect(header && payload && signature).toBeTruthy();
			const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as { iss: string; iat: number; exp: number };
			expect(claims).toEqual({ iss: "4242", iat: now - 60, exp: now + 9 * 60 });
			const verify = createVerify("RSA-SHA256");
			verify.update(`${header}.${payload}`);
			verify.end();
			expect(verify.verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);
		}
	});

	it("encrypts a backup secret so the stored value is not the secret", async () => {
		const sealed = await sealSecret("backup-key-for-tests", MIRROR_SECRET);
		expect(sealed.startsWith("v1.")).toBe(true);
		expect(sealed).not.toContain(MIRROR_SECRET);
		expect(await openSecret("backup-key-for-tests", sealed)).toBe(MIRROR_SECRET);
	});

	it("packs a folder and refuses a path that climbs out", () => {
		const packed = zipStore([{ name: "Northwind/HISTORY.md", data: new TextEncoder().encode("history") }]);
		expect(unzipStore(packed, 1000)).toEqual([
			{ name: "Northwind/HISTORY.md", data: new TextEncoder().encode("history") },
		]);
		expect(() => unzipStore(new Uint8Array([1, 2, 3]), 1000)).toThrow(NOT_A_BACKUP);
		expect(() => unzipStore(packed, 2)).toThrow(UPLOAD_TOO_BIG);
	});
});

describe("download, mirror, and restore", () => {
	let workspace: FakeWorkspace;
	let db: D1Database;
	let origin = "";
	let close: () => Promise<void> = async () => {};
	let privateKey: CryptoKey;
	let adminCookie = "";
	let memberCookie = "";
	let library = "";
	let workspaceId = "";
	let agentKey = "";
	let mirror: GitServer;
	let mirrorRoot = "";
	const env: Env = {
		WORKSPACE: {} as Artifacts,
		DB: {} as D1Database,
		SUGGESTIONS: {} as Env["SUGGESTIONS"],
		ARRIVALS: {} as Env["ARRIVALS"],
		DEMO_KEY: "secret",
		SIGN_IN: "access",
		TEAM_DOMAIN: TEAM,
		POLICY_AUD: AUD,
		MAX_WORKSPACES_PER_EMAIL: "5",
		MAX_WORKSPACES_PER_IP_PER_DAY: "5",
		MAX_BACKUP_BYTES: "20000000",
		MAX_BACKUP_UPLOAD_BYTES: "20000000",
		BACKUP_KEY: "backup-key-for-tests",
		EMAIL: { async send() { throw new Error("email links are switched off"); } },
	};

	beforeAll(async () => {
		const pair = keyPair(
			await crypto.subtle.generateKey(
				{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
				true,
				["sign", "verify"],
			),
		);
		privateKey = pair.privateKey;
		const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
		env.ACCESS_JWKS = JSON.stringify({ keys: [{ ...jwk, kid: "test", alg: "RS256", use: "sig" }] });
		workspace = await FakeWorkspace.start();
		db = memoryD1();
		env.WORKSPACE = workspace.binding;
		env.DB = db;
		const server = await serveWorker(env);
		origin = server.url;
		close = server.close;
		mirrorRoot = mkdtempSync(join(tmpdir(), "stylebook-mirror-"));
		mirror = await startGitServer(mirrorRoot, (_repo, _needs, secret) => secret === MIRROR_SECRET);
	});

	afterAll(async () => {
		await close();
		await mirror.close();
		await workspace.stop();
		rmSync(mirrorRoot, { recursive: true, force: true });
	});

	async function jwt(email: string): Promise<string> {
		return signAccessJwt(privateKey, "test", {
			email,
			iss: TEAM,
			aud: AUD,
			exp: Math.floor(Date.now() / 1000) + 600,
		});
	}

	function noticeOf(response: Response): string {
		const location = response.headers.get("Location") ?? "";
		return new URL(location, origin).searchParams.get("notice") ?? "";
	}

	function form(path: string, body: string, session = ""): Promise<Response> {
		return fetch(`${origin}${path}`, {
			method: "POST",
			redirect: "manual",
			headers: {
				...(session ? { Cookie: session } : {}),
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body,
		});
	}

	async function enter(email: string): Promise<Response> {
		return fetch(`${origin}/enter`, {
			redirect: "manual",
			headers: { "Cf-Access-Jwt-Assertion": await jwt(email) },
		});
	}

	function bareRepo(name: string): string {
		const dir = join(mirrorRoot, `${name}.git`);
		execFileSync("git", ["init", "--bare", "-b", "main", dir], { stdio: "ignore" });
		bare(dir, ["config", "http.receivepack", "true"]);
		const work = mkdtempSync(join(tmpdir(), "stylebook-seed-"));
		try {
			execFileSync("git", ["init", "-b", "main", work], { stdio: "ignore" });
			git(work, ["config", "user.name", "Seed"]);
			git(work, ["config", "user.email", "seed@example.com"]);
			writeFileSync(join(work, "README"), "seed\n");
			git(work, ["add", "README"]);
			git(work, ["commit", "-m", "seed"]);
			// A local path, so this does not wait on the test's own HTTP server.
			git(work, ["push", dir, "HEAD:refs/heads/main"]);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
		return dir;
	}

	function ref(dir: string, name: string): string {
		try {
			return bare(dir, ["rev-parse", name]).trim();
		} catch {
			return "";
		}
	}

	async function publish(path: string, content: string, message: string, note: string | null, repoName = library) {
		const repo = await workspace.binding.get(repoName);
		const access = await writeAccess(repo);
		return publishFile({
			remote: access.remote,
			token: access.token,
			path,
			content,
			message,
			author: { name: "Ada North", email: ADMIN_EMAIL },
			hasHistory: true,
			note: note ? { text: note } : undefined,
		});
	}

	it("opens a workspace and keeps Backups on the Admin menu", async () => {
		const arrived = await enter(ADMIN_EMAIL);
		const seen = cookie(arrived, "stylebook_seen");
		const started = await form("/start", "workspace=Northwind", seen);
		expect(started.status).toBe(303);
		adminCookie = cookie(started, "stylebook");
		const home = await fetch(`${origin}/`, { headers: { Cookie: adminCookie } });
		const homeHtml = await home.text();
		expect(homeHtml).toContain('href="/backups">Backups</a>');
		expect(homeHtml).toContain("Interview to draft");
		const row = await db
			.prepare(`SELECT id FROM workspaces WHERE name = ?1 AND deleted_at IS NULL`)
			.bind("Northwind")
			.first<{ id: string }>();
		workspaceId = row?.id ?? "";
		library = `${workspaceId}-library`;
		expect(library.endsWith("-library")).toBe(true);

		await form("/invite", `email=${encodeURIComponent(MEMBER_EMAIL)}&role=member`, adminCookie);
		const memberArrived = await enter(MEMBER_EMAIL);
		const memberSeen = cookie(memberArrived, "stylebook_seen");
		const joined = await form("/join", `workspace=${encodeURIComponent(workspaceId)}`, memberSeen);
		memberCookie = cookie(joined, "stylebook");
		const memberHome = await fetch(`${origin}/`, { headers: { Cookie: memberCookie } });
		const memberHtml = await memberHome.text();
		expect(memberHtml).not.toContain('href="/backups"');
	});

	it("shows Admins the backup page and members one sentence", async () => {
		const admin = await fetch(`${origin}/backups`, { headers: { Cookie: adminCookie } });
		expect(admin.status).toBe(200);
		const html = await admin.text();
		expect(html).toContain("Download");
		expect(html).toContain("Include open suggestions");
		expect(html).not.toContain('name="suggestions" value="yes" checked');
		expect(html).toContain("GitHub backups are not set up on this server yet.");
		expect(html).toContain("Back up to another service");
		expect(html).toContain("Restore");
		expect(html).toContain('href="/backups">Backups</a>');
		expect(bannedWords(html)).toEqual([]);
		expect(html).not.toContain(ADMIN_EMAIL);

		const member = await fetch(`${origin}/backups`, { headers: { Cookie: memberCookie } });
		expect(member.status).toBe(200);
		const memberHtml = await member.text();
		expect(memberHtml).toContain(BACKUP_ADMIN_LINE);
		expect(memberHtml).not.toContain('action="/backups/download"');
		expect(memberHtml).not.toContain('href="/backups"');
		expect(bannedWords(memberHtml)).toEqual([]);
	});

	it("refuses every backup route for a member and an agent", async () => {
		const connected = await form("/agents", "name=Cursor&tool=cursor", adminCookie);
		const connectedHtml = await connected.text();
		agentKey = connectedHtml.match(/<code>([^<]+)<\/code>/)?.[1] ?? "";
		expect(agentKey.length).toBeGreaterThan(20);
		for (const path of BACKUP_POSTS) {
			const member = await form(path, "suggestions=yes&keep=yes&name=Nope&address=http://127.0.0.1/no.git&secret=not-a-real-secret", memberCookie);
			expect(member.status, path).toBe(403);
			expect(await member.text()).toContain(BACKUP_ADMIN_LINE);
			const agent = await fetch(`${origin}${path}`, {
				method: "POST",
				headers: { Authorization: `Bearer ${agentKey}`, "Content-Type": "application/x-www-form-urlencoded" },
				body: "name=Nope",
			});
			expect(agent.status, path).toBe(403);
		}
		const agentGet = await fetch(`${origin}/backups`, { headers: { Authorization: `Bearer ${agentKey}` } });
		expect(agentGet.status).toBe(200);
		expect(await agentGet.text()).toContain(BACKUP_ADMIN_LINE);
	});

	it("downloads a folder that is also the full history, with no secrets", async () => {
		const skill = readFileSync(new URL("../sample-library/skills/interview-to-draft/SKILL.md", import.meta.url), "utf8");
		const note = editionNote({
			actor: "Cursor",
			onBehalfOf: "Ada North",
			model: "cursor",
			runId: "run-1",
			intent: "Tighten the opening.",
		});
		await publish("skills/interview-to-draft/SKILL.md", `${skill}\nA second edition line.\n`, "Tighten the opening.", note);
		const person = await db
			.prepare(`SELECT id FROM actors WHERE workspace_id = ?1 AND email = ?2`)
			.bind(workspaceId, ADMIN_EMAIL)
			.first<{ id: string }>();
		const copyName = suggestionName(workspaceId, person?.id ?? "", "backup");
		const libraryRepo = await workspace.binding.get(library);
		await ensureSuggestion(workspace.binding, libraryRepo, copyName);
		await publish(
			"skills/interview-to-draft/SKILL.md",
			`${skill}\nA suggested line.\n`,
			"Suggest a clearer opening.",
			editionNote({
				actor: "Cursor",
				onBehalfOf: "Ada North",
				model: "cursor",
				runId: "run-2",
				intent: "Offer a clearer opening.",
			}),
			copyName,
		);

		const response = await form("/backups/download", "suggestions=yes", adminCookie);
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("application/zip");
		const filename = response.headers.get("Content-Disposition") ?? "";
		expect(filename).toMatch(/Northwind-\d{4}-\d{2}-\d{2}\.zip/);
		const bytes = new Uint8Array(await response.arrayBuffer());
		const text = Buffer.from(bytes).toString("utf8");
		expect(text).not.toContain(ADMIN_EMAIL);
		expect(text).not.toContain(MEMBER_EMAIL);
		expect(text).not.toContain("stylebook.invalid");
		expect(text).not.toContain(agentKey);
		const session = decodeURIComponent(adminCookie.slice("stylebook=".length));
		expect(text).not.toContain(session);
		expect(text).not.toContain("art_v1_");
		expect(text).not.toContain("sbk_");

		const dir = mkdtempSync(join(tmpdir(), "stylebook-zip-"));
		const zipPath = join(dir, "backup.zip");
		writeFileSync(zipPath, bytes);
		execFileSync("python3", ["-c", "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", zipPath, dir]);
		const folder = join(dir, filename.match(/filename="([^"]+)"/)?.[1]?.replace(/\.zip$/, "") ?? "");
		expect(readFileSync(join(folder, "HISTORY.md"), "utf8")).toContain("Tighten the opening.");
		expect(readFileSync(join(folder, "HISTORY.md"), "utf8")).toContain("Written by Cursor for Ada North");
		expect(readFileSync(join(folder, "HISTORY.md"), "utf8")).toContain("Suggestion 1");
		expect(readFileSync(join(folder, "people.md"), "utf8")).toContain("Ada North, Admin");
		expect(readFileSync(join(folder, "people.md"), "utf8")).toContain("Member North, Member");
		expect(readFileSync(join(folder, "people.md"), "utf8")).not.toContain("@");
		const about = readFileSync(join(folder, "ABOUT-THIS-BACKUP.md"), "utf8");
		expect(about).toContain("Stylebook backup");
		expect(about).toContain("git log");
		expect(about).toContain("git notes --ref=stylebook");
		expect(readFileSync(join(folder, "suggestions/1/NOTE.md"), "utf8")).toContain("Offer a clearer opening.");

		const messages = git(folder, ["log", "--format=%s"]);
		expect(messages).toContain("Tighten the opening.");
		expect(messages).toContain("Add the team's skills, workflows and connections.");
		expect(git(folder, ["rev-list", "--count", "HEAD"]).trim()).toBe("2");
		const tip = git(folder, ["rev-parse", "HEAD"]).trim();
		expect(git(folder, ["notes", "--ref=stylebook", "show", tip])).toContain("Tighten the opening.");
		const identities = git(folder, ["log", "--all", "--format=%ae %ce"]);
		for (const line of identities.split("\n").filter(Boolean)) {
			expect(line).toBe("backup backup");
		}
		expect(git(folder, ["ls-files"])).not.toContain("HISTORY.md");

		const plain = await form("/backups/download", "", adminCookie);
		const plainText = Buffer.from(await plain.arrayBuffer()).toString("utf8");
		expect(plainText).not.toContain("suggestions/1/NOTE.md");

		const audit = await db
			.prepare(`SELECT action, detail FROM workspace_audit WHERE workspace_id = ?1 AND action = 'download' ORDER BY id`)
			.bind(workspaceId)
			.all<{ action: string; detail: string }>();
		expect((audit.results ?? []).length).toBeGreaterThan(0);
		expect(audit.results?.at(-1)?.detail).toMatch(/Downloaded\. \d+ bytes in \d+ ms\./);
		rmSync(dir, { recursive: true, force: true });
	}, 60_000);

	it("restores the download into a new workspace with the same files, editions, and notes", async () => {
		const downloaded = await form("/backups/download", "", adminCookie);
		const bytes = new Uint8Array(await downloaded.arrayBuffer());
		const before = workspace.git(library, "rev-parse", "refs/heads/main").trim();
		const data = new FormData();
		data.set("name", "Restored");
		data.set("file", new Blob([bytes], { type: "application/zip" }), "Northwind.zip");
		const restored = await fetch(`${origin}/backups/restore`, {
			method: "POST",
			redirect: "manual",
			headers: { Cookie: adminCookie },
			body: data,
		});
		expect(restored.status).toBe(303);
		expect(restored.headers.get("Location")).toContain("started from the backup");
		const nextCookie = cookie(restored, "stylebook");
		const home = await fetch(`${origin}/`, { headers: { Cookie: nextCookie } });
		expect(await home.text()).toContain("Restored");
		expect(workspace.git(library, "rev-parse", "refs/heads/main").trim()).toBe(before);

		const created = await db
			.prepare(`SELECT id FROM workspaces WHERE name = ?1 AND deleted_at IS NULL`)
			.bind("Restored")
			.first<{ id: string }>();
		const restoredLibrary = `${created?.id ?? ""}-library`;
		const names = workspace.git(library, "ls-tree", "-r", "--name-only", "refs/heads/main").trim().split("\n").filter(Boolean);
		const restoredNames = workspace.git(restoredLibrary, "ls-tree", "-r", "--name-only", "refs/heads/main").trim().split("\n").filter(Boolean);
		expect(restoredNames).toEqual(names);
		for (const path of names) {
			expect(workspace.git(restoredLibrary, "show", `refs/heads/main:${path}`)).toBe(
				workspace.git(library, "show", `refs/heads/main:${path}`),
			);
		}
		expect(workspace.git(restoredLibrary, "rev-list", "--count", "refs/heads/main").trim()).toBe(
			workspace.git(library, "rev-list", "--count", "refs/heads/main").trim(),
		);
		const originalTip = workspace.git(library, "rev-parse", "refs/heads/main").trim();
		const restoredTip = workspace.git(restoredLibrary, "rev-parse", "refs/heads/main").trim();
		expect(workspace.git(restoredLibrary, "notes", "--ref=stylebook", "show", restoredTip).trim()).toBe(
			workspace.git(library, "notes", "--ref=stylebook", "show", originalTip).trim(),
		);
		const people = await db
			.prepare(`SELECT role FROM actors WHERE workspace_id = ?1 AND removed_at IS NULL`)
			.bind(created?.id ?? "")
			.all<{ role: string }>();
		expect(people.results).toEqual([{ role: "admin" }]);
		const audit = await db
			.prepare(`SELECT actor_name, action FROM workspace_audit WHERE action = 'restore' ORDER BY id`)
			.bind()
			.all<{ actor_name: string; action: string }>();
		expect((audit.results ?? []).length).toBeGreaterThan(0);
	}, 60_000);

	it("backs up to another service, keeps it current, and stops when the copy has diverged", async () => {
		const dir = bareRepo("other");
		const mainBefore = ref(dir, "refs/heads/main");
		expect(mainBefore).not.toBe("");
		const address = `${mirror.url}/other.git`;
		const saved = await form("/backups/other", `address=${encodeURIComponent(address)}&login=stylebook&secret=${MIRROR_SECRET}`, adminCookie);
		expect(saved.status).toBe(303);
		const row = await db
			.prepare(`SELECT token_cipher, address FROM backup_mirrors WHERE workspace_id = ?1 AND kind = 'other'`)
			.bind(workspaceId)
			.first<{ token_cipher: string; address: string }>();
		expect(row?.address).toBe(address);
		expect(row?.token_cipher ?? "").not.toContain(MIRROR_SECRET);
		expect(await openSecret(env.BACKUP_KEY ?? "", row?.token_cipher ?? "")).toBe(MIRROR_SECRET);

		const sent = await form("/backups/other/now", "", adminCookie);
		expect(sent.status).toBe(303);
		expect(noticeOf(sent)).toBe("Backed up.");
		expect(ref(dir, "refs/heads/main")).toBe(mainBefore);
		expect(ref(dir, "refs/heads/stylebook")).not.toBe("");
		const refs = bare(dir, ["show-ref"]).trim().split("\n");
		expect(refs.some((line) => line.endsWith(" refs/heads/stylebook"))).toBe(true);
		expect(refs.some((line) => line.endsWith(" refs/notes/stylebook"))).toBe(true);
		expect(refs.filter((line) => line.includes(" refs/heads/")).map((line) => line.split(" ").at(-1)).sort()).toEqual([
			"refs/heads/main",
			"refs/heads/stylebook",
		]);
		const mirroredTip = ref(dir, "refs/heads/stylebook");
		expect(bare(dir, ["notes", "--ref=stylebook", "show", mirroredTip])).toContain("Tighten the opening.");
		expect(bare(dir, ["rev-list", "--count", "refs/heads/stylebook"]).trim()).toBe(
			workspace.git(library, "rev-list", "--count", "refs/heads/main").trim(),
		);

		const page = await fetch(`${origin}/backups`, { headers: { Cookie: adminCookie } });
		const pageHtml = await page.text();
		expect(pageHtml).toContain("Last backed up");
		expect(pageHtml).not.toContain(MIRROR_SECRET);
		expect(bannedWords(pageHtml)).toEqual([]);

		const kept = await form("/backups/other/keep", "keep=yes", adminCookie);
		expect(noticeOf(kept)).toBe("This backup stays up to date.");
		const skill = workspace.git(library, "show", "refs/heads/main:skills/interview-to-draft/SKILL.md");
		const edition = await publish(
			"workflows/follow-up.md",
			"# Follow up\n\nSend the draft.\n",
			"Add a follow-up.",
			editionNote({
				actor: "Ada North",
				onBehalfOf: "Ada North",
				model: "person",
				runId: "run-3",
				intent: "Add a follow-up.",
			}),
		);
		const step = {
			async do(_name: string, callback: () => Promise<unknown>) {
				return callback();
			},
			async sleep() {},
		} as unknown as WorkflowStep;
		await new ArrivalWorkflow({} as ExecutionContext, env).run(
			{
				payload: { source: { repoName: library }, payload: { ref: "refs/heads/main", after: edition } },
				timestamp: new Date(),
				instanceId: "backup-keep-1",
				workflowName: "stylebook-arrival",
			},
			step,
		);
		expect(bare(dir, ["rev-list", "--count", "refs/heads/stylebook"]).trim()).toBe(
			workspace.git(library, "rev-list", "--count", "refs/heads/main").trim(),
		);
		expect(ref(dir, "refs/heads/main")).toBe(mainBefore);
		void skill;

		const stopped = await form("/backups/other/disconnect", "", adminCookie);
		expect(noticeOf(stopped)).toBe("Disconnected.");
		const countAfterDisconnect = bare(dir, ["rev-list", "--count", "refs/heads/stylebook"]).trim();
		await publish("workflows/follow-up.md", "# Follow up\n\nSend the draft tomorrow.\n", "Move the follow-up.", null);
		const stepAgain = {
			async do(_name: string, callback: () => Promise<unknown>) {
				return callback();
			},
			async sleep() {},
		} as unknown as WorkflowStep;
		await new ArrivalWorkflow({} as ExecutionContext, env).run(
			{
				payload: {
					source: { repoName: library },
					payload: { ref: "refs/heads/main", after: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
				},
				timestamp: new Date(),
				instanceId: "backup-keep-2",
				workflowName: "stylebook-arrival",
			},
			stepAgain,
		);
		expect(bare(dir, ["rev-list", "--count", "refs/heads/stylebook"]).trim()).toBe(countAfterDisconnect);

		const again = await form("/backups/other", `address=${encodeURIComponent(address)}&login=stylebook&secret=${MIRROR_SECRET}`, adminCookie);
		expect(again.status).toBe(303);
		const work = mkdtempSync(join(tmpdir(), "stylebook-diverge-"));
		git(work, ["clone", "--branch", "stylebook", dir, "."]);
		git(work, ["config", "user.name", "Outside"]);
		git(work, ["config", "user.email", "outside@example.com"]);
		writeFileSync(join(work, "OUTSIDE"), "outside\n");
		git(work, ["add", "OUTSIDE"]);
		git(work, ["commit", "-m", "outside"]);
		git(work, ["push", "origin", "HEAD:stylebook"]);
		const divergedTip = ref(dir, "refs/heads/stylebook");
		const refused = await form("/backups/other/now", "", adminCookie);
		expect(noticeOf(refused)).toBe(DIVERGED);
		expect(ref(dir, "refs/heads/stylebook")).toBe(divergedTip);
		expect(ref(dir, "refs/heads/main")).toBe(mainBefore);
		rmSync(work, { recursive: true, force: true });

		const actions = await db
			.prepare(`SELECT action FROM workspace_audit WHERE workspace_id = ?1 ORDER BY id`)
			.bind(workspaceId)
			.all<{ action: string }>();
		const names = (actions.results ?? []).map((item) => item.action);
		for (const action of ["mirror-connect", "mirror-now", "mirror-keep", "mirror-disconnect"]) {
			expect(names).toContain(action);
		}
	}, 90_000);

	it("sends a GitHub-shaped backup to the local stand-in and only to stylebook", async () => {
		const dir = bareRepo("standin");
		const mainBefore = ref(dir, "refs/heads/main");
		const address = `${mirror.url}/standin.git`;
		await saveMirror(db, workspaceId, {
			kind: "github",
			address,
			tokenCipher: await sealSecret(env.BACKUP_KEY ?? "", MIRROR_SECRET),
			installationId: null,
			login: "stylebook",
			keepCurrent: false,
		});
		const sent = await form("/backups/github/now", "", adminCookie);
		expect(noticeOf(sent)).toBe("Backed up.");
		expect(ref(dir, "refs/heads/main")).toBe(mainBefore);
		expect(ref(dir, "refs/heads/stylebook")).not.toBe("");
		expect(bare(dir, ["show-ref"]).includes("refs/heads/stylebook")).toBe(true);
		const heads = bare(dir, ["for-each-ref", "--format=%(refname)", "refs/heads"]).trim().split("\n");
		expect(heads.sort()).toEqual(["refs/heads/main", "refs/heads/stylebook"]);
	}, 60_000);

	it("states the size cap and rejects a file that is not a backup", async () => {
		env.MAX_BACKUP_BYTES = "500";
		const tooBig = await form("/backups/download", "", adminCookie);
		expect(tooBig.status).toBe(303);
		expect(noticeOf(tooBig)).toBe(DOWNLOAD_TOO_BIG);
		env.MAX_BACKUP_BYTES = "20000000";

		env.MAX_BACKUP_UPLOAD_BYTES = "100";
		const data = new FormData();
		data.set("name", "Too big");
		data.set("file", new Blob([new Uint8Array(200)], { type: "application/zip" }), "big.zip");
		const oversized = await fetch(`${origin}/backups/restore`, {
			method: "POST",
			redirect: "manual",
			headers: { Cookie: adminCookie },
			body: data,
		});
		expect(noticeOf(oversized)).toBe(UPLOAD_TOO_BIG);
		env.MAX_BACKUP_UPLOAD_BYTES = "20000000";

		const junk = new FormData();
		junk.set("name", "Not a backup");
		junk.set("file", new Blob(["hello"], { type: "application/zip" }), "notes.zip");
		const rejected = await fetch(`${origin}/backups/restore`, {
			method: "POST",
			redirect: "manual",
			headers: { Cookie: adminCookie },
			body: junk,
		});
		expect(noticeOf(rejected)).toBe(NOT_A_BACKUP);
		const still = await db
			.prepare(`SELECT id FROM workspaces WHERE name = ?1`)
			.bind("Not a backup")
			.first<{ id: string }>();
		expect(still).toBeNull();
	});

	it("offers a download before a workspace is deleted", async () => {
		const people = await fetch(`${origin}/people`, { headers: { Cookie: adminCookie } });
		const html = await people.text();
		expect(html).toContain("Download first");
		expect(html).toContain("This removes the library, every suggestion, and everyone in the workspace.");
		expect(html).toContain('action="/backups/download"');
	});
});
