import { handleAccess } from "./access";
import { listActors, registerActor, actorByKey, type ActorInput } from "./actors";
import { seedOpenSuggestions } from "./demo-seed";
import { handleMcp } from "./mcp";
import { actorFromRequest } from "./auth";
import { auditSince, isUnseen } from "./audit";
import { publishDirect } from "./bypass";
import type { Env } from "./env";
import { handleGit } from "./gateway";
import { sanitize, describeError } from "./redact";
import { handleScreen } from "./screen";
import { LIMIT_MESSAGE, limitsOf } from "./limits";
import { d1ArrivalLog, d1AuditLog, runSwarm, workflowLauncher, MAX_SESSIONS } from "./swarm";
import { openSuggestionCount } from "./teams";
import { runTracer } from "./tracer";
import { whoPublished } from "./who";
import { ArrivalWorkflow, SuggestionWorkflow } from "./workflows";

export { ArrivalWorkflow, SuggestionWorkflow };

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

function sameString(a: string, b: string): boolean {
	const left = new TextEncoder().encode(a);
	const right = new TextEncoder().encode(b);
	// Compare every byte regardless of where the first difference is.
	let difference = left.byteLength ^ right.byteLength;
	const length = Math.max(left.byteLength, right.byteLength);
	for (let i = 0; i < length; i++) {
		difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
	}
	return difference === 0;
}

/**
 * The demo routes create repos and mint write tokens on the account that
 * runs this Worker, so they are never open to the public.
 */
function checkDemoKey(request: Request, env: Env): Response | null {
	if (!env.DEMO_KEY) {
		return json(
			{ ok: false, error: "The DEMO_KEY secret is not set on this Worker." },
			503,
		);
	}
	const header = request.headers.get("Authorization") ?? "";
	const sent = header.startsWith("Bearer ") ? header.slice(7) : "";
	if (!sent || !sameString(sent, env.DEMO_KEY)) {
		return json({ ok: false, error: "Missing or wrong demo key." }, 401);
	}
	return null;
}

export default {
	async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/health") {
			return json({ ok: true, name: "stylebook" });
		}

		if (url.pathname === "/mcp") {
			try {
				return await handleMcp(request, env);
			} catch (error) {
				const failure = describeError(error);
				return json(sanitize({ ok: false, error: failure.message, code: failure.code }), 500);
			}
		}

		if (url.pathname === "/git/access") {
			try {
				return await handleAccess(request, env);
			} catch (error) {
				const failure = describeError(error);
				return json(sanitize({ ok: false, error: failure.message, code: failure.code }), 500);
			}
		}

		const screen = await handleScreen(request, env, ctx);
		if (screen) return screen;

		if (url.pathname.startsWith("/git/")) {
			try {
				return await handleGit(request, env);
			} catch (error) {
				const failure = describeError(error);
				return json(sanitize({ ok: false, error: failure.message, code: failure.code }), 500);
			}
		}

		if (request.method === "GET" && url.pathname === "/who") {
			const signedIn = await actorFromRequest(request, env);
			if (!signedIn) return json({ ok: false, error: "Missing or unknown key." }, 401);
			const edition = url.searchParams.get("edition") ?? "";
			if (!/^[0-9a-f]{40}$/i.test(edition)) {
				return json({ ok: false, error: "edition must be an edition id." }, 400);
			}
			try {
				const who = await whoPublished(env, edition.toLowerCase(), signedIn.actor.workspaceId);
				if (!who) return json({ ok: false, error: "Nobody is recorded for that edition." }, 404);
				return json(sanitize({ ok: true, ...who }));
			} catch (error) {
				const failure = describeError(error);
				return json(sanitize({ ok: false, error: failure.message, code: failure.code }), 500);
			}
		}

		if (url.pathname === "/demo/actors") {
			const denied = checkDemoKey(request, env);
			if (denied) return denied;
			try {
				if (request.method === "GET") {
					const actors = await listActors(env.DB);
					return json(sanitize({ ok: true, actors }));
				}
				if (request.method === "POST") {
					const body = (await request.json().catch(() => ({}))) as { actors?: ActorInput[] };
					const inputs = Array.isArray(body.actors) ? body.actors : [];
					if (inputs.length < 1 || inputs.length > 20) {
						return json({ ok: false, error: "Send between 1 and 20 actors." }, 400);
					}
					if (inputs.some((input) => input?.workspaceId !== "demo")) {
						return json({ ok: false, error: "The demo routes only change the Demo workspace." }, 403);
					}
					const actors = [];
					for (const input of inputs) actors.push(await registerActor(env.DB, input));
					return json(sanitize({ ok: true, actors }));
				}
			} catch (error) {
				const failure = describeError(error);
				return json(sanitize({ ok: false, error: failure.message, code: failure.code }), failure.code ? 500 : 400);
			}
		}

		if (request.method === "GET" && url.pathname === "/demo/audit") {
			const denied = checkDemoKey(request, env);
			if (denied) return denied;
			const since = url.searchParams.get("since") ?? new Date(Date.now() - 86_400_000).toISOString();
			if (Number.isNaN(Date.parse(since))) {
				return json({ ok: false, error: "since must be a time." }, 400);
			}
			try {
				return json(sanitize({ ok: true, ...(await auditSince(env.DB, since)) }));
			} catch (error) {
				const failure = describeError(error);
				return json(sanitize({ ok: false, error: failure.message, code: failure.code }), 500);
			}
		}

		if (request.method === "POST" && url.pathname === "/demo/bypass") {
			const denied = checkDemoKey(request, env);
			if (denied) return denied;
			try {
				const pushed = await publishDirect(env.WORKSPACE);
				const refName = "refs/heads/main";
				const deadline = Date.now() + 45_000;
				let flagged = false;
				while (Date.now() < deadline) {
					flagged = await isUnseen(env.DB, pushed.name, refName, pushed.edition);
					if (flagged) break;
					await new Promise((resolve) => setTimeout(resolve, 2000));
				}
				return json(sanitize({ ok: flagged, name: pushed.name, edition: pushed.edition, ref: refName, flagged }));
			} catch (error) {
				const failure = describeError(error);
				return json(sanitize({ ok: false, error: failure.message, code: failure.code }), 500);
			}
		}

		if (request.method === "POST" && url.pathname === "/demo/seed") {
			const denied = checkDemoKey(request, env);
			if (denied) return denied;
			const body = (await request.json().catch(() => ({}))) as {
				personKey?: unknown;
				researcherKey?: unknown;
				proofreaderKey?: unknown;
			};
			const personKey = typeof body.personKey === "string" ? body.personKey : "";
			const researcherKey = typeof body.researcherKey === "string" ? body.researcherKey : "";
			const proofreaderKey = typeof body.proofreaderKey === "string" ? body.proofreaderKey : "";
			if (!personKey || !researcherKey || !proofreaderKey) {
				return json({ ok: false, error: "A person key and two agent keys are required." }, 400);
			}
			try {
				const report = await seedOpenSuggestions(env, url.origin, { personKey, researcherKey, proofreaderKey });
				return json(sanitize(report));
			} catch (error) {
				const failure = describeError(error);
				return json(sanitize({ ok: false, error: failure.message, code: failure.code }), 500);
			}
		}

		if (request.method === "POST" && url.pathname === "/demo/tracer") {
			const denied = checkDemoKey(request, env);
			if (denied) return denied;

			const body = (await request.json().catch(() => ({}))) as {
				actor?: unknown;
				session?: unknown;
				addEdition?: unknown;
			};
			const actor = typeof body.actor === "string" ? body.actor : "demo-agent";
			const session =
				typeof body.session === "string"
					? body.session
					: crypto.randomUUID().slice(0, 8);

			try {
				const result = await runTracer(env.WORKSPACE, {
					actor,
					session,
					addEdition: body.addEdition === true,
				});
				return json(sanitize({ ok: true, ...result }));
			} catch (error) {
				const failure = describeError(error);
				return json(sanitize({ ok: false, error: failure.message, code: failure.code }), 500);
			}
		}

		if (request.method === "POST" && url.pathname === "/demo/suggestions") {
			const denied = checkDemoKey(request, env);
			if (denied) return denied;

			const body = (await request.json().catch(() => ({}))) as {
				n?: unknown;
				key?: unknown;
				personKey?: unknown;
			};
			const n = body.n === undefined ? 25 : body.n;
			const key = typeof body.key === "string" ? body.key : "";
			const personKey = typeof body.personKey === "string" ? body.personKey : "";
			if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_SESSIONS) {
				return json(
					{ ok: false, error: `n must be a whole number from 1 to ${MAX_SESSIONS}.` },
					400,
				);
			}
			if (!key || !personKey) {
				return json({ ok: false, error: "An agent key and a person key are required." }, 400);
			}

			try {
				const agent = await actorByKey(env.DB, key);
				const person = await actorByKey(env.DB, personKey);
				if (!agent || agent.kind !== "agent") {
					return json({ ok: false, error: "Unknown agent key." }, 401);
				}
				if (!person || person.kind !== "person") {
					return json({ ok: false, error: "Unknown person key." }, 401);
				}
				if (agent.ownerId !== person.id) {
					return json({ ok: false, error: "That agent does not work for that person." }, 403);
				}
				if (agent.workspaceId !== person.workspaceId) {
					return json({ ok: false, error: "That agent does not work for that person." }, 403);
				}
				const open = await openSuggestionCount(env.DB, agent.workspaceId);
				if (open + n > limitsOf(env).openSuggestions) {
					return json({ ok: false, error: LIMIT_MESSAGE.openSuggestions }, 429);
				}
				const report = await runSwarm({
					workspace: env.WORKSPACE,
					launcher: workflowLauncher(env.SUGGESTIONS),
					arrivals: d1ArrivalLog(env.DB),
					audit: d1AuditLog(env.DB),
					gateway: {
						origin: url.origin,
						personKey,
						agentKey: key,
						actorName: agent.name,
						ownerName: person.name,
						model: agent.model ?? agent.id,
					},
					n,
					actor: agent.id,
					workspaceId: agent.workspaceId,
					runner: "workflow-instances",
				});
				return json(sanitize(report));
			} catch (error) {
				const failure = describeError(error);
				return json(sanitize({ ok: false, error: failure.message, code: failure.code }), 500);
			}
		}

		return json(
			{
				ok: false,
				error: "Not found. Try GET /health, GET /who, POST /demo/tracer, or POST /demo/suggestions.",
			},
			404,
		);
	},
} satisfies ExportedHandler<Env>;
