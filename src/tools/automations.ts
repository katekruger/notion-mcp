import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { promises as fs } from "node:fs";
import { z } from "zod";
import {
  checkRule,
  embedChartRecipes,
  editRules,
  loadRulesWithRevision,
  loadState,
  ruleSchema,
  rulesFileSchema,
  rulesInRepo,
  rulesPath,
  runAll,
  runLogPath,
  runRule,
  summarize,
  waive,
  type Rule,
} from "../services/automations.js";
import { nextOccurrence, toCron } from "../services/schedule.js";
import { ok, safe, WRITE } from "./util.js";

/** What to do after editing rules, depending on where they live. */
function nextStep(): string {
  return rulesInRepo()
    ? "Commit and push automations/rules.json so the scheduled GitHub workflow uses it."
    : "Saved on this machine. To run rules on a schedule without this machine, use action=deploy.";
}

const WORKFLOW_SNIPPET = `The repository's .github/workflows/automations.yml runs rules from automations/rules.json every hour.
1. Save the \`rules_file\` content below as automations/rules.json in your fork of the repository, and commit it.
2. In the repository settings, add the secret NOTION_TOKEN (the same integration secret this server uses).
3. Charts refreshed by rules carry their recipe in the rule, so the runner can redraw them.
4. Trigger "Notion automations" once from the Actions tab with dry_run on to check it.`;

export function registerAutomationTools(server: McpServer): void {
  server.registerTool(
    "notion_automation",
    {
      title: "Automations",
      description:
        "Manage and run automation rules (rules.json in the local state folder, or NOTION_PLUS_RULES). A rule has a `when` condition (same `where`/`filter` as " +
        "notion_query, plus `relative` dates), a `schedule` (\"weekdays 09:00\", \"daily 18:00\", \"hourly\", cron), or both. Row " +
        "`actions` apply to each matching row: {set: {...}}, {append: markdown}, {comment: text}, {trash: true}. `then` actions run " +
        "once per firing: {refresh_chart: block_id}, {build_report: {...notion_build_report args}}, {create_page: {parent, title, …}}. " +
        "Strings accept {{today}}, {{now}}, {{page.<Property>}}. A rule must stop matching a row after acting on it (write a value " +
        "outside its condition, trash, or use `marker`). Actions: list, get, add, update (merge fields), validate (checks against " +
        "the live schema and previews), dry_run (never writes), enable, disable, delete, run (writes; one undo_id per rule), " +
        "history (recent runs, paged), waive (mark a rule's unfinished firing as handled), export / import (the rules file as " +
        "JSON), deploy (the rules file plus steps to run it on a schedule in GitHub Actions). Each row's actions run in order " +
        "with progress saved after each step: values that keep the row matching, then content and comments, then the marker " +
        "or values that take it out of the condition, then trash. A failed row is retried next run from the step that " +
        "failed, and a scheduled occurrence only counts as fired when all of it succeeded. run reports status succeeded, " +
        "partial, or failed, and is an error unless every rule succeeded. list and get return the file's `revision`; pass it " +
        "as expected_revision on edits so a change made elsewhere in the meantime isn't overwritten.",
      inputSchema: {
        action: z.enum(["list", "get", "add", "update", "validate", "dry_run", "enable", "disable", "delete", "run", "history", "waive", "export", "import", "deploy"]),
        rule_id: z.string().optional(),
        rule: z.record(z.string(), z.unknown()).optional().describe("add: the whole rule; update: only the fields to change; validate: a rule to check without saving"),
        force: z.boolean().default(false).describe("dry_run/run: ignore schedules and run now"),
        timezone: z.string().optional().describe("Set the rules file's time zone (IANA, e.g. America/New_York)."),
        expected_revision: z
          .string()
          .optional()
          .describe("Edits: the revision from list/get. The edit is refused if the rules file changed since."),
        rules_file: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("import: a whole rules file ({version: 1, timezone, rules: [...]}), e.g. from export."),
        import_mode: z.enum(["merge", "replace"]).default("merge").describe("import: merge adds or replaces rules by id; replace swaps the whole file."),
        max_rows: z.number().int().min(1).optional().describe("run: rows acted on across all rules (default 200); the rest wait for the next run."),
        max_requests: z.number().int().min(1).optional().describe("run: Notion requests (default 3000)."),
        max_blocks: z.number().int().min(1).optional().describe("run: blocks appended (default 5000)."),
        max_minutes: z.number().min(0.1).optional().describe("run: wall time (default 20)."),
        limit: z.number().int().min(1).max(100).default(20).describe("history: runs per page."),
        cursor: z.number().int().min(0).optional().describe("history: next_cursor from the previous page."),
      },
      annotations: { ...WRITE, destructiveHint: true, idempotentHint: false },
    },
    safe(async (args) => {
      const { action, rule_id, rule, force, timezone, expected_revision } = args;
      const loaded = await loadRulesWithRevision();
      const data = loaded.data;
      if (timezone) {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
        data.timezone = timezone;
      }
      /** Apply a change to the current file (re-read under its lock), keeping any time zone change. */
      const save = (change: (d: typeof data) => void) =>
        editRules(
          (d) => {
            if (timezone) d.timezone = timezone;
            change(d);
          },
          { expectedRevision: expected_revision }
        );
      const indexIn = (d: typeof data, id: string): number => {
        const i = d.rules.findIndex((x) => x.id === id);
        if (i < 0) throw new Error(`Rule "${id}" was removed by another change; read the rules again.`);
        return i;
      };
      const find = (id: string | undefined): { index: number; rule: Rule } => {
        if (!id) throw new Error(`action=${action} needs rule_id.`);
        const index = data.rules.findIndex((r) => r.id === id);
        if (index < 0) throw new Error(`No rule "${id}". Rules: ${data.rules.map((r) => r.id).join(", ") || "(none)"}.`);
        return { index, rule: data.rules[index] };
      };
      const parse = (raw: unknown): Rule => {
        const r = ruleSchema.safeParse(raw);
        if (!r.success) throw new Error(`The rule is invalid:\n- ${r.error.issues.map((i) => `${i.path.join(".") || "rule"}: ${i.message}`).join("\n- ")}`);
        return r.data;
      };
      const schedule = (r: Rule) => (r.schedule ? { schedule: r.schedule, cron: toCron(r.schedule), next_run: nextOccurrence(toCron(r.schedule), new Date(), data.timezone)?.toISOString() } : {});

      switch (action) {
        case "list": {
          if (data.rules.length === 0) return ok(`No rules yet in ${rulesPath()}. Add one with action=add.`);
          const state = await loadState();
          return ok({
            file: rulesPath(),
            revision: loaded.revision,
            timezone: data.timezone,
            rules: data.rules.map((r) => ({
              id: r.id,
              ...(r.name ? { name: r.name } : {}),
              enabled: r.enabled,
              ...schedule(r),
              ...(r.database ? { database: r.database } : {}),
              when: r.when ?? "(schedule only)",
              actions: r.actions.length,
              then: r.then.length,
              ...(state.rules[r.id]?.last_fired ? { last_fired: state.rules[r.id].last_fired } : {}),
            })),
          });
        }
        case "get":
          return ok({ ...find(rule_id).rule, ...schedule(find(rule_id).rule), revision: loaded.revision });
        case "validate": {
          const r = rule ? parse(rule) : find(rule_id).rule;
          await checkRule(r, data.timezone);
          const preview = await runRule(r, data.timezone, { dryRun: true, force: true });
          return ok({ valid: true, ...schedule(r), preview: summarize([preview]) });
        }
        case "add":
        case "update": {
          let r: Rule;
          let index = -1;
          if (action === "add") {
            if (!rule) throw new Error("action=add needs `rule`.");
            r = parse(rule);
            if (data.rules.some((x) => x.id === r.id)) throw new Error(`A rule "${r.id}" already exists; use action=update.`);
          } else {
            const found = find(rule_id ?? (rule?.id as string | undefined));
            index = found.index;
            r = parse({ ...found.rule, ...(rule ?? {}), id: found.rule.id });
          }
          const withRecipes = await embedChartRecipes(r);
          r = withRecipes.rule;
          await checkRule(r, data.timezone);
          const preview = await runRule(r, data.timezone, { dryRun: true, force: true });
          const saved = r;
          const revision = await save((d) => {
            if (index >= 0) d.rules[indexIn(d, saved.id)] = saved;
            else if (d.rules.some((x) => x.id === saved.id)) throw new Error(`A rule "${saved.id}" was added by another change; use action=update.`);
            else d.rules.push(saved);
          });
          return ok({
            saved: r.id,
            revision,
            file: rulesPath(),
            ...schedule(r),
            ...(withRecipes.embedded.length ? { note: `Saved the recipe of chart(s) ${withRecipes.embedded.join(", ")} in the rule, so the scheduled workflow can redraw them.` } : {}),
            preview: summarize([preview]),
            next_step: nextStep(),
          });
        }
        case "enable":
        case "disable": {
          const { rule: r } = find(rule_id);
          const revision = await save((d) => {
            const i = indexIn(d, r.id);
            d.rules[i] = { ...d.rules[i], enabled: action === "enable" };
          });
          return ok({ rule: r.id, enabled: action === "enable", revision, next_step: nextStep() });
        }
        case "delete": {
          const { rule: r } = find(rule_id);
          const revision = await save((d) => void d.rules.splice(indexIn(d, r.id), 1));
          return ok({ deleted: r.id, removed_rule: r, revision, note: "To restore it, call action=add with removed_rule.", next_step: nextStep() });
        }
        case "dry_run": {
          if (timezone) await save(() => undefined);
          const report = await runAll({ dryRun: true, force, ...(rule_id ? { ruleId: rule_id } : {}) });
          return ok(summarize(report.results));
        }
        case "run": {
          const report = await runAll({
            dryRun: false,
            force,
            limits: { max_rows: args.max_rows, max_requests: args.max_requests, max_blocks: args.max_blocks, max_minutes: args.max_minutes },
            ...(rule_id ? { ruleId: rule_id } : {}),
          });
          const body = {
            run_id: report.run_id,
            status: report.status,
            rules: report.results.map((r) => ({ rule: r.rule, status: r.status, ...(r.undo_id ? { undo_id: r.undo_id } : {}) })),
            summary: summarize(report.results),
            undo: report.results.flatMap((r) => (r.undo_id ? [{ rule: r.rule, undo_id: r.undo_id }] : [])),
            ...(report.warnings.length ? { warnings: report.warnings } : {}),
            ...(report.status !== "succeeded"
              ? {
                  next_step:
                    "Unfinished rows and occurrences are retried on the next run from the step that failed. Fix the cause and run again, " +
                    "or waive a rule's unfinished firing with action=waive. Undo what did run with the undo ids.",
                }
              : {}),
          };
          // Anything short of full success is an error to the caller, with the details (and undo ids) kept.
          return report.status === "succeeded" ? ok(body) : { ...ok(body), isError: true };
        }
        case "history": {
          let lines: string[] = [];
          try {
            lines = (await fs.readFile(await runLogPath(), "utf8")).trim().split("\n").filter(Boolean);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            return ok("No runs recorded on this machine yet. Scheduled runs are recorded in GitHub Actions (job summary and artifacts).");
          }
          const start = args.cursor ?? 0;
          const newestFirst = lines.reverse();
          const page = newestFirst.slice(start, start + args.limit);
          let unreadable = 0;
          const runs = page.flatMap((l) => {
            try {
              return [JSON.parse(l) as unknown];
            } catch {
              unreadable++;
              return [];
            }
          });
          return ok({
            runs,
            total: newestFirst.length,
            ...(start + args.limit < newestFirst.length ? { next_cursor: start + args.limit } : {}),
            ...(unreadable ? { unreadable_lines: unreadable } : {}),
          });
        }
        case "waive": {
          if (!rule_id) throw new Error("action=waive needs rule_id.");
          find(rule_id);
          const w = await waive(rule_id);
          if (!w.waived && !w.rows) return ok({ rule: rule_id, note: "Nothing unfinished for this rule." });
          return ok({
            rule: rule_id,
            ...(w.waived ? { waived_firing: w.waived } : {}),
            ...(w.rows ? { dropped_row_progress: w.rows, note: "Those rows start over next run if they still match." } : {}),
          });
        }
        case "export":
          return ok({ file: rulesPath(), revision: loaded.revision, rules_file: data });
        case "import": {
          if (!args.rules_file) throw new Error("action=import needs rules_file.");
          const parsed = rulesFileSchema.safeParse(args.rules_file);
          if (!parsed.success) throw new Error(`rules_file is invalid:\n- ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n- ")}`);
          const incoming = parsed.data;
          const ids = new Set<string>();
          for (const r of incoming.rules) {
            if (ids.has(r.id)) throw new Error(`rules_file: duplicate rule id "${r.id}".`);
            ids.add(r.id);
          }
          for (const r of incoming.rules) await checkRule(r, incoming.timezone);
          const revision = await save((d) => {
            if (args.import_mode === "replace") {
              d.timezone = incoming.timezone;
              d.rules = incoming.rules;
              return;
            }
            for (const r of incoming.rules) {
              const i = d.rules.findIndex((x) => x.id === r.id);
              if (i >= 0) d.rules[i] = r;
              else d.rules.push(r);
            }
          });
          return ok({ imported: incoming.rules.map((r) => r.id), mode: args.import_mode, revision, next_step: nextStep() });
        }
        case "deploy": {
          const rules = await Promise.all(data.rules.map(async (r) => (await embedChartRecipes(r)).rule));
          const local = data.rules.flatMap((r) => r.then.flatMap((t) => ("refresh_chart" in t && typeof t.refresh_chart === "string" ? [r.id] : [])));
          const missing = rules.flatMap((r) => r.then.flatMap((t) => ("refresh_chart" in t && typeof t.refresh_chart === "string" ? [`${r.id}: ${t.refresh_chart}`] : [])));
          return ok({
            steps: WORKFLOW_SNIPPET,
            rules_file: { ...data, rules },
            ...(local.length ? { note: `Chart recipes were embedded for rules ${[...new Set(local)].join(", ")}.` } : {}),
            ...(missing.length ? { warning: `These charts have no recipe on this machine, so the runner can't redraw them: ${missing.join("; ")}.` } : {}),
          });
        }
      }
    })
  );
}
