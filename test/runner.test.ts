// The automation runner against a fake database: step order, resuming a failed row, occurrences that only count
// as fired when complete, waiving, and run limits. No network.
import { test, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@notionhq/client";

process.env.NOTION_PLUS_HOME = mkdtempSync(path.join(os.tmpdir(), "notion-plus-runner-test-"));
process.env.NOTION_PLUS_WORKSPACE = "test";
process.env.NOTION_PLUS_LOG = "off";

const { runAll, waive, loadState, statePath } = await import("../src/services/automations.js");
const { setClientForTests } = await import("../src/services/notion.js");
const { invalidateSchema } = await import("../src/services/schema.js");

const DS = "11111111-1111-1111-1111-111111111111";

function rt(text: string) {
  return [{ type: "text", text: { content: text, link: null }, annotations: {}, plain_text: text, href: null }];
}

interface Row {
  id: string;
  title: string;
  status: string;
  automated: boolean;
  note: string;
  in_trash: boolean;
}

/** A database with Name, Status, Note, and an Automated checkbox, whose writes are recorded in order. */
function fakeDb(rows: Row[], fail: { comment?: number; pageCreate?: number } = {}) {
  const writes: string[] = [];
  const pageOf = (r: Row) => ({
    object: "page",
    id: r.id,
    url: `https://notion.so/${r.id}`,
    in_trash: r.in_trash,
    parent: { type: "data_source_id", data_source_id: DS },
    properties: {
      Name: { id: "t", type: "title", title: rt(r.title) },
      Status: { id: "s", type: "select", select: { name: r.status } },
      Note: { id: "n", type: "rich_text", rich_text: rt(r.note) },
      Automated: { id: "a", type: "checkbox", checkbox: r.automated },
    },
  });
  const client = {
    dataSources: {
      retrieve: async () => ({
        object: "data_source",
        id: DS,
        title: rt("Tasks"),
        properties: {
          Name: { id: "t", name: "Name", type: "title", title: {} },
          Status: { id: "s", name: "Status", type: "select", select: { options: [{ id: "o1", name: "Done", color: "green" }, { id: "o2", name: "Open", color: "gray" }] } },
          Note: { id: "n", name: "Note", type: "rich_text", rich_text: {} },
          Automated: { id: "a", name: "Automated", type: "checkbox", checkbox: {} },
        },
      }),
      query: async () => ({
        results: rows.filter((r) => r.status === "Done" && !r.automated && !r.in_trash).map(pageOf),
        has_more: false,
        next_cursor: null,
      }),
    },
    pages: {
      update: async (a: { page_id: string; properties?: Record<string, Record<string, unknown>>; in_trash?: boolean }) => {
        const r = rows.find((x) => x.id === a.page_id);
        if (!r) throw new Error("no row");
        if (a.in_trash !== undefined) {
          r.in_trash = a.in_trash;
          writes.push(`trash ${r.id}`);
        }
        for (const [k, v] of Object.entries(a.properties ?? {})) {
          if (k === "Automated") r.automated = v.checkbox as boolean;
          if (k === "Note") r.note = ((v.rich_text as { text: { content: string } }[])[0]?.text.content) ?? "";
          if (k === "Status") r.status = (v.select as { name: string }).name;
          writes.push(`set ${r.id} ${k}`);
        }
        return pageOf(r);
      },
      create: async () => {
        if (fail.pageCreate && fail.pageCreate-- > 0) throw new Error("create failed");
        writes.push("create page");
        return { object: "page", id: `new-${writes.length}`, url: "https://notion.so/new" };
      },
    },
    blocks: {
      children: {
        append: async (a: { block_id: string; children: unknown[] }) => {
          writes.push(`append ${a.block_id}`);
          return { results: a.children.map((_, i) => ({ id: `b-${writes.length}-${i}` })) };
        },
      },
    },
    comments: {
      create: async (a: { parent: { page_id: string } }) => {
        if (fail.comment && fail.comment-- > 0) throw new Error("comment service down");
        writes.push(`comment ${a.parent.page_id}`);
        return { id: `c-${writes.length}` };
      },
    },
  } as unknown as Client;
  return { client, writes };
}

let n = 0;
function rulesFile(rules: unknown[]): string {
  const f = path.join(process.env.NOTION_PLUS_HOME as string, `rules-${++n}.json`);
  writeFileSync(f, JSON.stringify({ version: 1, timezone: "UTC", rules }));
  return f;
}

beforeEach(async () => {
  invalidateSchema(DS);
  writeFileSync(await statePath(), JSON.stringify({ rules: {} }));
});

const closeRule = {
  id: "close",
  database: DS,
  when: { where: { Status: "Done" } },
  actions: [{ set: { Note: "closed" } }, { append: "Closed." }, { comment: "Closed by automation" }],
  marker: "Automated",
};

test("row steps run in order with the marker written last", async () => {
  const { client, writes } = fakeDb([{ id: "r1", title: "A", status: "Done", automated: false, note: "", in_trash: false }]);
  setClientForTests(client);
  try {
    const report = await runAll({ dryRun: false, file: rulesFile([closeRule]) });
    assert.equal(report.status, "succeeded");
    assert.deepEqual(writes, ["set r1 Note", "append r1", "comment r1", "set r1 Automated"]);
    assert.equal((await loadState()).rules.close?.rows, undefined, "finished rows leave no progress behind");
  } finally {
    setClientForTests(null);
  }
}, 60_000);

test("a row that fails mid-way isn't marked, and the next run resumes at the failed step", async () => {
  const rows: Row[] = [{ id: "r1", title: "A", status: "Done", automated: false, note: "", in_trash: false }];
  const { client, writes } = fakeDb(rows, { comment: 1 });
  setClientForTests(client);
  try {
    const file = rulesFile([closeRule]);
    const first = await runAll({ dryRun: false, file });
    assert.equal(first.status, "failed");
    assert.match(first.results[0].rows[0].error ?? "", /comment service down/);
    assert.equal(rows[0].automated, false, "marker must not be written when a step failed");
    assert.deepEqual((await loadState()).rules.close?.rows?.r1?.done, ["set", "append:1"]);

    writes.length = 0;
    const second = await runAll({ dryRun: false, file });
    assert.equal(second.status, "succeeded");
    assert.deepEqual(writes, ["comment r1", "set r1 Automated"], "only the remaining steps run");
    assert.deepEqual(second.results[0].rows[0].resumed, ["set", "append:1"]);
    assert.equal(rows[0].automated, true);
  } finally {
    setClientForTests(null);
  }
}, 60_000);

test("a scheduled occurrence only counts as fired once all of it succeeded; waive gives up on it", async () => {
  const { client, writes } = fakeDb([], { pageCreate: 3 });
  setClientForTests(client);
  try {
    const rule = { id: "daily-page", schedule: "daily 09:00", then: [{ create_page: { parent: "22222222222222222222222222222222", title: "Day {{today}}" } }] };
    const file = rulesFile([rule]);
    const at = (t: string) => new Date(`2026-09-30T${t}:00Z`);

    const first = await runAll({ dryRun: false, file, now: at("09:05") });
    assert.equal(first.status, "failed");
    let s = (await loadState()).rules["daily-page"];
    assert.equal(s.last_fired, undefined, "a failed occurrence doesn't count as fired");
    assert.equal(s.pending?.key, "2026-09-30T09:00:00.000Z");

    // An hour later it's still due, and fails again.
    const second = await runAll({ dryRun: false, file, now: at("10:05") });
    assert.equal(second.results[0].occurrence, "2026-09-30T09:00:00.000Z");
    assert.equal(second.status, "failed");
    assert.equal((await loadState()).rules["daily-page"].pending?.attempts, 2);

    const w = await waive("daily-page");
    assert.equal(w.waived, "2026-09-30T09:00:00.000Z");
    s = (await loadState()).rules["daily-page"];
    assert.equal(s.last_fired, "2026-09-30T09:00:00.000Z");
    assert.equal(s.pending, undefined);
    const third = await runAll({ dryRun: false, file, now: at("11:05") });
    assert.equal(third.results[0].status, "skipped");
    assert.deepEqual(writes, []);
  } finally {
    setClientForTests(null);
  }
}, 60_000);

test("a scheduled occurrence that fails once is retried and then fires exactly once", async () => {
  const { client, writes } = fakeDb([], { pageCreate: 1 });
  setClientForTests(client);
  try {
    const file = rulesFile([{ id: "daily-page", schedule: "daily 09:00", then: [{ create_page: { parent: "22222222222222222222222222222222", title: "Day" } }] }]);
    await runAll({ dryRun: false, file, now: new Date("2026-09-30T09:05:00Z") });
    const retry = await runAll({ dryRun: false, file, now: new Date("2026-09-30T10:05:00Z") });
    assert.equal(retry.status, "succeeded");
    assert.equal((await loadState()).rules["daily-page"].last_fired, "2026-09-30T09:00:00.000Z");
    const again = await runAll({ dryRun: false, file, now: new Date("2026-09-30T11:05:00Z") });
    assert.equal(again.results[0].status, "skipped");
    assert.deepEqual(writes, ["create page"]);
  } finally {
    setClientForTests(null);
  }
}, 60_000);

test("run limits leave the remaining rows for the next run and report partial", async () => {
  const rows: Row[] = [
    { id: "r1", title: "A", status: "Done", automated: false, note: "", in_trash: false },
    { id: "r2", title: "B", status: "Done", automated: false, note: "", in_trash: false },
  ];
  const { client } = fakeDb(rows);
  setClientForTests(client);
  try {
    const file = rulesFile([{ ...closeRule, actions: [{ comment: "hi" }] }]);
    const report = await runAll({ dryRun: false, file, limits: { max_rows: 1 } });
    assert.equal(report.status, "partial");
    assert.equal(report.results[0].acted, 1);
    assert.match(report.results[0].rows[1].error ?? "", /row limit/);
    const next = await runAll({ dryRun: false, file, limits: { max_rows: 1 } });
    assert.equal(next.status, "succeeded");
    assert.ok(rows.every((r) => r.automated));
  } finally {
    setClientForTests(null);
  }
}, 60_000);

test("a value the condition checks is written in the commit step, after content", async () => {
  const rows: Row[] = [{ id: "r1", title: "A", status: "Done", automated: false, note: "", in_trash: false }];
  const { client, writes } = fakeDb(rows);
  setClientForTests(client);
  try {
    const rule = { id: "reopen", database: DS, when: { where: { Status: "Done" } }, actions: [{ set: { Status: "Open", Note: "reopened" } }, { append: "Reopened." }] };
    const report = await runAll({ dryRun: false, file: rulesFile([rule]) });
    assert.equal(report.status, "succeeded");
    assert.deepEqual(writes, ["set r1 Note", "append r1", "set r1 Status"]);
  } finally {
    setClientForTests(null);
  }
}, 60_000);

test("notion_automation run is an error unless every rule succeeded; history pages and skips bad lines", async () => {
  const { registerAutomationTools } = await import("../src/tools/automations.js");
  const { unwrap } = await import("../src/tools/util.js");
  const { runLogPath } = await import("../src/services/automations.js");
  const { appendFile } = await import("node:fs/promises");
  const handlers = new Map<string, (a: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>>();
  registerAutomationTools({ registerTool: (name: string, _c: unknown, h: never) => handlers.set(name, h) } as never);
  const tool = (args: Record<string, unknown>) =>
    (handlers.get("notion_automation") as (a: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }>)({
      force: false,
      import_mode: "merge",
      limit: 20,
      ...args,
    });
  const rows: Row[] = [{ id: "r1", title: "A", status: "Done", automated: false, note: "", in_trash: false }];
  const { client } = fakeDb(rows, { comment: 1 });
  setClientForTests(client);
  process.env.NOTION_PLUS_RULES = rulesFile([closeRule]);
  try {
    const failed = await tool({ action: "run" });
    assert.equal(failed.isError, true);
    const { env, json: body } = unwrap(failed);
    assert.equal(env?.status, "error");
    assert.equal(body.status, "failed");
    assert.ok((body.undo as unknown[]).length === 1, "undo ids are still returned");
    const fixed = await tool({ action: "run" });
    assert.equal(fixed.isError, undefined);
    assert.equal(unwrap(fixed).json.status, "succeeded");
    assert.equal(unwrap(fixed).env?.status, "ok");

    await appendFile(await runLogPath(), "{not json\n");
    const page1 = unwrap(await tool({ action: "history", limit: 1 })).json as { runs: unknown[]; unreadable_lines: number; next_cursor: number };
    assert.equal(page1.runs.length, 0);
    assert.equal(page1.unreadable_lines, 1);
    assert.equal(page1.next_cursor, 1);
    const page2 = unwrap(await tool({ action: "history", limit: 5, cursor: page1.next_cursor })).json as { runs: { status: string }[] };
    assert.ok(page2.runs.length >= 2);
    assert.equal(page2.runs[0].status, "succeeded");
  } finally {
    delete process.env.NOTION_PLUS_RULES;
    setClientForTests(null);
  }
}, 60_000);

test("a scheduled rule whose rows all failed doesn't run its follow-up on the retry until a row succeeds", async () => {
  const rows: Row[] = [{ id: "r1", title: "A", status: "Done", automated: false, note: "", in_trash: false }];
  const { client, writes } = fakeDb(rows, { comment: 2 });
  setClientForTests(client);
  try {
    const rule = { ...closeRule, id: "daily-close", schedule: "daily 09:00", actions: [{ comment: "hi" }], then: [{ create_page: { parent: "22222222222222222222222222222222", title: "Closed today" } }] };
    const file = rulesFile([rule]);
    const at = (t: string) => new Date(`2026-09-30T${t}:00Z`);
    assert.equal((await runAll({ dryRun: false, file, now: at("09:05") })).status, "failed");
    assert.equal((await runAll({ dryRun: false, file, now: at("10:05") })).status, "failed");
    assert.deepEqual(writes, [], "no follow-up while no row was acted on");
    const ok = await runAll({ dryRun: false, file, now: at("11:05") });
    assert.equal(ok.status, "succeeded");
    assert.deepEqual(writes, ["comment r1", "set r1 Automated", "create page"]);
    assert.equal((await loadState()).rules["daily-close"].last_fired, "2026-09-30T09:00:00.000Z");
  } finally {
    setClientForTests(null);
  }
}, 60_000);
