# Life OS MCP server

Lets Claude, ChatGPT or any MCP client drive the Life OS assistant, so the
thinking is paid for by an existing subscription rather than per API call.

## Capabilities and permissions

The [generated capability reference](../docs/generated/mcp-capabilities.md) is the current source for tool counts, permissions, resources and prompts. Regenerate it from the repository root with `node scripts/generate-mcp-docs.mjs`.

- Read app records and permitted mailbox, attachment, persona and finance data. Imported text is untrusted data, never instructions.
- Change private records, save provider reply drafts, reject queued proposals, and inspect operation/history state within the connection's capabilities. Some provider operations cannot be undone.
- Queue emails and invitations for owner approval inside Life OS. No MCP tool can approve or directly send them. The autonomous calendar path refuses guest-bearing edits/deletions.
- Use structured results, `_idempotency_key`, operation status, background scan jobs, and versioned task/note previews. Bulk preview commits return explicit per-record outcomes and can partially succeed.
- Never read private assistant transcripts or provider OAuth secrets, or change owner-only agent instructions/invoiced billing through tools.

OAuth connections receive explicitly selected capabilities. A restricted connection does not receive unfiltered aggregate results when those results cannot honor its selection. The legacy stdio shared secret is an owner-configured **full-access credential**, with a shared activity/idempotency namespace; use separate OAuth connections for client-specific grants and revocation.

See [Claude handoff](../docs/CLAUDE_HANDOFF_2026-10-15.md) for migration and recovery requirements. Existing OAuth grants are revoked by the security migration and must consent again.

## Setup

### 1. Set the shared token on the app

Generate a long random token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Add it to Vercel as `LIFEOS_MCP_TOKEN` (a plain server variable, never
`NEXT_PUBLIC_`), then redeploy so the running app picks it up. Anything
shorter than 24 characters is refused by the app.

### 2. Build the server

```bash
cd mcp-server
npm ci
npm run build
```

### 3. Point a client at it

Claude Desktop (`claude_desktop_config.json`) or Claude Code
(`.mcp.json`), using the same token:

```json
{
  "mcpServers": {
    "life-os": {
      "command": "node",
      "args": ["D:/Projects/Life OS of Tapas/app/mcp-server/dist/index.js"],
      "env": {
        "LIFEOS_URL": "https://life-os-of-tapas.vercel.app",
        "LIFEOS_MCP_TOKEN": "the same token you set on Vercel"
      }
    }
  }
}
```

Restart the client. The startup line on stderr prints the live tool counts. Resources and prompts are also discovered from the app; connection permissions determine availability.

## Checking it works

```bash
npm run inspect
```

Opens the MCP Inspector against the server. `lifeos_get_context` is the
quickest end-to-end check: it returns today's date, your work streams and
your open tasks.

If the server exits at startup it prints why on stderr. The two usual causes
are a missing `LIFEOS_URL` or `LIFEOS_MCP_TOKEN`, and a token that does not
match the one set on the app, which shows as a 401.

## Design notes

- The tool list is fetched from the app at startup rather than duplicated
  here, so this server cannot drift from the registry the app's gates are
  built around. Adding a tool in the app makes it appear here automatically.
- This package uses stdio. Phone/web clients can use the existing OAuth
  Streamable HTTP endpoint at `/api/mcp/http`. Both share the same permission
  and operation dispatcher; sends remain owner-approved.
- The server holds one secret, the shared token. Gmail and calendar
  credentials never leave the app.

## Retry and background jobs

Retain returned operation IDs. Reuse `_idempotency_key` only with identical arguments. A request without a key gets a new operation, so it cannot deduplicate a retry whose first response was lost. Never automatically retry an uncertain result with a fresh key.

`lifeos_start_scan_job` returns quickly; inspect `lifeos_job_status` and `lifeos_job_results`. Queued jobs are cancellable; once scanning has started, cancellation cannot reverse created tasks or proposals. Next.js starts the worker after the request, with a daily protected cron as a recovery trigger. Running work that outlives its lease is marked uncertain, not blindly replayed.

Previews currently support task title/note and saved-note title/body only. They expire after 15 minutes and compare the record version inside the same transaction as mutation/history. This does not promise version checks for every legacy write tool. Calendar, mail and protected fields are excluded.
