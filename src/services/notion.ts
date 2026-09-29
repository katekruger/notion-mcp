import { Client, isNotionClientError, APIErrorCode } from "@notionhq/client";

let client: Client | null = null;

export function notion(): Client {
  if (client) return client;
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    throw new Error(
      "NOTION_TOKEN is not set. Create an internal integration at https://www.notion.so/profile/integrations, " +
        "copy its secret, and add it to the env block of this server in your Claude config."
    );
  }
  // The official client already retries 429s and 5xx with backoff.
  client = new Client({ auth: token, retry: { maxRetries: 4 } });
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

export async function call<T>(fn: () => Promise<T>): Promise<T> {
  const slot = queue.then(async () => {
    const wait = Math.max(0, lastCall + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
  });
  queue = slot.catch(() => undefined);
  await slot;
  return fn();
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
