// A small set of open suggestions for the review screen. Two agents work for
// one person. One pair changes the same line of Steps. Another pair changes
// different parts of the same page, so they can be combined.

import { registerActor, type Actor } from "./actors";
import type { Env } from "./env";
import { ensureSampleLibrary, saveAgentSuggestion } from "./review";
import { SAMPLE_FILES } from "./sample-files";
import { ensureLibrary, getRepo, readBytes, suggestionName } from "./workspace";

const PERSON_ID = "editor";
const RESEARCHER_ID = "researcher";
const PROOFREADER_ID = "proofreader";

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
		agentId: RESEARCHER_ID,
		session: "names",
		path: INTERVIEW,
		why: "Keep every name tied to the transcript.",
		apply: (text) =>
			replaceOnce(text, "## Never\n", "## Never\n\n- Do not guess a name the transcript does not spell.\n"),
	},
	{
		agentId: PROOFREADER_ID,
		session: "style",
		path: INTERVIEW,
		why: "Ask for the house style before the draft.",
		apply: (text) => replaceOnce(text, "- the target length\n", "- the target length\n- the house style for titles\n"),
	},
	{
		agentId: RESEARCHER_ID,
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
		agentId: PROOFREADER_ID,
		session: "dates",
		path: RESEARCH,
		why: "A page without a date is not a source yet.",
		apply: (text) =>
			replaceOnce(text, "## Never\n", "## Never\n\n- Cite a page without the date it was published.\n"),
	},
	{
		agentId: RESEARCHER_ID,
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
		agentId: PROOFREADER_ID,
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
		agentId: RESEARCHER_ID,
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
		agentId: PROOFREADER_ID,
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
		agentId: RESEARCHER_ID,
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
		agentId: PROOFREADER_ID,
		session: "twice",
		path: INTERVIEW,
		why: "A second read catches a missed quote.",
		apply: (text) => replaceOnce(text, STEP, "1. Read the whole transcript twice before writing anything."),
	},
	{
		agentId: RESEARCHER_ID,
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
	input: { personKey: string; researcherKey: string; proofreaderKey: string },
): Promise<SeedReport> {
	const person = await registerActor(env.DB, {
		id: PERSON_ID,
		kind: "person",
		name: "Editor",
		key: input.personKey,
	});
	const researcher = await registerActor(env.DB, {
		id: RESEARCHER_ID,
		kind: "agent",
		name: "Researcher",
		ownerId: person.id,
		model: "researcher",
		key: input.researcherKey,
	});
	const proofreader = await registerActor(env.DB, {
		id: PROOFREADER_ID,
		kind: "agent",
		name: "Proofreader",
		ownerId: person.id,
		model: "proofreader",
		key: input.proofreaderKey,
	});
	const agents = new Map<string, { actor: Actor; key: string }>([
		[researcher.id, { actor: researcher, key: input.researcherKey }],
		[proofreader.id, { actor: proofreader, key: input.proofreaderKey }],
	]);

	await ensureSampleLibrary(env, person, input.personKey, origin);
	const library = await ensureLibrary(env.WORKSPACE);

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
		const name = suggestionName(holder.actor.id, edit.session);
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
