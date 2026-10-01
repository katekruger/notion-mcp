// Telling someone a run failed: a Slack incoming webhook, an HTTP endpoint (JSON {text, …}), or a Notion comment.
// Notifying is best effort: a failure to notify is logged, never turned into a second failure.
import { log } from "../log.js";
import { redact, resolve } from "./refs.js";
import { runAction } from "./actions.js";

export type Sink = { slack: string } | { http: string } | { comment: string };

export async function notify(sinks: Sink[], text: string, details: Record<string, unknown> = {}): Promise<{ sent: number; failed: string[] }> {
  const failed: string[] = [];
  let sent = 0;
  const message = redact(text);
  for (const sink of sinks) {
    try {
      const s = resolve(sink, {}) as Sink;
      const r = { undo: [], startedAt: new Date().toISOString(), resumed: false, key: `notify:${Date.now()}` };
      if ("slack" in s) await runAction({ slack: { webhook: s.slack, text: message } }, r);
      else if ("http" in s) await runAction({ http: { url: s.http, method: "POST", body: { text: message, ...redact(details) } } }, r);
      else await runAction({ comment: { page: s.comment, text: message } }, r);
      sent++;
    } catch (e) {
      const why = redact((e as Error).message);
      failed.push(why);
      log("warn", "notify.failed", { sink: Object.keys(sink)[0], error: why });
    }
  }
  return { sent, failed };
}

/** Sinks from NOTION_PLUS_NOTIFY (comma-separated: slack:SECRET_NAME, http:https://…, comment:<page>) for automation runs. */
export function envSinks(): Sink[] {
  return (process.env.NOTION_PLUS_NOTIFY ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .flatMap((x): Sink[] => {
      const [kind, ...rest] = x.split(":");
      const value = rest.join(":");
      if (kind === "slack") return [{ slack: `\${secret:${value}}` }];
      if (kind === "http") return [{ http: value }];
      if (kind === "comment") return [{ comment: value }];
      log("warn", "notify.unknown_sink", { sink: x });
      return [];
    });
}
