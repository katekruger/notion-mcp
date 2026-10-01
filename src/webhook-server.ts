#!/usr/bin/env node
// Webhook mode: npm run webhook. Receives Notion webhook deliveries on POST /notion/webhook, queues them durably, and
// runs a worker that starts matching workflows and resumes waiting runs. GET /healthz reports the queue.
// Run it behind HTTPS (a reverse proxy, a tunnel, or a platform that terminates TLS): Notion only delivers to https URLs.
import http from "node:http";
import { config, redactedSummary } from "./config.js";
import { log } from "./services/log.js";
import { listEvents, processQueue, receive } from "./services/webhooks.js";
import { tick } from "./services/workflow/engine.js";

const MAX_BODY = 1024 * 1024;

export function createWebhookServer(opts: { token?: string } = {}): http.Server {
  return http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/healthz") {
      void listEvents().then(
        (events) => send(200, { ok: true, queued: events.filter((e) => e.status === "queued").length, dead: events.filter((e) => e.status === "dead").length }),
        (e: Error) => send(500, { ok: false, error: e.message })
      );
      return;
    }
    if (req.method !== "POST" || req.url !== "/notion/webhook") return send(404, { error: "not found" });
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        send(413, { error: "body too large" });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (size > MAX_BODY) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
      receive(raw, headers, opts.token ?? config().NOTION_PLUS_WEBHOOK_TOKEN).then(
        (v) => {
          if (!v.ok) {
            log("warn", "webhook.rejected", { status: v.status, reason: v.reason });
            return send(v.status, { error: v.reason });
          }
          if ("verification_token" in v) return send(200, { ok: true, note: "Verification token logged; paste it into Notion and set NOTION_PLUS_WEBHOOK_TOKEN." });
          send(202, v);
        },
        (e: Error) => {
          log("error", "webhook.receive_failed", { error: e.message });
          send(500, { error: "couldn't queue the event; Notion will retry" });
        }
      );
    });
  });
}

async function main(): Promise<void> {
  const cfg = config();
  log("info", "webhook.config", redactedSummary(cfg));
  if (!cfg.NOTION_PLUS_WEBHOOK_TOKEN) log("warn", "webhook.no_token", { note: "Deliveries are rejected until NOTION_PLUS_WEBHOOK_TOKEN is set (the first verification request still works)." });
  const port = Number(cfg.NOTION_PLUS_WEBHOOK_PORT ?? process.env.PORT ?? 8787);
  createWebhookServer().listen(port, () => log("info", "webhook.listening", { port, path: "/notion/webhook" }));
  // Worker: queued events every 5 s; waiting runs and schedules every minute (the polling fallback).
  let busy = false;
  const loop = async (fn: () => Promise<unknown>, name: string) => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      log("error", `webhook.${name}_failed`, { error: (e as Error).message });
    } finally {
      busy = false;
    }
  };
  setInterval(() => void loop(() => processQueue(), "queue"), 5_000);
  setInterval(() => void loop(() => tick(), "tick"), 60_000);
}

if (process.argv[1] && /webhook-server\.(js|ts)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(`Error: ${(e as Error).message}`);
    process.exit(1);
  });
}
