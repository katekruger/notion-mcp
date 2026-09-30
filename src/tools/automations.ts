import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { promises as fs } from "node:fs";
import { z } from "zod";
import {
  anyFailed,
  checkRule,
  embedChartRecipes,
  loadRules,
  loadState,
  ruleSchema,
  rulesPath,
  runAll,
  runLogPath,
  runRule,
  saveRules,
  summarize,
  type Rule,
} from "../services/automations.js";
import { nextOccurrence, toCron } from "../services/schedule.js";
import { ok, safe, WRITE } from "./util.js";

const COMMIT_HINT = "Commit and push automations/rules.json so the scheduled GitHub workflow uses it.";

export function registerAutomationTools(server: McpServer): void {
  server.registerTool(
    "notion_automation",
    {
      title: "Automations",
      description:
        "Manage and run automation rules (automations/rules.json). A rule has a `when` condition (same `where`/`filter` as " +
        "notion_query, plus `relative` dates), a `schedule` (\"weekdays 09:00\", \"daily 18:00\", \"hourly\", cron), or both. Row " +
        "`actions` apply to each matching row: {set: {...}}, {append: markdown}, {comment: text}, {trash: true}. `then` actions run " +
        "once per firing: {refresh_chart: block_id}, {build_report: {...notion_build_report args}}, {create_page: {parent, title, …}}. " +
        "Strings accept {{today}}, {{now}}, {{page.<Property>}}. A rule must stop matching a row after acting on it (write a value " +
        "outside its condition, trash, or use `marker`). Actions: list, get, add, update (merge fields), validate (checks against " +
        "the live schema and previews), dry_run (never writes), enable, disable, delete, run (writes; one undo_id per rule), " +
        "history (recent runs). Editing only changes the local rules file; commit it for the GitHub schedule.",
      inputSchema: {
        action: z.enum(["list", "get", "add", "update", "validate", "dry_run", "enable", "disable", "delete", "run", "history"]),
        rule_id: z.string().optional(),
        rule: z.record(z.string(), z.unknown()).optional().describe("add: the whole rule; update: only the fields to change; validate: a rule to check without saving"),
        force: z.boolean().default(false).describe("dry_run/run: ignore schedules and run now"),
        timezone: z.string().optional().describe("Set the rules file's time zone (IANA, e.g. America/New_York)."),
      },
      annotations: { ...WRITE, destructiveHint: true, idempotentHint: false },
    },
    safe(async ({ action, rule_id, rule, force, timezone }) => {
      const data = await loadRules();
      if (timezone) {
        data.timezone = timezone;
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      }
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
          return ok({ ...find(rule_id).rule, ...schedule(find(rule_id).rule) });
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
          if (index >= 0) data.rules[index] = r;
          else data.rules.push(r);
          await saveRules(data);
          return ok({
            saved: r.id,
            file: rulesPath(),
            ...schedule(r),
            ...(withRecipes.embedded.length ? { note: `Saved the recipe of chart(s) ${withRecipes.embedded.join(", ")} in the rule, so the scheduled workflow can redraw them.` } : {}),
            preview: summarize([preview]),
            next_step: COMMIT_HINT,
          });
        }
        case "enable":
        case "disable": {
          const { index, rule: r } = find(rule_id);
          data.rules[index] = { ...r, enabled: action === "enable" };
          await saveRules(data);
          return ok({ rule: r.id, enabled: action === "enable", next_step: COMMIT_HINT });
        }
        case "delete": {
          const { index, rule: r } = find(rule_id);
          data.rules.splice(index, 1);
          await saveRules(data);
          return ok({ deleted: r.id, removed_rule: r, note: "To restore it, call action=add with removed_rule.", next_step: COMMIT_HINT });
        }
        case "dry_run": {
          if (timezone) await saveRules(data);
          const results = await runAll({ dryRun: true, force, ...(rule_id ? { ruleId: rule_id } : {}) });
          return ok(summarize(results));
        }
        case "run": {
          const results = await runAll({ dryRun: false, force, ...(rule_id ? { ruleId: rule_id } : {}) });
          const text = summarize(results);
          return ok({ failed: anyFailed(results), summary: text, undo: results.flatMap((r) => (r.undo_id ? [{ rule: r.rule, undo_id: r.undo_id }] : [])) });
        }
        case "history": {
          let lines: string[] = [];
          try {
            lines = (await fs.readFile(runLogPath(), "utf8")).trim().split("\n").filter(Boolean);
          } catch {
            return ok("No runs recorded on this machine yet. Scheduled runs are recorded in GitHub Actions (job summary and artifacts).");
          }
          return ok(lines.slice(-20).reverse().map((l) => JSON.parse(l) as unknown));
        }
      }
    })
  );
}
