import type { SessionParams } from "./session";

export interface Env {
	WORKSPACE: Artifacts;
	/**
	 * The review screen's library. A separate namespace so its first edition
	 * can be the sample library. Suggestion copies made earlier stay in
	 * WORKSPACE, because fork() keeps a copy in its source namespace.
	 */
	REVIEW: Artifacts;
	/** Secret. Callers of the demo routes send it as a bearer token. */
	DEMO_KEY?: string;
	DB: D1Database;
	/** One instance per suggestion session. */
	SUGGESTIONS: Workflow<SessionParams>;
	/** Started by the namespace-wide push trigger, not by the demo route. */
	ARRIVALS: Workflow;
}
