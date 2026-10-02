# Stylebook

A shared, versioned library for a team's AI tooling: skills, MCP server definitions, and workflows.

It is for teams who write, research and publish for a living and do not want to learn Git to share what works. Writers already have a word for the thing the whole team follows. It is a stylebook, and it comes in editions.

## How it works

- The team's **library** holds the current edition of every skill.
- Anyone who wants to change something, a person or an agent, gets their own **copy** and makes a **suggestion** there. The library is not touched.
- Many agents can do that at the same time, each in its own copy.
- A person compares the suggestions and **publishes** the one they want. That is a new **edition**.

Underneath, the library and every copy are Git repositories on [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/). That is what keeps the library portable: any tool that speaks Git can pull it.

## Status

Early. This table is the honest state of the code, not a roadmap.

| Piece | State |
| --- | --- |
| Library, suggestion copy, read back, history (Tracer 1) | Ran live on 2026-10-02. A new copy names the library as its source, the skill read back matched, and a second edition was on both the library and that copy. Calling again for the same session reused the existing copy. See [the run log](docs/runs/2026-10-02-tracer-1.md). |
| Many agents suggesting at once | Ran live on 2026-10-02. One request started 25 agents together, and a second started 100. Each got its own copy and saved one edition of the interview-to-draft skill. Their work overlapped in time. Each save was recorded when it arrived. See [the run log](docs/runs/2026-10-02-tracer-2.md). |
| Who made each change and why | Ran live on 2026-10-02. A person and two agents who work for that person are distinct. Saving an edition through Stylebook worked from outside the Worker as well as from an agent. An agent that put someone else's name on an edition was still recorded as that agent, and that key was refused for the library and for another agent's copy. Each agent-saved edition says why, and asking who saved it returns the agent, the person they work for, and that why. A save that did not come through Stylebook was flagged. See [the run log](docs/runs/2026-10-02-tracer-3.md). |
| Review screen: compare, flag overlaps, publish | Not started |
| Pull the library with plain Git or over MCP | Not started |

Run logs from live runs go in [`docs/runs/`](docs/runs/). Until one is there for a piece, treat that piece as unproven.

## Run it

You need Node 22 and a Cloudflare account on the Workers Paid plan, which Artifacts requires.

```sh
npm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put DEMO_KEY   # any long random string
```

Then call the tracer with that key:

```sh
curl -X POST https://<your-worker-url>/demo/tracer \
  -H "Authorization: Bearer <your DEMO_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"actor": "demo-agent", "session": "one"}'
```

The response reports the library's editions, the name and source of the copy, and whether the skill read back from the copy is byte-identical to the library's. Add `"addEdition": true` to give the library another edition before the copy is made.

The demo route creates repositories on your account, so it refuses every request that does not carry the key. Without the secret set it answers 503.

To start many agents at once, send a named user agent (a request with none was refused before it reached the Worker):

```sh
curl -X POST https://<your-worker-url>/demo/suggestions \
  -A stylebook-live-run \
  -H "Authorization: Bearer <your DEMO_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"n": 25, "key": "<agent key>", "personKey": "<person key>"}'
```

The response lists each copy, the edition it saved, who saved it, and whether the agents' work overlapped. It does not include credentials. `n` can be from 1 to 100. The agent key and the person key are registered first; the agent works for that person. Ask who saved an edition with `GET /who?edition=<id>`.

These steps were run against a live account on 2026-10-02. The record, with the key removed, is in [docs/runs/2026-10-02-tracer-1.md](docs/runs/2026-10-02-tracer-1.md).

## Develop

```sh
npm run typecheck   # generates binding types, then checks source and tests
npm test            # local tests
```

The tests do not need a Cloudflare account. They run the real publish code against a local Git server and a stand-in for the Artifacts binding, and once more inside the local Workers runtime. They show the code is sound. They do not show how the live service behaves.

## License

[MIT](LICENSE)
