// Property tests: parsers and schedules hold their promises for generated inputs, not just the examples.
import { test } from "vitest";
import assert from "node:assert/strict";
import fc from "fast-check";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCsv } from "../src/services/csv.js";
import { markdownToSpecs } from "../src/services/markdown.js";
import { nextOccurrence, previousOccurrence, toCron } from "../src/services/schedule.js";
import { readJson, StateCorruptError } from "../src/services/store.js";

const quote = (v: string) => (/[",\r\n]/.test(v) || v === "" ? `"${v.replace(/"/g, '""')}"` : v);

test("CSV: any table written with RFC 4180 quoting parses back to the same (trimmed) values", () => {
  const header = fc.string({ minLength: 1, maxLength: 8 }).map((h) => h.trim()).filter((h) => h.length > 0 && !h.startsWith("\uFEFF"));
  fc.assert(
    fc.property(
      fc.uniqueArray(header, { minLength: 1, maxLength: 4 }).chain((headers) =>
        fc.tuple(
          fc.constant(headers),
          // Rows that are entirely blank are skipped by design, so every generated row has a visible value.
          fc.array(fc.array(fc.string({ maxLength: 12 }), { minLength: headers.length, maxLength: headers.length }).filter((r) => r.some((c) => c.trim() !== "")), { minLength: 1, maxLength: 5 })
        )
      ),
      ([headers, rows]) => {
        const text = [headers.map(quote).join(","), ...rows.map((r) => r.map(quote).join(","))].join("\r\n");
        const parsed = parseCsv(text);
        assert.equal(parsed.length, rows.length);
        parsed.forEach((p, i) => headers.forEach((h, j) => assert.equal(p[h], rows[i][j].trim())));
      }
    ),
    { numRuns: 200 }
  );
});

test("markdown: arbitrary text becomes blocks or a clear Error, never a crash", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 400 }), fc.array(fc.constantFrom("# ", "- ", "1. ", "> ", "```", "| a | b |", "$$", "<details>", "</details>", "\n", "  "), { maxLength: 12 }), (text, bits) => {
      const md = bits.join("") + text;
      try {
        const specs = markdownToSpecs(md);
        assert.ok(Array.isArray(specs));
      } catch (e) {
        assert.ok(e instanceof Error && !(e instanceof TypeError) && !(e instanceof RangeError), String(e));
      }
    }),
    { numRuns: 300 }
  );
});

test("schedules: the previous occurrence is never after now, and the next is always after it", () => {
  const schedules = ["hourly", "daily 09:00", "weekdays 09:00", "weekly mon 08:30", "monthly 1 07:00", "*/15 * * * *"];
  const zones = ["UTC", "America/New_York", "Europe/Berlin", "Australia/Sydney"];
  fc.assert(
    fc.property(fc.constantFrom(...schedules), fc.constantFrom(...zones), fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) }), (s, tz, t) => {
      const cron = toCron(s);
      const now = new Date(t);
      const prev = previousOccurrence(cron, now, tz);
      const next = nextOccurrence(cron, now, tz);
      assert.ok(prev && prev.getTime() <= now.getTime(), `${s} ${tz} prev ${prev?.toISOString()} > ${now.toISOString()}`);
      assert.ok(next && next.getTime() > now.getTime(), `${s} ${tz} next ${next?.toISOString()} <= ${now.toISOString()}`);
      // Nothing scheduled falls strictly between them.
      const between = previousOccurrence(cron, new Date(next.getTime() - 1), tz);
      assert.equal(between?.getTime(), prev.getTime());
    }),
    { numRuns: 60 }
  );
}, 120_000);

test("state files: non-empty garbage is never read as empty state", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "notion-plus-prop-"));
  const f = path.join(dir, "state.json");
  const parse = (raw: unknown) => {
    const o = raw as { rules?: unknown } | null;
    if (!o || typeof o !== "object" || Array.isArray(o) || typeof o.rules !== "object" || o.rules === null) throw new Error("bad shape");
    return o;
  };
  await fc.assert(
    fc.asyncProperty(
      fc.oneof(fc.string({ minLength: 1 }), fc.json().filter((j) => !/^\{"rules":\{/.test(j.replace(/\s/g, "")))),
      async (content) => {
        writeFileSync(f, content);
        await assert.rejects(readJson(f, parse, () => ({ rules: {} })), StateCorruptError);
      }
    ),
    { numRuns: 200 }
  );
});
