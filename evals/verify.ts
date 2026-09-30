// Answers every question in evals/notion-plus.xml through the tools, the way a model should, and checks the expected
// answers. Proves the answers are right and reachable; it doesn't measure a model's tool choice (see the README).
//   npm run eval:verify
import { readFileSync } from "node:fs";
import { must, testPage, tool, type Json } from "./harness.js";

testPage();
const xml = readFileSync(new URL("./notion-plus.xml", import.meta.url), "utf8");
const expected = [...xml.matchAll(/<answer>([\s\S]*?)<\/answer>/g)].map((m) => m[1].trim());

// Find the fixture's pages and databases through its children: search can lag behind new pages by minutes.
const fixture = await must("notion_search", { query: "notion-plus eval fixture", type: "page", limit: 5 });
const root = (fixture.results ?? []).find((x: Json) => x.title === "notion-plus eval fixture");
if (!root) throw new Error("The eval fixture isn't there yet; run npm run eval:seed (search can take a minute to see it).");
const outline = (await tool("notion_get_blocks", { block: root.id, max_depth: 0 })).text;
const child = (title: string): string => {
  const line = outline.split("\n").find((l) => l.includes(`) ${title}`));
  const id = line?.match(/⟨([^⟩]+)⟩/)?.[1];
  if (!id) throw new Error(`"${title}" isn't in the fixture; rebuild it with npm run eval:seed -- --reset.`);
  return id;
};
const projects = child("Eval: Projects");
const clients = child("Eval: Clients");
const retro = child("Eval: Q3 retro");
const runbook = child("Eval: Runbook");

const solvers: (() => Promise<string>)[] = [
  async () => {
    const r = await must("notion_aggregate", { database: projects, where: { Status: "In progress" }, group_by: "Owner", metrics: ["sum:Budget"] });
    return r.groups[0].key;
  },
  async () => {
    const byClient = await must("notion_aggregate", { database: projects, where: { Tags: "Security" }, group_by: "Client" });
    const tiers = await must("notion_query", { database: clients, properties: ["Client", "Tier"] });
    const tierOf = new Map(tiers.rows.map((r: Json) => [r.Client, r.Tier]));
    const counts = new Map<string, number>();
    for (const g of byClient.groups) counts.set(String(tierOf.get(g.key)), (counts.get(String(tierOf.get(g.key))) ?? 0) + g.count);
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  },
  async () => {
    const r = await must("notion_find_blocks", { page: retro, query: "Approved by" });
    return r.matches[0].text.match(/Approved by (.+?) on/)[1];
  },
  async () => {
    const r = await must("notion_find_blocks", { page: retro, query: "September" });
    return r.matches.find((m: Json) => m.type === "table_row").text.split(" | ")[1];
  },
  async () => {
    const s = await must("notion_get_schema", { database: projects });
    return String(s.properties.find((p: Json) => p.name === "Status").groups.find((g: Json) => g.name === "Complete").options.length);
  },
  async () => {
    const list = await must("notion_views", { action: "list", database: projects });
    const board = list.views.find((v: Json) => v.type === "board");
    const v = await must("notion_views", { action: "get", view_id: board.id });
    return v.configuration.group_by.property;
  },
  async () => {
    const r = await must("notion_aggregate", { database: projects, where: { Due: { on_or_after: "2025-07-01", on_or_before: "2025-09-30" } } });
    return String(r.totals.count);
  },
  async () => {
    const page = await tool("notion_get_page", { page: runbook, format: "markdown" });
    return page.text.split("Restart the worker")[1]?.match(/```(\w+)/)?.[1] ?? "";
  },
  async () => {
    const r = await must("notion_comments", { action: "list", target: runbook });
    for (const c of r.comments) {
      const bold = String(c.text).match(/\*\*(\w+)\*\*/);
      if (bold) return bold[1].toLowerCase();
    }
    return "";
  },
  async () => {
    const emea = await must("notion_query", { database: clients, where: { Region: "EMEA" }, properties: ["Client"] });
    const r = await must("notion_aggregate", { database: projects, where: { or: emea.rows.map((c: Json) => ({ Client: c.id })) }, metrics: ["median:Budget"] });
    return String(r.totals.median_Budget);
  },
];

let failed = 0;
for (const [i, solve] of solvers.entries()) {
  try {
    const got = await solve();
    const ok = got.trim().toLowerCase() === expected[i].toLowerCase();
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} Q${i + 1}: ${got}${ok ? "" : ` (expected ${expected[i]})`}`);
  } catch (e) {
    failed++;
    console.log(`FAIL Q${i + 1}: ${(e as Error).message}`);
  }
}
console.log(`\n${solvers.length - failed}/${solvers.length} answers verified.`);
process.exit(failed ? 1 : 0);
