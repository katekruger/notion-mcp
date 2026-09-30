// Builds the fixed dataset the evaluation questions are written against, under NOTION_TEST_PAGE.
//   npm run eval:seed            (skips if the fixture already exists)
//   npm run eval:seed -- --reset (trashes it and builds it again)
// The data is fixed (2025 dates, owners as a select) so every answer stays the same over time.
import { must, testPage, tool } from "./harness.js";

export const FIXTURE = "notion-plus eval fixture";
const parent = testPage();

const existing = await must("notion_search", { query: FIXTURE, type: "page", limit: 10 });
const found = (existing.results ?? []).find((r: { title: string }) => r.title === FIXTURE);
if (found && !process.argv.includes("--reset")) {
  console.log(`Fixture exists: ${found.url}. Pass --reset to rebuild it.`);
  process.exit(0);
}
if (found) await must("notion_trash_page", { page: found.id });

const root = await must("notion_create_page", { parent, title: FIXTURE, icon: "🧪", markdown: "Fixed data for `evals/notion-plus.xml`. Don't edit; rebuild with `npm run eval:seed -- --reset`." });

const clients = await must("notion_create_database", {
  parent: root.page_id,
  title: "Eval: Clients",
  properties: [
    { name: "Client", type: "title" },
    { name: "Tier", type: "select", options: ["Gold", "Silver", "Bronze"] },
    { name: "Region", type: "select", options: ["NA", "EMEA", "APAC"] },
  ],
});
await must("notion_bulk_create", {
  database: clients.database_id,
  dry_run: false,
  csv: "Client,Tier,Region\nAcme,Gold,NA\nGlobex,Silver,EMEA\nInitech,Gold,EMEA\nUmbrella,Bronze,APAC\n",
});

const projects = await must("notion_create_database", {
  parent: root.page_id,
  title: "Eval: Projects",
  properties: [
    { name: "Project", type: "title" },
    {
      name: "Status",
      type: "status",
      options: [
        { name: "Backlog", group: "To-do" },
        { name: "In progress", group: "In progress" },
        { name: "Blocked", group: "In progress" },
        { name: "Done", group: "Complete" },
        { name: "Cancelled", group: "Complete" },
      ],
    },
    { name: "Owner", type: "select", options: ["Ada", "Grace", "Linus", "Margaret"] },
    { name: "Client", type: "relation", relation: { database: clients.database_id, two_way: true, related_name: "Projects" } },
    { name: "Budget", type: "number", number_format: "dollar" },
    { name: "Due", type: "date" },
    { name: "Tags", type: "multi_select", options: ["UX", "Security", "Data", "Mobile", "Growth"] },
  ],
});
const rows = [
  ["Portal redesign", "In progress", "Ada", "Acme", 12000, "2025-08-15", ["UX"]],
  ["SSO rollout", "In progress", "Grace", "Globex", 18000, "2025-09-30", ["Security"]],
  ["Data warehouse", "In progress", "Ada", "Initech", 25000, "2025-11-01", ["Data", "Security"]],
  ["Pen test", "Done", "Linus", "Initech", 9000, "2025-07-20", ["Security"]],
  ["Mobile app v2", "Blocked", "Margaret", "Acme", 30000, "2025-10-10", ["UX", "Mobile"]],
  ["Audit logging", "In progress", "Linus", "Globex", 7000, "2025-09-05", ["Security", "Data"]],
  ["Billing migration", "Done", "Grace", "Umbrella", 15000, "2025-06-30", ["Data"]],
  ["Onboarding emails", "Backlog", "Margaret", "Umbrella", 4000, "2025-12-01", ["Growth"]],
  ["Key rotation", "Backlog", "Ada", "Acme", 6000, "2025-08-01", ["Security"]],
  ["Churn dashboard", "Done", "Grace", "Initech", 11000, "2025-09-15", ["Data", "Growth"]],
  ["Accessibility fixes", "Cancelled", "Linus", "Globex", 5000, "2025-07-01", ["UX"]],
  ["Search relaunch", "In progress", "Margaret", "Umbrella", 20000, "2025-12-15", ["UX"]],
].map(([Project, Status, Owner, Client, Budget, Due, Tags]) => ({ Project, Status, Owner, Client, Budget, Due, Tags }));
await must("notion_bulk_create", { database: projects.database_id, rows, dry_run: false });
await must("notion_views", { action: "create", database: projects.database_id, view: { name: "Board", type: "board", group_by: "Status" } });
await must("notion_views", { action: "create", database: projects.database_id, view: { name: "By due date", type: "timeline", date: "Due" } });

await must("notion_create_page", {
  parent: root.page_id,
  title: "Eval: Q3 retro",
  markdown: [
    "# Q3 retro",
    "> [!NOTE] Covers July to September 2025.",
    "## Metrics",
    "| Month | p95 latency (ms) | Errors |",
    "|---|---|---|",
    "| July | 420 | 31 |",
    "| August | 380 | 22 |",
    "| September | 310 | 17 |",
    "## Migration",
    "<details>",
    "<summary>Decision</summary>",
    "\tMove the queue to the managed service.",
    "\t- Approved by Priya Raman on 2025-10-03.",
    "</details>",
    "<details>",
    "<summary>Alternatives</summary>",
    "\t- Self-hosted cluster (rejected: on-call load).",
    "</details>",
  ].join("\n"),
});

const runbook = await must("notion_create_page", {
  parent: root.page_id,
  title: "Eval: Runbook",
  markdown: [
    '## Rotate logs {toggle="true"}',
    "\t```python",
    "\timport logrotate",
    "\tlogrotate.run('/var/log/app')",
    "\t```",
    '## Restart the worker {toggle="true"}',
    "\t```bash",
    "\tsystemctl restart worker",
    "\t```",
  ].join("\n"),
});
await must("notion_comments", { action: "add", target: runbook.page_id, text: "Please **verify** the restart steps before Friday." });

const again = await tool("notion_search", { query: FIXTURE, type: "page", limit: 1 });
console.log(`Fixture ready: ${again.json.results?.[0]?.url ?? root.url}`);
