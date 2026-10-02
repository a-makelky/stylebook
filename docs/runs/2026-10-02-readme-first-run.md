# 2026-10-02 — run instructions on an empty setup

A Cursor cloud agent followed `README.md` as it stood at `513cb0b8b4c2bacca23d8b574d68e4f94a2ef0d8`, in a fresh clone, with nothing pre-created. The database, the workspace, and the Worker were new. The `[[routes]]` block was removed, as the README tells someone without the domain to do.

The trial names were `stylebook-trial` for the Worker, the D1 database, and the Artifacts namespace. That trial is deleted. The record of the deletion is at the end. Nothing else in the account was removed.

- Date: 2026-10-02.
- Wrangler 4.147.0. Node 22.14.0. Git 2.43.0.
- The trial hostname is written as `stylebook-trial.<subdomain>.workers.dev`. Keys are `<demo-key>`, `<person-key>`, and `<agent-key>`. The read credential is `<token>`. No account id is recorded.

## Commands

Each command is the one in the README, with the trial names filled in. Exit codes are the process status. HTTP lines are the status, the size, and the time.

| Step | Command | Result |
| --- | --- | --- |
| Install | `npm install` | exit 0 |
| Login check | `npx wrangler whoami` | exit 0. An Account API Token was already set as `CLOUDFLARE_API_TOKEN`. The account name and account id are omitted. `npx wrangler login` was not opened. |
| Database | `npx wrangler d1 create stylebook-trial` | exit 0. Wrangler printed a snippet whose binding name was taken from the database name. `binding` was left as `"DB"`. `database_name` and `database_id` were set to the new database. |
| Migrations | `npx wrangler d1 migrations apply stylebook-trial --remote` | exit 0. Applied migrations 0001 through 0004. The command asks before it applies. This session has no prompt, and the command continued. |
| First deploy | `npx wrangler deploy` | exit 0, and it took workflow names that already belonged to the live Worker. Version `ba877a71-a650-48c5-9250-5e31444d4b7d`. Recorded under Gaps. The names were put back before anything else ran. |
| Second deploy | `npx wrangler deploy` | exit 0, after the three workflow lines were renamed. Version `2cd520d0-fb44-4fe4-8c55-289d0460c042`. No reassignment warning. Host `stylebook-trial.<subdomain>.workers.dev` only. Namespace `stylebook-trial`. No custom domain. |
| Secret | `npx wrangler secret put DEMO_KEY` | exit 0. The string was passed on stdin. Wrangler printed `Success! Uploaded secret DEMO_KEY`. The value is not recorded. |
| Seed | `POST $HOST/demo/seed` | HTTP 200 in 58.310 seconds. `created` listed the eleven seed names. `alreadyThere` was empty. |
| Sign in | `POST $HOST/sign-in` | HTTP 303 in 0.096 seconds. `Location: /`. The cookie was `HttpOnly`, `Secure`, and `SameSite=Strict`. |
| Open the page | `GET $HOST/?item=skills/interview-to-draft/SKILL.md` | HTTP 200, 29324 bytes, 1.189 seconds. The page included Editor and the overlap sentence. It was not the sign-in form. |
| Read credential | `POST $HOST/git/access` with `{"name":"library","write":false}` | HTTP 200. `ok` true, `username` `stylebook`, `expiresIn` 600, `write` false. `remote` was `https://stylebook-trial.<subdomain>.workers.dev/git/library.git`. |
| Clone | `git clone` of that remote | exit 0. Eight files, listed below. |
| MCP initialize | `POST $HOST/mcp`, as the README shows | HTTP 200. Server `stylebook` 0.1.0, protocol `2025-03-26`. |
| MCP read | `tools/call` `read_item` of `skills/interview-to-draft/SKILL.md` | HTTP 200. The body starts with the front matter `name: interview-to-draft`. About 1100 bytes. |

The clone contained:

```
connections/servers.json
skills/contract-summary/SKILL.md
skills/interview-to-draft/SKILL.md
skills/pitch-deck-outline/SKILL.md
skills/research-brief/SKILL.md
skills/transcript-clean-up/SKILL.md
workflows/feature-article.md
workflows/new-client-kickoff.md
```

The seed response named these copies, and no others:

`sug-researcher-names`, `sug-proofreader-style`, `sug-researcher-sources`, `sug-proofreader-dates`, `sug-researcher-pauses`, `sug-proofreader-unclear`, `sug-researcher-handoff`, `sug-proofreader-ask`, `sug-researcher-clauses`, `sug-proofreader-twice`, `sug-researcher-brief`.

## What the README already said, and what matched

Deleting the `[[routes]]` block is what the custom-domain page tells someone to do when the domain is not in the account. The deploy then printed only the workers.dev host:

https://developers.cloudflare.com/workers/configuration/routing/custom-domains/

The seed took 58 seconds. The README says about a minute.

The Git and MCP examples worked once `$HOST` was the trial host. `remote` was this Worker, not an Artifacts address, which is what the README says.

A namespace that does not exist yet is created when the first copy is created. The trial namespace appeared with that seed. See [Namespaces](https://developers.cloudflare.com/artifacts/concepts/namespaces/).

## Gaps

These are the places the README, as followed, did not say what this run had to do. Each one is now in the Run it section.

1. `npx wrangler whoami` is how you see that you are logged in. When `CLOUDFLARE_API_TOKEN` is set, Wrangler reads it and the browser login can be skipped. The README only said `npx wrangler login`.
2. `d1 create` prints a binding name taken from the database name. Replacing `binding = "DB"` with that name would leave the Worker pointing at a binding it does not read. Only `database_id` is replaced. When the database is not named `stylebook`, `database_name` changes too, and the migrations command uses that name.
3. `d1 migrations apply` asks before it applies. A session with no prompt continues. The README did not say that it asks.
4. The workspace name is set in two places that have to match: `namespace` under `[[artifacts]]`, and `namespace` under `[triggers.events.filter]`. The README named `stylebook-review` once. Changing one line and not the other would subscribe the arrival workflow to a different workspace.
5. `name` at the top of `wrangler.toml` is the Worker, and a deploy updates the Worker of that name. The two `name` values under `[[workflows]]`, and `workflow_name` under the trigger, have to be unique in the account. The first trial deploy left those three lines as `stylebook-suggestion`, `stylebook-arrival`, and `stylebook-arrival`. Wrangler warned that the names belonged to the Worker `stylebook`, and the deploy reassigned them to `stylebook-trial`. The live Worker was uploaded again from the same tree stylebook.dev already served (`f156614e0b9a3c8a1cf353fa14b70bece4ac9c75`). That upload is version `927cfe40-28aa-4fa2-8e8a-53d5e18ec04e`. Both names reported script name `stylebook` afterwards, and `GET https://stylebook.dev/health` returned 200. The trial's three lines were then renamed to `stylebook-trial-suggestion`, `stylebook-trial-arrival`, and `stylebook-trial-arrival`, and the second deploy did not warn.
6. `wrangler secret put` asks for the string. A session with no prompt can pass it on stdin. The README only said to type it when asked.

## Deletions

Only the trial was removed. `stylebook-review`, `stylebook-demo`, and `skills-dev` were still in the namespace list afterwards. The live Worker, its database, and its two workflows were not deleted. After the deletions, `stylebook-suggestion` and `stylebook-arrival` still reported script name `stylebook`, and `GET https://stylebook.dev/health` returned 200.

| What | Command | Result |
| --- | --- | --- |
| Twelve copies | `npx wrangler artifacts repos delete <name> --namespace stylebook-trial --force` for `library` and the eleven seed names | exit 0 each. A list of that namespace afterwards was empty. |
| Namespace | `DELETE /accounts/<account-id>/artifacts/namespaces/stylebook-trial` | HTTP 204, empty body. Sent only after the copies were gone. |
| Worker | `npx wrangler delete stylebook-trial --force` | exit 0. Wrangler printed `Successfully deleted`. `GET` of the trial `/health` then returned 404. |
| Trial workflows | `npx wrangler workflows delete stylebook-trial-suggestion` and the same for `stylebook-trial-arrival` | exit 0. After the Worker was deleted those two still existed with the script marked deleted. They were removed. The live pair was not. |
| Database | `npx wrangler d1 delete stylebook-trial --skip-confirmation` | exit 0. `npx wrangler d1 info stylebook-trial` then exited 1 with code 7404, could not be found. That error line also prints the account id, so it is not copied here. |

Wrangler can list and get a namespace, and it can delete a repo. The changelog of that support does not list a namespace delete:

https://developers.cloudflare.com/changelog/post/2026-05-18-wrangler-support/

The REST page documents creating, listing, and reading a namespace, and deleting a repo. It does not document deleting a namespace:

https://developers.cloudflare.com/artifacts/api/rest-api/

The 204 above is what this account returned, after the repos were gone. It is not a documented route.
