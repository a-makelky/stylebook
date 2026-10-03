// Git HTTP for a backup. isomorphic-git reads http.corsProxy from the repo
// when `corsProxy` is omitted, and only `undefined` means "read the config".
// null skips that. The docs describe corsProxy as overriding the repo config:
// https://isomorphic-git.org/docs/en/push
// Fetch does not follow a redirect. A 3xx is returned as itself.

import http from "isomorphic-git/http/web";

/** Runtime null. The type is a string so it matches isomorphic-git's option. */
export const NO_CORS_PROXY = null as unknown as string;

type GitRequest = Parameters<typeof http.request>[0];

export const backupHttp = {
	request(args: GitRequest) {
		return http.request({
			...args,
			fetchOptions: { ...(args.fetchOptions ?? {}), redirect: "manual" },
		});
	},
};
