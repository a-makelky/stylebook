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
	MAX_PEOPLE?: string;
	MAX_AGENTS?: string;
	MAX_OPEN_SUGGESTIONS?: string;
	MAX_SIGN_IN_EMAILS_PER_HOUR?: string;
	MAX_SIGN_IN_EMAILS_PER_IP_PER_HOUR?: string;
}
