// Anything the Worker returns, or writes where a run log might copy it, has to
// be safe to publish. Artifacts remote URLs contain the account id, and write
// tokens must never leave the Worker.

const SECRET_KEYS = new Set([
	"remote",
	"token",
	"plaintext",
	"password",
	"authorization",
	"accountId",
	"account_id",
	"headers",
	"key",
	"personKey",
	"agentKey",
	"stylebookKey",
	"email",
]);

export interface Failure {
	attempt: number;
	code: string | null;
	message: string;
}

export function redact(value: string): string {
	return value
		.replace(/art_v1_[A-Za-z0-9._~-]+/g, "<token>")
		.replace(/\bsbk_[A-Za-z0-9_-]+/g, "<key>")
		.replace(/https?:\/\/[^\s"'<>]+/gi, "<url>")
		.replace(/\?expires=\d+/g, "")
		.slice(0, 400);
}

export function describeError(error: unknown, attempt = 1): Failure {
	let code: string | null = null;
	if (typeof error === "object" && error !== null) {
		const record = error as Record<string, unknown>;
		if (typeof record.code === "string" && record.code) code = record.code;
		else if (typeof record.code === "number") code = String(record.code);
		else if (typeof record.statusCode === "number") code = `HTTP_${record.statusCode}`;
		else if (typeof record.status === "number") code = `HTTP_${record.status}`;
		else if (error instanceof Error && error.name && error.name !== "Error") code = error.name;
	}
	let message = error instanceof Error ? error.message : String(error);
	if (typeof error === "object" && error !== null && "data" in error) {
		const data = (error as { data?: { response?: unknown } }).data;
		if (typeof data?.response === "string" && data.response) {
			message = `${message}: ${data.response.slice(0, 180)}`;
		}
	}
	return { attempt, code, message: redact(message) };
}

/** Drop secret keys and scrub every string. Used on the demo response. */
export function sanitize<T>(value: T): T {
	return walk(value) as T;
}

function walk(value: unknown): unknown {
	if (typeof value === "string") return redact(value);
	if (Array.isArray(value)) return value.map(walk);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			if (SECRET_KEYS.has(key)) continue;
			out[key] = walk(child);
		}
		return out;
	}
	return value;
}
