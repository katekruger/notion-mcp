// Offline checks for the automations engine: rules validation, templates, conditions, self-clearing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DataSourceObjectResponse, PageObjectResponse } from "@notionhq/client";
import { isoDate, loadRules, relativeFilters, render, ruleSchema, selfClearingProblem } from "../src/services/automations.js";

const ds = {
  id: "ds",
  title: [],
  properties: {
    Name: { id: "t", name: "Name", type: "title", title: {} },
    Status: { id: "s", name: "Status", type: "status", status: { options: [], groups: [] } },
    "Completed Date": { id: "c", name: "Completed Date", type: "date", date: {} },
    Done: { id: "d", name: "Done", type: "checkbox", checkbox: {} },
    Edited: { id: "e", name: "Edited", type: "last_edited_time", last_edited_time: {} },
    Points: { id: "p", name: "Points", type: "number", number: {} },
  },
} as unknown as DataSourceObjectResponse;

const rule = (extra: Record<string, unknown>) => ruleSchema.parse({ id: "r", database: "db", ...extra });

test("isoDate uses the rule file's time zone", () => {
  const t = new Date("2026-10-01T02:00:00Z");
  assert.equal(isoDate(t, "UTC"), "2026-10-01");
  assert.equal(isoDate(t, "America/New_York"), "2026-09-30");
});

test("render fills templates everywhere and rejects unknown ones", () => {
  const page = {
    id: "pid",
    url: "https://notion.so/pid",
    properties: { Name: { type: "title", title: [{ plain_text: "Launch" }] }, Tags: { type: "multi_select", multi_select: [{ name: "A" }, { name: "B" }] } },
  } as unknown as PageObjectResponse;
  const out = render({ a: "{{today}}", b: ["{{ page.Name }} {{page.Tags}}", 3], c: "{{page.url}}" }, { now: new Date("2026-10-01T12:00:00Z"), timezone: "UTC", page });
  assert.deepEqual(out, { a: "2026-10-01", b: ["Launch A, B", 3], c: "https://notion.so/pid" });
  assert.throws(() => render("{{tomorrow}}", { now: new Date(), timezone: "UTC" }), /Unknown template/);
  assert.throws(() => render("{{page.Nope}}", { now: new Date(), timezone: "UTC", page }), /no property/);
});

test("relative conditions become date and timestamp filters", () => {
  const now = new Date("2026-10-31T00:00:00Z");
  const f = relativeFilters(ds, [
    { property: "completed date", older_than_days: 30 },
    { property: "$last_edited", newer_than_days: 1 },
    { property: "Edited", older_than_days: 7 },
  ], now);
  assert.deepEqual(f[0], { property: "Completed Date", date: { before: "2026-10-01T00:00:00.000Z" } });
  assert.deepEqual(f[1], { timestamp: "last_edited_time", last_edited_time: { on_or_after: "2026-10-30T00:00:00.000Z" } });
  assert.deepEqual(f[2], { timestamp: "last_edited_time", last_edited_time: { before: "2026-10-24T00:00:00.000Z" } });
  assert.throws(() => relativeFilters(ds, [{ property: "Points", older_than_days: 1 }], now), /relative conditions need/);
});

test("rules must stop matching after they act", () => {
  // Classic stamp: condition checks Completed Date is empty, action fills it.
  assert.equal(selfClearingProblem(ds, rule({ when: { where: { Status: "Done", "Completed Date": null } }, actions: [{ set: { "Completed Date": "{{today}}" } }] })), null);
  // Status changes to a different value: clears.
  assert.equal(selfClearingProblem(ds, rule({ when: { where: { Status: "Not started" } }, actions: [{ set: { Status: "In progress" } }] })), null);
  // Setting the same value it matched on: loops.
  assert.match(selfClearingProblem(ds, rule({ when: { where: { Status: "Done" } }, actions: [{ set: { Status: "done" } }] })) ?? "", /every run/);
  // Comment only: loops unless a marker is used.
  const commentOnly = { when: { where: { Status: "Done" } }, actions: [{ comment: "hi" }] };
  assert.match(selfClearingProblem(ds, rule(commentOnly)) ?? "", /marker/);
  assert.equal(selfClearingProblem(ds, rule({ ...commentOnly, marker: "Done" })), null);
  // Trash always clears; raw filter properties count as checked.
  assert.equal(selfClearingProblem(ds, rule({ when: { where: { Status: "Done" } }, actions: [{ trash: true }] })), null);
  assert.equal(selfClearingProblem(ds, rule({ when: { filter: { property: "Points", number: { is_empty: true } } }, actions: [{ set: { Points: 0 } }] })), null);
});

test("rule schema rejects empty conditions, bad ids, and unknown actions", () => {
  assert.throws(() => rule({ when: {}, actions: [{ trash: true }] }), /at least one condition/);
  assert.throws(() => ruleSchema.parse({ id: "Bad Id", database: "d", when: { where: { a: 1 } }, actions: [{ trash: true }] }), /lowercase/);
  assert.throws(() => rule({ when: { where: { a: 1 } }, actions: [{ archive: true }] }));
  assert.equal(rule({ when: { where: { a: 1 } }, actions: [{ trash: true }] }).limit, 50);
});

test("loadRules: missing file is empty, bad files explain themselves", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rules-"));
  assert.deepEqual((await loadRules(path.join(dir, "none.json"))).rules, []);
  const bad = path.join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ version: 1, timezone: "Mars/Olympus", rules: [] }));
  await assert.rejects(loadRules(bad), /time zone/);
  const dup = path.join(dir, "dup.json");
  const r = { id: "x", database: "d", when: { where: { a: 1 } }, actions: [{ trash: true }] };
  writeFileSync(dup, JSON.stringify({ version: 1, rules: [r, r] }));
  await assert.rejects(loadRules(dup), /duplicate/);
});
