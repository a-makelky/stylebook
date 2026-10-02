// The first skill a new library starts with. It is a real, usable skill so the
// demo shows the kind of thing a content team would keep here.

export const STARTER_SKILL_PATH = "skills/interview-to-draft/SKILL.md";

export const STARTER_SKILL = `---
name: interview-to-draft
description: Turn an interview transcript into a first article draft that quotes accurately. Use when a writer has a transcript and an angle and needs a draft to edit.
---

# Interview to draft

## Before you start

Ask for anything that is missing:

- the transcript
- the angle, in one sentence
- who the piece is for
- the target length

## Steps

1. Read the whole transcript before writing anything.
2. List the five strongest quotes with their timestamps or line numbers. Copy them exactly.
3. Propose a headline and a one-paragraph outline. Wait for the writer to confirm the angle.
4. Write the draft. Every quote must appear in the transcript word for word. Mark paraphrase as paraphrase.
5. End with two lists: claims that need checking, and questions the interview did not answer.

## Never

- Invent a quote, a number, or a detail about the person interviewed.
- Tidy the wording inside quotation marks.
- Join two separate quotes into one.
`;

/** A small, visible change, used to give the library a further edition. */
export function withRevisionNote(content: string, edition: number): string {
	const note = `- Edition ${edition}: revision note added by the demo.`;
	if (content.includes("\n## Revision notes\n")) {
		return `${content.trimEnd()}\n${note}\n`;
	}
	return `${content.trimEnd()}\n\n## Revision notes\n\n${note}\n`;
}
