// Connect your tools. One tool at a time. A key or a JSON block is only under Other.

import { issueGrant } from "./access";
import { listActors, type Actor } from "./actors";
import { actorFromRequest, readCookie } from "./auth";
import { displayServerName, skillZip, teamConnections } from "./catalog";
import type { Env } from "./env";
import { signInMode } from "./identity";
import { accountLine, esc, page } from "./screen";
import { workspaceById } from "./teams";
import { libraryName } from "./workspace";

const TOOL_COOKIE = "stylebook_tool";

const TOOLS = [
	{ id: "claude", label: "Claude" },
	{ id: "chatgpt", label: "ChatGPT" },
	{ id: "cursor", label: "Cursor" },
	{ id: "vscode", label: "VS Code" },
	{ id: "claude-code", label: "Claude Code" },
	{ id: "codex", label: "Codex" },
	{ id: "other", label: "Other" },
] as const;

type ToolId = (typeof TOOLS)[number]["id"];

function html(body: string, status = 200, account?: string, extra?: Headers): Response {
	const headers = extra ?? new Headers();
	headers.set("Content-Type", "text/html; charset=utf-8");
	return new Response(page({ main: body, account }), { status, headers });
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
	if (request.method === "GET" && url.pathname === "/connect") return connectPage(request, env, signed.actor, url);
	return html(`<div class="sheet"><h1>Connect your tools</h1><p><a href="/connect">Back</a></p></div>`, 404);
}

function chosenTool(request: Request, url: URL): ToolId {
	const query = url.searchParams.get("tool");
	if (query && TOOLS.some((tool) => tool.id === query)) return query as ToolId;
	const remembered = readCookie(request, TOOL_COOKIE);
	if (remembered && TOOLS.some((tool) => tool.id === remembered)) return remembered as ToolId;
	return "claude";
}

function toolCookie(id: string, secure: boolean): string {
	const flag = secure ? "; Secure" : "";
	return `${TOOL_COOKIE}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${flag}`;
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

function copyButton(value: string, label = "Copy"): string {
	return `<button type="button" class="secondary" data-copy="${esc(value)}">${label}</button>`;
}

function addressLine(value: string): string {
	return `<p class="address"><code>${esc(value)}</code> ${copyButton(value)}</p>`;
}

const COPY_SCRIPT = `<script>
document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const value = button.getAttribute("data-copy") || "";
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(value);
      else {
        const area = document.createElement("textarea");
        area.value = value;
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy";
    }
  });
});
</script>`;

function toolSteps(id: ToolId, mcp: string): string {
	if (id === "claude") {
		return `<h2>Claude</h2>
      <ol class="steps">
        <li>Copy the address ${addressLine(mcp)}</li>
        <li>In Claude, Customize → Connectors → Add custom connector → paste</li>
        <li>Sign in and approve</li>
      </ol>
      <p class="meta">Free, Pro, Max, Team, and Enterprise. On Team and Enterprise, an owner adds it under Organization settings, then Connectors. <a href="https://support.anthropic.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp">Claude's guide</a></p>`;
	}
	if (id === "chatgpt") {
		return `<h2>ChatGPT</h2>
      <ol class="steps">
        <li>Copy the address ${addressLine(mcp)}</li>
        <li>In ChatGPT, an admin turns on developer mode, then add this address</li>
        <li>Sign in and approve</li>
      </ol>
      <p class="meta">Full connectors are in beta on Business, Enterprise, and Edu. Plus, Pro, and Free are not listed for this. <a href="https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt">OpenAI's guide</a></p>`;
	}
	if (id === "cursor") {
		return `<h2>Cursor</h2>
      <ol class="steps">
        <li>Copy the address ${addressLine(mcp)}</li>
        <li>In Cursor, open Customize and add a server with this address</li>
        <li>Sign in and approve</li>
      </ol>
      <p class="meta">Cursor has no documented one-click link for a server you host yourself. <a href="https://cursor.com/docs/mcp">Cursor's guide</a></p>`;
	}
	if (id === "vscode") {
		return `<h2>VS Code</h2>
      <ol class="steps">
        <li>Add to VS Code <p><a class="primary" href="${esc(vsCodeInstall("stylebook", mcp))}">Add to VS Code</a></p></li>
        <li>Sign in and approve</li>
      </ol>
      <p class="meta"><a href="https://code.visualstudio.com/docs/agent-customization/mcp-servers">VS Code's guide</a> and <a href="https://code.visualstudio.com/api/extension-guides/ai/mcp">the install link</a></p>`;
	}
	if (id === "claude-code") {
		const command = `claude mcp add --transport http stylebook ${mcp}`;
		return `<h2>Claude Code</h2>
      <ol class="steps">
        <li>Copy this line <pre>${esc(command)}</pre> ${copyButton(command)}</li>
        <li>Sign in and approve</li>
      </ol>
      <p class="meta"><a href="https://code.claude.com/docs/en/mcp">Claude Code's guide</a></p>`;
	}
	if (id === "codex") {
		return `<h2>Codex</h2>
      <ol class="steps">
        <li>Copy the address ${addressLine(mcp)}</li>
        <li>In Codex, open Settings, then MCP servers, then Add server, and choose Streamable HTTP</li>
        <li>Sign in and approve</li>
      </ol>
      <p class="meta"><a href="https://developers.openai.com/codex/mcp">Codex's guide</a></p>`;
	}
	return `<h2>Other</h2>
    <ol class="steps">
      <li>Name the connection</li>
      <li>The setup is shown once, on the next page</li>
    </ol>
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
    </form>`;
}

function modelFor(id: ToolId): string {
	if (id === "claude-code") return "Claude Code";
	if (id === "vscode") return "VS Code";
	if (id === "other") return "Another tool";
	const tool = TOOLS.find((item) => item.id === id);
	return tool?.label ?? "Claude";
}

async function connectPage(request: Request, env: Env, person: Actor, url: URL): Promise<Response> {
	const selected = chosenTool(request, url);
	const agents = (await listActors(env.DB, person.workspaceId)).filter((agent) => agent.kind === "agent");
	const mcp = address(url.origin);
	const connections = await teamConnections(env, person.workspaceId);
	const team =
		connections.length === 0
			? ""
			: `<h2>Your team also uses</h2>
      <p>Sign in to each service yourself. Stylebook does not keep those sign-ins.</p>
      ${connections
				.map(
					(item) => `<section class="person">
          <h2>${esc(displayServerName(item.name))}</h2>
          <p>Paste this address, then sign in.</p>
          ${addressLine(item.url)}
          <p><a class="primary" href="${esc(vsCodeInstall(item.name, item.url))}">Add to VS Code</a></p>
        </section>`,
				)
				.join("")}`;
	const choices = TOOLS.map((tool) => {
		const current = tool.id === selected ? ` aria-current="page"` : "";
		return `<a href="/connect?tool=${tool.id}"${current}>${esc(tool.label)}</a>`;
	}).join("");
	const body = `<div class="sheet">
    <p class="meta"><a href="/">Library</a></p>
    <h1>Connect your tools</h1>
    <p>Which tool do you use?</p>
    <nav class="tool-row">${choices}</nav>
    <section class="person">
      ${toolSteps(selected, mcp)}
      ${stateLine(agents, person.id, modelFor(selected))}
    </section>
    <h2 class="quiet">More</h2>
    <section class="person">
      <h2>Skills</h2>
      <p>Each skill and workflow in the library is offered to the tool. Where the tool has a prompt or slash menu, they show up there. Download the skill folders for a tool that imports them.</p>
      <p><a class="primary" href="/connect/skills.zip">Download skills</a></p>
      <p class="meta"><a href="https://cursor.com/docs/mcp">Cursor prompts and resources</a>. <a href="https://code.visualstudio.com/api/extension-guides/ai/mcp">VS Code prompts and resources</a>. <a href="https://code.claude.com/docs/en/skills">Claude Code skill folders</a>. <a href="https://cursor.com/docs/skills">Cursor skill folders</a>.</p>
    </section>
    <section class="person">
      <h2>A folder on your computer</h2>
      <p>This reads the library for a short time.</p>
      <form method="post" action="/connect/folder"><button class="primary" type="submit">Prepare a folder</button></form>
    </section>
    ${team}
    ${COPY_SCRIPT}
  </div>`;
	const workspace = await workspaceById(env.DB, person.workspaceId);
	const headers = new Headers();
	if (url.searchParams.get("tool") === selected) headers.append("Set-Cookie", toolCookie(selected, url.protocol === "https:"));
	return html(body, 200, accountLine(workspace?.name ?? "Workspace"), headers);
}

function otherTools(): Response {
	return html(`<div class="sheet">
    <p class="meta"><a href="/connect?tool=other">Connect your tools</a></p>
    <h1>Other</h1>
    ${toolSteps("other", "")}
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
