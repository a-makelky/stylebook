// The review screen keeps the person's Stylebook key in a cookie. The key is
// the same one the Git route checks. It is never the demo key.

import { actorByKey, type Actor } from "./actors";
import type { Env } from "./env";
import { actorBySession, endSession } from "./teams";

export const KEY_COOKIE = "stylebook";
export const CHOOSE_COOKIE = "stylebook_choose";
export const SEEN_COOKIE = "stylebook_seen";
export const RETURN_COOKIE = "stylebook_return";

/** Only a same-origin approval address. Anything else is dropped. */
export function safeReturnPath(value: string): string | null {
	if (value.length < 1 || value.length > 2000) return null;
	if (value.includes("//") || value.includes("\\") || value.includes("\n") || value.includes("\r")) return null;
	if (value !== "/authorize" && !value.startsWith("/authorize?")) return null;
	return value;
}

export function returnCookie(path: string): string {
	return `${RETURN_COOKIE}=${encodeURIComponent(path)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
}

export function clearReturnCookie(): string {
	return `${RETURN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readPresentedKey(request: Request): string | null {
	const cookie = request.headers.get("Cookie") ?? "";
	for (const part of cookie.split(";")) {
		const trimmed = part.trim();
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		if (trimmed.slice(0, eq) !== KEY_COOKIE) continue;
		try {
			const value = decodeURIComponent(trimmed.slice(eq + 1));
			if (value) return value;
		} catch {
			return null;
		}
	}
	const header = request.headers.get("Authorization") ?? "";
	if (header.startsWith("Bearer ")) {
		const key = header.slice(7).trim();
		if (key) return key;
	}
	return null;
}

export function readCookie(request: Request, name: string): string | null {
	const cookie = request.headers.get("Cookie") ?? "";
	for (const part of cookie.split(";")) {
		const trimmed = part.trim();
		const eq = trimmed.indexOf("=");
		if (eq === -1) continue;
		if (trimmed.slice(0, eq) !== name) continue;
		try {
			const value = decodeURIComponent(trimmed.slice(eq + 1));
			if (value) return value;
		} catch {
			return null;
		}
	}
	return null;
}

export async function actorFromRequest(
	request: Request,
	env: Env,
): Promise<{ actor: Actor; key: string } | null> {
	const key = readPresentedKey(request);
	if (!key) return null;
	const byKey = await actorByKey(env.DB, key);
	if (byKey) return { actor: byKey, key };
	const bySession = await actorBySession(env.DB, key);
	if (!bySession) return null;
	return { actor: bySession, key };
}

export async function signOut(request: Request, env: Env): Promise<void> {
	const key = readPresentedKey(request);
	if (key) await endSession(env.DB, key);
}

/** HttpOnly, Secure, SameSite=Strict. The browser only sends it back to this host. */
export function keyCookie(key: string): string {
	return `${KEY_COOKIE}=${encodeURIComponent(key)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=1209600`;
}

export function clearCookie(): string {
	return `${KEY_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function chooseCookie(secret: string): string {
	return `${CHOOSE_COOKIE}=${encodeURIComponent(secret)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`;
}

export function clearChooseCookie(): string {
	return `${CHOOSE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/** A verified email, before there is a workspace session. Same rules as the session cookie. */
export function seenCookie(secret: string): string {
	return `${SEEN_COOKIE}=${encodeURIComponent(secret)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900`;
}

export function clearSeenCookie(): string {
	return `${SEEN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
