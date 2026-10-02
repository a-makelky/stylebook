// Comparing and combining happen in the Worker. Artifacts has no hosted diff
// or merge: the binding reads files, and that is all.
// https://developers.cloudflare.com/artifacts/api/workers-binding/

export type DiffKind = "same" | "del" | "add";

export interface DiffPart {
	kind: DiffKind;
	text: string;
}

export interface Section {
	name: string;
	start: number;
	end: number;
}

export type Pencil = "blue" | "red" | "green";

export interface ProofLine {
	text: string;
	kind: "text" | "del" | "ins";
	tone?: Pencil;
	number?: number;
	section: string | null;
	/** Line index in the library text. For an inserted line, the library line it goes before. */
	base?: number;
}

interface Hunk {
	baseStart: number;
	baseEnd: number;
	lines: string[];
}

/** Drop a trailing empty line that only marks a final newline. */
export function linesOf(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

function finish(lines: string[], sample: string): string {
	if (lines.length === 0) return "";
	const body = lines.join("\n");
	return sample.endsWith("\n") ? `${body}\n` : body;
}

export function diffArrays(left: string[], right: string[]): DiffPart[] {
	const n = left.length;
	const m = right.length;
	const scores: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		const row = scores[i]!;
		const next = scores[i + 1]!;
		for (let j = m - 1; j >= 0; j--) {
			row[j] = left[i] === right[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
		}
	}
	const parts: DiffPart[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (left[i] === right[j]) {
			parts.push({ kind: "same", text: left[i]! });
			i++;
			j++;
		} else if (scores[i + 1]![j]! >= scores[i]![j + 1]!) {
			parts.push({ kind: "del", text: left[i]! });
			i++;
		} else {
			parts.push({ kind: "add", text: right[j]! });
			j++;
		}
	}
	while (i < n) parts.push({ kind: "del", text: left[i++]! });
	while (j < m) parts.push({ kind: "add", text: right[j++]! });
	return parts;
}

export function sectionsOf(text: string): Section[] {
	const lines = linesOf(text);
	const sections: Section[] = [];
	const description = lines.findIndex((line) => line.startsWith("description:"));
	if (description !== -1) sections.push({ name: "Description", start: description, end: description + 1 });
	for (let index = 0; index < lines.length; index++) {
		const match = /^##\s+(.+?)\s*$/.exec(lines[index] ?? "");
		if (!match) continue;
		let end = lines.length;
		for (let next = index + 1; next < lines.length; next++) {
			if ((lines[next] ?? "").startsWith("## ")) {
				end = next;
				break;
			}
		}
		sections.push({ name: match[1]!.trim(), start: index, end });
	}
	return sections;
}

function sectionAt(sections: Section[], index: number): string | null {
	for (const section of sections) {
		if (index >= section.start && index < section.end) return section.name;
	}
	return null;
}

export function changedSections(before: string, after: string): string[] {
	const baseSections = sectionsOf(before);
	const nextSections = sectionsOf(after);
	const names = new Set<string>();
	let baseIndex = 0;
	let nextIndex = 0;
	for (const part of diffArrays(linesOf(before), linesOf(after))) {
		if (part.kind === "del") {
			const name = sectionAt(baseSections, baseIndex);
			if (name) names.add(name);
		}
		if (part.kind === "add") {
			const name = sectionAt(nextSections, nextIndex);
			if (name) names.add(name);
		}
		if (part.kind !== "add") baseIndex++;
		if (part.kind !== "del") nextIndex++;
	}
	return [...names];
}

function hunks(base: string[], next: string[]): Hunk[] {
	const found: Hunk[] = [];
	let baseIndex = 0;
	let current: Hunk | null = null;
	const flush = () => {
		if (current) found.push(current);
		current = null;
	};
	for (const part of diffArrays(base, next)) {
		if (part.kind === "same") {
			flush();
			baseIndex++;
			continue;
		}
		if (part.kind === "del") {
			current ??= { baseStart: baseIndex, baseEnd: baseIndex, lines: [] };
			current.baseEnd = baseIndex + 1;
			baseIndex++;
			continue;
		}
		current ??= { baseStart: baseIndex, baseEnd: baseIndex, lines: [] };
		current.lines.push(part.text);
	}
	flush();
	return found;
}

/** Two edits of the same existing lines, with different results. Inserts do not count. */
function incompatible(left: Hunk, right: Hunk): boolean {
	if (left.baseEnd === left.baseStart || right.baseEnd === right.baseStart) return false;
	if (left.baseStart < right.baseEnd && right.baseStart < left.baseEnd) {
		const same =
			left.baseStart === right.baseStart &&
			left.baseEnd === right.baseEnd &&
			left.lines.join("\n") === right.lines.join("\n");
		return !same;
	}
	return false;
}

export interface MergeOk {
	ok: true;
	text: string;
}

export interface MergeConflict {
	ok: false;
	sections: string[];
}

/**
 * Apply both edits to the base text. Inserts at the same place are both kept.
 * The same existing lines changed two ways is a conflict, unless `prefer` names a side.
 */
export function merge3(
	baseText: string,
	oursText: string,
	theirsText: string,
	prefer?: "ours" | "theirs",
): MergeOk | MergeConflict {
	const base = linesOf(baseText);
	const left = hunks(base, linesOf(oursText));
	const right = hunks(base, linesOf(theirsText));
	if (!prefer) {
		for (const ours of left) {
			for (const theirs of right) {
				if (incompatible(ours, theirs)) {
					const start = Math.min(ours.baseStart, theirs.baseStart);
					const end = Math.max(ours.baseEnd, theirs.baseEnd);
					return { ok: false, sections: namesInRange(baseText, start, end) };
				}
			}
		}
	}
	const useLeft = prefer === "theirs" ? left.filter((ours) => !right.some((theirs) => incompatible(ours, theirs))) : left;
	const useRight = prefer === "ours" ? right.filter((theirs) => !left.some((ours) => incompatible(ours, theirs))) : right;
	const chosen = [...useLeft, ...useRight].sort((a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd);
	const out: string[] = [];
	let cursor = 0;
	for (const hunk of chosen) {
		if (hunk.baseStart < cursor) continue;
		if (hunk.baseStart > cursor) out.push(...base.slice(cursor, hunk.baseStart));
		out.push(...hunk.lines);
		cursor = Math.max(cursor, hunk.baseEnd);
	}
	out.push(...base.slice(cursor));
	return { ok: true, text: finish(out, oursText.endsWith("\n") || baseText.endsWith("\n") ? `${baseText}\n` : baseText) };
}

function namesInRange(text: string, start: number, end: number): string[] {
	const names = new Set<string>();
	const sections = sectionsOf(text);
	for (let index = start; index < Math.max(end, start + 1); index++) {
		const name = sectionAt(sections, index);
		if (name) names.add(name);
	}
	return [...names];
}

export function sameLinesConflict(base: string, left: string, right: string): boolean {
	return !merge3(base, left, right).ok;
}

function applyWithin(base: string[], chosen: Hunk[], start: number, end: number): string[] {
	const out: string[] = [];
	let cursor = start;
	for (const hunk of chosen) {
		if (hunk.baseStart > cursor) out.push(...base.slice(cursor, hunk.baseStart));
		out.push(...hunk.lines);
		cursor = Math.max(cursor, hunk.baseEnd);
	}
	if (end > cursor) out.push(...base.slice(cursor, end));
	return out;
}

/**
 * Keep both changes. Changes to different lines are both applied, as in a
 * clean publish. Where both suggestions change the same lines, the first
 * suggestion's version of those lines comes first and the second's follows,
 * without repeating a line both already share. Everything else appears once.
 *
 * Seam: a hosted model is not called. A real agent would replace this function
 * and leave the callers as they are.
 */
export function combineChanges(library: string, first: string, second: string): string {
	const clean = merge3(library, first, second);
	if (clean.ok) return clean.text;

	const base = linesOf(library);
	const tagged = [
		...hunks(base, linesOf(first)).map((hunk) => ({ hunk, side: 0 as const })),
		...hunks(base, linesOf(second)).map((hunk) => ({ hunk, side: 1 as const })),
	].sort((a, b) => a.hunk.baseStart - b.hunk.baseStart || a.hunk.baseEnd - b.hunk.baseEnd);

	// Group hunks that touch the same library lines.
	const groups: { start: number; end: number; items: typeof tagged }[] = [];
	for (const item of tagged) {
		const last = groups[groups.length - 1];
		if (last && (item.hunk.baseStart < last.end || item.hunk.baseStart === last.start)) {
			last.end = Math.max(last.end, item.hunk.baseEnd);
			last.items.push(item);
		} else {
			groups.push({ start: item.hunk.baseStart, end: item.hunk.baseEnd, items: [item] });
		}
	}

	const out: string[] = [];
	let cursor = 0;
	for (const group of groups) {
		out.push(...base.slice(cursor, group.start));
		const firstHunks = group.items.filter((item) => item.side === 0).map((item) => item.hunk);
		const secondHunks = group.items.filter((item) => item.side === 1).map((item) => item.hunk);
		const firstLines = applyWithin(base, firstHunks, group.start, group.end);
		if (secondHunks.length === 0) {
			out.push(...firstLines);
		} else if (firstHunks.length === 0) {
			out.push(...applyWithin(base, secondHunks, group.start, group.end));
		} else {
			const seen = new Set(firstLines.filter((line) => line.trim() !== ""));
			out.push(...firstLines);
			out.push(...applyWithin(base, secondHunks, group.start, group.end).filter((line) => !seen.has(line)));
		}
		cursor = Math.max(cursor, group.end);
	}
	out.push(...base.slice(cursor));
	return finish(out, library.endsWith("\n") ? library : `${library}\n`);
}

export function proofLines(library: string, selected: string, tone: Pencil, number: number): ProofLine[] {
	const before = sectionsOf(library);
	const after = sectionsOf(selected);
	const lines: ProofLine[] = [];
	let baseIndex = 0;
	let nextIndex = 0;
	for (const part of diffArrays(linesOf(library), linesOf(selected))) {
		if (part.kind === "same") {
			lines.push({ text: part.text, kind: "text", section: sectionAt(before, baseIndex), base: baseIndex });
			baseIndex++;
			nextIndex++;
		} else if (part.kind === "del") {
			lines.push({
				text: part.text,
				kind: "del",
				tone,
				number,
				section: sectionAt(before, baseIndex),
				base: baseIndex,
			});
			baseIndex++;
		} else {
			lines.push({
				text: part.text,
				kind: "ins",
				tone,
				number,
				section: sectionAt(after, nextIndex),
				base: baseIndex,
			});
			nextIndex++;
		}
	}
	return lines;
}

/**
 * Red marks for another suggestion, drawn only in the sections both change,
 * next to the library line each one changes. A red deletion of a line the
 * page shows unchanged replaces that line; everything else goes just before
 * the next unchanged library line, after any blue marks at the same place.
 */
export function withOverlapMarks(
	page: ProofLine[],
	library: string,
	other: string,
	number: number,
	sections: string[],
): ProofLine[] {
	const wanted = new Set(sections);
	const extra = proofLines(library, other, "red", number).filter(
		(line) => line.kind !== "text" && line.section && wanted.has(line.section),
	);
	if (extra.length === 0) return page;
	const out = [...page];
	for (const mark of extra) {
		const base = mark.base ?? Number.MAX_SAFE_INTEGER;
		if (mark.kind === "del") {
			const same = out.findIndex((line) => line.kind === "text" && line.base === base);
			if (same !== -1) {
				out[same] = mark;
				continue;
			}
		}
		const after = mark.kind === "del" ? base + 1 : base;
		const next = out.findIndex((line) => line.kind === "text" && (line.base ?? -1) >= after);
		if (next === -1) out.push(mark);
		else out.splice(next, 0, mark);
	}
	return out;
}

/** Stable identifier from the copy name. A trailing number is that number. */
export function suggestionNumber(name: string): number {
	const match = /-(\d+)$/.exec(name);
	if (match) return Number(match[1]);
	let hash = 0;
	for (const char of name) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
	return (hash % 89) + 1;
}
