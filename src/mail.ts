// Email sign-in. The link is single use, expires in 15 minutes, and is stored
// as a hash. Addresses are stored for the send and the membership. They are
// not written to logs.
// https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
// https://developers.cloudflare.com/email-service/configuration/send-bindings/

import { hashKey } from "./actors";
import type { Env } from "./env";
import { LIMIT_MESSAGE, limitsOf } from "./limits";

export const SENDER = "sign-in@stylebook.dev";
export const LINK_TTL_MS = 15 * 60 * 1000;

const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type LinkPurpose = "start" | "sign-in" | "invite" | "choose";

export function normalizeEmail(value: string): string | null {
	const email = value.trim().toLowerCase();
	if (email.length < 3 || email.length > 200 || !EMAIL_OK.test(email)) return null;
	return email;
}

export function clientIp(request: Request): string {
	const header = request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For") ?? "";
	const ip = header.split(",")[0]?.trim() ?? "";
	return ip.slice(0, 80) || "unknown";
}

function randomSecret(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function wrote(result: D1Result): number {
	return result.meta?.changes ?? 0;
}

/**
 * Count and insert in one statement, so parallel requests cannot all pass.
 * A Workers Rate Limiting binding cannot do this hour-long cap: its period is
 * only 10 or 60 seconds, and the counter is local to one location and
 * eventually consistent.
 * https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
 * D1 runs one statement to a commit.
 * https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
 */
export async function claimSignInSend(env: Env, email: string, ip: string): Promise<boolean> {
	const limits = limitsOf(env);
	const now = new Date().toISOString();
	const since = new Date(Date.now() - 3_600_000).toISOString();
	const result = await env.DB.prepare(
		`INSERT INTO sign_in_sends (email, ip, sent_at)
     SELECT ?1, ?2, ?3
     WHERE (SELECT COUNT(*) FROM sign_in_sends WHERE email = ?1 AND sent_at >= ?4) < ?5
       AND (SELECT COUNT(*) FROM sign_in_sends WHERE ip = ?2 AND sent_at >= ?4) < ?6
       AND (SELECT COUNT(*) FROM sign_in_sends WHERE sent_at >= ?4) < ?7`,
	)
		.bind(
			email,
			ip,
			now,
			since,
			limits.signInEmailsPerHour,
			limits.signInEmailsPerIpPerHour,
			limits.signInEmailsGlobalPerHour,
		)
		.run();
	return wrote(result) > 0;
}

/** Letters, digits, spaces, and basic punctuation, at most 40 characters. */
const EMAIL_NAME = /^[A-Za-z0-9 .,''&\-()]+$/;

export function emailWorkspaceName(name: string | null | undefined): string | null {
	if (!name) return null;
	const trimmed = name.trim().replace(/\s+/g, " ");
	if (trimmed.length < 1 || trimmed.length > 40) return null;
	if (!EMAIL_NAME.test(trimmed)) return null;
	return trimmed;
}

function letter(
	url: string,
	purpose: LinkDraft["purpose"],
	workspaceName: string | null,
): { subject: string; text: string; html: string } {
	const safe = purpose === "invite" ? emailWorkspaceName(workspaceName) : null;
	const line =
		purpose === "start"
			? "Open this link to open your new workspace. It works once and expires in 15 minutes."
			: safe
				? `Open this link to sign in to "${safe}". It works once and expires in 15 minutes.`
				: "Open this link to sign in. It works once and expires in 15 minutes.";
	const subject = "Sign in to Stylebook";
	const text = ["Stylebook", "", line, "", url, "", "If you did not ask for this, you can ignore it."].join("\n");
	const html = `<!DOCTYPE html><html lang="en"><body style="font-family: Georgia, serif; color: #1B1D21; background: #FCFCFA;">
<p style="font-style: italic; font-size: 28px;">Stylebook</p>
<p>${escapeHtml(line)}</p>
<p><a href="${escapeHtml(url)}">Sign in</a></p>
<p style="color: #5E6167;">If you did not ask for this, you can ignore it.</p>
</body></html>`;
	return { subject, text, html };
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface LinkDraft {
	email: string;
	purpose: Exclude<LinkPurpose, "choose">;
	workspaceId?: string | null;
	workspaceName?: string | null;
	invitedBy?: string | null;
}

export const SENT = "Check your inbox. The link works once and expires in 15 minutes.";

/** The same reply for every address, so sign-in does not reveal who has an account. */
export const SIGN_IN_ACK = "If that address is in a workspace, a link is on its way.";

export type SendResult =
	| { ok: true; message: string }
	| { ok: false; message: string; status: number };

/** Store a hashed link and send it. The caller has already claimed a send. */
export async function sendStoredLink(env: Env, origin: string, draft: LinkDraft): Promise<SendResult> {
	const email = normalizeEmail(draft.email);
	if (!email) return { ok: false, message: "Enter an email address.", status: 400 };
	if (!env.EMAIL) return { ok: false, message: "Sign-in email is not ready yet.", status: 503 };

	const secret = randomSecret();
	const now = new Date();
	const expires = new Date(now.getTime() + LINK_TTL_MS).toISOString();
	await env.DB.prepare(
		`INSERT INTO sign_in_links
      (token_hash, email, purpose, workspace_id, workspace_name, invited_by, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
	)
		.bind(
			await hashKey(secret),
			email,
			draft.purpose,
			draft.workspaceId ?? null,
			draft.workspaceName ?? null,
			draft.invitedBy ?? null,
			now.toISOString(),
			expires,
		)
		.run();

	const url = `${origin.replace(/\/$/, "")}/s/${secret}`;
	const message = letter(url, draft.purpose, draft.purpose === "start" ? null : draft.workspaceName ?? null);
	try {
		await env.EMAIL.send({
			to: email,
			from: { email: SENDER, name: "Stylebook" },
			subject: message.subject,
			text: message.text,
			html: message.html,
		});
	} catch {
		return { ok: false, message: "The sign-in email could not be sent. Try again in a little while.", status: 503 };
	}
	return { ok: true, message: SENT };
}

export async function issueSignInLink(
	env: Env,
	request: Request,
	origin: string,
	draft: LinkDraft,
): Promise<SendResult> {
	const email = normalizeEmail(draft.email);
	if (!email) return { ok: false, message: "Enter an email address.", status: 400 };
	if (!env.EMAIL) return { ok: false, message: "Sign-in email is not ready yet.", status: 503 };
	if (!(await claimSignInSend(env, email, clientIp(request)))) {
		return { ok: false, message: LIMIT_MESSAGE.signIn, status: 429 };
	}
	return sendStoredLink(env, origin, { ...draft, email });
}

export interface StoredLink {
	email: string;
	purpose: string;
	workspaceId: string | null;
	workspaceName: string | null;
	invitedBy: string | null;
	expiresAt: string;
	usedAt: string | null;
}

/** A link that is not emailed. Used when an address belongs to more than one workspace. */
export async function rememberLink(env: Env, email: string, purpose: LinkPurpose): Promise<string> {
	const secret = randomSecret();
	const now = new Date();
	await env.DB.prepare(
		`INSERT INTO sign_in_links
      (token_hash, email, purpose, workspace_id, workspace_name, invited_by, created_at, expires_at)
     VALUES (?1, ?2, ?3, NULL, NULL, NULL, ?4, ?5)`,
	)
		.bind(await hashKey(secret), email, purpose, now.toISOString(), new Date(now.getTime() + LINK_TTL_MS).toISOString())
		.run();
	return secret;
}

export async function peekLink(env: Env, secret: string): Promise<StoredLink | null> {
	if (!/^[0-9a-f]{64}$/.test(secret)) return null;
	const row = await env.DB.prepare(
		`SELECT email, purpose, workspace_id, workspace_name, invited_by, expires_at, used_at
     FROM sign_in_links WHERE token_hash = ?1`,
	)
		.bind(await hashKey(secret))
		.first<{
			email: string;
			purpose: string;
			workspace_id: string | null;
			workspace_name: string | null;
			invited_by: string | null;
			expires_at: string;
			used_at: string | null;
		}>();
	if (!row || row.used_at || row.expires_at <= new Date().toISOString()) return null;
	return {
		email: row.email,
		purpose: row.purpose,
		workspaceId: row.workspace_id,
		workspaceName: row.workspace_name,
		invitedBy: row.invited_by,
		expiresAt: row.expires_at,
		usedAt: null,
	};
}

export async function takeLink(env: Env, secret: string): Promise<StoredLink | null> {
	if (!/^[0-9a-f]{64}$/.test(secret)) return null;
	const hash = await hashKey(secret);
	const now = new Date().toISOString();
	const stamp = `${now}#${randomSecret().slice(0, 8)}`;
	const row = await env.DB.prepare(
		`SELECT email, purpose, workspace_id, workspace_name, invited_by, expires_at, used_at
     FROM sign_in_links WHERE token_hash = ?1`,
	)
		.bind(hash)
		.first<{
			email: string;
			purpose: string;
			workspace_id: string | null;
			workspace_name: string | null;
			invited_by: string | null;
			expires_at: string;
			used_at: string | null;
		}>();
	if (!row || row.used_at || row.expires_at <= now) return null;
	await env.DB.prepare(`UPDATE sign_in_links SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL`)
		.bind(stamp, hash)
		.run();
	const claimed = await env.DB.prepare(`SELECT used_at FROM sign_in_links WHERE token_hash = ?1`)
		.bind(hash)
		.first<{ used_at: string | null }>();
	if (claimed?.used_at !== stamp) return null;
	return {
		email: row.email,
		purpose: row.purpose,
		workspaceId: row.workspace_id,
		workspaceName: row.workspace_name,
		invitedBy: row.invited_by,
		expiresAt: row.expires_at,
		usedAt: now,
	};
}
