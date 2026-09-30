# Notion Plus MCP — Comprehensive Engineering and Capability Audit

**Repository:** `katekruger/notion-mcp`  
**Revision audited:** `e39a25beb0435816736bbc1b50c14709087ed1da` (`v0.8.0`)  
**Audit date:** 2026-09-30  
**Previous baseline:** `10f772e05587a0499cbb52a20935766b7bccaa06` (`v0.7.0`)  
**Version:** 0.8.0  
**Overall assessment:** Promising, unusually capable beta; not yet production-durable for unattended automation

## Executive summary

This codebase is much more complete than a typical early MCP server. It exposes 29 tools and already covers precise block editing, broad Notion-flavored Markdown, schema-aware database operations, bulk actions, undo, native views, rendered charts, report pages, and scheduled rules. Version 0.8.0 adds database duplication with schema/row copying and relation remapping, three chart image themes, stronger live smoke coverage, and release-runner corrections. The local quality gate passes: lint, strict TypeScript checking, 69 tests, and the production build all succeeded at the audited revision.

The main gap is not feature count. It is the distance between a strong single-user local tool and a durable automation platform. The current implementation can perform substantial work, but its persistence and execution model cannot yet guarantee safe recovery from interruption, concurrent clients, corrupt state, or partial multi-step writes. Several failures are reported as successful MCP calls, scheduled occurrences are marked complete despite row or follow-up failures, and a row can be marked as processed before all its actions finish. Those behaviors matter more than another chart type.

The recommended path is:

1. Make automation execution recoverable and idempotent.
2. Separate mutable user configuration/state from the installed package and repository.
3. Make corruption and partial failure loud, structured, and observable.
4. Add live contract tests against a disposable Notion workspace and package-level smoke tests.
5. Then expand toward event triggers, reusable content templates, richer visual specifications, exports, and external actions.

## Scope and method

This is a post-merge re-audit. It reviewed the complete current source plus the 457-line change set from v0.7.0 to v0.8.0, tests, evaluation scripts, package metadata, bundle construction, documentation, and all GitHub Actions workflows. It traced the tool registration and principal write, undo, chart, report, file, duplication, and automation paths.

Executed successfully:

- `npm ci`
- ESLint
- strict TypeScript typecheck across source, tests, scripts, and evals
- Vitest: **7 files, 69 tests passed**
- production TypeScript build
- npm dependency advisory scan

Not executed:

- Live Notion acceptance/evaluation suites, because this audit environment did not have a disposable Notion integration token and workspace.
- Cross-platform MCP bundle installation and launch on all four release targets.
- Claude Desktop, Cowork, and Claude Code end-to-end calls through their actual MCP hosts.

Therefore, claims about live Notion behavior are based on code and test inspection unless explicitly marked as verified by the local suite.

## What changed since the first audit

| v0.8.0 change | Evaluation | Audit consequence |
|---|---|---|
| Duplicate databases found directly on a page | Valuable capability; includes schemas, up to 500 rows per data source, row content, internal relation remapping, and external-relation containment | Improves content fidelity substantially, but introduces two new correctness gaps documented as P1-09 and P1-10 |
| Preserve top-level sub-page/database ordering | Good product improvement within Notion API constraints | Previous duplicate-page limitation is partly resolved |
| Light, dark, and transparent chart themes | Correctly schema-validated and unit-tested | The previous fixed-light-image gap is resolved; richer graph types, vector output, alt text, and custom themes remain |
| Live smoke case for database copying | Stronger API-contract coverage when manually run | CI still does not execute the live suite |
| Intel macOS runner changed to `macos-15-intel`; matrix no longer fail-fast | Appropriate release correction | Cross-platform bundle creation is more resilient, but artifacts are still not install/handshake-tested |
| README corrections for views, schemas, database copying, and themes | More accurate product communication | Undo language and automation deployment caveats still need tightening |

### Status of the original high-priority findings

| Original finding | v0.8.0 status |
|---|---|
| P1-01 partial row can be permanently processed | **Open** |
| P1-02 failed scheduled occurrence marked fired | **Open** |
| P1-03 corrupt state silently becomes empty | **Open** |
| P1-04 concurrent processes can lose file-backed state | **Open** |
| P1-05 bundle automation storage conflicts with repo workflow | **Open** |
| P1-06 interactive automation failure returns MCP success | **Open** |
| P1-07 no live API contract gate in CI | **Open; live smoke coverage improved but remains manual** |
| P1-08 GitHub cache used as durable automation state | **Open** |

No original P1 durability finding was fixed in v0.8.0. The release primarily expands product capability.

## Capability inventory

### Working and well implemented

| Area | Current implementation | Assessment |
|---|---|---|
| MCP surface | 29 focused tools with Zod input schemas and useful descriptions | Strong |
| Reads | Search, page/block reads, schema, query, find, aggregation | Broad and model-friendly |
| Content | Surgical patching, positional inserts, replacement, copy/move, comments, Markdown round-trip | Strong scope |
| Data | Schema-aware writes, forgiving names, bulk update/create, filters, relations | Strong scope |
| Safety | Dry runs, snapshots, undo journal, stale-edit checks, partial-write reporting | Thoughtful, but persistence gaps weaken it |
| Visuals | Native chart views, PNG charts, report pages, tables, KPIs, Mermaid Gantt | Useful first-generation visual system |
| Automations | Conditions, schedules, row actions, follow-up report/chart/page actions | Capable polling runner, not yet a workflow engine |
| Rate limiting | Serialized request starts plus bounded bulk concurrency | Sensible for a single process |
| Error messages | Many Notion failures are translated into actionable guidance | Strong usability |
| File access | Local uploads constrained to configured roots with realpath checks | Good security boundary |
| CI | Lint, typecheck, tests, build on push/PR | Good baseline |
| Distribution | Platform-specific MCP bundles and manifest configuration | Solid direction |

### Capability ceiling today

The server can create sophisticated Notion pages and conventional analytical visuals. It cannot yet serve as a general visual-computation or business-automation platform. Specifically, it lacks webhook/event triggers, arbitrary workflow branching, durable queues, external destinations, custom visualization grammar, interactive hosted artifacts, and rich document/template composition primitives. These are roadmap gaps, not necessarily defects.

## Prioritized findings

Severity meanings:

- **P0 — Critical:** credible data loss, credential exposure, or unsafe production behavior requiring immediate action.
- **P1 — High:** breaks durability, correctness, or core advertised behavior under realistic conditions.
- **P2 — Medium:** meaningful operability, security-hardening, usability, or scope gap.
- **P3 — Low:** engineering polish or incremental improvement.

No P0 issue was established from the inspected code.

### P1-01 — A partially completed row can be permanently treated as processed

**Location:** `src/services/automations.ts:590-625`  
**Category:** correctness, durability, automation

Property writes—including the optional marker—occur before append, comment, and trash actions. If the property/marker write succeeds and a later action fails, the row may no longer match the rule on the next run. The failure is recorded on the row, but there is no checkpoint from which to resume the remaining actions and no automatic compensation.

**Impact:** A workflow can silently stop halfway through: for example, set `Published=true`, fail while appending the publication content, and never retry because `Published=true` excludes it.

**Recommendation:** Model each row execution as a durable state machine. Write a run/step idempotency record before work; checkpoint each action; only write the completion marker last. On failure, either compensate successful earlier steps or resume from the failed step. Treat marker changes as commit, not preparation.

### P1-02 — Scheduled occurrences are marked fired despite partial failure

**Location:** `src/services/automations.ts:629-658`  
**Category:** correctness, recoverability

`last_fired` is advanced whenever the rule has no top-level validation error. Individual row failures and `then` action failures do not prevent it. Scheduled rules will therefore skip the occurrence on retry even when some or all intended work failed.

**Impact:** Missed reports, pages, chart refreshes, comments, or row updates require manual discovery and recovery.

**Recommendation:** Give every occurrence a durable status (`pending`, `running`, `partial`, `succeeded`, `failed`). Advance the schedule watermark only after required steps succeed. Support retry policies and an explicit operator decision to waive a failed step.

### P1-03 — State and journal corruption is silently converted into empty state

**Locations:** `src/services/journal.ts:45-50`, `src/services/automations.ts:203-209`, `src/services/chartstore.ts:20-25`  
**Category:** durability, data integrity

Broad `catch` blocks treat missing files, permission failures, and malformed JSON identically. A truncated or corrupt automation state file becomes “no rules have fired”; a corrupt journal becomes “no history”; a corrupt chart store becomes “no recipes.”

**Impact:** Scheduled actions may repeat, undo history can appear lost, and refresh metadata can disappear without an actionable error.

**Recommendation:** Only treat `ENOENT` as empty. Validate persisted formats with versioned schemas, preserve corrupt files, fail closed for automation state, and provide a repair/migration command. Keep rotating backups and checksums.

### P1-04 — File persistence is not safe across concurrent MCP clients/processes

**Locations:** `src/services/journal.ts:45-75`, `src/services/chartstore.ts:20-37`, `src/services/automations.ts:180-216`  
**Category:** concurrency, durability

The journal, chart store, rules, and state use unguarded load/modify/save sequences and fixed `.tmp` filenames. Two server processes can read the same old value, both write, and the last rename wins. They can also collide on the same temp path.

**Impact:** Lost undo entries, rules, chart recipes, or automation watermarks when Claude Desktop, Cowork, Claude Code, or a scheduled runner share storage.

**Recommendation:** Move mutable state to SQLite with WAL mode and transactions, or implement cross-process locking, unique temp files, compare-and-swap revisions, fsync, and atomic replacement. Namespace state by workspace/integration identity.

### P1-05 — Installed-bundle automation management conflicts with the repository workflow

**Locations:** `src/services/automations.ts:148-184`, `src/tools/automations.ts:22-37`, `scripts/bundle.mjs:21-26`  
**Category:** functionality, usability, distribution

Rules default to `automations/rules.json` relative to the installed code. The bundle ships an empty rules file, and the MCP tells users to “commit and push” that file. A normal Claude Desktop/Cowork bundle installation is not a Git checkout; its installed package may be replaced on upgrade and may not be a suitable mutable location.

**Impact:** The headline automation-management flow is confusing or non-durable for the one-click audience. Updating the extension may discard locally edited rules, and there is no automatic path from a bundle rule to a repository workflow.

**Recommendation:** Store user rules under `NOTION_PLUS_HOME` by default. Provide `notion_automation export/import` and a guided GitHub deployment command or generated workflow artifact. Treat repo-backed rules as an explicit deployment mode, not the universal default.

### P1-06 — MCP “run” can return protocol success when automation work failed

**Location:** `src/tools/automations.ts:141-145`  
**Category:** API semantics, usability

The `run` action wraps results with `ok(...)` and includes `failed: true` inside the body. MCP clients that rely on `isError` will see a successful tool call. Scheduled CLI execution does separately set process failure, but interactive agent behavior can misinterpret this.

**Impact:** Claude may tell the user an automation ran successfully or continue dependent actions after a failed run.

**Recommendation:** Return `isError: true` when any requested rule fails, while preserving structured per-rule results and undo ids. Distinguish `partial_success` from total failure in a machine-readable status field.

### P1-07 — There is no live API contract gate in CI

**Locations:** `.github/workflows/ci.yml`, `evals/*`, `scripts/smoke.ts`  
**Category:** compatibility, testing

CI is entirely local/mock based. The repo contains live smoke and acceptance code, but no scheduled or protected workflow exercises it against a disposable Notion fixture.

**Impact:** API-version changes, permissions, unsupported payload details, export normalization, view behavior, and file upload behavior can regress while all 69 tests remain green.

**Recommendation:** Add a nightly and pre-release live suite using a dedicated least-privilege Notion workspace. Seed unique fixtures, verify results through independent reads, and always clean them up. Keep PRs fork-safe by running secrets only on trusted branches.

### P1-08 — Automation state depends on a GitHub cache, which is not a durable datastore

**Location:** `.github/workflows/automations.yml:46-68`  
**Category:** architecture, recoverability

The schedule watermark, journal, report pointer, and run history are restored from and saved to Actions cache entries. Caches are evictable implementation accelerators, not durable transactional storage. A missed restore is interpreted by the application as fresh state.

**Impact:** Rules can refire old occurrences and `replace_previous` can lose track of its last report. Undo history continuity is best-effort.

**Recommendation:** Persist runner state in a durable system: a dedicated Notion control database, GitHub artifact plus explicit latest pointer, object storage with conditional writes, or a small hosted database. Keep cache only as an optimization.

### P1-09 — Database retrieval failures are misclassified as linked views and silently skipped

**Locations:** `src/services/dbcopy.ts:35-42`, `src/services/copy.ts:193-196`, `src/tools/content.ts` duplicate-page dry run  
**Category:** correctness, error handling, data completeness  
**Introduced:** v0.8.0

`readDatabase` catches every exception and returns `null`. Callers interpret `null` as a linked database view that the API cannot recreate. Authentication failures, missing permissions, rate-limit exhaustion, timeouts, API regressions, and transient network errors can therefore be reported as a benign unsupported object instead of failing the copy.

**Impact:** A user can receive an apparently successful duplicate with a database omitted. The result gives the wrong reason and encourages manual relinking instead of retrying or fixing permissions.

**Recommendation:** Catch only the exact Notion error that identifies a non-retrievable linked view. Propagate authorization, restricted-resource, rate-limit, timeout, gateway, and unexpected errors. Return an explicit `incomplete` status whenever any child cannot be conclusively classified.

### P1-10 — Nested content inside copied database rows can be omitted without disclosure

**Locations:** `src/services/copy.ts:198-204`, `src/services/copy.ts:59-66`  
**Category:** data fidelity, functionality  
**Introduced:** v0.8.0

For each copied database row, the callback calls `childrenAsSpecs` and appends only `c.specs`. It does not recursively copy `c.nestedPages`, inspect child databases, or merge `c.skipped` into the duplicate result. The top-level page path handles those categories, but the row-content path does not.

**Impact:** A row containing a sub-page, nested database, meeting notes, or another unsupported block may be duplicated without that content and without a warning. This conflicts with the product expectation that database rows are copied “with content.”

**Recommendation:** Reuse the segment-aware recursive copy pipeline for row pages, with a documented depth limit and database mode. At minimum, aggregate all skipped/nested items into the returned result and make the overall status `partial`. Add unit and live tests covering row sub-pages, nested databases, unsupported blocks, and partial failure.

### P2-01 — The automation model is polling-only and up to roughly an hour late

**Location:** `.github/workflows/automations.yml:3-5`  

There are no Notion webhook triggers or inbound event receiver. Condition-only rules run hourly, and schedule rules fire on the first runner invocation after their requested time.

**Recommendation:** Add a documented webhook service mode with signature verification, deduplication, replay protection, queueing, and polling fallback. Preserve the local-only runner for simple deployments.

### P2-02 — Automation actions are too narrow for comprehensive workflows

**Location:** `src/services/automations.ts` action and `then` schemas  

Current row actions are set, append, comment, and trash; follow-ups are refresh chart, build report, and create page. Missing primitives include move/duplicate page, patch/replace/delete block, relation sync, view maintenance, HTTP webhook, email/Slack, file/export, approval gates, branching, loops, delays, and sub-workflows.

**Recommendation:** Introduce a versioned workflow schema with typed steps, conditions, outputs, references between steps, secrets, per-step retry/timeout policy, and capability allowlists. Do not add arbitrary shell execution to the MCP.

### P2-03 — Visual output is capable but not yet “all kinds of complex graphs”

**Locations:** `src/services/charts.ts`, `src/services/visualops.ts`, `src/tools/visuals.ts`  

The renderer supports common Cartesian and part-to-whole charts, and v0.8.0 adds light, dark, and transparent surfaces. It does not expose Vega/Vega-Lite specifications, layered/dual-axis charts, heatmaps, histograms, box plots, bullet charts, waterfall, funnel, Sankey, network, treemap, geographic maps, small multiples, annotations, confidence bands, or user-defined theme tokens. Output remains PNG-only, and a single Notion image cannot automatically switch with the viewer's theme.

**Recommendation:** Add two tiers:

1. Safe high-level schemas for common business charts with automatic accessibility and sensible defaults.
2. An advanced validated Vega-Lite input with resource limits and a denylist for external data loading.

Add SVG/PNG export, explicit width/height, dark/light/transparent themes, alt text, annotations, number/date formats, brand token packs, and render snapshots.

### P2-04 — Reports are a fixed recipe rather than a reusable composition system

**Location:** `src/services/visualops.ts:144-369`  

`notion_build_report` is useful but structurally fixed: summary, KPI row, charts, a table, and Gantt. Users cannot define reusable page layouts, nested sections, conditional sections, narrative generation slots, design tokens, reusable partials, or component libraries.

**Recommendation:** Add `notion_render_template` with a declarative, versioned page specification. Support variables, repeaters, conditionals, named slots, Notion block components, chart/view components, preview/diff, and template validation. Keep templates in user storage with import/export.

### P2-05 — External fetches lack a shared egress policy and size limits

**Locations:** `src/services/files.ts:92-99`, `src/services/visualops.ts:116-123`  

`reuploadUrl` and chart-image backup download full response bodies without a maximum byte count, timeout specific to downloads, redirect limit, or hostname/address policy. Current call paths mostly use user-supplied URLs or Notion-returned URLs, but this remains a denial-of-service and SSRF-hardening gap if expanded.

**Recommendation:** Centralize outbound fetches. Require HTTPS by default, block loopback/link-local/private IPs after DNS resolution, cap redirects and bytes, enforce content-type and timeout, and stream to bounded storage.

### P2-06 — Environment configuration is not validated at startup

**Locations:** `src/services/notion.ts:6-13`, `src/services/files.ts:34-39`  

`NOTION_TIMEOUT_MS` can become `NaN`, the API version override is unconstrained, timezone errors may appear late, and writable state/upload locations are not health-checked.

**Recommendation:** Parse all configuration through one Zod schema at startup, print a redacted configuration summary, and expose `notion_health`/`notion_doctor` for permissions, API version, writable paths, renderer, upload, and automation deployment checks.

### P2-07 — Tool response truncation can produce invalid JSON

**Location:** `src/tools/util.ts:33-52`  

The structured shrinking loop usually preserves JSON, but the final fallback slices serialized JSON text. The accompanying comment says results keep valid JSON, which is not guaranteed.

**Impact:** A model may be unable to parse a large response and cannot reliably distinguish omitted data.

**Recommendation:** Always return a valid envelope with `items`, `truncated`, `next_cursor`, and a compact summary. Add true pagination to history, views, aggregates, and large previews rather than character-based mutation.

### P2-08 — View listing truncates silently and does N+1 reads

**Location:** `src/tools/visuals.ts:61-72`  

The list fetches one page, reports the API result count, but retrieves details only for the first 50 views. It neither paginates nor clearly marks omitted items and performs a retrieve per view.

**Recommendation:** Return lightweight list data directly where possible, paginate, expose a cursor, and label truncation. Bound concurrent detail reads if retrieval is necessary.

### P2-09 — Undo is best-effort but advertised too absolutely

**Locations:** `README.md`, `src/services/journal.ts`  

The README says the server “can undo anything it did,” while later documentation lists exceptions. Schema undo lacks concurrency checks, same-minute edits are undetectable, some previous images cannot be restored, entries roll off after 500, and interrupted writes can occur before journal recording.

**Recommendation:** Change the headline to “records best-effort undo for supported writes.” Journal intent before execution, then finalize it; surface undo coverage per tool response (`full`, `partial`, `none`) and retention status.

### P2-10 — The journal is written after remote effects

**Locations:** write tools throughout `src/tools/*`; `src/services/journal.ts:61-77`  

Most tools perform Notion writes and only then call `record`. A process crash, disk-full error, or permission failure between those operations leaves a remote effect with no undo entry.

**Recommendation:** Use a write-ahead operation record: persist planned operation and snapshots first, execute, append resulting ids, then mark committed. Provide recovery for `running` entries discovered on startup.

### P2-11 — Run “write budget” measures rows, not writes

**Location:** `src/services/automations.ts:473-474,585-622`  

A row with several actions and many appended blocks consumes one unit. Follow-up actions consume none. The name and documentation imply a cap on writes, but it is not one.

**Recommendation:** Rename it `max_rows` or account for every remote mutation/request. Add separate limits for rows, API calls, uploaded bytes, created blocks, and wall time.

### P2-12 — Operational logs are local, capped in the tool, and failures can disappear

**Locations:** `src/services/automations.ts:686-707`, `src/tools/automations.ts:146-153`  

Run-log write failures are swallowed. History returns only 20 records and parses JSON lines without isolating malformed entries. There are no metrics, correlation ids, structured log levels, or notification sinks beyond a GitHub issue on job failure.

**Recommendation:** Add run and step ids to every log and tool result; provide paginated history; emit structured stderr logs; add OpenTelemetry hooks and configurable notification actions; make audit-log failure visible without necessarily failing completed business work.

### P2-13 — Supply-chain controls need strengthening

**Locations:** `.github/workflows/*.yml`, `package-lock.json`  

Actions are pinned to mutable major tags, dependency review is not in CI, release artifacts have no checksums or attestations, and the advisory scan currently reports 7 development-chain vulnerabilities (1 high, 2 moderate, 4 low). The high advisory is under the bundle CLI’s interactive dependency chain; the moderate issue is in Vitest. They are not production runtime dependencies in the packed server, but should still be managed.

**Recommendation:** Pin Actions to commit SHAs, enable Dependabot/Renovate and dependency review, upgrade Vitest to a fixed release after compatibility testing, track the unpatched MCPB chain, generate SBOMs, sign/provenance-attest releases, and publish checksums.

### P2-14 — Release CI does not run the full quality gate or install-test the artifact

**Location:** `.github/workflows/release.yml:18-30`  

The bundle job runs tests and bundle construction but omits lint/typecheck and does not unpack and launch the produced MCPB. Manifest/tool compatibility is not verified through an actual host handshake.

**Recommendation:** Run `npm run check`, pack, unpack into a clean directory, launch the server, perform MCP initialize/list-tools, verify all 29 tool schemas, and render a chart. Add the same smoke on every target OS.

### P2-15 — GitHub failure reporting assumes a pre-existing label

**Location:** `.github/workflows/automations.yml:82-96`  

Creating an issue with `labels: ["notion-automations"]` fails when the label does not exist. The failure-report step then fails while trying to report the original failure.

**Recommendation:** Create/ensure the label first, omit it if unavailable, and write a job-summary fallback.

### P2-16 — Single-token, single-process architecture limits team and hosted use

**Locations:** `src/services/notion.ts`, `src/index.ts`  

There is one process-global Notion client and one token from environment variables. Transport is stdio only. There is no tenant isolation, OAuth, per-user authorization, audit identity, or remote deployment mode.

**Recommendation:** Keep local stdio as the safe default. If team/hosted use is a goal, design a separate authenticated service with OAuth token vaulting, tenant-specific clients/state/rate limits, authorization scopes, and an HTTP streaming transport. Do not retrofit multi-tenancy into the current global state.

### P2-17 — Fetched Notion content is not explicitly marked as untrusted

**Locations:** read-tool descriptions and server instructions in `src/index.ts`  

Pages can contain instructions intended to manipulate the calling model. This is not unique to this project, but a comprehensive MCP should tell clients that retrieved content is data, not authority, particularly before destructive writes or external actions.

**Recommendation:** Add server instructions and response metadata stating that Notion content is untrusted. Require explicit confirmation for high-impact bulk/schema/trash operations and never derive credentials or authorization changes from page content.

### P2-18 — Large database duplication has no operation budget or progress contract

**Locations:** `src/services/dbcopy.ts:179-217`, `src/services/copy.ts:198-204`  
**Category:** performance, usability, operability  
**Introduced:** v0.8.0

Copying up to 500 rows per data source can require full-property reads, page creation, recursive block reads/appends, and a second relation-update pass. The global rate limiter protects Notion, but the operation exposes no estimate, progress notification, cancellation checkpoint, elapsed-time budget, or resume token. A complex database can exceed host or workflow timeouts after creating substantial partial output.

**Recommendation:** Extend dry run with estimated rows, blocks, uploads, and API calls. Add `max_rows`, `max_blocks`, and `copy_row_content` controls; emit MCP progress; support cancellation; persist a resumable copy operation; and return an explicit partial result with created-object counts and undo coverage.

### P3 findings

| ID | Gap | Location | Recommendation |
|---|---|---|---|
| P3-01 | `skipLibCheck` reduces protection against dependency type drift | `tsconfig.json:10` | Keep for build speed if needed, but add a scheduled strict dependency-contract build or targeted type adapters. |
| P3-02 | Extensive `as never` casts bypass SDK request type checking | throughout services/tools | Centralize thin typed adapters for new Notion endpoints and remove casts as SDK types mature. |
| P3-03 | Tool annotations default writes to `idempotentHint: true`, then override inconsistently | `src/tools/util.ts:74-76` | Declare annotations per tool and test them; a misleading hint can affect agent retries. |
| P3-04 | No coverage thresholds or mutation/property tests | test configuration | Add branch coverage gates plus fuzz/property tests for Markdown, filters, CSV, schedules, and persisted-state parsers. |
| P3-05 | No formal support/deprecation policy | README/package | Publish supported Node/host/API versions, migration policy, and compatibility matrix. |
| P3-06 | No changelog/release enforcement | release workflow | Verify version, manifest, changelog, tag, and generated bundle metadata agree. |
| P3-07 | Chart images now have three surfaces but remain raster-only and lack accessible descriptions | chart service and README visual guidance | Add SVG, reusable theme tokens, alt text/data-table fallbacks, and render metadata. |
| P3-08 | Automation rule editing has no revision/conflict token | `notion_automation` | Return file revision and require `expected_revision` for updates. |

## Usability review

### What is good

- Tool names are predictable and descriptions are unusually detailed.
- Dry-run defaults on bulk/destructive operations are appropriate.
- Errors commonly explain how to fix sharing, auth, schema, and input problems.
- Markdown is a strong agent-facing authoring format and reduces tool-call verbosity.
- Report and chart tools provide useful high-level outcomes instead of requiring dozens of block calls.
- The README explains many real Notion API limitations instead of hiding them.

### What should improve

1. **Add a doctor tool.** A single `notion_doctor` should check credentials, capabilities, shared test page, upload directories, local state, chart renderer, rules deployment, API version, and scheduler freshness.
2. **Return structured envelopes.** Every tool should use consistent `status`, `summary`, `data`, `warnings`, `undo`, `pagination`, and `next_actions` fields.
3. **Split the automation tool.** One action-dispatch tool is compact but hard for models and permission systems. Prefer `notion_automation_list`, `validate`, `save`, `run`, and `history`, or at least expose read-only management separately from destructive execution.
4. **Provide recipes/prompts.** Ship MCP prompts or documented playbooks for a weekly executive report, campaign calendar, content brief, project dashboard, research synthesis, and chart selection.
5. **Preview complex content.** Add a plan/diff representation before building a large page or report, with estimated blocks, uploads, API calls, and unsupported features.
6. **Expose capability discovery.** A `notion_capabilities` response should reflect the configured integration capabilities and current Notion API, not only static README claims.
7. **Make deployment explicit.** Clearly distinguish local interactive mode, local scheduled mode, GitHub runner mode, and a future webhook service mode.

## Recommended target architecture

### Core layers

1. **MCP interface:** small, stable, versioned tools plus prompts/resources.
2. **Domain service:** typed operations for content, data, visuals, and workflow steps.
3. **Execution engine:** durable run/step state, idempotency keys, retries, compensation, budgets, and cancellation.
4. **Persistence:** SQLite locally; pluggable durable backend for hosted/GitHub modes.
5. **Notion adapter:** typed API-version adapter with contract tests and capability detection.
6. **Rendering engine:** page-template compiler plus high-level charts and restricted Vega-Lite.
7. **Observability:** structured logs, run history, health checks, metrics hooks, and notification sinks.

### Automation execution contract

Every run should have:

- immutable rule version and occurrence/idempotency key;
- `pending → running → partial/succeeded/failed/cancelled` status;
- per-step attempts, timestamps, inputs hash, outputs, and errors;
- configurable retry/backoff/timeout;
- resume after process restart;
- completion marker written last;
- write-ahead undo/compensation metadata;
- explicit behavior for partial success;
- audit identity and redacted logs.

## Capability roadmap

### Recommended next work, in order

| Order | Work package | Why now | Estimated effort | Exit signal |
|---|---|---|---|---|
| 1 | Fix P1-09/P1-10 and add database-copy failure/fidelity tests | Newly shipped user-data correctness risk | 2–4 engineering days | Permission/network errors fail accurately; every omitted row child is reported or copied |
| 2 | Correct automation commit semantics (P1-01/P1-02/P1-06) | Highest business-risk behavior | 1–2 engineering weeks | Failed steps resume; completion markers and schedule watermarks advance only after required success |
| 3 | Transactional persistence and write-ahead journal (P1-03/P1-04/P1-08/P2-10) | Foundation for reliable unattended work | 2–4 engineering weeks | Crash/concurrency/corruption suite passes without duplicate effects or lost history |
| 4 | Move rules/state outside bundles and add doctor/import/export | Removes a major Cowork/Desktop usability trap | 3–6 engineering days | Upgrade preserves rules; doctor verifies deployment and storage |
| 5 | Live CI and packaged-host smoke matrix | Detects Notion and distribution drift | 3–5 engineering days | Nightly trusted live suite plus clean unpack/initialize/list-tools/render test on four platforms |
| 6 | Structured results, pagination, progress, and cancellation | Makes large operations reliably usable by agents | 1–2 engineering weeks | All long operations return machine-readable partial/failure state and support progress/cancel |
| 7 | Template/content composition system | Highest-leverage content expansion | 2–4 engineering weeks | Reusable versioned templates render with preview/diff and variables |
| 8 | Advanced accessible visualization layer | Delivers the requested complex-graph breadth | 2–4 engineering weeks | Safe advanced specs, wider chart catalog, SVG, themes, and accessible fallbacks |
| 9 | Webhooks and external workflow actions | Valuable only after execution is durable | 3–6 engineering weeks | Deduplicated queued events, retries, approvals, and dead-letter recovery |

Effort ranges are directional for one engineer familiar with the codebase and exclude product design, external security review, and Notion API lead time.

### Phase 0 — Correctness and durability (release blocker)

- Fix P1-01 through P1-10.
- Move mutable state out of the package/repository default.
- Add transactional persistence and write-ahead journaling.
- Add structured failure statuses and correct MCP `isError` behavior.
- Add live nightly and packaged-artifact smoke suites.

**Exit criteria:** Kill the runner at any step, restart it, and prove it neither loses the action nor repeats a non-idempotent effect. Corrupt each state file and prove the runner stops with recovery guidance.

### Phase 1 — Content system

- Declarative page/template specification.
- Reusable components and brand/design tokens.
- Variables, loops, conditionals, and named data bindings.
- Preview/diff and block/API-call estimates.
- Export/import templates and example libraries.
- HTML/PDF/image artifact attachment where supported.

**Exit criteria:** Claude can build a repeatable executive report, content brief, launch plan, and research dossier from templates without hand-authoring dozens of block calls.

### Phase 2 — Visualization system

- Expanded safe chart catalog.
- Restricted advanced Vega-Lite input.
- SVG and PNG, responsive sizing, light/dark themes.
- Alt text, data tables, annotations, accessible palettes.
- Snapshot/golden tests across platforms.
- Hosted interactive embed adapter as an optional deployment.

**Exit criteria:** Users can express conventional business, statistical, relationship, flow, and geographic visuals, with accessible fallbacks and deterministic rendering.

### Phase 3 — Automation platform

- Webhooks plus polling fallback.
- Typed multi-step workflows with branching and references.
- External connectors through allowlisted adapters/webhooks.
- Approvals and human-in-the-loop pauses.
- Dead-letter queue, retries, replay, cancellation, and notifications.
- Secrets references, never plaintext rule values.

**Exit criteria:** A failed workflow is visible, resumable, and replayable; every external effect has an idempotency story.

### Phase 4 — Team/hosted readiness

- OAuth and tenant isolation.
- Remote authenticated transport.
- Role-based authorization and policy controls.
- Durable hosted persistence and queue.
- SLOs, metrics, alerting, backups, retention, and disaster-recovery tests.

## Suggested acceptance matrix

| Dimension | Required test |
|---|---|
| Hosts | Claude Desktop, Cowork, Claude Code; clean install and upgrade |
| Platforms | macOS ARM/x64, Windows x64, Linux x64 |
| API | Pinned Notion version plus explicit upgrade-canary suite |
| Failure | Timeout before/after every remote write; process kill between remote write and journal commit |
| Concurrency | Two MCP processes updating journal, rules, chart store, and state |
| State | Missing, malformed, truncated, permission-denied, disk-full, stale-version |
| Scale | Max rows, blocks, rich-text segments, relations, files, chart points, and output size |
| Security | Path traversal, symlinks, SSRF, oversized downloads, malicious CSV/Markdown, prompt injection |
| Automation | Duplicate event, late event, retry, partial step, overlapping occurrence, clock/DST changes |
| Undo | Full, partial, unsupported, conflict, same-minute edit, expired file, retention boundary |
| Packaging | Pack, unpack, initialize MCP, list tools, render chart, write/read fixture |
| Accessibility | Chart alt text, palette contrast, data-table fallback, dark/light output |

## Definition of “production standard” for this project

A release should not be called production-ready until:

- all P1 findings are fixed and regression-tested;
- the live acceptance suite passes on a disposable Notion workspace;
- packaged bundles pass host-level smoke tests on every supported platform;
- automation runs are durable, resumable, and idempotent across crashes;
- corrupt or unavailable persistence fails closed with recovery instructions;
- every tool has accurate annotations and structured success/partial/failure output;
- dependency and GitHub Action supply-chain gates are enabled;
- user rules and state survive upgrades;
- supported capabilities and unavoidable Notion limitations are documented precisely.

## Reusable comprehensive audit prompt for Claude Cowork or Claude Code

Copy the prompt below into Claude Cowork or Claude Code from the repository root. It is designed to prevent a shallow feature-list review and to produce evidence-backed remediation work.

```text
You are the principal engineer and product-systems auditor for this Notion MCP server. Perform a comprehensive, evidence-backed audit of the entire repository. Do not implement fixes unless I explicitly ask after reviewing the audit.

Primary product goal
This MCP must let Claude Cowork and Claude Code safely create, edit, organize, visualize, and automate sophisticated Notion work: pages, databases, reusable content systems, reports, dashboards, charts, diagrams, media, and durable multi-step workflows. It should be reliable enough for unattended scheduled or event-driven automation, while being understandable for a non-engineer.

Required procedure
1. Read all repository instructions and documentation first.
2. Record the exact commit, version, runtime, and date audited.
3. Inventory every MCP tool, prompt, resource, transport, persistent store, workflow, script, test, and release artifact. Trace registrations to implementations; do not infer capability from the README alone.
4. Install only locked dependencies and run every available quality check: lint, typecheck, unit/integration tests, build, package/bundle validation, security/advisory scan, and documented evals. Clearly separate checks you ran from checks you could not run and explain why.
5. If a disposable Notion token/workspace is available, run live tests only in that fixture. Seed uniquely named data, verify every effect through independent reads, and clean up. Never use production pages for destructive tests.
6. Trace all write paths, partial-write paths, retries, rate limits, timeouts, pagination, output truncation, local file reads, URL fetches, uploads, undo, state persistence, and automation scheduling.
7. Test or reason explicitly about process crashes, concurrent MCP clients, malformed/corrupt state, disk-full/permission errors, network ambiguity after writes, duplicate events, clock changes/DST, API-version drift, package upgrades, and GitHub Actions cache loss.
8. Compare the implementation against current MCP and official Notion API documentation. Cite the exact authoritative source and date for any external claim. Treat README claims as hypotheses until verified.
9. Evaluate usability in Claude Desktop, Cowork, and Claude Code: installation, discovery, tool descriptions, schema ergonomics, error recovery, previews, confirmations, progress, pagination, structured output, and non-technical guidance.
10. Evaluate capability against the matrix below and identify both defects and missing product capabilities.

Audit dimensions
- Correctness and data integrity
- Durability, crash recovery, idempotency, and concurrency
- Security: credentials, authorization, prompt injection, file boundaries, SSRF, resource exhaustion, dependency and CI supply chain
- Notion API correctness, limits, pagination, versioning, and permission behavior
- MCP protocol correctness: schemas, annotations, errors, cancellation, progress, prompts/resources, transports
- Automation: triggers, schedules, state, retries, deduplication, branching, approvals, dead-letter handling, replay, notifications, observability
- Content: complete block/property coverage, reusable templates/components, imports/exports, rich media, accessibility, previews/diffs
- Visuals: native views, static and interactive charts, complex graph types, themes, accessibility, deterministic cross-platform rendering, refresh behavior
- Performance and scale: API-call count, N+1 patterns, memory, large files/data, bulk budgets, rate limiting
- Maintainability: architecture, typing, duplication, module boundaries, migrations, documentation, testability
- Testing and release engineering: live contract tests, failure injection, coverage, packaging, upgrades, artifact signing/provenance
- Operations: health checks, logs, metrics, run history, alerts, backups, retention, disaster recovery
- Product scope and UX for technical and non-technical users

Capability matrix to assess
- Read/search/query/aggregate
- Surgical and bulk page/block/property operations
- Database/schema/view/template lifecycle
- File/media upload and export
- Tables, columns, tabs, equations, Mermaid and diagrams
- Native charts and custom charts: bar, line, area, scatter, pie/donut, histogram, heatmap, box, waterfall, funnel, bullet, Sankey, network, treemap, map, small multiples, annotations
- Reusable report/page templates with variables, loops, conditions, design tokens, and preview
- Scheduled, conditional, event/webhook, and manual automations
- Multi-step workflows, branching, step outputs, retries, timeouts, compensation, approvals, secrets, external actions
- Undo, audit history, conflict detection, and recovery
- Local bundle, source install, GitHub runner, and future hosted/team operation

Output requirements
Create or update COMPREHENSIVE-CODE-AUDIT.md in the repository. Include:
- Executive summary and an honest readiness verdict
- Exact scope, methodology, revision, and limitations
- Capability inventory: working, partial, broken, missing
- Findings ordered P0/P1/P2/P3; every finding must include ID, category, evidence with file and line, realistic impact, reproduction/test where possible, and specific recommendation
- Explicit “what is working well” section
- Automation durability analysis and failure-state diagrams
- Content and visualization gap analysis
- Security threat model and trust boundaries
- Test/coverage and release analysis
- Prioritized remediation roadmap with dependencies, effort ranges, risk, and measurable exit criteria
- A production-readiness checklist and acceptance-test matrix
- Separate quick wins, architectural changes, and capability expansions
- No invented results, no vague “improve error handling,” and no claim unsupported by code, an executed check, or an authoritative source

At the end, summarize the ten highest-leverage changes. Do not modify application code during the audit.
```

## Ten highest-leverage changes

1. Fix database-copy error classification and disclose or copy every nested row child (P1-09/P1-10).
2. Implement transactional, resumable automation runs with completion markers written last.
3. Replace JSON persistence with durable local SQLite and a real remote-state strategy for GitHub/hosted runners.
4. Fail closed on corrupt state and add migrations, backups, and a doctor/repair flow.
5. Use write-ahead journaling so every remote effect has recovery metadata before execution.
6. Move user rules/state outside installed bundles and add import/export/deployment workflows.
7. Add nightly live Notion contract tests and packaged-host smoke tests on all platforms.
8. Normalize structured tool outcomes and add progress/cancellation for long copies and automations.
9. Build declarative content templates and an accessible advanced visualization layer.
10. Add webhook/event execution, durable queues, retries, approvals, and external actions only after the durability foundation is complete.

## Final verdict

**Use today:** Good for supervised, single-user Claude-driven Notion work, including richer page/database duplication and themed report charts, plus experimentation with scheduled rules.  
**Do not yet rely on:** Unattended business-critical automations, multiple simultaneous clients sharing state, or guaranteed undo/recovery.  
**Readiness:** Strong beta / engineering preview. Version 0.8.0 materially improves capability, but it does not change the production-readiness verdict: execution and persistence semantics remain the gating work.
