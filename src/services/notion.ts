import { Client, isNotionClientError, APIErrorCode, LogLevel, RequestTimeoutError } from "@notionhq/client";

let client: Client | null = null;

/** Per-request timeout. Long enough for large appends, short enough that a hung call surfaces. */
export const REQUEST_TIMEOUT_MS = Number(process.env.NOTION_TIMEOUT_MS ?? 30_000);

export function notion(): Client {
  if (client) return client;
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    throw new Error(
      "NOTION_TOKEN is not set. Create an internal integration at https://www.notion.so/profile/integrations, " +
        "copy its secret, and add it to the env block of this server in your Claude config."
    );
  }
  // The official client retries 429/529 (honoring Retry-After) and, for safe methods, 500/503 with backoff.
  client = new Client({ auth: token, retry: { maxRetries: 4 }, timeoutMs: REQUEST_TIMEOUT_MS,
    // Expected misses (e.g. trying an id as a data source before a database) are handled; only log real errors.
    logLevel: LogLevel.ERROR,
  });
  return client;
}

/** Replace the client (tests only), so request-shaping logic can run against a fake without a network. */
export function setClientForTests(fake: Client | null): void {
  client = fake;
}

// Notion allows roughly 3 requests/second per integration. Space calls out so
// bulk jobs don't spend their time in 429 backoff.
const MIN_INTERVAL_MS = 340;
let queue: Promise<void> = Promise.resolve();
let lastCall = 0;

export interface CallOptions {
  /**
   * The call can safely run twice (reads, or writes that set absolute values).
   * Only these are retried after a timeout or network failure, since the first attempt may have landed.
   */
  idempotent?: boolean;
}

const NETWORK_RETRIES = 2;

/** Timeouts and connection failures, where no HTTP response came back. */
export function isTransientNetworkError(error: unknown): boolean {
  if (RequestTimeoutError.isRequestTimeoutError(error)) return true;
  const e = error as { name?: string; message?: string; cause?: { code?: string } } | null;
  if (!e || typeof e !== "object") return false;
  const code = e.cause?.code ?? "";
  return (
    (e.name === "TypeError" && /fetch failed/i.test(e.message ?? "")) ||
    ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"].includes(code)
  );
}

async function slot(): Promise<void> {
  const s = queue.then(async () => {
    const wait = Math.max(0, lastCall + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
  });
  queue = s.catch(() => undefined);
  await s;
}

export async function call<T>(fn: () => Promise<T>, opts: CallOptions = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await slot();
    try {
      return await fn();
    } catch (e) {
      if (!opts.idempotent || attempt >= NETWORK_RETRIES || !isTransientNetworkError(e)) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

/** Shorthand for reads, which are always safe to retry. */
export function read<T>(fn: () => Promise<T>): Promise<T> {
  return call(fn, { idempotent: true });
}

/** Accepts a Notion URL, a dashed UUID, or a 32-char hex id. Returns a dashed UUID. */
export function normalizeId(input: string): string {
  const trimmed = input.trim();
  const dashed = trimmed.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (dashed) return dashed[0].toLowerCase();
  // For URLs, prefer the last 32-hex run in the path (ignores ?v= view ids).
  const path = trimmed.split("?")[0];
  const runs = path.match(/[0-9a-f]{32}/gi);
  const hex = runs ? runs[runs.length - 1] : null;
  if (!hex) {
    throw new Error(`Could not find a Notion id in "${input}". Pass a page/database URL or id.`);
  }
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function formatError(error: unknown): string {
  if (isNotionClientError(error)) {
    switch (error.code) {
      case APIErrorCode.ObjectNotFound:
        return (
          "Error: Not found, or not shared with this integration. In Notion, open the page or database, " +
          "click ••• → Connections, and add your integration (sharing a parent page shares everything under it)."
        );
      case APIErrorCode.Unauthorized:
        return "Error: The NOTION_TOKEN was rejected. Check that the integration secret is correct and not revoked.";
      case APIErrorCode.RestrictedResource:
        return "Error: The integration lacks the capability for this action. Enable read/update/insert content in the integration settings.";
      case APIErrorCode.RateLimited:
        return "Error: Rate limited by Notion even after retries. Wait a minute and retry with a smaller batch.";
      case APIErrorCode.ConflictError:
        return "Error: Notion reported a write conflict (someone else edited at the same moment). Re-read and retry.";
      case "notionhq_client_request_timeout":
        return `Error: Notion didn't answer within ${REQUEST_TIMEOUT_MS / 1000}s. For reads, retry; for writes, re-read first to see whether it landed.`;
      case APIErrorCode.ValidationError:
        return `Error: Notion rejected the request: ${error.message}`;
      default:
        return `Error (${error.code}): ${error.message}`;
    }
  }
  if (error instanceof Error) return `Error: ${error.message}`;
  return `Error: ${String(error)}`;
}

export function isNotFound(error: unknown): boolean {
  return (
    isNotionClientError(error) &&
    (error.code === APIErrorCode.ObjectNotFound || error.code === APIErrorCode.ValidationError)
  );
}
