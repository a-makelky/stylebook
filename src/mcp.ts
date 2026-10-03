// MCP endpoint. A client speaks JSON-RPC over HTTP. The tools read the library
// and suggest a change through the same path a Git client uses.
// https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/

import { actorById, setClientVersion, type Actor } from "./actors";
import { actorFromRequest } from "./auth";
import { libraryPrompts, teamConnections, toolLabel, type LibraryPrompt } from "./catalog";
import { authorize } from "./roles";
import type { Env } from "./env";
import { DeskError, loadDesk, saveAgentSuggestion, writtenBy } from "./review";
import { describeError } from "./redact";
import { noteUsed } from "./teams";
import { scopedEnv } from "./usage";
import { ensureLibrary, listPaths, readBytes } from "./workspace";

export interface McpActorProps {
	actorId: string;
	keyHash: string;
}

const PROTOCOL = "2025-03-26";
const SUPPORTED = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2026-07-28"]);

const TOOLS = [
	{
		name: "list_library",
		description: "List the pages in the library: skills, workflows, and connections.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "read_item",
		description: "Read one page from the library.",
		inputSchema: {
			type: "object",
			properties: { path: { type: "string", description: "Path of the page in the library." } },
			required: ["path"],
		},
	},
	{
		name: "suggest_change",
		description: "Suggest a change. Saves a new version on your own copy of the library.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Path of the page to change." },
				content: { type: "string", description: "The full new text of that page." },
				why: { type: "string", description: "Why this suggestion was made." },
				session: { type: "string", description: "A short name for this suggestion. Optional." },
			},
			required: ["path", "content", "why"],
		},
	},
	{
		name: "list_suggestions",
		description: "List open suggestions for one page. Newest first.",
		inputSchema: {
			type: "object",
			properties: { path: { type: "string", description: "Path of the page. Optional." } },
		},
	},
	{
		name: "get_skill",
		description: "Read one skill or workflow from the library by its name.",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string", description: "The skill or workflow name." },
				path: { type: "string", description: "The page path, if you have it." },
			},
		},
	},
	{
		name: "list_team_connections",
		description: "List the services the team uses. Each person signs in to those services themselves.",
		inputSchema: { type: "object", properties: {} },
	},
];

interface RpcRequest {
	jsonrpc?: string;
	id?: unknown;
	method?: string;
	params?: unknown;
}

function rpcResult(id: unknown, result: unknown): Response {
	return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string, status = 200): Response {
	return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status });
}

function toolText(text: string, isError = false) {
	return { content: [{ type: "text", text }], isError };
}

function argsOf(params: unknown): Record<string, unknown> {
	if (!params || typeof params !== "object") return {};
	const record = params as { arguments?: unknown; name?: unknown };
	if (record.arguments && typeof record.arguments === "object") return record.arguments as Record<string, unknown>;
	return {};
}

async function listLibrary(env: Env, workspaceId: string): Promise<string> {
	const library = await ensureLibrary(env.WORKSPACE, workspaceId);
	const paths = await listPaths(library.repo);
	if (paths.length === 0) return "The library is empty.";
	return paths.map((path) => `- ${path}`).join("\n");
}

async function readItem(env: Env, workspaceId: string, path: string): Promise<string> {
	const library = await ensureLibrary(env.WORKSPACE, workspaceId);
	const bytes = await readBytes(library.repo, path);
	if (!bytes) return `That page is not in the library: ${path}`;
	return new TextDecoder().decode(bytes);
}

async function actorFromProps(env: Env, props: McpActorProps): Promise<Actor | null> {
	const actor = await actorById(env.DB, props.actorId);
	if (!actor || actor.removedAt || !props.keyHash) return null;
	const row = await env.DB.prepare(`SELECT 1 AS present FROM actor_keys WHERE actor_id = ?1 AND key_hash = ?2`)
		.bind(actor.id, props.keyHash)
		.first<{ present: number }>();
	return row ? actor : null;
}

async function rememberClient(env: Env, actor: Actor, params: unknown): Promise<void> {
	if (actor.kind !== "agent") return;
	const info = (params as { clientInfo?: { name?: unknown; version?: unknown } } | null)?.clientInfo;
	const version = typeof info?.version === "string" ? info.version : "";
	if (version) {
		await setClientVersion(env.DB, actor.id, version);
		actor.clientVersion = version.slice(0, 40);
	}
	const reported = typeof info?.name === "string" ? toolLabel(info.name) : "";
	if (reported && (!actor.model || actor.model === "Another tool" || actor.model === "Your tool")) {
		const model = reported.slice(0, 40);
		await env.DB.prepare(`UPDATE actors SET model = ?1 WHERE id = ?2`).bind(model, actor.id).run();
		actor.model = model;
	}
	await noteUsed(env, actor.id);
}

function resourceUri(path: string): string {
	return `stylebook://library/${path}`;
}

async function callTool(
	env: Env,
	actor: Actor,
	key: string,
	origin: string,
	name: string,
	args: Record<string, unknown>,
	sessionHeader: string | null,
): Promise<{ text: string; isError: boolean }> {
	if (actor.kind === "agent") await noteUsed(env, actor.id);
	const scoped = scopedEnv(env, actor.workspaceId);
	env = scoped.env;
	try {
		if (name === "publish" || name === "decline" || name === "combine" || name === "invite") {
			const action = name === "invite" ? "invite" : name === "decline" ? "decline" : name === "combine" ? "combine" : "publish";
			const decision = await authorize(env, actor, action, typeof args.path === "string" ? args.path : null);
			return { text: decision.ok ? "Do that from the page." : decision.sentence, isError: true };
		}
		if (name === "list_library") return { text: await listLibrary(env, actor.workspaceId), isError: false };
		if (name === "read_item") {
			const path = typeof args.path === "string" ? args.path : "";
			if (!path) return { text: "A path is required.", isError: true };
			const text = await readItem(env, actor.workspaceId, path);
			return { text, isError: text.startsWith("That page is not") };
		}
		if (name === "suggest_change") {
			const current = (await actorById(env.DB, actor.id)) ?? actor;
			const fromArg = typeof args.session === "string" ? args.session.trim() : "";
			const fromHeader = sessionHeader?.trim() ?? "";
			const saved = await saveAgentSuggestion(env, current, key, origin, {
				session: (fromArg || fromHeader || crypto.randomUUID().slice(0, 8)).slice(0, 80),
				path: typeof args.path === "string" ? args.path : "",
				content: typeof args.content === "string" ? args.content : "",
				why: typeof args.why === "string" ? args.why : "",
			});
			return {
				text: `Saved suggestion ${saved.name} as edition ${saved.edition}.`,
				isError: false,
			};
		}
		if (name === "list_suggestions") {
			const path = typeof args.path === "string" ? args.path : "skills/interview-to-draft/SKILL.md";
			const desk = await loadDesk(env, actor, key, origin, path, null, null, null);
			if (desk.suggestions.length === 0) return { text: "No open suggestions for this page.", isError: false };
			const lines = desk.suggestions.map(
				(entry) => `${entry.name} (${entry.number}). ${writtenBy(entry.writer, entry.owner)}. ${entry.why}`,
			);
			return { text: lines.join("\n"), isError: false };
		}
		if (name === "get_skill") {
			const prompts = await libraryPrompts(env, actor.workspaceId);
			const wanted = typeof args.name === "string" ? args.name : "";
			const path = typeof args.path === "string" ? args.path : "";
			const found = prompts.find((item) => item.name === wanted || item.path === path || item.path === wanted);
			if (!found) return { text: "That skill is not in the library.", isError: true };
			return { text: found.text, isError: false };
		}
		if (name === "list_team_connections") {
			const connections = await teamConnections(env, actor.workspaceId);
			if (connections.length === 0) return { text: "This team has not listed any other services.", isError: false };
			return { text: connections.map((item) => `- ${item.name} ${item.url}`).join("\n"), isError: false };
		}
		return { text: `Unknown tool ${name}.`, isError: true };
	} catch (error) {
		if (error instanceof DeskError) return { text: error.message, isError: true };
		const failure = describeError(error);
		console.error(failure.code, failure.message);
		return { text: "The library could not be opened.", isError: true };
	} finally {
		await scoped.flush();
	}
}

async function libraryMethod(env: Env, actor: Actor, method: string, message: RpcRequest): Promise<Response> {
	const prompts = await libraryPrompts(env, actor.workspaceId);
	if (method === "prompts/list") {
		return rpcResult(message.id, {
			prompts: prompts.map((item) => ({ name: item.name, title: item.title, description: item.description })),
		});
	}
	if (method === "resources/list") {
		return rpcResult(message.id, {
			resources: prompts.map((item) => ({
				uri: resourceUri(item.path),
				name: item.name,
				title: item.title,
				description: item.description,
				mimeType: "text/markdown",
			})),
		});
	}
	if (method === "prompts/get") {
		const name = typeof (message.params as { name?: unknown } | null)?.name === "string" ? (message.params as { name: string }).name : "";
		const found = prompts.find((item) => item.name === name);
		if (!found) return rpcError(message.id, -32002, "That skill is not in the library.");
		return rpcResult(message.id, promptResult(found));
	}
	const uri = typeof (message.params as { uri?: unknown } | null)?.uri === "string" ? (message.params as { uri: string }).uri : "";
	const found = prompts.find((item) => resourceUri(item.path) === uri || item.path === uri);
	if (!found) return rpcError(message.id, -32002, "That page is not in the library.");
	return rpcResult(message.id, {
		contents: [{ uri: resourceUri(found.path), mimeType: "text/markdown", text: found.text }],
	});
}

function promptResult(found: LibraryPrompt) {
	return {
		description: found.description,
		messages: [{ role: "user", content: { type: "text", text: found.text } }],
	};
}

export async function handleMcp(request: Request, env: Env, props?: McpActorProps): Promise<Response> {
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: cors() });
	}
	if (request.method === "GET") {
		return rpcError(null, -32000, "Use POST for this endpoint.", 405);
	}
	if (request.method !== "POST") return rpcError(null, -32000, "Use POST.", 405);

	let message: RpcRequest;
	try {
		message = (await request.json()) as RpcRequest;
	} catch {
		return rpcError(null, -32700, "The request was not JSON.", 400);
	}
	if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
		return rpcError(message.id, -32600, "That is not a JSON-RPC request.", 400);
	}

	const method = message.method;
	if (method.startsWith("notifications/")) {
		return new Response(null, { status: 202, headers: cors() });
	}

	let actor: Actor | null = null;
	let key = "";
	if (props) {
		actor = await actorFromProps(env, props);
	} else {
		const signed = await actorFromRequest(request, env);
		actor = signed?.actor ?? null;
		key = signed?.key ?? "";
	}
	if (!actor && method !== "initialize" && method !== "ping") {
		return rpcError(message.id, -32001, "Missing or unknown key.", 401);
	}
	if (props && !actor) return rpcError(message.id, -32001, "Missing or unknown key.", 401);

	const origin = new URL(request.url).origin;
	let response: Response;
	if (method === "initialize") {
		const params = (message.params ?? {}) as { protocolVersion?: string };
		const requested = params.protocolVersion ?? PROTOCOL;
		if (actor) await rememberClient(env, actor, message.params);
		response = rpcResult(message.id, {
			protocolVersion: SUPPORTED.has(requested) ? requested : PROTOCOL,
			capabilities: {
				tools: { listChanged: false },
				prompts: { listChanged: false },
				resources: { listChanged: false },
			},
			serverInfo: { name: "stylebook", version: "0.1.0" },
			instructions: "Read the library, then suggest a change with a note about why. Skills are also available as prompts.",
		});
	} else if (method === "ping") {
		response = rpcResult(message.id, {});
	} else if (method === "tools/list") {
		response = rpcResult(message.id, { tools: TOOLS });
	} else if (method === "tools/call") {
		const params = (message.params ?? {}) as { name?: string };
		const name = params.name ?? "";
		const outcome = await callTool(
			env,
			actor as Actor,
			key,
			origin,
			name,
			argsOf(message.params),
			request.headers.get("Mcp-Session-Id"),
		);
		response = rpcResult(message.id, toolText(outcome.text, outcome.isError));
	} else if (method === "prompts/list" || method === "prompts/get" || method === "resources/list" || method === "resources/read") {
		response = await libraryMethod(env, actor as Actor, method, message);
	} else {
		response = rpcError(message.id, -32601, `Unknown method ${method}.`);
	}

	const headers = cors();
	for (const [key, value] of response.headers) headers.set(key, value);
	return new Response(response.body, { status: response.status, headers });
}

function cors(): Headers {
	return new Headers({
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version",
		"Access-Control-Allow-Methods": "POST, OPTIONS",
	});
}

