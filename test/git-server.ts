// A local Git server for tests: Node's http in front of `git http-backend`,
// the smart-HTTP server that ships with Git. It lets the real publish code
// run end to end without Cloudflare. It is not Artifacts, and passing here
// does not prove behavior on the live service.

import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type Scope = "read" | "write";

export interface GitServer {
	url: string;
	close(): Promise<void>;
}

/** Decide whether a request may proceed. `secret` is the Basic auth password. */
export type Authorize = (
	repo: string,
	needs: Scope,
	secret: string | null,
) => boolean;

/** Basic password or Bearer token. Artifacts tokens may carry `?expires=`. */
function presentedSecret(request: IncomingMessage): string | null {
	const header = request.headers.authorization;
	if (!header) return null;
	let raw: string | null = null;
	if (header.startsWith("Bearer ")) raw = header.slice(7).trim();
	else if (header.startsWith("Basic ")) {
		const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
		const separator = decoded.indexOf(":");
		raw = separator === -1 ? null : decoded.slice(separator + 1);
	}
	if (!raw) return null;
	return raw.split("?expires=")[0] || null;
}

export async function startGitServer(
	root: string,
	authorize: Authorize,
): Promise<GitServer> {
	const server: Server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		const repo = url.pathname.split("/")[1]?.replace(/\.git$/, "") ?? "";
		const isPush =
			url.pathname.endsWith("/git-receive-pack") ||
			url.searchParams.get("service") === "git-receive-pack";

		if (!authorize(repo, isPush ? "write" : "read", presentedSecret(request))) {
			response.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
			response.end("Unauthorized");
			return;
		}

		const backend = spawn("git", ["http-backend"], {
			env: {
				PATH: process.env.PATH ?? "",
				GIT_PROJECT_ROOT: root,
				GIT_HTTP_EXPORT_ALL: "1",
				REQUEST_METHOD: request.method ?? "GET",
				PATH_INFO: url.pathname,
				QUERY_STRING: url.search.slice(1),
				CONTENT_TYPE: request.headers["content-type"] ?? "",
				HTTP_CONTENT_ENCODING: String(request.headers["content-encoding"] ?? ""),
				GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
				REMOTE_USER: "test",
			},
		});

		request.pipe(backend.stdin);

		const chunks: Buffer[] = [];
		backend.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		backend.on("close", () => {
			const output = Buffer.concat(chunks);
			const split = output.indexOf("\r\n\r\n");
			if (split === -1) {
				response.writeHead(500);
				response.end("git http-backend returned no headers");
				return;
			}

			let status = 200;
			const headers: Record<string, string> = {};
			for (const line of output.subarray(0, split).toString("utf8").split("\r\n")) {
				const colon = line.indexOf(":");
				if (colon === -1) continue;
				const key = line.slice(0, colon).trim();
				const value = line.slice(colon + 1).trim();
				if (key.toLowerCase() === "status") {
					status = Number.parseInt(value, 10) || 200;
				} else {
					headers[key] = value;
				}
			}
			response.writeHead(status, headers);
			response.end(output.subarray(split + 4));
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}
