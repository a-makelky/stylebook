# 2026-10-03 — fresh clone, then Try the demo on stylebook.dev

A Cursor cloud agent followed the "Run it yourself" section of `README.md` as it stood at `3fe70ade81f9e58e418f301330a696aded8c35e5`, in a fresh clone. The Worker, database, KV namespace, Artifacts namespace, and workflow names were new. The `[[routes]]` block was removed before deploy. Nothing was deployed onto `stylebook.dev`. The trial was deleted afterwards. The hosted `DEMO_KEY` was not changed.

- Date: 2026-10-03, about 15:16–15:24 UTC.
- Wrangler 4.147.0. Node 22.14.0. Git 2.43.0.
- The trial hostname is written as `stylebook-fresh.<subdomain>.workers.dev`. Keys are `<demo-key>`, `<person-key>`, `<researcher-key>`, and `<proofreader-key>`. No account id is recorded.

## Commands

Each command is the one in the README, with the trial names filled in. Exit codes are the process status. HTTP lines are the status and the time.

| Step | Command | Result |
| --- | --- | --- |
| Install | `npm install` | exit 0 |
| Login check | `npx wrangler whoami` | exit 0. An Account API Token was already set. The account name and account id are omitted. `npx wrangler login` was not opened. |
| Database, hosted name | `npx wrangler d1 create stylebook` | exit 1. Wrangler printed `A database with that name already exists` and did not print an id. The hosted database was left as it was. |
| Database | `npx wrangler d1 create stylebook-fresh` | exit 0. Region ENAM. The snippet's binding name was taken from the database name. `binding` was left as `"DB"`. `database_name` and `database_id` were set to the new database. |
| KV, hosted title | `npx wrangler kv namespace create OAUTH_KV` | exit 1. Wrangler printed that a namespace titled `OAUTH_KV` already exists. The hosted namespace was left as it was. |
| KV | `npx wrangler kv namespace create stylebook-fresh-oauth` | exit 0. The snippet's binding name was taken from the title. `binding` was left as `"OAUTH_KV"`. The new id replaced the one in the file. |
| Migrations | `npx wrangler d1 migrations apply stylebook-fresh --remote` | exit 0. Wrangler asked `About to apply 14 migration(s)` and, with no prompt, printed `Using fallback value in non-interactive context: yes`. All 14 files ended ✅, including both `0011_backups.sql` and `0011_demo_copies.sql`. |
| Deploy | `npx wrangler deploy` | exit 0, after the names above were changed and the `[[routes]]` block was removed. Version `8e189057-258d-482a-b6ba-790c10f244a4`. No reassignment warning. Host `stylebook-fresh.<subdomain>.workers.dev` only. Schedule `17 * * * *`. Workflows `stylebook-fresh-suggestion` and `stylebook-fresh-arrival`. `event triggers: 1`. Namespace `stylebook-fresh`. No custom domain. |
| Secret | `npx wrangler secret put DEMO_KEY --name stylebook-fresh` | exit 0. The string was passed on stdin. Wrangler printed `Success! Uploaded secret DEMO_KEY`. The value is not recorded. This was the trial Worker only. |
| Health | `GET $HOST/health` | HTTP 200. `{"ok":true,"name":"stylebook"}`. |
| Seed | `POST $HOST/demo/seed` | HTTP 200 in 93.6 seconds. `created` had 11 names. `alreadyThere` was empty. |
| Try the demo | `POST $HOST/try`, then `GET $HOST/` with the session | POST 303 to `/` in 4.041 seconds. GET 200 in 0.134 seconds, 36521 bytes. The page included Editor, Publish, and "Ask an agent to combine them." |
| Landing | `GET $HOST/` with no session | HTTP 200. The page included Try the demo. |

`GET https://stylebook.dev/health` returned 200 before the trial was deleted and again after. A workflow list during the trial showed `stylebook-suggestion` and `stylebook-arrival` still on script `stylebook`, and the two trial workflows on script `stylebook-fresh`.

The seed created `demo-library` and eleven `demo-sug-…` repos. Try the demo then created one copy of that set, twelve repos, in the same namespace. Twenty-four repos in all.

## What the README already said, and what matched

`npx wrangler whoami` showed the token login, and the browser login was skipped. The README says that.

`d1 create` prints a binding name taken from the database name. `binding` stayed `"DB"`. The README says that.

Migrations ask before they apply, and a session with no prompt continues. This run printed the fallback `yes`. The README says that. The sentence sat after the namespace paragraph, so it was not obvious which command asks. It now sits under the migrations command.

Renaming the three workflow lines before deploy avoided the reassignment warning. The README says to rename them first when the names are taken.

Deleting the `[[routes]]` block is what the custom-domain page tells someone to do when the domain is not in the account. The deploy then printed only the workers.dev host. See [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

The namespace did not exist before the seed. It was there once the library and the copies existed. See [Namespaces](https://developers.cloudflare.com/artifacts/concepts/namespaces/).

`wrangler secret put` accepts the string on stdin. The README says that.

## Gaps

These are the places the README, as followed, did not say what this run had to do. Each one is now in the Run it section.

1. `npx wrangler kv namespace create OAUTH_KV` fails when that title already exists. Wrangler says to choose a different name. The second copy used the title `stylebook-fresh-oauth` and left `binding = "OAUTH_KV"`. The snippet used the title as the binding name. The second-copy sentence did not mention KV. Keeping the id already in the file would share the hosted namespace.
2. The second-copy sentence said to change the Worker name, the database name and id, both namespace lines, and the three workflow lines. It did not say to delete `[[routes]]`. The routes paragraph said to delete that block when the domain is not in the account. This account already serves `stylebook.dev` from the Worker `stylebook`. The block was removed before deploy, so this run did not observe what a deploy with the block still in place would do. The custom-domain page says a custom domain cannot be created on a hostname that already has a CNAME, or on a zone you do not own: [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).
3. `npx wrangler d1 create stylebook` exits 1 with `A database with that name already exists` and does not print an id. The README already says the database exists in that case and to read the id with `d1 info`. A second copy has to create a different name. Pointing `database_id` at the hosted database would share it. The second-copy sentence now says not to do that.
4. The seed took 93.6 seconds. The README said about a minute. It now says more than a minute.
5. The README said to open the host and sign in with `editor@stylebook.invalid`. That address is not a mailbox. With `SIGN_IN` set to `access`, `POST /sign-in` returns 404 and the page does not send a link. See [2026-10-03-access-roles.md](2026-10-03-access-roles.md). Try the demo is what opens a copy, and this run did that. The person key is what opens the seeded Demo workspace: the screen treats the `stylebook` cookie as that key (`src/auth.ts`). The README now says so.

## Deletions

Only the trial was removed. `stylebook`, `stylebook-review`, and `stylebook-demo` were still in the namespace list afterwards. The live Worker, its database, its KV namespace, and its two workflows were not deleted. After the deletions, `stylebook-suggestion` and `stylebook-arrival` were still listed on script `stylebook`, and `GET https://stylebook.dev/health` returned 200.

| What | Command | Result |
| --- | --- | --- |
| Twenty-four repos | `npx wrangler artifacts repos delete <name> --namespace stylebook-fresh --force` | exit 0 each. A list of that namespace afterwards was empty. |
| Namespace | `DELETE /accounts/<account-id>/artifacts/namespaces/stylebook-fresh` | HTTP 204, empty body. Sent only after the repos were gone. A namespace list afterwards did not include `stylebook-fresh`. |
| Worker | `npx wrangler delete stylebook-fresh --force` | exit 0. Wrangler printed `Successfully deleted`. `GET` of the trial `/health` then returned 404, and the body was `error code: 1042`. |
| Trial workflows | `npx wrangler workflows delete stylebook-fresh-suggestion` and the same for `stylebook-fresh-arrival` | exit 0. Wrangler printed that each was removed. The live pair was not. |
| Database | `npx wrangler d1 delete stylebook-fresh --skip-confirmation` | exit 0. `npx wrangler d1 info stylebook-fresh` then failed with code 7404, could not be found. That error line also prints the account id, so it is not copied here. |
| KV namespace | `npx wrangler kv namespace delete --namespace-id <id> --skip-confirmation` | exit 0. Wrangler printed that the namespace was deleted. The hosted namespace was not. |

Wrangler can list and get a namespace, and it can delete a repo. It has no namespace delete. The changelog of that support does not list one:

https://developers.cloudflare.com/changelog/post/2026-05-18-wrangler-support/

The REST page documents creating, listing, and reading a namespace, and deleting a repo. It does not document deleting a namespace:

https://developers.cloudflare.com/artifacts/api/rest-api/

The 204 above is what this account returned, after the repos were gone. It is not a documented route.

The 404 body `error code: 1042` is what curl received. The errors page defines 1042 as a Worker fetching another Worker on the same zone:

https://developers.cloudflare.com/workers/observability/errors/

This request was not a Worker fetch, so that definition does not describe it. The status was 404.

## Try the demo on stylebook.dev

Five signed-out `POST /try` calls, then `GET /` with that session. User agent `stylebook-live-run`. Each POST was 303 to `/`. Each page was 200 and included Editor, Publish, and "Ask an agent to combine them." The five copies were separate pages of about 36520 bytes.

| Visit | Copy (`POST /try`) | Then the page | Together |
| --- | --- | --- | --- |
| 1 | 4309 ms | 212 ms | 4522 ms |
| 2 | 4443 ms | 140 ms | 4584 ms |
| 3 | 3517 ms | 138 ms | 3655 ms |
| 4 | 4035 ms | 131 ms | 4166 ms |
| 5 | 3895 ms | 174 ms | 4068 ms |

All five were under five seconds together. The time is in making the copy. The page after that was under a quarter of a second. Before these five, the day's copy count was 18. The cap is 80 (`MAX_DEMO_COPIES_PER_DAY`). One connecting address is capped at 8. These five copies stay until the hourly job deletes them. The schedule on the hosted Worker is `17 * * * *`. See [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

## 25 agents and 100 agents

Those calls were not made on stylebook.dev. `POST /demo/suggestions` requires the hosted `DEMO_KEY`. That secret is already set. It cannot be read back, and it was not replaced. `wrangler secret list` on the Worker `stylebook` still names `DEMO_KEY` and does not return the value.

The last measurement of this route is [2026-10-02-tracer-2.md](2026-10-02-tracer-2.md): 25 forks in a 3.9 s window, and 100 sessions in 16.9 s, on the namespace bound that day. This pass does not replace those numbers.
