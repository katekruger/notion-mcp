import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkRule, loadRules, ruleSchema, rulesPath, runAll, runRule, saveRules, summarize } from "../services/automations.js";
import { ok, READ, safe, WRITE } from "./util.js";

export function registerAutomationTools(server: McpServer): void {
  server.registerTool(
    "notion_automation_list",
    {
      title: "List Automation Rules",
      description: "List the automation rules in automations/rules.json: id, database, conditions, actions, and whether each is enabled.",
      inputSchema: {},
      annotations: READ,
    },
    safe(async () => {
      const data = await loadRules();
      if (data.rules.length === 0) return ok(`No rules yet in ${rulesPath()}. Add one with notion_automation_add.`);
      return ok({ file: rulesPath(), timezone: data.timezone, rules: data.rules });
    })
  );

  server.registerTool(
    "notion_automation_add",
    {
      title: "Add Automation Rule",
      description:
        "Add or replace a rule in automations/rules.json. Rules are polling queries: `when` uses the same `where`/`filter` as notion_query, " +
        "plus `relative` date conditions ({property, older_than_days | newer_than_days}; property may be \"$last_edited\" or \"$created\"). " +
        "Actions: {set: {...}}, {append: markdown or blocks}, {comment: text}, {trash: true}. Strings accept {{today}}, {{now}}, " +
        "{{page.<Property>}}, {{page.url}}. A rule must stop matching a row after acting on it (change a property its condition checks, " +
        "trash, or set `marker` to a checkbox property). The rule is checked against the live schema and a dry run preview is returned. " +
        "Writes only the local rules file; commit it for the scheduled GitHub workflow to pick it up.",
      inputSchema: {
        rule: ruleSchema,
        replace: z.boolean().default(false).describe("Replace an existing rule with the same id."),
      },
      annotations: { ...WRITE, idempotentHint: false },
    },
    safe(async ({ rule, replace }) => {
      const data = await loadRules();
      const existing = data.rules.findIndex((r) => r.id === rule.id);
      if (existing >= 0 && !replace) throw new Error(`A rule "${rule.id}" already exists. Pass replace: true to overwrite it.`);
      await checkRule(rule, data.timezone);
      const preview = await runRule(rule, data.timezone, { dryRun: true });
      if (existing >= 0) data.rules[existing] = rule;
      else data.rules.push(rule);
      await saveRules(data);
      return ok({
        saved: rule.id,
        file: rulesPath(),
        preview: summarize([preview]),
        next_step: "Commit automations/rules.json so the scheduled workflow runs it.",
      });
    })
  );

  server.registerTool(
    "notion_automation_dry_run",
    {
      title: "Dry Run Automations",
      description: "Show which rows each automation rule would act on right now and what it would do. Never writes to Notion.",
      inputSchema: { rule_id: z.string().optional().describe("One rule; omit for all enabled rules.") },
      annotations: READ,
    },
    safe(async ({ rule_id }) => {
      const results = await runAll({ dryRun: true, ...(rule_id ? { ruleId: rule_id } : {}) });
      return ok(summarize(results));
    })
  );
}
