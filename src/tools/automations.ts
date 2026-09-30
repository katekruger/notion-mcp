import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { promises as fs } from "node:fs";
import { z } from "zod";
import {
  anyFailed,
  checkRule,
  embedChartRecipes,
  editRules,
  loadRulesWithRevision,
  loadState,
  ruleSchema,
  rulesPath,
  runAll,
  runLogPath,
  runRule,
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
        "history (recent runs). Editing only changes the local rules file; commit it for the GitHub schedule. list and get return the " +
        "file's `revision`; pass it as expected_revision on edits so a change made elsewhere in the meantime isn't overwritten.",
      inputSchema: {
        action: z.enum(["list", "get", "add", "update", "validate", "dry_run", "enable", "disable", "delete", "run", "history"]),
        rule_id: z.string().optional(),
        rule: z.record(z.string(), z.unknown()).optional().describe("add: the whole rule; update: only the fields to change; validate: a rule to check without saving"),
        force: z.boolean().default(false).describe("dry_run/run: ignore schedules and run now"),
        timezone: z.string().optional().describe("Set the rules file's time zone (IANA, e.g. America/New_York)."),
        expected_revision: z
          .string()
          .optional()
          .describe("Edits: the revision from list/get. The edit is refused if the rules file changed since."),
      },
      annotations: { ...WRITE, destructiveHint: true, idempotentHint: false },
    },
    safe(async ({ action, rule_id, rule, force, timezone, expected_revision }) => {
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
            next_step: COMMIT_HINT,
          });
        }
        case "enable":
        case "disable": {
          const { rule: r } = find(rule_id);
          const revision = await save((d) => {
            const i = indexIn(d, r.id);
            d.rules[i] = { ...d.rules[i], enabled: action === "enable" };
          });
          return ok({ rule: r.id, enabled: action === "enable", revision, next_step: COMMIT_HINT });
        }
        case "delete": {
          const { rule: r } = find(rule_id);
          const revision = await save((d) => void d.rules.splice(indexIn(d, r.id), 1));
          return ok({ deleted: r.id, removed_rule: r, revision, note: "To restore it, call action=add with removed_rule.", next_step: COMMIT_HINT });
        }
        case "dry_run": {
          if (timezone) await save(() => undefined);
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
            lines = (await fs.readFile(await runLogPath(), "utf8")).trim().split("\n").filter(Boolean);
          } catch {
            return ok("No runs recorded on this machine yet. Scheduled runs are recorded in GitHub Actions (job summary and artifacts).");
          }
          return ok(lines.slice(-20).reverse().map((l) => JSON.parse(l) as unknown));
        }
      }
    })
  );
}
