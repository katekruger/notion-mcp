// Live integration suite: runs every tool handler against a real Notion workspace.
//
//   NOTION_TOKEN=ntn_... NOTION_TEST_PAGE=<page url or id> npm run test:live
//   (or put both in .env)
//
// Everything is created inside a fresh pair of databases under NOTION_TEST_PAGE and
// trashed at the end, even when steps fail. The undo journal goes to a temp folder,
// never to ~/.notion-plus. Set SMOKE_KEEP=1 to leave the databases for inspection.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

try {
  process.loadEnvFile?.(".env");
} catch {
  // No .env is fine; the variables may come from the environment.
}
process.env.NOTION_PLUS_HOME = mkdtempSync(path.join(os.tmpdir(), "notion-plus-smoke-"));
process.env.NOTION_PLUS_RULES = path.join(process.env.NOTION_PLUS_HOME, "rules.json"); // never touch the repo's rules

const { call, normalizeId, notion } = await import("../src/services/notion.js");
const { registerReadTools } = await import("../src/tools/read.js");
const { registerPageTools } = await import("../src/tools/pages.js");
const { registerBlockTools } = await import("../src/tools/blocks.js");
const { registerSafetyTools, registerSchemaTools } = await import("../src/tools/schema.js");
const { registerAutomationTools } = await import("../src/tools/automations.js");
const { registerContentTools } = await import("../src/tools/content.js");
const { runAll } = await import("../src/services/automations.js");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Handler = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

const tools = new Map<string, { schema: z.ZodTypeAny; handler: Handler }>();
const registry = {
  registerTool(name: string, config: { inputSchema: z.ZodRawShape }, handler: Handler) {
    tools.set(name, { schema: z.object(config.inputSchema), handler });
  },
};
for (const register of [registerReadTools, registerPageTools, registerBlockTools, registerContentTools, registerSchemaTools, registerSafetyTools, registerAutomationTools]) {
  register(registry as never);
}

/** Call a tool the way the MCP server would: parse args with its schema (applies defaults), then run the handler. */
async function tool(name: string, args: Record<string, unknown>): Promise<{ text: string; json: Json; isError: boolean }> {
  const t = tools.get(name);
  if (!t) throw new Error(`No tool ${name}`);
  const r = await t.handler(t.schema.parse(args));
  const text = r.content[0]?.text ?? "";
  let json: Json = {};
  try {
    json = JSON.parse(text);
  } catch {
    // Some tools return prose.
  }
  return { text, json, isError: Boolean(r.isError) };
}

/** Like tool(), but a tool error fails the step. */
async function must(name: string, args: Record<string, unknown>): Promise<Json> {
  const r = await tool(name, args);
  if (r.isError) throw new Error(`${name} failed: ${r.text}`);
  return r.json;
}

const results: { step: string; ok: boolean; detail: string }[] = [];
const touched = new Set<string>();
async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  touched.add(name.split(":")[0]);
  const started = Date.now();
  try {
    const out = await fn();
    const detail = typeof out === "string" ? out : "";
    results.push({ step: name, ok: true, detail });
    console.log(`  ok    ${name} (${Date.now() - started} ms)${detail ? ` - ${detail}` : ""}`);
  } catch (e) {
    const detail = (e as Error).message.split("\n").slice(0, 4).join(" | ");
    results.push({ step: name, ok: false, detail });
    console.log(`  FAIL  ${name} - ${detail}`);
  }
}
function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

const token = process.env.NOTION_TOKEN;
const testPage = process.env.NOTION_TEST_PAGE;
if (!token || !testPage) {
  console.error("Set NOTION_TOKEN and NOTION_TEST_PAGE (env or .env).");
  process.exit(2);
}
const pageId = normalizeId(testPage);
const stamp = `smoke-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const n = notion();
const createdDatabases: string[] = [];
const createdPages: string[] = [];

async function blockText(id: string): Promise<string> {
  const b = (await call(() => n.blocks.retrieve({ block_id: id }))) as unknown as Json;
  if (b.type === "table_row") return b.table_row.cells.map((c: Json[]) => c.map((s) => s.plain_text).join("")).join(" | ");
  return (b[b.type].rich_text ?? []).map((s: Json) => s.plain_text).join("");
}

function rt(content: string) {
  return [{ type: "text", text: { content } }];
}

async function createDatabase(title: string, properties: Record<string, unknown>): Promise<{ db: string; ds: string }> {
  const res = (await call(() =>
    n.databases.create({ parent: { type: "page_id", page_id: pageId }, title: rt(title), initial_data_source: { properties } } as never)
  )) as unknown as { id: string; data_sources?: { id: string }[] };
  createdDatabases.push(res.id);
  const ds = res.data_sources?.[0]?.id;
  if (!ds) throw new Error(`Database ${res.id} came back without a data source`);
  return { db: res.id, ds };
}

async function blockAt(page: string, text: string): Promise<string> {
  const r = await must("notion_find_blocks", { page, query: text });
  expect(r.count >= 1, `no block matching "${text}"`);
  return r.matches[0].id as string;
}

async function prop(page: string, name: string): Promise<unknown> {
  const r = await tool("notion_get_page", { page, include_content: false });
  expect(!r.isError, r.text);
  return r.json.properties[name];
}

async function main(): Promise<void> {
  console.log(`Smoke run ${stamp} under page ${pageId}\n`);

  // ---------- setup ----------
  let related = { db: "", ds: "" };
  let main = { db: "", ds: "" };
  let hasStatus = true;
  const relRows: string[] = [];
  let person: { id: string; email?: string } | null = null;

  await step("setup: related database", async () => {
    related = await createDatabase(`${stamp} related`, { Name: { title: {} } });
  });
  const mainProps: Record<string, unknown> = {
    Name: { title: {} },
    Status: { status: {} },
    Priority: { select: { options: [{ name: "Low", color: "gray" }, { name: "High", color: "red" }] } },
    Tags: { multi_select: { options: [{ name: "Alpha" }, { name: "Beta" }] } },
    Due: { date: {} },
    Points: { number: { format: "number" } },
    Done: { checkbox: {} },
    Automated: { checkbox: {} },
    Owner: { people: {} },
    Related: { relation: { data_source_id: related.ds, type: "single_property", single_property: {} } },
  };
  await step("setup: main database with all property types", async () => {
    try {
      main = await createDatabase(`${stamp} main`, mainProps);
    } catch (e) {
      // If the API refuses to create a status property, keep testing everything else.
      if (!/status/i.test((e as Error).message)) throw e;
      hasStatus = false;
      delete mainProps.Status;
      main = await createDatabase(`${stamp} main`, mainProps);
      throw new Error(`status property could not be created via API (${(e as Error).message}); continuing without it`);
    }
  });
  if (!main.ds) throw new Error("Could not create the test database; stopping.");

  await step("setup: 30 related rows", async () => {
    for (let i = 0; i < 30; i++) {
      const p = await call(() =>
        n.pages.create({ parent: { type: "data_source_id", data_source_id: related.ds }, properties: { Name: { title: rt(`rel ${i}`) } } } as never)
      );
      relRows.push(p.id);
    }
  });
  await step("setup: find a person user", async () => {
    let p: { id: string; person?: { email?: string } } | undefined;
    let listable = true;
    try {
      const users = await call(() => n.users.list({}));
      p = users.results.find((u) => u.type === "person") as typeof p;
    } catch {
      listable = false;
      const tp = (await call(() => n.pages.retrieve({ page_id: pageId }))) as unknown as { created_by: { id: string } };
      p = { id: tp.created_by.id };
    }
    if (!p) return "no person users visible; people steps will be skipped";
    if (!listable) {
      person = { id: p.id };
      return "token can't list users (personal access token); using the test page's creator id";
    }
    person = { id: p.id, ...(p.person?.email ? { email: p.person.email } : {}) };
    return person.email ? "email visible" : "email NOT visible (integration lacks the email capability)";
  });

  // ---------- read tools ----------
  await step("notion_search: data_source filter", async () => {
    let r: Json = {};
    for (let i = 0; i < 6; i++) {
      r = await must("notion_search", { query: stamp, type: "data_source" });
      if (r.count >= 1) break;
      await new Promise((res) => setTimeout(res, 5000)); // the search index lags new databases
    }
    const types = new Set((r.results ?? []).map((x: Json) => x.type));
    expect(r.count >= 1, "no databases found after 30s of retries");
    expect(types.size === 1 && types.has("database"), `unexpected result types ${[...types]}`);
    return `${r.count} results`;
  });
  await step("notion_search: page filter + sort", async () => {
    const r = await tool("notion_search", { query: "", type: "page", limit: 5 });
    expect(!r.isError, r.text);
    return r.json.count ? `${r.json.count} pages, newest ${r.json.results[0].last_edited}` : r.text;
  });
  await step("notion_get_schema", async () => {
    const r = await must("notion_get_schema", { database: main.db });
    const names = r.properties.map((p: Json) => p.name);
    for (const want of Object.keys(mainProps)) expect(names.includes(want), `schema missing ${want}`);
    return hasStatus ? `status options: ${r.properties.find((p: Json) => p.name === "Status").options.join(", ")}` : "";
  });

  // ---------- create rows ----------
  const deepMarkdown = [
    "# Q3 plan",
    "Intro with **Q3 bold** and a [link](https://example.com).",
    "## Second heading",
    "Paragraph under second heading.",
    "### Third heading",
    "- level 1",
  ].join("\n");
  const deepBlocks = [
    {
      type: "bulleted_list_item",
      text: "deep 1",
      children: [{ type: "bulleted_list_item", text: "deep 2", children: [{ type: "bulleted_list_item", text: "deep 3", children: [{ type: "paragraph", text: "deep 4" }] }] }],
    },
    { type: "paragraph", text: "Delete me" },
    { type: "to_do", text: "Existing task", checked: false },
  ];
  const rows: string[] = [];
  await step("notion_create_page: row with every property + 4-level content", async () => {
    const r = await must("notion_create_page", {
      parent: main.db,
      title: "Row A",
      properties: {
        ...(hasStatus ? { status: "not started" } : {}),
        Priority: "high",
        Tags: ["alpha", "Beta"],
        Due: "2026-10-01",
        Points: "1,200",
        Done: "yes",
        ...(person ? { Owner: [person.id] } : {}),
        Related: [relRows[0]],
      },
      markdown: deepMarkdown,
      blocks: deepBlocks,
    });
    rows.push(r.page_id);
    return `notes: ${r.notes.join("; ") || "none"}`;
  });
  await step("notion_create_page: rows B and C", async () => {
    for (const title of ["Row B", "Row C"]) {
      const r = await must("notion_create_page", { parent: main.db, title, properties: hasStatus ? { Status: "Not started" } : {} });
      rows.push(r.page_id);
    }
  });
  await step("notion_create_page: invalid values report every problem, write nothing", async () => {
    const r = await tool("notion_create_page", { parent: main.db, title: "Bad", properties: { Points: "abc", Priority: "Nope", Nonexistent: 1 } });
    expect(r.isError, "expected an error");
    expect(/abc/.test(r.text) && /Nope/.test(r.text) && /Nonexistent/.test(r.text), `not all problems reported: ${r.text}`);
    const q = await must("notion_query", { database: main.db, where: { Name: "Bad" } });
    expect(q.count === 0, "a row was created despite the error");
  });
  const [rowA, rowB, rowC] = rows;

  await step("notion_get_page: 4-level nesting landed intact", async () => {
    const r = await tool("notion_get_page", { page: rowA, max_depth: 6 });
    expect(!r.isError, r.text);
    const line = r.text.split("\n").find((l) => l.includes("deep 4"));
    expect(line, "deep 4 missing");
    expect(line.startsWith("      - "), `deep 4 at wrong depth: "${line}"`);
  });
  await step("notion_get_blocks", async () => {
    const r = await tool("notion_get_blocks", { block: rowA, max_depth: 1 });
    expect(!r.isError && r.text.includes("Q3 plan"), r.text.slice(0, 200));
  });
  await step("notion_find_blocks: regex", async () => {
    const r = await must("notion_find_blocks", { page: rowA, query: "deep \\d", regex: true, max_depth: 6 });
    expect(r.count === 4, `expected 4 matches, got ${r.count}`);
  });
  await step("notion_query: where + properties + sorts", async () => {
    const where = hasStatus ? { Status: "not started" } : { Name: "Row B" };
    const r = await must("notion_query", { database: main.db, where, properties: ["Name"], sorts: [{ property: "name" }] });
    expect(r.count === (hasStatus ? 3 : 1), `expected ${hasStatus ? 3 : 1} rows, got ${r.count}`);
    return r.rows.map((x: Json) => x.Name).join(", ");
  });

  // ---------- property writes + undo ----------
  await step("notion_update_properties: dry_run writes nothing", async () => {
    const r = await must("notion_update_properties", { page: rowA, properties: { Points: 5 }, dry_run: true });
    expect(r.dry_run && r.before.Points === 1200, JSON.stringify(r));
    expect((await prop(rowA, "Points")) === 1200, "dry run changed the value");
  });
  await step("notion_update_properties: write then undo", async () => {
    const r = await must("notion_update_properties", { page: rowA, properties: { Points: 5, Done: false, Tags: [] } });
    expect((await prop(rowA, "Points")) === 5, "write did not land");
    await must("notion_undo", { undo_id: r.undo_id });
    expect((await prop(rowA, "Points")) === 1200, "undo did not restore Points");
    expect((await prop(rowA, "Done")) === true, "undo did not restore Done");
    expect(JSON.stringify(await prop(rowA, "Tags")) === JSON.stringify(["Alpha", "Beta"]), "undo did not restore Tags");
  });
  await step("notion_update_properties: stale expected_last_edited_time is refused", async () => {
    const r = await tool("notion_update_properties", { page: rowA, properties: { Points: 9 }, expected_last_edited_time: "2000-01-01T00:00:00Z" });
    expect(r.isError && /edited at/.test(r.text), r.text);
  });

  await step("notion_undo: refuses to overwrite a later edit, then force overwrites it", async () => {
    const r = await must("notion_update_properties", { page: rowA, properties: { Points: 7 } });
    // Notion reports edit times to the minute, so the outside edit must land in a later minute to be visible.
    const wait = 61_000 - (Date.now() % 60_000);
    await new Promise((res) => setTimeout(res, wait));
    await call(() => n.pages.update({ page_id: rowA, properties: { Points: { number: 8 } } } as never));
    const refused = await tool("notion_undo", { undo_id: r.undo_id });
    expect(refused.isError && /Nothing was undone/.test(refused.text), refused.text);
    expect((await prop(rowA, "Points")) === 8, "refused undo still wrote");
    const forced = await must("notion_undo", { undo_id: r.undo_id, force: true });
    expect(forced.overwrote_later_edits?.length === 1, JSON.stringify(forced));
    expect((await prop(rowA, "Points")) === 1200, "forced undo did not restore Points");
    return `waited ${Math.round(wait / 1000)}s for the next minute`;
  });

  if (hasStatus) {
    await step("notion_bulk_update: dry_run, apply, undo", async () => {
      const dry = await must("notion_bulk_update", { database: main.db, where: { Status: "Not started" }, set: { Status: "In progress" } });
      expect(dry.dry_run && dry.matched === 3, `dry run matched ${dry.matched}`);
      const still = await must("notion_query", { database: main.db, where: { Status: "Not started" } });
      expect(still.count === 3, "dry run wrote");
      const applied = await must("notion_bulk_update", { database: main.db, where: { Status: "Not started" }, set: { Status: "In progress" }, dry_run: false });
      expect(applied.updated === 3 && applied.failed.length === 0, JSON.stringify(applied));
      const moved = await must("notion_query", { database: main.db, where: { Status: "In progress" } });
      expect(moved.count === 3, `after apply ${moved.count} rows In progress`);
      await must("notion_undo", { undo_id: applied.undo_id });
      const back = await must("notion_query", { database: main.db, where: { Status: "Not started" } });
      expect(back.count === 3, `after undo ${back.count} rows Not started`);
    });
  }

  await step("truncation: 30 relations survive update + undo", async () => {
    await must("notion_update_properties", { page: rowC, properties: { Related: relRows } });
    const cleared = await must("notion_update_properties", { page: rowC, properties: { Related: [] } });
    expect(cleared.before.Related.length === 30, `before shows ${cleared.before.Related.length} relations, expected 30`);
    await must("notion_undo", { undo_id: cleared.undo_id });
    const page = await call(() => n.pages.retrieve({ page_id: rowC }));
    const propId = (page as unknown as { properties: Record<string, { id: string }> }).properties.Related.id;
    let count = 0;
    let cursor: string | undefined;
    do {
      const res = (await call(() => n.pages.properties.retrieve({ page_id: rowC, property_id: propId, ...(cursor ? { start_cursor: cursor } : {}) }))) as unknown as {
        results: unknown[];
        has_more: boolean;
        next_cursor: string | null;
      };
      count += res.results.length;
      cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
    } while (cursor);
    expect(count === 30, `after undo ${count} relations, expected 30`);
  });
  await step("limits: >100 relations rejected before writing", async () => {
    const r = await tool("notion_update_properties", { page: rowC, properties: { Related: Array.from({ length: 101 }, () => relRows[0]) } });
    expect(r.isError && /at most 100/.test(r.text), r.text);
  });
  await step("people: set by id; name lookup explains itself", async () => {
    if (!person) return "skipped: no person users";
    const byId = await tool("notion_update_properties", { page: rowB, properties: { Owner: [(person as { id: string }).id] } });
    expect(!byId.isError, byId.text);
    const byName = await tool("notion_update_properties", { page: rowB, properties: { Owner: "someone@example.com" } });
    expect(byName.isError, "lookup by email of an unknown user should fail");
    if (/Pass Notion user ids/.test(byName.text)) return "set by id; email lookup unavailable to this token (clear error shown)";
  });
  await step("people: set by email", async () => {
    if (!person) return "skipped: no person users";
    const p = person as { id: string; email?: string };
    const r = await tool("notion_update_properties", { page: rowB, properties: { Owner: p.email ?? "nobody@example.com" } });
    if (!p.email) {
      expect(r.isError && /capability|user ids/.test(r.text), `expected a hint, got: ${r.text}`);
      return "email hidden; capability hint shown";
    }
    expect(!r.isError, r.text);
    return "resolved by email";
  });

  // ---------- block writes + undo ----------
  await step("notion_patch_block: edit then undo", async () => {
    const id = await blockAt(rowA, "Existing task");
    const r = await must("notion_patch_block", { block_id: id, text: "Edited task", checked: true });
    await must("notion_undo", { undo_id: r.undo_id });
    const b = (await call(() => n.blocks.retrieve({ block_id: id }))) as unknown as Json;
    expect(b.to_do.rich_text[0].plain_text === "Existing task" && b.to_do.checked === false, "undo did not restore text/checked");
  });
  await step("notion_insert_blocks: after the second heading, then undo", async () => {
    const heading = await blockAt(rowA, "Second heading");
    const r = await must("notion_insert_blocks", { parent: rowA, position: "after_block", after_block_id: heading, markdown: "- [ ] Inserted to-do" });
    const kids = (await call(() => n.blocks.children.list({ block_id: rowA }))).results as Json[];
    const idx = kids.findIndex((k) => k.id === heading);
    expect(kids[idx + 1]?.id === r.block_ids[0], "insert did not land right after the heading");
    await must("notion_undo", { undo_id: r.undo_id });
    const after = (await call(() => n.blocks.children.list({ block_id: rowA }))).results as Json[];
    expect(!after.some((k) => k.id === r.block_ids[0]), "undo did not remove the inserted block");
  });
  await step("notion_insert_blocks: start position with 120 blocks", async () => {
    const md = Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n\n");
    const r = await must("notion_insert_blocks", { parent: rowB, position: "start", markdown: md });
    expect(r.inserted === 120, `inserted ${r.inserted}`);
    const kids = (await call(() => n.blocks.children.list({ block_id: rowB, page_size: 100 }))).results as Json[];
    expect(kids[0].paragraph.rich_text[0].plain_text === "line 0" && kids[99].paragraph.rich_text[0].plain_text === "line 99", "order wrong");
    await must("notion_undo", { undo_id: r.undo_id });
  });
  await step("notion_replace_text: dry_run, apply, undo; formatting kept", async () => {
    const dry = await must("notion_replace_text", { page: rowA, find: "Q3", replace: "Q4" });
    expect(dry.dry_run && dry.total_replacements === 2, `dry run found ${dry.total_replacements}`);
    expect((await tool("notion_find_blocks", { page: rowA, query: "Q4" })).json.count === 0, "dry run wrote");
    const applied = await must("notion_replace_text", { page: rowA, find: "Q3", replace: "Q4", dry_run: false });
    expect(applied.changed === 2, JSON.stringify(applied));
    const intro = await blockAt(rowA, "Q4 bold");
    const b = (await call(() => n.blocks.retrieve({ block_id: intro }))) as unknown as Json;
    const boldSeg = b.paragraph.rich_text.find((s: Json) => s.plain_text.includes("Q4"));
    expect(boldSeg?.annotations.bold, "bold lost");
    expect(b.paragraph.rich_text.some((s: Json) => s.href?.startsWith("https://example.com")), "link lost");
    await must("notion_undo", { undo_id: applied.undo_id });
    expect((await tool("notion_find_blocks", { page: rowA, query: "Q4" })).json.count === 0, "undo left Q4 text");
  });
  await step("notion_delete_blocks: delete then undo restores the block", async () => {
    const id = await blockAt(rowA, "Delete me");
    const r = await must("notion_delete_blocks", { block_ids: [id] });
    expect(r.deleted.length === 1, JSON.stringify(r));
    const u = await must("notion_undo", { undo_id: r.undo_id });
    expect(!u.failed, `restoring a trashed block failed: ${JSON.stringify(u.failed)}`);
    const b = (await call(() => n.blocks.retrieve({ block_id: id }))) as unknown as Json;
    expect(b.in_trash === false || b.archived === false, "block still in trash after undo");
  });

  // ---------- schema writes + undo ----------
  await step("notion_add_property: add then undo", async () => {
    const r = await must("notion_add_property", { database: main.db, name: "Extra", type: "number" });
    await must("notion_undo", { undo_id: r.undo_id });
    const s = await must("notion_get_schema", { database: main.db });
    expect(!s.properties.some((p: Json) => p.name === "Extra"), "Extra still present");
  });
  await step("notion_update_options: add keeps rows; undo removes only the added option", async () => {
    const r = await must("notion_update_options", { database: main.db, property: "Priority", add: ["Medium"] });
    expect((await prop(rowA, "Priority")) === "High", "row A lost its option after adding one");
    await must("notion_update_properties", { page: rowB, properties: { Priority: "Medium" } });
    await must("notion_undo", { undo_id: r.undo_id });
    const s = await must("notion_get_schema", { database: main.db });
    const opts = s.properties.find((p: Json) => p.name === "Priority").options;
    expect(JSON.stringify(opts) === JSON.stringify(["Low", "High"]), `options after undo: ${opts}`);
    expect((await prop(rowA, "Priority")) === "High", "row A lost High after undo");
    return `row B (was Medium) now: ${JSON.stringify(await prop(rowB, "Priority"))}`;
  });
  await step("notion_update_options: rename is refused clearly, nothing changes", async () => {
    const r = await tool("notion_update_options", { database: main.db, property: "Priority", rename: [{ from: "high", to: "Urgent" }] });
    expect(r.isError && /can't rename/.test(r.text), r.text);
    expect((await prop(rowA, "Priority")) === "High", "row A changed");
  });
  await step("notion_insert_blocks: after_block undo leaves later siblings alone", async () => {
    const heading = await blockAt(rowA, "Second heading");
    const before = (await call(() => n.blocks.children.list({ block_id: rowA }))).results.length;
    const r = await must("notion_insert_blocks", { parent: rowA, position: "after_block", after_block_id: heading, markdown: "one\n\ntwo" });
    expect(r.block_ids.length === 2, `recorded ${r.block_ids.length} ids for 2 blocks`);
    await must("notion_undo", { undo_id: r.undo_id });
    const after = (await call(() => n.blocks.children.list({ block_id: rowA }))).results.length;
    expect(after === before, `page had ${before} top-level blocks, now ${after}`);
  });
  await step("notion_rename_property: rename then undo", async () => {
    const r = await must("notion_rename_property", { database: main.db, from: "points", to: "Score" });
    expect((await prop(rowA, "Score")) === 1200, "renamed property missing");
    await must("notion_undo", { undo_id: r.undo_id });
    expect((await prop(rowA, "Points")) === 1200, "rename not undone");
  });

  // ---------- automations ----------
  if (hasStatus) {
    let trashRow = "";
    const today = new Date().toISOString().slice(0, 10);
    const rules = [
      {
        id: "stamp-done",
        database: main.db,
        when: { where: { Status: "Done", Due: null } },
        actions: [{ set: { Due: "{{today}}" } }, { append: "Closed on {{today}}" }, { comment: "Closed by automation: {{page.Name}}" }],
      },
      { id: "flag-high", database: main.db, when: { where: { Priority: "High" } }, actions: [{ comment: "High priority row" }], marker: "Automated" },
      { id: "trash-marked", database: main.db, when: { where: { Name: "Trash me" } }, actions: [{ trash: true }] },
    ];
    await step("notion_automation_add: rules checked against the schema, with preview", async () => {
      trashRow = (await must("notion_create_page", { parent: main.db, title: "Trash me" })).page_id;
      await must("notion_update_properties", { page: rowB, properties: { Status: "Done", Due: null } });
      for (const rule of rules) {
        const r = await must("notion_automation_add", { rule });
        expect(r.saved === rule.id, JSON.stringify(r));
      }
      const listed = await must("notion_automation_list", {});
      expect(listed.rules.length === 3, `listed ${listed.rules.length} rules`);
    });
    await step("notion_automation_add: a rule that would repeat forever is refused", async () => {
      const r = await tool("notion_automation_add", { rule: { id: "loop", database: main.db, when: { where: { Status: "Done" } }, actions: [{ comment: "again" }] } });
      expect(r.isError && /every run/.test(r.text), r.text);
    });
    await step("notion_automation_add: relative date conditions query cleanly", async () => {
      const r = await must("notion_automation_add", {
        rule: { id: "recent", enabled: false, database: main.db, when: { relative: [{ property: "$created", newer_than_days: 1 }] }, actions: [{ comment: "x" }], marker: "Automated" },
      });
      expect(/would act on [1-9]/.test(r.preview), r.preview);
    });
    await step("notion_automation_dry_run: previews and writes nothing", async () => {
      const r = await tool("notion_automation_dry_run", {});
      expect(!r.isError && /stamp-done.*would act on 1/.test(r.text) && /flag-high.*would act on 1/.test(r.text) && /trash-marked.*would act on 1/.test(r.text), r.text);
      expect((await prop(rowB, "Due")) === null, "dry run wrote Due");
    });
    let undoIds: string[] = [];
    await step("automations run: set, append, comment, marker, trash", async () => {
      const results = await runAll({ dryRun: false });
      for (const res of results) expect(!res.error && res.acted === 1, `${res.rule}: ${res.error ?? `acted ${res.acted}`} ${JSON.stringify(res.rows)}`);
      undoIds = results.map((r) => r.undo_id).filter((x): x is string => Boolean(x));
      expect((await prop(rowB, "Due")) === today, `Due is ${JSON.stringify(await prop(rowB, "Due"))}`);
      expect((await tool("notion_find_blocks", { page: rowB, query: `Closed on ${today}` })).json.count === 1, "append missing");
      const comments = (await call(() => n.comments.list({ block_id: rowB }))).results as Json[];
      expect(comments.some((c) => c.rich_text.map((t: Json) => t.plain_text).join("").includes("Closed by automation: Row B")), "comment missing");
      expect((await prop(rowA, "Automated")) === true, "marker not set");
      const t = (await call(() => n.pages.retrieve({ page_id: trashRow }))) as unknown as Json;
      expect(t.in_trash === true, "row not trashed");
    });
    await step("automations run again: nothing matches (rules are one-time per row)", async () => {
      const results = await runAll({ dryRun: false });
      expect(results.every((r) => r.acted === 0 && !r.error), JSON.stringify(results.map((r) => [r.rule, r.acted, r.error])));
    });
    await step("automations undo: every rule's run reverts", async () => {
      for (const id of undoIds) await must("notion_undo", { undo_id: id });
      expect((await prop(rowB, "Due")) === null, "Due not reverted");
      expect((await tool("notion_find_blocks", { page: rowB, query: "Closed on" })).json.count === 0, "appended block not removed");
      expect((await prop(rowA, "Automated")) === false, "marker not reverted");
      const t = (await call(() => n.pages.retrieve({ page_id: trashRow }))) as unknown as Json;
      expect(t.in_trash === false, "trashed row not restored");
      const comments = (await call(() => n.comments.list({ block_id: rowB }))).results as Json[];
      expect(!comments.some((c) => c.rich_text.map((x: Json) => x.plain_text).join("").includes("Closed by automation")), "automation comment not deleted");
    });
  }

  // ---------- content limits ----------
  await step("limits: 5000-char paragraph is written in full", async () => {
    const r = await must("notion_insert_blocks", { parent: rowB, blocks: [{ type: "paragraph", text: "y".repeat(5000) }] });
    const b = (await call(() => n.blocks.retrieve({ block_id: r.block_ids[0] }))) as unknown as Json;
    const len = b.paragraph.rich_text.reduce((sum: number, seg: Json) => sum + seg.plain_text.length, 0);
    expect(len === 5000, `stored ${len} chars`); // sent as 3 segments; Notion merges them on read
  });
  await step("limits: >100 segments rejected before writing", async () => {
    const r = await tool("notion_insert_blocks", { parent: rowB, blocks: [{ type: "paragraph", text: "z".repeat(200_001) }] });
    expect(r.isError && /rich text segments/.test(r.text), r.text.slice(0, 200));
  });

  // ---------- phase 2: content ----------
  const RICH_MD = [
    "# Q3 plan",
    "#### Small heading",
    '## Details {toggle="true"}',
    "\tHidden until opened",
    'Plain, **bold Q3**, <span color="red">red</span>, <span color="blue_bg">highlight</span>, $x^2$, ' +
      `<mention-page url="${pageId}"/>, <mention-date start="2026-10-01"/>, [link](https://example.com)`,
    "> [!NOTE] Heads up",
    "> Second line of the note",
    '<callout icon="🔥" color="red_bg">',
    "\tHot take",
    "\t- nested bullet",
    "</callout>",
    "<details>",
    "<summary>More</summary>",
    "\t- level 1",
    "\t\t- level 2",
    "\t\t\t- level 3",
    "\t\t\t\t- level 4",
    "\t\t\t\t\t- level 5",
    "</details>",
    "<columns>",
    "\t<column>",
    "\t\tLeft column",
    "\t\t- with a list",
    "\t\t\t- nested deeper",
    "\t</column>",
    "\t<column>",
    "\t\tRight column",
    "\t</column>",
    "</columns>",
    "| Quarter | Revenue |",
    "|---|---|",
    "| Q3 | 100 |",
    "| Q4 | 120 |",
    "<tabs>",
    "\t<tab>",
    "\t\tOverview",
    "\t\tOverview content",
    "\t</tab>",
    "\t<tab>",
    "\t\tDetails",
    "\t\tDetails content",
    "\t</tab>",
    "</tabs>",
    "```mermaid",
    "graph TD; A-->B",
    "```",
    "$$",
    "E=mc^2",
    "$$",
    "<table_of_contents/>",
    "<breadcrumb/>",
    '<bookmark url="https://example.com"/>',
    '<embed src="https://www.youtube.com/watch?v=dQw4w9WgXcQ"></embed>',
    "![](https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png)",
    `<link-to-page url="${pageId}"/>`,
    "<synced_block>",
    "\tSynced original",
    "</synced_block>",
    "- [x] done item",
    "---",
  ].join("\n");
  let richPage = "";
  await step("notion_create_page: every block type from markdown", async () => {
    const r = await must("notion_create_page", { parent: pageId, title: `${stamp} Q3 content`, markdown: RICH_MD, icon: "📊" });
    richPage = r.page_id;
    createdPages.push(richPage);
    const outline = (await tool("notion_get_blocks", { block: richPage, max_depth: 6, max_blocks: 500 })).text;
    const types = ["heading_1", "heading_4", "heading_2", "callout", "toggle", "column_list", "table", "tab", "code", "equation", "table_of_contents",
      "breadcrumb", "bookmark", "embed", "image", "link_to_page", "synced_block", "to_do", "divider"];
    const missing = types.filter((t) => !outline.includes(`(${t})`));
    expect(missing.length === 0, `missing block types: ${missing.join(", ")}`);
    expect(outline.includes("level 5"), "5-level nesting lost");
    expect(outline.includes("nested deeper"), "nested content inside a column lost");
    return `${outline.split("\n").length} blocks`;
  });
  await step("notion_get_page format=markdown: formatting survives a round trip", async () => {
    const md1 = (await tool("notion_get_page", { page: richPage, format: "markdown" })).text.split("MARKDOWN:\n")[1] ?? "";
    for (const needle of ['color="red"', "<callout", "<columns>", "<details>", "<tabs>", "```mermaid", "<breadcrumb/>", "<bookmark url=", "<link-to-page", "mention-page", "level 5"]) {
      expect(md1.includes(needle), `markdown read lacks ${needle}`);
    }
    const r = await must("notion_create_page", { parent: pageId, title: `${stamp} round trip`, markdown: md1 });
    createdPages.push(r.page_id);
    const md2 = (await tool("notion_get_page", { page: r.page_id, format: "markdown" })).text.split("MARKDOWN:\n")[1] ?? "";
    // The synced original becomes a reference to it in the copy; everything else should match line for line.
    const norm = (s: string) => s.split("\n").filter((l) => !/synced_block/.test(l)).join("\n");
    const a = norm(md1).split("\n");
    const b = norm(md2).split("\n");
    const diff = a.map((l, i) => (l === b[i] ? null : `${i}: ${l} ≠ ${b[i]}`)).filter(Boolean);
    expect(diff.length === 0 && a.length === b.length, `${diff.length} lines differ (${a.length} vs ${b.length}): ${diff.slice(0, 3).join(" | ")}`);
    return `${a.length} lines identical`;
  });
  await step("notion_insert_blocks: local image is uploaded", async () => {
    const png = path.join(os.tmpdir(), `${stamp}.png`);
    writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const r = await must("notion_insert_blocks", { parent: richPage, blocks: [{ type: "image", url: png, caption: "uploaded" }] });
    const b = (await call(() => n.blocks.retrieve({ block_id: r.block_ids[0] }))) as unknown as Json;
    expect(b.image.type === "file", `image type ${b.image.type}`);
    const outside = await tool("notion_insert_blocks", { parent: richPage, blocks: [{ type: "image", url: "/etc/hostname" }] });
    expect(outside.isError && /outside the folders/.test(outside.text), outside.text);
  });
  await step("notion_patch_block: toggle heading, callout icon, table cells; undo", async () => {
    const heading = await blockAt(richPage, "Small heading");
    const r1 = await must("notion_patch_block", { block_id: heading, toggleable: true, color: "green_bg" });
    const h = (await call(() => n.blocks.retrieve({ block_id: heading }))) as unknown as Json;
    expect(h.heading_4.is_toggleable === true && h.heading_4.color === "green_background", JSON.stringify(h.heading_4));
    const callout = await blockAt(richPage, "Hot take");
    const r2 = await must("notion_patch_block", { block_id: callout, icon: "✅" });
    const row = await blockAt(richPage, "Q4 | 120");
    const r3 = await must("notion_patch_block", { block_id: row, cells: ["Q4", "**130**"] });
    expect(r3.after === "Q4 | 130", r3.after);
    for (const r of [r3, r2, r1]) await must("notion_undo", { undo_id: r.undo_id });
    const c = (await call(() => n.blocks.retrieve({ block_id: callout }))) as unknown as Json;
    expect(c.callout.icon.emoji === "🔥", "callout icon not restored");
    expect((await blockText(row)) === "Q4 | 120", "table row not restored");
  });
  await step("notion_replace_text: Q3→Q4 in title, text, and table cells keeps formatting; undo", async () => {
    const dry = await must("notion_replace_text", { page: richPage, find: "Q3", replace: "Q4" });
    expect(dry.dry_run && dry.total_replacements >= 4, JSON.stringify(dry).slice(0, 300));
    expect(dry.changes.some((c: Json) => c.page_title), "title not in preview");
    expect(dry.changes.some((c: Json) => c.type === "table_row"), "table cell not in preview");
    const r = await must("notion_replace_text", { page: richPage, find: "Q3", replace: "Q4", dry_run: false });
    expect(r.total_replacements === dry.total_replacements, `${r.total_replacements} vs ${dry.total_replacements}`);
    const para = await blockAt(richPage, "bold Q4");
    const b = (await call(() => n.blocks.retrieve({ block_id: para }))) as unknown as Json;
    expect(b.paragraph.rich_text.some((s: Json) => s.plain_text.includes("Q4") && s.annotations.bold), "bold lost");
    expect(b.paragraph.rich_text.some((s: Json) => s.type === "mention"), "mention lost");
    await must("notion_undo", { undo_id: r.undo_id });
    const again = await must("notion_replace_text", { page: richPage, find: "Q3", replace: "Q4" });
    expect(again.total_replacements === dry.total_replacements, "undo did not restore every Q3");
  });
  let target = "";
  await step("notion_copy_blocks: copy callout and columns to another page; undo", async () => {
    target = (await must("notion_create_page", { parent: pageId, title: `${stamp} target`, markdown: "Existing first\n\nExisting last" })).page_id;
    createdPages.push(target);
    const callout = await blockAt(richPage, "Hot take");
    const cols = (await tool("notion_get_blocks", { block: richPage, max_depth: 0 })).text.match(/\(column_list\).*⟨([^⟩]+)⟩/)?.[1];
    expect(cols, "no column_list found");
    const first = await blockAt(target, "Existing first");
    const r = await must("notion_copy_blocks", { block_ids: [callout, cols], to: target, position: "after_block", after_block_id: first });
    expect(r.created_block_ids.length === 2, JSON.stringify(r));
    const outline = (await tool("notion_get_blocks", { block: target, max_depth: 4 })).text;
    const order = ["Existing first", "Hot take", "Left column", "nested deeper", "Existing last"].map((t) => outline.indexOf(t));
    expect(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])), `order wrong: ${order}`);
    await must("notion_undo", { undo_id: r.undo_id });
    expect(!(await tool("notion_get_blocks", { block: target, max_depth: 0 })).text.includes("Hot take"), "copy not undone");
  });
  await step("notion_copy_blocks: move defaults to a dry run; move then undo restores the original", async () => {
    const toggle = await blockAt(richPage, "More");
    const dry = await must("notion_copy_blocks", { block_ids: [toggle], to: target, move: true });
    expect(dry.dry_run === true && dry.total_blocks >= 6, JSON.stringify(dry));
    const r = await must("notion_copy_blocks", { block_ids: [toggle], to: target, move: true, dry_run: false });
    expect((await tool("notion_find_blocks", { page: richPage, query: "^More$", regex: true })).json.count === 0, "original still there");
    expect((await tool("notion_find_blocks", { page: target, query: "level 5", max_depth: 6 })).json.count === 1, "moved content missing");
    await must("notion_undo", { undo_id: r.undo_id });
    expect((await tool("notion_find_blocks", { page: richPage, query: "level 5", max_depth: 6 })).json.count === 1, "original not restored");
    expect((await tool("notion_find_blocks", { page: target, query: "level 5", max_depth: 6 })).json.count === 0, "moved copy not removed");
  });
  await step("notion_copy_blocks: moving an original synced block is refused", async () => {
    const synced = (await tool("notion_get_blocks", { block: richPage, max_depth: 0 })).text.match(/\(synced_block\).*⟨([^⟩]+)⟩/)?.[1];
    const r = await tool("notion_copy_blocks", { block_ids: [synced], to: target, move: true, dry_run: false });
    expect(r.isError && /synced/.test(r.text), r.text);
  });
  await step("notion_duplicate_page: content, icon, and sub-pages; undo", async () => {
    await must("notion_create_page", { parent: richPage, title: "Child page", markdown: "child content" });
    const dry = await must("notion_duplicate_page", { page: richPage, dry_run: true });
    expect(dry.subpages.includes("Child page"), JSON.stringify(dry));
    const r = await must("notion_duplicate_page", { page: richPage, to: pageId });
    createdPages.push(r.page_id);
    expect(r.subpages === 1, JSON.stringify(r));
    const copy = await tool("notion_get_page", { page: r.page_id, max_depth: 6, max_blocks: 500 });
    expect(copy.text.includes("(copy)") && copy.text.includes('"icon": "📊"'), copy.text.slice(0, 300));
    expect(copy.text.includes("level 5") && copy.text.includes("(child_page) Child page"), "content or sub-page missing");
    await must("notion_undo", { undo_id: r.undo_id });
    const p = (await call(() => n.pages.retrieve({ page_id: r.page_id }))) as unknown as Json;
    expect(p.in_trash === true, "duplicate not trashed");
  });
  await step("notion_update_page: title, icon, cover, lock, move; undo", async () => {
    const r = await must("notion_update_page", {
      page: target, title: `${stamp} renamed`, icon: "🎯", cover: "https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png",
      locked: true, move_to: richPage,
    });
    const p = (await call(() => n.pages.retrieve({ page_id: target }))) as unknown as Json;
    expect(p.icon.emoji === "🎯" && p.cover && p.is_locked === true && p.parent.page_id === richPage, JSON.stringify({ icon: p.icon, parent: p.parent }));
    await must("notion_undo", { undo_id: r.undo_id });
    const q = (await call(() => n.pages.retrieve({ page_id: target }))) as unknown as Json;
    expect(q.parent.page_id === pageId && q.icon === null && q.cover === null && !q.is_locked, JSON.stringify({ icon: q.icon, parent: q.parent, locked: q.is_locked }));
  });
  await step("notion_comments: add, list, reply; undo deletes", async () => {
    const a = await must("notion_comments", { action: "add", target: richPage, text: "**Review** this" });
    const b = await must("notion_comments", { action: "reply", discussion_id: a.discussion_id, text: "Done" });
    const list = await must("notion_comments", { action: "list", target: richPage });
    expect(list.count >= 2 && list.comments.some((c: Json) => c.text === "Review this"), JSON.stringify(list).slice(0, 300));
    await must("notion_undo", { undo_id: b.undo_id });
    await must("notion_undo", { undo_id: a.undo_id });
    const after = await must("notion_comments", { action: "list", target: richPage });
    expect(after.count === list.count - 2, `${after.count} comments left`);
  });
  await step("notion_list_templates: a database without templates says so", async () => {
    const r = await tool("notion_list_templates", { database: main.db });
    expect(!r.isError && /no templates|templates/.test(r.text), r.text);
  });

  // ---------- page trash + undo ----------
  await step("notion_trash_page: trash then undo", async () => {
    const r = await must("notion_trash_page", { page: rowC });
    await must("notion_undo", { undo_id: r.undo_id });
    const p = (await call(() => n.pages.retrieve({ page_id: rowC }))) as unknown as Json;
    expect(p.in_trash === false, "page still in trash");
  });
  await step("notion_create_page: undo trashes the created page", async () => {
    const r = await must("notion_create_page", { parent: pageId, title: `${stamp} sub-page`, markdown: "hello" });
    await must("notion_undo", { undo_id: r.undo_id });
    const p = (await call(() => n.pages.retrieve({ page_id: r.page_id }))) as unknown as Json;
    expect(p.in_trash === true, "sub-page not trashed");
  });
  await step("notion_history", async () => {
    const r = await tool("notion_history", { limit: 50 });
    expect(!r.isError && Array.isArray(r.json) && r.json.length > 0, r.text.slice(0, 200));
    return `${r.json.length} entries`;
  });
}

let crashed = false;
try {
  await main();
} catch (e) {
  crashed = true;
  console.log(`\nStopped early: ${(e as Error).message}`);
} finally {
  if (process.env.SMOKE_KEEP) {
    console.log(`\nSMOKE_KEEP set; leaving databases: ${createdDatabases.join(", ")}`);
  } else {
    for (const id of createdPages.reverse()) {
      try {
        await call(() => notion().pages.update({ page_id: id, in_trash: true } as never));
      } catch {
        // Already trashed (for example by an undo step).
      }
    }
    for (const id of createdDatabases.reverse()) {
      try {
        await call(() => notion().databases.update({ database_id: id, in_trash: true } as never));
      } catch (e) {
        console.log(`Cleanup failed for database ${id}: ${(e as Error).message}. Trash it by hand.`);
      }
    }
    if (createdDatabases.length) console.log(`\nCleaned up ${createdDatabases.length} test databases.`);
  }
}

const allTools = [...tools.keys()];
const untested = allTools.filter((t) => ![...touched].some((s) => s.startsWith(t)) && !["notion_undo"].includes(t));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed. Journal: ${process.env.NOTION_PLUS_HOME}`);
if (untested.length) console.log(`Tools without a dedicated step: ${untested.join(", ")}`);
process.exit(failed.length || crashed ? 1 : 0);
