// ArrivalWorkflow is started by the namespace-wide push trigger. It only
// records the event. SuggestionWorkflow is one scripted session.
// https://developers.cloudflare.com/artifacts/guides/build-and-deploy-on-push/

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { insertArrival, toArrival } from "./arrivals";
import { reconcilePush, type ReconcileResult } from "./audit";
import type { Env } from "./env";
import { runSuggestionSession, type SessionParams, type SessionResult } from "./session";
import { describeError } from "./redact";

const CONFIRM_ATTEMPTS = 3;

export class ArrivalWorkflow extends WorkflowEntrypoint<Env> {
	async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
		const row = await step.do("record the arrival", async () => {
			const recordedAt = new Date().toISOString();
			const arrival = toArrival(event.payload, recordedAt, event.instanceId);
			await insertArrival(this.env.DB, arrival);
			return {
				repoName: arrival.repoName,
				refName: arrival.refName,
				editionId: arrival.editionId,
				kind: arrival.kind,
			};
		});

		// The gateway writes its row after Artifacts has already accepted the
		// push, which is when this workflow starts. Match on repo + ref + edition.
		// https://developers.cloudflare.com/artifacts/guides/event-subscriptions/
		let outcome: ReconcileResult | "unparsed" = "unparsed";
		if (row.kind !== "unparsed" && !row.editionId.startsWith("missing-")) {
			for (let attempt = 1; attempt <= CONFIRM_ATTEMPTS; attempt++) {
				await step.sleep(`wait for the gateway row ${attempt}`, "2 seconds");
				outcome = await step.do(`match the gateway row ${attempt}`, async () =>
					reconcilePush(
						this.env.DB,
						row.repoName,
						row.refName,
						row.editionId,
						new Date().toISOString(),
						attempt === CONFIRM_ATTEMPTS,
					),
				);
				if (outcome === "confirmed") break;
			}
		}
		return { ...row, outcome };
	}
}

export class SuggestionWorkflow extends WorkflowEntrypoint<Env, SessionParams> {
	async run(event: WorkflowEvent<SessionParams>, step: WorkflowStep) {
		// Retries of a whole step could save the same change twice. The session
		// records its own publish retries and returns them instead of throwing.
		return step.do("suggest", async () => {
			try {
				return await runSuggestionSession(this.env.WORKSPACE, event.payload);
			} catch (error) {
				const failure = describeError(error);
				const now = new Date().toISOString();
				const fallen: SessionResult = {
					ok: false,
					name: event.payload.session,
					actor: event.payload.actor,
					session: event.payload.session,
					edit: {
						index: event.payload.editIndex,
						section: "unknown",
						kind: "add",
						summary: "The session failed before it could report",
					},
					startedAt: now,
					endedAt: now,
					elapsedMs: 0,
					forkStartedAt: null,
					forkEndedAt: null,
					forkMs: null,
					afterFork: null,
					source: null,
					created: false,
					libraryTip: null,
					libraryEditionCount: null,
					parentEdition: null,
					edition: null,
					editionCount: null,
					onTopOfLibrary: false,
					alreadyApplied: false,
					noteCommit: null,
					failures: [failure],
				};
				return fallen;
			}
		});
	}
}
