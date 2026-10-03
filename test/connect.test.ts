import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerActor } from "../src/actors";
import { parseTeamConnections, publicServerUrl, toolLabel } from "../src/catalog";
import type { Env } from "../src/env";
import { writtenBy } from "../src/review";
import { STARTER_SKILL_PATH } from "../src/seed";
import { openSession } from "../src/teams";
import { FakeWorkspace } from "./fake-artifacts";
import { memoryD1 } from "./memory-d1";
import { memoryKv } from "./memory-kv";
import { serveWorker } from "./serve";

const BANNED =
	/\b(git|repos?|branches?|commits?|push(?:ed|ing)?|pull|merge[ds]?|fork(?:ed|ing)?|squash(?:ed|ing)?|rebase[ds]?|clon(?:e|ed|ing)|tokens?|prs?|pr)\b/i;

function visible(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<pre\b[^>]*\bdata-setup\b[^>]*>[\s\S]*?<\/pre>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"');
}

function cookiesOf(response: Response): string {
	return response.headers
		.getSetCookie()
		.map((item) => item.split(";")[0] ?? "")
		.filter(Boolean)
		.join("; ");
}

function mergedCookie(session: string, response: Response): string {
	const more = cookiesOf(response);
	return more ? `${session}; ${more}` : session;
}

describe("team connections stay public", () => {
	it("drops secrets and keeps a plain address", () => {
		expect(publicServerUrl("https://user:secret@example.com/mcp")).toBeNull();
		expect(publicServerUrl("https://example.com/mcp?token=abc")).toBeNull();
		expect(publicServerUrl("https://mcp.notion.com/mcp")).toBe("https://mcp.notion.com/mcp");
		const parsed = parseTeamConnections(
			JSON.stringify({
				mcpServers: {
					notion: { url: "https://mcp.notion.com/mcp", headers: { Authorization: "Bearer hidden" } },
					leaky: { url: "https://example.com/mcp?access_token=no" },
				},
			}),
		);
		expect(parsed).toEqual([{ name: "notion", url: "https://mcp.notion.com/mcp" }]);
		expect(JSON.stringify(parsed)).not.toContain("hidden");
		expect(JSON.stringify(parsed)).not.toContain("access_token");
	});

	it("names a tool from what it calls itself", () => {
		expect(toolLabel("Claude")).toBe("Claude");
		expect(toolLabel("claude-code")).toBe("Claude Code");
		expect(toolLabel("Visual Studio Code")).toBe("VS Code");
		expect(writtenBy("Claude for Dana", "Dana")).toBe("Written by Claude for Dana");
		expect(writtenBy("Researcher", "Editor")).toBe("Written by Researcher for Editor");
	});
});

describe("sign in from a tool", () => {
	let workspace: FakeWorkspace;
	let db: D1Database;
	let origin = "";
	let close: () => Promise<void> = async () => {};
	let session = "";
	const env: Env = {
		WORKSPACE: {} as Artifacts,
		DEMO_KEY: "secret",
		DB: {} as D1Database,
		SUGGESTIONS: {} as Env["SUGGESTIONS"],
		ARRIVALS: {} as Env["ARRIVALS"],
		SIGN_IN: "access",
		OAUTH_KV: memoryKv(),
		MAX_WORKSPACES: "40",
		MAX_PEOPLE: "25",
		MAX_AGENTS: "40",
		MAX_OPEN_SUGGESTIONS: "200",
	};

	beforeAll(async () => {
		workspace = await FakeWorkspace.start();
		db = memoryD1();
		env.WORKSPACE = workspace.binding;
		env.DB = db;
		const actor = await registerActor(db, {
			id: "dana",
			kind: "person",
			name: "Dana",
			workspaceId: "north",
			email: "dana@stylebook.invalid",
			role: "admin",
			key: "dana-person-key-0001",
		});
		session = `stylebook=${encodeURIComponent(await openSession(db, actor))}`;
		const server = await serveWorker(env);
		origin = server.url;
		close = server.close;
	}, 30_000);

	afterAll(async () => {
		await close();
		await workspace.stop();
	});

	it("asks a signed-out person to sign in, then shows consent and credits the tool", async () => {
		const home = await fetch(`${origin}/`, { headers: { Cookie: session } });
		expect(home.status).toBe(200);
		expect(await home.text()).toContain("Interview to draft");

		const resource = `${origin}/mcp`;
		const unsigned = await fetch(`${origin}/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		});
		expect(unsigned.status).toBe(401);
		expect(unsigned.headers.get("WWW-Authenticate") ?? "").toContain("resource_metadata");

		const redirectUri = "http://127.0.0.1:33418/callback";
		const registered = await fetch(`${origin}/oauth/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				client_name: "Claude",
				redirect_uris: [redirectUri],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			}),
		});
		expect(registered.status).toBe(201);
		const client = (await registered.json()) as { client_id: string };
		expect(client.client_id).toBeTruthy();

		const verifier = randomBytes(32).toString("base64url");
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		const authorize = new URL("/authorize", origin);
		authorize.searchParams.set("response_type", "code");
		authorize.searchParams.set("client_id", client.client_id);
		authorize.searchParams.set("redirect_uri", redirectUri);
		authorize.searchParams.set("code_challenge", challenge);
		authorize.searchParams.set("code_challenge_method", "S256");
		authorize.searchParams.set("scope", "suggest");
		authorize.searchParams.set("resource", resource);
		authorize.searchParams.set("state", "abc");

		const signedOut = await fetch(authorize, { redirect: "manual" });
		expect(signedOut.status).toBe(303);
		expect(signedOut.headers.get("Location")).toBe("/enter");
		expect(cookiesOf(signedOut)).toContain("stylebook_return=");

		const consent = await fetch(authorize, { headers: { Cookie: session }, redirect: "manual" });
		expect(consent.status).toBe(200);
		const consentHtml = await consent.text();
		expect(visible(consentHtml)).toContain("will be able to read your team's library and suggest changes as");
		expect(visible(consentHtml)).toContain("Claude for Dana");
		expect(visible(consentHtml)).toContain("It cannot publish.");
		expect(BANNED.test(visible(consentHtml))).toBe(false);
		const handle = consentHtml.match(/name="handle" value="([^"]+)"/)?.[1] ?? "";
		expect(handle).not.toBe("");

		const waiting = await fetch(`${origin}/connect`, { headers: { Cookie: session } });
		const waitingHtml = await waiting.text();
		expect(waitingHtml).toContain("Waiting for your first connection");
		expect(waitingHtml).toContain("Customize, then Connectors");
		expect(waitingHtml).toContain("Business, Enterprise, and Edu");
		expect(waitingHtml).toContain("claude mcp add --transport http stylebook");
		expect(waitingHtml).toContain("vscode:mcp/install?");
		expect(waitingHtml).toContain("https://mcp.notion.com/mcp");
		expect(waitingHtml).toContain("Download skills");
		expect(waitingHtml).toContain("Other tools");
		expect(BANNED.test(visible(waitingHtml))).toBe(false);
		expect(visible(waitingHtml).toLowerCase()).not.toContain("header");

		const approved = await fetch(`${origin}/authorize`, {
			method: "POST",
			redirect: "manual",
			headers: { Cookie: mergedCookie(session, consent), "Content-Type": "application/x-www-form-urlencoded" },
			body: `handle=${encodeURIComponent(handle)}&decision=approve`,
		});
		expect(approved.status).toBe(302);
		const location = new URL(approved.headers.get("Location") ?? "");
		expect(location.searchParams.get("state")).toBe("abc");
		const code = location.searchParams.get("code") ?? "";
		expect(code).not.toBe("");

		const tokenResponse = await fetch(`${origin}/oauth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				redirect_uri: redirectUri,
				client_id: client.client_id,
				code_verifier: verifier,
				resource,
			}),
		});
		expect(tokenResponse.status).toBe(200);
		const token = (await tokenResponse.json()) as { access_token?: string };
		expect(token.access_token).toBeTruthy();

		const headers = {
			Authorization: `Bearer ${token.access_token}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		const call = (method: string, params: unknown) =>
			fetch(`${origin}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });

		const init = await call("initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "Claude", version: "1.2.3" },
		});
		expect(init.status).toBe(200);

		const connected = await fetch(`${origin}/connect`, { headers: { Cookie: session } });
		const connectedHtml = await connected.text();
		expect(connectedHtml).toContain("Connected as");
		expect(connectedHtml).toContain("Claude for Dana");

		const prompts = await call("prompts/list", {});
		const promptBody = (await prompts.json()) as { result: { prompts: { name: string }[] } };
		expect(promptBody.result.prompts.map((item) => item.name)).toContain("interview-to-draft");
		expect(promptBody.result.prompts.map((item) => item.name)).toContain("feature-article");

		const skill = await call("tools/call", { name: "get_skill", arguments: { name: "interview-to-draft" } });
		const skillBody = (await skill.json()) as { result: { content: { text: string }[] } };
		expect(skillBody.result.content[0]?.text).toContain("Interview to draft");

		const connections = await call("tools/call", { name: "list_team_connections", arguments: {} });
		const connectionText = JSON.stringify(await connections.json());
		expect(connectionText).toContain("https://mcp.notion.com/mcp");
		expect(connectionText).not.toContain("Bearer");

		const blocked = await call("tools/call", { name: "publish", arguments: { path: STARTER_SKILL_PATH } });
		const blockedText = JSON.stringify(await blocked.json());
		expect(blockedText).toContain("An agent cannot publish.");

		const suggested = await call("tools/call", {
			name: "suggest_change",
			arguments: {
				path: STARTER_SKILL_PATH,
				content: "A suggestion from Claude for Dana.\n",
				why: "Try the sign-in connection.",
				session: "first",
			},
		});
		const suggestedText = JSON.stringify(await suggested.json());
		expect(suggestedText).toContain("Saved suggestion");
		const edition = suggestedText.match(/as edition ([0-9a-f]{40})/)?.[1] ?? "";
		expect(edition).toHaveLength(40);
		const who = await fetch(`${origin}/who?edition=${edition}`, { headers: { Cookie: session } });
		const whoBody = (await who.json()) as { actor?: { name?: string }; note?: { model?: string; actor?: string; onBehalfOf?: string } };
		expect(whoBody.actor?.name).toBe("Claude for Dana");
		expect(whoBody.note?.actor).toBe("Claude for Dana");
		expect(whoBody.note?.onBehalfOf).toBe("Dana");
		expect(whoBody.note?.model).toContain("1.2.3");

		const zip = await fetch(`${origin}/connect/skills.zip`, { headers: { Cookie: session } });
		expect(zip.headers.get("Content-Type")).toContain("zip");
		const bytes = new TextDecoder().decode(await zip.arrayBuffer());
		expect(bytes).toContain("skills/interview-to-draft/SKILL.md");
		expect(bytes).not.toContain("workflows/feature-article.md");

		const people = await fetch(`${origin}/people`, { headers: { Cookie: session } });
		const peopleHtml = await people.text();
		expect(peopleHtml).toContain("Claude for Dana");
		expect(peopleHtml).toContain("Connect your AI tools");
		const agentId = peopleHtml.match(/action="\/agents\/revoke"><input type="hidden" name="id" value="([^"]+)"/)?.[1] ?? "";
		expect(agentId).not.toBe("");
		const revoked = await fetch(`${origin}/agents/revoke`, {
			method: "POST",
			headers: { Cookie: session, "Content-Type": "application/x-www-form-urlencoded" },
			body: `id=${encodeURIComponent(agentId)}`,
		});
		expect(await revoked.text()).toContain("The key no longer works.");
		const after = await call("tools/list", {});
		expect(after.status).toBe(401);
	}, 60_000);
});
