// Scripted improvements to the interview-to-draft skill. No hosted model:
// each session applies one of these by hand. The first 25 are the ones a
// content team would argue about in a review. Further ones exist so a larger
// run still changes real lines, and they stay distinct.

export type EditKind = "add" | "reword" | "remove";

export interface Edit {
	section: string;
	kind: EditKind;
	summary: string;
	apply(content: string): string | null;
}

interface EditDef {
	section: string;
	kind: EditKind;
	summary: string;
	apply(content: string): string | null;
}

function replaceOnce(content: string, from: string, to: string): string | null {
	if (content.includes(from)) return content.replace(from, to);
	// A retry finds the new wording already in place.
	if (content.includes(to)) return content;
	return null;
}

function removeOnce(content: string, text: string): string | null {
	if (!content.includes(text)) return content;
	return content.replace(text, "");
}

function insertUnder(content: string, heading: string, line: string): string | null {
	if (content.includes(line)) return content;
	const marker = `## ${heading}\n`;
	const start = content.indexOf(marker);
	const block = `${line}\n`;
	if (start === -1) {
		const section = `\n## ${heading}\n\n${block}`;
		const revision = content.indexOf("\n## Revision notes\n");
		if (revision === -1) return `${content.trimEnd()}\n${section}`;
		return `${content.slice(0, revision).trimEnd()}\n${section}${content.slice(revision)}`;
	}
	const bodyStart = start + marker.length;
	const next = content.indexOf("\n## ", bodyStart);
	const end = next === -1 ? content.length : next;
	const prefix = content.slice(0, end).replace(/\s*$/, "\n");
	const suffix = content.slice(end);
	return `${prefix}${block}${suffix.startsWith("\n") ? suffix : `\n${suffix}`}`;
}

function addStep(content: string, sentence: string): string | null {
	if (content.includes(sentence)) return content;
	const start = content.indexOf("## Steps\n");
	if (start === -1) return null;
	const next = content.indexOf("\n## ", start + 8);
	const end = next === -1 ? content.length : next;
	const section = content.slice(start, end);
	const numbers = [...section.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));
	const n = (numbers.length ? Math.max(...numbers) : 0) + 1;
	const prefix = content.slice(0, end).replace(/\s*$/, "\n");
	const suffix = content.slice(end);
	return `${prefix}${n}. ${sentence}\n${suffix.startsWith("\n") ? suffix : `\n${suffix}`}`;
}

const HANDCRAFTED: EditDef[] = [
	{
		section: "Steps",
		kind: "reword",
		summary: "Tell the writer to read the small talk, not only the answers.",
		apply: (content) =>
			replaceOnce(
				content,
				"1. Read the whole transcript before writing anything.",
				"1. Read the whole transcript, including the small talk, before writing anything.",
			),
	},
	{
		section: "Steps",
		kind: "reword",
		summary: "Make the pause before drafting explicit.",
		apply: (content) =>
			replaceOnce(
				content,
				"3. Propose a headline and a one-paragraph outline. Wait for the writer to confirm the angle.",
				"3. Propose a headline and a one-paragraph outline. Stop there until the writer confirms the angle.",
			),
	},
	{
		section: "Steps",
		kind: "add",
		summary: "Add a read-aloud pass before the draft is handed over.",
		apply: (content) =>
			addStep(
				content,
				"Read the draft aloud and cut any sentence that is neither the speaker's point nor the writer's angle.",
			),
	},
	{
		section: "Steps",
		kind: "remove",
		summary:
			"Drop the paraphrase reminder from the drafting step. The Never list already covers changing words inside quotes.",
		apply: (content) => removeOnce(content, " Mark paraphrase as paraphrase."),
	},
	{
		section: "Before you start",
		kind: "add",
		summary: "Ask for the name and title before drafting, so the first reference is right.",
		apply: (content) =>
			insertUnder(
				content,
				"Before you start",
				"- the spelling of the person's name, and the title they use",
			),
	},
	{
		section: "Before you start",
		kind: "reword",
		summary: "Ask what the reader already knows, not only who they are.",
		apply: (content) =>
			replaceOnce(
				content,
				"- who the piece is for",
				"- who the piece is for, and what they already know",
			),
	},
	{
		section: "Never",
		kind: "add",
		summary: "Forbid invented timestamps.",
		apply: (content) =>
			insertUnder(content, "Never", "- Guess a timestamp when the transcript does not show one."),
	},
	{
		section: "Before you start",
		kind: "remove",
		summary: "Take target length off the intake list. It belongs with the outline, not the first ask.",
		apply: (content) => removeOnce(content, "- the target length\n"),
	},
	{
		section: "Description",
		kind: "reword",
		summary: "Say in the description that quotes must be the person's own words.",
		apply: (content) =>
			replaceOnce(
				content,
				"Turn an interview transcript into a first article draft that quotes accurately.",
				"Turn an interview transcript into a first article draft. Quote only words the person said.",
			),
	},
	{
		section: "After the draft",
		kind: "add",
		summary: "Add a fact-check handoff after the draft.",
		apply: (content) =>
			insertUnder(
				content,
				"After the draft",
				"- List every number, name, and title in the draft and point each one back to a line in the transcript.",
			),
	},
	{
		section: "Voice",
		kind: "add",
		summary: "Add a voice check so the draft does not sand off how the person speaks.",
		apply: (content) =>
			insertUnder(
				content,
				"Voice",
				"- Keep the person's register. Do not make a careful speaker sound casual, or a casual speaker sound like a press release.",
			),
	},
	{
		section: "Steps",
		kind: "reword",
		summary: "Say that the draft is in the writer's voice, and that quotes stay word for word.",
		apply: (content) =>
			replaceOnce(
				content,
				"4. Write the draft. Every quote must appear in the transcript word for word.",
				"4. Write the draft in the writer's voice. Every quote must appear in the transcript word for word.",
			),
	},
	{
		section: "Steps",
		kind: "add",
		summary: "Add a step to flag unclear quotes instead of guessing.",
		apply: (content) =>
			addStep(content, "If a quote is unclear, flag it for the writer instead of guessing what was said."),
	},
	{
		section: "Never",
		kind: "reword",
		summary: "Name age as something the draft must not invent.",
		apply: (content) =>
			replaceOnce(
				content,
				"- Invent a quote, a number, or a detail about the person interviewed.",
				"- Invent a quote, a number, an age, or a detail about the person interviewed.",
			),
	},
	{
		section: "Before you start",
		kind: "add",
		summary: "Ask whether the conversation was on the record before any quote is used.",
		apply: (content) =>
			insertUnder(content, "Before you start", "- whether the person was speaking on the record"),
	},
	{
		section: "Steps",
		kind: "reword",
		summary: "Let the outline be as long as the piece needs, not one paragraph.",
		apply: (content) => replaceOnce(content, "a one-paragraph outline", "an outline of the piece"),
	},
	{
		section: "Steps",
		kind: "add",
		summary: "Add a step for the first reference and why a reader should care.",
		apply: (content) =>
			addStep(
				content,
				"Name the person on first reference and say, in the writer's words, why a reader should care.",
			),
	},
	{
		section: "Steps",
		kind: "remove",
		summary:
			"Remove the repeated instruction to copy quotes exactly. The drafting step already requires the words to match.",
		apply: (content) => removeOnce(content, " Copy them exactly."),
	},
	{
		section: "Checks",
		kind: "add",
		summary: "Add a number check the writer can do before editing.",
		apply: (content) =>
			insertUnder(
				content,
				"Checks",
				"- Check every number in the draft against the transcript before the draft is handed to the writer.",
			),
	},
	{
		section: "Never",
		kind: "reword",
		summary: "Say that grammar and filler words inside quotes stay as spoken.",
		apply: (content) =>
			replaceOnce(
				content,
				"- Tidy the wording inside quotation marks.",
				"- Change the wording inside quotation marks, including grammar and ums.",
			),
	},
	{
		section: "Before you start",
		kind: "add",
		summary: "Ask what must not be published before anything is drafted.",
		apply: (content) =>
			insertUnder(
				content,
				"Before you start",
				"- the words or claims the person does not want published",
			),
	},
	{
		section: "Description",
		kind: "remove",
		summary: "Shorten the description to the job itself and drop the usage sentence.",
		apply: (content) =>
			removeOnce(
				content,
				" Use when a writer has a transcript and an angle and needs a draft to edit.",
			),
	},
	{
		section: "Steps",
		kind: "add",
		summary: "Add a step for the quotes that were cut, and why.",
		apply: (content) => addStep(content, "List any quote you almost used and why you left it out."),
	},
	{
		section: "Voice",
		kind: "add",
		summary: "Keep terms of art in quotes and gloss them outside the quotation marks.",
		apply: (content) =>
			insertUnder(
				content,
				"Voice",
				"- If the person uses a term of art, keep it and gloss it in the writer's words. Do not swap it for a simpler word inside the quote.",
			),
	},
	{
		section: "Never",
		kind: "add",
		summary: "Spell out that quotes from different moments stay in separate quotation marks.",
		apply: (content) =>
			insertUnder(
				content,
				"Never",
				"- Run two quotes together when the person said them at different moments. Keep each quotation separate.",
			),
	},
];

const TOPICS: { noun: string; phrase: string }[] = [
	{ noun: "number", phrase: "a number the person stated" },
	{ noun: "age", phrase: "an age" },
	{ noun: "job title", phrase: "the job title the person used" },
	{ noun: "place", phrase: "a place name" },
	{ noun: "date", phrase: "a date or a year" },
	{ noun: "sum of money", phrase: "a sum of money" },
	{ noun: "organization", phrase: "an organization" },
	{ noun: "product", phrase: "a product name" },
	{ noun: "law", phrase: "a law or a rule they named" },
	{ noun: "percentage", phrase: "a percentage" },
	{ noun: "name", phrase: "the spelling of a name" },
	{ noun: "rejected title", phrase: "a title the person rejected" },
	{ noun: "offhand remark", phrase: "an offhand remark" },
	{ noun: "untranslated word", phrase: "a word they said in another language" },
	{ noun: "refusal", phrase: "a pause or a refusal to answer" },
];

function extraEdit(slot: number): EditDef {
	const topic = TOPICS[slot % TOPICS.length]!;
	const pattern = Math.floor(slot / TOPICS.length);
	if (pattern === 0) {
		return {
			section: "Never",
			kind: "add",
			summary: `Forbid adding ${topic.phrase} when the transcript does not contain it.`,
			apply: (content) =>
				insertUnder(
					content,
					"Never",
					`- Do not add ${topic.phrase} unless those words are in the transcript.`,
				),
		};
	}
	if (pattern === 1) {
		return {
			section: "Before you start",
			kind: "add",
			summary: `Ask how the writer wants ${topic.phrase} handled when the transcript is vague.`,
			apply: (content) =>
				insertUnder(
					content,
					"Before you start",
					`- how the writer wants ${topic.phrase} handled when the transcript is vague`,
				),
		};
	}
	if (pattern === 2) {
		return {
			section: "Steps",
			kind: "add",
			summary: `Add a step that ties each ${topic.noun} in the draft to a transcript line.`,
			apply: (content) =>
				addStep(
					content,
					`Mark each ${topic.noun} in the draft and point to the transcript line it came from.`,
				),
		};
	}
	if (pattern === 3) {
		return {
			section: "After the draft",
			kind: "add",
			summary: `Add a read-aloud check for every ${topic.noun}.`,
			apply: (content) =>
				insertUnder(
					content,
					"After the draft",
					`- Read every ${topic.noun} in the draft aloud and confirm it appears in the transcript.`,
				),
		};
	}
	return {
		section: "Voice",
		kind: "add",
		summary: `Keep the person's own term for ${topic.phrase} outside the quote as well as inside.`,
		apply: (content) =>
			insertUnder(
				content,
				"Voice",
				`- When the person talks about ${topic.phrase}, keep their term for it outside the quote as well as inside.`,
			),
	};
}

/** How many distinct scripted edits this tracer can hand out. */
export const EDIT_COUNT = HANDCRAFTED.length + TOPICS.length * 5;

export function editAt(index: number): Edit {
	const def = index < HANDCRAFTED.length ? HANDCRAFTED[index]! : extraEdit(index - HANDCRAFTED.length);
	return def;
}

export function applyEdit(content: string, edit: Edit): string | null {
	return edit.apply(content);
}
