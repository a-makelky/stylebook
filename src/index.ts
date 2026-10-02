import { runTracer } from "./tracer";

export interface Env {
	WORKSPACE: Artifacts;
	/** Secret. Callers of the demo routes send it as a bearer token. */
	DEMO_KEY?: string;
}

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
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/health") {
			return json({ ok: true, name: "stylebook" });
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
				return json({ ok: true, ...result });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code: unknown }).code)
						: null;
				return json({ ok: false, error: message, code }, 500);
			}
		}

		return json(
			{ ok: false, error: "Not found. Try GET /health or POST /demo/tracer." },
			404,
		);
	},
} satisfies ExportedHandler<Env>;
