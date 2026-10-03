// Who is signing in. The rest of Stylebook asks this module and does not read
// Access headers itself. Email links stay in src/mail.ts and run only when
// SIGN_IN is "link". The hosted sign-in is Cloudflare Access one-time PIN.
//
// https://developers.cloudflare.com/workers/configuration/cloudflare-access/
// https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
// https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/
// https://developers.cloudflare.com/cloudflare-one/access-controls/policies/

import type { Env } from "./env";
import { normalizeEmail } from "./mail";

export type SignInMode = "access" | "link";

export function signInMode(env: Env): SignInMode {
	// Production sets SIGN_IN to access. Unset keeps the email-link code, so
	// tests of that path still run. The links are switched off on the Worker.
	return env.SIGN_IN === "access" ? "access" : "link";
}

interface AccessClaims {
	email?: unknown;
	iss?: unknown;
	aud?: unknown;
	exp?: unknown;
	nbf?: unknown;
}

interface JsonWebKeyWithKid extends JsonWebKey {
	kid?: string;
}

/** A request context that may already have been checked by Access. */
export interface AccessRuntime {
	access?: {
		// Matches the generated Workers type: missing identity is `undefined`.
		getIdentity(): Promise<{ email?: string } | null | undefined>;
	};
}

const CERTS_PATH = "/cdn-cgi/access/certs";
let cachedKeys: { url: string; keys: JsonWebKeyWithKid[]; at: number } | null = null;

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlToBytes(input: string): Uint8Array {
	const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function decodeJson<T>(segment: string): T | null {
	try {
		return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment))) as T;
	} catch {
		return null;
	}
}

async function keysFor(env: Env): Promise<{ keys: JsonWebKeyWithKid[]; issuer: string; audience: string } | null> {
	if (env.ACCESS_JWKS) {
		try {
			const parsed = JSON.parse(env.ACCESS_JWKS) as { keys?: JsonWebKeyWithKid[] };
			if (!parsed.keys?.length || !env.TEAM_DOMAIN || !env.POLICY_AUD) return null;
			return { keys: parsed.keys, issuer: env.TEAM_DOMAIN, audience: env.POLICY_AUD };
		} catch {
			return null;
		}
	}
	if (!env.TEAM_DOMAIN || !env.POLICY_AUD) return null;
	const url = `${env.TEAM_DOMAIN.replace(/\/$/, "")}${CERTS_PATH}`;
	if (cachedKeys && cachedKeys.url === url && Date.now() - cachedKeys.at < 60 * 60 * 1000) {
		return { keys: cachedKeys.keys, issuer: env.TEAM_DOMAIN, audience: env.POLICY_AUD };
	}
	const response = await fetch(url);
	if (!response.ok) return null;
	const body = (await response.json()) as { keys?: JsonWebKeyWithKid[] };
	if (!body.keys?.length) return null;
	cachedKeys = { url, keys: body.keys, at: Date.now() };
	return { keys: body.keys, issuer: env.TEAM_DOMAIN, audience: env.POLICY_AUD };
}

function audienceMatches(aud: unknown, expected: string): boolean {
	if (typeof aud === "string") return aud === expected;
	return Array.isArray(aud) && aud.some((item) => item === expected);
}

/**
 * The email Access proved. The `Cf-Access-Authenticated-User-Email` header is
 * never read. A JWT is checked against the team signing keys, the issuer, and
 * the application audience, as the validating-json guide describes.
 */
export async function emailFromAccessJwt(token: string, env: Env): Promise<string | null> {
	const parts = token.split(".");
	if (parts.length !== 3) return null;
	const header = decodeJson<{ alg?: string; kid?: string }>(parts[0] ?? "");
	const claims = decodeJson<AccessClaims>(parts[1] ?? "");
	if (!header || header.alg !== "RS256" || !claims) return null;
	const material = await keysFor(env);
	if (!material) return null;
	if (claims.iss !== material.issuer) return null;
	if (!audienceMatches(claims.aud, material.audience)) return null;
	const now = Math.floor(Date.now() / 1000);
	if (typeof claims.exp !== "number" || claims.exp < now - 60) return null;
	if (typeof claims.nbf === "number" && claims.nbf > now + 60) return null;
	const key = material.keys.find((item) => !header.kid || item.kid === header.kid) ?? material.keys[0];
	if (!key) return null;
	const cryptoKey = await crypto.subtle.importKey(
		"jwk",
		key,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"],
	);
	const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
	const signature = base64UrlToBytes(parts[2] ?? "");
	const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, signed);
	if (!valid) return null;
	return typeof claims.email === "string" ? normalizeEmail(claims.email) : null;
}

export async function verifiedEmail(request: Request, env: Env, runtime?: AccessRuntime): Promise<string | null> {
	if (signInMode(env) !== "access") return null;
	const token = request.headers.get("Cf-Access-Jwt-Assertion");
	if (token) {
		const email = await emailFromAccessJwt(token, env);
		if (email) return email;
	}
	// Access already checked this request. The Workers guide exposes that as
	// ctx.access, which is absent when Access did not authenticate it.
	// https://developers.cloudflare.com/workers/configuration/cloudflare-access/
	if (runtime?.access) {
		try {
			const identity = await runtime.access.getIdentity();
			if (identity?.email) return normalizeEmail(identity.email);
		} catch {
			return null;
		}
	}
	return null;
}

export function accessLogoutUrl(env: Env): string | null {
	if (signInMode(env) !== "access" || !env.TEAM_DOMAIN) return null;
	return `${env.TEAM_DOMAIN.replace(/\/$/, "")}/cdn-cgi/access/logout`;
}

/** Used by tests to build a JWT the verifier will accept. Not a sign-in link. */
export async function signAccessJwt(
	privateKey: CryptoKey,
	kid: string,
	claims: { email: string; iss: string; aud: string; exp: number },
): Promise<string> {
	const header = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })));
	const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
	const signed = new TextEncoder().encode(`${header}.${payload}`);
	const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, signed));
	return `${header}.${payload}.${bytesToBase64Url(signature)}`;
}
