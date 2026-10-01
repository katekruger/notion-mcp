// Templates: variables, loops, conditions, parts and slots, built-ins, preview diffs, and writing against a fake
// client (charts uploaded into their placeholders, data tables, page creation). No network.
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@notionhq/client";

process.env.NOTION_PLUS_HOME = mkdtempSync(path.join(os.tmpdir(), "notion-plus-templates-test-"));
process.env.NOTION_PLUS_WORKSPACE = "test";

const t = await import("../src/services/templates.js");
const { BUILTIN_TEMPLATES } = await import("../src/services/templates-builtin.js");
const { setClientForTests } = await import("../src/services/notion.js");
type BlockSpec = import("../src/services/blocks.js").BlockSpec;

const tpl = (blocks: unknown[], extra: Record<string, unknown> = {}) => t.parseTemplate({ version: 1, name: "t", title: "T {{today}}", blocks, ...extra });

test("every built-in template is valid and compiles with sample values", async () => {
  const samples: Record<string, Record<string, unknown>> = {
    "weekly-executive-report": {
      week_of: "2026-09-28",
      headline: "Shipped billing v2",
      status: "At risk",
      kpis: [{ label: "Signups", value: 120 }, { label: "Churn", value: "2.1%" }],
      wins: ["Billing v2 live"],
      risks: [{ risk: "Hiring", owner: "Ana", mitigation: "Agency" }],
      decisions: ["Approve Q4 budget"],
      next_week: ["Pricing page"],
      trend: [{ x: "W1", y: 1 }, { x: "W2", y: 3 }],
    },
    "content-brief": { title: "Why polling", goal: "Explain", audience: "Engineers", messages: ["Simple"], outline: [{ section: "Intro", points: ["Hook"] }], keywords: ["mcp"] },
    "launch-plan": {
      product: "Atlas",
      launch_date: "2026-11-02",
      summary: "New dashboard.",
      goals: [{ goal: "Adoption", metric: "WAU", target: "1k" }],
      milestones: [{ name: "Beta", start: "2026-10-01", end: "2026-10-15", owner: "Kim", status: "active" }],
      risks: [{ risk: "Perf", likelihood: "Low", mitigation: "Load test" }],
    },
    "research-dossier": { topic: "Pricing", question: "Raise prices?", summary: "Yes, modestly.", findings: [{ finding: "Low churn", evidence: "2%", source: "Data" }], data: [{ x: "A", y: 2 }] },
  };
  assert.equal(BUILTIN_TEMPLATES.length, 5);
  for (const raw of BUILTIN_TEMPLATES) {
    const tmpl = t.parseTemplate(raw);
    if (tmpl.name === "database-report") continue; // reads a database; tested below with a fake client
    const c = await t.compileTemplate(tmpl, samples[tmpl.name]);
    assert.ok(c.specs.length > 3, tmpl.name);
    assert.ok(!c.title.includes("{{"), `${tmpl.name}: ${c.title}`);
    assert.ok(!JSON.stringify(c.specs).includes("{{"), `${tmpl.name} left a variable unfilled`);
  }
});

test("variables: required, types, unknown names, and defaults are checked before anything renders", async () => {
  const x = tpl([{ markdown: "{{who}} has {{n}}" }], { variables: { who: { type: "string", required: true }, n: { type: "number", default: 3 } } });
  await assert.rejects(t.compileTemplate(x, {}), (e: unknown) => e instanceof t.TemplateError && /"who" is required/.test((e as Error).message));
  await assert.rejects(t.compileTemplate(x, { who: 1 }), /should be a string/);
  await assert.rejects(t.compileTemplate(x, { who: "A", extra: 1 }), /Unknown variable "extra"/);
  const c = await t.compileTemplate(x, { who: "Ana" });
  assert.equal(c.specs[0].text, "Ana has 3");
  // A reference to a missing value is an error, not an empty string in the page.
  await assert.rejects(t.compileTemplate(tpl([{ markdown: "{{nope}}" }]), {}), /\{\{nope\}\} has no value/);
});

test("each, if/else, parts with arguments, and slots", async () => {
  const x = tpl(
    [
      { each: "items", as: "it", blocks: [{ markdown: "- {{it_index}}: {{it.name}}" }] },
      { if: { var: "mode", equals: "a" }, then: [{ heading: "A" }], else: [{ heading: "Not A" }] },
      { if: "empty_list", then: [{ heading: "never" }] },
      { part: "sig", with: { by: "{{who}}" } },
      { slot: "notes", default: [{ markdown: "default notes" }] },
    ],
    {
      variables: { items: { type: "list" }, mode: { type: "string" }, who: { type: "string" }, empty_list: { type: "list", default: [] } },
      parts: { sig: [{ markdown: "— {{by}}" }] },
    }
  );
  const c = await t.compileTemplate(x, { items: [{ name: "x" }, { name: "y" }], mode: "b", who: "Kim" }, { slots: { notes: "**filled**" } });
  const lines = t.outline(c.specs);
  assert.deepEqual(lines, ["bulleted_list_item: 1: x", "bulleted_list_item: 2: y", "heading_2: Not A", "paragraph: — Kim", "paragraph: **filled**"]);
  await assert.rejects(t.compileTemplate(x, { items: [] }, { slots: { nope: "x" } }), /no slot "nope"/);
  // A part that includes itself stops instead of looping forever.
  const loop = tpl([{ part: "p" }], { parts: { p: [{ part: "p" }] } });
  await assert.rejects(t.compileTemplate(loop, {}), /nest more than 20/);
});

test("views must be at the top level; charts get placeholders whose paths reach them inside columns and toggles", async () => {
  const bad = tpl([{ columns: [[{ view: { database: "db", view: { name: "V", type: "table" } } }], [{ markdown: "x" }]] }]);
  await assert.rejects(t.compileTemplate(bad, {}), /only be at the top level/);
  const x = tpl([
    { markdown: "intro" },
    { columns: [[{ markdown: "left" }], [{ chart: { spec: { type: "column", title: "In column" }, data: [{ x: "a", y: 1 }] } }]] },
    { toggle: "More", children: [{ chart: { spec: { type: "line", title: "In toggle" }, data: [{ x: "a", y: 1 }, { x: "b", y: 2 }] } }] },
  ]);
  const c = await t.compileTemplate(x, {});
  assert.equal(c.charts.length, 2);
  for (const ch of c.charts) {
    const { list, index } = t.specAt(c.specs, ch.path);
    assert.equal(list[index].text, `[chart: ${ch.spec.title}]`);
  }
});

test("diffLines reports what a render would add and drop", () => {
  const d = t.diffLines(["heading_2: A", "paragraph: old", "divider"], ["heading_2: A", "paragraph: new", "divider", "paragraph: extra"]);
  assert.deepEqual(d, { added: ["paragraph: new", "paragraph: extra"], removed: ["paragraph: old"], unchanged: 2 });
});

test("writeTemplate uploads charts into their placeholders, adds data tables, and creates the page", async () => {
  const appended: { block_id: string; children: Record<string, unknown>[] }[] = [];
  let created: Record<string, unknown> | null = null;
  let uploads = 0;
  let n = 0;
  setClientForTests({
    pages: { create: async (b: Record<string, unknown>) => ((created = b), { object: "page", id: "page-1", url: "https://notion.so/page-1" }) },
    fileUploads: {
      create: async () => ({ id: `up-${++uploads}` }),
      send: async () => ({}),
    },
    blocks: {
      children: {
        append: async (a: { block_id: string; children: Record<string, unknown>[] }) => {
          appended.push(a);
          return { results: a.children.map(() => ({ id: `b-${++n}` })) };
        },
      },
    },
  } as unknown as Client);
  try {
    const x = tpl([
      { heading: "Numbers" },
      { chart: { spec: { type: "column", title: "Sales" }, data: [{ x: "Q1", y: 3 }, { x: "Q2", y: 5 }], data_table: true } },
      { markdown: "after" },
    ]);
    const c = await t.compileTemplate(x, {});
    const undo: import("../src/services/journal.js").UndoOp[] = [];
    const r = await t.writeTemplate(c, { parent: "11111111111111111111111111111111" }, undo);
    assert.equal(r.page_id, "page-1");
    assert.equal(uploads, 1);
    assert.deepEqual(undo, [{ kind: "page_trash", page_id: "page-1", in_trash: true }]);
    assert.match(JSON.stringify(created), /T \d{4}-\d{2}-\d{2}/);
    const top = appended[0].children.map((b) => b.type);
    assert.deepEqual(top, ["heading_2", "image", "toggle", "paragraph"]);
    const image = appended[0].children[1].image as { file_upload: { id: string } };
    assert.equal(image.file_upload.id, "up-1");
    const spec: BlockSpec[] = c.specs;
    assert.equal(spec[2].type, "toggle", "the data table toggle sits right after the chart");
  } finally {
    setClientForTests(null);
  }
}, 60_000);

test("saved templates: save, list (replacing a built-in by name), delete", async () => {
  const mine = t.parseTemplate({ version: 1, name: "content-brief", description: "mine", title: "Mine", blocks: [{ markdown: "x" }] });
  await t.saveTemplate(mine);
  const all = await t.listTemplates();
  assert.equal(all.find((x) => x.template.name === "content-brief")?.builtin, false);
  assert.equal(all.length, 5);
  assert.equal(await t.deleteTemplate("content-brief"), true);
  assert.equal((await t.listTemplates()).find((x) => x.template.name === "content-brief")?.builtin, true);
  assert.equal(await t.deleteTemplate("content-brief"), false);
});

const rt = (text: string) => [{ type: "text", text: { content: text, link: null }, annotations: {}, plain_text: text, href: null }];
const DS = "2a1b3c4d-0000-4000-8000-000000000001";

/** A Tasks database (title, status with groups, due date, owner) whose queries return every row and record the filter. */
function fakeTasks() {
  const filters: unknown[] = [];
  const row = (id: string, name: string, status: string, due: string | null, owner: string) => ({
    object: "page",
    id,
    url: `https://notion.so/${id.replace(/-/g, "")}`,
    parent: { type: "data_source_id", data_source_id: DS },
    properties: {
      Name: { id: "t", type: "title", title: rt(name) },
      Status: { id: "s", type: "status", status: { name: status } },
      Due: { id: "d", type: "date", date: due ? { start: due, end: null } : null },
      Owner: { id: "o", type: "select", select: { name: owner } },
    },
  });
  const rows = [
    row("2a1b3c4d-0000-4000-8000-0000000000a1", "Spec", "Done", "2026-09-01", "Ana"),
    row("2a1b3c4d-0000-4000-8000-0000000000a2", "Build", "In progress", "2026-09-20", "Kim"),
    row("2a1b3c4d-0000-4000-8000-0000000000a3", "Ship", "Not started", "2099-01-01", "Kim"),
  ];
  const client = {
    dataSources: {
      retrieve: async () => ({
        object: "data_source",
        id: DS,
        title: rt("Tasks"),
        parent: { type: "database_id", database_id: DS },
        properties: {
          Name: { id: "t", name: "Name", type: "title", title: {} },
          Status: {
            id: "s",
            name: "Status",
            type: "status",
            status: {
              options: [{ id: "s1", name: "Not started", color: "gray" }, { id: "s2", name: "In progress", color: "blue" }, { id: "s3", name: "Done", color: "green" }],
              groups: [{ id: "g1", name: "To-do", color: "gray", option_ids: ["s1"] }, { id: "g2", name: "In progress", color: "blue", option_ids: ["s2"] }, { id: "g3", name: "Complete", color: "green", option_ids: ["s3"] }],
            },
          },
          Due: { id: "d", name: "Due", type: "date", date: {} },
          Owner: { id: "o", name: "Owner", type: "select", select: { options: [{ id: "a", name: "Ana", color: "red" }, { id: "k", name: "Kim", color: "blue" }] } },
        },
      }),
      query: async (a: { filter?: unknown }) => {
        filters.push(a.filter ?? null);
        return { object: "list", results: rows, has_more: false, next_cursor: null };
      },
    },
  };
  return { client, filters };
}

test("database-report: summary, chart, table, and Gantt come from the database; where flows into the queries", async () => {
  const { client, filters } = fakeTasks();
  setClientForTests(client as unknown as Client);
  try {
    const tmpl = t.parseTemplate(BUILTIN_TEMPLATES.find((x) => (x as { name: string }).name === "database-report"));
    const c = await t.compileTemplate(tmpl, {
      database: DS,
      title: "Tasks",
      where: { Owner: "Kim" },
      chart_x: "Status",
      table_where: { Status: { not: "Done" } },
      table_properties: ["Name", "Status", "Due"],
      gantt_start: "Due",
    });
    const lines = t.outline(c.specs);
    // Summary: 3 rows (the fake ignores filters), 1 complete, 1 overdue (Build: due 2026-09-20, not done).
    assert.match(lines[0], /\*\*3\*\* rows · \*\*1\*\* complete \(33%\) · \*\*1\*\* overdue/);
    assert.ok(lines.some((l) => /\[chart: Breakdown\]/.test(l)), lines.join("\n"));
    assert.equal(c.charts.length, 1);
    assert.deepEqual(c.charts[0].rows.map((r) => r.x).sort(), ["Done", "In progress", "Not started"]);
    const table = c.specs.find((s) => s.type === "table") as BlockSpec & { rows: string[][] };
    assert.deepEqual(table.rows[0], ["Name", "Status", "Due"]);
    const gantt = c.specs.find((s) => s.type === "code") as BlockSpec;
    assert.match(gantt.text ?? "", /gantt[\s\S]*Spec[\s\S]*:done[\s\S]*Build[\s\S]*:crit/);
    // The `where` variable reached the queries as a real filter, not text.
    assert.ok(filters.some((f) => JSON.stringify(f).includes("Kim")), JSON.stringify(filters));
    assert.ok(!JSON.stringify(c.specs).includes("{{"));
  } finally {
    setClientForTests(null);
  }
});

test("database-report with only the database: summary and table, no chart or Gantt", async () => {
  const { client } = fakeTasks();
  setClientForTests(client as unknown as Client);
  try {
    const tmpl = t.parseTemplate(BUILTIN_TEMPLATES.find((x) => (x as { name: string }).name === "database-report"));
    const c = await t.compileTemplate(tmpl, { database: DS });
    assert.equal(c.charts.length, 0);
    assert.ok(!c.specs.some((s) => s.type === "code"));
    assert.ok(c.specs.some((s) => s.type === "table"));
  } finally {
    setClientForTests(null);
  }
});

test("a {{variable}} where an object is expected must hold an object", async () => {
  const { client } = fakeTasks();
  setClientForTests(client as unknown as Client);
  try {
    const x = tpl([{ summary: { database: DS, where: "{{w}}" } }], { variables: { w: { type: "string" } } });
    await assert.rejects(t.compileTemplate(x, { w: "Status = Done" }), /should be an object/);
    assert.throws(() => tpl([{ summary: { database: DS, where: "Status = Done" } }]), /value or a \{\{variable\}\}/);
  } finally {
    setClientForTests(null);
  }
});
