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
import { limitsOf } from "./limits";
import { DEMO_UNAVAILABLE, isDemoCopy } from "./permit";
import { clientIp } from "./mail";
import { handleMcp, type McpActorProps } from "./mcp";
import { esc, page } from "./screen";
import { chooseWorkspace, connectSignedInAgent, memberships, workspaceById } from "./teams";

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
		clientRegistrationCallback: ({ clientMetadata }) => registrationPolicy(clientMetadata),
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

export const CLIENT_NAME_MAX = 80;
export const REDIRECT_URI_MAX = 8;

/**
 * Dynamic registration stays public-client only, so every client uses PKCE.
 * The provider rejects a public client that skips the code check.
 * https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/authorization-server.md
 */
export function registrationPolicy(
	metadata: Record<string, unknown>,
): { code: string; description: string } | undefined {
	const name = metadata.client_name;
	if (typeof name === "string" && [...name].length > CLIENT_NAME_MAX) {
		return { code: "invalid_client_metadata", description: "The app name is too long." };
	}
	const uris = metadata.redirect_uris;
	if (Array.isArray(uris) && uris.length > REDIRECT_URI_MAX) {
		return { code: "invalid_client_metadata", description: "Too many return addresses." };
	}
	if (metadata.token_endpoint_auth_method !== "none") {
		return { code: "invalid_client_metadata", description: "Sign in from the app. A shared secret is not accepted." };
	}
	return undefined;
}

/** One network can register only so many apps an hour. The count and the insert are one statement. */
export async function claimOauthRegistration(env: Env, ip: string): Promise<boolean> {
	const limits = limitsOf(env);
	const now = new Date().toISOString();
	const since = new Date(Date.now() - 3_600_000).toISOString();
	const result = await env.DB.prepare(
		`INSERT INTO oauth_registrations (ip, sent_at)
     SELECT ?1, ?2
     WHERE (SELECT COUNT(*) FROM oauth_registrations WHERE ip = ?1 AND sent_at >= ?3) < ?4`,
	)
		.bind(ip.slice(0, 80) || "unknown", now, since, limits.oauthRegistrationsPerIpPerHour)
		.run();
	return (result.meta?.changes ?? 0) > 0;
}

export async function oauthFetch(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	fallback: AppFetch,
): Promise<Response> {
	if (!env.OAUTH_KV) return fallback(request, env, ctx);
	const url = new URL(request.url);
	if (request.method === "POST" && url.pathname === "/oauth/register") {
		const allowed = await claimOauthRegistration(env, clientIp(request));
		if (!allowed) {
			return Response.json(
				{
					error: "temporarily_unavailable",
					error_description: "Too many connections were started from this network. Try again in an hour.",
				},
				{ status: 429, headers: { "Retry-After": "3600" } },
			);
		}
	}
	return providerFor(url.origin, fallback).fetch(request, env, ctx);
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
	const signed = await actorFromRequest(request, env);
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

	const person = signed.actor;
	if (await isDemoCopy(env.DB, person.workspaceId)) {
		return html(
			`<div class="sheet"><h1>Connect your tools</h1><p>${esc(DEMO_UNAVAILABLE)}</p></div>`,
		);
	}
	const details = await oauth.describeConsent(authRequest);
	const consent = await oauth.beginConsent(authRequest);
	const registered = details.clientName.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
	const tool = toolLabel(registered);
	const agentName = `${tool} for ${person.name}`.slice(0, 80);
	const workspace = await workspaceById(env.DB, person.workspaceId);
	const workspaceName = workspace?.name ?? "this workspace";
	const homes = person.email ? await memberships(env.DB, person.email) : [];
	const back = authorizeReturn(url);
	const picker = homes
		.filter((home) => home.workspace.id !== person.workspaceId)
		.map(
			(home) => `<form method="post" action="/authorize">
        <input type="hidden" name="decision" value="switch">
        <input type="hidden" name="workspace" value="${esc(home.workspace.id)}">
        <input type="hidden" name="return" value="${esc(back)}">
        <button class="text" type="submit">Open ${esc(home.workspace.name)}</button>
      </form>`,
		)
		.join("");
	const published = details.clientDomain ? `<p>Published by ${esc(details.clientDomain)}.</p>` : "";
	const loopback = details.redirectIsLoopback
		? `<p>This returns you to an app on your computer. Continue only if you just started from it.</p>`
		: "";
	const body = `<div class="sheet">
      <h1>Connect ${esc(tool)} to ${esc(workspaceName)}?</h1>
      <p class="return">This returns you to ${esc(details.redirectHost)}</p>
      <p>An app calling itself '${esc(registered)}' is asking. Only approve if you just added Stylebook to that app.</p>
      <p>${esc(tool)} (registered as ${esc(registered)}) will be able to read the ${esc(workspaceName)} library and suggest changes as <em>${esc(agentName)}</em>. It cannot publish.</p>
      ${published}
      ${loopback}
      ${picker ? `<h2>Workspace</h2>${picker}` : ""}
      <form method="post" action="/authorize">
        <input type="hidden" name="handle" value="${esc(consent.handle)}">
        <input type="hidden" name="workspace" value="${esc(person.workspaceId)}">
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

function authorizeReturn(url: URL): string {
	const next = new URL(url.pathname + url.search, url.origin);
	next.searchParams.delete("workspace");
	return safeReturnPath(`${next.pathname}${next.search}`) ?? "/authorize";
}

async function switchWorkspace(request: Request, env: Env, form: FormData): Promise<Response> {
	const signed = await actorFromRequest(request, env);
	if (!signed || signed.actor.kind !== "person" || !signed.actor.email) {
		return plain("Sign in, then choose a workspace.", 401);
	}
	const back = safeReturnPath(String(form.get("return") ?? ""));
	if (!back) return plain("Go back and choose a workspace.", 400);
	const joined = await chooseWorkspace(env, signed.actor.email, String(form.get("workspace") ?? ""));
	if ("message" in joined) return plain(joined.message, 403);
	const headers = new Headers({ Location: back });
	headers.append("Set-Cookie", keyCookie(joined.secret));
	return new Response(null, { status: 303, headers });
}

async function finishConsent(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
	const form = await request.formData();
	if (form.get("decision") === "switch") return switchWorkspace(request, env, form);
	const handle = String(form.get("handle") ?? "");
	if (form.get("decision") !== "approve") {
		const denied = await oauth.denyConsent(request, handle);
		return new Response(null, { status: 302, headers: denied.headers });
	}
	const signed = await actorFromRequest(request, env);
	if (!signed || signed.actor.kind !== "person") return plain("Sign in, then approve this connection.", 401);
	if (String(form.get("workspace") ?? "") !== signed.actor.workspaceId) {
		return plain("Approve this for the workspace you are in.", 403);
	}
	if (await isDemoCopy(env.DB, signed.actor.workspaceId)) return plain(DEMO_UNAVAILABLE, 403);
	const approved = await oauth.approveConsent(request, handle, { scope: ["suggest"] });
	const client = await oauth.lookupClient(approved.request.clientId);
	const tool = toolLabel(client?.clientName || approved.request.clientId);
	const connected = await connectSignedInAgent(env, signed.actor, tool, approved.request.clientId);
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
