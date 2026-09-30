// Offline checks for the automations engine: rules validation, templates, conditions, self-clearing.
import { test } from "vitest";
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

// ---------- Phase 5: schedules, then-actions, smarter self-clearing ----------
import { isDue, nextOccurrence, previousOccurrence, toCron } from "../src/services/schedule.js";
import { runRule, stillMatches } from "../src/services/automations.js";

test("schedules: friendly forms become cron; bad ones explain themselves", () => {
  assert.equal(toCron("weekdays 09:00"), "0 9 * * 1-5");
  assert.equal(toCron("every weekday at 9am"), "0 9 * * 1-5");
  assert.equal(toCron("daily 18:30"), "30 18 * * *");
  assert.equal(toCron("weekly Friday 5pm"), "0 17 * * 5");
  assert.equal(toCron("monthly 15 08:00"), "0 8 15 * *");
  assert.equal(toCron("hourly"), "0 * * * *");
  assert.equal(toCron("*/15 9-17 * * mon-fri"), "*/15 9-17 * * mon-fri");
  assert.throws(() => toCron("sometimes"), /Can't read schedule/);
  assert.throws(() => toCron("daily 25:00"), /isn't a valid time/);
  assert.throws(() => toCron("61 * * * *"), /out of range/);
  assert.throws(() => toCron("monthly 31"), /1 to 28/);
});

test("schedules: occurrences follow the rules file's time zone, including DST", () => {
  const tz = "America/New_York";
  // Wednesday 2026-09-30 09:17 EDT.
  const now = new Date("2026-09-30T13:17:00Z");
  assert.equal(previousOccurrence("0 9 * * 1-5", now, tz)?.toISOString(), "2026-09-30T13:00:00.000Z");
  assert.equal(nextOccurrence("0 9 * * 1-5", now, tz)?.toISOString(), "2026-10-01T13:00:00.000Z");
  // Friday 2026-10-30 → next weekday 9am is Monday 2026-11-02, after DST ends (EST, UTC-5).
  assert.equal(nextOccurrence("0 9 * * 1-5", new Date("2026-10-30T14:00:00Z"), tz)?.toISOString(), "2026-11-02T14:00:00.000Z");
});

test("schedules: a due occurrence fires once; unknown history only catches up recent occurrences", () => {
  const tz = "UTC";
  const window = 70 * 60_000;
  const at917 = new Date("2026-09-30T09:17:00Z");
  assert.equal(isDue("daily 09:00", at917, tz, undefined, window).due, true);
  assert.equal(isDue("daily 09:00", at917, tz, "2026-09-30T09:00:00.000Z", window).due, false);
  assert.equal(isDue("daily 09:00", at917, tz, "2026-09-29T09:00:00.000Z", window).due, true);
  // New rule at 15:00: today's 09:00 is too old to catch up.
  assert.equal(isDue("daily 09:00", new Date("2026-09-30T15:00:00Z"), tz, undefined, window).due, false);
});

test("stillMatches understands operators, empties, and templates", () => {
  assert.equal(stillMatches({ not_in: ["Done", "At Risk"] }, "At Risk"), false);
  assert.equal(stillMatches({ not_in: ["Done"] }, "Blocked"), true);
  assert.equal(stillMatches({ in: ["Todo", "Doing"] }, "Done"), false);
  assert.equal(stillMatches({ "!=": "Done" }, "done"), false);
  assert.equal(stillMatches(null, "{{today}}"), false);
  assert.equal(stillMatches({ is_empty: true }, "2026-10-01"), false);
  assert.equal(stillMatches({ before: "today" }, "2026-10-01"), null);
  assert.equal(stillMatches("Done", "Done"), true);
});

test("self-clearing: operator conditions count when the new value falls outside them", () => {
  const atRisk = rule({
    schedule: "weekdays 09:00",
    when: { where: { Status: { not_in: ["Done", "At Risk"] }, "Completed Date": { before: "today" } } },
    actions: [{ set: { Status: "At Risk" } }, { comment: "Past due" }],
  });
  assert.equal(selfClearingProblem(ds, atRisk), null);
  const loops = rule({ when: { where: { Status: { not_in: ["Done"] } } }, actions: [{ set: { Status: "Blocked" } }] });
  assert.match(selfClearingProblem(ds, loops) ?? "", /every run/);
});

test("rule schema: schedules, then-actions, and the combinations that would misfire", () => {
  const scheduleOnly = ruleSchema.parse({ id: "weekly-report", schedule: "weekly mon 08:00", then: [{ create_page: { parent: "3ea4c9c1e28b809c9a5dc0d2d61ff8d7", title: "Week of {{today}}" } }] });
  assert.equal(scheduleOnly.actions.length, 0);
  assert.throws(() => ruleSchema.parse({ id: "x", then: [{ refresh_chart: "b" }] }), /`when` condition, a `schedule`/);
  assert.throws(() => ruleSchema.parse({ id: "x", schedule: "daily", actions: [{ trash: true }] }), /need a `when`/);
  assert.throws(() => ruleSchema.parse({ id: "x", database: "d", when: { where: { a: 1 } }, then: [{ refresh_chart: "b" }] }), /add a `schedule`/);
  assert.throws(() => ruleSchema.parse({ id: "x", when: { where: { a: 1 } }, actions: [{ trash: true }] }), /needs `database`/);
  assert.throws(() => ruleSchema.parse({ id: "x", schedule: "nope", then: [{ refresh_chart: "b" }] }), /Can't read schedule/);
});

test("runRule: a schedule that isn't due is skipped without touching Notion; dry runs describe then-actions", async () => {
  const r = ruleSchema.parse({ id: "weekly", schedule: "weekly mon 08:00", then: [{ create_page: { parent: "3ea4c9c1e28b809c9a5dc0d2d61ff8d7", title: "Week of {{today}}" } }] });
  const wed = new Date("2026-09-30T12:00:00Z");
  const skipped = await runRule(r, "UTC", { dryRun: true, now: wed });
  assert.match(skipped.skipped ?? "", /not due/);
  assert.equal(skipped.next_run, "2026-10-05T08:00:00.000Z");
  const forced = await runRule(r, "UTC", { dryRun: true, now: wed, force: true });
  assert.equal(forced.skipped, undefined);
  assert.deepEqual(forced.then, [{ action: 'create page "Week of 2026-09-30"' }]);
});
