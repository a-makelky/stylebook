// Connect your tools. One card per tool, the shortest path that tool documents.
// A key or a JSON block is only on Other tools.

import { issueGrant } from "./access";
import { listActors, type Actor } from "./actors";
import { actorFromRequest } from "./auth";
import { skillZip, teamConnections } from "./catalog";
import type { Env } from "./env";
import { signInMode } from "./identity";
import { accountLine, esc, page } from "./screen";
import { workspaceById } from "./teams";
import { libraryName } from "./workspace";

function html(body: string, status = 200, account?: string): Response {
	return new Response(page({ main: body, account }), {
		status,
		headers: { "Content-Type": "text/html; charset=utf-8" },
	});
}

export async function handleConnect(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const signed = await actorFromRequest(request, env);
	if (!signed || signed.actor.kind !== "person") {
		if (signInMode(env) === "access") {
			return html(
				`<div class="sheet"><h1>Sign in</h1><p>Sign in, then connect a tool.</p><p><a class="primary" href="/enter">Sign in</a></p></div>`,
				401,
			);
		}
		return html(
			`<div class="sheet"><h1>Sign in</h1><p><a href="/">Send yourself a sign-in link</a> to connect a tool.</p></div>`,
			401,
		);
	}
	if (request.method === "GET" && url.pathname === "/connect/skills.zip") {
		const bytes = await skillZip(env, signed.actor.workspaceId);
		return new Response(bytes, {
			headers: {
				"Content-Type": "application/zip",
				"Content-Disposition": 'attachment; filename="skills.zip"',
			},
		});
	}
	if (request.method === "GET" && url.pathname === "/connect/other") return otherTools();
	if (request.method === "POST" && url.pathname === "/connect/folder") return folder(env, signed.actor, url.origin);
	if (request.method === "GET" && url.pathname === "/connect") return connectPage(env, signed.actor, url.origin);
	return html(`<div class="sheet"><h1>Connect your tools</h1><p><a href="/connect">Back</a></p></div>`, 404);
}

function stateLine(agents: Actor[], personId: string, model: string): string {
	const match = agents.find((agent) => agent.ownerId === personId && agent.model === model && agent.lastUsedAt);
	if (!match) return `<p class="meta">Waiting for your first connection…</p>`;
	return `<p class="meta">Connected as <em>${esc(match.name)}</em></p>`;
}

function address(origin: string): string {
	return `${origin}/mcp`;
}

function vsCodeInstall(name: string, url: string): string {
	const config = { name, type: "http", url };
	return `vscode:mcp/install?${encodeURIComponent(JSON.stringify(config))}`;
}

async function connectPage(env: Env, person: Actor, origin: string): Promise<Response> {
	const agents = (await listActors(env.DB, person.workspaceId)).filter((agent) => agent.kind === "agent");
	const mcp = address(origin);
	const connections = await teamConnections(env, person.workspaceId);
	const team =
		connections.length === 0
			? ""
			: `<h2>Your team also uses</h2>
      <p>Sign in to each service yourself. Stylebook does not keep those sign-ins.</p>
      ${connections
				.map(
					(item) => `<section class="person">
          <h2>${esc(item.name)}</h2>
          <p>Paste this address, then sign in.</p>
          <p><code>${esc(item.url)}</code></p>
          <p><a class="primary" href="${esc(vsCodeInstall(item.name, item.url))}">Add to VS Code</a></p>
        </section>`,
				)
				.join("")}`;
	const body = `<div class="sheet">
    <p class="meta"><a href="/">Library</a></p>
    <h1>Connect your tools</h1>
    <p>Add Stylebook to the tool you already use. You sign in, then approve what it can do. It can read the library and suggest changes. It cannot publish.</p>
    <section class="person">
      <h2>Claude</h2>
      <p>On the web or the desktop app, open Customize, then Connectors, then Add, then Add custom connector. Paste this address, continue, and sign in.</p>
      <p><code>${esc(mcp)}</code></p>
      <p class="meta">Free, Pro, Max, Team, and Enterprise. On Team and Enterprise, an owner adds it under Organization settings, then Connectors. <a href="https://support.anthropic.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp">Claude's guide</a></p>
      ${stateLine(agents, person.id, "Claude")}
    </section>
    <section class="person">
      <h2>ChatGPT</h2>
      <p>Full connectors are in beta on Business, Enterprise, and Edu. An admin turns on developer mode, then you add this address and sign in. Plus, Pro, and Free are not listed for this.</p>
      <p><code>${esc(mcp)}</code></p>
      <p class="meta"><a href="https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt">OpenAI's guide</a></p>
      ${stateLine(agents, person.id, "ChatGPT")}
    </section>
    <section class="person">
      <h2>Cursor</h2>
      <p>Open Customize and add a server with this address, then sign in. Cursor has no documented one-click link for a server you host yourself.</p>
      <p><code>${esc(mcp)}</code></p>
      <p class="meta"><a href="https://cursor.com/docs/mcp">Cursor's guide</a></p>
      ${stateLine(agents, person.id, "Cursor")}
    </section>
    <section class="person">
      <h2>VS Code</h2>
      <p>One click opens VS Code and adds Stylebook. Then sign in.</p>
      <p><a class="primary" href="${esc(vsCodeInstall("stylebook", mcp))}">Add to VS Code</a></p>
      <p class="meta"><a href="https://code.visualstudio.com/docs/agent-customization/mcp-servers">VS Code's guide</a> and <a href="https://code.visualstudio.com/api/extension-guides/ai/mcp">the install link</a></p>
      ${stateLine(agents, person.id, "VS Code")}
    </section>
    <section class="person">
      <h2>Claude Code</h2>
      <p>Paste this one line, then sign in.</p>
      <pre>claude mcp add --transport http stylebook ${esc(mcp)}</pre>
      <p class="meta"><a href="https://code.claude.com/docs/en/mcp">Claude Code's guide</a></p>
      ${stateLine(agents, person.id, "Claude Code")}
    </section>
    <section class="person">
      <h2>Codex</h2>
      <p>Open Settings, then MCP servers, then Add server, and choose Streamable HTTP. Paste this address, then sign in.</p>
      <p><code>${esc(mcp)}</code></p>
      <p class="meta"><a href="https://developers.openai.com/codex/mcp">Codex's guide</a></p>
      ${stateLine(agents, person.id, "Codex")}
    </section>
    <section class="person">
      <h2>A folder on your computer</h2>
      <p>This reads the library for a short time.</p>
      <form method="post" action="/connect/folder"><button class="primary" type="submit">Prepare a folder</button></form>
    </section>
    <h2>Skills</h2>
    <p>Each skill and workflow in the library is offered to the tool. Where the tool has a prompt or slash menu, they show up there. Download the skill folders for a tool that imports them.</p>
    <p><a class="primary" href="/connect/skills.zip">Download skills</a></p>
    <p class="meta"><a href="https://cursor.com/docs/mcp">Cursor prompts and resources</a>. <a href="https://code.visualstudio.com/api/extension-guides/ai/mcp">VS Code prompts and resources</a>. <a href="https://code.claude.com/docs/en/skills">Claude Code skill folders</a>. <a href="https://cursor.com/docs/skills">Cursor skill folders</a>.</p>
    ${team}
    <p class="meta"><a href="/connect/other">Other tools</a></p>
  </div>`;
	const workspace = await workspaceById(env.DB, person.workspaceId);
	return html(body, 200, accountLine(workspace?.name ?? "Workspace"));
}

function otherTools(): Response {
	return html(`<div class="sheet">
    <p class="meta"><a href="/connect">Connect your tools</a></p>
    <h1>Other tools</h1>
    <p>Name the connection. The setup is shown once, on the next page.</p>
    <form method="post" action="/agents">
      <label for="agent-name">Name</label>
      <input id="agent-name" name="name" required>
      <label for="tool">Tool</label>
      <select id="tool" name="tool">
        <option value="cursor">Cursor</option>
        <option value="claude">Claude Code</option>
        <option value="other">Another tool</option>
      </select>
      <button class="primary" type="submit">Connect</button>
    </form>
  </div>`);
}

async function folder(env: Env, person: Actor, origin: string): Promise<Response> {
	const name = libraryName(person.workspaceId);
	const grant = await issueGrant(env.DB, person, name, false, 600);
	const host = origin.replace(/^https?:\/\//, "");
	const command = `git clone https://stylebook:${grant}@${host}/git/${name}.git library`;
	return html(`<div class="sheet">
    <p class="meta"><a href="/connect">Connect your tools</a></p>
    <h1>A folder on your computer</h1>
    <p>This reads the library for a short time.</p>
    <pre data-setup>${esc(command)}</pre>
  </div>`);
}
