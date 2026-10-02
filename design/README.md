# Design

Stylebook looks like a page an editor has marked up. The skill is the page. Suggestions are drawn on it in coloured pencil, the way a copy editor marks a proof. Everything around the page stays quiet so the marks carry the screen.

This file is the source for the interface. Build to it.

## Colour

| Token | Hex | Use | Contrast on paper |
| --- | --- | --- | --- |
| `paper` | `#FCFCFA` | Page background | — |
| `ink` | `#1B1D21` | Text, primary button fill, icons | 16.4:1 |
| `graphite` | `#5E6167` | Secondary text: dates, "working for", captions | 6.1:1 |
| `rule` | `#E3E3DD` | Hairline rules between regions. Never text. | 1.3:1 |
| `pencil-blue` | `#2B4C9B` | The suggestion being read. Focus rings. | 7.8:1 |
| `pencil-red` | `#B3261E` | Another suggestion that changes the same lines | 6.4:1 |
| `pencil-green` | `#2E6B4A` | Changes already accepted into the next edition | 6.2:1 |

The pencil colours mean something, so they never decorate. Each one names a state, not an agent. The page shows one suggestion at a time in blue. A second suggestion appears in red only when it overlaps the one being read. Green marks what has already been combined and will go out with the next edition. That keeps the page readable when 25 suggestions are open.

Colour is never the only signal. A mark is also a shape (a caret, a strike, a numbered ring), so it reads in greyscale.

## Type

One family: [Newsreader](https://fonts.google.com/specimen/Newsreader) (SIL Open Font License), weights 400, 500 and 600, with italics. Load it from Google Fonts or self-host the files.

| Role | Size / line height | Weight |
| --- | --- | --- |
| Skill title | 44 / 1.1, tracking -0.015em | 500 |
| Section heading | 22 / 1.3 | 600 |
| Body (the skill) | 19 / 1.6 | 400 |
| Interface text | 17 / 1.5 | 400 |
| Meta (dates, who) | 16 / 1.5, italic | 400 |

Keep the skill's text to about 68 characters a line. Meta lines are italic and graphite, never capitals. No all-caps labels anywhere.

## Wordmark

"Stylebook", Newsreader italic 500, in ink. Nothing under it, beside it or around it.

## Marks on the page

These are the proofreading marks the interface draws inside the skill's text.

- **Inserted text**: a small caret just before the insertion, then the new words in italic, in the pencil colour.
- **Removed text**: struck through in the pencil colour, 1.6px.
- **Which suggestion**: a 19px ring with the suggestion's number, in the same pencil colour, after the mark. The same number labels the suggestion in the list.

Suggestion numbers are identifiers, not a sequence, so they are the only numbered markers in the interface apart from the skill's own numbered steps.

## Icons

Nib marks: a proofreader's marks, written with a broad-nib pen so the strokes swell and thin like the italic wordmark. The files are in [`icons/`](icons/).

| File | Means |
| --- | --- |
| `library.svg` | The team's library |
| `suggestion.svg` | A suggestion (the insertion caret) |
| `edition.svg` | An edition |
| `publish.svg` | Publish |
| `decline.svg` | Decline (the delete mark) |
| `combine.svg` | Combine two suggestions (the close-up mark) |
| `history.svg` | History |
| `locked.svg` | Locked (the "let it stand" mark) |

- `icons/*.svg` are for 24px and up. `icons/small/*.svg` use a narrower nib for 16 to 20px.
- Inline the SVG in the markup so `currentColor` picks up the text colour. As an `<img>` the icon stays black.
- Put a word next to every icon. An icon on its own needs an `aria-label`.

## Layout

Wide screens (about 1100px and up), three columns:

```
┌──────────────┬───────────────────────────────┬──────────────────────┐
│ Library      │ Skill title                   │ Suggestions          │
│ contents     │ Edition 12, published …       │  ① who, for whom     │
│ (200px)      │                               │    what, why         │
│              │ The skill, with the selected  │    Publish · Decline │
│              │ suggestion drawn on it        │  ② …                 │
│              │ (max 640px)                   │ Overlap note         │
│              │ History                       │ (300–340px)          │
└──────────────┴───────────────────────────────┴──────────────────────┘
```

Narrow screens: one column, the page first, then the suggestions, then the contents. The page never goes below 16px side margins.

Text is left aligned. Regions are separated by space and hairline `rule` lines, not boxes.

## Controls

- **Primary button** (Publish): ink fill, paper text, 3px radius, at least 44px tall.
- **Secondary button** (Combine): paper fill, 1px ink border, same size.
- **Tertiary** (Decline): text only, underlined.
- **Focus**: 2px `pencil-blue` outline, 3px offset, on everything focusable.
- A button says exactly what happens, and the result uses the same word: "Publish" makes a note that says "Published as edition 13".

## Motion

Only when a person acts. When a suggestion is published, its marks settle into plain text once. Nothing moves on load. Respect `prefers-reduced-motion` by showing the end state.

## Never

Gradients, shadows, rounded cards, a box around every item, decorative underlines or squiggles, emoji, all-caps labels, a different typeface for "UI".

## Words

On screen use: Workspace, Library, Suggestion, Edition, Publish, History, Copy, Locked, Combine. Never: git, repo, branch, commit, push, pull, merge, fork, PR, squash, rebase, clone, token. See [`AGENTS.md`](../AGENTS.md).

## Adding an icon

Add its path to `ICONS` in [`make-icons.py`](make-icons.py) and run `python3 design/make-icons.py`. Draw it on a 32-unit grid with one stroke, the way a pen would.
