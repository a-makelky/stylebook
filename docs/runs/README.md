# Run logs

One file per live run, named `YYYY-MM-DD-<what>.md`. A run log is the evidence that a piece of Stylebook works against the real Artifacts service.

No run log has been committed yet.

## What a run log contains

- Date, and who or what ran it.
- The commit of this repo that was deployed.
- The exact request sent and the full response, with secrets removed.
- What was checked by hand afterwards, and how.
- Anything the live service did that the docs do not describe.
- Failures and retries, with the error codes returned.

## Before committing

Remove the demo key, every token, and the Cloudflare account ID. Artifacts remote URLs contain the account ID, so cut them or replace the ID with `<account-id>`.

## Open questions for the first live run

The local tests guess at these. The first run should answer them here.

- How long after `fork()` returns does `get()` report `FORK_IN_PROGRESS`, if at all?
- Does `info().source` on a copy read `artifacts:<namespace>/library`, as the generated types suggest?
- Does a copy made with `defaultBranchOnly: true` carry the library's full history on `main`?
