#!/usr/bin/env node
// npm run automations -- [--dry-run] [--rule <id>] [--force] [--max-writes <n>]
import { appendFile } from "node:fs/promises";
import { anyFailed, rulesPath, runAll, summarize } from "./services/automations.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run") || process.env.AUTOMATIONS_DRY_RUN === "true";
  const force = process.argv.includes("--force") || process.env.AUTOMATIONS_FORCE === "true";
  const ruleId = arg("--rule") || process.env.RULE || undefined;
  const maxWrites = Number(arg("--max-writes") ?? process.env.AUTOMATIONS_MAX_WRITES ?? 200);
  if (!process.env.NOTION_TOKEN) {
    console.error("NOTION_TOKEN is not set.");
    return 2;
  }
  const mode = [dryRun ? "dry run: nothing will be written" : "", force ? "forced: schedules ignored" : ""].filter(Boolean).join("; ");
  console.log(`Rules: ${rulesPath()}${mode ? ` (${mode})` : ""}\n`);
  const results = await runAll({ dryRun, force, maxWrites, ...(ruleId ? { ruleId } : {}) });
  const text = summarize(results);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Notion automations${dryRun ? " (dry run)" : ""}${force ? " (forced)" : ""}\n\n${text}\n`);
  }
  return anyFailed(results) ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
);
