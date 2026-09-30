// Durable local state: corruption stops instead of reading as empty, writes are atomic, locks hold across
// processes, and a crash mid-write leaves an interrupted journal entry. Several tests run child processes.
import { test } from "vitest";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@notionhq/client";

process.env.NOTION_PLUS_HOME = mkdtempSync(path.join(os.tmpdir(), "notion-plus-store-test-"));
process.env.NOTION_PLUS_WORKSPACE = "test";

const { readJson, StateCorruptError, updateJson, withLock, writeJson } = await import("../src/services/store.js");
const { history, record, runJournaled } = await import("../src/services/journal.js");
const { call, setClientForTests } = await import("../src/services/notion.js");
const { editRules, loadRulesWithRevision, loadState, RulesConflictError } = await import("../src/services/automations.js");
const { stateDir } = await import("../src/services/workspace.js");

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(root, "node_modules", ".bin", "tsx");
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "notion-plus-store-"));
const asObject = (raw: unknown) => {
  if (!raw || typeof raw !== "object") throw new Error("expected an object");
  return raw as { n: number };
};

test("readJson: missing is empty; bad JSON and bad contents stop with a recovery message and leave the file alone", async () => {
  const dir = tmp();
  assert.deepEqual((await readJson(path.join(dir, "none.json"), asObject, () => ({ n: 0 }))).data, { n: 0 });
  const bad = path.join(dir, "bad.json");
  writeFileSync(bad, '{"n": 1'); // cut off mid-write
  await assert.rejects(readJson(bad, asObject, () => ({ n: 0 })), (e: unknown) => e instanceof StateCorruptError && /\.bak/.test((e as Error).message));
  assert.equal(readFileSync(bad, "utf8"), '{"n": 1');
  const wrong = path.join(dir, "wrong.json");
  writeFileSync(wrong, "[1,2]");
  await assert.rejects(readJson(wrong, () => { throw new Error("expected an object"); }, () => ({ n: 0 })), /unexpected contents/);
  // A directory where the file should be is an unreadable file, not missing state.
  await assert.rejects(readJson(dir, asObject, () => ({ n: 0 })), StateCorruptError);
});

test("writeJson: replaces atomically, keeps the previous version, leaves no temp files", async () => {
  const dir = tmp();
  const f = path.join(dir, "s.json");
  const r1 = await writeJson(f, { n: 1 });
  const r2 = await writeJson(f, { n: 2 });
  assert.notEqual(r1, r2);
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { n: 2 });
  assert.deepEqual(JSON.parse(readFileSync(`${f}.bak`, "utf8")), { n: 1 });
  assert.deepEqual(readdirSync(dir).sort(), ["s.json", "s.json.bak"]);
  assert.equal((await readJson(f, asObject, () => ({ n: 0 }))).revision, r2);
});

test("withLock: a lock left by a dead process is broken; a live one times out with a clear error", async () => {
  const dir = tmp();
  const f = path.join(dir, "s.json");
  writeFileSync(`${f}.lock`, JSON.stringify({ pid: 2 ** 22 + 12345, at: new Date().toISOString() }));
  assert.equal(await withLock(f, async () => "got it", { timeoutMs: 2000 }), "got it");
  assert.equal(existsSync(`${f}.lock`), false);
  writeFileSync(`${f}.lock`, JSON.stringify({ pid: process.ppid, at: new Date().toISOString() }));
  await assert.rejects(withLock(f, async () => "no", { timeoutMs: 300 }), /locked by another process/);
});

test("updateJson: two processes incrementing 100 times each lose no updates", async () => {
  const dir = tmp();
  const f = path.join(dir, "counter.json");
  const script = path.join(dir, "inc.mts");
  writeFileSync(
    script,
    `import { updateJson } from ${JSON.stringify(path.join(root, "src/services/store.ts"))};\n` +
      `for (let i = 0; i < 100; i++) await updateJson(${JSON.stringify(f)}, (r) => r as { n: number }, () => ({ n: 0 }), (d) => ({ data: { n: d.n + 1 }, result: null }));\n`
  );
  await Promise.all([run(tsx, [script]), run(tsx, [script])]);
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { n: 200 });
}, 120_000);

test("journal: record completes the intent written before the first write; a no-record success leaves nothing", async () => {
  setClientForTests({ pages: { update: async () => ({}) } } as unknown as Client);
  try {
    const id = await runJournaled("notion_update_properties", { page: "p1" }, async () => {
      await call(() => Promise.resolve({}));
      const before = (await history(1))[0];
      assert.equal(before.status, "pending");
      const jid = await record("notion_update_properties", "Updated Status on p1", [{ kind: "page_trash", page_id: "p1", in_trash: true }]);
      assert.equal(jid, before.id, "record fills in the intent instead of adding an entry");
      return { content: [{ type: "text" as const, text: jid }] };
    });
    const [latest] = await history(1);
    assert.equal(latest.id, id.content[0].text);
    assert.equal(latest.status, undefined);
    assert.equal(latest.undo.length, 1);

    const count = (await history(500)).length;
    await runJournaled("notion_undo", {}, async () => {
      await call(() => Promise.resolve({}));
      return { content: [{ type: "text" as const, text: "ok" }] };
    });
    assert.equal((await history(500)).length, count, "a write that records nothing leaves no entry");

    const failed = await runJournaled("notion_insert_blocks", { page: "p2" }, async () => {
      await call(() => Promise.resolve({}));
      return { content: [{ type: "text" as const, text: "Error: boom" }], isError: true };
    });
    assert.equal(failed.isError, true);
    const [f] = await history(1);
    assert.equal(f.status, "failed");
    assert.match(f.error ?? "", /boom/);
    assert.match(f.args ?? "", /p2/);
  } finally {
    setClientForTests(null);
  }
}, 30_000);

test("journal: a process that dies mid-write leaves an interrupted entry with its input", async () => {
  const home = tmp();
  const script = path.join(home, "crash.mts");
  writeFileSync(
    script,
    `process.env.NOTION_PLUS_HOME = ${JSON.stringify(home)};\nprocess.env.NOTION_PLUS_WORKSPACE = "test";\n` +
      `const { runJournaled } = await import(${JSON.stringify(path.join(root, "src/services/journal.ts"))});\n` +
      `const { call } = await import(${JSON.stringify(path.join(root, "src/services/notion.ts"))});\n` +
      `await runJournaled("notion_bulk_update", { database: "db-crash" }, async () => { await call(async () => process.exit(9)); return { content: [] }; });\n`
  );
  await assert.rejects(run(tsx, [script]), (e: unknown) => (e as { code?: number }).code === 9);
  const saved = process.env.NOTION_PLUS_HOME;
  process.env.NOTION_PLUS_HOME = home;
  try {
    const [entry] = await history(1);
    assert.equal(entry.tool, "notion_bulk_update");
    assert.equal(entry.interrupted, true);
    assert.match(entry.args ?? "", /db-crash/);
  } finally {
    process.env.NOTION_PLUS_HOME = saved;
  }
}, 60_000);

test("automation state: a corrupt file stops the run instead of reading as nothing fired", async () => {
  const f = path.join(await stateDir(), "automation-state.json");
  writeFileSync(f, '{"rules": {"weekly": {"last_fired": "2026-09-');
  await assert.rejects(loadState(), StateCorruptError);
  writeFileSync(f, JSON.stringify({ rules: { weekly: { last_fired: "2026-09-28T09:00:00.000Z" } } }));
  assert.equal((await loadState()).rules.weekly.last_fired, "2026-09-28T09:00:00.000Z");
});

test("rules: edits apply to the current file, and expected_revision refuses a stale edit", async () => {
  const file = path.join(tmp(), "rules.json");
  const rule = (id: string) => ({ id, database: "db", when: { where: { Status: "Done" } }, actions: [{ trash: true }] });
  const r1 = await editRules((d) => void d.rules.push(rule("a") as never), { file });
  // Someone else adds a rule; an edit without a revision still keeps it.
  await editRules((d) => void d.rules.push(rule("b") as never), { file });
  await editRules((d) => (d.timezone = "UTC"), { file });
  assert.deepEqual((await loadRulesWithRevision(file)).data.rules.map((r) => r.id), ["a", "b"]);
  // An edit based on the first revision is refused.
  await assert.rejects(editRules((d) => void d.rules.splice(0, 1), { file, expectedRevision: r1 }), RulesConflictError);
  const cur = await loadRulesWithRevision(file);
  await editRules((d) => void d.rules.splice(0, 1), { file, expectedRevision: cur.revision ?? undefined });
  assert.deepEqual((await loadRulesWithRevision(file)).data.rules.map((r) => r.id), ["b"]);
});

test("updateJson under a lock serializes writers in one process too", async () => {
  const f = path.join(tmp(), "c.json");
  await Promise.all(Array.from({ length: 20 }, () => updateJson(f, asObject, () => ({ n: 0 }), (d) => ({ data: { n: d.n + 1 }, result: null }))));
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { n: 20 });
});
