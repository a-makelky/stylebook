// A small set of open suggestions for the review screen. Two agents work for
// one person. One pair changes the same line of Steps. Another pair changes
// different parts of the same page, so they can be combined.

import { registerActor, type Actor } from "./actors";
import type { Env } from "./env";
import { ensureSampleLibrary, saveAgentSuggestion } from "./review";
import { SAMPLE_FILES } from "./sample-files";
import { workspaceById } from "./teams";
import { ensureLibrary, getRepo, libraryName, readBytes, suggestionName } from "./workspace";

const PERSON_ROLE = "editor";
const RESEARCHER_ROLE = "researcher";
const PROOFREADER_ROLE = "proofreader";

function roleId(workspaceId: string, role: string): string {
	return `${workspaceId.replace(/[^a-z0-9]/g, "").slice(0, 8)}${role}`.slice(0, 24);
}

interface SeedEdit {
	agentId: string;
	session: string;
	path: string;
	why: string;
	apply: (text: string) => string;
}

function replaceOnce(text: string, from: string, to: string): string {
	if (!text.includes(from)) return text;
	return text.replace(from, to);
}

const INTERVIEW = "skills/interview-to-draft/SKILL.md";
const RESEARCH = "skills/research-brief/SKILL.md";
const TRANSCRIPT = "skills/transcript-clean-up/SKILL.md";
const FEATURE = "workflows/feature-article.md";
const PITCH = "skills/pitch-deck-outline/SKILL.md";
const CONTRACT = "skills/contract-summary/SKILL.md";

const STEP = "1. Read the whole transcript before writing anything.";

/** Eleven open suggestions. The last two share a line of Steps. */
export const SEED_EDITS: SeedEdit[] = [
	{
		agentId: RESEARCHER_ROLE,
		session: "names",
		path: INTERVIEW,
		why: "Keep every name tied to the transcript.",
		apply: (text) =>
			replaceOnce(text, "## Never\n", "## Never\n\n- Do not guess a name the transcript does not spell.\n"),
	},
	{
		agentId: PROOFREADER_ROLE,
		session: "style",
		path: INTERVIEW,
		why: "Ask for the house style before the draft.",
		apply: (text) => replaceOnce(text, "- the target length\n", "- the target length\n- the house style for titles\n"),
	},
	{
		agentId: RESEARCHER_ROLE,
		session: "sources",
		path: RESEARCH,
		why: "Name the source in the sentence that uses it.",
		apply: (text) =>
			replaceOnce(
				text,
				"2. Find what is already settled. Prefer primary sources: the study, the filing, the dataset, the person's own words.",
				"2. Find what is already settled. Prefer primary sources: the study, the filing, the dataset, the person's own words. Name the source in the sentence.",
			),
	},
	{
		agentId: PROOFREADER_ROLE,
		session: "dates",
		path: RESEARCH,
		why: "A page without a date is not a source yet.",
		apply: (text) =>
			replaceOnce(text, "## Never\n", "## Never\n\n- Cite a page without the date it was published.\n"),
	},
	{
		agentId: RESEARCHER_ROLE,
		session: "pauses",
		path: TRANSCRIPT,
		why: "Keep a pause when it changes the answer.",
		apply: (text) =>
			replaceOnce(
				text,
				"6. Keep the speaker's own words, grammar and order. This is a clean-up, not an edit.",
				"6. Keep the speaker's own words, grammar and order. This is a clean-up, not an edit.\n7. When a pause changes the answer, write [long pause] and the timestamp.",
			),
	},
	{
		agentId: PROOFREADER_ROLE,
		session: "unclear",
		path: TRANSCRIPT,
		why: "An unclear speaker needs a timestamp, not a guess.",
		apply: (text) =>
			replaceOnce(
				text,
				'1. Label every speaker by name. If you are not sure who is speaking, write "Unclear speaker" and the timestamp.',
				'1. Label every speaker by name. If you are not sure who is speaking, write "Unclear speaker" and the timestamp. Do not pick the person who spoke most recently.',
			),
	},
	{
		agentId: RESEARCHER_ROLE,
		session: "handoff",
		path: FEATURE,
		why: "Name the assigning editor in the handoff note.",
		apply: (text) =>
			replaceOnce(
				text,
				"A person signs off steps 1, 5 and 6. Agents may do steps 3 and 4.",
				"A person signs off steps 1, 5 and 6. Agents may do steps 3 and 4.\n\nName the assigning editor in the handoff note.",
			),
	},
	{
		agentId: PROOFREADER_ROLE,
		session: "ask",
		path: PITCH,
		why: "The ask should be a sentence the client can repeat.",
		apply: (text) =>
			replaceOnce(
				text,
				"1. Write the ask as one sentence. Every slide has to earn its place against it.",
				"1. Write the ask as one sentence the client could repeat. Every slide has to earn its place against it.",
			),
	},
	{
		agentId: RESEARCHER_ROLE,
		session: "clauses",
		path: CONTRACT,
		why: "Quote the clause that is one-sided.",
		apply: (text) =>
			replaceOnce(
				text,
				"3. Flag any clause that is one-sided, open-ended, or missing. Say why in one line.",
				"3. Flag any clause that is one-sided, open-ended, or missing. Quote it, and say why in one line.",
			),
	},
	{
		agentId: PROOFREADER_ROLE,
		session: "twice",
		path: INTERVIEW,
		why: "A second read catches a missed quote.",
		apply: (text) => replaceOnce(text, STEP, "1. Read the whole transcript twice before writing anything."),
	},
	{
		agentId: RESEARCHER_ROLE,
		session: "brief",
		path: INTERVIEW,
		why: "Start from the agreed brief.",
		apply: (text) => replaceOnce(text, STEP, "1. Read the brief, then the whole transcript before writing anything."),
	},
];

export interface SeedReport {
	ok: true;
	created: { name: string; path: string; why: string; writer: string }[];
	alreadyThere: string[];
}

export async function seedOpenSuggestions(
	env: Env,
	origin: string,
	input: { personKey: string; researcherKey: string; proofreaderKey: string; workspaceName?: string; workspaceId?: string },
): Promise<SeedReport> {
	const wantedName = input.workspaceName?.trim() || "Demo";
	const wantedId = input.workspaceId?.trim() || "demo";
	let workspace = await workspaceById(env.DB, wantedId);
	if (!workspace) {
		if (!/^[a-z][a-z0-9]{2,15}$/.test(wantedId)) throw new Error("Workspace id must be a short lowercase name.");
		await env.DB.prepare(`INSERT INTO workspaces (id, name, created_at) VALUES (?1, ?2, ?3)`)
			.bind(wantedId, wantedName, new Date().toISOString())
			.run();
		workspace = { id: wantedId, name: wantedName };
	}
	const person = await registerActor(env.DB, {
		id: roleId(workspace.id, PERSON_ROLE),
		kind: "person",
		name: "Editor",
		workspaceId: workspace.id,
		email: "editor@stylebook.invalid",
		key: input.personKey,
	});
	const researcher = await registerActor(env.DB, {
		id: roleId(workspace.id, RESEARCHER_ROLE),
		kind: "agent",
		name: "Researcher",
		workspaceId: workspace.id,
		ownerId: person.id,
		model: "researcher",
		key: input.researcherKey,
	});
	const proofreader = await registerActor(env.DB, {
		id: roleId(workspace.id, PROOFREADER_ROLE),
		kind: "agent",
		name: "Proofreader",
		workspaceId: workspace.id,
		ownerId: person.id,
		model: "proofreader",
		key: input.proofreaderKey,
	});
	const agents = new Map<string, { actor: Actor; key: string }>([
		[RESEARCHER_ROLE, { actor: researcher, key: input.researcherKey }],
		[PROOFREADER_ROLE, { actor: proofreader, key: input.proofreaderKey }],
	]);

	await ensureSampleLibrary(env, person, input.personKey, origin);
	const library = await ensureLibrary(env.WORKSPACE, workspace.id);

	const created: SeedReport["created"] = [];
	const alreadyThere: string[] = [];
	for (const edit of SEED_EDITS) {
		const bytes = await readBytes(library.repo, edit.path);
		const source = bytes ? new TextDecoder().decode(bytes) : SAMPLE_FILES[edit.path];
		if (!source) continue;
		const content = edit.apply(source);
		if (content === source) continue;
		const holder = agents.get(edit.agentId);
		if (!holder) continue;
		const name = suggestionName(workspace.id, holder.actor.id, edit.session);
		if (await getRepo(env.WORKSPACE, name)) {
			alreadyThere.push(name);
			continue;
		}
		const saved = await saveAgentSuggestion(env, holder.actor, holder.key, origin, {
			session: edit.session,
			path: edit.path,
			content,
			why: edit.why,
		});
		created.push({ name: saved.name, path: edit.path, why: edit.why, writer: holder.actor.name });
	}
	return { ok: true, created, alreadyThere };
}
