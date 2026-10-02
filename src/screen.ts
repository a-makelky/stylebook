// The review screen. One page: the library, the open suggestions, and history.
// Words on this page follow design/README.md.

import { actorFromRequest, chooseCookie, clearChooseCookie, clearCookie, keyCookie, readCookie, CHOOSE_COOKIE, signOut } from "./auth";
import { listActors } from "./actors";
import { issueSignInLink, noteSignInAttempt, peekLink, takeLink } from "./mail";
import { LIMIT_MESSAGE, limitsOf } from "./limits";
import {
	chooseWorkspace,
	cleanWorkspaceName,
	connectAgent,
	countMembers,
	countWorkspaces,
	freshAgentKey,
	joinFromLink,
	memberships,
	removePerson,
	renameAgent,
	revokeAgentKey,
	workspaceById,
} from "./teams";
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
	type Desk,
	type DeskSuggestion,
} from "./review";

function esc(value: string): string {
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
	const ways = conflict
		? `<p class="overlap">Nothing was published. These lines also changed in ${
				conflict.current ? "the current edition" : `Suggestion ${conflict.otherNumber}`
			}.</p>
        <form method="post" action="/resolve">${hidden("item", item)}${hidden("suggestion", suggestion.name)}${hidden("other", conflict.otherName)}${hidden("mode", "keep-this")}
          <button class="primary" type="submit">Keep this one</button>
        </form>
        <form method="post" action="/resolve">${hidden("item", item)}${hidden("suggestion", suggestion.name)}${hidden("other", conflict.otherName)}${hidden("mode", "keep-other")}
          <button class="secondary" type="submit">Keep the other</button>
        </form>
        <form method="post" action="/resolve">${hidden("item", item)}${hidden("suggestion", suggestion.name)}${hidden("other", conflict.otherName)}${hidden("mode", "combine")}
          <button class="secondary" type="submit">${icon("combine", true)} Ask an agent to combine them</button>
        </form>`
		: "";
	const publish = desk.canPublish
		? `<form method="post" action="/publish">${hidden("item", item)}${hidden("suggestion", suggestion.name)}
            <button class="primary" type="submit">${icon("publish", true)} Publish</button>
          </form>
          <form method="post" action="/decline">${hidden("item", item)}${hidden("suggestion", suggestion.name)}
            <button class="text" type="submit">${icon("decline", true)} Decline</button>
          </form>`
		: `<p class="meta">${icon("locked", true)} Locked</p>`;
	return `<article class="suggestion${selected ? " selected" : ""}">
    <a href="${href}">${icon("suggestion", true)} <span class="ring ${suggestion.combined ? "green" : selected ? "blue" : ""}">${suggestion.number}</span>
      <span class="who">Written by ${esc(suggestion.writer)} for ${esc(suggestion.owner)}</span></a>
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
					return `<li><a href="${href}"${current}>${esc(item.title)}</a></li>`;
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
	const locked = desk.canPublish ? "" : `<p class="meta">${icon("locked", true)} Locked</p>`;
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
		main: `<p class="meta bar"><span>${esc(desk.workspaceName)}</span> <a href="/people">People and agents</a>
      <form method="post" action="/sign-out"><button class="text" type="submit">Sign out</button></form></p>
    <div class="desk">
      <nav class="contents"><h2>${icon("library", true)} Library</h2>${contents}</nav>
      <article class="page">
        <h1>${esc(desk.title)}</h1>
        ${edition}
        ${locked}
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

function page(parts: { main: string }): string {
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
  .wordmark { font-style: italic; font-weight: 500; font-size: 28px; line-height: 1.1; margin: 0; }
  header { padding: 28px 24px 0; }
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
  button { font-size: 17px; line-height: 1.5; cursor: pointer; }
  button.primary, button.secondary { min-height: 44px; padding: 0 16px; border-radius: 3px; }
  button.primary { background: var(--ink); color: var(--paper); border: none; }
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
  .bar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
  .bar input { width: auto; flex: 1; min-width: 12rem; margin: 0; }
  pre { white-space: pre-wrap; font: inherit; font-size: 16px; line-height: 1.5; margin: 8px 0 16px; }
  .history { border-top: 1px solid var(--rule); margin-top: 32px; }
  @media (max-width: 1099px) {
    header { padding-left: 16px; padding-right: 16px; }
    .desk { display: flex; flex-direction: column; padding: 24px 16px 48px; }
    .page { order: 1; }
    .suggestions { order: 2; }
    .contents { order: 3; }
  }
  @media (prefers-reduced-motion: reduce) {
    .settle .mark, .settle .caret, .settle .ring { color: var(--ink); text-decoration: none; font-style: normal; }
  }
</style>
</head>
<body>
<header><p class="wordmark">Stylebook</p></header>
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
    <p>Paste this where that tool keeps its connections. The key is in the header.</p>
    <pre data-setup>${esc(mcp)}</pre>
    <h2>For a folder on your computer</h2>
    <p>Paste this to read the library. Saving a suggestion uses the same key.</p>
    <pre data-setup>${esc(folder)}</pre>`;
}

function renderPeople(
	workspaceName: string,
	people: { id: string; name: string; you: boolean }[],
	agents: { id: string; name: string; tool: string }[],
	message: string | null,
	reveal: { name: string; key: string; origin: string; workspaceId: string } | null,
): string {
	const note = message ? `<p class="overlap">${esc(message)}</p>` : "";
	const shown = reveal
		? `<p class="notice">This key for ${esc(reveal.name)} is shown once. Copy it now.</p>
       <p><code>${esc(reveal.key)}</code></p>
       ${setupMarkup(reveal.origin, reveal.workspaceId, reveal.key)}`
		: "";
	const personRows = people
		.map(
			(person) => `<div class="person bar"><span>${esc(person.name)}${person.you ? " (you)" : ""}</span>
        ${
					person.you
						? ""
						: `<form method="post" action="/people/remove">${hidden("id", person.id)}<button class="text" type="submit">Remove</button></form>`
				}</div>`,
		)
		.join("");
	const agentRows = agents
		.map(
			(agent) => `<div class="agent">
        <p>${esc(agent.name)} <span class="meta">${esc(agent.tool)}</span></p>
        <form method="post" action="/agents/rename" class="bar">${hidden("id", agent.id)}
          <label for="rename-${esc(agent.id)}">Name</label>
          <input id="rename-${esc(agent.id)}" name="name" value="${esc(agent.name)}" required>
          <button class="secondary" type="submit">Rename</button>
        </form>
        <form method="post" action="/agents/revoke">${hidden("id", agent.id)}<button class="text" type="submit">Revoke the key</button></form>
        <form method="post" action="/agents/key">${hidden("id", agent.id)}<button class="text" type="submit">Make a new key</button></form>
      </div>`,
		)
		.join("");
	return page({
		main: `<div class="sheet">
      <p class="meta"><a href="/">Library</a></p>
      <h1>${esc(workspaceName)}</h1>
      ${note}
      ${shown}
      <h2>Invite a colleague</h2>
      <form method="post" action="/invite">
        <label for="invite-email">Email</label>
        <input id="invite-email" name="email" type="email" autocomplete="email" required>
        <button class="primary" type="submit">Send an invite</button>
      </form>
      <h2>People</h2>
      ${personRows || `<p class="meta">Just you, so far.</p>`}
      <h2>Connect an agent</h2>
      <form method="post" action="/agents">
        <label for="agent-name">Name</label>
        <input id="agent-name" name="name" required placeholder="Claude, working for me">
        <label for="tool">Tool</label>
        <select id="tool" name="tool">
          <option value="cursor">Cursor</option>
          <option value="claude">Claude Code</option>
          <option value="other">Another tool</option>
        </select>
        <button class="primary" type="submit">Connect</button>
      </form>
      ${agentRows}
      <form method="post" action="/sign-out"><button class="text" type="submit">Sign out</button></form>
    </div>`,
	});
}

function renderChoose(workspaces: { id: string; name: string }[]): string {
	const options = workspaces
		.map(
			(workspace) => `<form method="post" action="/choose">${hidden("workspace", workspace.id)}
        <button class="secondary" type="submit">Open ${esc(workspace.name)}</button></form>`,
		)
		.join("");
	return page({
		main: `<div class="sheet"><h1>Open a workspace</h1>${options}</div>`,
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


export async function handleScreen(request: Request, env: Env): Promise<Response | null> {
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
		path === "/people/remove" ||
		path === "/publish" ||
		path === "/resolve" ||
		path === "/decline" ||
		path === "/suggestion" ||
		Boolean(link);
	if (!screen) return null;

	try {
		if (request.method === "GET" && link) {
			const joined = await joinFromLink(env, link[1] ?? "");
			if ("message" in joined) return html(renderGate(joined.message), 400);
			if ("choose" in joined) {
				return html(renderChoose(joined.choose.workspaces), 200, { "Set-Cookie": chooseCookie(joined.choose.secret) });
			}
			return redirectCookies("/", [keyCookie(joined.joined.secret), clearChooseCookie()]);
		}

		if (request.method === "POST" && path === "/start") {
			const form = await fields(request);
			const workspace = cleanWorkspaceName(form.get("workspace") ?? "");
			const email = form.get("email") ?? "";
			if (!workspace) return html(renderGate("Give the workspace a short name."), 400);
			if ((await countWorkspaces(env.DB)) >= limitsOf(env).workspaces) {
				return html(renderGate(LIMIT_MESSAGE.workspaces), 429);
			}
			const sent = await issueSignInLink(env, request, url.origin, {
				email,
				purpose: "start",
				workspaceName: workspace,
			});
			return html(renderGate(sent.message, sent.ok ? "ok" : "error"), sent.ok ? 200 : 429);
		}

		if (request.method === "POST" && path === "/sign-in") {
			const form = await fields(request);
			const email = form.get("email") ?? "";
			const homes = email.includes("@") ? await memberships(env.DB, email.trim().toLowerCase()) : [];
			const sent =
				homes.length === 0
					? await noteSignInAttempt(env, request, email)
					: await issueSignInLink(env, request, url.origin, { email, purpose: "sign-in" });
			const status = sent.ok ? 200 : sent.message === "Enter an email address." ? 400 : 429;
			return html(renderGate(sent.message, sent.ok ? "ok" : "error"), status);
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
			return redirectCookies("/", [keyCookie(joined.secret), clearChooseCookie()]);
		}

		if (request.method === "GET" && path === "/choose") {
			const secret = readCookie(request, CHOOSE_COOKIE);
			if (!secret) return html(renderGate("That link has expired or was already used."), 400);
			const pending = await peekLink(env, secret);
			if (!pending) return html(renderGate("That link has expired or was already used."), 400);
			const homes = await memberships(env.DB, pending.email);
			return html(renderChoose(homes.map((item) => item.workspace)));
		}

		if (request.method === "POST" && path === "/sign-out") {
			await signOut(request, env);
			return redirect("/", { "Set-Cookie": clearCookie() });
		}

		const signed = await actorFromRequest(request, env);
		if (!signed) {
			if (request.method === "GET" && path === "/") return html(renderGate(null));
			return html(renderGate("Send yourself a sign-in link to open the library."), 401);
		}

		if (signed.actor.kind === "person" && request.method === "GET" && path === "/people") {
			return peoplePage(env, signed.actor, url.origin, url.searchParams.get("notice"), null);
		}

		if (signed.actor.kind === "person" && request.method === "POST" && path === "/invite") {
			const form = await fields(request);
			const email = (form.get("email") ?? "").trim().toLowerCase();
			const homes = await memberships(env.DB, email);
			const already = homes.some((item) => item.workspace.id === signed.actor.workspaceId);
			if (!already && (await countMembers(env.DB, signed.actor.workspaceId, "person")) >= limitsOf(env).people) {
				return peoplePage(env, signed.actor, url.origin, LIMIT_MESSAGE.people, null);
			}
			const workspace = await workspaceById(env.DB, signed.actor.workspaceId);
			const sent = await issueSignInLink(env, request, url.origin, {
				email,
				purpose: "invite",
				workspaceId: signed.actor.workspaceId,
				workspaceName: workspace?.name ?? null,
				invitedBy: signed.actor.id,
			});
			return peoplePage(env, signed.actor, url.origin, sent.ok ? SENT : sent.message, null);
		}

		if (signed.actor.kind === "person" && request.method === "POST" && path === "/people/remove") {
			const form = await fields(request);
			const problem = await removePerson(env, signed.actor, form.get("id") ?? "");
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
		if (path === "/suggestion") {
			const failure = describeError(error);
			console.error(failure.code, failure.message);
			return Response.json({ ok: false, error: "The suggestion could not be saved." }, { status: 500 });
		}
		return html(renderGate("The library could not be opened. Try again."), 500);
	}
	return html(renderGate(null), 405);
}

const SENT = "Check your inbox. The link works once and expires in 15 minutes.";

function redirectCookies(location: string, cookies: string[]): Response {
	const headers = new Headers({ Location: location });
	for (const cookie of cookies) headers.append("Set-Cookie", cookie);
	return new Response(null, { status: 303, headers });
}

async function peoplePage(
	env: Env,
	actor: { id: string; name: string; workspaceId: string; kind: string },
	origin: string,
	message: string | null,
	reveal: { name: string; key: string } | null,
): Promise<Response> {
	const workspace = await workspaceById(env.DB, actor.workspaceId);
	const actors = await listActors(env.DB, actor.workspaceId);
	const people = actors
		.filter((item) => item.kind === "person")
		.map((item) => ({ id: item.id, name: item.name, you: item.id === actor.id }));
	const agents = actors
		.filter((item) => item.kind === "agent" && item.ownerId === actor.id)
		.map((item) => ({ id: item.id, name: item.name, tool: item.model ?? "Another tool" }));
	return html(
		renderPeople(
			workspace?.name ?? "Workspace",
			people,
			agents,
			message,
			reveal ? { ...reveal, origin, workspaceId: actor.workspaceId } : null,
		),
	);
}
