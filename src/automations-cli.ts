#!/usr/bin/env node
// npm run automations -- [--dry-run] [--rule <id>] [--force] [--max-rows <n>] [--max-requests <n>] [--max-blocks <n>]
//   [--max-minutes <n>] [--require-state]
import { access, appendFile } from "node:fs/promises";
import { rulesPath, runAll, statePath, summarize } from "./services/automations.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run") || process.env.AUTOMATIONS_DRY_RUN === "true";
  const force = process.argv.includes("--force") || process.env.AUTOMATIONS_FORCE === "true";
  const ruleId = arg("--rule") || process.env.RULE || undefined;
  const num = (flag: string, env: string, legacy?: string): number | undefined => {
    const v = arg(flag) ?? process.env[env] ?? (legacy ? (arg(`--${legacy}`) ?? process.env[`AUTOMATIONS_${legacy.toUpperCase().replace(/-/g, "_")}`]) : undefined);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number, got "${v}".`);
    return n;
  };
  // --max-writes / AUTOMATIONS_MAX_WRITES are the old names for --max-rows.
  const limits = {
    max_rows: num("--max-rows", "AUTOMATIONS_MAX_ROWS", "max-writes"),
    max_requests: num("--max-requests", "AUTOMATIONS_MAX_REQUESTS"),
    max_blocks: num("--max-blocks", "AUTOMATIONS_MAX_BLOCKS"),
    max_minutes: num("--max-minutes", "AUTOMATIONS_MAX_MINUTES"),
  };
  if (!process.env.NOTION_TOKEN) {
    console.error("NOTION_TOKEN is not set.");
    return 2;
  }
  // The scheduled workflow restored state from a previous run: a missing file then means the restore failed, and
  // running anyway would re-fire occurrences that already ran.
  if (process.argv.includes("--require-state") || process.env.AUTOMATIONS_REQUIRE_STATE === "true") {
    const file = await statePath();
    try {
      await access(file);
    } catch {
      console.error(`Automation state ${file} is missing although a previous run saved it. Stopping so nothing fires twice. Restore it, or run once without --require-state to start fresh.`);
      return 3;
    }
  }
  const mode = [dryRun ? "dry run: nothing will be written" : "", force ? "forced: schedules ignored" : ""].filter(Boolean).join("; ");
  console.log(`Rules: ${rulesPath()}${mode ? ` (${mode})` : ""}\n`);
  const report = await runAll({ dryRun, force, limits, ...(ruleId ? { ruleId } : {}) });
  const text = `Run ${report.run_id}: ${report.status}\n\n${summarize(report.results)}${report.warnings.length ? `\n\nWarnings:\n- ${report.warnings.join("\n- ")}` : ""}`;
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Notion automations${dryRun ? " (dry run)" : ""}${force ? " (forced)" : ""}\n\n${text}\n`);
  }
  return report.status === "succeeded" ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
);
