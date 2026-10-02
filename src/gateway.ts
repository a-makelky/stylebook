// The Git route. Callers speak Git to Stylebook. Stylebook checks the caller's
// own key, decides whether that actor may use the copy, and forwards the three
// smart-HTTP requests to Artifacts with a short-lived repo token.
// https://developers.cloudflare.com/artifacts/api/git-protocol/
// https://developers.cloudflare.com/artifacts/concepts/best-practices/

import { grantByToken } from "./access";
import { actorByKey, allows, ownerOf, refusal, type Actor } from "./actors";
import { recordPush } from "./audit";
import type { Env } from "./env";
import { describeError } from "./redact";
import { actorBySession } from "./teams";
import { scopedEnv } from "./usage";
import { getRepo } from "./workspace";

const ROUTE =
	/^\/git\/([A-Za-z0-9][A-Za-z0-9._-]{0,62})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Packs for this library are small. Larger bodies are refused rather than buffered. */
const MAX_BODY = 8 * 1024 * 1024;
const ZERO = "0000000000000000000000000000000000000000";

export interface RefUpdate {
	oldId: string;
	newId: string;
	refName: string;
}

export function gatewayRemote(origin: string, repoName: string): string {
	return `${origin.replace(/\/$/, "")}/git/${repoName}.git`;
}

export function presentedKey(request: Request): string | null {
	const header = request.headers.get("Authorization") ?? "";
	if (header.startsWith("Bearer ")) {
		const key = header.slice(7).trim();
		return key || null;
	}
	if (header.startsWith("Basic ")) {
		let decoded: string;
		try {
			decoded = atob(header.slice(6));
		} catch {
			return null;
		}
		const separator = decoded.indexOf(":");
		if (separator === -1) return null;
		const password = decoded.slice(separator + 1);
		return password || null;
	}
	return null;
}

/**
 * The receive-pack body starts with pkt-lines of ref updates, then a flush,
 * then the pack. The first line may carry capabilities after a NUL.
 */
export function parseReceivePackCommands(body: Uint8Array): RefUpdate[] {
	const updates: RefUpdate[] = [];
	const decoder = new TextDecoder();
	let offset = 0;
	while (offset + 4 <= body.byteLength) {
		const size = Number.parseInt(decoder.decode(body.subarray(offset, offset + 4)), 16);
		if (!Number.isFinite(size) || size < 0) break;
		if (size === 0) break;
		if (size < 4 || offset + size > body.byteLength) break;
		let line = decoder.decode(body.subarray(offset + 4, offset + size)).replace(/\n$/, "");
		offset += size;
		const nul = line.indexOf("\0");
		if (nul !== -1) line = line.slice(0, nul);
		const parts = line.split(" ");
		if (parts.length < 3) continue;
		const [oldId, newId, refName] = parts;
		if (!oldId || !newId || !refName) continue;
		if (!/^[0-9a-f]{40}$/i.test(oldId) || !/^[0-9a-f]{40}$/i.test(newId)) continue;
		if (!refName.startsWith("refs/")) continue;
		updates.push({ oldId: oldId.toLowerCase(), newId: newId.toLowerCase(), refName });
	}
	return updates;
}

/** Refs the server accepted. A report without `unpack ok` accepts nothing. */
export function acceptedUpdates(body: Uint8Array, requested: RefUpdate[]): RefUpdate[] {
	const text = new TextDecoder().decode(body);
	if (!text.includes("unpack ok")) return [];
	const rejected = new Set<string>();
	for (const match of text.matchAll(/ng (\S+)/g)) {
		const ref = match[1];
		if (ref) rejected.add(ref);
	}
	const named: string[] = [];
	for (const match of text.matchAll(/(?:^|[\s\u0001])ok (\S+)/g)) {
		const ref = match[1];
		if (ref) named.push(ref);
	}
	const wanted = requested.filter((update) => update.newId !== ZERO && !rejected.has(update.refName));
	if (named.length === 0) return wanted;
	const ok = new Set(named);
	return wanted.filter((update) => ok.has(update.refName));
}

function text(status: number, message: string, authenticate = false): Response {
	const headers = new Headers({ "Content-Type": "text/plain; charset=utf-8" });
	if (authenticate) headers.set("WWW-Authenticate", 'Basic realm="Stylebook"');
	return new Response(`${message}\n`, { status, headers });
}

function writingRequest(suffix: string, service: string | null): boolean {
	return suffix === "git-receive-pack" || service === "git-receive-pack";
}

export async function handleGit(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const match = ROUTE.exec(url.pathname);
	if (!match) return text(404, "Not found.");
	const repoName = match[1]!;
	const suffix = match[2]!;
	const service = url.searchParams.get("service");
	const writing = writingRequest(suffix, service);

	if (suffix === "info/refs" && request.method !== "GET") return text(405, "Use GET.");
	if (suffix !== "info/refs" && request.method !== "POST") return text(405, "Use POST.");

	const key = presentedKey(request);
	if (!key) return text(401, "Missing or unknown key.", true);
	const actor = (await actorByKey(env.DB, key)) ?? (await actorBySession(env.DB, key));
	const grant = actor ? null : await grantByToken(env.DB, key);
	const caller = actor ?? grant?.actor ?? null;
	if (!caller) return text(401, "Missing or unknown key.", true);
	if (grant && (grant.repoName !== repoName || (writing && !grant.canWrite))) {
		return text(403, refusal(repoName, writing));
	}
	if (!allows(caller, repoName, writing)) return text(403, refusal(repoName, writing));

	const scoped = scopedEnv(env, caller.workspaceId);
	try {
	const repo = await getRepo(scoped.env.WORKSPACE, repoName);
	if (!repo) return text(404, "That copy does not exist.");

	// Bearer takes the full token string the control plane returned, including
	// the expiry suffix. Basic auth would want only the secret.
	// https://developers.cloudflare.com/artifacts/api/git-protocol/
	const [info, token] = await Promise.all([
		repo.info(),
		repo.createToken(writing ? "write" : "read", 300),
	]);
	const search = service ? `?service=${encodeURIComponent(service)}` : "";
	const target = `${info.remote.replace(/\/$/, "")}/${suffix}${search}`;

	let body: Uint8Array | undefined;
	let commands: RefUpdate[] = [];
	if (request.method === "POST") {
		const declared = Number(request.headers.get("Content-Length") ?? "0");
		if (Number.isFinite(declared) && declared > MAX_BODY) {
			return text(413, "This change is too large to accept.");
		}
		body = new Uint8Array(await request.arrayBuffer());
		if (body.byteLength > MAX_BODY) return text(413, "This change is too large to accept.");
		if (writing) commands = parseReceivePackCommands(body);
	}

	const headers = new Headers();
	headers.set("Authorization", `Bearer ${token.plaintext}`);
	const protocol = request.headers.get("Git-Protocol");
	if (protocol) headers.set("Git-Protocol", protocol);
	const contentType = request.headers.get("Content-Type");
	if (contentType) headers.set("Content-Type", contentType);
	headers.set("User-Agent", "stylebook");

	let upstream: Response;
	try {
		upstream = await fetch(target, {
			method: request.method,
			headers,
			body,
			redirect: "follow",
		});
	} catch (error) {
		return text(502, describeError(error).message);
	}

	const upstreamType = upstream.headers.get("Content-Type") ?? "";
	const outHeaders = new Headers();
	if (upstreamType) outHeaders.set("Content-Type", upstreamType);
	const cache = upstream.headers.get("Cache-Control");
	if (cache) outHeaders.set("Cache-Control", cache);

	const gitBody = upstreamType.includes("git");
	if (!gitBody && upstream.status >= 400) {
		// An error page from the upstream can contain the remote, which contains
		// the account id. Do not pass that page on.
		return text(upstream.status === 401 ? 502 : upstream.status, "The workspace refused the request.");
	}

	if (!writing) {
		return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
	}

	const bytes = new Uint8Array(await upstream.arrayBuffer());
	if (upstream.status === 200 && gitBody) {
		const accepted = acceptedUpdates(bytes, commands);
		if (accepted.length > 0) await remember(env, repoName, caller, accepted);
	}
	return new Response(bytes, { status: upstream.status, headers: outHeaders });
	} finally {
		await scoped.flush();
	}
}

async function remember(env: Env, repoName: string, actor: Actor, updates: RefUpdate[]): Promise<void> {
	const owner = await ownerOf(env.DB, actor);
	const acceptedAt = new Date().toISOString();
	for (const update of updates) {
		await recordPush(env.DB, {
			repoName,
			refName: update.refName,
			editionId: update.newId,
			actor,
			owner,
			acceptedAt,
		});
	}
}
