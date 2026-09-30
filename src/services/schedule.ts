// Schedules for automation rules: 5-field cron or friendly forms, evaluated in the rules file's time zone.
// The runner is polled (hourly in GitHub Actions), so a schedule fires on the first run at or after each occurrence.

const DOW: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/** Friendly schedule → cron. Accepts cron as-is. */
export function toCron(input: string): string {
  const s = input.trim().toLowerCase().replace(/\s+/g, " ");
  const time = (t: string | undefined): [number, number] => {
    const m = (t ?? "00:00").match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (!m) throw new Error(`"${t}" isn't a time. Use 24-hour HH:MM (09:00) or 9am.`);
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    if (h > 23 || min > 59) throw new Error(`"${t}" isn't a valid time.`);
    return [h, min];
  };
  let m: RegExpMatchArray | null;
  if (s === "hourly") return "0 * * * *";
  if ((m = s.match(/^(daily|every day)(?: at)?(?: (\S+))?$/))) {
    const [h, min] = time(m[2]);
    return `${min} ${h} * * *`;
  }
  if ((m = s.match(/^(weekdays|every weekday)(?: at)?(?: (\S+))?$/))) {
    const [h, min] = time(m[2]);
    return `${min} ${h} * * 1-5`;
  }
  if ((m = s.match(/^(?:weekly|every) (sun|mon|tue|wed|thu|fri|sat)[a-z]*(?: at)?(?: (\S+))?$/))) {
    const [h, min] = time(m[2]);
    return `${min} ${h} * * ${DOW[m[1]]}`;
  }
  if ((m = s.match(/^monthly(?: on)?(?: (?:day )?(\d{1,2}))?(?: at)?(?: (\S+))?$/))) {
    const day = Number(m[1] ?? 1);
    if (day < 1 || day > 28) throw new Error("Monthly schedules take a day from 1 to 28 (every month has those).");
    const [h, min] = time(m[2]);
    return `${min} ${h} ${day} * *`;
  }
  if (s.split(" ").length === 5) {
    parseCron(s); // validates
    return s;
  }
  throw new Error(
    `Can't read schedule "${input}". Use "hourly", "daily 09:00", "weekdays 09:00", "weekly mon 09:00", "monthly 1 09:00", or 5-field cron ("0 9 * * 1-5").`
  );
}

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

function field(expr: string, min: number, max: number, names?: Record<string, number>): Set<number> {
  const out = new Set<number>();
  for (const part of expr.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step in "${part}".`);
    const val = (v: string) => {
      const n = names?.[v.toLowerCase()] ?? Number(v);
      if (!Number.isInteger(n) || n < min || n > (max === 6 ? 7 : max)) throw new Error(`"${v}" is out of range ${min}-${max}.`);
      return max === 6 && n === 7 ? 0 : n;
    };
    let lo: number;
    let hi: number;
    if (range === "*") [lo, hi] = [min, max];
    else if (range.includes("-")) [lo, hi] = range.split("-").map(val) as [number, number];
    else [lo, hi] = [val(range), stepRaw === undefined ? val(range) : max];
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron needs 5 fields (minute hour day-of-month month day-of-week); got "${expr}".`);
  const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  return {
    minute: field(parts[0], 0, 59),
    hour: field(parts[1], 0, 23),
    dom: field(parts[2], 1, 31),
    month: field(parts[3], 1, 12, MON),
    dow: field(parts[4], 0, 6, DOW),
    domAny: parts[2] === "*",
    dowAny: parts[4] === "*",
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock fields of an instant in a time zone. */
function wall(d: Date, tz: string): { minute: number; hour: number; dom: number; month: number; dow: number } {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short" });
    formatters.set(tz, f);
  }
  const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  return { minute: Number(parts.minute), hour: Number(parts.hour), dom: Number(parts.day), month: Number(parts.month), dow: DOW[String(parts.weekday).toLowerCase().slice(0, 3)] };
}

function matches(c: CronFields, d: Date, tz: string): boolean {
  const w = wall(d, tz);
  if (!c.minute.has(w.minute) || !c.hour.has(w.hour) || !c.month.has(w.month)) return false;
  // Standard cron: when both day fields are restricted, either may match.
  const domOk = c.dom.has(w.dom);
  const dowOk = c.dow.has(w.dow);
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowOk;
  if (c.dowAny) return domOk;
  return domOk || dowOk;
}

const MINUTE = 60_000;
const SEARCH_LIMIT = 62 * 24 * 60; // two months of minutes

/** The latest scheduled minute at or before `now`, or null if none in the last two months. */
export function previousOccurrence(cron: string, now: Date, tz: string): Date | null {
  const c = parseCron(cron);
  const start = Math.floor(now.getTime() / MINUTE) * MINUTE;
  for (let i = 0; i < SEARCH_LIMIT; i++) {
    const d = new Date(start - i * MINUTE);
    if (matches(c, d, tz)) return d;
  }
  return null;
}

/** The next scheduled minute after `now`. */
export function nextOccurrence(cron: string, now: Date, tz: string): Date | null {
  const c = parseCron(cron);
  const start = Math.floor(now.getTime() / MINUTE) * MINUTE + MINUTE;
  for (let i = 0; i < SEARCH_LIMIT; i++) {
    const d = new Date(start + i * MINUTE);
    if (matches(c, d, tz)) return d;
  }
  return null;
}

/**
 * Whether a schedule is due: its latest occurrence hasn't fired yet. With no record of a previous firing,
 * it fires only if that occurrence is recent (within `catchUpMs`), so a new or restored rule doesn't fire
 * for an occurrence long past.
 */
export function isDue(schedule: string, now: Date, tz: string, lastFired: string | undefined, catchUpMs: number): { due: boolean; occurrence: Date | null } {
  const occurrence = previousOccurrence(toCron(schedule), now, tz);
  if (!occurrence) return { due: false, occurrence };
  if (lastFired) return { due: occurrence.getTime() > new Date(lastFired).getTime(), occurrence };
  return { due: now.getTime() - occurrence.getTime() <= catchUpMs, occurrence };
}
