// A git note on an agent-saved edition: who, for whom, which model, which run,
// and why. The note lives under refs/notes/* so it does not change the edition.
// https://developers.cloudflare.com/artifacts/concepts/best-practices/

export interface EditionNote {
	actor: string;
	onBehalfOf: string;
	model: string;
	runId: string;
	intent: string;
}

const LINES: { label: string; field: keyof EditionNote }[] = [
	{ label: "actor", field: "actor" },
	{ label: "on behalf of", field: "onBehalfOf" },
	{ label: "model", field: "model" },
	{ label: "run", field: "runId" },
	{ label: "intent", field: "intent" },
];

function oneLine(value: string): string {
	return value.replace(/[\r\n]+/g, " ").trim();
}

/** The note body stored on the edition. Five lines, always in this order. */
export function editionNote(note: EditionNote): string {
	const lines = LINES.map(({ label, field }) => {
		const value = field === "intent" ? oneLine(note[field]).slice(0, 200) : oneLine(note[field]);
		return `${label}: ${value}`;
	});
	return `${lines.join("\n")}\n`;
}

/** Read the five fields back. Returns null when a line is missing or reordered. */
export function parseEditionNote(text: string): EditionNote | null {
	const rows = text.split("\n").filter((line) => line.length > 0);
	if (rows.length < LINES.length) return null;
	const note = {} as EditionNote;
	for (let index = 0; index < LINES.length; index++) {
		const { label, field } = LINES[index]!;
		const prefix = `${label}: `;
		const row = rows[index];
		if (!row?.startsWith(prefix)) return null;
		const value = row.slice(prefix.length).trim();
		if (!value) return null;
		note[field] = value;
	}
	return note;
}
