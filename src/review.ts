// The review screen: read the library, compare open suggestions, and publish
// one. Comparing and combining run here. Artifacts does not host either.
// https://developers.cloudflare.com/artifacts/api/workers-binding/
// https://developers.cloudflare.com/artifacts/concepts/best-practices/

import { allows, listActors, ownerOf, type Actor } from "./actors";
import { recordPush } from "./audit";
import {
	changedSections,
	combineChanges,
	merge3,
	proofLines,
	sameLinesConflict,
	suggestionNumber,
	withOverlapMarks,
	type ProofLine,
} from "./diff";
import type { Env } from "./env";
import { gatewayRemote } from "./gateway";
import { NOTES_REF, publishPrepared, publishSavedEdition } from "./git";
import { editionNote } from "./notes";
import { SAMPLE_FILES } from "./sample-files";
import { whoPublished } from "./who";
import {
	LIBRARY,
	ensureLibrary,
	ensureSuggestion,
	getRepo,
	listEditions,
	listPaths,
	listRepoNames,
	readBytes,
	suggestionName,
	type Edition,
} from "./workspace";

const PERSON_EMAIL = "person@stylebook.invalid";
const AGENT_EMAIL = "agent@stylebook.invalid";
const PATH_OK = /^[a-z0-9._/-]+$/i;
const NAME_OK = /^sug-[a-z0-9-]{1,58}$/;
const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

export class DeskError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
}

export interface DeskItem {
	path: string;
	title: string;
	group: "Skills" | "Workflows" | "Connections";
}

export interface DeskSuggestion {
	name: string;
	number: number;
	writer: string;
	owner: string;
	why: string;
	sections: string[];
	combined: boolean;
	actorId: string | null;
}

export interface DeskConflict {
	otherName: string;
	otherNumber: number;
	section: string;
	/** True when the other side is the current edition, not another suggestion. */
	current: boolean;
}

export interface DeskHistory {
	number: number;
	line: string;
}

export interface Desk {
	actorName: string;
	canPublish: boolean;
	editionNumber: number | null;
	publishedOn: string | null;
	items: DeskItem[];
	item: string | null;
	title: string;
	description: string;
	lines: ProofLine[];
	suggestions: DeskSuggestion[];
	overlaps: { number: number; section: string }[];
	conflict: DeskConflict | null;
	history: DeskHistory[];
	notice: string | null;
}

interface OpenSuggestion extends DeskSuggestion {
	text: string;
	base: string;
}

function spaces(env: Env): Artifacts[] {
	return env.REVIEW === env.WORKSPACE ? [env.REVIEW] : [env.REVIEW, env.WORKSPACE];
}

export function cleanPath(value: string | null): string | null {
	if (!value || value.length > 200 || value.includes("..") || value.startsWith("/")) return null;
	if (!PATH_OK.test(value)) return null;
	return value;
}

export function cleanName(value: string | null): string | null {
	if (!value || !NAME_OK.test(value)) return null;
	return value;
}

export function plainDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function decode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

async function readText(repo: ArtifactsRepo, path: string, ref = "main"): Promise<string | null> {
	try {
		const bytes = await readBytes(repo, path, ref);
		return bytes ? decode(bytes) : null;
	} catch {
		return null;
	}
}

function titleOf(path: string, text: string): string {
	for (const line of text.split("\n")) {
		if (line.startsWith("# ")) return line.slice(2).trim();
	}
	const base = path.split("/").pop() ?? path;
	return base.replace(/\.[a-z]+$/i, "").replace(/[-_]/g, " ");
}

function groupOf(path: string): DeskItem["group"] {
	if (path.startsWith("skills/")) return "Skills";
	if (path.startsWith("workflows/")) return "Workflows";
	return "Connections";
}

function descriptionOf(text: string): string {
	for (const line of text.split("\n")) {
		if (line.startsWith("description:")) return line.slice("description:".length).trim();
	}
	return "";
}

function historyLine(approver: string, writer: string | null, owner: string | null, when: string): string {
	const date = plainDate(when);
	if (writer && owner && writer !== approver) {
		return `Written by ${writer} for ${owner}, approved by ${approver}. ${date}.`;
	}
	return `Approved by ${approver}. ${date}.`;
}

async function declinedKeys(env: Env, actorId: string): Promise<Set<string>> {
	const rows = await env.DB.prepare(`SELECT repo_name, path FROM declines WHERE actor_id = ?1`)
		.bind(actorId)
		.all<{ repo_name: string; path: string }>();
	return new Set((rows.results ?? []).map((row) => `${row.repo_name}\n${row.path}`));
}

async function findRepo(env: Env, name: string): Promise<ArtifactsRepo | null> {
	for (const workspace of spaces(env)) {
		const repo = await getRepo(workspace, name);
		if (repo) return repo;
	}
	return null;
}

/**
 * A short-lived write token for the review library.
 *
 * `/git/library.git` is the earlier workspace's library. This library lives
 * in the review workspace, so the screen writes its remote directly and
 * records the person in the same audit table the Git route uses.
 */
async function reviewLibraryWrite(env: Env): Promise<{ remote: string; token: string }> {
	const library = await ensureLibrary(env.REVIEW);
	const [info, token] = await Promise.all([library.repo.info(), library.repo.createToken("write", 300)]);
	return { remote: info.remote, token: token.plaintext };
}

/** Publish the sample library as the first edition when the review library is empty. */
export async function ensureSampleLibrary(env: Env, person: Actor, key: string, origin: string): Promise<void> {
	if (!allows(person, LIBRARY, true)) return;
	const library = await ensureLibrary(env.REVIEW);
	const existing = await listEditions(library.repo, 1);
	if (existing.length > 0) return;
	const access = await reviewLibraryWrite(env);
	void key;
	void origin;
	const saved = await publishPrepared({
		remote: access.remote,
		token: access.token,
		author: { name: person.name, email: PERSON_EMAIL },
		hasHistory: false,
		prepare: async (tree) => {
			if (await tree.read("skills/interview-to-draft/SKILL.md")) {
				return { stop: "The library is already open." };
			}
			return {
				files: Object.entries(SAMPLE_FILES).map(([path, content]) => ({ path, content })),
				message: "Add the team's skills, workflows and connections.",
			};
		},
	});
	if ("edition" in saved) {
		await recordPush(env.DB, {
			repoName: LIBRARY,
			refName: "refs/heads/main",
			editionId: saved.edition,
			actor: person,
			owner: person,
			acceptedAt: new Date().toISOString(),
		});
	}
}

async function libraryFile(env: Env, path: string): Promise<{ text: string; editions: Edition[] }> {
	const library = await ensureLibrary(env.REVIEW);
	const editions = await listEditions(library.repo, 1000);
	const text = (await readText(library.repo, path)) ?? "";
	return { text, editions };
}

async function readOpenSuggestion(
	env: Env,
	workspace: Artifacts,
	name: string,
	path: string,
	libraryText: string,
): Promise<OpenSuggestion | null> {
	const repo = await getRepo(workspace, name);
	if (!repo) return null;
	const text = await readText(repo, path);
	if (text === null || text === libraryText) return null;
	const commits = await repo.log({ ref: "main", limit: 1 });
	const tip = commits[0];
	const parent = tip?.parents[0];
	const parentText = parent ? await readText(repo, path, parent) : null;
	const base = parentText ?? libraryText;
	const who = tip ? await whoPublished(env, tip.hash) : null;
	const why = who?.note?.intent ?? tip?.message ?? "A suggested change.";
	const writer = who?.note?.actor ?? who?.actor.name ?? "Someone";
	const owner = who?.note?.onBehalfOf ?? who?.owner.name ?? writer;
	return {
		name,
		number: suggestionNumber(name),
		writer,
		owner,
		why,
		sections: changedSections(base, text),
		combined: why.startsWith("Combined both changes"),
		actorId: who?.actor.id ?? null,
		text,
		base,
	};
}

async function openSuggestions(env: Env, actor: Actor, path: string, libraryText: string): Promise<OpenSuggestion[]> {
	const hidden = await declinedKeys(env, actor.id);
	const seen = new Set<string>();
	const pending: { workspace: Artifacts; name: string }[] = [];
	for (const workspace of spaces(env)) {
		let names: string[] = [];
		try {
			names = await listRepoNames(workspace);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.startsWith("sug-") || seen.has(name)) continue;
			seen.add(name);
			if (!allows(actor, name, false)) continue;
			if (hidden.has(`${name}\n${path}`)) continue;
			pending.push({ workspace, name });
		}
	}
	const found: OpenSuggestion[] = [];
	let cursor = 0;
	const width = Math.min(8, pending.length);
	await Promise.all(
		Array.from({ length: width }, async () => {
			while (cursor < pending.length) {
				const item = pending[cursor];
				cursor += 1;
				if (!item) return;
				try {
					const suggestion = await readOpenSuggestion(env, item.workspace, item.name, path, libraryText);
					if (suggestion) found.push(suggestion);
				} catch {
					// One copy that cannot be read does not blank the desk.
				}
			}
		}),
	);
	found.sort((a, b) => a.number - b.number || a.name.localeCompare(b.name));
	return found;
}

function overlapPairs(selected: OpenSuggestion, others: OpenSuggestion[], libraryText: string) {
	const overlaps: { number: number; section: string }[] = [];
	let conflict: DeskConflict | null = null;
	for (const other of others) {
		if (other.name === selected.name) continue;
		const shared = selected.sections.filter((section) => other.sections.includes(section));
		for (const section of shared) overlaps.push({ number: other.number, section });
		if (!conflict && sameLinesConflict(libraryText, selected.text, other.text)) {
			conflict = {
				otherName: other.name,
				otherNumber: other.number,
				section: shared[0] ?? selected.sections[0] ?? "this part",
				current: false,
			};
		}
	}
	return { overlaps, conflict };
}

function pageLines(libraryText: string, selected: OpenSuggestion | null, overlaps: OpenSuggestion[]): ProofLine[] {
	if (!selected) {
		return libraryText.split("\n").filter((line, index, all) => line !== "" || index < all.length - 1).map((text) => ({
			text,
			kind: "text" as const,
			section: null,
		}));
	}
	const tone = selected.combined ? "green" : "blue";
	let lines = proofLines(libraryText, selected.text, tone, selected.number);
	for (const other of overlaps) {
		const shared = selected.sections.filter((section) => other.sections.includes(section));
		if (shared.length === 0) continue;
		lines = withOverlapMarks(lines, libraryText, other.text, other.number, shared);
	}
	return lines;
}

async function historyOf(env: Env, editions: Edition[]): Promise<DeskHistory[]> {
	const total = editions.length;
	const lines: DeskHistory[] = [];
	for (let index = 0; index < Math.min(editions.length, 20); index++) {
		const edition = editions[index]!;
		const who = await whoPublished(env, edition.id);
		const approver = who?.actor.name ?? edition.author;
		const writer = who?.note?.actor ?? null;
		const owner = who?.note?.onBehalfOf ?? who?.owner.name ?? null;
		lines.push({
			number: total - index,
			line: historyLine(approver, writer, owner, who?.actor ? edition.savedAt : edition.savedAt),
		});
	}
	return lines;
}

export async function loadDesk(
	env: Env,
	actor: Actor,
	key: string,
	origin: string,
	item: string | null,
	suggestion: string | null,
	notice: string | null,
): Promise<Desk> {
	await ensureSampleLibrary(env, actor, key, origin);
	const library = await ensureLibrary(env.REVIEW);
	const paths = await listPaths(library.repo);
	const items: DeskItem[] = [];
	for (const path of paths) {
		const text = (await readText(library.repo, path)) ?? "";
		items.push({ path, title: titleOf(path, text), group: groupOf(path) });
	}
	const chosenPath =
		(item && items.some((entry) => entry.path === item) ? item : null) ??
		items.find((entry) => entry.path === "skills/interview-to-draft/SKILL.md")?.path ??
		items[0]?.path ??
		null;
	const { text: libraryText, editions } = chosenPath
		? await libraryFile(env, chosenPath)
		: { text: "", editions: await listEditions(library.repo, 1000) };
	const suggestions = chosenPath ? await openSuggestions(env, actor, chosenPath, libraryText) : [];
	const selected =
		suggestions.find((entry) => entry.name === suggestion) ?? suggestions[0] ?? null;
	const { overlaps, conflict } = selected
		? overlapPairs(selected, suggestions, libraryText)
		: { overlaps: [], conflict: null };
	let blocked = conflict;
	if (selected && !blocked) {
		const onto = merge3(selected.base, libraryText, selected.text);
		if (!onto.ok) {
			blocked = {
				otherName: "",
				otherNumber: 0,
				section: onto.sections[0] ?? "this part",
				current: true,
			};
		}
	}
	const overlapSources = selected
		? suggestions.filter((entry) => entry.name !== selected.name && overlaps.some((item) => item.number === entry.number))
		: [];
	const history = await historyOf(env, editions);
	const current = editions[0];
	return {
		actorName: actor.name,
		canPublish: allows(actor, LIBRARY, true),
		editionNumber: editions.length || null,
		publishedOn: current ? plainDate(current.savedAt) : null,
		items,
		item: chosenPath,
		title: chosenPath ? titleOf(chosenPath, libraryText) : "Library",
		description: descriptionOf(libraryText),
		lines: pageLines(libraryText, selected, overlapSources),
		suggestions: suggestions.map(({ text: _text, base: _base, ...rest }) => rest),
		overlaps,
		conflict: blocked,
		history,
		notice,
	};
}

async function agentFor(env: Env, person: Actor, preferredId: string | null): Promise<Actor> {
	const actors = await listActors(env.DB);
	const agents = actors.filter((actor) => actor.kind === "agent" && actor.ownerId === person.id);
	const preferred = preferredId ? agents.find((agent) => agent.id === preferredId) : null;
	const agent = preferred ?? agents[0];
	if (!agent) throw new DeskError("No agent works for you yet, so nothing was combined.");
	return agent;
}

async function writeLibrary(
	env: Env,
	person: Actor,
	key: string,
	origin: string,
	path: string,
	base: string,
	libraryText: string,
	suggestionText: string,
	prefer: "ours" | "theirs" | undefined,
	message: string,
	note: string | undefined,
): Promise<{ edition: string; noteCommit: string | null } | { stopped: string }> {
	const library = await ensureLibrary(env.REVIEW);
	const editions = await listEditions(library.repo, 1);
	const access = await reviewLibraryWrite(env);
	void key;
	void origin;
	return publishPrepared({
		remote: access.remote,
		token: access.token,
		author: { name: person.name, email: PERSON_EMAIL },
		hasHistory: editions.length > 0,
		prepare: async (tree) => {
			const current = (await tree.read(path)) ?? "";
			const merged = merge3(base, current, suggestionText, prefer);
			if (!merged.ok) {
				return {
					stop: "The library changed while this was publishing. Nothing was lost. Try again.",
				};
			}
			if (merged.text === current) return { stop: "This suggestion is already in the library." };
			// The base captured before the send can be older than `current`.
			// Re-merge from that base so an edition saved in between is kept.
			void libraryText;
			return {
				files: [{ path, content: merged.text }],
				message,
				note,
			};
		},
	});
}

function publishedNotice(editionNumber: number): string {
	return `Published as edition ${editionNumber}.`;
}

async function editionCount(env: Env): Promise<number> {
	const library = await ensureLibrary(env.REVIEW);
	return (await listEditions(library.repo, 1000)).length;
}

export async function publishSuggestion(
	env: Env,
	person: Actor,
	key: string,
	origin: string,
	name: string,
	path: string,
	mode: "publish" | "keep-this" | "keep-other",
): Promise<string> {
	if (!allows(person, LIBRARY, true)) throw new DeskError("This key cannot change the library.", 403);
	await ensureSampleLibrary(env, person, key, origin);
	const { text: libraryText } = await libraryFile(env, path);
	const suggestions = await openSuggestions(env, person, path, libraryText);
	const selected = suggestions.find((entry) => entry.name === name);
	if (!selected) throw new DeskError("That suggestion is not open.");
	const { conflict } = overlapPairs(selected, suggestions, libraryText);
	const onto = merge3(selected.base, libraryText, selected.text);
	// A combined suggestion is the resolution of the overlap it was made from.
	// Publishing it is the way out, so the sources still being open do not block it.
	const blocked = selected.combined
		? null
		: (conflict ?? (onto.ok ? null : { current: true, otherName: "", otherNumber: 0, section: onto.sections[0] ?? "this part" }));

	if (mode === "publish" && blocked) {
		const which = blocked.current ? "the current edition" : `Suggestion ${blocked.otherNumber}`;
		return `Nothing was published. These lines also changed in ${which}.`;
	}

	let target = selected;
	let prefer: "ours" | "theirs" | undefined = mode === "publish" ? undefined : "theirs";
	if (mode === "keep-other") {
		if (!conflict || conflict.current) return "Kept the current edition. Nothing new was published.";
		const other = suggestions.find((entry) => entry.name === conflict.otherName);
		if (!other) throw new DeskError("That suggestion is not open.");
		target = other;
		prefer = "theirs";
	}

	const who = target.actorId ? target : selected;
	const note = editionNote({
		actor: who.writer,
		onBehalfOf: who.owner,
		model: who.writer,
		runId: target.name,
		intent: who.why,
	});
	const saved = await writeLibrary(
		env,
		person,
		key,
		origin,
		path,
		target.base,
		libraryText,
		target.text,
		prefer,
		`Publish suggestion ${target.number}`,
		note,
	);
	if ("stopped" in saved) return saved.stopped;
	await recordPush(env.DB, {
		repoName: LIBRARY,
		refName: "refs/heads/main",
		editionId: saved.edition,
		actor: person,
		owner: person,
		acceptedAt: new Date().toISOString(),
	});
	if (saved.noteCommit) {
		await recordPush(env.DB, {
			repoName: LIBRARY,
			refName: NOTES_REF,
			editionId: saved.noteCommit,
			actor: person,
			owner: person,
			acceptedAt: new Date().toISOString(),
		});
	}
	const count = await editionCount(env);
	if (mode === "keep-this") return `Kept this one. ${publishedNotice(count)}`;
	if (mode === "keep-other") return `Kept the other. ${publishedNotice(count)}`;
	return publishedNotice(count);
}

export async function combineSuggestions(
	env: Env,
	person: Actor,
	origin: string,
	name: string,
	path: string,
): Promise<string> {
	if (!allows(person, LIBRARY, true)) throw new DeskError("This key cannot change the library.", 403);
	const { text: libraryText } = await libraryFile(env, path);
	const suggestions = await openSuggestions(env, person, path, libraryText);
	const selected = suggestions.find((entry) => entry.name === name);
	if (!selected) throw new DeskError("That suggestion is not open.");
	const { conflict } = overlapPairs(selected, suggestions, libraryText);
	const other = conflict && !conflict.current ? suggestions.find((entry) => entry.name === conflict.otherName) : null;
	const secondText = other?.text ?? libraryText;
	const secondNumber = other?.number ?? 0;
	const combined = combineChanges(libraryText, selected.text, secondText);
	const agent = await agentFor(env, person, selected.actorId);
	const owner = await ownerOf(env.DB, agent);
	const session = `combine-${selected.number}-${secondNumber}-${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;
	const copyName = suggestionName(agent.id, session);
	if (!allows(agent, copyName, true)) throw new DeskError("This key cannot change that copy.", 403);

	const library = await ensureLibrary(env.REVIEW);
	const suggestion = await ensureSuggestion(env.REVIEW, library.repo, copyName);
	const access = await suggestion.repo.createToken("write", 300);
	const info = await suggestion.repo.info();
	const why = `Combined both changes, in order, from Suggestion ${selected.number} and Suggestion ${secondNumber}.`;
	const saved = await publishSavedEdition({
		remote: info.remote,
		token: access.plaintext,
		path,
		content: combined,
		message: why,
		author: { name: agent.name, email: AGENT_EMAIL },
		hasHistory: true,
		note: {
			text: editionNote({
				actor: agent.name,
				onBehalfOf: owner.name,
				model: agent.model ?? agent.id,
				runId: copyName,
				intent: why,
			}),
		},
	});
	const acceptedAt = new Date().toISOString();
	await recordPush(env.DB, {
		repoName: copyName,
		refName: "refs/heads/main",
		editionId: saved.edition,
		actor: agent,
		owner,
		acceptedAt,
	});
	if (saved.noteCommit) {
		await recordPush(env.DB, {
			repoName: copyName,
			refName: NOTES_REF,
			editionId: saved.noteCommit,
			actor: agent,
			owner,
			acceptedAt,
		});
	}
	void origin;
	return copyName;
}

export async function declineSuggestion(env: Env, actor: Actor, name: string, path: string): Promise<void> {
	if (!allows(actor, name, false)) throw new DeskError("This key cannot open that copy.", 403);
	await env.DB.prepare(
		`INSERT OR REPLACE INTO declines (actor_id, repo_name, path, declined_at) VALUES (?1, ?2, ?3, ?4)`,
	)
		.bind(actor.id, name, path, new Date().toISOString())
		.run();
}

/** An agent saves one suggestion on a new copy of the review library. */
export async function saveAgentSuggestion(
	env: Env,
	agent: Actor,
	key: string,
	origin: string,
	input: { session: string; path: string; content: string; why: string },
): Promise<{ name: string; edition: string }> {
	if (agent.kind !== "agent") throw new DeskError("An agent key is required.", 403);
	const path = cleanPath(input.path);
	if (!path) throw new DeskError("That page is not in the library.");
	const why = input.why.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
	if (!why) throw new DeskError("Say why this suggestion was made.");
	if (input.content.length > 200_000) throw new DeskError("That page is too large.");
	const owner = await ownerOf(env.DB, agent);
	const name = suggestionName(agent.id, input.session);
	if (!allows(agent, name, true)) throw new DeskError("This key cannot change that copy.", 403);
	const library = await ensureLibrary(env.REVIEW);
	const existing = await listEditions(library.repo, 1);
	if (existing.length === 0) throw new DeskError("The library has no edition yet.");
	await ensureSuggestion(env.REVIEW, library.repo, name);
	const saved = await publishSavedEdition({
		remote: gatewayRemote(origin, name),
		token: key,
		path,
		content: input.content,
		message: why,
		author: { name: agent.name, email: AGENT_EMAIL },
		hasHistory: true,
		note: {
			text: editionNote({
				actor: agent.name,
				onBehalfOf: owner.name,
				model: agent.model ?? agent.id,
				runId: name,
				intent: why,
			}),
		},
	});
	return { name, edition: saved.edition };
}
