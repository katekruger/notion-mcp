import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadRules } from "../services/automations.js";
import {
  cancelRun,
  convertRule,
  defsFile,
  deleteWorkflow,
  getRun,
  getWorkflow,
  listRuns,
  listWorkflows,
  nextRun,
  resumeRun,
  saveWorkflow,
  startRun,
  type RunRecord,
} from "../services/workflow/engine.js";
import { ACTIONS, parseWorkflow, WEBHOOK_EVENTS } from "../services/workflow/schema.js";
import { discardEvent, listEvents, replayEvent } from "../services/webhooks.js";
import { ok, safe, WRITE } from "./util.js";

function runSummary(r: RunRecord) {
  return {
    run_id: r.run_id,
    workflow: r.workflow_id,
    status: r.status,
    started: r.started,
    updated: r.updated,
    ...(r.waiting ? { waiting: r.waiting } : {}),
    ...(r.error ? { error: r.error } : {}),
    steps: Object.fromEntries(Object.entries(r.steps).map(([k, s]) => [k, s.status + (s.attempts > 1 ? ` (${s.attempts} attempts)` : "") + (s.error ? `: ${s.error}` : "")])),
    ...(r.undo_ids.length ? { undo_ids: r.undo_ids } : {}),
  };
}

export function registerWorkflowTools(server: McpServer): void {
  server.registerTool(
    "notion_workflow",
    {
      title: "Workflows",
      description:
        "Multi-step workflows (version 2 of automations): a trigger (manual, schedule, or Notion webhook events) and typed " +
        `steps run in order. Step actions: ${ACTIONS.join(", ")}. Each step has an id; may have \`if\` (a \${…} reference), ` +
        "`retry` {attempts, backoff_seconds}, `timeout_seconds`, and `continue_on_error`. Steps read earlier outputs with " +
        "${steps.<id>.<path>} (query returns rows with id, url, title, and each property), the trigger with ${trigger.*}, inputs " +
        "with ${inputs.*}, loop items with ${item} (or the foreach `as` name), and secrets with ${secret:NAME} " +
        "(environment variable NOTION_PLUS_SECRET_NAME; never stored or shown). approval pauses until a checkbox is checked or a " +
        "comment with a keyword is posted; delay pauses for minutes; both resume on the next scheduler pass. Runs are durable: " +
        "a crash, failure, or pause resumes after the last finished step, and creating steps check what an interrupted attempt " +
        "already made, so nothing is created twice. http and slack steps only reach hosts in NOTION_PLUS_HTTP_ALLOW (Slack's " +
        "hook host is always allowed for slack). `on_failure` notifies Slack, an HTTP endpoint, or a page comment. Actions: list, " +
        "get, save, delete, validate, run (now, with `inputs`), runs (history), run_status, resume (continue a waiting or failed " +
        "run), cancel, convert (a v1 rule into a workflow, saved disabled), events / replay / discard (the webhook queue and its " +
        `dead letters). Webhook events: ${WEBHOOK_EVENTS.join(", ")}.`,
      inputSchema: {
        action: z.enum(["list", "get", "save", "delete", "validate", "run", "runs", "run_status", "resume", "cancel", "convert", "events", "replay", "discard"]),
        id: z.string().optional().describe("Workflow id (get, delete, run, runs, convert: the rule id)."),
        workflow: z.record(z.string(), z.unknown()).optional().describe("save / validate: the whole workflow spec."),
        inputs: z.record(z.string(), z.unknown()).optional().describe("run: values for ${inputs.*}."),
        run_id: z.string().optional(),
        event_id: z.string().optional(),
        status: z.enum(["running", "waiting", "succeeded", "failed", "cancelled", "queued", "done", "dead"]).optional().describe("runs / events: filter."),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { ...WRITE, destructiveHint: true },
    },
    safe(async (a) => {
      const need = <T>(v: T | undefined, what: string): T => {
        if (v === undefined) throw new Error(`action=${a.action} needs \`${what}\`.`);
        return v;
      };
      switch (a.action) {
        case "list": {
          const all = await listWorkflows();
          if (!all.length) return ok(`No workflows yet in ${defsFile()}. Save one with action=save, or convert a rule with action=convert.`);
          return ok({
            file: defsFile(),
            workflows: all.map((w) => ({ id: w.id, ...(w.name ? { name: w.name } : {}), enabled: w.enabled, trigger: w.trigger, steps: w.steps.length, ...(nextRun(w) ? { next_run: nextRun(w) } : {}) })),
          });
        }
        case "get":
          return ok({ workflow: await getWorkflow(need(a.id, "id")) });
        case "validate": {
          const w = parseWorkflow(need(a.workflow, "workflow"));
          return ok({ valid: true, id: w.id, steps: w.steps.length, trigger: w.trigger, ...(nextRun(w) ? { next_run: nextRun(w) } : {}) });
        }
        case "save": {
          const w = parseWorkflow(need(a.workflow, "workflow"));
          await saveWorkflow(w);
          return ok({ saved: w.id, file: defsFile(), enabled: w.enabled, ...(nextRun(w) ? { next_run: nextRun(w) } : {}) });
        }
        case "delete":
          return ok((await deleteWorkflow(need(a.id, "id"))) ? { deleted: a.id } : `No workflow "${a.id}".`);
        case "run": {
          const w = await getWorkflow(need(a.id, "id"));
          const r = await startRun(w, { trigger: { type: "manual" }, inputs: a.inputs ?? {} });
          const body = { ...runSummary(r), ...(r.status === "waiting" ? { next_step: "The run is paused; it continues on the next scheduler pass, or call action=resume after approving." } : {}) };
          return r.status === "failed" ? { ...ok(body), isError: true } : ok(body);
        }
        case "runs": {
          const runs = await listRuns({ ...(a.id ? { workflow: a.id } : {}), ...(a.status && ["running", "waiting", "succeeded", "failed", "cancelled"].includes(a.status) ? { status: a.status as RunRecord["status"] } : {}) });
          return ok({ runs: runs.slice(0, a.limit).map(runSummary), total: runs.length });
        }
        case "run_status": {
          const r = await getRun(need(a.run_id, "run_id"));
          return ok({ ...runSummary(r), outputs: Object.fromEntries(Object.entries(r.steps).map(([k, s]) => [k, s.out])) });
        }
        case "resume": {
          const r = await resumeRun(need(a.run_id, "run_id"));
          return r.status === "failed" ? { ...ok(runSummary(r)), isError: true } : ok(runSummary(r));
        }
        case "cancel":
          return ok(runSummary(await cancelRun(need(a.run_id, "run_id"))));
        case "convert": {
          const id = need(a.id, "id");
          const rule = (await loadRules()).rules.find((r) => r.id === id);
          if (!rule) throw new Error(`No rule "${id}".`);
          const w = convertRule(rule);
          await saveWorkflow(w);
          return ok({
            saved: w.id,
            workflow: w,
            note: "Saved disabled. Check it with action=get, enable it (save with enabled: true), then disable the rule so the two don't both act.",
          });
        }
        case "events": {
          const events = await listEvents(a.status && ["queued", "done", "dead"].includes(a.status) ? (a.status as "queued" | "done" | "dead") : undefined);
          return ok({
            events: events.slice(0, a.limit).map((e) => ({ id: e.id, type: e.event.type, status: e.status, attempts: e.attempts, received: e.received, ...(e.error ? { error: e.error } : {}), ...(e.runs?.length ? { runs: e.runs } : {}) })),
            total: events.length,
          });
        }
        case "replay":
          await replayEvent(need(a.event_id, "event_id"));
          return ok({ replayed: a.event_id, note: "Queued again; the webhook worker processes it within seconds." });
        case "discard":
          return ok((await discardEvent(need(a.event_id, "event_id"))) ? { discarded: a.event_id } : `No queued event "${a.event_id}".`);
      }
    })
  );
}
