// Sign-in from a tool. The MCP address is an OAuth protected resource.
// Cloudflare Access remains the identity, on /enter, the same way the person
// signs in to Stylebook. Approving creates an agent; the token is that agent.
// https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/
// https://github.com/cloudflare/workers-oauth-provider

import {
	AuthorizationError,
	CimdFetchError,
	OAuthProvider,
	type OAuthHelpers,
	type ResolveExternalTokenResult,
} from "@cloudflare/workers-oauth-provider";
import { actorByKey, hashKey } from "./actors";
import { actorFromRequest, keyCookie, returnCookie, safeReturnPath } from "./auth";
import { toolLabel } from "./catalog";
import type { Env } from "./env";
import { signInMode } from "./identity";
import { handleMcp, type McpActorProps } from "./mcp";
import { esc, page } from "./screen";
import { chooseWorkspace, connectSignedInAgent, memberships } from "./teams";

type AppFetch = (request: Request, env: Env, ctx?: ExecutionContext) => Promise<Response>;

const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string, fallback: AppFetch): OAuthProvider<Env> {
	const existing = providers.get(origin);
	if (existing) return existing;
	const resource = `${origin}/mcp`;
	const created = new OAuthProvider<Env>({
		apiRoute: "/mcp",
		apiHandler: { fetch: mcpAuthed },
		defaultHandler: { fetch: fallback },
		authorizeEndpoint: "/authorize",
		tokenEndpoint: "/oauth/token",
		clientRegistrationEndpoint: "/oauth/register",
		scopesSupported: ["suggest"],
		requiredScopes: ["suggest"],
		allowPrivateUseRedirectUris: true,
		clientIdMetadataDocumentEnabled: true,
		resourceMetadata: {
			resource,
			authorization_servers: [origin],
			resource_name: "Stylebook",
			bearer_methods_supported: ["header"],
		},
		resolveExternalToken,
	});
	providers.set(origin, created);
	return created;
}

async function resolveExternalToken(input: {
	token: string;
	request: Request;
	env: Env;
}): Promise<ResolveExternalTokenResult | null> {
	const actor = await actorByKey(input.env.DB, input.token);
	if (!actor) return null;
	const origin = new URL(input.request.url).origin;
	return {
		props: { actorId: actor.id, keyHash: await hashKey(input.token) } satisfies McpActorProps,
		audience: `${origin}/mcp`,
	};
}

async function mcpAuthed(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const props = (ctx as ExecutionContext & { props?: McpActorProps }).props;
	return handleMcp(request, env, props);
}

export async function oauthFetch(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	fallback: AppFetch,
): Promise<Response> {
	if (!env.OAUTH_KV) return fallback(request, env, ctx);
	const origin = new URL(request.url).origin;
	return providerFor(origin, fallback).fetch(request, env, ctx);
}

function html(body: string, status = 200, extra?: Headers): Response {
	const headers = extra ?? new Headers();
	headers.set("Content-Type", "text/html; charset=utf-8");
	return new Response(page({ main: body }), { status, headers });
}

function plain(message: string, status = 400): Response {
	return html(`<div class="sheet"><h1>Connect</h1><p>${esc(message)}</p><p><a href="/">Library</a></p></div>`, status);
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER as OAuthHelpers | undefined;
	if (!oauth) return plain("Sign-in from a tool is not available on this copy.", 503);
	const url = new URL(request.url);
	try {
		if (request.method === "GET") return await showConsent(request, env, oauth, url);
		if (request.method === "POST") return await finishConsent(request, env, oauth);
		return plain("Use the page to approve.", 405);
	} catch (error) {
		if (error instanceof AuthorizationError && error.redirectTo) {
			return Response.redirect(error.redirectTo, 302);
		}
		if (error instanceof AuthorizationError) return plain(error.description);
		if (error instanceof CimdFetchError) return plain("This app could not be verified.");
		throw error;
	}
}

async function showConsent(request: Request, env: Env, oauth: OAuthHelpers, url: URL): Promise<Response> {
	const authRequest = await oauth.parseAuthRequest(request);
	let signed = await actorFromRequest(request, env);
	const cookies: string[] = [];
	if (!signed || signed.actor.kind !== "person") {
		const back = safeReturnPath(`${url.pathname}${url.search}`);
		if (signInMode(env) === "access") {
			const headers = new Headers({ Location: "/enter" });
			if (back) headers.append("Set-Cookie", returnCookie(back));
			return new Response(null, { status: 303, headers });
		}
		return plain("Sign in, then approve this connection.", 401);
	}

	const workspaceId = url.searchParams.get("workspace");
	if (workspaceId && signed.actor.email && workspaceId !== signed.actor.workspaceId) {
		const joined = await chooseWorkspace(env, signed.actor.email, workspaceId);
		if (!("message" in joined)) {
			signed = { actor: joined.actor, key: joined.secret };
			cookies.push(keyCookie(joined.secret));
		}
	}

	const person = signed.actor;
	const details = await oauth.describeConsent(authRequest);
	const consent = await oauth.beginConsent(authRequest);
	const tool = toolLabel(details.clientName);
	const agentName = `${tool} for ${person.name}`.slice(0, 80);
	const homes = person.email ? await memberships(env.DB, person.email) : [];
	const picker =
		homes.length > 1
			? `<h2>Workspace</h2>${homes
					.map((home) => {
						const next = new URL(url.pathname + url.search, url.origin);
						next.searchParams.set("workspace", home.workspace.id);
						const current = home.workspace.id === person.workspaceId ? " (this one)" : "";
						return `<p><a href="${esc(`${next.pathname}${next.search}`)}">Open ${esc(home.workspace.name)}${current}</a></p>`;
					})
					.join("")}`
			: "";
	const published = details.clientDomain
		? `<p>Published by ${esc(details.clientDomain)}.</p>`
		: `<p>This app named itself. The name is not checked.</p>`;
	const loopback = details.redirectIsLoopback
		? `<p>This returns you to an app on your computer. Continue only if you just started from it.</p>`
		: "";
	const body = `<div class="sheet">
      <h1>Approve</h1>
      <p>${esc(tool)} will be able to read your team's library and suggest changes as <em>${esc(agentName)}</em>. It cannot publish.</p>
      ${published}
      <p>This returns you to ${esc(details.redirectHost)}.</p>
      ${loopback}
      ${picker}
      <form method="post" action="/authorize">
        <input type="hidden" name="handle" value="${esc(consent.handle)}">
        <button class="primary" type="submit" name="decision" value="approve">Approve</button>
        <button class="text" type="submit" name="decision" value="deny">Don't allow</button>
      </form>
    </div>`;
	for (const cookie of consent.headers.getSetCookie()) cookies.push(cookie);
	const headers = new Headers(consent.headers);
	headers.delete("set-cookie");
	for (const cookie of cookies) headers.append("Set-Cookie", cookie);
	return html(body, 200, headers);
}

async function finishConsent(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
	const form = await request.formData();
	const handle = String(form.get("handle") ?? "");
	if (form.get("decision") !== "approve") {
		const denied = await oauth.denyConsent(request, handle);
		return new Response(null, { status: 302, headers: denied.headers });
	}
	const signed = await actorFromRequest(request, env);
	if (!signed || signed.actor.kind !== "person") return plain("Sign in, then approve this connection.", 401);
	const approved = await oauth.approveConsent(request, handle, { scope: ["suggest"] });
	const client = await oauth.lookupClient(approved.request.clientId);
	const tool = toolLabel(client?.clientName || approved.request.clientId);
	const connected = await connectSignedInAgent(env, signed.actor, tool);
	if ("message" in connected) return plain(connected.message, 403);
	const completed = await oauth.completeAuthorization({
		request: approved.request,
		userId: connected.actor.id,
		metadata: { tool },
		scope: ["suggest"],
		props: { actorId: connected.actor.id, keyHash: connected.keyHash } satisfies McpActorProps,
	});
	approved.headers.set("Location", completed.redirectTo);
	return new Response(null, { status: 302, headers: approved.headers });
}
