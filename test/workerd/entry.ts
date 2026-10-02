// A minimal Worker used only by test/workerd.test.ts. It runs the real
// publish code inside the Workers runtime (workerd) so the test can confirm
// that isomorphic-git and the in-memory file system work there, not just in Node.

import { publishFile, type PublishInput } from "../../src/git";

export default {
	async fetch(request: Request): Promise<Response> {
		try {
			const input = (await request.json()) as PublishInput;
			const edition = await publishFile(input);
			return Response.json({ ok: true, edition });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return Response.json({ ok: false, error: message }, { status: 500 });
		}
	},
};
