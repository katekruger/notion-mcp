#!/usr/bin/env node
// npm run automations -- [--dry-run] [--rule <id>] [--max-writes <n>]
import { appendFile } from "node:fs/promises";
import { rulesPath, runAll, summarize } from "./services/automations.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run") || process.env.AUTOMATIONS_DRY_RUN === "true";
  const ruleId = arg("--rule");
  const maxWrites = Number(arg("--max-writes") ?? process.env.AUTOMATIONS_MAX_WRITES ?? 200);
  if (!process.env.NOTION_TOKEN) {
    console.error("NOTION_TOKEN is not set.");
    return 2;
  }
  console.log(`Rules: ${rulesPath()}${dryRun ? " (dry run: nothing will be written)" : ""}\n`);
  const results = await runAll({ dryRun, maxWrites, ...(ruleId ? { ruleId } : {}) });
  const text = summarize(results);
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Notion automations${dryRun ? " (dry run)" : ""}\n\n${text}\n`);
  }
  const failed = results.some((r) => r.error || r.rows.some((row) => row.error && !row.error.startsWith("skipped")));
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  }
);
