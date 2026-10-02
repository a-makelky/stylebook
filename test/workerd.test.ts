// Runs the publish code inside the local Workers runtime (workerd, started by
// `wrangler dev`) against the local Git server. This catches runtime problems
// that Node hides. It still is not the live Artifacts service.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeWorkspace } from "./fake-artifacts";

const AUTHOR = { name: "Workerd test", email: "test@example.invalid" };

let workspace: FakeWorkspace;
let wrangler: ChildProcess;
let base: string;

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = typeof address === "object" && address ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

async function publish(body: Record<string, unknown>) {
	const response = await fetch(base, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return (await response.json()) as { ok: boolean; edition?: string; error?: string };
}

beforeAll(async () => {
	workspace = await FakeWorkspace.start();
	const port = await freePort();
	base = `http://127.0.0.1:${port}/`;

	wrangler = spawn(
		"npx",
		[
			"wrangler",
			"dev",
			"-c",
			"test/workerd/wrangler.toml",
			"--port",
			String(port),
			"--ip",
			"127.0.0.1",
		],
		{ stdio: "ignore", detached: true },
	);

	const deadline = Date.now() + 60_000;
	for (;;) {
		try {
			await fetch(base, { method: "POST", body: "{}" });
			break;
		} catch {
			if (Date.now() > deadline) throw new Error("wrangler dev did not start");
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}
}, 90_000);

afterAll(async () => {
	if (wrangler?.pid) {
		const exited = new Promise((resolve) => wrangler.once("exit", resolve));
		try {
			process.kill(-wrangler.pid, "SIGTERM");
		} catch {
			// Already gone.
		}
		// Give the runtime a moment to shut down so nothing is left running.
		await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
	}
	await workspace?.stop();
});

describe("publishing inside the Workers runtime", () => {
	it("publishes a first edition and then a second on top of it", async () => {
		const created = await workspace.binding.create("workerd-library", {
			setDefaultBranch: "main",
		});

		const first = await publish({
			remote: created.remote,
			token: created.token,
			path: "skills/example/SKILL.md",
			content: "first\n",
			message: "First edition",
			author: AUTHOR,
			hasHistory: false,
		});
		expect(first).toMatchObject({ ok: true });
		expect(workspace.git("workerd-library", "show", "main:skills/example/SKILL.md")).toBe(
			"first\n",
		);
		expect(workspace.git("workerd-library", "rev-parse", "main").trim()).toBe(first.edition);

		const repo = await workspace.binding.get("workerd-library");
		const token = await repo.createToken("write", 60);
		const second = await publish({
			remote: created.remote,
			token: token.plaintext,
			path: "skills/example/SKILL.md",
			content: "second\n",
			message: "Second edition",
			author: AUTHOR,
			hasHistory: true,
		});
		expect(second).toMatchObject({ ok: true });
		expect(workspace.git("workerd-library", "show", "main:skills/example/SKILL.md")).toBe(
			"second\n",
		);
		expect(workspace.git("workerd-library", "rev-list", "--count", "main").trim()).toBe("2");
		expect(workspace.git("workerd-library", "log", "-1", "--format=%an <%ae>").trim()).toBe(
			"Workerd test <test@example.invalid>",
		);
	}, 60_000);

	it("reports a refused publish instead of claiming success", async () => {
		const refused = await publish({
			remote: workspace.remote("workerd-library"),
			token: "art_v1_notavalidtoken?expires=1",
			path: "skills/example/SKILL.md",
			content: "should never land\n",
			message: "Should be refused",
			author: AUTHOR,
			hasHistory: true,
		});
		expect(refused.ok).toBe(false);
		expect(workspace.git("workerd-library", "rev-list", "--count", "main").trim()).toBe("2");
	}, 60_000);
});
