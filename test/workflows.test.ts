// The workflow engine against a fake workspace: references and secrets, step order and outputs, retries, resuming
// without duplicates after a failed or interrupted create, approvals, delays, sub-workflows, the HTTP allow-list,
// failure notifications, schedules across a DST change, and converting v1 rules. No network.
import { test, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Client } from "@notionhq/client";

process.env.NOTION_PLUS_HOME = mkdtempSync(path.join(os.tmpdir(), "notion-plus-wf-test-"));
process.env.NOTION_PLUS_WORKSPACE = "test";
process.env.NOTION_PLUS_LOG = "off";
process.env.NOTION_PLUS_TIMEZONE = "UTC";

const engine = await import("../src/services/workflow/engine.js");
const { parseWorkflow } = await import("../src/services/workflow/schema.js");
const refs = await import("../src/services/workflow/refs.js");
const { setClientForTests } = await import("../src/services/notion.js");
const { invalidateSchema } = await import("../src/services/schema.js");
const { ruleSchema } = await import("../src/services/automations.js");
const { history } = await import("../src/services/journal.js");

const DS = "11111111-1111-1111-1111-111111111111";
const R1 = "aaaaaaaa-0000-0000-0000-000000000001";
const R2 = "aaaaaaaa-0000-0000-0000-000000000002";
const { APIErrorCode, APIResponseError } = await import("@notionhq/client");
const notFound = () => new APIResponseError({ code: APIErrorCode.ObjectNotFound, status: 404, message: "not found", headers: {}, rawBodyText: "{}", additional_data: undefined, request_id: undefined });
const PARENT = "22222222-2222-2222-2222-222222222222";
const rt = (t: string) => [{ type: "text", text: { content: t, link: null }, annotations: {}, plain_text: t, href: null }];

interface Row { id: string; title: string; status: string; approved: boolean; in_trash: boolean }

/** A database of tasks plus a parent page; records every write in order. */
function fake(rows: Row[], opts: { failComments?: number; createThenThrow?: number } = {}) {
  const writes: string[] = [];
  const comments: { id: string; page: string; text: string; created_time: string }[] = [];
  const children: Record<string, { id: string; type: string; created_time: string; [k: string]: unknown }[]> = { [PARENT]: [] };
  let n = 0;
  const pageOf = (r: Row) => ({
    object: "page", id: r.id, url: `https://notion.so/${r.id}`, in_trash: r.in_trash, created_time: "2026-10-01T00:00:00.000Z",
    parent: { type: "data_source_id", data_source_id: DS },
    properties: {
      Name: { id: "t", type: "title", title: rt(r.title) },
      Status: { id: "s", type: "select", select: { name: r.status } },
      Approved: { id: "a", type: "checkbox", checkbox: r.approved },
    },
  });
  const client = {
    dataSources: {
      retrieve: async ({ data_source_id }: { data_source_id: string }) => {
        if (data_source_id !== DS) throw notFound();
        return {
          object: "data_source", id: DS, title: rt("Tasks"), parent: { type: "database_id", database_id: "33333333-3333-3333-3333-333333333333" },
          properties: {
            Name: { id: "t", name: "Name", type: "title", title: {} },
            Status: { id: "s", name: "Status", type: "select", select: { options: [{ id: "1", name: "Open", color: "gray" }, { id: "2", name: "Done", color: "green" }] } },
            Approved: { id: "a", name: "Approved", type: "checkbox", checkbox: {} },
          },
        };
      },
      query: async () => ({ results: rows.filter((r) => !r.in_trash && r.status === "Open").map(pageOf), has_more: false, next_cursor: null }),
    },
    databases: { retrieve: async () => Promise.reject(notFound()) },
    pages: {
      retrieve: async ({ page_id }: { page_id: string }) => {
        const r = rows.find((x) => x.id === page_id);
        if (!r) throw new Error("no page");
        return pageOf(r);
      },
      update: async (a: { page_id: string; properties?: Record<string, Record<string, unknown>>; in_trash?: boolean }) => {
        const r = rows.find((x) => x.id === a.page_id) as Row;
        for (const [k, v] of Object.entries(a.properties ?? {})) {
          if (k === "Status") r.status = (v.select as { name: string }).name;
          if (k === "Approved") r.approved = v.checkbox as boolean;
          writes.push(`set ${r.id} ${k}`);
        }
        if (a.in_trash !== undefined) {
          r.in_trash = a.in_trash;
          writes.push(`trash ${r.id}`);
        }
        return pageOf(r);
      },
      create: async (b: { parent: { page_id?: string }; properties: { title?: { title: { text: { content: string } }[] } } }) => {
        const id = `bbbbbbbb-0000-0000-0000-${String(++n).padStart(12, "0")}`;
        const title = b.properties.title?.title[0]?.text.content ?? "";
        if (b.parent.page_id) children[b.parent.page_id]?.push({ id, type: "child_page", child_page: { title }, created_time: new Date().toISOString(), has_children: false, object: "block" });
        writes.push(`create ${title}`);
        if (opts.createThenThrow && opts.createThenThrow-- > 0) throw new Error("connection reset after the page was made");
        return { object: "page", id, url: `https://notion.so/${id}` };
      },
    },
    blocks: {
      children: {
        list: async ({ block_id }: { block_id: string }) => ({ results: children[block_id] ?? [], has_more: false, next_cursor: null }),
        append: async (a: { block_id: string; children: unknown[] }) => {
          writes.push(`append ${a.block_id}`);
          return { results: a.children.map(() => ({ id: `b-${++n}` })) };
        },
      },
      delete: async ({ block_id }: { block_id: string }) => (writes.push(`delete ${block_id}`), {}),
    },
    comments: {
      create: async (a: { parent: { page_id: string }; rich_text: { text: { content: string } }[] }) => {
        if (opts.failComments && opts.failComments-- > 0) throw new Error("comments are down");
        const c = { id: `c-${++n}`, page: a.parent.page_id, text: a.rich_text.map((t) => t.text.content).join(""), created_time: new Date().toISOString() };
        comments.push(c);
        writes.push(`comment ${c.page}: ${c.text}`);
        return { id: c.id };
      },
      list: async ({ block_id }: { block_id: string }) => ({
        results: comments.filter((c) => c.page === block_id).map((c) => ({ id: c.id, created_time: c.created_time, rich_text: rt(c.text) })),
        has_more: false,
      }),
    },
  } as unknown as Client;
  return { client, writes, comments };
}

beforeEach(async () => {
  invalidateSchema(DS);
  writeFileSync(path.join(process.env.NOTION_PLUS_HOME as string, "workflows.json"), "{}");
});

const wf = (steps: unknown[], extra: Record<string, unknown> = {}) => parseWorkflow({ version: 2, id: "wf", steps, ...extra });

test("references: whole values pass through, text is interpolated, missing ones are errors; secrets are redacted", () => {
  const ctx = { steps: { q: { rows: [{ id: R1, Status: "Open" }] } }, n: 3 };
  assert.deepEqual(refs.resolve("${steps.q.rows}", ctx), [{ id: R1, Status: "Open" }]);
  assert.equal(refs.resolve("Row ${steps.q.rows.0.id} is ${steps.q.rows.0.Status}", ctx), `Row ${R1} is Open`);
  assert.throws(() => refs.resolve("${steps.nope}", ctx), /has no value/);
  assert.equal(refs.truthy("${steps.nope}", ctx), false);
  assert.equal(refs.truthy("${steps.q.rows}", ctx), true);
  process.env.NOTION_PLUS_SECRET_API_KEY = "sk-very-secret-value";
  assert.equal(refs.resolve("Bearer ${secret:api_key}", {}), "Bearer sk-very-secret-value");
  assert.deepEqual(refs.redact({ err: "401 for sk-very-secret-value" }), { err: "401 for ***" });
  assert.throws(() => refs.resolve("${secret:missing}", {}), /NOTION_PLUS_SECRET_MISSING/);
});

test("steps run in order, read each other's outputs, loop over rows, branch, and skip by condition; undo is recorded", async () => {
  const rows: Row[] = [{ id: R1, title: "A", status: "Open", approved: false, in_trash: false }, { id: R2, title: "B", status: "Open", approved: false, in_trash: false }];
  const { client, writes } = fake(rows);
  setClientForTests(client);
  try {
    const w = wf([
      { id: "open", query: { database: DS, where: { Status: "Open" } } },
      { id: "nothing", if: "${steps.open.missing}", comment: { page: R1, text: "never" } },
      {
        id: "each",
        foreach: {
          items: "${steps.open.rows}",
          as: "row",
          steps: [
            { id: "note", comment: { page: "${row}", text: "Closing ${row.title}" } },
            { id: "route", switch: { on: "${row.title}", cases: { A: [{ id: "close_a", set: { page: "${row}", values: { Status: "Done" } } }] }, default: [{ id: "trash_other", trash: { page: "${row}" } }] } },
          ],
        },
      },
    ]);
    const run = await engine.startRun(w);
    assert.equal(run.status, "succeeded", run.error);
    assert.deepEqual(writes, [`comment ${R1}: Closing A`, `set ${R1} Status`, `comment ${R2}: Closing B`, `trash ${R2}`]);
    assert.equal(run.steps.nothing.status, "skipped");
    assert.equal(run.steps["each[1].route.trash_other"].status, "succeeded");
    assert.equal(run.undo_ids.length, 1);
    const [entry] = await history(1);
    assert.equal(entry.id, run.undo_ids[0]);
    assert.ok(entry.undo.length >= 4);
  } finally {
    setClientForTests(null);
  }
}, 60_000);

test("retries: a step that fails once succeeds on its second attempt", async () => {
  const rows: Row[] = [{ id: R1, title: "A", status: "Open", approved: false, in_trash: false }];
  const { client, comments } = fake(rows, { failComments: 1 });
  setClientForTests(client);
  try {
    const run = await engine.startRun(wf([{ id: "c", retry: { attempts: 2, backoff_seconds: 0 }, comment: { page: R1, text: "hi" } }]));
    assert.equal(run.status, "succeeded");
    assert.equal(run.steps.c.attempts, 2);
    assert.equal(comments.length, 1);
  } finally {
    setClientForTests(null);
  }
}, 60_000);

test("a create that landed but reported failure isn't repeated when the run resumes", async () => {
  const { client, writes } = fake([], { createThenThrow: 1 });
  setClientForTests(client);
  try {
    const w = wf([{ id: "page", create_page: { parent: PARENT, title: "Weekly notes" } }, { id: "after", comment: { page: "${steps.page.page_id}", text: "made" } }]);
    await engine.saveWorkflow(w);
    const first = await engine.startRun(w);
    assert.equal(first.status, "failed");
    const second = await engine.resumeRun(first.run_id);
    assert.equal(second.status, "succeeded", second.error);
    assert.deepEqual(writes.filter((x) => x.startsWith("create")), ["create Weekly notes"], "the page is created once");
    assert.equal((second.steps.page.out as { adopted?: boolean }).adopted, true);
    assert.deepEqual(writes.filter((x) => x.startsWith("comment")), ["comment bbbbbbbb-0000-0000-0000-000000000001: made"]);
  } finally {
    setClientForTests(null);
  }
}, 60_000);

test("approval pauses the run, asks once, and continues when the checkbox is checked", async () => {
  const rows: Row[] = [{ id: R1, title: "Launch", status: "Open", approved: false, in_trash: false }];
  const { client, writes } = fake(rows);
  setClientForTests(client);
  try {
    const w = wf([
      { id: "ok", approval: { page: R1, property: "Approved", message: "Please approve the launch." } },
      { id: "go", set: { page: R1, values: { Status: "Done" } } },
    ]);
    await engine.saveWorkflow(w);
    const run = await engine.startRun(w);
    assert.equal(run.status, "waiting");
    assert.deepEqual(run.waiting, { step: "ok", kind: "approval" });
    const again = await engine.resumeRun(run.run_id);
    assert.equal(again.status, "waiting");
    assert.equal(writes.filter((x) => x.startsWith("comment")).length, 1, "the request is posted once");
    rows[0].approved = true;
    const done = await engine.resumeRun(run.run_id);
    assert.equal(done.status, "succeeded");
    assert.ok(writes.includes(`set ${R1} Status`));
  } finally {
    setClientForTests(null);
  }
}, 60_000);

test("delay waits until its time; the scheduler pass resumes it then", async () => {
  const rows: Row[] = [{ id: R1, title: "A", status: "Open", approved: false, in_trash: false }];
  const { client, writes } = fake(rows);
  setClientForTests(client);
  try {
    const w = wf([{ id: "wait", delay: { minutes: 30 } }, { id: "note", comment: { page: R1, text: "later" } }]);
    await engine.saveWorkflow(w);
    const t0 = new Date("2026-10-01T10:00:00Z");
    const run = await engine.startRun(w, { now: () => t0 });
    assert.equal(run.status, "waiting");
    assert.equal(run.waiting?.until, "2026-10-01T10:30:00.000Z");
    const early = await engine.tick(() => new Date("2026-10-01T10:10:00Z"));
    assert.equal(early.resumed.length, 0);
    const later = await engine.tick(() => new Date("2026-10-01T10:31:00Z"));
    assert.equal(later.resumed[0]?.status, "succeeded");
    assert.deepEqual(writes, [`comment ${R1}: later`]);
  } finally {
    setClientForTests(null);
  }
}, 60_000);

test("sub-workflows get their inputs; http stays inside the allow-list; failures notify", async () => {
  const rows: Row[] = [{ id: R1, title: "A", status: "Open", approved: false, in_trash: false }];
  const { client, writes } = fake(rows);
  setClientForTests(client);
  try {
    await engine.saveWorkflow(wf([{ id: "say", comment: { page: "${inputs.page}", text: "from child: ${inputs.msg}" } }], { id: "child" }));
    const parent = wf([{ id: "call", run_workflow: { id: "child", with: { page: R1, msg: "hello" } } }], { id: "parent" });
    const r1 = await engine.startRun(parent);
    assert.equal(r1.status, "succeeded", r1.error);
    assert.ok(writes.includes(`comment ${R1}: from child: hello`));

    delete process.env.NOTION_PLUS_HTTP_ALLOW;
    const blocked = wf([{ id: "hook", http: { url: "https://api.example.com/x", body: { a: 1 } } }], { id: "blocked", on_failure: [{ comment: R1 }] });
    const r2 = await engine.startRun(blocked);
    assert.equal(r2.status, "failed");
    assert.match(r2.error ?? "", /NOTION_PLUS_HTTP_ALLOW/);
    assert.ok(writes.some((x) => x.startsWith(`comment ${R1}: Workflow "blocked"`) && x.includes("failed")), "on_failure commented");
  } finally {
    setClientForTests(null);
  }
}, 60_000);

test("schedules start a workflow once per occurrence, following the time zone across a DST change", async () => {
  const { client } = fake([]);
  setClientForTests(client);
  process.env.NOTION_PLUS_TIMEZONE = "America/New_York";
  try {
    await engine.saveWorkflow(wf([{ id: "noop", if: "${inputs.never}", delay: { minutes: 1 } }], { id: "daily", trigger: { schedule: "daily 09:00" } }));
    // 09:00 New York is 13:00 UTC in summer time (until Nov 1, 2026) and 14:00 UTC after.
    const a = await engine.tick(() => new Date("2026-10-31T13:05:00Z"));
    assert.equal(a.started.length, 1);
    assert.equal((a.started[0].trigger as { occurrence: string }).occurrence, "2026-10-31T13:00:00.000Z");
    assert.equal((await engine.tick(() => new Date("2026-10-31T13:50:00Z"))).started.length, 0, "same occurrence: not again");
    // Nov 1, after the clocks go back: 13:30 UTC is 08:30 in New York, so not due yet.
    assert.equal((await engine.tick(() => new Date("2026-11-01T13:30:00Z"))).started.length, 0, "not 13:00 UTC any more");
    const b = await engine.tick(() => new Date("2026-11-01T14:05:00Z"));
    assert.equal((b.started[0]?.trigger as { occurrence: string }).occurrence, "2026-11-01T14:00:00.000Z");
  } finally {
    process.env.NOTION_PLUS_TIMEZONE = "UTC";
    setClientForTests(null);
  }
}, 60_000);

test("a v1 rule converts to an equivalent workflow (marker last), and unsupported rules say why", () => {
  const rule = ruleSchema.parse({
    id: "close-done",
    database: DS,
    when: { where: { Status: "Done" } },
    actions: [{ set: { Status: "Archived" } }, { comment: "Closed {{page.Name}} on {{today}}" }],
    marker: "Automated",
  });
  const w = engine.convertRule(rule);
  assert.equal(w.enabled, false);
  assert.deepEqual(w.trigger, { schedule: "hourly" });
  const loop = w.steps[1] as unknown as { foreach: { steps: { id: string; comment?: { text: string } }[] } };
  assert.deepEqual(loop.foreach.steps.map((s) => s.id), ["set_0", "comment_1", "mark"]);
  assert.equal(loop.foreach.steps[1].comment?.text, "Closed ${row.Name} on ${today}");
  const relative = ruleSchema.parse({ id: "old", database: DS, when: { relative: [{ property: "$created", older_than_days: 30 }] }, actions: [{ trash: true }] });
  assert.throws(() => engine.convertRule(relative), /relative dates/);
});

test("workflow specs: duplicate step ids and bad schedules are refused", () => {
  assert.throws(() => wf([{ id: "a", delay: { minutes: 1 } }, { id: "a", delay: { minutes: 1 } }]), /used twice/);
  assert.throws(() => wf([{ id: "a", delay: { minutes: 1 } }], { trigger: { schedule: "sometimes" } }), /schedule/i);
  assert.throws(() => wf([{ id: "a", approval: { page: "p" } }]), /property|comment_keyword/);
});

test("removeLeftovers deletes only the blocks an interrupted append left, so the retry doesn't duplicate them", async () => {
  const { removeLeftovers } = await import("../src/services/workflow/actions.js");
  const deleted: string[] = [];
  const para = (id: string, text: string, created: string) => ({ object: "block", id, type: "paragraph", has_children: false, created_time: created, paragraph: { rich_text: rt(text), color: "default" } });
  setClientForTests({
    blocks: {
      children: {
        list: async () => ({
          results: [
            para("old", "Closed on 2026-09-01", "2026-09-01T10:00:00.000Z"), // same text, but from long before: kept
            para("left-1", "Closed on 2026-10-01", "2026-10-01T10:00:00.000Z"),
            para("left-2", "second block", "2026-10-01T10:00:00.000Z"),
          ],
          has_more: false,
          next_cursor: null,
        }),
      },
      delete: async ({ block_id }: { block_id: string }) => (deleted.push(block_id), {}),
    },
  } as unknown as Client);
  try {
    const specs = [{ type: "paragraph", text: "Closed on 2026-10-01" }, { type: "paragraph", text: "second block" }, { type: "paragraph", text: "third" }];
    assert.equal(await removeLeftovers(R1, specs, "2026-10-01T10:00:30.000Z"), 2);
    assert.deepEqual(deleted, ["left-1", "left-2"]);
  } finally {
    setClientForTests(null);
  }
});
