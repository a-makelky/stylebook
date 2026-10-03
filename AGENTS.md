# AGENTS.md

Stylebook is a shared, versioned library for a team's AI tooling, built on Cloudflare Workers and Artifacts. Its users are writers, researchers and publishers, not developers. Read `README.md` first.

## Rules

1. **Cite the docs.** Every claim about what Artifacts can do needs a link to the current Cloudflare docs. If the docs and the generated `worker-configuration.d.ts` disagree, the generated types win; say so. Do not invent features. Where the docs are silent, say what you observed and how.
2. **Evidence before "done".** A piece of work is done when it has run against live Artifacts and a run log is committed under `docs/runs/`. Code that only typechecks or only passes local tests is not done. If you are blocked, say exactly what is missing.
3. **No secrets.** No API tokens, repo tokens, or demo keys in the repo, in run logs, in commit messages, or in responses the Worker returns.
4. **Nothing personal.** This repo is public. No personal email addresses, account IDs, private links, or paths from anyone's machine. Artifacts remote URLs contain the account ID, so do not log or return them.
5. **Real forks.** A suggestion copy is made with `fork()` in the same namespace as its library. Do not replace it with clone-and-push; that loses the recorded source and the fork event.
6. **Ask before adding cost.** Nothing that bills per use beyond the Workers Paid plan without the owner's say-so.

## Words

On screen, and in anything a user reads, use: Workspace, Library, Suggestion, Edition, Publish, History, Copy, Locked, Combine.

Never on screen: git, repo, branch, commit, push, pull, merge, fork, PR, squash, rebase, clone, token.

Code, comments and this file may use the Git words. Users never see them.

| On screen | Underneath |
| --- | --- |
| Workspace | A team prefix on every repo in one Artifacts namespace. The binding cannot pick a namespace at runtime. See the [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/). |
| Library | Repo named `{workspace}-library` |
| Suggestion | Fork of the library, one per actor per session: `{workspace}-sug-{actor}-{session}` |
| Edition | Commit on `main` |
| Publish | Combine a suggestion into the library and push |

## Layout

- `src/index.ts` — routes and the demo-key check
- `src/oauth.ts` — sign-in from a tool, on `/mcp`
- `src/connect.ts` — the Connect page
- `src/catalog.ts` — skills, workflows, and team connections read from the library
- `src/zip.ts` — stored zip for a skill folder, a download, and a restore
- `src/workspace.ts` — library and suggestion copies over the Artifacts binding
- `src/teams.ts` — workspaces, sessions, invites, and agent keys
- `src/mail.ts` — one-time sign-in links, kept and switched off
- `src/identity.ts` — who is signing in; Cloudflare Access today
- `src/permit.ts` — the one permission check
- `src/roles.ts` — roles, invitations, locked pages, and the check's inputs
- `src/admin.ts` — the service-admin page
- `src/limits.ts` — starting limits
- `src/usage.ts` — per-workspace operation counts
- `src/git.ts` — writing an edition with isomorphic-git
- `src/memory-fs.ts` — in-memory file system isomorphic-git runs on
- `src/actors.ts` — people, agents, and hashed keys
- `src/gateway.ts` — the Git route that forwards smart HTTP to Artifacts
- `src/notes.ts` — the note stored on an agent-saved edition
- `src/who.ts` — who saved an edition, and the note
- `src/audit.ts` — gateway rows, and the push event that confirms or flags them
- `src/tracer.ts` — the first end-to-end path: library, copy, read back
- `src/edits.ts` — scripted changes the concurrent sessions apply
- `src/session.ts` — one suggestion session
- `src/swarm.ts` — start many sessions at once and collect what came back
- `src/workflows.ts` — the session Workflow, and the Workflow that records a push
- `src/arrivals.ts` — the push event turned into one arrival row
- `src/backup.ts` — download a workspace and start a new one from that download
- `src/backups-page.ts` — the Backups page
- `src/mirror.ts` — send a library to a backup, only to the stylebook ref
- `src/backup-store.ts` — audit rows and the saved backup link
- `src/backup-crypto.ts` — encrypt a backup secret with a Worker secret
- `src/github-app.ts` — GitHub App install, short-lived tokens, private repositories
- `src/git-http.ts` — Git HTTP that does not follow a redirect or a proxy
- `src/backup-git.ts` — which backup files a restore keeps, and the inflate budget
- `test/` — local tests, a local Git server, and a stand-in for the binding
- `docs/runs/` — run logs from live runs

## Commands

```sh
npm install
npm run typecheck
npm test
```

Run both before opening a pull request. Work on a branch and open a pull request; do not push to `main`.
