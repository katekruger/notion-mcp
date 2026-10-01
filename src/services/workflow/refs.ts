// ${…} references in workflow steps, and secrets. A reference reads the run's context: ${trigger.*} (the event or
// schedule that started it), ${inputs.*}, ${steps.<id>.*} (earlier outputs), ${item} / ${<as>} inside foreach,
// ${today}, ${now}. ${secret:NAME} reads the environment variable NOTION_PLUS_SECRET_NAME. Secret values never
// reach logs, run records, or tool results: redact() replaces them everywhere output is stored.

export type Context = Record<string, unknown>;

const REF = /\$\{\s*([^}]+?)\s*\}/g;

export class RefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefError";
  }
}

/** Values of every secret read during this process, for redaction. */
const secretValues = new Set<string>();

export function secret(name: string): string {
  if (!/^[A-Z0-9_]+$/i.test(name)) throw new RefError(`"${name}" isn't a secret name (letters, digits, _).`);
  const v = process.env[`NOTION_PLUS_SECRET_${name.toUpperCase()}`];
  if (v === undefined || v === "") throw new RefError(`Secret "${name}" isn't set. Add NOTION_PLUS_SECRET_${name.toUpperCase()} to the server's environment.`);
  if (v.length >= 4) secretValues.add(v);
  return v;
}

/** Replace any secret value (read so far) in a value about to be stored or shown. */
export function redact<T>(value: T): T {
  if (!secretValues.size) return value;
  const text = JSON.stringify(value);
  if (text === undefined) return value;
  let out = text;
  for (const s of secretValues) out = out.split(JSON.stringify(s).slice(1, -1)).join("***");
  return out === text ? value : (JSON.parse(out) as T);
}

export function lookup(ctx: Context, path: string): unknown {
  let cur: unknown = ctx;
  for (const key of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(key)) cur = cur[Number(key)];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[key];
    else if (key === "length" && typeof cur === "string") cur = cur.length;
    else return undefined;
  }
  return cur;
}

function value(expr: string, ctx: Context): unknown {
  const s = expr.match(/^secret:(.+)$/);
  if (s) return secret(s[1].trim());
  const v = lookup(ctx, expr);
  if (v === undefined) throw new RefError(`\${${expr}} has no value here.`);
  return v;
}

/**
 * Resolve references in a value. A string that is exactly one reference becomes the referenced value itself (a list,
 * an object, a number); references inside longer strings are written as text.
 */
export function resolve(v: unknown, ctx: Context): unknown {
  if (typeof v === "string") {
    const whole = v.match(/^\$\{\s*([^}]+?)\s*\}$/);
    if (whole) return value(whole[1], ctx);
    return v.replace(REF, (_, e: string) => {
      const x = value(e, ctx);
      return typeof x === "object" && x !== null ? JSON.stringify(x) : String(x);
    });
  }
  if (Array.isArray(v)) return v.map((x) => resolve(x, ctx));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, ctx)]));
  return v;
}

/** A reference used as a condition: true when set and not empty/false/0. Missing references are false. */
export function truthy(expr: string, ctx: Context): boolean {
  let v: unknown;
  try {
    v = resolve(expr, ctx);
  } catch (e) {
    if (e instanceof RefError && !/Secret/.test(e.message)) return false;
    throw e;
  }
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== 0 && v !== "" && v !== "false";
}
