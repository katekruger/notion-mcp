# Audit status at 1.0.0

This page maps each finding in [COMPREHENSIVE-CODE-AUDIT.md](../COMPREHENSIVE-CODE-AUDIT.md) (written against v0.8.0) to the code that addresses it and the test that shows it. It was checked against the code, not against the changelog. That check found one finding (P3-01) the changelog wrongly listed as fixed; it is fixed in 1.0.0.

**Status key**

| Status | Meaning |
|---|---|
| **fixed** | The code addresses the finding, and a test or CI job shows it. |
| **mitigated** | The risk is handled another way, or the safeguard needs a setting to take effect. |
| **partial** | The core problem is fixed; the remaining work is under [Known limitations](#known-limitations). |
| **designed** | A design doc only, by plan. |

**Totals:** 27 fixed, 7 partial, 1 mitigated, 1 designed.

| ID | Finding | Status | Where | Shown by |
|---|---|---|---|---|
| P1-01 | A half-done row counted as processed | fixed | `services/automations.ts`: row steps, checkpoints, marker in the commit step | `runner.test.ts` "a row that fails mid-way isn't marked, and the next run resumes at the failed step"; "row steps run in order with the marker written last" |
| P1-02 | A failed occurrence counted as fired | fixed | `automations.ts`: pending firings, `last_fired` only on success, `waive` | `runner.test.ts` "a scheduled occurrence only counts as fired once all of it succeeded; waive gives up on it" |
| P1-03 | Corrupt state read as empty | partial | `services/store.ts` `readJson`: `StateCorruptError`, file left in place, `.bak` | `store.test.ts` "readJson: missing is empty; bad JSON and bad contents stop with a recovery message…"; `properties.test.ts` "state files: non-empty garbage is never read as empty state" |
| P1-04 | Concurrent processes lose updates | fixed | `store.ts` `withLock`, `writeJson` (temp, fsync, rename), `updateJson`; one folder per integration | `store.test.ts` "updateJson: two processes incrementing 100 times each lose no updates" |
| P1-05 | Bundle rules vs repository rules | fixed | Rules in the home folder by default; `NOTION_PLUS_RULES` to opt in; export, import and deploy actions | `tools.test.ts` "rules live in the home folder by default, and export → import carries them to another machine" |
| P1-06 | A failed run returns MCP success | fixed | `tools/automations.ts`: `isError` unless every rule succeeded | `runner.test.ts` "notion_automation run is an error unless every rule succeeded…" |
| P1-07 | No live API gate in CI | mitigated | `.github/workflows/live.yml` (nightly, on tags, manual) | Passes with a notice until the `NOTION_TOKEN` and `NOTION_TEST_PAGE` secrets are set. **No live run has been made for 1.0.0.** |
| P1-08 | Automation state kept in the GitHub cache | fixed | `automations.yml` keeps state on the `notion-automations-state` branch; `--require-state` | `tools.test.ts` "the scheduled runner stops instead of starting fresh when required state is missing" |
| P1-09 | Database read failures taken for linked views | fixed | `services/dbcopy.ts` `readDatabase`: only not-found means "linked view" | `copy.test.ts` "readDatabase: not-found means an unreadable view; every other failure is thrown" (401, 403, 429, 500, 503, timeout) |
| P1-10 | Nested row content dropped silently | fixed | `services/copy.ts`: rows copied recursively, `status: partial` with reasons | `copy.test.ts` "duplicatePage copies row content recursively and reports what rows couldn't carry" |
| P2-01 | Polling only | fixed | `services/webhooks.ts`, `webhook-server.ts`, `Dockerfile` | `webhooks.test.ts` (3 tests); the CI `docker` job |
| P2-02 | Automation actions too narrow | partial | `services/workflow/*`: workflow spec v2, 18 step types | `workflows.test.ts` (steps, refs, loops, approval, delay, sub-workflows, HTTP allow-list) |
| P2-03 | Narrow chart catalog | partial | `services/charts.ts` (22 types), `graphlayout.ts`, raw `vega_lite` with a theme | `charts.test.ts` "every new chart type compiles and renders to SVG"; SVG snapshots |
| P2-04 | Reports are a fixed recipe | fixed | `services/templates.ts`, 5 built-in templates, including `database-report` | `templates.test.ts` (10 tests) |
| P2-05 | No egress policy | fixed | `services/fetch.ts` `safeFetch`, used for every outbound download and HTTP step | `fetch.test.ts` (3 tests) |
| P2-06 | Config not checked at startup | fixed | `config.ts`, `notion_doctor`, `notion_capabilities` | `envelope.test.ts` "config: defaults, and every bad value named at once"; `tools.test.ts` "notion_doctor reports a bad token…" |
| P2-07 | Truncation breaks JSON | fixed | `tools/util.ts` `renderEnvelope`, `fitToLimit` | `envelope.test.ts` "large results shrink lists inside data and always stay valid JSON under the limit" |
| P2-08 | View list truncates; one read per view | fixed | `tools/visuals.ts`: cursor and limit; details read only for the returned page, a few at a time | `tools.test.ts` "notion_views list pages through views and reads details only for the page it returns" |
| P2-09 | Undo promised too broadly | fixed | README "Undo coverage"; `undo.coverage` in every result | `envelope.test.ts` "known fields are lifted to fixed places…" |
| P2-10 | Journal written after the remote change | partial | `services/journal.ts`: an intent is written before the first write; unfinished ones show as `interrupted` | `store.test.ts` "journal: a process that dies mid-write leaves an interrupted entry with its input" |
| P2-11 | Write budget counts rows | fixed | Limits on rows, requests, blocks and minutes | `runner.test.ts` "run limits leave the remaining rows for the next run and report partial" |
| P2-12 | Logs local; failures disappear | partial | `services/log.ts` (JSON lines with run ids), run-log failures become warnings, `NOTION_PLUS_NOTIFY` | `runner.test.ts` "…history pages and skips bad lines" |
| P2-13 | Supply chain | fixed | Actions pinned to commit SHAs, Dependabot, dependency review, `npm audit` | CI |
| P2-14 | Release not gated or install-tested | fixed | `release.yml`: `npm run check`, then bundle smoke on 4 operating systems, checksums, SBOM, provenance | CI |
| P2-15 | Failure report needs an existing label | fixed | `automations.yml` creates the label, with a job-summary fallback | CI |
| P2-16 | One token, one process | designed | [hosted-design.md](hosted-design.md) | Not built, by plan |
| P2-17 | Notion content not marked untrusted | fixed | `index.ts` server instructions; `UNTRUSTED` warning on results with page text | `tools.test.ts` "read results that carry page text are marked as untrusted data" |
| P2-18 | Large database copy has no budget | partial | Dry-run estimate, `max_rows`, `copy_row_content` | `copy.test.ts` "copy_row_content off skips row content and says so" |
| P3-01 | `skipLibCheck` | fixed (1.0.0) | `tsconfig.json`: `skipLibCheck: false`; dependency types are checked on every build | `npm run check` |
| P3-02 | `as never` casts | partial | Typed request adapters in `services/notion.ts` | About 39 casts remain |
| P3-03 | Default tool annotations | fixed | Annotations set per tool | `annotations.test.ts` (2 tests) |
| P3-04 | Coverage and property tests | fixed | Coverage thresholds raised in 1.0.0 to just below current (statements 59, branches 48, functions 62, lines 62); fast-check property tests | `properties.test.ts`; `vitest.config.ts` |
| P3-05 | Support policy | fixed | [SUPPORT.md](../SUPPORT.md) | — |
| P3-06 | Release consistency | fixed | `scripts/check-version.mjs` in CI and release | CI |
| P3-07 | Raster-only charts, no alt text | fixed | SVG output, generated alt text, data tables, palettes | `charts.test.ts` "charts describe themselves for alt text and data tables" |
| P3-08 | No revision token on rule edits | fixed | `editRules`, `expected_revision` | `store.test.ts` "rules: edits apply to the current file, and expected_revision refuses a stale edit" |

**About P1-09.** `isNotFound` also counts Notion's `validation_error` as not found. That's deliberate: asking for a data source by a database's id returns `validation_error`, and that error is how lookups fall back to reading the database. Real failures stay errors: auth, permissions, rate limits, server errors and timeouts. The test covers each of them.

## Known limitations

These are the remaining parts of the partial findings, plus what wasn't verified. Each is a candidate for a 1.x minor release.

### Not verified for 1.0.0
- **No live run.** The live Notion suites (`npm run smoke`, `npm run acceptance`) have not been run against a real workspace for 1.0.0.
  - Everything is tested against fake Notion clients.
  - To run them, add the `NOTION_TOKEN` and `NOTION_TEST_PAGE` repository secrets and trigger `live.yml`.
- **Docker image.** It is checked only by the CI `docker` job: it builds, answers `/healthz`, and rejects unsigned deliveries.

### Open work from partial findings
- **P1-03 (state files):** no `repair` command, no versioned format on disk, and only one backup.
- **P2-10 (write-ahead journal):** it records the tool's input before writing, but not snapshots or the ids of objects it creates. Interrupted entries are flagged for checking by hand, not recovered automatically.
- **P2-18 (large database copies):** no `max_blocks`, no progress notifications, no cancellation, and a copy can't be resumed. A copy that fails part-way throws, without counts of what it created.
- **P2-02 (workflow steps):** missing email, block patch/delete, relation sync, view maintenance and file upload steps.
- **P2-03 (charts):** no geographic maps, confidence bands or date-format option. Brand theming covers palettes only.
- **P2-12 (operations):** no OpenTelemetry or metrics hooks, and no correlation ids outside automations.
- **P3-02 (typing):** the remaining `as never` casts.
- **Smaller items:**
  - downloads don't check the content type against an allow-list;
  - `notion_aggregate` has no pagination;
  - the undo coverage map is lost on restart;
  - automations have no limit on uploaded bytes.
