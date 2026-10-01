# Hosted team mode: design (not built)

Status: design only (audit P2-16). The server today is one process, one Notion token, one user, talking stdio.
This is what a hosted, multi-user version would need, so the local design isn't retrofitted into it piecemeal.

## Goals

- Many people, and many Notion workspaces, through one deployment.
- Each request acts with the permissions of the person (or workspace) behind it, and nothing else.
- Durable, observable, and recoverable at a level a team can rely on.

## Shape

| Concern | Local today | Hosted |
|---|---|---|
| Transport | stdio | MCP Streamable HTTP, behind TLS |
| Identity | none (whoever starts the process) | OAuth 2.1 sign-in for the MCP client; each request carries a session bound to a user and a tenant |
| Notion access | one integration token in the environment | Notion public-integration OAuth per workspace; access and refresh tokens in a vault (KMS-encrypted), never in logs or tool results |
| Client | one global `Client` (`notion()`) | a client per request from the tenant's token; `notion()` becomes request-scoped (AsyncLocalStorage, as the journal already uses for intents) |
| Rate limits | one queue spacing requests ~3/s | per Notion workspace (that's Notion's unit), shared across processes (Redis token bucket) |
| State | JSON files under a home folder, per integration | a database (Postgres): journal, chart recipes, templates, rules, workflows, runs, webhook queue, all keyed by tenant; row-level tenant isolation |
| Undo | per integration | per user within a tenant: you can undo your own changes; admins can undo anyone's in their tenant |
| Automations | GitHub Actions or local cron; webhook server | a worker pool reading a job queue (the webhook queue and schedule ticks become jobs); at-least-once with the existing idempotency (step state + reconcile) |
| Secrets for workflows | `NOTION_PLUS_SECRET_*` environment variables | per-tenant secrets in the vault, referenced the same way (`${secret:NAME}`) |
| Outbound HTTP | `NOTION_PLUS_HTTP_ALLOW` | per-tenant allow-list, plus the same private-address blocking in `safeFetch` |

## Authorization

- Scopes per tool family (read, write, schema, automation, admin), granted per user by a tenant admin.
- Destructive tools (trash, delete blocks, schema delete, workflow runs) need the write scope and, by default, a confirmation step the client must show.
- Every tool call is written to an audit log: who, tenant, tool, arguments (secrets redacted), result status, undo id.

## What carries over unchanged

- Tool schemas and the result envelope.
- The write-ahead journal and undo coverage.
- Workflow semantics: durable runs, resumable steps, reconcile-before-retry, approvals, delays.
- `safeFetch`, the chart renderer, templates.

## What has to change first

1. Make every module that reads `config()`, `homeDir()`, or `notion()` take a request context instead (one parameter threaded through, or AsyncLocalStorage).
2. Put the `store.ts` interface (`readJson`, `updateJson`) behind a storage adapter, with the JSON files as one implementation and Postgres as another.
3. Move the request-spacing queue in `notion.ts` behind a rate-limiter interface.

## Operations

- SLOs: tool-call success rate and p95 latency (excluding Notion's own latency), automation start delay, webhook end-to-end delay.
- Metrics and traces with OpenTelemetry; the existing JSON logs already carry `run_id`.
- Backups: point-in-time recovery for the database; the journal is the user-facing undo, not the backup.
- Data retention: run records 90 days, audit log per tenant policy, journal 500 changes per user.
- Disaster recovery drill: restore to a new region and replay the webhook queue (events are deduplicated by id).
