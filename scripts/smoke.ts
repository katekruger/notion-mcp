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
const { registerDatabaseTools } = await import("../src/tools/database.js");
const { registerVisualTools } = await import("../src/tools/visuals.js");
const { runAll } = await import("../src/services/automations.js");
const { journalWrites } = await import("../src/tools/util.js");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Handler = (args: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>;

const tools = new Map<string, { schema: z.ZodTypeAny; handler: Handler }>();
const registry = {
  registerTool(name: string, config: { inputSchema: z.ZodRawShape }, handler: Handler) {
    tools.set(name, { schema: z.object(config.inputSchema), handler });
  },
};
for (const register of [registerReadTools, registerPageTools, registerBlockTools, registerContentTools, registerSchemaTools, registerDatabaseTools, registerVisualTools, registerSafetyTools, registerAutomationTools]) {
  register(journalWrites(registry as never) as never);
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
  await step("notion_schema add: add then undo", async () => {
    const r = await must("notion_schema", { database: main.db, action: "add", definition: { name: "Extra", type: "number" } });
    await must("notion_undo", { undo_id: r.undo_id });
    const s = await must("notion_get_schema", { database: main.db });
    expect(!s.properties.some((p: Json) => p.name === "Extra"), "Extra still present");
  });
  await step("notion_schema add_options: add keeps rows; undo removes only the added option", async () => {
    const r = await must("notion_schema", { database: main.db, action: "add_options", property: "Priority", options: ["Medium"] });
    expect((await prop(rowA, "Priority")) === "High", "row A lost its option after adding one");
    await must("notion_update_properties", { page: rowB, properties: { Priority: "Medium" } });
    await must("notion_undo", { undo_id: r.undo_id });
    const s = await must("notion_get_schema", { database: main.db });
    const opts = s.properties.find((p: Json) => p.name === "Priority").options;
    expect(JSON.stringify(opts) === JSON.stringify(["Low", "High"]), `options after undo: ${opts}`);
    expect((await prop(rowA, "Priority")) === "High", "row A lost High after undo");
    return `row B (was Medium) now: ${JSON.stringify(await prop(rowB, "Priority"))}`;
  });
  await step("notion_schema add_options: an existing option (any case) changes nothing", async () => {
    const r = await must("notion_schema", { database: main.db, action: "add_options", property: "Priority", options: ["high"] });
    expect(r.added.length === 0 && !r.undo_id, JSON.stringify(r));
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
  await step("notion_schema rename: rename then undo", async () => {
    const r = await must("notion_schema", { database: main.db, action: "rename", property: "points", to: "Score" });
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
    await step("notion_automation add: rules checked against the schema, with preview", async () => {
      trashRow = (await must("notion_create_page", { parent: main.db, title: "Trash me" })).page_id;
      await must("notion_update_properties", { page: rowB, properties: { Status: "Done", Due: null } });
      for (const rule of rules) {
        const r = await must("notion_automation", { action: "add", rule });
        expect(r.saved === rule.id, JSON.stringify(r));
      }
      const listed = await must("notion_automation", { action: "list" });
      expect(listed.rules.length === 3, `listed ${listed.rules.length} rules`);
    });
    await step("notion_automation add: a rule that would repeat forever is refused", async () => {
      const r = await tool("notion_automation", { action: "add", rule: { id: "loop", database: main.db, when: { where: { Status: "Done" } }, actions: [{ comment: "again" }] } });
      expect(r.isError && /every run/.test(r.text), r.text);
    });
    await step("notion_automation add: relative date conditions query cleanly", async () => {
      const r = await must("notion_automation", {
        action: "add",
        rule: { id: "recent", enabled: false, database: main.db, when: { relative: [{ property: "$created", newer_than_days: 1 }] }, actions: [{ comment: "x" }], marker: "Automated" },
      });
      expect(/would act on [1-9]/.test(r.preview), r.preview);
    });
    await step("notion_automation dry_run: previews and writes nothing", async () => {
      const r = await tool("notion_automation", { action: "dry_run" });
      expect(!r.isError && /stamp-done.*would act on 1/.test(r.text) && /flag-high.*would act on 1/.test(r.text) && /trash-marked.*would act on 1/.test(r.text), r.text);
      expect((await prop(rowB, "Due")) === null, "dry run wrote Due");
    });
    let undoIds: string[] = [];
    await step("automations run: set, append, comment, marker, trash", async () => {
      const { results } = await runAll({ dryRun: false });
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
      const { results } = await runAll({ dryRun: false });
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
  await step("notion_duplicate_page: a database on the page is copied in place with rows and internal relations", async () => {
    const holder = (await call(() => n.pages.create({ parent: { page_id: pageId }, properties: { title: { title: [{ text: { content: `${stamp} db holder` } }] } } } as never))).id;
    createdPages.push(holder);
    await call(() => n.blocks.children.append({ block_id: holder, children: [{ paragraph: { rich_text: [{ text: { content: "above" } }] } }] } as never));
    const db = (await call(() => n.databases.create({
      parent: { type: "page_id", page_id: holder }, is_inline: true, title: [{ text: { content: "Inner" } }],
      initial_data_source: { properties: { Task: { title: {} }, Pts: { number: { format: "dollar" } } } },
    } as never))) as unknown as Json;
    const ds = db.data_sources[0].id;
    await call(() => n.dataSources.update({ data_source_id: ds, properties: { Parent: { relation: { data_source_id: ds, type: "dual_property", dual_property: { synced_property_name: "Children" } } } } } as never));
    const a = await call(() => n.pages.create({ parent: { data_source_id: ds }, properties: { Task: { title: [{ text: { content: "A" } }] }, Pts: { number: 3 } } } as never));
    await call(() => n.pages.create({ parent: { data_source_id: ds }, properties: { Task: { title: [{ text: { content: "B" } }] }, Parent: { relation: [{ id: a.id }] } } } as never));
    // Row A has its own sub-page, which must be copied under the copied row (not silently dropped).
    await call(() => n.pages.create({ parent: { page_id: a.id }, properties: { title: { title: [{ text: { content: "A notes" } }] } } } as never));
    await call(() => n.blocks.children.append({ block_id: holder, children: [{ paragraph: { rich_text: [{ text: { content: "below" } }] } }] } as never));
    const dry = await must("notion_duplicate_page", { page: holder, dry_run: true });
    expect(dry.databases?.[0]?.data_sources?.[0]?.rows === 2, JSON.stringify(dry));
    const r = await must("notion_duplicate_page", { page: holder });
    createdPages.push(r.page_id);
    expect(r.databases.length === 1 && r.databases[0].rows === 2, JSON.stringify(r));
    const kids = (await call(() => n.blocks.children.list({ block_id: r.page_id }))) as unknown as Json;
    expect(kids.results.map((b: Json) => b.type).join(",") === "paragraph,child_database,paragraph", "database not in place");
    const copyDb = (await call(() => n.databases.retrieve({ database_id: r.databases[0].database_id }))) as unknown as Json;
    const copyDs = copyDb.data_sources[0].id;
    const rows = (await call(() => n.dataSources.query({ data_source_id: copyDs } as never))) as unknown as Json;
    const b = rows.results.find((x: Json) => x.properties.Task.title[0]?.plain_text === "B");
    const copiedA = rows.results.find((x: Json) => x.properties.Task.title[0]?.plain_text === "A");
    expect(b?.properties.Parent.relation[0]?.id === copiedA?.id, "relation not re-pointed at the copied row");
    const aKids = (await call(() => n.blocks.children.list({ block_id: copiedA.id }))) as unknown as Json;
    expect(aKids.results.some((k: Json) => k.type === "child_page" && k.child_page.title === "A notes"), "row sub-page not copied");
    await must("notion_undo", { undo_id: r.undo_id });
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
    expect(list.count >= 2 && list.comments.some((c: Json) => c.text === "**Review** this"), JSON.stringify(list).slice(0, 300));
    await must("notion_undo", { undo_id: b.undo_id });
    await must("notion_undo", { undo_id: a.undo_id });
    const after = await must("notion_comments", { action: "list", target: richPage });
    expect(after.count === list.count - 2, `${after.count} comments left`);
  });
  await step("notion_list_templates: a database without templates says so", async () => {
    const r = await tool("notion_list_templates", { database: main.db });
    expect(!r.isError && /no templates|templates/.test(r.text), r.text);
  });

  // ---------- phase 3: databases ----------
  let clients = { db: "", ds: "" };
  let tracker = { db: "", ds: "" };
  await step("notion_create_database: Clients, then a tracker with every property kind", async () => {
    const c = await must("notion_create_database", {
      parent: pageId, title: `${stamp} Clients`, icon: "🏢",
      properties: [{ name: "Client", type: "title" }, { name: "Tier", type: "select", options: ["Gold", "Silver"] }],
    });
    clients = { db: c.database_id, ds: c.data_source_id };
    createdDatabases.push(c.database_id);
    const r = await must("notion_create_database", {
      parent: pageId, title: `${stamp} Tracker`,
      properties: [
        { name: "Task", type: "title" },
        { name: "Status", type: "status", options: ["Backlog", "In Progress", "At Risk", "Done"] },
        { name: "Owner", type: "people" },
        { name: "Due", type: "date" },
        { name: "Completed Date", type: "date" },
        { name: "Priority", type: "select", options: [{ name: "High", color: "red" }, { name: "Medium", color: "yellow" }, { name: "Low", color: "gray" }] },
        { name: "Client", type: "relation", relation: { database: clients.db, two_way: true, related_name: "Projects" } },
        { name: "Client tier", type: "rollup", rollup: { relation: "Client", property: "Tier", function: "show_original" } },
        { name: "Estimate", type: "number", number_format: "dollar", description: "Budget" },
        { name: "Double", type: "formula", formula: 'prop("Estimate") * 2' },
        { name: "Parent", type: "relation", relation: { database: "self" } },
        { name: "ID", type: "unique_id", prefix: "PRJ" },
        { name: "Files", type: "files" },
        { name: "Where", type: "place" },
      ],
    });
    tracker = { db: r.database_id, ds: r.data_source_id };
    createdDatabases.push(r.database_id);
    const names = r.properties.map((p: Json) => p.name);
    for (const want of ["Status", "Client", "Client tier", "Parent", "ID", "Where", "Double"]) expect(names.includes(want), `missing ${want}: ${names}`);
    const status = r.properties.find((p: Json) => p.name === "Status");
    const complete = status.groups.find((g: Json) => g.name === "Complete").options;
    expect(complete.includes("Done"), `Done not in Complete: ${JSON.stringify(status.groups)}`);
    const cs = await must("notion_get_schema", { database: clients.db });
    expect(cs.properties.some((p: Json) => p.name === "Projects"), `two-way relation missing on Clients: ${JSON.stringify(cs.properties.map((p: Json) => [p.name, p.type]))}`);
    return r.notes?.join(" ") ?? "";
  });
  await step("notion_bulk_create: invalid rows are all reported, nothing written", async () => {
    const r = await must("notion_bulk_create", {
      database: tracker.db, dry_run: false,
      rows: [{ Task: "ok", Status: "Done" }, { Task: "bad", Status: "Nope" }, { Task: "bad2", Estimate: "lots", Client: "No Such Client" }],
    });
    expect(r.invalid === 2 && r.errors.length === 2 && !r.created, JSON.stringify(r));
    expect(r.errors.some((e: Json) => e.error.includes('no row titled "No Such Client"')), JSON.stringify(r.errors));
    const q = await must("notion_query", { database: tracker.db });
    expect(q.count === 0, `${q.count} rows written`);
  });
  let bulkUndo = "";
  await step("notion_bulk_create: 3 clients from CSV, 15 tasks from JSON with relations by title", async () => {
    const c = await must("notion_bulk_create", { database: clients.db, csv: 'Client,Tier\nAcme,Gold\n"Globex, Inc",Silver\nInitech,\n', dry_run: false });
    expect(c.created === 3, JSON.stringify(c));
    const owners = person ? [person.id] : [];
    const statuses = ["Backlog", "In Progress", "At Risk", "Done", "Done"];
    const rows = Array.from({ length: 15 }, (_, i) => ({
      Task: `Task ${i + 1}`,
      Status: statuses[i % 5],
      Priority: ["High", "Medium", "Low"][i % 3],
      Due: `2026-${String(9 + (i % 3)).padStart(2, "0")}-${String(10 + i).padStart(2, "0")}`,
      Estimate: (i + 1) * 100,
      Client: ["Acme", "Globex, Inc", "Initech"][i % 3],
      ...(owners.length ? { Owner: owners } : {}),
    }));
    const dry = await must("notion_bulk_create", { database: tracker.db, rows });
    expect(dry.dry_run && dry.rows === 15, JSON.stringify(dry));
    const r = await must("notion_bulk_create", { database: tracker.db, rows, dry_run: false });
    expect(r.created === 15, JSON.stringify(r));
    bulkUndo = r.undo_id;
    const q = await must("notion_query", { database: tracker.db, where: { Client: "Acme" }, properties: ["Task", "Client tier", "ID"] });
    expect(q.count === 5, `Acme has ${q.count} tasks`);
    expect(JSON.stringify(q.rows[0]["Client tier"]).includes("Gold"), `rollup read: ${JSON.stringify(q.rows[0])}`);
    expect(/^PRJ-\d+$/.test(q.rows[0].ID), `unique id: ${q.rows[0].ID}`);
  });
  await step("notion_query: operators, in, or, relative dates", async () => {
    const a = await must("notion_query", { database: tracker.db, where: { Estimate: { ">": 500, "<=": 1000 } } });
    expect(a.count === 5, `estimate range: ${a.count}`);
    const b = await must("notion_query", { database: tracker.db, where: { Status: { in: ["Done", "At Risk"] } } });
    expect(b.count === 9, `status in: ${b.count}`);
    const c = await must("notion_query", { database: tracker.db, where: { or: [{ Priority: "High" }, { Task: { contains: "15" } }] } });
    expect(c.count === 6, `or: ${c.count}`);
    const d = await must("notion_query", { database: tracker.db, where: { Due: { before: "2026-10-01" }, Status: { "!=": "Done" } } });
    expect(d.count >= 1, `before: ${d.count}`);
    const e = await must("notion_query", { database: tracker.db, where: { "$created": { after: "-1d" } } });
    expect(e.count === 15, `created recently: ${e.count}`);
  });
  await step("notion_aggregate: counts by status, sums by client, month buckets", async () => {
    const a = await must("notion_aggregate", { database: tracker.db, group_by: "Status" });
    expect(a.totals.count === 15, JSON.stringify(a.totals));
    const done = a.groups.find((g: Json) => g.key === "Done");
    expect(done?.count === 6, JSON.stringify(a.groups));
    const b = await must("notion_aggregate", { database: tracker.db, group_by: "Client", metrics: ["count", "sum:Estimate", "avg:Estimate"] });
    const acme = b.groups.find((g: Json) => g.key === "Acme");
    expect(acme?.count === 5 && acme.sum_Estimate === 100 + 400 + 700 + 1000 + 1300, JSON.stringify(b.groups));
    const c = await must("notion_aggregate", { database: tracker.db, group_by: { property: "Due", by: "month" }, where: { Status: { "!=": "Done" } } });
    expect(c.groups.length === 3 && c.totals.count === 9, JSON.stringify(c));
    return `status: ${a.groups.map((g: Json) => `${g.key}=${g.count}`).join(", ")}`;
  });
  await step("notion_bulk_update: per-row values, dry run, apply, undo", async () => {
    const q = await must("notion_query", { database: tracker.db, where: { Priority: "High" }, properties: ["Task"] });
    const rows = q.rows.map((r: Json, i: number) => ({ page: r.id, set: { Estimate: 9000 + i, Where: { lat: 40.7, lon: -74, name: "NYC" } } }));
    const dry = await must("notion_bulk_update", { rows });
    expect(dry.dry_run && dry.matched === rows.length && dry.rows[0].will_set, JSON.stringify(dry).slice(0, 300));
    const r = await must("notion_bulk_update", { rows, dry_run: false });
    expect(r.updated === rows.length, JSON.stringify(r));
    const check = await must("notion_query", { database: tracker.db, where: { Estimate: { ">=": 9000 } } });
    expect(check.count === rows.length, `${check.count} updated`);
    await must("notion_undo", { undo_id: r.undo_id });
    const after = await must("notion_query", { database: tracker.db, where: { Estimate: { ">=": 9000 } } });
    expect(after.count === 0, `${after.count} not reverted`);
  });
  await step("files and place properties: write, read, undo", async () => {
    const q = await must("notion_query", { database: tracker.db, where: { Task: "Task 1" } });
    const id = q.rows[0].id;
    const txt = path.join(os.tmpdir(), `${stamp}.txt`);
    writeFileSync(txt, "hello");
    const r = await must("notion_update_properties", { page: id, properties: { Files: [txt, { name: "spec", url: "https://example.com/spec.pdf" }], Where: { lat: 51.5, lon: -0.12, name: "London" } } });
    const files = await prop(id, "Files");
    expect(JSON.stringify(files) === JSON.stringify([`${stamp}.txt`, "spec"]), JSON.stringify(files));
    expect((await prop(id, "Where") as Json)?.name === "London", "place missing");
    await must("notion_undo", { undo_id: r.undo_id });
    expect(JSON.stringify(await prop(id, "Files")) === "[]" && (await prop(id, "Where")) === null, "files/place not reverted");
  });
  await step("notion_schema: status option with group, number format, description", async () => {
    const a = await must("notion_schema", { database: tracker.db, action: "add_options", property: "Status", options: [{ name: "Blocked", group: "In progress" }, "Shipped"] });
    const s = await must("notion_get_schema", { database: tracker.db });
    const groups = s.properties.find((p: Json) => p.name === "Status").groups;
    expect(groups.find((g: Json) => g.name === "In progress").options.includes("Blocked"), JSON.stringify(groups));
    expect(groups.find((g: Json) => g.name === "Complete").options.includes("Shipped"), JSON.stringify(groups));
    const b = await must("notion_schema", { database: tracker.db, action: "set_number_format", property: "Estimate", number_format: "euro" });
    const c = await must("notion_schema", { database: tracker.db, action: "set_description", property: "Priority", description: "How urgent" });
    for (const u of [c, b, a]) await must("notion_undo", { undo_id: u.undo_id });
    const s2 = await must("notion_get_schema", { database: tracker.db });
    const st = s2.properties.find((p: Json) => p.name === "Status").options;
    expect(!st.includes("Blocked") && st.includes("Done"), `status after undo: ${st}`);
    expect(s2.properties.find((p: Json) => p.name === "Estimate").format === "dollar", "format not restored");
    const pr = await must("notion_get_schema", { database: tracker.db });
    expect(pr.properties.find((p: Json) => p.name === "Priority").options.length === 3, "priority options changed by description edit");
  });
  await step("notion_schema delete: dry run counts values; undo re-creates the property and its values", async () => {
    const dry = await must("notion_schema", { database: tracker.db, action: "delete", property: "Priority" });
    expect(dry.dry_run && dry.rows_with_values === "15", JSON.stringify(dry));
    const r = await must("notion_schema", { database: tracker.db, action: "delete", property: "Priority", dry_run: false });
    expect(r.values_saved_for_undo === 15, JSON.stringify(r));
    const s = await must("notion_get_schema", { database: tracker.db });
    expect(!s.properties.some((p: Json) => p.name === "Priority"), "not deleted");
    await must("notion_undo", { undo_id: r.undo_id });
    const agg = await must("notion_aggregate", { database: tracker.db, group_by: "Priority" });
    expect(JSON.stringify(agg.groups.map((g: Json) => [g.key, g.count]).sort()) === JSON.stringify([["High", 5], ["Low", 5], ["Medium", 5]]), JSON.stringify(agg.groups));
  });
  if (process.env.SMOKE_LARGE) {
    await step("large: 300 rows created, bulk-updated with dry run, and undone as one batch", async () => {
      const rows = Array.from({ length: 300 }, (_, i) => ({ Task: `Bulk ${i + 1}`, Status: "Backlog", Estimate: i }));
      const created = await must("notion_bulk_create", { database: tracker.db, rows, dry_run: false });
      expect(created.created === 300, JSON.stringify(created));
      const dry = await must("notion_bulk_update", { database: tracker.db, where: { Task: { starts_with: "Bulk " } }, set: { Status: "In Progress" }, limit: 500 });
      expect(dry.matched === 300, `dry run matched ${dry.matched}`);
      const t0 = Date.now();
      const r = await must("notion_bulk_update", { database: tracker.db, where: { Task: { starts_with: "Bulk " } }, set: { Status: "In Progress" }, limit: 500, dry_run: false });
      expect(r.updated === 300, JSON.stringify(r));
      const t1 = Date.now();
      await must("notion_undo", { undo_id: r.undo_id });
      const t2 = Date.now();
      const agg = await must("notion_aggregate", { database: tracker.db, where: { Task: { starts_with: "Bulk " } }, group_by: "Status" });
      expect(agg.groups.length === 1 && agg.groups[0].key === "Backlog" && agg.groups[0].count === 300, JSON.stringify(agg.groups));
      await must("notion_undo", { undo_id: created.undo_id });
      return `update ${Math.round((t1 - t0) / 1000)}s, undo ${Math.round((t2 - t1) / 1000)}s`;
    });
  }
  // ---------- phase 4: views and visuals ----------
  let reportHost = "";
  await step("notion_views: board, timeline, calendar, and chart tabs; list and get", async () => {
    const made: string[] = [];
    for (const view of [
      { name: "By status", type: "board", group_by: "Status", properties: ["Priority", "Due"] },
      { name: "Timeline", type: "timeline", date: "Due", zoom: "week" },
      { name: "Calendar", type: "calendar", date: "Due" },
      { name: "Open by client", type: "chart", where: { Status: { "!=": "Done" } }, chart: { type: "column", x: "Client", y: "count", stack_by: "Priority", labels: true } },
      { name: "Budget", type: "chart", chart: { type: "number", y: "sum:Estimate" } },
    ]) {
      const r = await must("notion_views", { action: "create", database: tracker.db, view });
      made.push(r.undo_id);
    }
    const list = await must("notion_views", { action: "list", database: tracker.db });
    for (const want of ["By status", "Timeline", "Calendar", "Open by client", "Budget"]) expect(list.views.some((v: Json) => v.name === want), `missing view ${want}`);
    const board = list.views.find((v: Json) => v.name === "By status");
    const got = await must("notion_views", { action: "get", view_id: board.id });
    expect(got.configuration.group_by.property === "Status", JSON.stringify(got.configuration));
    for (const u of made.reverse()) await must("notion_undo", { undo_id: u });
    const after = await must("notion_views", { action: "list", database: tracker.db });
    expect(after.views.length === list.views.length - 5, `${after.views.length} views after undo`);
    return `${list.views.length} views, then ${after.views.length}`;
  });
  await step("notion_views: update and delete revert with undo", async () => {
    const r = await must("notion_views", { action: "create", database: tracker.db, view: { name: "Work", type: "table", sorts: [{ property: "Due" }] } });
    const upd = await must("notion_views", { action: "update", view_id: r.view_id, view: { name: "Work (high)", type: "table", where: { Priority: "High" } } });
    let v = await must("notion_views", { action: "get", view_id: r.view_id });
    expect(v.name === "Work (high)" && JSON.stringify(v.filter).includes("Priority"), JSON.stringify(v));
    await must("notion_undo", { undo_id: upd.undo_id });
    v = await must("notion_views", { action: "get", view_id: r.view_id });
    expect(v.name === "Work" && !v.filter, `after undo: ${JSON.stringify(v).slice(0, 200)}`);
    const del = await must("notion_views", { action: "delete", view_id: r.view_id });
    await must("notion_undo", { undo_id: del.undo_id });
    const list = await must("notion_views", { action: "list", database: tracker.db });
    const back = list.views.filter((x: Json) => x.name === "Work");
    expect(back.length === 1, "deleted view not re-created");
    await must("notion_views", { action: "delete", view_id: back[0].id });
  });
  await step("notion_views: linked chart on a page at an exact spot, and a dashboard widget", async () => {
    reportHost = (await must("notion_create_page", { parent: pageId, title: `${stamp} visuals`, markdown: "First\n\nLast" })).page_id;
    createdPages.push(reportHost);
    const first = await blockAt(reportHost, "First");
    const r = await must("notion_views", { action: "create", database: tracker.db, view: { name: "Per client", type: "chart", chart: { type: "donut", x: "Client" } }, on: { page: reportHost, after_block: first } });
    const outline = (await tool("notion_get_blocks", { block: reportHost, max_depth: 0 })).text.split("\n");
    expect(outline.length === 3 && outline[1].includes("child_database"), outline.join(" | "));
    await must("notion_undo", { undo_id: r.undo_id });
    const after = (await tool("notion_get_blocks", { block: reportHost, max_depth: 0 })).text.split("\n");
    expect(after.length === 2, `linked view not removed: ${after.join(" | ")}`);
    const dash = await must("notion_views", { action: "create", database: tracker.db, view: { name: "Dashboard", type: "dashboard" } });
    const w = await must("notion_views", { action: "create", database: tracker.db, view: { name: "Count", type: "chart", chart: { type: "number", y: "count" } }, on: { dashboard: dash.view_id } });
    expect(w.view_id, JSON.stringify(w));
    await must("notion_undo", { undo_id: w.undo_id });
    await must("notion_undo", { undo_id: dash.undo_id });
  });
  let chartBlock = "";
  await step("notion_create_chart: image from a database query and from inline data", async () => {
    const r = await must("notion_create_chart", {
      parent: reportHost, chart: { type: "bar", title: "Estimate by priority", value_format: "currency" },
      source: { database: tracker.db, x: "Priority", y: "sum:Estimate" },
    });
    chartBlock = r.block_id;
    expect(r.points === 3 && r.rows_scanned === 15, JSON.stringify(r));
    const b = (await call(() => n.blocks.retrieve({ block_id: chartBlock }))) as unknown as Json;
    expect(b.type === "image" && b.image.type === "file", JSON.stringify(b.image).slice(0, 200));
    const inline = await must("notion_create_chart", {
      parent: reportHost, position: "start", chart: { type: "line", title: "Burndown" },
      data: [{ x: "2026-09-01", y: 15, series: "Open" }, { x: "2026-09-08", y: 11, series: "Open" }, { x: "2026-09-15", y: 6, series: "Open" }],
    });
    await must("notion_undo", { undo_id: inline.undo_id });
    const bad = await tool("notion_create_chart", { parent: reportHost, chart: { type: "pie" }, data: [{ x: "a", y: -1 }] });
    expect(bad.isError && /negative/.test(bad.text), bad.text);
  });
  await step("notion_create_chart: refresh in place from new data, then undo", async () => {
    const before = (await call(() => n.blocks.retrieve({ block_id: chartBlock }))) as unknown as Json;
    await must("notion_bulk_update", { database: tracker.db, where: { Priority: "Low" }, set: { Estimate: 99999 }, dry_run: false });
    const r = await must("notion_create_chart", { refresh_block_id: chartBlock });
    const mid = (await call(() => n.blocks.retrieve({ block_id: chartBlock }))) as unknown as Json;
    expect(mid.image.file.url.split("?")[0] !== before.image.file.url.split("?")[0], "image not replaced");
    await must("notion_undo", { undo_id: r.undo_id });
    const after = (await call(() => n.blocks.retrieve({ block_id: chartBlock }))) as unknown as Json;
    expect(after.image.file.url.split("?")[0] !== mid.image.file.url.split("?")[0], "image not restored");
    await must("notion_undo", {});
  });
  await step("notion_build_report: summary, KPIs, live and image charts, overdue table, gantt; undo", async () => {
    const r = await must("notion_build_report", {
      database: tracker.db, parent: pageId, title: `${stamp} Tracker report`,
      charts: [
        { title: "Tasks by status", type: "column", x: "Status" },
        { title: "Estimate by client and priority", type: "grouped_column", x: "Client", y: "sum:Estimate", series: "Priority" },
      ],
      table: { title: "Overdue", where: { Due: { before: "today" }, Status: { "!=": "Done" } }, properties: ["Task", "Status", "Due", "Client"], sort: { property: "Due" }, linked_view: true },
      gantt: { title: "Upcoming work", start: "Due", section: "Client", where: { Status: { "!=": "Done" } } },
    });
    createdPages.push(r.page_id);
    expect(r.sections.native_charts === 1 && r.sections.image_charts === 1 && r.sections.kpis === 4, JSON.stringify(r.sections));
    const outline = (await tool("notion_get_blocks", { block: r.page_id, max_depth: 3, max_blocks: 400 })).text;
    for (const want of ["(callout)", "(column_list)", "(child_database)", "(image)", "(table)", "(code)", "Overdue", "Upcoming work"]) expect(outline.includes(want), `report lacks ${want}`);
    expect((outline.match(/\(child_database\)/g) ?? []).length === 2, "expected a live chart and a live table");
    const md = (await tool("notion_get_page", { page: r.page_id, format: "markdown" })).text;
    expect(md.includes("```mermaid") && md.includes("gantt"), "gantt missing");
    await must("notion_undo", { undo_id: r.undo_id });
    const p = (await call(() => n.pages.retrieve({ page_id: r.page_id }))) as unknown as Json;
    expect(p.in_trash === true, "report not trashed");
  });

  // ---------- phase 5: automations ----------
  await step("notion_automation: weekday schedule marks past-due rows At Risk with a comment; runs once; undo", async () => {
    const rule = {
      id: "at-risk",
      schedule: "weekdays 09:00",
      database: tracker.db,
      when: { where: { Due: { before: "today" }, Status: { not_in: ["Done", "At Risk"] } } },
      actions: [{ set: { Status: "At Risk" } }, { comment: "Past due: {{page.Task}} was due {{page.Due}}" }],
      limit: 100,
    };
    const added = await must("notion_automation", { action: "add", rule });
    expect(added.cron === "0 9 * * 1-5" && added.next_run, JSON.stringify(added));
    const pastDue = await must("notion_query", { database: tracker.db, where: rule.when.where });
    expect(pastDue.count > 0, "no past-due rows to test with");
    const dry = (await tool("notion_automation", { action: "dry_run", rule_id: "at-risk", force: true })).text;
    expect(dry.includes(`would act on ${pastDue.count}`), dry);
    const run = await must("notion_automation", { action: "run", rule_id: "at-risk", force: true });
    expect(!run.failed && run.undo.length === 1, JSON.stringify(run));
    const nowAtRisk = await must("notion_query", { database: tracker.db, where: { Status: "At Risk" } });
    expect(nowAtRisk.count >= pastDue.count, `${nowAtRisk.count} At Risk`);
    const comments = (await call(() => n.comments.list({ block_id: pastDue.rows[0].id }))).results as Json[];
    expect(comments.some((c) => c.rich_text.map((t: Json) => t.plain_text).join("").startsWith("Past due:")), "comment missing");
    const again = await must("notion_automation", { action: "run", rule_id: "at-risk", force: true });
    expect(/acted on 0 of 0/.test(again.summary), `rule re-fired: ${again.summary}`);
    const notDue = (await tool("notion_automation", { action: "dry_run", rule_id: "at-risk" })).text;
    expect(/not due|would act on/.test(notDue), notDue);
    await must("notion_undo", { undo_id: run.undo[0].undo_id });
    const back = await must("notion_query", { database: tracker.db, where: rule.when.where });
    expect(back.count === pastDue.count, `after undo ${back.count} past-due rows`);
    return `${pastDue.count} rows marked, re-run acted on 0, undone`;
  });
  await step("notion_automation: row moves to Done → stamp Completed Date and refresh the chart; undo", async () => {
    const rule = {
      id: "stamp-completed",
      database: tracker.db,
      when: { where: { Status: "Done", "Completed Date": null } },
      actions: [{ set: { "Completed Date": "{{today}}" } }],
      then: [{ refresh_chart: chartBlock }],
    };
    const added = await must("notion_automation", { action: "add", rule });
    expect(/recipe/.test(added.note ?? ""), `recipe not embedded: ${JSON.stringify(added)}`);
    const saved = await must("notion_automation", { action: "get", rule_id: "stamp-completed" });
    expect(typeof saved.then[0].refresh_chart === "object" && saved.then[0].refresh_chart.source, JSON.stringify(saved.then));
    const before = (await call(() => n.blocks.retrieve({ block_id: chartBlock }))) as unknown as Json;
    const run = await must("notion_automation", { action: "run", rule_id: "stamp-completed" });
    expect(!run.failed && /acted on 6 of 6/.test(run.summary) && /then refresh chart/.test(run.summary), run.summary);
    const stamped = await must("notion_query", { database: tracker.db, where: { "Completed Date": { is_not_empty: true } } });
    expect(stamped.count === 6, `${stamped.count} stamped`);
    const after = (await call(() => n.blocks.retrieve({ block_id: chartBlock }))) as unknown as Json;
    expect(after.image.file.url.split("?")[0] !== before.image.file.url.split("?")[0], "chart not redrawn");
    await must("notion_undo", { undo_id: run.undo[0].undo_id });
    const cleared = await must("notion_query", { database: tracker.db, where: { "Completed Date": { is_not_empty: true } } });
    expect(cleared.count === 0, `${cleared.count} still stamped`);
  });
  await step("notion_automation: schedule-only report replaces its previous page; create_page; manage and history", async () => {
    const rule = {
      id: "weekly-report",
      schedule: "weekly mon 08:00",
      then: [
        { build_report: { database: tracker.db, parent: pageId, title: `${stamp} weekly {{today}}`, charts: [{ title: "By status", x: "Status" }] } },
        { create_page: { parent: pageId, title: `${stamp} notes {{today}}`, markdown: "- [ ] Review the report" } },
      ],
    };
    await must("notion_automation", { action: "add", rule });
    const first = await must("notion_automation", { action: "run", rule_id: "weekly-report", force: true });
    expect(!first.failed, first.summary);
    const second = await must("notion_automation", { action: "run", rule_id: "weekly-report", force: true });
    expect(!second.failed, second.summary);
    const reports = (await must("notion_search", { query: `${stamp} weekly`, type: "page" })) as Json;
    const live = (reports.results ?? []).filter((p: Json) => p.title.startsWith(`${stamp} weekly`));
    for (const p of live) createdPages.push(p.id);
    const notes = (await must("notion_search", { query: `${stamp} notes`, type: "page" })) as Json;
    for (const p of notes.results ?? []) createdPages.push(p.id);
    const firstReport = first.summary.match(/report (\S+)/)?.[1] ?? "";
    const firstId = firstReport.match(/[0-9a-f]{32}/)?.[0];
    if (firstId) {
      const p = (await call(() => n.pages.retrieve({ page_id: firstId }))) as unknown as Json;
      expect(p.in_trash === true, "previous report not replaced");
    }
    for (const u of [...second.undo, ...first.undo]) await must("notion_undo", { undo_id: u.undo_id, force: true });
    await must("notion_automation", { action: "disable", rule_id: "weekly-report" });
    const list = await must("notion_automation", { action: "list" });
    expect(list.rules.find((r: Json) => r.id === "weekly-report").enabled === false, "disable failed");
    const del = await must("notion_automation", { action: "delete", rule_id: "weekly-report" });
    expect(del.removed_rule.id === "weekly-report", JSON.stringify(del));
    const history = await tool("notion_automation", { action: "history" });
    expect(!history.isError && Array.isArray(history.json) && history.json.length >= 4, history.text.slice(0, 200));
    for (const id of ["at-risk", "stamp-completed"]) await must("notion_automation", { action: "delete", rule_id: id });
  });

  await step("notion_bulk_create: undo trashes every created row", async () => {
    await must("notion_undo", { undo_id: bulkUndo });
    const q = await must("notion_query", { database: tracker.db });
    expect(q.count === 0, `${q.count} rows left`);
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
