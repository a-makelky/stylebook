// The service-admin page. It counts workspaces. It does not read a library,
// a suggestion, or anyone's name or email address.

import type { Env } from "./env";
import { formatUsd, operationsCostUsd } from "./cost";
import { verifiedEmail, type AccessRuntime } from "./identity";
import { isServiceAdmin, monthKey, signInCount } from "./roles";
import { monthOperationTotal } from "./usage";
import { deleteWorkspaceRepos } from "./workspace";

function esc(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function page(main: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stylebook</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400&amp;display=swap">
<style>
  :root { --paper: #FCFCFA; --ink: #1B1D21; --graphite: #5E6167; --rule: #E3E3DD; --blue: #2B4C9B; --red: #B3261E; }
  * { box-sizing: border-box; }
  body, button, input { margin: 0; background: var(--paper); color: var(--ink); font-family: Newsreader, Palatino, serif; font-size: 17px; line-height: 1.5; }
  a { color: inherit; }
  :focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
  .wordmark { font-style: italic; font-weight: 500; font-size: 28px; margin: 28px 16px 0; }
  main { max-width: 42rem; margin: 0 auto; padding: 28px 16px 64px; }
  h1 { font-size: 44px; line-height: 1.1; font-weight: 500; letter-spacing: -0.015em; }
  h2 { font-size: 22px; line-height: 1.3; font-weight: 600; }
  .meta { color: var(--graphite); font-style: italic; font-size: 16px; }
  .warn { color: var(--red); }
  .workspace { border-top: 1px solid var(--rule); padding: 16px 0; }
  label, input { display: block; width: 100%; }
  input { min-height: 44px; margin: 8px 0 16px; padding: 8px 12px; border: 1px solid var(--ink); border-radius: 3px; background: var(--paper); color: var(--ink); }
  button { min-height: 44px; padding: 0 16px; border-radius: 3px; font-size: 17px; cursor: pointer; }
  button.secondary { background: var(--paper); color: var(--ink); border: 1px solid var(--ink); }
  button.text { background: none; border: none; text-decoration: underline; padding: 0; }
  form.row { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; }
  form.row input { width: 8rem; }
</style>
</head>
<body>
<p class="wordmark">Stylebook</p>
<main>${main}</main>
</body>
</html>`;
}

function html(body: string, status = 200): Response {
	return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

interface WorkspaceLine {
	id: string;
	name: string;
	createdAt: string;
	suspended: number;
	people: number;
	agents: number;
	suggestions: number;
	operations: number;
	limitPeople: number | null;
	limitAgents: number | null;
	limitSuggestions: number | null;
}

async function lines(env: Env): Promise<WorkspaceLine[]> {
	const month = monthKey();
	const rows = await env.DB.prepare(
		`SELECT w.id, w.name, w.created_at, w.suspended, w.limit_people, w.limit_agents, w.limit_suggestions,
        (SELECT COUNT(*) FROM actors a WHERE a.workspace_id = w.id AND a.kind = 'person' AND a.removed_at IS NULL) AS people,
        (SELECT COUNT(*) FROM actors a WHERE a.workspace_id = w.id AND a.kind = 'agent' AND a.removed_at IS NULL) AS agents,
        (SELECT COUNT(DISTINCT repo_name) FROM gateway_pushes g
          WHERE g.workspace_id = w.id AND g.ref_name = 'refs/heads/main' AND g.repo_name LIKE w.id || '-sug-%') AS suggestions
     FROM workspaces w
     WHERE w.deleted_at IS NULL
     ORDER BY w.created_at`,
	)
		.bind()
		.all<{
			id: string;
			name: string;
			created_at: string;
			suspended: number;
			people: number;
			agents: number;
			suggestions: number;
			limit_people: number | null;
			limit_agents: number | null;
			limit_suggestions: number | null;
		}>();
	const found: WorkspaceLine[] = [];
	for (const row of rows.results ?? []) {
		found.push({
			id: row.id,
			name: row.name,
			createdAt: row.created_at,
			suspended: row.suspended,
			people: row.people,
			agents: row.agents,
			suggestions: row.suggestions,
			operations: await monthOperationTotal(env.DB, row.id, month),
			limitPeople: row.limit_people,
			limitAgents: row.limit_agents,
			limitSuggestions: row.limit_suggestions,
		});
	}
	return found;
}

async function audit(env: Env, action: string, workspaceId: string, detail: string): Promise<void> {
	await env.DB.prepare(`INSERT INTO service_audit (at, action, workspace_id, detail) VALUES (?1, ?2, ?3, ?4)`)
		.bind(new Date().toISOString(), action, workspaceId, detail)
		.run();
}

function whole(value: string | null, fallback: number): number | null {
	if (!value) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100000) return null;
	return parsed;
}

export async function handleAdmin(request: Request, env: Env, runtime?: AccessRuntime): Promise<Response | null> {
	const url = new URL(request.url);
	if (url.pathname !== "/admin") return null;
	const email = await verifiedEmail(request, env, runtime);
	if (!email || !isServiceAdmin(env, email)) return html(page(`<h1>That page is not available.</h1>`), 404);

	if (request.method === "POST") {
		const form = new URLSearchParams(await request.text());
		const id = form.get("workspace") ?? "";
		const workspace = await env.DB.prepare(`SELECT id, name FROM workspaces WHERE id = ?1 AND deleted_at IS NULL`)
			.bind(id)
			.first<{ id: string; name: string }>();
		if (!workspace) return html(page(`<h1>That workspace is not here.</h1>`), 404);
		const action = form.get("action") ?? "";
		if (action === "limits") {
			const people = whole(form.get("people"), 25);
			const agents = whole(form.get("agents"), 40);
			const suggestions = whole(form.get("suggestions"), 200);
			if (people === null || agents === null || suggestions === null) {
				return html(page(`<p class="warn">Enter a whole number for each limit.</p>`), 400);
			}
			await env.DB.prepare(
				`UPDATE workspaces SET limit_people = ?1, limit_agents = ?2, limit_suggestions = ?3 WHERE id = ?4`,
			)
				.bind(people, agents, suggestions, id)
				.run();
			await audit(env, "limits", id, "Changed the limits.");
		} else if (action === "suspend") {
			const next = form.get("suspended") === "yes" ? 0 : 1;
			await env.DB.prepare(`UPDATE workspaces SET suspended = ?1 WHERE id = ?2`).bind(next, id).run();
			await audit(env, next === 1 ? "suspend" : "resume", id, next === 1 ? "Suspended the workspace." : "Allowed changes again.");
		} else if (action === "delete") {
			if ((form.get("name") ?? "") !== workspace.name) {
				return html(page(`<p class="warn">Type the workspace name to delete it.</p>`), 400);
			}
			await deleteWorkspaceRepos(env.WORKSPACE, id);
			const now = new Date().toISOString();
			const actors = await env.DB.prepare(`SELECT id FROM actors WHERE workspace_id = ?1`).bind(id).all<{ id: string }>();
			for (const actor of actors.results ?? []) {
				await env.DB.prepare(`DELETE FROM sessions WHERE actor_id = ?1`).bind(actor.id).run();
				await env.DB.prepare(`DELETE FROM actor_keys WHERE actor_id = ?1`).bind(actor.id).run();
			}
			await env.DB.prepare(`UPDATE actors SET removed_at = ?1 WHERE workspace_id = ?2 AND removed_at IS NULL`).bind(now, id).run();
			await env.DB.prepare(`UPDATE workspaces SET deleted_at = ?1 WHERE id = ?2`).bind(now, id).run();
			await audit(env, "delete", id, "Deleted the workspace.");
		} else {
			return html(page(`<h1>That action is not available.</h1>`), 400);
		}
		return new Response(null, { status: 303, headers: { Location: "/admin" } });
	}

	if (request.method !== "GET") return html(page(`<h1>That page is not available.</h1>`), 405);

	const workspaces = await lines(env);
	const operations = workspaces.reduce((sum, item) => sum + item.operations, 0);
	const cost = operationsCostUsd(operations);
	const signedIn = await signInCount(env.DB);
	const warning =
		signedIn >= 40
			? `<p class="warn">${signedIn} people signed in this month. This is the point where Stylebook plans to host sign-in itself.</p>`
			: `<p class="meta">${signedIn} ${signedIn === 1 ? "person" : "people"} signed in this month.</p>`;
	const cards = workspaces
		.map((item) => {
			const share = operations === 0 ? 0 : (cost * item.operations) / operations;
			const when = new Date(item.createdAt).toLocaleDateString("en-GB", {
				day: "numeric",
				month: "long",
				year: "numeric",
				timeZone: "UTC",
			});
			return `<section class="workspace">
        <h2>${esc(item.name)}</h2>
        <p class="meta">Created ${esc(when)}. ${item.people} ${item.people === 1 ? "person" : "people"}. ${item.agents} ${item.agents === 1 ? "agent" : "agents"}. ${item.suggestions} open ${item.suggestions === 1 ? "suggestion" : "suggestions"}.</p>
        <p class="meta">${item.operations} operations this month. Estimated cost ${esc(formatUsd(share))}.</p>
        ${item.suspended ? `<p class="warn">Read-only.</p>` : ""}
        <form method="post" action="/admin" class="row">
          <input type="hidden" name="workspace" value="${esc(item.id)}">
          <input type="hidden" name="action" value="limits">
          <label>People<input name="people" inputmode="numeric" value="${item.limitPeople ?? 25}" required></label>
          <label>Agents<input name="agents" inputmode="numeric" value="${item.limitAgents ?? 40}" required></label>
          <label>Open suggestions<input name="suggestions" inputmode="numeric" value="${item.limitSuggestions ?? 200}" required></label>
          <button class="secondary" type="submit">Save limits</button>
        </form>
        <form method="post" action="/admin">
          <input type="hidden" name="workspace" value="${esc(item.id)}">
          <input type="hidden" name="action" value="suspend">
          <input type="hidden" name="suspended" value="${item.suspended ? "yes" : "no"}">
          <button class="text" type="submit">${item.suspended ? "Allow changes again" : "Suspend"}</button>
        </form>
        <form method="post" action="/admin">
          <input type="hidden" name="workspace" value="${esc(item.id)}">
          <input type="hidden" name="action" value="delete">
          <label for="delete-${esc(item.id)}">Type the workspace name</label>
          <input id="delete-${esc(item.id)}" name="name" autocomplete="off">
          <button class="text" type="submit">Delete</button>
        </form>
      </section>`;
		})
		.join("");
	const recent = await env.DB.prepare(`SELECT action, detail FROM service_audit ORDER BY id DESC LIMIT 8`)
		.bind()
		.all<{ action: string; detail: string }>();
	const history = (recent.results ?? []).map((row) => `<p class="meta">${esc(row.detail)}</p>`).join("");
	return html(
		page(`<h1>Workspaces</h1>
      ${warning}
      <p class="meta">${operations} operations this month across every workspace. Estimated cost ${esc(formatUsd(cost))}. The first 10,000 operations and the first 1 GB on the account are included. Storage is not counted per workspace.</p>
      ${cards || `<p class="meta">No workspaces yet.</p>`}
      ${history ? `<h2>Recent actions</h2>${history}` : ""}`),
	);
}
