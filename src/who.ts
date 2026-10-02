// "Who saved this edition?" The answer is the actor the Git route recorded,
// plus the note on that edition. The author name inside the edition is not used.

import type { GatewayPush } from "./audit";
import { pushForEdition } from "./audit";
import type { Env } from "./env";
import { NOTES_REF } from "./git";
import { parseEditionNote, type EditionNote } from "./notes";
import { getRepo } from "./workspace";

export interface Who {
	edition: string;
	name: string;
	actor: { id: string; name: string; kind: string; model: string | null };
	owner: { id: string; name: string; kind: string };
	note: EditionNote | null;
}

async function noteText(env: Env, repoName: string, edition: string): Promise<string | null> {
	const repo = await getRepo(env.WORKSPACE, repoName);
	if (!repo) return null;
	return noteOnRepo(env, repo, repoName, edition);
}

async function noteOnRepo(env: Env, repo: ArtifactsRepo, repoName: string, edition: string): Promise<string | null> {
	// readFile resolves a branch, a tag, or a commit id. A notes ref is none of
	// those, so the commit id recorded for refs/notes/* is what the read uses.
	// https://developers.cloudflare.com/artifacts/concepts/best-practices/
	const commits = await env.DB.prepare(
		`SELECT edition_id FROM gateway_pushes
     WHERE repo_name = ?1 AND ref_name = ?2
     ORDER BY id DESC
     LIMIT 20`,
	)
		.bind(repoName, NOTES_REF)
		.all<{ edition_id: string }>();
	const refs = [NOTES_REF, ...(commits.results ?? []).map((row) => row.edition_id)];
	const paths = [edition, `${edition.slice(0, 2)}/${edition.slice(2)}`];
	for (const ref of refs) {
		for (const path of paths) {
			try {
				const blob = await repo.readFile({ ref, path });
				if (!blob) continue;
				const text = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
				if (text) return text;
			} catch {
				// A missing path throws. Try the other notes layout.
			}
		}
	}
	return null;
}

export function whoFromPush(push: GatewayPush, note: EditionNote | null): Who {
	return {
		edition: push.editionId,
		name: push.repoName,
		actor: {
			id: push.actorId,
			name: push.actorName,
			kind: push.actorKind,
			model: push.model,
		},
		owner: { id: push.ownerId, name: push.ownerName, kind: "person" },
		note,
	};
}

export async function whoPublished(env: Env, edition: string): Promise<Who | null> {
	const push = await pushForEdition(env.DB, edition);
	if (!push) return null;
	const text = await noteText(env, push.repoName, push.editionId);
	return whoFromPush(push, text ? parseEditionNote(text) : null);
}
