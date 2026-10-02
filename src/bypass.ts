// A push that does not go through the Git route. The arrival Workflow should
// flag it, because nothing in the gateway table names an actor for it.
// Sessions do not use this. It exists so the flag can be shown.

import { publishFile } from "./git";
import { DEMO_AUTHOR } from "./tracer";
import { ensureLibrary, listEditions, writeAccess, LIBRARY } from "./workspace";

export async function publishDirect(
	workspace: Artifacts,
): Promise<{ name: string; edition: string }> {
	const library = await ensureLibrary(workspace);
	const existing = await listEditions(library.repo, 1);
	const access = await writeAccess(library.repo, 120);
	const edition = await publishFile({
		remote: access.remote,
		token: access.token,
		path: "desk/unseen.md",
		content: `Saved without the gateway at ${new Date().toISOString()}\n`,
		message: "Save an edition outside the gateway",
		author: DEMO_AUTHOR,
		hasHistory: existing.length > 0,
	});
	return { name: LIBRARY, edition };
}
