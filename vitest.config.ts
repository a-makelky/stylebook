import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		setupFiles: ["./test/setup.ts"],
		testTimeout: 120_000,
		hookTimeout: 120_000,
		server: {
			deps: {
				inline: ["@cloudflare/workers-oauth-provider"],
			},
		},
	},
	resolve: {
		alias: {
			"cloudflare:workers": new URL("./test/cloudflare-workers-stub.ts", import.meta.url).pathname,
		},
	},
});
