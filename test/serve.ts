// Speaks HTTP in front of the Worker, so stock Git can call the Git route
// during tests. The upstream is still the local Git server, not Artifacts.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Env } from "../src/env";
import worker from "../src/index";

export async function serveWorker(env: Env): Promise<{ url: string; close(): Promise<void> }> {
	let port = 0;
	const server = createServer((request, response) => {
		void forward(request, response, env, port).catch((error: unknown) => {
			response.writeHead(500, { "Content-Type": "text/plain" });
			response.end(error instanceof Error ? error.message : "error");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}

async function forward(request: IncomingMessage, response: ServerResponse, env: Env, port: number) {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	const body = Buffer.concat(chunks);
	const headers = new Headers();
	for (const [key, value] of Object.entries(request.headers)) {
		if (value === undefined) continue;
		if (key === "host" || key === "connection" || key === "content-length" || key === "transfer-encoding") {
			continue;
		}
		if (Array.isArray(value)) {
			for (const item of value) headers.append(key, item);
		} else {
			headers.set(key, value);
		}
	}
	const method = request.method ?? "GET";
	const incoming = new Request(`http://127.0.0.1:${port}${request.url ?? "/"}`, {
		method,
		headers,
		body: method === "GET" || method === "HEAD" ? undefined : body,
	});
	const pending: Promise<unknown>[] = [];
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			pending.push(promise);
		},
		passThroughOnException() {},
		props: {},
	} as ExecutionContext;
	const outgoing = await worker.fetch(incoming, env, ctx);
	await Promise.allSettled(pending);
	const bytes = Buffer.from(await outgoing.arrayBuffer());
	const outHeaders: Record<string, string | string[]> = {};
	const cookies = outgoing.headers.getSetCookie?.() ?? [];
	outgoing.headers.forEach((value, key) => {
		if (key === "content-length" || key === "transfer-encoding" || key === "set-cookie") return;
		outHeaders[key] = value;
	});
	if (cookies.length > 0) outHeaders["set-cookie"] = cookies;
	response.writeHead(outgoing.status, outHeaders);
	response.end(bytes);
}
