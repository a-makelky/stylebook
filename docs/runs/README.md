# Run logs

One file per live run, named `YYYY-MM-DD-<what>.md`. A run log is the evidence that a piece of Stylebook works against the real Artifacts service.

| Run | What it shows |
| --- | --- |
| [2026-10-02-tracer-1.md](2026-10-02-tracer-1.md) | Library, suggestion copy, and read-back on the live service. |
| [2026-10-02-tracer-2.md](2026-10-02-tracer-2.md) | 25 agents, then 100, suggesting at the same time on the live service. Each push was recorded when it arrived. |
| [2026-10-02-tracer-3.md](2026-10-02-tracer-3.md) | Who saved each edition, and why, on the live service. A forged name did not change the actor. A save that skipped Stylebook was flagged. |
| [2026-10-02-tracer-4.md](2026-10-02-tracer-4.md) | The review screen on the live service: compare, flag an overlap, publish, and keep both sides of a race. |
| [2026-10-02-tracer-5.md](2026-10-02-tracer-5.md) | One workspace, a plain Git clone, two MCP clients, and a fresh-clone walkthrough of the run instructions. |
| [2026-10-02-live-library.md](2026-10-02-live-library.md) | The live library on stylebook.dev after the line-level review fixes, including the overlapping pair, the combined page, and History. |
| [2026-10-02-readme-first-run.md](2026-10-02-readme-first-run.md) | The run instructions followed on an empty setup, the gaps that turned up, and the deletion of that trial. |
| [2026-10-02-teams.md](2026-10-02-teams.md) | Workspaces, email sign-in, invites, and connecting an agent on the live service. |
| [2026-10-02-review-fixes.md](2026-10-02-review-fixes.md) | Confirm page, owner and member on People and agents, and the signed-in header on the live service. |
| [2026-10-03-access-roles.md](2026-10-03-access-roles.md) | Cloudflare Access sign-in, Admin and Member, the People page, and deleting a workspace's copies. |
| [2026-10-03-tracer-8-review.md](2026-10-03-tracer-8-review.md) | Suspension on suggestion writes, cross-site posts, the admin page, a second workspace, and the People page. |
| [2026-10-03-connect-tools.md](2026-10-03-connect-tools.md) | Sign-in from a tool on stylebook.dev: one address, approve, a credited suggestion, and Revoke. |
| [2026-10-03-front-door.md](2026-10-03-front-door.md) | The landing page, Try the demo, a first-run welcome, and the consent heading on stylebook.dev. |
| [2026-10-03-backups.md](2026-10-03-backups.md) | Download, backup, and restore on stylebook.dev, including the review checks against a local stand-in. |
| [2026-10-03-fresh-clone.md](2026-10-03-fresh-clone.md) | The run instructions followed from a fresh clone, the trial deleted afterwards, and Try the demo timed on stylebook.dev. |

## What a run log contains

- Date, and who or what ran it.
- The commit of this repo that was deployed.
- The exact request sent and the full response, with secrets removed.
- What was checked by hand afterwards, and how.
- Anything the live service did that the docs do not describe.
- Failures and retries, with the error codes returned.

## Before committing

Remove the demo key, every token, and the Cloudflare account ID. Artifacts remote URLs contain the account ID, so cut them or replace the ID with `<account-id>`.

## Open questions for the first live run

Answered by [2026-10-02-tracer-1.md](2026-10-02-tracer-1.md). The public binding docs do not specify these. The generated `worker-configuration.d.ts` and the live service do.

- `get()` did not report `FORK_IN_PROGRESS` after `fork()` returned. The first `get()` succeeded, in 48 ms and 50 ms, with no retry.
- `info().source` on both copies was `artifacts:stylebook-demo/library`.
- A copy made with `defaultBranchOnly: true` carried both editions on `main`, with the same edition ids as the library.
