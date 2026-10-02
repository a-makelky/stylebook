# Stylebook

A shared, versioned library for a team's AI tooling: skills, MCP server definitions, and workflows.

It is for teams who write, research and publish for a living and do not want to learn Git to share what works. Writers already have a word for the thing the whole team follows. It is a stylebook, and it comes in editions.

## How it works

- The team's **library** holds the current edition of every skill.
- Anyone who wants to change something, a person or an agent, gets their own **copy** and makes a **suggestion** there. The library is not touched.
- Many agents can do that at the same time, each in its own copy.
- A person compares the suggestions and **publishes** the one they want. That is a new **edition**.

Underneath, the library and every copy are Git repositories on [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/). That is what keeps the library portable: any tool that speaks Git can pull it, and an agent tool can use the MCP endpoint on the same host. The address a Git client uses is this Worker. It does not include an Artifacts remote.

## Status

This table is the honest state of the code, not a roadmap.

| Piece | State |
| --- | --- |
| Library, suggestion copy, read back, history (Tracer 1) | Ran live on 2026-10-02. See [the run log](docs/runs/2026-10-02-tracer-1.md). |
| Many agents suggesting at once | Ran live on 2026-10-02. See [the run log](docs/runs/2026-10-02-tracer-2.md). |
| Who made each change and why | Ran live on 2026-10-02. See [the run log](docs/runs/2026-10-02-tracer-3.md). |
| Review screen: compare, flag overlaps, publish | Ran live on 2026-10-02. See [the run log](docs/runs/2026-10-02-tracer-4.md). |
| Pull the library with plain Git or over MCP | Ran live on 2026-10-02. See [the run log](docs/runs/2026-10-02-tracer-5.md). |
| Workspaces, email sign-in, invites, and connecting an agent | Ran live on 2026-10-02. See [the run log](docs/runs/2026-10-02-teams.md). Sign-in email is not delivered until the domain is onboarded for Email Service. |

Run logs from live runs go in [`docs/runs/`](docs/runs/). Until one is there for a piece, treat that piece as unproven.

## Use it

Stylebook is hosted at [stylebook.dev](https://stylebook.dev). A writer opens that address in a browser. They do not need Cloudflare or a terminal.

1. Start a workspace with a name and an email address. Stylebook sends a link from `sign-in@stylebook.dev`. It works once and expires in 15 minutes. Opening it lands on the library, which already holds the sample pages. The domain has to be onboarded for Email Service before a link can arrive. The run log records the current state of that.
2. From People and agents, invite a colleague by email. Their link signs them into that same workspace. Everyone in the workspace can review and publish. Remove ends that person's sessions.
3. Connect an agent by giving it a name and picking the tool. The key is shown once, with a setup for Cursor or Claude Code and a setup for a folder on your computer. The agent's first suggestion then appears on the page. An agent can be renamed, and its key can be revoked.

A workspace is one team. Its library, suggestions, people, agents and History stay inside it. Another workspace cannot see or change them.

When a limit is reached, the page says so in plain language. The starting limits are 40 workspaces, 25 people and 40 agents in one workspace, 200 open suggestions in one workspace, and 5 sign-in emails per address per hour.

## Run it yourself

Self-hosting is possible from this project. It is not the path above.

You need Node.js 22, Git, and a Cloudflare account on the Workers Paid plan. Artifacts requires that plan. See [Get started](https://developers.cloudflare.com/artifacts/get-started/). Sending sign-in email also needs [Email Service](https://developers.cloudflare.com/email-service/get-started/send-emails/) on that plan, with the sender `sign-in@stylebook.dev` allowed on the binding. See [Send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/).

From a fresh clone of this project:

```sh
npm install
npx wrangler login
```

Create the database that records arrivals, unless `wrangler.toml` already points at one in your account:

```sh
npx wrangler d1 create stylebook
```

If the name is already taken, the database exists. Read its id:

```sh
npx wrangler d1 info stylebook
```

When that id differs from `database_id` under `[[d1_databases]]` in `wrangler.toml`, replace the value in the file with the id just printed. Then apply the migrations:

```sh
npx wrangler d1 migrations apply stylebook --remote
```

The Workers binding addresses one namespace, chosen in `wrangler.toml`. Its methods take a repo name, not a namespace, so a team is a prefix on every repo (`{id}-library` and `{id}-sug-…`) in the namespace `stylebook`. A copy made with `fork()` stays in that namespace. If the namespace does not exist yet, Artifacts creates it when the first repo is created. See the [Workers binding](https://developers.cloudflare.com/artifacts/api/workers-binding/) and [Namespaces](https://developers.cloudflare.com/artifacts/concepts/namespaces/). Older namespaces named `stylebook-review` and `stylebook-demo` stay in the account and are not bound.

`wrangler.toml` attaches `stylebook.dev` as a [custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/). Delete the `[[routes]]` block before you deploy if that domain is not in your Cloudflare account. The deploy fails when the domain belongs to another account.

```sh
npx wrangler deploy
npx wrangler secret put DEMO_KEY
```

Type any long random string when asked. The demo routes refuse every request that does not carry it. Without the secret set they answer 503.

In the commands below, `$DEMO_KEY` is that string and `$HOST` is the `https://` URL Wrangler printed. When `stylebook.dev` answers, you can use `https://stylebook.dev` instead.

### Open suggestions

This registers one person, Editor, and two agents who work for that person, Researcher and Proofreader. It then saves about a dozen suggestions. Two of them change the same line of Steps. Two others change different parts of the same page, so they can be combined.

```sh
export PERSON_KEY=$(openssl rand -hex 24)
export RESEARCHER_KEY=$(openssl rand -hex 24)
export PROOFREADER_KEY=$(openssl rand -hex 24)

curl -X POST "$HOST/demo/seed" \
  -A stylebook-live-run \
  -H "Authorization: Bearer $DEMO_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"personKey\":\"$PERSON_KEY\",\"researcherKey\":\"$RESEARCHER_KEY\",\"proofreaderKey\":\"$PROOFREADER_KEY\"}"
```

Keep the three keys. The seed request can take about a minute. It opens a workspace named Demo. The library repo is `demo-library`. Open `$HOST` in a browser and sign in with the Editor address the seed records (`editor@stylebook.invalid`). The first page lists the newest suggestions. When more copies exist than fit on the page, it links to the older ones and does not read every copy.

The `workers.dev` hostname returns [error 1010](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/) for Python's default user agent. That refusal happens before the request reaches the Worker. `curl` and Git get through on that hostname. On `stylebook.dev` the same Python agent gets through. If a hostname you control returns 1010, [Browser Integrity Check](https://developers.cloudflare.com/waf/tools/browser-integrity-check/) is refusing the client. The commands below send `-A stylebook-live-run` so they do not depend on that check. Git sends its own user agent. The run log records what got through.

### Plain Git

Ask the Worker for a read credential for the library. The response's `remote` is this host. It is not an Artifacts address. Read credentials are for clone and fetch. A write credential is only for a push. See [Best practices](https://developers.cloudflare.com/artifacts/concepts/best-practices/) and the [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/).

```sh
curl -sS -X POST "$HOST/git/access" \
  -A stylebook-live-run \
  -H "Authorization: Bearer $PERSON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"demo-library","write":false}'
```

Take `token` from the response. Strip the scheme from `$HOST`:

```sh
HOST_ONLY=${HOST#https://}
```

```sh
git clone "https://stylebook:<token>@${HOST_ONLY}/git/demo-library.git" stylebook-library
```

That clone needs only Git. The files in `stylebook-library` are the library.

An agent that may write its own copy can push to `https://stylebook:<agent-key>@${HOST_ONLY}/git/<copy-name>.git`. A person publishes from the page. An agent key cannot publish the library.

### MCP

The endpoint is `$HOST/mcp`. It speaks JSON-RPC over HTTP, the streamable HTTP shape described in [Cloudflare's MCP transport notes](https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/). Send the agent's Stylebook key as `Authorization: Bearer`. These tools are available:

| Tool | What it does |
| --- | --- |
| `list_library` | List the pages in the library |
| `read_item` | Read one page. Argument: `path` |
| `suggest_change` | Save a suggestion on that agent's own copy. Arguments: `path`, `content`, `why`, and an optional `session` |
| `list_suggestions` | List open suggestions for one page, newest first. Argument: `path` |

A change suggested here is saved the same way as a change pushed with Git: the Worker checks the key and forwards the write.

Point any MCP client that supports a remote HTTP endpoint at `$HOST/mcp`, with the bearer key. To try it with curl, initialize, then call a tool:

```sh
curl -sS -X POST "$HOST/mcp" \
  -A stylebook-live-run \
  -H "Authorization: Bearer $RESEARCHER_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

curl -sS -X POST "$HOST/mcp" \
  -A stylebook-live-run \
  -H "Authorization: Bearer $RESEARCHER_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_item","arguments":{"path":"skills/interview-to-draft/SKILL.md"}}}'
```

To suggest a change, call `suggest_change` with the full new text of the page and a `why`. Sign in on the page with the Editor address and the suggestion is listed there.

### Many agents at once

To start many agents at once, send a named user agent:

```sh
curl -X POST "$HOST/demo/suggestions" \
  -A stylebook-live-run \
  -H "Authorization: Bearer $DEMO_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"n\": 25, \"key\": \"$RESEARCHER_KEY\", \"personKey\": \"$PERSON_KEY\"}"
```

The response lists each copy and whether the agents' work overlapped. It does not include credentials. `n` can be from 1 to 100. Ask who saved an edition with `GET $HOST/who?edition=<id>` and the person's key.

Those copies land in the same workspace as the library. The page shows the newest ones first.

The earlier tracer route is still there:

```sh
curl -X POST "$HOST/demo/tracer" \
  -A stylebook-live-run \
  -H "Authorization: Bearer $DEMO_KEY" \
  -H "Content-Type: application/json" \
  -d '{"actor": "demo-agent", "session": "one"}'
```

## Develop

```sh
npm run typecheck   # generates binding types, then checks source and tests
npm test            # local tests
```

The tests do not need a Cloudflare account. They run the real publish code against a local Git server and a stand-in for the Artifacts binding, and once more inside the local Workers runtime. They show the code is sound. They do not show how the live service behaves.

## License

[MIT](LICENSE)
