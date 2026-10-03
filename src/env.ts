import type { SessionParams } from "./session";

/** Cloudflare Email Service send binding. https://developers.cloudflare.com/email-service/api/send-emails/workers-api/ */
export interface OutboundMail {
	send(message: {
		to: string | { email: string; name?: string };
		from: string | { email: string; name?: string };
		subject: string;
		text?: string;
		html?: string;
	}): Promise<{ messageId: string }>;
}

export interface Env {
	/** One Artifacts namespace. Every team's library and copies live here, prefixed by the workspace id. */
	WORKSPACE: Artifacts;
	/** Secret. Callers of the demo routes send it as a bearer token. */
	DEMO_KEY?: string;
	DB: D1Database;
	/** One instance per suggestion session. */
	SUGGESTIONS: Workflow<SessionParams>;
	/** Started by the namespace-wide push trigger, not by the demo route. */
	ARRIVALS: Workflow;
	/** Sign-in email. Restricted to one sender address. Absent in tests that do not send mail. */
	EMAIL?: OutboundMail;
	MAX_WORKSPACES?: string;
	MAX_WORKSPACES_PER_EMAIL?: string;
	MAX_WORKSPACES_PER_IP_PER_DAY?: string;
	MAX_PEOPLE?: string;
	MAX_AGENTS?: string;
	MAX_OPEN_SUGGESTIONS?: string;
	MAX_SIGN_IN_EMAILS_PER_HOUR?: string;
	MAX_SIGN_IN_EMAILS_PER_IP_PER_HOUR?: string;
	MAX_SIGN_IN_EMAILS_GLOBAL_PER_HOUR?: string;
	/** "access" (Cloudflare Access) or "link" (the email links kept in src/mail.ts). */
	SIGN_IN?: string;
	/** https://<team>.cloudflareaccess.com — set as a secret, not in the repo. */
	TEAM_DOMAIN?: string;
	/** Application Audience (AUD) tag. Set as a secret, not in the repo. */
	POLICY_AUD?: string;
	/** Comma-separated emails allowed to open /admin. A secret. Never written here. */
	SERVICE_ADMINS?: string;
	/** Test double: a JWKS JSON document. Production fetches the team certs URL. */
	ACCESS_JWKS?: string;
	/** Largest download, in bytes. Set in wrangler config. */
	MAX_BACKUP_BYTES?: string;
	/** Largest restore upload, in bytes. Set in wrangler config. */
	MAX_BACKUP_UPLOAD_BYTES?: string;
	/** Encrypts a backup secret for another service. A Worker secret. */
	BACKUP_KEY?: string;
	/** GitHub App id. A Worker secret, set once the app exists. */
	GITHUB_APP_ID?: string;
	/** GitHub App private key, PEM. A Worker secret. */
	GITHUB_APP_PRIVATE_KEY?: string;
	/** GitHub App slug, used for the install screen. A Worker secret. */
	GITHUB_APP_SLUG?: string;
}
