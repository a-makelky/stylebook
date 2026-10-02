import type { SessionParams } from "./session";

export interface Env {
	WORKSPACE: Artifacts;
	/** Secret. Callers of the demo routes send it as a bearer token. */
	DEMO_KEY?: string;
	DB: D1Database;
	/** One instance per suggestion session. */
	SUGGESTIONS: Workflow<SessionParams>;
	/** Started by the namespace-wide push trigger, not by the demo route. */
	ARRIVALS: Workflow;
}
