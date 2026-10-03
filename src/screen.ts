// The review screen. One page: the library, the open suggestions, and history.
// Words on this page follow design/README.md.

import { actorFromRequest, chooseCookie, clearChooseCookie, clearCookie, clearReturnCookie, clearSeenCookie, keyCookie, readCookie, RETURN_COOKIE, safeReturnPath, seenCookie, CHOOSE_COOKIE, SEEN_COOKIE, signOut } from "./auth";
import { accessLogoutUrl, signInMode, verifiedEmail, type AccessRuntime } from "./identity";
import { listActors } from "./actors";
import { clientIp, issueSignInLink, normalizeEmail, peekLink, rememberLink, SENT, SIGN_IN_ACK, takeLink } from "./mail";
import {
	chooseWorkspace,
	cleanWorkspaceName,
	connectAgent,
	deliverSignIn,
	freshAgentKey,
	joinFromLink,
	memberships,
	releaseWorkspaceStart,
	removeAgent,
	removePerson,
	renameAgent,
	reserveWorkspaceStart,
	revokeAgentKey,
	acceptInvitation,
	cancelInvitation,
	changeRole,
	deleteWorkspace,
	finishWorkspaceStart,
	openSession,
	invitePerson,
	saveWorkspaceSettings,
	workspaceById,
} from "./teams";
import { authorize, invitationsForWorkspace, pendingInvitations, recordSignIn, setPageLock, workspaceState } from "./roles";
import { scopedEnv } from "./usage";
import { libraryName } from "./workspace";
import { describeError } from "./redact";
import type { Env } from "./env";
import { icon } from "./icons";
import type { ProofLine } from "./diff";
import {
	cleanName,
	cleanPath,
	combineSuggestions,
	declineSuggestion,
	DeskError,
	loadDesk,
	publishSuggestion,
	saveAgentSuggestion,
	writtenBy,
	type Desk,
	type DeskSuggestion,
} from "./review";

export function esc(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function mark(line: ProofLine): string {
	const text = esc(line.text);
	if (line.kind === "text" || !line.tone) return text;
	const ring = line.number
		? `<span class="ring ${line.tone}">${line.number}</span>`
		: "";
	if (line.kind === "del") return `<del class="mark ${line.tone}">${text}</del>${ring}`;
	return `<span class="caret ${line.tone}" aria-hidden="true"></span><em class="mark ${line.tone}">${text}</em>${ring}`;
}

function isFrontMatter(line: ProofLine, hiding: { on: boolean }): boolean {
	if (line.text === "---") {
		hiding.on = !hiding.on;
		return true;
	}
	if (hiding.on) return true;
	if (line.text.startsWith("name:")) return true;
	if (line.text.startsWith("description:") && line.kind === "text") return true;
	return false;
}

function renderLines(lines: ProofLine[]): string {
	const hiding = { on: false };
	const html: string[] = [];
	let list: string[] = [];
	let listTag: "ul" | "ol" = "ul";
	const flush = () => {
		if (list.length === 0) return;
		html.push(`<${listTag}>${list.join("")}</${listTag}>`);
		list = [];
	};
	for (const line of lines) {
		if (isFrontMatter(line, hiding)) continue;
		if (line.text.startsWith("# ")) continue;
		const body = mark(line);
		if (line.text.startsWith("description:")) {
			flush();
			html.push(`<p class="lede">${mark({ ...line, text: line.text.replace(/^description:\s*/, "") })}</p>`);
			continue;
		}
		if (line.text.startsWith("## ")) {
			flush();
			html.push(`<h2>${mark({ ...line, text: line.text.replace(/^##\s+/, "") })}</h2>`);
			continue;
		}
		const listItem = /^\s*(?:([-*])|(\d+)\.)\s+(.*)$/.exec(line.text);
		if (listItem) {
			const tag = listItem[2] ? "ol" : "ul";
			if (list.length > 0 && tag !== listTag) flush();
			listTag = tag;
			// A changed step keeps its own number, so a struck line and its
			// replacement both read as the same step.
			const value = listItem[2] ? ` value="${Number(listItem[2])}"` : "";
			list.push(`<li${value}>${mark({ ...line, text: listItem[3] ?? "" })}</li>`);
			continue;
		}
		if (line.text.trim() === "") {
			flush();
			continue;
		}
		flush();
		html.push(`<p>${body}</p>`);
	}
	flush();
	return html.join("\n");
}

function hidden(name: string, value: string): string {
	return `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`;
}

function suggestionCard(desk: Desk, suggestion: DeskSuggestion, selected: boolean): string {
	const item = desk.item ?? "";
	const href = `/?item=${encodeURIComponent(item)}&suggestion=${encodeURIComponent(suggestion.name)}`;
	const conflict = selected && desk.conflict ? desk.conflict : null;
	const ways =
		conflict && desk.canPublish
			? `<p class="overlap">Nothing was published. These lines also changed in ${
					conflict.current ? "the current edition" : `Suggestion ${conflict.otherNumber}`
				}.</p>
        <div class="ways">
        <form method="post" action="/resolve">${hidden("item", item)}${hidden("suggestion", suggestion.name)}${hidden("other", conflict.otherName)}${hidden("mode", "keep-this")}
          <button class="primary" type="submit">Keep this one</button>
        </form>
        <form method="post" action="/resolve">${hidden("item", item)}${hidden("suggestion", suggestion.name)}${hidden("other", conflict.otherName)}${hidden("mode", "keep-other")}
          <button class="secondary" type="submit">Keep the other</button>
        </form>
        <form method="post" action="/resolve">${hidden("item", item)}${hidden("suggestion", suggestion.name)}${hidden("other", conflict.otherName)}${hidden("mode", "combine")}
          <button class="secondary" type="submit">${icon("combine", true)} Ask an agent to combine them</button>
        </form>
        </div>`
			: conflict
				? `<p class="overlap">Nothing was published. These lines also changed in ${
						conflict.current ? "the current edition" : `Suggestion ${conflict.otherNumber}`
					}.</p>`
				: "";
	const publish = desk.canPublish
		? `<form method="post" action="/publish">${hidden("item", item)}${hidden("suggestion", suggestion.name)}
            <button class="primary" type="submit">${icon("publish", true)} Publish</button>
          </form>
          <form method="post" action="/decline">${hidden("item", item)}${hidden("suggestion", suggestion.name)}
            <button class="text" type="submit">${icon("decline", true)} Decline</button>
          </form>`
		: desk.locked
			? `<p class="meta">${icon("locked", true)} Locked</p>`
			: "";
	return `<article class="suggestion${selected ? " selected" : ""}">
    <a href="${href}">${icon("suggestion", true)} <span class="ring ${suggestion.combined ? "green" : selected ? "blue" : ""}">${suggestion.number}</span>
      <span class="who">${esc(writtenBy(suggestion.writer, suggestion.owner))}</span></a>
    <p>${esc(suggestion.why)}</p>
    ${ways}
    <div class="actions">${publish}</div>
  </article>`;
}

export function renderDesk(desk: Desk, suggestion: string | null): string {
	const selected = desk.suggestions.find((entry) => entry.name === suggestion) ?? desk.suggestions[0] ?? null;
	const groups = ["Skills", "Workflows", "Connections"] as const;
	const contents = groups
		.map((group) => {
			const items = desk.items.filter((item) => item.group === group);
			if (items.length === 0) return "";
			const links = items
				.map((item) => {
					const href = `/?item=${encodeURIComponent(item.path)}`;
					const current = item.path === desk.item ? ` aria-current="page"` : "";
					const mark = desk.lockedPaths.includes(item.path) ? ` ${icon("locked", true)}` : "";
					return `<li><a href="${href}"${current}>${esc(item.title)}</a>${mark}</li>`;
				})
				.join("");
			return `<h2>${esc(group)}</h2><ul>${links}</ul>`;
		})
		.join("");
	const overlap =
		desk.overlaps.length === 0
			? ""
			: desk.overlaps
					.map(
						(item) =>
							`<p class="overlap">This and Suggestion ${item.number} both change <em>${esc(item.section)}</em>.</p>`,
					)
					.join("");
	const notice = desk.notice ? `<p class="notice">${esc(desk.notice)}</p>` : "";
	const edition =
		desk.editionNumber && desk.publishedOn
			? `<p class="meta">${icon("edition", true)} Edition ${desk.editionNumber}, published ${esc(desk.publishedOn)}</p>`
			: "";
	const locked = desk.locked ? `<p class="meta">${icon("locked", true)} Locked</p>` : "";
	const lockControl = desk.canLock && desk.item
		? `<form method="post" action="${desk.locked ? "/unlock" : "/lock"}">${hidden("item", desk.item)}
        <button class="text" type="submit">${desk.locked ? "Unlock" : "Lock this page"}</button></form>`
		: "";
	const description = desk.description ? `<p class="lede">${esc(desk.description)}</p>` : "";
	const history =
		desk.history.length === 0
			? ""
			: `<section class="history"><h2>${icon("history", true)} History</h2>${desk.history
					.map((entry) => `<p class="meta">Edition ${entry.number}. ${esc(entry.line)}</p>`)
					.join("")}</section>`;
	const count = desk.suggestions.length;
	const countLabel = count === 1 ? "1 suggestion" : `${count} suggestions`;
	const cards =
		desk.suggestions.length === 0
			? `<p class="meta">No open suggestions for this page.</p>`
			: desk.suggestions.map((entry) => suggestionCard(desk, entry, entry.name === selected?.name)).join("");

	return page({
		account: accountLine(desk.workspaceName),
		main: `<div class="desk">
      <nav class="contents"><h2>${icon("library", true)} Library</h2>${contents}</nav>
      <article class="page">
        <h1>${esc(desk.title)}</h1>
        ${edition}
        ${locked}
        ${lockControl}
        ${description}
        ${notice}
        <div class="page-body">${renderLines(desk.lines)}</div>
        ${history}
      </article>
      <aside class="suggestions">
        <h2>${icon("suggestion", true)} Suggestions</h2>
        <p class="meta">${countLabel}</p>
        ${overlap}
        ${cards}
        ${desk.more ? `<p class="meta"><a href="${esc(desk.more)}">Older suggestions</a></p>` : ""}
      </aside>
    </div>`,
	});
}

export function accountLine(workspaceName: string): string {
	// A div, not a paragraph: a form inside a paragraph is lifted out of it,
	// which split the workspace name and Sign out onto opposite sides of the line.
	return `<div class="account"><span>${esc(workspaceName)}</span><a href="/connect">Connect your tools</a><a href="/people">People</a>
    <form method="post" action="/sign-out"><button class="text" type="submit">Sign out</button></form></div>`;
}

export function page(parts: { main: string; account?: string }): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stylebook</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400;1,6..72,500&amp;display=swap">
<style>
  :root {
    --paper: #FCFCFA;
    --ink: #1B1D21;
    --graphite: #5E6167;
    --rule: #E3E3DD;
    --blue: #2B4C9B;
    --red: #B3261E;
    --green: #2E6B4A;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--paper); color: var(--ink); }
  body, button, input { font-family: Newsreader, "Iowan Old Style", Palatino, serif; }
  a { color: inherit; }
  :focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
  .wordmark { font-style: italic; font-weight: 500; font-size: 28px; line-height: 1.1; margin: 0; color: var(--ink); }
  header { padding: 28px 24px 0; }
  .top {
    display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline;
    gap: 8px 24px; max-width: 1200px; margin: 0 auto; padding: 0 24px;
  }
  header:has(.top) { padding-left: 0; padding-right: 0; }
  .account {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px;
    margin: 0 0 0 auto; color: var(--graphite); font-style: italic; font-size: 16px; line-height: 1.5;
  }
  .account a, .account button.text { color: var(--graphite); font-size: 16px; font-style: italic; min-height: 0; }
  .account form { margin: 0; }
  .desk {
    display: grid;
    grid-template-columns: 200px minmax(0, 640px) minmax(300px, 340px);
    gap: 32px;
    max-width: 1200px;
    margin: 0 auto;
    padding: 28px 24px 64px;
  }
  h1 { font-size: 44px; line-height: 1.1; font-weight: 500; letter-spacing: -0.015em; margin: 0 0 8px; }
  h2 { font-size: 22px; line-height: 1.3; font-weight: 600; margin: 28px 0 8px; }
  .contents h2, .suggestions h2, .history h2 { font-size: 17px; font-weight: 400; display: flex; align-items: center; gap: 8px; }
  .page-body { max-width: 68ch; font-size: 19px; line-height: 1.6; font-weight: 400; }
  .page-body p, .page-body li { margin: 0 0 0.8em; }
  .lede, .meta { color: var(--graphite); font-style: italic; font-size: 16px; line-height: 1.5; }
  .contents, .suggestions { font-size: 17px; line-height: 1.5; }
  .contents ul { list-style: none; padding: 0; margin: 0; }
  .page-body ul, .page-body ol { padding: 0 0 0 1.4em; margin: 0 0 0.8em; }
  .page-body ul { list-style: disc; }
  .page-body ol { list-style: decimal; }
  .page-body li::marker { color: var(--graphite); }
  .contents li { margin: 6px 0; }
  .contents a[aria-current="page"] { color: var(--blue); }
  .suggestion { padding: 16px 0; border-top: 1px solid var(--rule); }
  .suggestion a { display: flex; align-items: center; gap: 8px; text-decoration: none; }
  .who { font-style: italic; color: var(--graphite); }
  .actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
  .ways { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 12px; }
  .ways form { display: flex; margin: 0; }
  .ways button { width: 100%; }
  @media (min-width: 1100px) {
    .ways { flex-direction: row; align-items: stretch; }
    .ways form { flex: 1 1 0; min-width: 0; }
  }
  button { font-size: 17px; line-height: 1.5; cursor: pointer; }
  button.primary, button.secondary { min-height: 44px; padding: 0 16px; border-radius: 3px; }
  button.primary, a.primary { background: var(--ink); color: var(--paper); border: none; text-decoration: none; }
  a.primary { display: inline-flex; align-items: center; min-height: 44px; padding: 0 16px; border-radius: 3px; }
  button.secondary { background: var(--paper); color: var(--ink); border: 1px solid var(--ink); }
  button.text { background: none; border: none; color: var(--ink); text-decoration: underline; min-height: 44px; padding: 0; }
  button .icon { vertical-align: -4px; }
  .icon { width: 24px; height: 24px; }
  .mark.blue, .caret.blue, .ring.blue { color: var(--blue); }
  .mark.red, .caret.red, .ring.red { color: var(--red); }
  .mark.green, .caret.green, .ring.green { color: var(--green); }
  del.mark { text-decoration: line-through; text-decoration-thickness: 1.6px; }
  em.mark { font-style: italic; }
  .caret {
    display: inline-block; width: 0.45em; height: 0.45em; margin: 0 0.2em 0.15em 0;
    border-left: 1.6px solid currentColor; border-bottom: 1.6px solid currentColor;
    transform: rotate(-45deg); vertical-align: middle;
  }
  .ring {
    display: inline-flex; align-items: center; justify-content: center;
    width: 19px; height: 19px; border: 1px solid currentColor; border-radius: 50%;
    font-size: 12px; font-style: normal; line-height: 1; text-decoration: none;
  }
  .overlap { color: var(--red); }
  .notice { color: var(--green); font-style: italic; }
  .sign-in, .sheet { max-width: 42rem; padding: 28px 16px 64px; margin: 0 auto; }
  .sign-in label, .sign-in input, .sheet label, .sheet input, .sheet select { display: block; width: 100%; font-size: 17px; line-height: 1.5; }
  .sign-in input, .sheet input, .sheet select { min-height: 44px; margin: 8px 0 16px; padding: 8px 12px; border: 1px solid var(--ink); border-radius: 3px; background: var(--paper); color: var(--ink); }
  .sheet h1 { font-size: 44px; line-height: 1.1; font-weight: 500; letter-spacing: -0.015em; }
  .person, .agent { border-top: 1px solid var(--rule); padding: 12px 0; }
  .tool-row { display: flex; flex-wrap: wrap; gap: 0 16px; margin: 4px 0 8px; }
  .tool-row a { display: inline-flex; align-items: center; min-height: 44px; text-decoration: none; }
  .tool-row a[aria-current="page"] { font-weight: 600; text-decoration: underline; }
  .steps { margin: 8px 0 16px; padding: 0 0 0 1.4em; font-size: 17px; line-height: 1.5; }
  .steps li { margin: 8px 0; }
  .address { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin: 8px 0; }
  .address code, .steps code { font-family: inherit; overflow-wrap: anywhere; }
  h2.quiet { font-style: italic; font-weight: 400; color: var(--graphite); }
  .sheet h1.return { overflow-wrap: anywhere; }
  .bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
  .bar input { width: auto; flex: 1; min-width: 12rem; margin: 0; }
  pre { white-space: pre-wrap; font: inherit; font-size: 16px; line-height: 1.5; margin: 8px 0 16px; }
  .history { border-top: 1px solid var(--rule); margin-top: 32px; }
  .sheet.people { max-width: 68rem; }
  .person-row, .agent-row, .invite-row {
    display: flex; flex-direction: column; align-items: stretch; gap: 4px;
    border-top: 1px solid var(--rule); padding: 12px 0;
  }
  .person-name, .agent-name { font-size: 17px; line-height: 1.5; }
  .sheet .person-row form, .sheet .agent-row form, .sheet .invite-row form { margin: 0; }
  .sheet .person-row select {
    display: block; width: 100%; min-width: 0; margin: 0;
  }
  .sheet .invite-line {
    display: flex; flex-wrap: wrap; gap: 12px; align-items: end;
  }
  .sheet .invite-line label {
    display: flex; flex-direction: column; width: auto; flex: 1 1 12rem; margin: 0;
  }
  .sheet .invite-line input, .sheet .invite-line select { width: 100%; margin: 8px 0 0; }
  .sheet .invite-line button { flex: 0 0 auto; }
  .agent-actions { display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: center; }
  .agent-actions details { margin: 0; }
  .agent-actions summary {
    cursor: pointer; text-decoration: underline; min-height: 44px;
    display: inline-flex; align-items: center; list-style: none;
  }
  .agent-actions summary::-webkit-details-marker { display: none; }
  .agent-actions summary::marker { content: ""; }
  .sheet .rename-form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 0; }
  .sheet .rename-form label { width: auto; margin: 0; }
  .sheet .rename-form input { width: auto; flex: 1 1 10rem; margin: 0; }
  .sheet label.check {
    display: flex; flex-direction: row; align-items: center; justify-content: flex-start;
    gap: 8px; width: auto; margin: 0 0 8px;
  }
  .sheet label.check input { width: auto; min-height: 0; margin: 0; flex: 0 0 auto; }
  .delete-workspace { border-top: 1px solid var(--rule); margin-top: 32px; padding-top: 8px; color: var(--red); }
  .delete-workspace h2, .delete-workspace p, .delete-workspace label, .delete-workspace button { color: var(--red); }
  @media (min-width: 641px) {
    .person-row, .agent-row, .invite-row { flex-direction: row; align-items: center; gap: 16px; }
    .person-row .person-name { flex: 1 1 8rem; }
    .person-row .email { flex: 1.4 1 12rem; }
    .person-row .joined, .agent-row .used { flex: 0 0 auto; }
    .person-row .remove, .agent-row .agent-actions, .invite-row form { margin-left: auto; }
    .sheet .person-row select { width: auto; min-width: 8rem; }
  }
  @media (max-width: 640px) {
    .sheet .invite-line { flex-direction: column; align-items: stretch; }
    .sheet .invite-line label, .sheet .invite-line button { width: 100%; flex-basis: auto; }
  }
  @media (max-width: 1099px) {
    header { padding-left: 16px; padding-right: 16px; }
    header:has(.top) { padding-left: 0; padding-right: 0; }
    .top { padding: 0 16px; }
    .desk { display: flex; flex-direction: column; padding: 24px 16px 48px; }
    .page { order: 1; }
    .suggestions { order: 2; }
    .contents { order: 3; }
  }
  @media (max-width: 640px) {
    .top { flex-direction: column; align-items: flex-start; }
    .account { margin-left: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .settle .mark, .settle .caret, .settle .ring { color: var(--ink); text-decoration: none; font-style: normal; }
  }
</style>
</head>
<body>
<header>${parts.account ? `<div class="top"><p class="wordmark">Stylebook</p>${parts.account}</div>` : `<p class="wordmark">Stylebook</p>`}</header>
${parts.main}
</body>
</html>`;
}

export function renderGate(message: string | null, tone: "error" | "ok" = "error"): string {
	const note = message ? `<p class="${tone === "ok" ? "notice" : "overlap"}">${esc(message)}</p>` : "";
	return page({
		main: `<div class="sheet">
      <h1>Start a workspace</h1>
      <form method="post" action="/start">
        <label for="workspace">Workspace name</label>
        <input id="workspace" name="workspace" autocomplete="organization" required>
        <label for="start-email">Email</label>
        <input id="start-email" name="email" type="email" autocomplete="email" required>
        ${note}
        <button class="primary" type="submit">Start</button>
      </form>
      <h2>Already in a workspace</h2>
      <form method="post" action="/sign-in">
        <label for="sign-email">Email</label>
        <input id="sign-email" name="email" type="email" autocomplete="email" required>
        <button class="secondary" type="submit">Send a sign-in link</button>
      </form>
    </div>`,
	});
}

function setupMarkup(origin: string, workspaceId: string, key: string): string {
	const host = origin.replace(/^https?:\/\//, "");
	const mcp = JSON.stringify(
		{
			mcpServers: {
				stylebook: {
					url: `${origin}/mcp`,
					headers: { Authorization: `Bearer ${key}` },
				},
			},
		},
		null,
		2,
	);
	const folder = `git clone https://stylebook:${key}@${host}/git/${libraryName(workspaceId)}.git library`;
	return `<h2>For Cursor or Claude Code</h2>
    <p>Paste this where that tool keeps its connections.</p>
    <pre data-setup>${esc(mcp)}</pre>
    <h2>For a folder on your computer</h2>
    <p>Paste this to read the library. Saving a suggestion uses the same key.</p>
    <pre data-setup>${esc(folder)}</pre>`;
}

function plainWhen(iso: string | null | undefined): string {
	if (!iso) return "Not used yet";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "Not used yet";
	return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

interface PeoplePerson {
	id: string;
	name: string;
	email: string;
	role: string;
	joined: string | null;
	you: boolean;
	starter: boolean;
	agents: string;
}

interface PeopleAgent {
	id: string;
	name: string;
	tool: string;
	person: string;
	lastUsed: string | null;
	yours: boolean;
}

function roleSentence(name: string, role: "admin" | "member"): string {
	return `${name} is now ${role === "admin" ? "an Admin" : "a Member"}.`;
}

function lastUsedLabel(iso: string | null): string {
	if (!iso) return "Not used yet";
	const when = plainWhen(iso);
	return when === "Not used yet" ? when : `Last used ${when}`;
}

function renderPeople(
	workspaceName: string,
	people: PeoplePerson[],
	agents: PeopleAgent[],
	invites: { id: string; email: string; role: string }[],
	message: string | null,
	reveal: { name: string; key: string; origin: string; workspaceId: string } | null,
	admin: boolean,
	starter: boolean,
	membersCanPublish: boolean,
	links: boolean,
): string {
	const note = message ? `<p class="${message.startsWith("Only an") || message.startsWith("An agent") || message.startsWith("The person") || message.startsWith("There is") || message.startsWith("That ") || message.startsWith("This ") || message.startsWith("Give ") || message.startsWith("Enter ") || message.startsWith("Type ") || message.startsWith("You cannot") ? "overlap" : "notice"}">${esc(message)}</p>` : "";
	const shown = reveal
		? `<p class="notice">This key for ${esc(reveal.name)} is shown once. Copy it now.</p>
       <p><code>${esc(reveal.key)}</code></p>
       ${setupMarkup(reveal.origin, reveal.workspaceId, reveal.key)}`
		: "";
	const personRows = people
		.map((person) => {
			const role = person.starter
				? `<span class="role">Started this workspace</span>`
				: admin
					? `<form method="post" action="/people/role">${hidden("id", person.id)}<select name="role" aria-label="Role for ${esc(person.name)}" onchange="this.form.requestSubmit()">
              <option value="member"${person.role === "member" ? " selected" : ""}>Member</option>
              <option value="admin"${person.role === "admin" ? " selected" : ""}>Admin</option>
            </select></form>`
					: `<span class="role">${person.role === "admin" ? "Admin" : "Member"}</span>`;
			const remove =
				admin && !person.starter
					? `<span class="remove"><form method="post" action="/people/remove">${hidden("id", person.id)}<button class="text" type="submit">Remove</button></form></span>`
					: "";
			return `<div class="person-row">
        <span class="person-name">${esc(person.name)}${person.you ? " (you)" : ""}</span>
        <span class="meta email">${esc(person.email)}</span>
        ${role}
        <span class="meta joined">Joined ${esc(plainWhen(person.joined))}</span>
        ${remove}
      </div>`;
		})
		.join("");
	const inviteRows = invites
		.map(
			(invite) => `<div class="invite-row"><span>${esc(invite.email)}</span>
        <span class="meta">${invite.role === "admin" ? "Admin" : "Member"}</span>
        ${
					admin
						? `<form method="post" action="/invitations/cancel">${hidden("id", invite.id)}<button class="text" type="submit">Cancel</button></form>`
						: ""
				}</div>`,
		)
		.join("");
	const agentRows = agents
		.map((agent) => {
			const rename = agent.yours
				? `<details class="rename"><summary>Rename</summary>
            <form method="post" action="/agents/rename" class="rename-form">${hidden("id", agent.id)}
              <label for="rename-${esc(agent.id)}">Name</label>
              <input id="rename-${esc(agent.id)}" name="name" value="${esc(agent.name)}" required>
              <button class="text" type="submit">Save</button>
            </form>
          </details>
          <form method="post" action="/agents/key">${hidden("id", agent.id)}<button class="text" type="submit">New key</button></form>`
				: "";
			const revoke =
				admin || agent.yours
					? `<form method="post" action="/agents/revoke">${hidden("id", agent.id)}<button class="text" type="submit">Revoke</button></form>`
					: "";
			return `<div class="agent-row">
        <span class="agent-name">${esc(agent.name)}</span>
        <span>${esc(agent.tool)}</span>
        <span class="meta">${esc(agent.person)}</span>
        <span class="meta used">${esc(lastUsedLabel(agent.lastUsed))}</span>
        <span class="agent-actions">${rename}${revoke}</span>
      </div>`;
		})
		.join("");
	const invite = admin
		? `<h2>Invite</h2>
      <form method="post" action="/invite" class="invite-line">
        <label for="invite-email">Email
          <input id="invite-email" name="email" type="email" autocomplete="email" required>
        </label>
        <label for="invite-role">Role
          <select id="invite-role" name="role">
            <option value="member" selected>Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <button class="primary" type="submit">${links ? "Send an invite" : "Invite"}</button>
      </form>
      ${inviteRows ? `<p class="meta">Waiting to join</p>${inviteRows}` : ""}`
		: "";
	const settings = admin
		? `<h2>Settings</h2>
      <form method="post" action="/settings">
        <label for="workspace-name">Workspace name</label>
        <input id="workspace-name" name="name" value="${esc(workspaceName)}" required>
        <label class="check" for="members-can-publish"><input id="members-can-publish" type="checkbox" name="members_can_publish" value="yes"${membersCanPublish ? " checked" : ""}> Members can publish</label>
        <p class="meta">When this is off, members suggest and an Admin publishes.</p>
        <button class="secondary" type="submit">Save</button>
      </form>`
		: "";
	const deletion = starter
		? `<section class="delete-workspace">
      <h2>Delete this workspace</h2>
      <p>This removes the library, every suggestion, and everyone in the workspace.</p>
      <form method="post" action="/workspace/delete">
        <label for="delete-name">Type the workspace name</label>
        <input id="delete-name" name="name" autocomplete="off" required>
        <button class="text" type="submit">Delete</button>
      </form>
    </section>`
		: "";
	const connect = `<h2>Connect your AI tools</h2>
      <p><a class="primary" href="/connect">Connect your AI tools</a></p>`;
	return page({
		account: accountLine(workspaceName),
		main: `<div class="sheet people">
      <p class="meta"><a href="/">Library</a></p>
      <h1>People</h1>
      <p class="meta">${esc(workspaceName)}</p>
      ${note}
      ${shown}
      <h2>Everyone in the workspace</h2>
      ${personRows || `<p class="meta">Just you, so far.</p>`}
      ${invite}
      <h2>Agents</h2>
      ${agentRows || `<p class="meta">No agents yet.</p>`}
      ${connect}
      ${settings}
      ${deletion}
    </div>`,
	});
}

function renderRemoveConfirm(name: string, id: string): string {
	return page({
		main: `<div class="sheet">
      <h1>Remove ${esc(name)}</h1>
      <p>Remove ${esc(name)} from this workspace? Their agents stop working.</p>
      <form method="post" action="/people/remove">${hidden("id", id)}${hidden("confirm", "yes")}
        <button class="primary" type="submit">Remove</button>
      </form>
      <p><a href="/people">Cancel</a></p>
    </div>`,
	});
}

function renderConfirm(label: string, secret: string): string {
	return page({
		main: `<div class="sheet">
      <h1>${esc(label)}</h1>
      <form method="post" action="/s/${esc(secret)}">
        <button class="primary" type="submit">${esc(label)}</button>
      </form>
    </div>`,
	});
}

async function confirmLabel(env: Env, link: { purpose: string; email: string; workspaceId: string | null }): Promise<string | null> {
	if (link.purpose === "start") return "Open your new workspace";
	if (link.purpose === "invite" && link.workspaceId) {
		const workspace = await workspaceById(env.DB, link.workspaceId);
		return workspace ? `Sign in to ${workspace.name}` : null;
	}
	if (link.purpose === "sign-in" || link.purpose === "choose") {
		const homes = await memberships(env.DB, link.email);
		if (homes.length === 1) return `Sign in to ${homes[0]!.workspace.name}`;
		if (homes.length > 1) return "Sign in";
	}
	return null;
}

function renderChoose(
	workspaces: { id: string; name: string }[],
	invites: { workspaceId: string; workspaceName: string }[] = [],
	message: string | null = null,
): string {
	const note = message ? `<p class="overlap">${esc(message)}</p>` : "";
	const options = workspaces
		.map(
			(workspace) => `<form method="post" action="/choose">${hidden("workspace", workspace.id)}
        <button class="secondary" type="submit">Open ${esc(workspace.name)}</button></form>`,
		)
		.join("");
	const joins = invites
		.map(
			(invite) => `<form method="post" action="/join">${hidden("workspace", invite.workspaceId)}
        <button class="secondary" type="submit">Join ${esc(invite.workspaceName)}</button></form>`,
		)
		.join("");
	return page({
		main: `<div class="sheet"><h1>Open a workspace</h1>${note}${options}${joins}</div>`,
	});
}

function html(body: string, status = 200, headers?: HeadersInit): Response {
	const out = new Headers(headers);
	out.set("Content-Type", "text/html; charset=utf-8");
	return new Response(body, { status, headers: out });
}

function redirect(location: string, headers?: HeadersInit): Response {
	const out = new Headers(headers);
	out.set("Location", location);
	return new Response(null, { status: 303, headers: out });
}

function back(item: string | null, suggestion: string | null, notice?: string): string {
	const params = new URLSearchParams();
	if (item) params.set("item", item);
	if (suggestion) params.set("suggestion", suggestion);
	if (notice) params.set("notice", notice);
	const query = params.toString();
	return query ? `/?${query}` : "/";
}

async function fields(request: Request): Promise<URLSearchParams> {
	return new URLSearchParams(await request.text());
}


export async function handleScreen(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
	const url = new URL(request.url);
	const path = url.pathname;
	const link = /^\/s\/([0-9a-f]{64})$/.exec(path);
	const screen =
		path === "/" ||
		path === "/start" ||
		path === "/sign-in" ||
		path === "/sign-out" ||
		path === "/choose" ||
		path === "/people" ||
		path === "/invite" ||
		path === "/agents" ||
		path === "/agents/rename" ||
		path === "/agents/revoke" ||
		path === "/agents/key" ||
		path === "/agents/remove" ||
		path === "/people/remove" ||
		path === "/people/role" ||
		path === "/invitations/cancel" ||
		path === "/settings" ||
		path === "/workspace/delete" ||
		path === "/lock" ||
		path === "/unlock" ||
		path === "/enter" ||
		path === "/join" ||
		path === "/publish" ||
		path === "/resolve" ||
		path === "/decline" ||
		path === "/suggestion" ||
		Boolean(link);
	if (!screen) return null;

	try {
		if (link && signInMode(env) === "access") return html(renderAccessGate(), 404);

		if (link && (request.method === "GET" || request.method === "POST")) {
			const secret = link[1] ?? "";
			if (request.method === "GET") {
				const pending = await peekLink(env, secret);
				if (!pending) return html(renderGate("That link has expired or was already used."), 400);
				const label = await confirmLabel(env, pending);
				if (!label) return html(renderGate("That link has expired or was already used."), 400);
				return html(renderConfirm(label, secret));
			}
			const joined = await joinFromLink(env, secret);
			if ("message" in joined) return html(renderGate(joined.message), 400);
			if ("choose" in joined) {
				return html(renderChoose(joined.choose.workspaces), 200, { "Set-Cookie": chooseCookie(joined.choose.secret) });
			}
			return signedInRedirect(request, [keyCookie(joined.joined.secret), clearChooseCookie()]);
		}

		if (request.method === "POST" && path === "/start" && signInMode(env) === "access") {
			const seen = await seenEmail(request, env);
			if (!seen) return html(renderAccessGate(), 401);
			const form = await fields(request);
			const workspace = cleanWorkspaceName(form.get("workspace") ?? "");
			if (!workspace) return html(renderArrived("Give the workspace a short name."), 400);
			const reserved = await reserveWorkspaceStart(env, seen, clientIp(request));
			if ("message" in reserved) return html(renderArrived(reserved.message), 429);
			const started = await finishWorkspaceStart(env, seen, workspace);
			if ("message" in started) {
				await releaseWorkspaceStart(env, reserved.id);
				return html(renderArrived(started.message), 400);
			}
			await takeLink(env, readCookie(request, SEEN_COOKIE) ?? "");
			return signedInRedirect(request, [keyCookie(started.joined.secret), clearSeenCookie()]);
		}

		if (request.method === "POST" && path === "/start") {
			const form = await fields(request);
			const workspace = cleanWorkspaceName(form.get("workspace") ?? "");
			const email = normalizeEmail(form.get("email") ?? "");
			if (!workspace) return html(renderGate("Give the workspace a short name."), 400);
			if (!email) return html(renderGate("Enter an email address."), 400);
			const reserved = await reserveWorkspaceStart(env, email, clientIp(request));
			if ("message" in reserved) return html(renderGate(reserved.message), 429);
			const sent = await issueSignInLink(env, request, url.origin, {
				email,
				purpose: "start",
				workspaceName: workspace,
			});
			if (!sent.ok) await releaseWorkspaceStart(env, reserved.id);
			return html(renderGate(sent.message, sent.ok ? "ok" : "error"), sent.ok ? 200 : sent.status);
		}

		if (request.method === "POST" && path === "/sign-in" && signInMode(env) === "access") {
			return html(renderAccessGate(), 404);
		}

		if (request.method === "POST" && path === "/sign-in") {
			const form = await fields(request);
			const email = normalizeEmail(form.get("email") ?? "");
			if (!email) return html(renderGate("Enter an email address."), 400);
			const work = deliverSignIn(env, url.origin, email, clientIp(request));
			if (ctx) ctx.waitUntil(work);
			else await work;
			return html(renderGate(SIGN_IN_ACK, "ok"), 200);
		}

		if (request.method === "POST" && path === "/choose") {
			const secret = readCookie(request, CHOOSE_COOKIE);
			const form = await fields(request);
			const workspaceId = form.get("workspace") ?? "";
			if (!secret) return html(renderGate("That link has expired or was already used."), 400);
			const taken = await takeLink(env, secret);
			if (!taken || taken.purpose !== "choose") return html(renderGate("That link has expired or was already used."), 400);
			const joined = await chooseWorkspace(env, taken.email, workspaceId);
			if ("message" in joined) return html(renderGate(joined.message), 400);
			return signedInRedirect(request, [keyCookie(joined.secret), clearChooseCookie()]);
		}

		if (request.method === "GET" && path === "/choose") {
			const secret = readCookie(request, CHOOSE_COOKIE);
			if (!secret) return html(renderGate("That link has expired or was already used."), 400);
			const pending = await peekLink(env, secret);
			if (!pending) return html(renderGate("That link has expired or was already used."), 400);
			const homes = await memberships(env.DB, pending.email);
			const invites = await pendingInvitations(env.DB, pending.email);
			return html(renderChoose(homes.map((item) => item.workspace), inviteChoices(invites)));
		}

		if (request.method === "POST" && path === "/sign-out") {
			await signOut(request, env);
			const logout = accessLogoutUrl(env);
			const headers = new Headers({ "Set-Cookie": clearCookie() });
			headers.append("Set-Cookie", clearSeenCookie());
			if (logout) {
				headers.set("Location", logout);
				return new Response(null, { status: 303, headers });
			}
			headers.set("Location", "/");
			return new Response(null, { status: 303, headers });
		}

		if (path === "/enter" && request.method === "GET") {
			return enterFromAccess(request, env, ctx as AccessRuntime | undefined);
		}

		if (request.method === "POST" && path === "/join") {
			const held = await heldEmail(request, env);
			if (!held) {
				if (signInMode(env) === "access") return html(renderAccessGate(), 401);
				return html(renderGate("That link has expired or was already used."), 400);
			}
			const form = await fields(request);
			const joined = await acceptInvitation(env, held.email, form.get("workspace") ?? "");
			if ("message" in joined) {
				if (held.purpose === "choose") {
					const homes = await memberships(env.DB, held.email);
					const invites = await pendingInvitations(env.DB, held.email);
					return html(renderChoose(homes.map((item) => item.workspace), inviteChoices(invites), joined.message), 400);
				}
				const invites = await pendingInvitations(env.DB, held.email);
				return html(renderArrived(joined.message, inviteChoices(invites)), 400);
			}
			await takeLink(env, held.secret);
			return signedInRedirect(request, [keyCookie(joined.secret), clearSeenCookie(), clearChooseCookie()]);
		}

		const signed = await actorFromRequest(request, env);
		if (!signed) {
			if (request.method === "GET" && path === "/") {
				return html(signInMode(env) === "access" ? renderAccessGate() : renderGate(null));
			}
			if (signInMode(env) === "access") return html(renderAccessGate(), 401);
			return html(renderGate("Send yourself a sign-in link to open the library."), 401);
		}

		if (
			signed.actor.kind === "agent" &&
			request.method === "POST" &&
			["/invite", "/people/role", "/people/remove", "/settings", "/workspace/delete", "/lock", "/unlock", "/invitations/cancel", "/publish", "/decline", "/resolve"].includes(path)
		) {
			const form = path === "/resolve" ? await fields(request) : null;
			const action =
				path === "/decline"
					? "decline"
					: path === "/resolve" && form?.get("mode") === "combine"
						? "combine"
						: path === "/publish" || path === "/resolve"
							? "publish"
							: path === "/settings" || path === "/workspace/delete"
								? "members-can-publish"
								: path === "/lock" || path === "/unlock"
									? "lock"
									: "invite";
			const decision = await authorize(env, signed.actor, action);
			return html(renderGate(decision.ok ? "An agent cannot change the workspace." : decision.sentence), 403);
		}

		if (signed.actor.kind === "person" && request.method === "POST" && (path === "/lock" || path === "/unlock")) {
			const form = await fields(request);
			const item = cleanPath(form.get("item"));
			if (!item) return redirect(back(null, null, "Choose a page first."));
			const problem = await setPageLock(env, signed.actor, item, path === "/lock");
			return redirect(back(item, null, problem ?? (path === "/lock" ? "Locked." : "Unlocked.")));
		}

		if (signed.actor.kind === "person" && request.method === "GET" && path === "/people") {
			return peoplePage(env, signed.actor, url.origin, url.searchParams.get("notice"), null);
		}

		if (signed.actor.kind === "person" && request.method === "POST" && path === "/invite") {
			const form = await fields(request);
			const role = form.get("role") === "admin" ? "admin" : "member";
			const invited = await invitePerson(env, signed.actor, form.get("email") ?? "", role);
			if ("message" in invited) return peoplePage(env, signed.actor, url.origin, invited.message, null);
			if (signInMode(env) === "link") {
				const workspace = await workspaceById(env.DB, signed.actor.workspaceId);
				const sent = await issueSignInLink(env, request, url.origin, {
					email: invited.invitation.email,
					purpose: "invite",
					workspaceId: signed.actor.workspaceId,
					workspaceName: workspace?.name ?? null,
					invitedBy: signed.actor.id,
				});
				return peoplePage(env, signed.actor, url.origin, sent.ok ? SENT : sent.message, null);
			}
			return peoplePage(env, signed.actor, url.origin, "They will join when they sign in.", null);
		}

		if (signed.actor.kind === "person" && request.method === "POST" && path === "/invitations/cancel") {
			const form = await fields(request);
			const problem = await cancelInvitation(env, signed.actor, form.get("id") ?? "");
			return peoplePage(env, signed.actor, url.origin, problem ?? "Cancelled.", null);
		}

		if (signed.actor.kind === "person" && request.method === "POST" && path === "/people/role") {
			const form = await fields(request);
			const personId = form.get("id") ?? "";
			const role = form.get("role") === "admin" ? "admin" : "member";
			const target = (await listActors(env.DB, signed.actor.workspaceId)).find((item) => item.id === personId);
			const problem = await changeRole(env, signed.actor, personId, role);
			return peoplePage(env, signed.actor, url.origin, problem ?? roleSentence(target?.name ?? "They", role), null);
		}

		if (signed.actor.kind === "person" && request.method === "POST" && path === "/settings") {
			const form = await fields(request);
			const problem = await saveWorkspaceSettings(
				env,
				signed.actor,
				form.get("name") ?? "",
				form.get("members_can_publish") === "yes",
			);
			return peoplePage(env, signed.actor, url.origin, problem ?? "Saved.", null);
		}

		if (signed.actor.kind === "person" && request.method === "POST" && path === "/workspace/delete") {
			const form = await fields(request);
			const problem = await deleteWorkspace(env, signed.actor, form.get("name") ?? "");
			if (problem) return peoplePage(env, signed.actor, url.origin, problem, null);
			await signOut(request, env);
			return redirect("/", { "Set-Cookie": clearCookie() });
		}

		if (signed.actor.kind === "person" && request.method === "POST" && path === "/people/remove") {
			const form = await fields(request);
			const personId = form.get("id") ?? "";
			if (form.get("confirm") !== "yes") {
				const decision = await authorize(env, signed.actor, "remove-person", null, { targetId: personId });
				if (!decision.ok) return peoplePage(env, signed.actor, url.origin, decision.sentence, null);
				const target = (await listActors(env.DB, signed.actor.workspaceId)).find((item) => item.id === personId);
				return html(renderRemoveConfirm(target?.name ?? "this person", personId));
			}
			const problem = await removePerson(env, signed.actor, personId);
			return peoplePage(env, signed.actor, url.origin, problem, null);
		}

		if (signed.actor.kind === "person" && request.method === "POST" && path === "/agents") {
			const form = await fields(request);
			const connected = await connectAgent(env, signed.actor, form.get("name") ?? "", form.get("tool") ?? "other");
			if ("message" in connected) return peoplePage(env, signed.actor, url.origin, connected.message, null);
			return peoplePage(env, signed.actor, url.origin, null, { name: connected.actor.name, key: connected.key });
		}

		if (signed.actor.kind === "person" && request.method === "POST" && path === "/agents/rename") {
			const form = await fields(request);
			const problem = await renameAgent(env, signed.actor, form.get("id") ?? "", form.get("name") ?? "");
			return peoplePage(env, signed.actor, url.origin, problem, null);
		}

		if (signed.actor.kind === "person" && request.method === "POST" && path === "/agents/revoke") {
			const form = await fields(request);
			const problem = await revokeAgentKey(env, signed.actor, form.get("id") ?? "");
			return peoplePage(env, signed.actor, url.origin, problem ?? "The key no longer works.", null);
		}

		if (signed.actor.kind === "person" && request.method === "POST" && path === "/agents/key") {
			const form = await fields(request);
			const minted = await freshAgentKey(env, signed.actor, form.get("id") ?? "");
			if ("message" in minted) return peoplePage(env, signed.actor, url.origin, minted.message, null);
			return peoplePage(env, signed.actor, url.origin, null, { name: "This agent", key: minted.key });
		}

		if (signed.actor.kind === "person" && request.method === "POST" && path === "/agents/remove") {
			const form = await fields(request);
			const problem = await removeAgent(env, signed.actor, form.get("id") ?? "");
			return peoplePage(env, signed.actor, url.origin, problem, null);
		}

		const scoped = scopedEnv(env, signed.actor.workspaceId);
		try {
			if (request.method === "POST" && path === "/suggestion") {
				const body = (await request.json().catch(() => ({}))) as {
					session?: unknown;
					path?: unknown;
					content?: unknown;
					why?: unknown;
				};
				const saved = await saveAgentSuggestion(scoped.env, signed.actor, signed.key, url.origin, {
					session: typeof body.session === "string" ? body.session : crypto.randomUUID().slice(0, 8),
					path: typeof body.path === "string" ? body.path : "",
					content: typeof body.content === "string" ? body.content : "",
					why: typeof body.why === "string" ? body.why : "",
				});
				return Response.json({ ok: true, name: saved.name, edition: saved.edition });
			}

			if (request.method === "GET" && path === "/") {
				const item = cleanPath(url.searchParams.get("item"));
				const suggestion = cleanName(url.searchParams.get("suggestion"));
				const notice = url.searchParams.get("notice");
				const before = url.searchParams.get("before");
				const desk = await loadDesk(scoped.env, signed.actor, signed.key, url.origin, item, suggestion, notice, before);
				return html(renderDesk(desk, suggestion));
			}

			if (request.method === "POST" && (path === "/publish" || path === "/resolve" || path === "/decline")) {
				const form = await fields(request);
				const item = cleanPath(form.get("item"));
				const suggestion = cleanName(form.get("suggestion"));
				if (!item || !suggestion) throw new DeskError("Choose a suggestion first.");
				if (path === "/decline") {
					await declineSuggestion(scoped.env, signed.actor, suggestion, item);
					return redirect(back(item, null, "Declined."));
				}
				if (path === "/resolve" && form.get("mode") === "combine") {
					const name = await combineSuggestions(scoped.env, signed.actor, url.origin, suggestion, item);
					return redirect(back(item, name, "Combined into a new suggestion."));
				}
				const mode = path === "/publish" ? "publish" : form.get("mode") === "keep-other" ? "keep-other" : "keep-this";
				const notice = await publishSuggestion(
					scoped.env,
					signed.actor,
					signed.key,
					url.origin,
					suggestion,
					item,
					mode,
				);
				const stay = notice.startsWith("Nothing was published") || notice.startsWith("Kept the current");
				return redirect(back(item, stay ? suggestion : null, notice));
			}
		} finally {
			await scoped.flush();
		}
	} catch (error) {
		if (error instanceof DeskError) {
			if (path === "/suggestion") return Response.json({ ok: false, error: error.message }, { status: error.status });
			return html(renderGate(error.message), error.status);
		}
		const failure = describeError(error);
		console.error(failure.code, failure.message);
		if (path === "/suggestion") {
			return Response.json({ ok: false, error: "The suggestion could not be saved." }, { status: 500 });
		}
		return html(renderGate("The library could not be opened. Try again."), 500);
	}
	return html(renderGate(null), 405);
}

function signedInRedirect(request: Request, cookies: string[]): Response {
	const back = safeReturnPath(readCookie(request, RETURN_COOKIE) ?? "");
	if (!back) return redirectCookies("/", cookies);
	return redirectCookies(back, [...cookies, clearReturnCookie()]);
}

/**
 * Access sends the person back here from another site. A redirect that sets a
 * Strict cookie is not sent on the next request, so the page would redirect
 * forever. A normal page sets the cookie, then continues.
 * https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#samesitesamesite-value
 */
function continueAfterAccess(location: string, cookies: string[]): Response {
	const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
	for (const cookie of cookies) headers.append("Set-Cookie", cookie);
	const href = esc(location);
	const body = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${href}"><title>Stylebook</title></head><body><p><a href="${href}">Continue</a></p></body></html>`;
	return new Response(body, { status: 200, headers });
}

function redirectCookies(location: string, cookies: string[]): Response {
	const headers = new Headers({ Location: location });
	for (const cookie of cookies) headers.append("Set-Cookie", cookie);
	return new Response(null, { status: 303, headers });
}

async function peoplePage(
	env: Env,
	actor: import("./actors").Actor,
	origin: string,
	message: string | null,
	reveal: { name: string; key: string } | null,
): Promise<Response> {
	const state = await workspaceState(env.DB, actor.workspaceId);
	const admin = (await authorize(env, actor, "invite")).ok;
	const actors = await listActors(env.DB, actor.workspaceId);
	const people = actors
		.filter((item) => item.kind === "person")
		.map((item) => {
			const theirs = actors.filter((agent) => agent.kind === "agent" && agent.ownerId === item.id);
			return {
				id: item.id,
				name: item.name,
				email: item.email ?? "",
				role: item.role === "admin" ? "admin" : "member",
				joined: item.createdAt ?? null,
				you: item.id === actor.id,
				starter: state?.ownerId === item.id,
				agents: theirs.length === 0 ? "" : `Agents: ${theirs.map((agent) => agent.name).join(", ")}`,
			};
		});
	const agents = actors
		.filter((item) => item.kind === "agent" && (admin || item.ownerId === actor.id))
		.map((item) => ({
			id: item.id,
			name: item.name,
			tool: item.model ?? "Another tool",
			person: actors.find((person) => person.id === item.ownerId)?.name ?? "Someone",
			lastUsed: item.lastUsedAt ?? null,
			yours: item.ownerId === actor.id,
		}));
	const invites = admin ? await invitationsForWorkspace(env.DB, actor.workspaceId) : [];
	return html(
		renderPeople(
			state?.name ?? "Workspace",
			people,
			agents,
			invites.map((item) => ({ id: item.id, email: item.email, role: item.role })),
			message,
			reveal ? { ...reveal, origin, workspaceId: actor.workspaceId } : null,
			admin,
			state?.ownerId === actor.id,
			state?.membersCanPublish ?? false,
			signInMode(env) === "link",
		),
	);
}

function renderAccessGate(): string {
	return page({
		main: `<div class="sheet">
      <h1>Sign in</h1>
      <p>Stylebook sends a one-time code to your email. Then you can open a workspace, accept an invitation, or start one.</p>
      <p><a class="primary" href="/enter">Sign in</a></p>
    </div>`,
	});
}

function renderArrived(message: string | null, invites: { workspaceId: string; workspaceName: string }[] = []): string {
	const note = message ? `<p class="overlap">${esc(message)}</p>` : "";
	const cards = invites
		.map(
			(invite) => `<p>You have an invitation to ${esc(invite.workspaceName)}.</p>
        <form method="post" action="/join">${hidden("workspace", invite.workspaceId)}
          <button class="primary" type="submit">Join ${esc(invite.workspaceName)}</button>
        </form>`,
		)
		.join("");
	return page({
		main: `<div class="sheet">
      <h1>${invites.length > 0 ? "You have an invitation" : "Start a workspace"}</h1>
      ${note}
      ${cards}
      <h2>Start a workspace</h2>
      <form method="post" action="/start">
        <label for="workspace">Workspace name</label>
        <input id="workspace" name="workspace" autocomplete="organization" required>
        <button class="primary" type="submit">Start</button>
      </form>
    </div>`,
	});
}

async function seenEmail(request: Request, env: Env): Promise<string | null> {
	const secret = readCookie(request, SEEN_COOKIE);
	if (!secret) return null;
	const pending = await peekLink(env, secret);
	if (!pending || pending.purpose !== "sign-in") return null;
	return pending.email;
}

function inviteChoices(invites: { workspaceId: string; workspaceName: string }[]): { workspaceId: string; workspaceName: string }[] {
	return invites.map((item) => ({ workspaceId: item.workspaceId, workspaceName: item.workspaceName }));
}

async function heldEmail(
	request: Request,
	env: Env,
): Promise<{ email: string; secret: string; purpose: "sign-in" | "choose" } | null> {
	const seen = readCookie(request, SEEN_COOKIE);
	if (seen) {
		const pending = await peekLink(env, seen);
		if (pending?.purpose === "sign-in") return { email: pending.email, secret: seen, purpose: "sign-in" };
	}
	const choose = readCookie(request, CHOOSE_COOKIE);
	if (choose) {
		const pending = await peekLink(env, choose);
		if (pending?.purpose === "choose") return { email: pending.email, secret: choose, purpose: "choose" };
	}
	return null;
}

async function enterFromAccess(request: Request, env: Env, runtime?: AccessRuntime): Promise<Response> {
	if (signInMode(env) !== "access") return redirect("/");
	const email = await verifiedEmail(request, env, runtime);
	if (!email) return html(renderAccessGate(), 401);
	await recordSignIn(env.DB, email);
	const homes = await memberships(env.DB, email);
	const invites = await pendingInvitations(env.DB, email);
	if (homes.length === 1 && invites.length === 0) {
		const home = homes[0]!;
		const back = safeReturnPath(readCookie(request, RETURN_COOKIE) ?? "") ?? "/";
		return continueAfterAccess(back, [
			keyCookie(await openSession(env.DB, home.actor)),
			clearSeenCookie(),
			clearReturnCookie(),
		]);
	}
	if (homes.length > 0) {
		const choice = await rememberLink(env, email, "choose");
		return html(renderChoose(homes.map((item) => item.workspace), inviteChoices(invites)), 200, {
			"Set-Cookie": chooseCookie(choice),
		});
	}
	const secret = await rememberLink(env, email, "sign-in");
	return html(renderArrived(null, inviteChoices(invites)), 200, { "Set-Cookie": seenCookie(secret) });
}
