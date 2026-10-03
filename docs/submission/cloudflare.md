DRAFT. Not submitted.

* **Artifacts** holds every workspace's library and every suggestion. Each suggestion is a real `fork()` in the same namespace, one per agent per session. The Worker reads with `readFile()`, `log()` and `info()` and writes editions through Git with short-lived repo tokens. Push events (`cf.artifacts.repo.pushed`) start a Workflow that confirms every save against Stylebook's own record.
* **Workers** runs all of Stylebook on [stylebook.dev](https://stylebook.dev) (custom domain): the review screen, a Git smart-HTTP endpoint, an MCP endpoint, and OAuth. The Git endpoint checks the caller's own key and forwards with a short-lived token, so attribution comes from the key, not a typed name, and no Artifacts remote or account ID leaves the Worker.
* **Workflows** run each agent session as its own instance, so 25 or 100 agents work at once.
* **Cloudflare Access** (one-time email code) is the sign-in for people. The Worker verifies the Access JWT itself. Two roles, Admin and Member, plus a "Members can publish" switch.
* **Workers OAuth Provider + KV**: agent tools connect to the MCP endpoint by signing in through Access and approving on a consent page bound to one workspace. No keys to paste.
* **D1** keeps workspaces, people, agents and who each agent works for, hashed keys, roles, invitations, and an audit trail of what happened in the workspace.
* **Cron Triggers** delete expired demo copies every hour.
* **Git notes** (`refs/notes/stylebook`) carry the why on every agent edit: who, for whom, which model, which run, and a one-line intent.
* **Portability**: a workspace downloads as one zip that is both a plain folder and a complete Git repository, and can be restored into a new workspace.
