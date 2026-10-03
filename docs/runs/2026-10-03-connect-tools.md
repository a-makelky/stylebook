# 2026-10-03 — Connect your tools

A Cursor cloud agent ran the local checks. It did not deploy. `wrangler whoami` answered "You are not authenticated." There is no API token in this environment, so this run could not create the KV namespace, apply migration `0009_connectors.sql`, or deploy. It also could not open Claude, or the MCP Inspector, against stylebook.dev and finish the Cloudflare Access one-time code. The demo secret was not changed. No address, account id, or remote URL is recorded here.

The pictures below are the local server, with a stand-in person named Dana. They are not stylebook.dev.

## What a person does

For Claude, on the web or the desktop app, the path is the one in [Getting started with custom connectors using remote MCP](https://support.anthropic.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp). Free, Pro, Max, Team, and Enterprise can use it. On Team and Enterprise an owner adds it first under Organization settings, then Connectors.

Clicks, counted on the local server with Chrome:

1. On People, click **Connect your AI tools**. The same page is **Connect your tools** in the workspace menu.
2. On the Claude card, copy the one address. In Claude: Customize, then Connectors, then Add, then Add custom connector. Paste the address and continue. That is the one paste. The card does not show a key, a JSON block, or the word "header".
3. Claude opens Stylebook. With no session, Cloudflare Access asks for the one-time code, the same sign-in as the site. This run already had a session, so that screen did not appear.
4. The page says Claude will be able to read the team's library and suggest changes as *Claude for Dana*. It cannot publish. Click **Approve**.

From the consent page starting to load until Approve finished and the browser followed the return address: **1789 ms**. The return address was a local callback with nothing listening, so the last screen was the browser's own connection error. That screen is the tool's callback, not Stylebook.

That is open Connect, one paste, sign in when needed, Approve.

## What the local server did

Sign-in from the tool uses the [Workers OAuth Provider](https://github.com/cloudflare/workers-oauth-provider) in front of `/mcp`, with Cloudflare Access as the identity, which is option 1 in [Authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/). The provider's resource is the request's own `/mcp` address, so a local server and stylebook.dev can both check the audience. A posted key with no colons is still accepted. Revoke deletes that key, so the next call with the old token is rejected even if the grant record lingers.

With the test KV namespace in place:

- A call to `/mcp` with no credential returned 401, and `WWW-Authenticate` pointed at the resource metadata.
- A signed-out visit to the approval address redirected to `/enter` and remembered the return address.
- Approving created an agent named Claude for Dana. The page did not show a key.
- The first call carried the tool name and version. The saved suggestion's note named Claude for Dana, on behalf of Dana, and the model line included `1.2.3`.
- After that call the Claude card read "Connected as *Claude for Dana*".
- Skills and workflows came back as prompts. `get_skill` returned the interview skill. The skill download was a zip of the `skills/*/SKILL.md` files and did not include workflows.
- `list_team_connections` returned the Notion address from `connections/servers.json` and did not return a credential. A query or a sign-in embedded in an address is dropped before it is shown.
- Calling publish returned "An agent cannot publish."
- Revoke on People, then the same token, returned 401.

`npm test`: 10 files, 83 tests, passed. `npm run typecheck` passed.

## Cards

Each card follows that vendor's current docs. Where the docs have no one-click install for a server you host yourself, the card is the address and sign-in.

| Tool | What the card does | Docs |
| --- | --- | --- |
| Claude | Paste the address. Customize, Connectors, Add, Add custom connector, then sign in. | [Custom connectors](https://support.anthropic.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp) |
| ChatGPT | Paste the address and sign in. Full connectors are in beta on Business, Enterprise, and Edu. Plus, Pro, and Free are not listed for this. | [Developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) |
| Cursor | Paste the address in Customize, then sign in. Cursor documents OAuth for streamable HTTP, and a marketplace install, not a one-click link for a server you host. | [MCP](https://cursor.com/docs/mcp) |
| VS Code | One click uses the documented `vscode:mcp/install` link, then sign in. The link carries no credential. | [MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers), [install link](https://code.visualstudio.com/api/extension-guides/ai/mcp) |
| Claude Code | One line: `claude mcp add --transport http stylebook <address>`, then sign in. | [MCP](https://code.claude.com/docs/en/mcp) |
| Codex | Settings, MCP servers, Add server, Streamable HTTP, paste the address, then sign in. The documented add example is not an HTTP URL flag, so the card does not invent one. | [Codex MCP](https://developers.openai.com/codex/mcp) |
| A folder on your computer | One button. The command is shown once and reads the library for a short time. | [Git protocol](https://developers.cloudflare.com/artifacts/api/git-protocol/) |

Skills are prompts and resources where the tool supports them ([Cursor](https://cursor.com/docs/mcp), [VS Code](https://code.visualstudio.com/api/extension-guides/ai/mcp)). The download is the `SKILL.md` folder layout ([Claude Code skills](https://code.claude.com/docs/en/skills), [Cursor skills](https://cursor.com/docs/skills)). `get_skill` covers a tool that has neither prompts nor resources.

## Pictures

![Connect, wide](2026-10-03-connect-wide.png)

![Connect, phone](2026-10-03-connect-phone.png)

![Approve, wide](2026-10-03-consent-wide.png)

![Approve, phone](2026-10-03-consent-phone.png)

![People, wide](2026-10-03-people-connect-wide.png)

![People, phone](2026-10-03-people-connect-phone.png)

## Still needed for stylebook.dev

1. `npx wrangler login`, or an API token.
2. `npx wrangler kv namespace create OAUTH_KV`, then set that id on the `OAUTH_KV` binding in `wrangler.toml`. The binding is commented until the id exists. KV is included in Workers Paid. See [KV](https://developers.cloudflare.com/workers/runtime-apis/kv/).
3. `npx wrangler d1 migrations apply stylebook --remote` so `client_version` exists. Migration `0009_connectors.sql` follows `0008_admin_audit_actor.sql`.
4. Deploy without changing the demo secret. `global_fetch_strictly_public` is already on, which the OAuth library requires for a published client identity.
5. Repeat the Claude clicks, or the MCP Inspector, against `https://stylebook.dev/mcp`, including Access, Approve, one suggestion, and Revoke.
