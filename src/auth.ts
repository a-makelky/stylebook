// The review screen keeps the person's Stylebook key in a cookie. The key is
// the same one the Git route checks. It is never the demo key.

import { actorByKey, type Actor } from "./actors";
import type { Env } from "./env";

export const KEY_COOKIE = "stylebook";

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

export async function actorFromRequest(
	request: Request,
	env: Env,
): Promise<{ actor: Actor; key: string } | null> {
	const key = readPresentedKey(request);
	if (!key) return null;
	const actor = await actorByKey(env.DB, key);
	if (!actor) return null;
	return { actor, key };
}

/** HttpOnly, Secure, SameSite=Strict. The browser only sends it back to this host. */
export function keyCookie(key: string): string {
	return `${KEY_COOKIE}=${encodeURIComponent(key)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=1209600`;
}

export function clearCookie(): string {
	return `${KEY_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
