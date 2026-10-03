// MCP endpoint. A client speaks JSON-RPC over HTTP. The tools read the library
// and suggest a change through the same path a Git client uses.
// https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/

import { actorFromRequest } from "./auth";
import { authorize } from "./roles";
import type { Env } from "./env";
import { DeskError, loadDesk, saveAgentSuggestion } from "./review";
import { describeError } from "./redact";
import { noteUsed } from "./teams";
import { scopedEnv } from "./usage";
import { ensureLibrary, listPaths, readBytes } from "./workspace";

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

async function callTool(
	env: Env,
	request: Request,
	origin: string,
	name: string,
	args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
	const signed = await actorFromRequest(request, env);
	if (!signed) return { text: "Missing or unknown key.", isError: true };
	if (signed.actor.kind === "agent") await noteUsed(env, signed.actor.id);
	const scoped = scopedEnv(env, signed.actor.workspaceId);
	env = scoped.env;
	try {
		if (name === "publish" || name === "decline" || name === "combine" || name === "invite") {
			const action = name === "invite" ? "invite" : name === "decline" ? "decline" : name === "combine" ? "combine" : "publish";
			const decision = await authorize(env, signed.actor, action, typeof args.path === "string" ? args.path : null);
			return { text: decision.ok ? "Do that from the page." : decision.sentence, isError: true };
		}
		if (name === "list_library") return { text: await listLibrary(env, signed.actor.workspaceId), isError: false };
		if (name === "read_item") {
			const path = typeof args.path === "string" ? args.path : "";
			if (!path) return { text: "A path is required.", isError: true };
			const text = await readItem(env, signed.actor.workspaceId, path);
			return { text, isError: text.startsWith("That page is not") };
		}
		if (name === "suggest_change") {
			const saved = await saveAgentSuggestion(env, signed.actor, signed.key, origin, {
				session: typeof args.session === "string" ? args.session : crypto.randomUUID().slice(0, 8),
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
			const desk = await loadDesk(env, signed.actor, signed.key, origin, path, null, null, null);
			if (desk.suggestions.length === 0) return { text: "No open suggestions for this page.", isError: false };
			const lines = desk.suggestions.map(
				(entry) => `${entry.name} (${entry.number}). ${entry.writer} for ${entry.owner}. ${entry.why}`,
			);
			return { text: lines.join("\n"), isError: false };
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

export async function handleMcp(request: Request, env: Env): Promise<Response> {
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

	const signed = await actorFromRequest(request, env);
	if (!signed && method !== "initialize" && method !== "ping") {
		return rpcError(message.id, -32001, "Missing or unknown key.", 401);
	}

	let response: Response;
	if (method === "initialize") {
		const params = (message.params ?? {}) as { protocolVersion?: string };
		const requested = params.protocolVersion ?? PROTOCOL;
		response = rpcResult(message.id, {
			protocolVersion: SUPPORTED.has(requested) ? requested : PROTOCOL,
			capabilities: { tools: { listChanged: false } },
			serverInfo: { name: "stylebook", version: "0.1.0" },
			instructions: "Read the library, then suggest a change with a note about why.",
		});
	} else if (method === "ping") {
		response = rpcResult(message.id, {});
	} else if (method === "tools/list") {
		response = rpcResult(message.id, { tools: TOOLS });
	} else if (method === "tools/call") {
		const params = (message.params ?? {}) as { name?: string };
		const name = params.name ?? "";
		const outcome = await callTool(env, request, new URL(request.url).origin, name, argsOf(message.params));
		response = rpcResult(message.id, toolText(outcome.text, outcome.isError));
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

