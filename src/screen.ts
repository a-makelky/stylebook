// The review screen. One page: the library, the open suggestions, and history.
// Words on this page follow design/README.md.

import { actorFromRequest, clearCookie, keyCookie } from "./auth";
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
	const flush = () => {
		if (list.length === 0) return;
		html.push(`<ul>${list.join("")}</ul>`);
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
		if (/^(?:[-*]|\d+\.)\s/.test(line.text)) {
			const item = line.text.replace(/^(?:[-*]|\d+\.)\s+/, "");
			list.push(`<li>${mark({ ...line, text: item })}</li>`);
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
		main: `<div class="desk">
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
  .contents ul, .page-body ul { list-style: none; padding: 0; margin: 0; }
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
  .sign-in { max-width: 36ch; padding: 48px 16px 64px; margin: 0 auto; }
  .sign-in label, .sign-in input { display: block; width: 100%; font-size: 17px; }
  .sign-in input { min-height: 44px; margin: 8px 0 16px; padding: 8px 12px; border: 1px solid var(--ink); border-radius: 3px; background: var(--paper); color: var(--ink); }
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

export function renderSignIn(message: string | null): string {
	const note = message ? `<p class="overlap">${esc(message)}</p>` : "";
	return page({
		main: `<form class="sign-in" method="post" action="/sign-in">
      <label for="key">Stylebook key</label>
      <input id="key" name="key" type="password" autocomplete="current-password" required>
      ${note}
      <button class="primary" type="submit">Open the library</button>
    </form>`,
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
	const screen =
		path === "/" ||
		path === "/sign-in" ||
		path === "/sign-out" ||
		path === "/publish" ||
		path === "/resolve" ||
		path === "/decline" ||
		path === "/suggestion";
	if (!screen) return null;

	try {
		if (request.method === "POST" && path === "/sign-in") {
			const form = await fields(request);
			const key = form.get("key")?.trim() ?? "";
			const probe = new Request(request.url, { headers: { Authorization: `Bearer ${key}` } });
			const signed = await actorFromRequest(probe, env);
			if (!signed) return html(renderSignIn("That key is not a Stylebook key."), 401);
			return redirect("/", { "Set-Cookie": keyCookie(signed.key) });
		}

		if (request.method === "POST" && path === "/sign-out") {
			return redirect("/", { "Set-Cookie": clearCookie() });
		}

		const signed = await actorFromRequest(request, env);
		if (!signed) {
			if (request.method === "GET" && path === "/") return html(renderSignIn(null));
			return html(renderSignIn("Open the library with your Stylebook key."), 401);
		}

		if (request.method === "POST" && path === "/suggestion") {
			const body = (await request.json().catch(() => ({}))) as {
				session?: unknown;
				path?: unknown;
				content?: unknown;
				why?: unknown;
			};
			const saved = await saveAgentSuggestion(env, signed.actor, signed.key, url.origin, {
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
			const desk = await loadDesk(env, signed.actor, signed.key, url.origin, item, suggestion, notice);
			return html(renderDesk(desk, suggestion));
		}

		if (request.method === "POST" && (path === "/publish" || path === "/resolve" || path === "/decline")) {
			const form = await fields(request);
			const item = cleanPath(form.get("item"));
			const suggestion = cleanName(form.get("suggestion"));
			if (!item || !suggestion) throw new DeskError("Choose a suggestion first.");
			if (path === "/decline") {
				await declineSuggestion(env, signed.actor, suggestion, item);
				return redirect(back(item, null, "Declined."));
			}
			if (path === "/resolve" && form.get("mode") === "combine") {
				const name = await combineSuggestions(env, signed.actor, url.origin, suggestion, item);
				return redirect(back(item, name, "Combined into a new suggestion."));
			}
			const mode = path === "/publish" ? "publish" : form.get("mode") === "keep-other" ? "keep-other" : "keep-this";
			const notice = await publishSuggestion(env, signed.actor, signed.key, url.origin, suggestion, item, mode);
			const stay = notice.startsWith("Nothing was published") || notice.startsWith("Kept the current");
			return redirect(back(item, stay ? suggestion : null, notice));
		}
	} catch (error) {
		if (error instanceof DeskError) {
			if (path === "/suggestion") return Response.json({ ok: false, error: error.message }, { status: error.status });
			return html(renderSignIn(error.message), error.status);
		}
		if (path === "/suggestion") {
			return Response.json({ ok: false, error: "The suggestion could not be saved." }, { status: 500 });
		}
		return html(renderSignIn("The library could not be opened. Try again."), 500);
	}
	return html(renderSignIn(null), 405);
}
