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
| Library, suggestion copy, read back, history (Tracer 1) | Code and local tests. **Not yet run against live Artifacts.** |
| Many agents suggesting at once | Not started |
| Who made each change and why | Not started |
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

These steps have not yet been run end to end on a live account. That is the next piece of work.

## Develop

```sh
npm run typecheck   # generates binding types, then checks source and tests
npm test            # local tests
```

The tests do not need a Cloudflare account. They run the real publish code against a local Git server and a stand-in for the Artifacts binding, and once more inside the local Workers runtime. They show the code is sound. They do not show how the live service behaves.

## License

[MIT](LICENSE)
