# 2026-10-03 — The front door

A Cursor cloud agent ran this against https://stylebook.dev.

- Date: 2026-10-03, about 10:01 UTC through 10:19 UTC.
- Worker name: `stylebook`. Version `6cc740f8-d93c-4c8f-894f-76c999199f78`. Wrangler 4.147.0.
- Code that was deployed: `9c3c13b3213640b85db4b07abb9133bde82440c9`. The deploy ran from that tree. This log and the pictures were added after.
- The demo secret was not changed. No address, account id, team host, or workers.dev hostname is recorded here.

## What was deployed

`npx wrangler d1 migrations apply stylebook --remote` applied `0011_demo_copies.sql` (the demo-copy table, and the welcome flag) and `0012_demo_paint.sql` (the first page saved for the visitor's next request). Both reported success.

`npx wrangler deploy` published the Worker. The deploy listed `schedule: 17 * * * *` and left the existing push trigger in place. Cron Triggers run in UTC. See [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) and the [scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/).

A copy is made with `fork()` in the same namespace, which is what records where it came from. See the [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/). The visitor's calls are counted in the same usage table. See [Artifacts pricing](https://developers.cloudflare.com/artifacts/platform/pricing/).

## The first page

Signed out, `GET /` returned 200. The page says what Stylebook is, shows the Interview to draft skill with one blue-pencil suggestion (Researcher, for Editor, "Keep every name tied to the transcript."), and offers Start a workspace, Try the demo, and a quiet Sign in link to `/enter`. The only "open source" and the only link to the repository are in the footer.

## Try the demo

`POST /try` with no email returned 303 to `/`, with a session cookie. Three visitors, one after another, once the shared Demo workspace was already there:

| Visit | Copy | Then the page | Together |
| --- | --- | --- | --- |
| 1 | 3809 ms | 140 ms | 3949 ms |
| 2 | 3150 ms | 59 ms | 3209 ms |
| 3 | 2844 ms | 66 ms | 2910 ms |

Each page was 200 and showed suggestions, Publish, and "Ask an agent to combine them." The three copies had different names. A copy's usage row recorded 12 forks plus gets and reads.

The other seeded suggestions are copied after the response. Five seconds later, Research brief on that copy showed 2 suggestions.

The daily cap is 80, in `MAX_DEMO_COPIES_PER_DAY`. It was not used up on the live host. The test sets the cap to the copies already made and the next try returns 429 with "The demo is full for today. Start a workspace, or come back tomorrow."

The same test publishes in one copy and checks that the shared Demo library and the other copy are unchanged. The live pages showed Publish, so the visitor is signed in as Editor, an Admin. The test checks that role directly.

## Deletion

One copy's expiry was set to `2000-01-01T00:00:00.000Z`. At 10:17:07 UTC the row was still there. At 10:17:55 UTC it was gone. That is the hourly job. The handler removes the repos and then the row, and it is awaited so a failure is retried.

## Welcome, empty list, consent

On one live copy the welcome flag was turned on. The page showed "Start here", with Read a skill, Invite someone, and Connect an agent, above the suggestions.

A brand-new workspace, with no suggestions yet, needs an email sign-in, and the consent page needs a tool to start the connection. Those two pictures are this commit's server, the same markup that was deployed. The new workspace shows "Start here" and "No suggestions yet. A suggestion arrives when a person or an agent proposes a change." The consent heading is "Connect Claude to North?" and the first line under it is "This returns you to 127.0.0.1".

## Accessibility

Lighthouse 12.8.2, mobile, accessibility only, on https://stylebook.dev/. Score **100**.

## Pictures

Wide is 1440 pixels. Phone is 390.

Landing, live:

![Landing, wide](2026-10-03-front-landing-wide.png)

![Landing, phone](2026-10-03-front-landing-phone.png)

Demo, live, with suggestions:

![Demo, wide](2026-10-03-front-demo-wide.png)

![Demo, phone](2026-10-03-front-demo-phone.png)

Welcome, live:

![Welcome, wide](2026-10-03-front-welcome-wide.png)

![Welcome, phone](2026-10-03-front-welcome-phone.png)

Empty list, this commit's server:

![Empty, wide](2026-10-03-front-empty-wide.png)

![Empty, phone](2026-10-03-front-empty-phone.png)

Consent, this commit's server:

![Consent, wide](2026-10-03-front-consent-wide.png)

![Consent, phone](2026-10-03-front-consent-phone.png)

## Review pass

Deployed again on 2026-10-03, after `origin/main` was already in the tree. Commit `aa31e83`. Worker version `6c2ca266-932f-4e12-8d9f-fb08f0347b97`. An earlier deploy the same afternoon, from the merge commit, put the backup and GitHub routes back on stylebook.dev before these fixes. `GET /health` returned 200. `GET /backups` with no session returned 401. `GET /backups/github/setup` returned 200 and named GitHub.

`npx wrangler d1 migrations apply stylebook --remote` applied `0013_demo_ip.sql` (the connecting address on a demo copy). It reported 3 commands, success. `0011_demo_copies.sql` was not renamed. It is already recorded, and its `ALTER TABLE` is not safe to run again under another name.

`npm run typecheck` and `npm test` passed (128 tests). `DEMO_KEY` was not changed.

### Try the demo, again

Three signed-out `POST /try` calls, then the library page with that session. Each page was 200 and showed suggestions, Publish, and "Ask an agent to combine them." The copies were separate.

| Visit | Copy | Then the page | Together |
| --- | --- | --- | --- |
| 1 | 4781 ms | 86 ms | 4867 ms |
| 2 | 5377 ms | 90 ms | 5467 ms |
| 3 | 4145 ms | 116 ms | 4261 ms |

Visits 1 and 3 were under five seconds. Visit 2 was not. The time is in making the copy. The page after that was under a fifth of a second.

Copies opened since 14:00 UTC had usage rows: 72 forks, 144 gets, and 792 reads, across those copies. See [Artifacts pricing](https://developers.cloudflare.com/artifacts/platform/pricing/).

The day's cap is 80 (`MAX_DEMO_COPIES_PER_DAY`). One connecting address is capped at 8 (`MAX_DEMO_COPIES_PER_IP_PER_DAY`). The address is `CF-Connecting-IP` only. A forwarded header is not used. Both caps are one insert, the same shape as a workspace start. The live host was not at either cap. The tests set each cap and the next try returns 429.

### What a demo copy cannot do

On one live copy, People, Connect, and Backups all showed "Not available in the demo. Start your own workspace to use this." People had no invite form and no new key. Connect had no tool steps. Backups still had Download, and no GitHub connect and no other-service form. Posting an invite stored nothing. Posting an other-service backup returned to Backups with that same sentence, and no backup row was stored.

A person who is already signed in is sent to their workspace, and the session cookie is left as it is. That was checked in the tests. Live sign-in is Cloudflare Access, so this pass did not sign a second person in on the host.

The first page reads the shared Demo library through a proxy that allows `readFile`, `log`, `readTree`, and `listFiles`. The generated binding types do not declare `listFiles`. Anything else throws. See the [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/).

### Deletion, again

One copy's expiry was set to `2000-01-01T00:00:00.000Z` before 14:06 UTC. At 14:18 UTC that row was gone, and so were its workspace, people, backup, and audit rows. The schedule is still `17 * * * *`. The same job removes `d` plus seven letters repos that no longer have a copy row. The shared Demo library is not one of those names. That sweep was checked in the tests.
