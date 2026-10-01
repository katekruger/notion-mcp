// Webhook intake: signatures, duplicates and replays, the durable queue with retries and dead letters, replay and
// discard, and the HTTP server end to end. No network beyond localhost.
import { test, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";

process.env.NOTION_PLUS_LOG = "off";
process.env.NOTION_PLUS_WORKSPACE = "test";
const wh = await import("../src/services/webhooks.js");
const { createWebhookServer } = await import("../src/webhook-server.js");

const TOKEN = "secret_verification_token_123";
const sign = (body: string) => `sha256=${createHmac("sha256", TOKEN).update(body).digest("hex")}`;
const now = new Date("2026-10-01T12:00:00Z");
const event = (id: string, at = now) => JSON.stringify({ id, type: "page.created", timestamp: at.toISOString(), entity: { id: "p1", type: "page" }, data: { parent: { id: "db1" } } });

beforeEach(() => {
  process.env.NOTION_PLUS_HOME = mkdtempSync(path.join(os.tmpdir(), "notion-plus-wh-test-"));
});

test("only signed, fresh, first-time events are queued", async () => {
  const body = event("e1");
  assert.deepEqual(await wh.receive(body, { "x-notion-signature": "sha256=bad" }, TOKEN, now), { ok: false, status: 401, reason: "bad or missing signature" });
  assert.deepEqual(await wh.receive(body, {}, TOKEN, now), { ok: false, status: 401, reason: "bad or missing signature" });
  assert.deepEqual(await wh.receive(body, { "x-notion-signature": sign(body) }, TOKEN, now), { ok: true, queued: "e1" });
  assert.deepEqual(await wh.receive(body, { "x-notion-signature": sign(body) }, TOKEN, now), { ok: true, duplicate: "e1" });
  const old = event("e2", new Date(now.getTime() - 11 * 60_000));
  const r = await wh.receive(old, { "x-notion-signature": sign(old) }, TOKEN, now);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /replay window/);
  assert.deepEqual(await wh.receive(body, { "x-notion-signature": sign(body) }, undefined, now), { ok: false, status: 503, reason: "NOTION_PLUS_WEBHOOK_TOKEN isn't set, so deliveries can't be verified" });
});

test("the subscription's verification request returns its token", async () => {
  const r = await wh.receive(JSON.stringify({ verification_token: "abc" }), {}, undefined, now);
  assert.deepEqual(r, { ok: true, verification_token: "abc" });
});

test("failing events retry with backoff, then go to dead letters; replay and discard work", async () => {
  const body = event("e3");
  await wh.receive(body, { "x-notion-signature": sign(body) }, TOKEN, now);
  let calls = 0;
  const failing = async () => {
    calls++;
    throw new Error("workflow broke");
  };
  let t = now.getTime();
  for (let i = 0; i < wh.MAX_ATTEMPTS; i++) {
    await wh.processQueue(new Date(t), failing);
    t += 60 * 60_000; // past any backoff
  }
  assert.equal(calls, wh.MAX_ATTEMPTS);
  const [dead] = await wh.listEvents("dead");
  assert.equal(dead.id, "e3");
  assert.match(dead.error ?? "", /workflow broke/);
  // Not retried once dead.
  await wh.processQueue(new Date(t), failing);
  assert.equal(calls, wh.MAX_ATTEMPTS);

  await wh.replayEvent("e3", new Date(t));
  const r = await wh.processQueue(new Date(t), async () => [{ run_id: "wf-1" }]);
  assert.deepEqual(r, { done: 1, retried: 0, dead: 0 });
  assert.deepEqual((await wh.listEvents("done"))[0].runs, ["wf-1"]);
  assert.equal(await wh.discardEvent("e3"), true);
  assert.equal((await wh.listEvents()).length, 0);
  // Discarded, but still remembered: a redelivery is a duplicate.
  assert.deepEqual(await wh.receive(body, { "x-notion-signature": sign(body) }, TOKEN, now), { ok: true, duplicate: "e3" });
});

test("the server accepts a signed delivery over HTTP and rejects unsigned ones", async () => {
  const server = createWebhookServer({ token: TOKEN });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const body = JSON.stringify({ id: "e9", type: "page.created", timestamp: new Date().toISOString() });
    const good = await fetch(`http://127.0.0.1:${port}/notion/webhook`, { method: "POST", body, headers: { "x-notion-signature": sign(body), "content-type": "application/json" } });
    assert.equal(good.status, 202);
    const bad = await fetch(`http://127.0.0.1:${port}/notion/webhook`, { method: "POST", body });
    assert.equal(bad.status, 401);
    const health = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { queued: number };
    assert.equal(health.queued, 1);
    assert.equal((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status, 404);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
