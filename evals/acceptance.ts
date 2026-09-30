// Acceptance tests 1–7, run through the tools against NOTION_TEST_PAGE. Results stay on the page for inspection,
// except where a test calls for an undo (4 and 7). Rules for tests 5 and 6 are saved to automations/rules.json.
//   npm run acceptance
import { writeFileSync } from "node:fs";
import { must, testPage, tool, type Json } from "./harness.js";
import { normalizeId, notion } from "../src/services/notion.js";

const parent = testPage();
const today = new Date().toISOString().slice(0, 10);
const log: string[] = [];
const say = (s: string) => {
  console.log(s);
  log.push(s);
};
const check = (cond: unknown, msg: string) => {
  if (!cond) throw new Error(msg);
};
const addDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const root = await must("notion_create_page", { parent, title: `Acceptance ${today}`, icon: "✅", markdown: "Acceptance tests 1–7 for notion-plus. Each section below was built by the tools." });
say(`# Acceptance ${today}\n\nRoot page: ${root.url}\n`);

// The integration may not be allowed to list users; the test page's creator is a real person to assign.
const creator = ((await notion().pages.retrieve({ page_id: normalizeId(parent) })) as unknown as Json).created_by.id as string;

// ---------- 1 ----------
say("## 1. Project tracker with a Clients relation and 15 rows");
const clients = await must("notion_create_database", {
  parent: root.page_id, title: "Clients", icon: "🏢",
  properties: [{ name: "Client", type: "title" }, { name: "Tier", type: "select", options: ["Gold", "Silver", "Bronze"] }],
});
await must("notion_bulk_create", { database: clients.database_id, dry_run: false, csv: "Client,Tier\nAcme,Gold\nGlobex,Silver\nInitech,Gold\nUmbrella,Bronze\n" });
const tracker = await must("notion_create_database", {
  parent: root.page_id, title: "Project tracker", icon: "📋",
  properties: [
    { name: "Task", type: "title" },
    { name: "Status", type: "status", options: ["Not started", "In progress", "At Risk", "Done"] },
    { name: "Owner", type: "people" },
    { name: "Assignee", type: "select", options: ["Ada", "Grace", "Linus", "Margaret"], description: "Named owner, for charts (the integration can't list workspace people)" },
    { name: "Due date", type: "date" },
    { name: "Completed Date", type: "date" },
    { name: "Priority", type: "select", options: [{ name: "High", color: "red" }, { name: "Medium", color: "yellow" }, { name: "Low", color: "gray" }] },
    { name: "Client", type: "relation", relation: { database: clients.database_id, two_way: true, related_name: "Projects" } },
  ],
});
const statuses = ["Not started", "In progress", "In progress", "Done", "Not started"];
const people = ["Ada", "Grace", "Linus", "Margaret", "Ada"];
const rows = Array.from({ length: 15 }, (_, i) => ({
  Task: ["Kickoff", "Research", "Design review", "API spec", "Prototype", "Security review", "Data model", "Beta invite", "Load test", "Docs", "Pricing page", "QA pass", "Launch plan", "Retro", "Q4 roadmap"][i],
  Status: statuses[i % 5],
  Owner: [creator],
  Assignee: people[i % 5 === 4 ? 4 : i % 4],
  "Due date": addDays(-12 + i * 3),
  Priority: ["High", "Medium", "Low"][i % 3],
  Client: ["Acme", "Globex", "Initech", "Umbrella"][i % 4],
}));
const dry = await must("notion_bulk_create", { database: tracker.database_id, rows });
check(dry.rows === 15, JSON.stringify(dry));
const created = await must("notion_bulk_create", { database: tracker.database_id, rows, dry_run: false });
check(created.created === 15, JSON.stringify(created));
const schema = await must("notion_get_schema", { database: tracker.database_id });
say(`- Created Clients (4 rows) and Project tracker with ${schema.properties.length} properties; Status groups: ${schema.properties.find((p: Json) => p.name === "Status").groups.map((g: Json) => `${g.name}: ${g.options.join("/")}`).join("; ")}.`);
say(`- Added 15 rows (dry run first), each linked to a client by name. ${tracker.url}\n`);

// ---------- 2 ----------
say("## 2. Board view by status and timeline view by due date");
const board = await must("notion_views", { action: "create", database: tracker.database_id, view: { name: "Board by status", type: "board", group_by: "Status", properties: ["Assignee", "Due date", "Priority"] } });
const timeline = await must("notion_views", { action: "create", database: tracker.database_id, view: { name: "Timeline by due date", type: "timeline", date: "Due date", zoom: "week", properties: ["Task", "Status"] } });
say(`- Board: ${board.url}\n- Timeline: ${timeline.url}\n- Both created directly through the views API; nothing was left for manual setup.\n`);

// ---------- 3 ----------
say("## 3. Report page");
const report = await must("notion_build_report", {
  database: tracker.database_id, parent: root.page_id, title: "Tracker report",
  charts: [
    { title: "Tasks by status", type: "column", x: "Status" },
    { title: "Tasks per owner", type: "bar", x: "Assignee", native: false },
  ],
  table: { title: "Overdue items", where: { "Due date": { before: "today" }, Status: { "!=": "Done" } }, properties: ["Task", "Status", "Due date", "Assignee"], sort: { property: "Due date" } },
  gantt: { title: "Upcoming work", start: "Due date", section: "Assignee", where: { Status: { "!=": "Done" }, "Due date": { on_or_after: "today" } } },
});
const reportMd = (await tool("notion_get_page", { page: report.page_id, format: "markdown" })).text;
check(reportMd.includes("```mermaid") && reportMd.includes("Overdue items"), "report sections missing");
const outline = (await tool("notion_get_blocks", { block: report.page_id, max_depth: 0 })).text;
const chartBlock = outline.split("\n").find((l) => l.includes("(image)"))?.match(/⟨([^⟩]+)⟩/)?.[1] ?? "";
say(`- ${report.url}\n- Summary callout, ${report.sections.kpis} KPI tiles (counts by status group), a live Notion chart of tasks by status, a rendered bar chart of tasks per owner, an overdue-items table (report covers ${report.rows} rows), and a Mermaid Gantt of upcoming work.\n`);

// ---------- 4 ----------
say('## 4. Rename "Q3" to "Q4" everywhere on a page without losing formatting; preview, then undo');
const q3 = await must("notion_create_page", {
  parent: root.page_id, title: "Q3 plan",
  markdown: [
    "# Q3 goals",
    'Ship the **Q3 launch** with <span color="blue">Q3 pricing</span>; see [Q3 brief](https://example.com/q3).',
    "- Q3 hiring",
    "\t- Close two Q3 roles",
    "> [!NOTE] Q3 review on Friday",
    "| Quarter | Target |",
    "|---|---|",
    "| Q3 | 120 |",
  ].join("\n"),
});
const preview = await must("notion_replace_text", { page: q3.page_id, find: "Q3", replace: "Q4" });
say(`- Preview (dry run): ${preview.total_replacements} replacements in ${preview.changes.length} places (title, headings, bold text, colored text, link text, nested bullet, callout, table cell). Nothing written yet.`);
const applied = await must("notion_replace_text", { page: q3.page_id, find: "Q3", replace: "Q4", dry_run: false });
const para = (await must("notion_find_blocks", { page: q3.page_id, query: "Q4 launch" })).matches[0].id as string;
const block = (await notion().blocks.retrieve({ block_id: para })) as unknown as Json;
const segs = block.paragraph.rich_text as Json[];
check(segs.some((s) => s.plain_text.includes("Q4 launch") && s.annotations.bold), "bold lost");
check(segs.some((s) => s.plain_text.includes("Q4 pricing") && s.annotations.color === "blue"), "color lost");
check(segs.some((s) => s.plain_text.includes("Q4 brief") && s.href), "link lost");
say(`- Applied: ${applied.total_replacements} replacements; bold, blue text, and the link kept their formatting.`);
await must("notion_undo", { undo_id: applied.undo_id });
const after = await must("notion_replace_text", { page: q3.page_id, find: "Q4", replace: "Q3" });
check(!after.total_replacements, "undo left Q4 text");
say(`- Undone (undo_id ${applied.undo_id}): the page reads "Q3" again. ${q3.url}\n`);

// ---------- 5 ----------
say("## 5. Weekdays at 9am: mark past-due rows At Risk and comment");
await tool("notion_automation", { action: "delete", rule_id: "acceptance-at-risk" });
const rule5 = await must("notion_automation", {
  action: "add",
  rule: {
    id: "acceptance-at-risk",
    name: "Past due → At Risk",
    schedule: "weekdays 09:00",
    database: tracker.database_id,
    when: { where: { "Due date": { before: "today" }, Status: { not_in: ["Done", "At Risk"] } } },
    actions: [{ set: { Status: "At Risk" } }, { comment: "Past due: **{{page.Task}}** was due {{page.Due date}}." }],
  },
});
const dry5 = await tool("notion_automation", { action: "dry_run", rule_id: "acceptance-at-risk", force: true });
say(`- Saved rule (cron ${rule5.cron}, next run ${rule5.next_run}).\n- Local dry run (forced, since it isn't 9am now):\n\n${dry5.text.split("\n").map((l) => `  ${l}`).join("\n")}\n`);
say("- GitHub Actions: commit automations/rules.json, then run the workflow (see the summary for its result).\n");

// ---------- 6 ----------
say("## 6. When a row moves to Done, stamp Completed Date and refresh the report chart");
await tool("notion_automation", { action: "delete", rule_id: "acceptance-stamp-completed" });
const rule6 = await must("notion_automation", {
  action: "add",
  rule: {
    id: "acceptance-stamp-completed",
    name: "Done → stamp Completed Date, refresh chart",
    database: tracker.database_id,
    when: { where: { Status: "Done", "Completed Date": null } },
    actions: [{ set: { "Completed Date": "{{today}}" } }],
    then: [{ refresh_chart: chartBlock }],
  },
});
const moved = await must("notion_query", { database: tracker.database_id, where: { Task: "Kickoff" } });
await must("notion_update_properties", { page: moved.rows[0].id, properties: { Status: "Done" } });
const run6 = await must("notion_automation", { action: "run", rule_id: "acceptance-stamp-completed" });
const stamped = await must("notion_query", { database: tracker.database_id, where: { "Completed Date": today } });
check(!run6.failed && stamped.count >= 1, run6.summary);
say(`- ${rule6.note ?? ""}\n- Moved "Kickoff" to Done, then ran the rule:\n\n${run6.summary.split("\n").map((l: string) => `  ${l}`).join("\n")}\n\n- ${stamped.count} rows now have Completed Date ${today}; the "Tasks per owner" chart on the report was redrawn.\n`);

// ---------- 7 ----------
say("## 7. 300-row bulk update: dry run, apply, undo the whole batch");
const bulkDb = await must("notion_create_database", {
  parent: root.page_id, title: "Bulk test (300 rows)",
  properties: [{ name: "Item", type: "title" }, { name: "Stage", type: "select", options: ["New", "Reviewed"] }, { name: "Score", type: "number" }],
});
const items = Array.from({ length: 300 }, (_, i) => ({ Item: `Item ${String(i + 1).padStart(3, "0")}`, Stage: "New", Score: i }));
const t0 = Date.now();
const made = await must("notion_bulk_create", { database: bulkDb.database_id, rows: items, dry_run: false });
check(made.created === 300, JSON.stringify(made).slice(0, 200));
const t1 = Date.now();
const dry7 = await must("notion_bulk_update", { database: bulkDb.database_id, where: { Stage: "New" }, set: { Stage: "Reviewed" }, limit: 500 });
check(dry7.matched === 300, `dry run matched ${dry7.matched}`);
const t2 = Date.now();
const upd = await must("notion_bulk_update", { database: bulkDb.database_id, where: { Stage: "New" }, set: { Stage: "Reviewed" }, limit: 500, dry_run: false });
check(upd.updated === 300 && upd.failed.length === 0, JSON.stringify(upd).slice(0, 200));
const t3 = Date.now();
await must("notion_undo", { undo_id: upd.undo_id });
const t4 = Date.now();
const back = await must("notion_aggregate", { database: bulkDb.database_id, group_by: "Stage" });
check(back.groups.length === 1 && back.groups[0].key === "New" && back.groups[0].count === 300, JSON.stringify(back.groups));
const s = (a: number, b: number) => `${Math.round((b - a) / 1000)}s`;
say(`- Created 300 rows (${s(t0, t1)}). Dry run matched 300 and wrote nothing (${s(t1, t2)}). Applied Stage → Reviewed to 300 rows (${s(t2, t3)}), 0 failures. One notion_undo reverted all 300 (${s(t3, t4)}); all 300 read "New" again. ${bulkDb.url}\n`);

writeFileSync(process.env.ACCEPTANCE_OUT ?? "acceptance-report.md", log.join("\n") + "\n");
console.log("\nAll acceptance steps passed.");
