# Sample library

What a content team's Stylebook library looks like. The review-screen demo will publish this folder as the first edition of a new workspace's library. Today the live demo publishes only `interview-to-draft` (from `src/seed.ts`); a test keeps the two copies identical.

| Folder | Holds | Format |
| --- | --- | --- |
| `skills/` | One folder per skill, each with a `SKILL.md` | Markdown with `name` and `description` at the top, the format agent tools such as Claude and Cursor read |
| `workflows/` | How skills are used together, and where a person signs off | Markdown |
| `connections/` | The tools the team's agents connect to | `servers.json` in the `mcpServers` shape most agent tools accept |

The connection to Notion uses Notion's hosted server ([Notion's MCP guide](https://developers.notion.com/guides/mcp/get-started-with-mcp)). Each person signs in to Notion from their own tool; no keys live in the library.

The skills are written for a team of writers, researchers and editors. They are examples, not advice for any particular publication.
