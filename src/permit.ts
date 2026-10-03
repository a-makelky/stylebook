// One permission check for the screen, the Git route, MCP, and /git/access.
// A route does not decide a role on its own. It asks here.

export type Role = "admin" | "member";

export type Action =
	| "read"
	| "suggest"
	| "publish"
	| "decline"
	| "combine"
	| "keep"
	| "lock"
	| "unlock"
	| "connect-agent"
	| "rename-agent"
	| "revoke-agent"
	| "invite"
	| "change-role"
	| "remove-person"
	| "rename-workspace"
	| "members-can-publish"
	| "delete-workspace";

export interface PermitActor {
	kind: "person" | "agent";
	removedAt: string | null;
}

export interface WorkspaceSettings {
	membersCanPublish: boolean;
	suspended: boolean;
}

export interface PermitInput {
	actor: PermitActor;
	/** The person's role. For an agent, this is the person they work for. */
	role: Role;
	action: Action;
	path?: string | null;
	settings: WorkspaceSettings;
	/** The page is locked, or a library write might include a locked page. */
	locked?: boolean;
	/** This person started the workspace. */
	starter?: boolean;
	/** The person this action would change started the workspace. */
	targetStarter?: boolean;
	/** The agent belongs to this person. */
	own?: boolean;
}

export type PermitResult = { ok: true } | { ok: false; sentence: string };

const PUBLISH: ReadonlySet<Action> = new Set(["publish", "decline", "combine", "keep"]);

const PUBLISH_SENTENCE = "Only an Admin can publish here. You can suggest this change instead.";
const LOCKED_SENTENCE = "Only an Admin can publish a locked page.";

function no(sentence: string): PermitResult {
	return { ok: false, sentence };
}

/**
 * What this actor may do. Agents never publish, decline, combine, invite, or
 * change settings, and they never exceed the person they work for.
 */
export function permit(input: PermitInput): PermitResult {
	const { actor, role, action, settings } = input;
	if (actor.removedAt) return no("That person is not in this workspace.");
	if (settings.suspended && action !== "read") return no("This workspace is read-only.");

	if (actor.kind === "agent") {
		if (role !== "admin" && role !== "member") return no("That agent is not in this workspace.");
		if (action === "read" || action === "suggest") return { ok: true };
		if (action === "publish" || action === "keep") return no("An agent cannot publish.");
		if (action === "decline") return no("An agent cannot decline.");
		if (action === "combine") return no("An agent cannot combine.");
		if (action === "invite" || action === "change-role" || action === "remove-person") {
			return no("An agent cannot invite someone.");
		}
		if (
			action === "lock" ||
			action === "unlock" ||
			action === "rename-workspace" ||
			action === "members-can-publish" ||
			action === "delete-workspace" ||
			action === "connect-agent" ||
			action === "rename-agent" ||
			action === "revoke-agent"
		) {
			return no("An agent cannot change the workspace.");
		}
		return no("An agent cannot change the workspace.");
	}

	const admin = role === "admin";
	if (action === "read" || action === "suggest" || action === "connect-agent") return { ok: true };

	if (action === "rename-agent") {
		return input.own ? { ok: true } : no("That agent is not yours.");
	}
	if (action === "revoke-agent") {
		if (input.own || admin) return { ok: true };
		return no("Only an Admin can revoke someone else's agent.");
	}

	if (PUBLISH.has(action)) {
		if (input.locked && !admin) return no(LOCKED_SENTENCE);
		if (admin) return { ok: true };
		if (settings.membersCanPublish) return { ok: true };
		return no(PUBLISH_SENTENCE);
	}

	if (action === "lock" || action === "unlock") {
		return admin ? { ok: true } : no("Only an Admin can lock a page.");
	}

	if (action === "invite") return admin ? { ok: true } : no("Only an Admin can invite someone.");
	if (action === "change-role") {
		if (input.targetStarter) return no("The person who started this workspace stays an Admin.");
		return admin ? { ok: true } : no("Only an Admin can change a role.");
	}
	if (action === "remove-person") {
		if (input.targetStarter) return no("The person who started this workspace cannot be removed.");
		return admin ? { ok: true } : no("Only an Admin can remove someone.");
	}
	if (action === "rename-workspace" || action === "members-can-publish") {
		return admin ? { ok: true } : no("Only an Admin can change this workspace.");
	}
	if (action === "delete-workspace") {
		return input.starter ? { ok: true } : no("Only the person who started this workspace can delete it.");
	}
	return no("Only an Admin can change this workspace.");
}
