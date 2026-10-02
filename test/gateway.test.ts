import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allows, listActors, registerActor, type Actor } from "../src/actors";
import { auditSince } from "../src/audit";
import type { Env } from "../src/env";
import { acceptedUpdates, parseReceivePackCommands, type RefUpdate } from "../src/gateway";
import worker from "../src/index";
import { publishDirect } from "../src/bypass";
import { publishFile } from "../src/git";
import { editionNote, parseEditionNote } from "../src/notes";
import { STARTER_SKILL, STARTER_SKILL_PATH } from "../src/seed";
import { ensureLibrary, ensureSuggestion, suggestionName, LIBRARY } from "../src/workspace";
import { ArrivalWorkflow } from "../src/workflows";
import type { WorkflowStep } from "cloudflare:workers";
import { FakeWorkspace } from "./fake-artifacts";
import { memoryD1 } from "./memory-d1";
import { serveWorker } from "./serve";

const run = promisify(execFile);
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

const PERSON_KEY = "test-person-key-0001";
const CURSOR_KEY = "test-cursor-key-0001";
const CODEX_KEY = "test-codex-key-0001";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const ZERO = "0".repeat(40);

const editor: Actor = { id: "editor", kind: "person", name: "Aaron", ownerId: null, model: null };
const cursor: Actor = { id: "cursor", kind: "agent", name: "Cursor", ownerId: "editor", model: "cursor" };
const codex: Actor = { id: "codex", kind: "agent", name: "Codex", ownerId: "editor", model: "codex" };

function pkt(line: string): Uint8Array {
	const data = new TextEncoder().encode(line);
	const size = (data.byteLength + 4).toString(16).padStart(4, "0");
	const bytes = new Uint8Array(data.byteLength + 4);
	bytes.set(new TextEncoder().encode(size));
	bytes.set(data, 4);
	return bytes;
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

describe("who may use a copy", () => {
	it("keeps a person and two agents with the same owner distinct", () => {
		expect(new Set([editor.id, cursor.id, codex.id]).size).toBe(3);
		expect(cursor.ownerId).toBe(editor.id);
		expect(codex.ownerId).toBe(editor.id);
		expect(cursor.id).not.toBe(codex.id);
	});

	it("lets an agent read the library and write only its own copies", () => {
		expect(allows(cursor, LIBRARY, false)).toBe(true);
		expect(allows(cursor, LIBRARY, true)).toBe(false);
		expect(allows(cursor, suggestionName("cursor", "one"), true)).toBe(true);
		expect(allows(cursor, suggestionName("codex", "one"), false)).toBe(false);
		expect(allows(cursor, suggestionName("codex", "one"), true)).toBe(false);
		expect(allows(editor, LIBRARY, true)).toBe(true);
		expect(allows(editor, suggestionName("cursor", "one"), false)).toBe(true);
		expect(allows(editor, suggestionName("cursor", "one"), true)).toBe(false);
	});

	it("does not let one actor id open copies whose actor id merely starts with it", async () => {
		const agentA: Actor = { id: "a", kind: "agent", name: "A", ownerId: "editor", model: "m" };
		expect(allows(agentA, "sug-a-run-001", true)).toBe(true);
		expect(allows(agentA, "sug-a-b-run-001", true)).toBe(true);
		const agentAB: Actor = { id: "a-b", kind: "agent", name: "AB", ownerId: "editor", model: "m" };
		expect(allows(agentAB, "sug-a-b-run-001", true)).toBe(false);
		const db = memoryD1();
		await registerActor(db, { id: "editor", kind: "person", name: "Editor", key: PERSON_KEY });
		await expect(
			registerActor(db, { id: "a-b", kind: "agent", name: "AB", ownerId: "editor", model: "m", key: CURSOR_KEY }),
		).rejects.toThrow(/letters and digits/);
	});

	it("parses a receive-pack command and ignores a rejected ref", () => {
		const body = concat([
			pkt(`${ZERO} ${SHA} refs/heads/main\0 report-status\n`),
			pkt("0000"),
		]);
		const updates = parseReceivePackCommands(body);
		expect(updates).toEqual([{ oldId: ZERO, newId: SHA, refName: "refs/heads/main" }]);
		const report = new TextEncoder().encode("000eunpack ok\n0019ok refs/heads/main\n0000");
		expect(acceptedUpdates(report, updates).map((update: RefUpdate) => update.refName)).toEqual([
			"refs/heads/main",
		]);
		const rejected = new TextEncoder().encode("000eunpack ok\n001dng refs/heads/main no\n0000");
		expect(acceptedUpdates(rejected, updates)).toEqual([]);
	});

	it("round-trips the note fields", () => {
		const text = editionNote({
			actor: "Cursor",
			onBehalfOf: "Aaron",
			model: "cursor",
			runId: "local",
			intent: "Tighten the opening",
		});
		expect(parseEditionNote(text)).toEqual({
			actor: "Cursor",
			onBehalfOf: "Aaron",
			model: "cursor",
			runId: "local",
			intent: "Tighten the opening",
		});
	});
});

describe("stock git through the route", () => {
	let workspace: FakeWorkspace;
	let db: D1Database;
	let env: Env;
	let origin = "";
	let close: () => Promise<void> = async () => {};

	beforeAll(async () => {
		workspace = await FakeWorkspace.start();
		db = memoryD1();
		await registerActor(db, { id: "editor", kind: "person", name: "Aaron", key: PERSON_KEY });
		await registerActor(db, {
			id: "cursor",
			kind: "agent",
			name: "Cursor",
			ownerId: "editor",
			model: "cursor",
			key: CURSOR_KEY,
		});
		await registerActor(db, {
			id: "codex",
			kind: "agent",
			name: "Codex",
			ownerId: "editor",
			model: "codex",
			key: CODEX_KEY,
		});
		env = {
			WORKSPACE: workspace.binding,
			DEMO_KEY: "secret",
			DB: db,
			SUGGESTIONS: { async create() { throw new Error("not used"); } } as unknown as Workflow,
			ARRIVALS: { async create() { throw new Error("not used"); } } as unknown as Workflow,
		};
		const server = await serveWorker(env);
		origin = server.url;
		close = server.close;
	});

	afterAll(async () => {
		await close();
		await workspace.stop();
	});

	function remote(repo: string, key: string): string {
		return `http://x:${key}@${origin.slice("http://".length)}/git/${repo}.git`;
	}

	async function git(dir: string, args: string[]): Promise<string> {
		const { stdout } = await run("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnv });
		return stdout;
	}

	it("clones and pushes with stock git, and a forged author stays the agent", async () => {
		const library = await ensureLibrary(workspace.binding);
		await publishFile({
			remote: remote(LIBRARY, PERSON_KEY),
			token: PERSON_KEY,
			path: STARTER_SKILL_PATH,
			content: STARTER_SKILL,
			message: "Add the interview-to-draft skill",
			author: { name: "Aaron", email: "editor@stylebook.invalid" },
			hasHistory: false,
		});
		const name = suggestionName("cursor", "stock");
		await ensureSuggestion(workspace.binding, library.repo, name);

		const dir = mkdtempSync(join(tmpdir(), "stylebook-clone-"));
		await run("git", ["clone", remote(name, CURSOR_KEY), dir], { env: gitEnv });
		await git(dir, ["config", "user.name", "Forged Name"]);
		await git(dir, ["config", "user.email", "forged@example.com"]);
		await run("sh", ["-c", `printf '\\nForged line.\\n' >> ${JSON.stringify(join(dir, STARTER_SKILL_PATH))}`]);
		await git(dir, ["add", STARTER_SKILL_PATH]);
		await git(dir, [
			"commit",
			"--author=Forged Name <forged@example.com>",
			"-m",
			"Pretend to be someone else",
		]);
		await git(dir, ["push", "origin", "HEAD:main"]);

		const edition = (await git(dir, ["rev-parse", "HEAD"])).trim();
		const author = workspace.git(name, "log", "-1", "--format=%an %ae").trim();
		expect(author).toBe("Forged Name forged@example.com");

		const recorded = await auditSince(db, "1970-01-01T00:00:00.000Z");
		const row = recorded.gateway.find((item) => item.editionId === edition);
		expect(row).toMatchObject({
			repoName: name,
			refName: "refs/heads/main",
			actorId: "cursor",
			actorName: "Cursor",
			ownerId: "editor",
			ownerName: "Aaron",
		});

		const whoResponse = await worker.fetch(
			new Request(`https://stylebook.test/who?edition=${edition}`, {
				headers: { Authorization: `Bearer ${CURSOR_KEY}` },
			}),
			env,
		);
		expect(whoResponse.status).toBe(200);
		const who = (await whoResponse.json()) as {
			actor: { id: string; name: string };
			owner: { id: string; name: string };
			note: unknown;
		};
		expect(who.actor).toEqual({ id: "cursor", name: "Cursor", kind: "agent", model: "cursor" });
		expect(who.owner).toEqual({ id: "editor", name: "Aaron", kind: "person" });
		expect(who.note).toBeNull();
		const body = JSON.stringify(who);
		expect(body).not.toContain(CURSOR_KEY);
		expect(body).not.toContain("art_v1_");
		expect(body).not.toContain("127.0.0.1");

		const listed = await worker.fetch(new Request("https://stylebook.test/demo/actors", {
			headers: { Authorization: "Bearer secret" },
		}), env);
		const actors = (await listed.json()) as { actors: { id: string; ownerId: string | null }[] };
		const ids = actors.actors.map((actor) => actor.id).sort();
		expect(ids).toEqual(["codex", "cursor", "editor"]);
		expect(actors.actors.filter((actor) => actor.ownerId === "editor")).toHaveLength(2);

		const libraryDir = mkdtempSync(join(tmpdir(), "stylebook-library-"));
		await run("git", ["clone", remote(LIBRARY, CURSOR_KEY), libraryDir], { env: gitEnv });
		await git(libraryDir, ["config", "user.name", "Cursor"]);
		await git(libraryDir, ["config", "user.email", "agent@stylebook.invalid"]);
		await run("sh", ["-c", `printf '\\nnope\\n' >> ${JSON.stringify(join(libraryDir, STARTER_SKILL_PATH))}`]);
		await git(libraryDir, ["add", STARTER_SKILL_PATH]);
		await git(libraryDir, ["commit", "-m", "Try to publish"]);
		await expectGitFailureArgs(
			["-C", libraryDir, "push", "origin", "HEAD:main"],
			"cannot change the library",
		);
		await expectGitFailure(remote(name, CODEX_KEY), "cannot open that copy");

		const step = {
			async do(_name: string, callback: () => Promise<unknown>) {
				return callback();
			},
			async sleep() {},
		} as unknown as WorkflowStep;
		const workflow = new ArrivalWorkflow({} as ExecutionContext, env);
		const confirmed = await workflow.run(
			{
				payload: {
					source: { repoName: name },
					payload: { ref: "refs/heads/main", after: edition },
				},
				timestamp: new Date(),
				instanceId: "confirm-1",
				workflowName: "stylebook-arrival",
			},
			step,
		);
		expect(confirmed).toMatchObject({ outcome: "confirmed" });
		const afterConfirm = await auditSince(db, "1970-01-01T00:00:00.000Z");
		expect(afterConfirm.gateway.find((item) => item.editionId === edition)?.confirmedAt).toBeTruthy();

		const bypass = await publishDirect(workspace.binding);
		const flagged = await workflow.run(
			{
				payload: {
					source: { repoName: bypass.name },
					payload: { ref: "refs/heads/main", after: bypass.edition },
				},
				timestamp: new Date(),
				instanceId: "flag-1",
				workflowName: "stylebook-arrival",
			},
			step,
		);
		expect(flagged).toMatchObject({ outcome: "flagged" });
		const unseen = await auditSince(db, "1970-01-01T00:00:00.000Z");
		expect(unseen.unseen.some((item) => item.editionId === bypass.edition)).toBe(true);
		expect(unseen.gateway.some((item) => item.editionId === bypass.edition)).toBe(false);
	}, 60_000);
});

async function expectGitFailure(url: string, message: string) {
	const dir = mkdtempSync(join(tmpdir(), "stylebook-denied-"));
	await expectGitFailureArgs(["clone", url, dir], message);
}

async function expectGitFailureArgs(args: string[], message: string) {
	let text = "";
	try {
		await run("git", args, { encoding: "utf8", env: gitEnv });
		text = "git succeeded";
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr ?? "";
		text = `${error instanceof Error ? error.message : ""} ${stderr}`;
	}
	expect(text).toContain(message);
}
