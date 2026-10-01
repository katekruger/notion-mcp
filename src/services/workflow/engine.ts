// The workflow engine. A run is a durable record: each step's state (started, succeeded, failed, skipped, waiting),
// its attempts and output, saved after every change. Running a workflow walks its steps in order and skips the ones
// a previous attempt finished, so a run interrupted by a crash, a failure, an approval, or a delay continues where
// it stopped. Steps that started but never finished are retried with `resumed`, which lets creating steps find what
// the interrupted attempt already made (see actions.ts). Runs record undo for what they write, one journal entry
// per session of work.
import path from "node:path";
import { randomBytes } from "node:crypto";
import { readJson, revisionOf, updateJson } from "../store.js";
import { homeDir } from "../files.js";
import { stateDir } from "../workspace.js";
import { record, type UndoOp } from "../journal.js";
import { log } from "../log.js";
import { config } from "../../config.js";
import { isDue, toCron, nextOccurrence } from "../schedule.js";
import { normalizeId } from "../notion.js";
import { resolveDataSource } from "../schema.js";
import { actionOf, parseWorkflow, type Step, type StepAction, type Workflow } from "./schema.js";
import { redact, resolve, truthy, type Context } from "./refs.js";
import { approvalGiven, runAction } from "./actions.js";
import { notify } from "./notify.js";
import type { Rule } from "../automations.js";

// ---------- storage ----------

/** Workflow definitions: NOTION_PLUS_WORKFLOWS (the GitHub runner points it at the repo's file), else the home folder. */
export const defsFile = () => (process.env.NOTION_PLUS_WORKFLOWS ? path.resolve(process.env.NOTION_PLUS_WORKFLOWS) : path.join(homeDir(), "workflows.json"));
const runsFile = async () => path.join(await stateDir(), "workflow-runs.json");

const parseMap = (raw: unknown): Record<string, unknown> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected an object keyed by id");
  return raw as Record<string, unknown>;
};

export async function listWorkflows(): Promise<Workflow[]> {
  const all = (await readJson(defsFile(), parseMap, () => ({}))).data;
  return Object.values(all).map((w) => parseWorkflow(w));
}

export async function getWorkflow(id: string): Promise<Workflow> {
  const w = (await listWorkflows()).find((x) => x.id === id);
  if (!w) throw new Error(`No workflow "${id}". Workflows: ${(await listWorkflows()).map((x) => x.id).join(", ") || "none"}.`);
  return w;
}

export async function saveWorkflow(w: Workflow): Promise<void> {
  await updateJson<Record<string, unknown>, null>(defsFile(), parseMap, () => ({}), (all) => ({ data: { ...all, [w.id]: w }, result: null }));
}

export async function deleteWorkflow(id: string): Promise<boolean> {
  return updateJson<Record<string, unknown>, boolean>(defsFile(), parseMap, () => ({}), (all) =>
    id in all ? { data: Object.fromEntries(Object.entries(all).filter(([k]) => k !== id)), result: true } : { result: false }
  );
}

export type RunStatus = "running" | "waiting" | "succeeded" | "failed" | "cancelled";

export interface StepState {
  status: "started" | "succeeded" | "failed" | "skipped" | "waiting";
  attempts: number;
  started_at: string;
  finished_at?: string;
  out?: unknown;
  error?: string;
  /** delay: when to continue. approval: when it gives up. */
  until?: string;
  /** approval: the request comment was posted. */
  asked?: boolean;
}

export interface RunRecord {
  run_id: string;
  workflow_id: string;
  workflow_rev: string;
  status: RunStatus;
  trigger: unknown;
  inputs: Record<string, unknown>;
  steps: Record<string, StepState>;
  waiting?: { step: string; kind: "approval" | "delay"; until?: string };
  started: string;
  updated: string;
  error?: string;
  undo_ids: string[];
}

interface RunsFile {
  runs: Record<string, RunRecord>;
  /** Schedule bookkeeping per workflow: the occurrence it last started for. */
  schedules: Record<string, { last_fired?: string }>;
}

const parseRuns = (raw: unknown): RunsFile => {
  const o = raw as Partial<RunsFile> | null;
  if (!o || typeof o !== "object" || typeof o.runs !== "object" || o.runs === null) throw new Error('expected {"runs": {...}}');
  return { runs: o.runs, schedules: o.schedules ?? {} };
};
const emptyRuns = (): RunsFile => ({ runs: {}, schedules: {} });

/** Finished runs kept, newest first; waiting and running ones are always kept. */
const KEEP_FINISHED = 200;

async function saveRun(run: RunRecord): Promise<void> {
  run.updated = new Date().toISOString();
  const safe = redact(run);
  await updateJson<RunsFile, null>(await runsFile(), parseRuns, emptyRuns, (f) => {
    f.runs[run.run_id] = safe;
    const finished = Object.values(f.runs).filter((r) => r.status !== "waiting" && r.status !== "running").sort((a, b) => b.updated.localeCompare(a.updated));
    const drop = new Set(finished.slice(KEEP_FINISHED).map((r) => r.run_id));
    if (drop.size) f.runs = Object.fromEntries(Object.entries(f.runs).filter(([k]) => !drop.has(k)));
    return { data: f, result: null };
  });
}

export async function listRuns(filter: { workflow?: string; status?: RunStatus } = {}): Promise<RunRecord[]> {
  const f = (await readJson(await runsFile(), parseRuns, emptyRuns)).data;
  return Object.values(f.runs)
    .filter((r) => (!filter.workflow || r.workflow_id === filter.workflow) && (!filter.status || r.status === filter.status))
    .sort((a, b) => b.started.localeCompare(a.started));
}

export async function getRun(runId: string): Promise<RunRecord> {
  const r = (await readJson(await runsFile(), parseRuns, emptyRuns)).data.runs[runId];
  if (!r) throw new Error(`No run "${runId}".`);
  return r;
}

// ---------- execution ----------

class Paused extends Error {
  constructor(readonly step: string, readonly kind: "approval" | "delay", readonly until?: string) {
    super(`waiting at ${step}`);
  }
}

class StepFailed extends Error {
  constructor(readonly step: string, message: string) {
    super(`Step "${step}" failed: ${message}`);
  }
}

interface Exec {
  run: RunRecord;
  wf: Workflow;
  undo: UndoOp[];
  now: () => Date;
  depth: number;
}

const MAX_DEPTH = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout<T>(p: Promise<T>, seconds: number | undefined, step: string): Promise<T> {
  if (!seconds) return p;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${seconds}s (step "${step}")`)), seconds * 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runSteps(steps: Step[], ctx: Context, prefix: string, ex: Exec): Promise<void> {
  for (const step of steps) {
    const key = `${prefix}${step.id}`;
    const state = ex.run.steps[key];
    const scoped = ctx.steps as Record<string, unknown>;
    if (state && (state.status === "succeeded" || state.status === "skipped" || (state.status === "failed" && step.continue_on_error))) {
      scoped[step.id] = state.out;
      continue;
    }
    if (step.if !== undefined && !truthy(step.if, ctx)) {
      ex.run.steps[key] = { status: "skipped", attempts: 0, started_at: ex.now().toISOString(), finished_at: ex.now().toISOString() };
      await saveRun(ex.run);
      continue;
    }
    const action = actionOf(step);
    if (action === "foreach") await runForeach(step as Step & { foreach: { items: string; as?: string; steps: Step[]; max?: number } }, ctx, key, ex);
    else if (action === "switch") await runSwitch(step as Step & { switch: { on: string; cases: Record<string, Step[]>; default?: Step[] } }, ctx, key, ex);
    else if (action === "approval") await runApproval(step as Step & { approval: { page: string; property?: string; comment_keyword?: string; message?: string; expires_hours?: number } }, ctx, key, ex);
    else if (action === "delay") await runDelay(step as Step & { delay: { minutes: number } }, key, ex);
    else if (action === "run_workflow") await runChild(step as Step & { run_workflow: { id: string; with?: Record<string, unknown> } }, ctx, key, ex);
    else await runActionStep(step, ctx, key, ex);
    scoped[step.id] = ex.run.steps[key]?.out;
  }
}

async function finish(key: string, ex: Exec, out: unknown): Promise<void> {
  const s = ex.run.steps[key] ?? { status: "started", attempts: 0, started_at: ex.now().toISOString() };
  ex.run.steps[key] = { ...s, status: "succeeded", out: redact(out), finished_at: ex.now().toISOString() };
  await saveRun(ex.run);
}

async function runActionStep(step: Step, ctx: Context, key: string, ex: Exec): Promise<void> {
  const attempts = step.retry?.attempts ?? 1;
  const backoff = (step.retry?.backoff_seconds ?? 5) * 1000;
  const prev = ex.run.steps[key];
  // A step left "started" (process died) or "failed" (retried later) may have done part of its work: resume it.
  let resumed = prev?.status === "started" || prev?.status === "failed";
  let startedAt = resumed && prev ? prev.started_at : ex.now().toISOString();
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(backoff * 2 ** (i - 1));
    ex.run.steps[key] = { status: "started", attempts: (prev?.attempts ?? 0) + i + 1, started_at: startedAt };
    await saveRun(ex.run);
    try {
      const resolved = resolve(Object.fromEntries(Object.entries(step).filter(([k]) => !["id", "if", "retry", "timeout_seconds", "continue_on_error"].includes(k))), ctx) as StepAction;
      const out = await withTimeout(runAction(resolved, { undo: ex.undo, startedAt, resumed, key: `${ex.run.run_id}:${key}` }), step.timeout_seconds, step.id);
      await finish(key, ex, out);
      return;
    } catch (e) {
      lastError = redact((e as Error).message);
      log("warn", "workflow.step_failed", { run_id: ex.run.run_id, workflow: ex.wf.id, step: key, attempt: i + 1, error: lastError });
      // The failed attempt may have done part of its work; the next one checks first.
      resumed = true;
      startedAt = ex.run.steps[key].started_at;
    }
  }
  ex.run.steps[key] = { ...ex.run.steps[key], status: "failed", error: lastError, finished_at: ex.now().toISOString(), ...(step.continue_on_error ? { out: { error: lastError } } : {}) };
  await saveRun(ex.run);
  if (!step.continue_on_error) throw new StepFailed(key, lastError);
}

async function runForeach(step: Step & { foreach: { items: string; as?: string; steps: Step[]; max?: number } }, ctx: Context, key: string, ex: Exec): Promise<void> {
  const items = resolve(step.foreach.items, ctx);
  if (!Array.isArray(items)) throw new StepFailed(key, `foreach items ${step.foreach.items} isn't a list.`);
  const max = step.foreach.max ?? 200;
  if (items.length > max) throw new StepFailed(key, `${items.length} items is more than foreach max (${max}).`);
  ex.run.steps[key] ??= { status: "started", attempts: 1, started_at: ex.now().toISOString() };
  const name = step.foreach.as ?? "item";
  for (const [i, item] of items.entries()) {
    // Each iteration sees earlier steps' outputs plus its own.
    const iterCtx: Context = { ...ctx, [name]: item, index: i, steps: { ...(ctx.steps as object) } };
    await runSteps(step.foreach.steps, iterCtx, `${key}[${i}].`, ex);
  }
  await finish(key, ex, { count: items.length });
}

async function runSwitch(step: Step & { switch: { on: string; cases: Record<string, Step[]>; default?: Step[] } }, ctx: Context, key: string, ex: Exec): Promise<void> {
  const v = resolve(step.switch.on, ctx);
  const chosen = Object.keys(step.switch.cases).find((c) => c.toLowerCase() === String(v).toLowerCase());
  ex.run.steps[key] ??= { status: "started", attempts: 1, started_at: ex.now().toISOString() };
  await runSteps(chosen ? step.switch.cases[chosen] : (step.switch.default ?? []), ctx, `${key}.`, ex);
  await finish(key, ex, { value: v, case: chosen ?? "default" });
}

async function runApproval(step: Step & { approval: { page: string; property?: string; comment_keyword?: string; message?: string; expires_hours?: number } }, ctx: Context, key: string, ex: Exec): Promise<void> {
  const a = resolve(step.approval, ctx) as { page: string; property?: string; comment_keyword?: string; message?: string; expires_hours?: number };
  const now = ex.now();
  let s = ex.run.steps[key];
  if (!s) {
    s = { status: "waiting", attempts: 1, started_at: now.toISOString(), ...(a.expires_hours ? { until: new Date(now.getTime() + a.expires_hours * 3_600_000).toISOString() } : {}) };
    ex.run.steps[key] = s;
    await saveRun(ex.run);
  }
  if (a.message && !s.asked) {
    await runAction({ comment: { page: a.page, text: a.message } }, { undo: ex.undo, startedAt: s.started_at, resumed: true, key: `${ex.run.run_id}:${key}` });
    s.asked = true;
    await saveRun(ex.run);
  }
  if (await approvalGiven(a, s.started_at)) {
    await finish(key, ex, { approved: true, at: ex.now().toISOString() });
    return;
  }
  if (s.until && now.getTime() > new Date(s.until).getTime()) {
    ex.run.steps[key] = { ...s, status: "failed", error: "approval expired", finished_at: now.toISOString() };
    await saveRun(ex.run);
    throw new StepFailed(key, "approval expired");
  }
  throw new Paused(key, "approval", s.until);
}

async function runDelay(step: Step & { delay: { minutes: number } }, key: string, ex: Exec): Promise<void> {
  const now = ex.now();
  let s = ex.run.steps[key];
  if (!s) {
    s = { status: "waiting", attempts: 1, started_at: now.toISOString(), until: new Date(now.getTime() + step.delay.minutes * 60_000).toISOString() };
    ex.run.steps[key] = s;
    await saveRun(ex.run);
  }
  if (now.getTime() >= new Date(s.until as string).getTime()) {
    await finish(key, ex, { waited_until: s.until });
    return;
  }
  throw new Paused(key, "delay", s.until);
}

async function runChild(step: Step & { run_workflow: { id: string; with?: Record<string, unknown> } }, ctx: Context, key: string, ex: Exec): Promise<void> {
  if (ex.depth >= MAX_DEPTH) throw new StepFailed(key, `sub-workflows nest more than ${MAX_DEPTH} deep.`);
  const child = await getWorkflow(step.run_workflow.id);
  const inputs = { ...child.inputs, ...((resolve(step.run_workflow.with ?? {}, ctx) as Record<string, unknown>) ?? {}) };
  ex.run.steps[key] ??= { status: "started", attempts: 1, started_at: ex.now().toISOString() };
  const childCtx: Context = { ...baseContext(), trigger: ctx.trigger, inputs, steps: {} };
  await runSteps(child.steps, childCtx, `${key}/`, { ...ex, wf: child, depth: ex.depth + 1 });
  await finish(key, ex, { workflow: child.id, steps: childCtx.steps });
}

function baseContext(): Context {
  const tz = config().timezone;
  return { today: new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()), now: new Date().toISOString() };
}

/** Continue (or start) a run. Returns the record as it stands after this session. */
async function execute(run: RunRecord, wf: Workflow, now: () => Date): Promise<RunRecord> {
  const ex: Exec = { run, wf, undo: [], now, depth: 0 };
  if (run.workflow_rev !== revisionOf(JSON.stringify(wf))) {
    log("warn", "workflow.changed_mid_run", { run_id: run.run_id, workflow: wf.id });
  }
  run.status = "running";
  delete run.waiting;
  await saveRun(run);
  const ctx: Context = { ...baseContext(), trigger: run.trigger, inputs: run.inputs, steps: {} };
  try {
    await runSteps(wf.steps, ctx, "", ex);
    run.status = "succeeded";
    delete run.error;
  } catch (e) {
    if (e instanceof Paused) {
      run.status = "waiting";
      run.waiting = { step: e.step, kind: e.kind, ...(e.until ? { until: e.until } : {}) };
    } else {
      run.status = "failed";
      run.error = redact((e as Error).message);
    }
  } finally {
    if (ex.undo.length) {
      run.undo_ids.push(await record("notion_workflow", `Workflow "${wf.id}" run ${run.run_id}${run.status === "waiting" ? " (until it paused)" : ""}`, ex.undo));
    }
    await saveRun(run);
  }
  log(run.status === "failed" ? "error" : "info", "workflow.run_session", { run_id: run.run_id, workflow: wf.id, status: run.status, ...(run.error ? { error: run.error } : {}) });
  if (run.status === "failed" && wf.on_failure.length) {
    const failed = Object.entries(run.steps).filter(([, s]) => s.status === "failed").map(([k]) => k);
    await notify(wf.on_failure, `Workflow "${wf.name ?? wf.id}" run ${run.run_id} failed${failed.length ? ` at ${failed.join(", ")}` : ""}: ${run.error ?? "see its run record"}`);
  }
  return run;
}

export function newRunId(now = new Date()): string {
  return `wf-${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
}

/** Start a run of a workflow now. */
export async function startRun(wf: Workflow, opts: { trigger?: unknown; inputs?: Record<string, unknown>; now?: () => Date } = {}): Promise<RunRecord> {
  const now = opts.now ?? (() => new Date());
  const run: RunRecord = {
    run_id: newRunId(now()),
    workflow_id: wf.id,
    workflow_rev: revisionOf(JSON.stringify(wf)),
    status: "running",
    trigger: opts.trigger ?? { type: "manual" },
    inputs: { ...wf.inputs, ...(opts.inputs ?? {}) },
    steps: {},
    started: now().toISOString(),
    updated: now().toISOString(),
    undo_ids: [],
  };
  log("info", "workflow.run_started", { run_id: run.run_id, workflow: wf.id });
  return execute(run, wf, now);
}

/** Continue a waiting (or interrupted) run: re-checks approvals and delays and resumes after the last finished step. */
export async function resumeRun(runId: string, now: () => Date = () => new Date()): Promise<RunRecord> {
  const run = await getRun(runId);
  if (run.status === "succeeded" || run.status === "cancelled") throw new Error(`Run ${runId} is ${run.status}.`);
  // A failed run retries its failed step (finished ones are kept); that step runs as a resume, so it first checks
  // what the failed attempt may have created.
  return execute(run, await getWorkflow(run.workflow_id), now);
}

export async function cancelRun(runId: string): Promise<RunRecord> {
  const run = await getRun(runId);
  if (run.status === "succeeded") throw new Error(`Run ${runId} already succeeded.`);
  run.status = "cancelled";
  delete run.waiting;
  await saveRun(run);
  return run;
}

/**
 * One pass of the scheduler: resume runs that are waiting (or were interrupted while running), and start scheduled
 * workflows that are due. Called by `npm run automations` (hourly in GitHub Actions) and by the webhook server.
 */
export async function tick(now: () => Date = () => new Date()): Promise<{ resumed: RunRecord[]; started: RunRecord[] }> {
  const resumed: RunRecord[] = [];
  for (const r of await listRuns()) {
    if (r.status !== "waiting" && r.status !== "running") continue;
    // A delay that isn't due yet needs no work.
    if (r.waiting?.kind === "delay" && r.waiting.until && new Date(r.waiting.until).getTime() > now().getTime()) continue;
    try {
      resumed.push(await resumeRun(r.run_id, now));
    } catch (e) {
      log("error", "workflow.resume_failed", { run_id: r.run_id, error: (e as Error).message });
    }
  }
  const started: RunRecord[] = [];
  const tz = config().timezone;
  for (const wf of await listWorkflows()) {
    if (!wf.enabled || !wf.trigger.schedule) continue;
    const file = await runsFile();
    const last = (await readJson(file, parseRuns, emptyRuns)).data.schedules[wf.id]?.last_fired;
    const due = isDue(wf.trigger.schedule, now(), tz, last, 70 * 60_000);
    if (!due.due || !due.occurrence) continue;
    const occurrence = due.occurrence.toISOString();
    // Claim the occurrence first, so overlapping schedulers can't both start it.
    const claimed = await updateJson<RunsFile, boolean>(file, parseRuns, emptyRuns, (f) => {
      if (f.schedules[wf.id]?.last_fired === occurrence) return { result: false };
      f.schedules[wf.id] = { last_fired: occurrence };
      return { data: f, result: true };
    });
    if (claimed) started.push(await startRun(wf, { trigger: { type: "schedule", occurrence }, now }));
  }
  return { resumed, started };
}

export function nextRun(wf: Workflow): string | undefined {
  return wf.trigger.schedule ? nextOccurrence(toCron(wf.trigger.schedule), new Date(), config().timezone)?.toISOString() : undefined;
}

// ---------- webhook events ----------

export interface NotionEvent {
  id: string;
  type: string;
  timestamp?: string;
  entity?: { id: string; type: string };
  data?: { parent?: { id: string; type?: string } } & Record<string, unknown>;
}

/** Workflows a Notion event starts, and their runs. */
export async function startFromEvent(event: NotionEvent): Promise<RunRecord[]> {
  const runs: RunRecord[] = [];
  for (const wf of await listWorkflows()) {
    const w = wf.trigger.webhook;
    if (!wf.enabled || !w || !(w.events as string[]).includes(event.type)) continue;
    if (w.database) {
      const ds = await resolveDataSource(w.database);
      const ids = new Set([ds.id, (ds.parent as { database_id?: string }).database_id].filter(Boolean).map((x) => normalizeId(x as string)));
      const parent = event.data?.parent?.id;
      if (!parent || !ids.has(normalizeId(parent))) continue;
    }
    const trigger = { type: "webhook", event: event.type, event_id: event.id, at: event.timestamp, entity: event.entity, page_id: event.entity?.type === "page" ? event.entity.id : undefined, data: event.data };
    runs.push(await startRun(wf, { trigger }));
  }
  return runs;
}

// ---------- v1 rules → v2 workflows ----------

/** {{page.X}} → ${row.X}, {{today}} → ${today}, {{now}} → ${now}. */
function convertTemplates(v: unknown): unknown {
  if (typeof v === "string") return v.replace(/\{\{\s*page\.([^}]+?)\s*\}\}/g, "${row.$1}").replace(/\{\{\s*(today|now)\s*\}\}/g, "${$1}");
  if (Array.isArray(v)) return v.map(convertTemplates);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, convertTemplates(x)]));
  return v;
}

/**
 * Turn a v1 rule into an equivalent v2 workflow: a query for the rule's condition, then each row's actions in the
 * same order the runner uses (marker last). Rules with raw filters, relative dates, or chart/report follow-ups stay
 * rules; this says which part can't convert.
 */
export function convertRule(rule: Rule): Workflow {
  if (rule.when?.filter || rule.when?.relative?.length) throw new Error(`Rule "${rule.id}" uses a raw filter or relative dates, which workflows don't have yet; keep it as a rule.`);
  const unsupported = rule.then.filter((t) => !("create_page" in t));
  if (unsupported.length) throw new Error(`Rule "${rule.id}" refreshes charts or builds reports in \`then\`; keep it as a rule (or use render_template in a workflow).`);
  const steps: unknown[] = [];
  if (rule.when) {
    const where = { ...((convertTemplates(rule.when.where ?? {}) as object) ?? {}), ...(rule.marker ? { [rule.marker]: false } : {}) };
    steps.push({ id: "rows", query: { database: rule.database, ...(rule.data_source_name ? { data_source_name: rule.data_source_name } : {}), where, limit: rule.limit } });
    const rowSteps: unknown[] = [];
    rule.actions.forEach((a, i) => {
      if ("set" in a) rowSteps.push({ id: `set_${i}`, set: { page: "${row}", values: convertTemplates(a.set), ...(rule.allow_new_options ? { allow_new_options: true } : {}) } });
      if ("append" in a) rowSteps.push({ id: `append_${i}`, append: typeof a.append === "string" ? { page: "${row}", markdown: convertTemplates(a.append) } : { page: "${row}", blocks: a.append } });
      if ("comment" in a) rowSteps.push({ id: `comment_${i}`, comment: { page: "${row}", text: convertTemplates(a.comment) } });
    });
    if (rule.marker) rowSteps.push({ id: "mark", set: { page: "${row}", values: { [rule.marker]: true } } });
    if (rule.actions.some((a) => "trash" in a)) rowSteps.push({ id: "trash", trash: { page: "${row}" } });
    if (rowSteps.length) steps.push({ id: "each_row", foreach: { items: "${steps.rows.rows}", as: "row", steps: rowSteps, max: 500 } });
  }
  rule.then.forEach((t, i) => {
    if ("create_page" in t) {
      const c = convertTemplates(t.create_page) as { parent: string; title: string; properties?: Record<string, unknown>; markdown?: string };
      steps.push({ id: `create_page_${i}`, ...(rule.when ? { if: "${steps.rows.rows}" } : {}), create_page: c });
    }
  });
  return parseWorkflow({
    version: 2,
    id: rule.id,
    ...(rule.name ? { name: rule.name } : {}),
    enabled: false,
    trigger: { schedule: rule.schedule ?? "hourly" },
    steps,
  });
}
