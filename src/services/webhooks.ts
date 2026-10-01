// Notion webhooks, received durably. An event is accepted only with a valid signature (HMAC-SHA256 of the raw body
// with the subscription's verification token, in X-Notion-Signature), only once (by event id), and only if it's
// recent (older than 10 minutes, or from the future, is treated as a replay). Accepted events go into a queue on
// disk and are acknowledged at once; a worker starts the matching workflows, retrying with backoff, and moves an
// event that keeps failing to the dead-letter list, where it can be replayed or discarded.
import path from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readJson, updateJson } from "./store.js";
import { stateDir } from "./workspace.js";
import { log } from "./log.js";
import { startFromEvent, type NotionEvent } from "./workflow/engine.js";

export const REPLAY_WINDOW_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
const SEEN_TTL_MS = 7 * 24 * 3_600_000;

export interface QueuedEvent {
  event: NotionEvent;
  received: string;
  status: "queued" | "done" | "dead";
  attempts: number;
  next_at: string;
  error?: string;
  runs?: string[];
}

interface QueueFile {
  events: Record<string, QueuedEvent>;
  /** Event ids already accepted, with when; kept for a week so redeliveries are ignored. */
  seen: Record<string, string>;
}

const parseQueue = (raw: unknown): QueueFile => {
  const o = raw as Partial<QueueFile> | null;
  if (!o || typeof o !== "object" || typeof o.events !== "object" || o.events === null) throw new Error('expected {"events": {...}}');
  return { events: o.events, seen: o.seen ?? {} };
};
const emptyQueue = (): QueueFile => ({ events: {}, seen: {} });
const queueFile = async () => path.join(await stateDir(), "webhook-queue.json");

export type Verdict =
  | { ok: true; queued: string }
  | { ok: true; duplicate: string }
  | { ok: true; verification_token: string }
  | { ok: false; status: number; reason: string };

export function signatureValid(rawBody: string, header: string | undefined, token: string): boolean {
  if (!header) return false;
  const expected = `sha256=${createHmac("sha256", token).update(rawBody).digest("hex")}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Check and queue one delivery. The first request of a new subscription carries a `verification_token` (and no
 * signature); it's returned so the operator can paste it into Notion and set NOTION_PLUS_WEBHOOK_TOKEN.
 */
export async function receive(rawBody: string, headers: Record<string, string | undefined>, token: string | undefined, now = new Date()): Promise<Verdict> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 400, reason: "body isn't JSON" };
  }
  if (typeof body.verification_token === "string" && Object.keys(body).length === 1) {
    log("warn", "webhook.verification_token", { note: "Paste this token into the Notion subscription to verify it, and set NOTION_PLUS_WEBHOOK_TOKEN to it." });
    return { ok: true, verification_token: body.verification_token };
  }
  if (!token) return { ok: false, status: 503, reason: "NOTION_PLUS_WEBHOOK_TOKEN isn't set, so deliveries can't be verified" };
  if (!signatureValid(rawBody, headers["x-notion-signature"], token)) return { ok: false, status: 401, reason: "bad or missing signature" };
  const event = body as unknown as NotionEvent;
  if (typeof event.id !== "string" || typeof event.type !== "string") return { ok: false, status: 400, reason: "not a Notion event (no id or type)" };
  const at = event.timestamp ? new Date(event.timestamp).getTime() : NaN;
  if (!Number.isFinite(at) || now.getTime() - at > REPLAY_WINDOW_MS || at - now.getTime() > 5 * 60_000) {
    return { ok: false, status: 400, reason: "event timestamp missing or outside the replay window" };
  }
  return updateJson<QueueFile, Verdict>(await queueFile(), parseQueue, emptyQueue, (q) => {
    if (q.seen[event.id] || q.events[event.id]) return { result: { ok: true, duplicate: event.id } };
    q.seen[event.id] = now.toISOString();
    q.events[event.id] = { event, received: now.toISOString(), status: "queued", attempts: 0, next_at: now.toISOString() };
    // Forget old ids and finished events.
    const cutoff = now.getTime() - SEEN_TTL_MS;
    q.seen = Object.fromEntries(Object.entries(q.seen).filter(([, t]) => new Date(t).getTime() > cutoff));
    q.events = Object.fromEntries(Object.entries(q.events).filter(([, e]) => e.status !== "done" || now.getTime() - new Date(e.received).getTime() < 86_400_000));
    return { data: q, result: { ok: true, queued: event.id } };
  });
}

async function setEvent(id: string, change: (e: QueuedEvent) => void): Promise<void> {
  await updateJson<QueueFile, null>(await queueFile(), parseQueue, emptyQueue, (q) => {
    if (q.events[id]) change(q.events[id]);
    return { data: q, result: null };
  });
}

/** Process due events once. `start` defaults to starting matching workflows (tests pass their own). */
export async function processQueue(now = new Date(), start: (e: NotionEvent) => Promise<{ run_id: string }[]> = startFromEvent): Promise<{ done: number; retried: number; dead: number }> {
  const q = (await readJson(await queueFile(), parseQueue, emptyQueue)).data;
  const due = Object.entries(q.events).filter(([, e]) => e.status === "queued" && new Date(e.next_at).getTime() <= now.getTime());
  const counts = { done: 0, retried: 0, dead: 0 };
  for (const [id, e] of due) {
    try {
      const runs = await start(e.event);
      await setEvent(id, (x) => {
        x.status = "done";
        x.attempts++;
        x.runs = runs.map((r) => r.run_id);
        delete x.error;
      });
      counts.done++;
    } catch (err) {
      const attempts = e.attempts + 1;
      const dead = attempts >= MAX_ATTEMPTS;
      await setEvent(id, (x) => {
        x.attempts = attempts;
        x.error = (err as Error).message.slice(0, 500);
        x.status = dead ? "dead" : "queued";
        x.next_at = new Date(now.getTime() + 60_000 * 2 ** (attempts - 1)).toISOString();
      });
      log(dead ? "error" : "warn", dead ? "webhook.dead_letter" : "webhook.retry", { event: id, attempts, error: (err as Error).message });
      if (dead) counts.dead++;
      else counts.retried++;
    }
  }
  return counts;
}

export async function listEvents(status?: QueuedEvent["status"]): Promise<(QueuedEvent & { id: string })[]> {
  const q = (await readJson(await queueFile(), parseQueue, emptyQueue)).data;
  return Object.entries(q.events)
    .filter(([, e]) => !status || e.status === status)
    .map(([id, e]) => ({ id, ...e }))
    .sort((a, b) => b.received.localeCompare(a.received));
}

/** Put a dead (or done) event back in the queue. */
export async function replayEvent(id: string, now = new Date()): Promise<void> {
  let found = false;
  await setEvent(id, (e) => {
    found = true;
    e.status = "queued";
    e.attempts = 0;
    e.next_at = now.toISOString();
    delete e.error;
  });
  if (!found) throw new Error(`No queued event "${id}".`);
}

/** Drop an event from the queue (it stays in `seen`, so a redelivery is still ignored). */
export async function discardEvent(id: string): Promise<boolean> {
  return updateJson<QueueFile, boolean>(await queueFile(), parseQueue, emptyQueue, (q) =>
    q.events[id] ? { data: { ...q, events: Object.fromEntries(Object.entries(q.events).filter(([k]) => k !== id)) }, result: true } : { result: false }
  );
}
