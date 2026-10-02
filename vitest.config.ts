import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
	resolve: {
		alias: {
			"cloudflare:workers": new URL("./test/cloudflare-workers-stub.ts", import.meta.url).pathname,
		},
	},
});
