// Health and capability checks: what's working, what isn't, and how to fix it. Every check runs on its own, so
// one failure (no token, say) doesn't hide the others.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { config, ConfigError, DEFAULT_NOTION_VERSION } from "../config.js";
import { isNotionClientError, APIErrorCode } from "@notionhq/client";
import { notion, read } from "../services/notion.js";
import { stateDir } from "../services/workspace.js";
import { history } from "../services/journal.js";
import { loadCharts } from "../services/chartstore.js";
import { loadRulesWithRevision, loadState, rulesInRepo, rulesPath, statePath } from "../services/automations.js";
import { MAX_COPY_ROWS } from "../services/dbcopy.js";
import { MAX_COPY_BLOCKS } from "../services/copy.js";
import { ok, READ, safe } from "./util.js";

export type CheckStatus = "ok" | "warn" | "fail" | "skipped";

export interface Check {
  check: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

async function run(name: string, fn: () => Promise<Omit<Check, "check">>): Promise<Check> {
  try {
    return { check: name, ...(await fn()) };
  } catch (e) {
    const detail = e instanceof ConfigError ? e.problems.join("; ") : (e as Error).message.split("\n")[0];
    return { check: name, status: "fail", detail, fix: fixFor(e) };
  }
}

function fixFor(e: unknown): string | undefined {
  if (e instanceof ConfigError) return "Correct the named settings in the server's env block.";
  if (isNotionClientError(e)) {
    if (e.code === APIErrorCode.Unauthorized) return "The token was rejected. Copy the integration secret again from notion.so/profile/integrations.";
    if (e.code === APIErrorCode.RestrictedResource) return "The integration lacks this capability; turn it on in the integration's Capabilities tab.";
  }
  return undefined;
}

/** Probe read-only calls that need specific capabilities. */
export async function probeCapabilities(): Promise<Record<string, "yes" | "no" | "unknown">> {
  const out: Record<string, "yes" | "no" | "unknown"> = { read_content: "unknown", read_comments: "unknown", update_content: "unknown", insert_content: "unknown" };
  const n = notion();
  let somePage: string | undefined;
  try {
    const r = await read(() => n.search({ page_size: 1, filter: { property: "object", value: "page" } } as never));
    out.read_content = "yes";
    somePage = (r.results[0] as { id?: string } | undefined)?.id;
  } catch (e) {
    out.read_content = isNotionClientError(e) && e.code === APIErrorCode.RestrictedResource ? "no" : "unknown";
  }
  if (somePage) {
    try {
      await read(() => n.comments.list({ block_id: somePage as string, page_size: 1 }));
      out.read_comments = "yes";
    } catch (e) {
      if (isNotionClientError(e) && e.code === APIErrorCode.RestrictedResource) out.read_comments = "no";
    }
  }
  // Writes can't be probed without writing; a missing capability shows up as a clear error on the first write.
  return out;
}

export async function runDoctor(opts: { online: boolean }): Promise<Check[]> {
  const checks: Check[] = [];
  let cfgOk = true;
  checks.push(
    await run("settings", async () => {
      try {
        const c = config();
        return {
          status: c.NOTION_VERSION === DEFAULT_NOTION_VERSION ? "ok" : "warn",
          detail: `API version ${c.NOTION_VERSION}, timeout ${c.NOTION_TIMEOUT_MS} ms, time zone ${c.timezone}, home ${c.home}`,
          ...(c.NOTION_VERSION !== DEFAULT_NOTION_VERSION ? { fix: `NOTION_VERSION overrides the tested ${DEFAULT_NOTION_VERSION}; remove it unless you need it.` } : {}),
        };
      } catch (e) {
        cfgOk = false;
        throw e;
      }
    })
  );
  const hasToken = cfgOk && Boolean(config().NOTION_TOKEN);
  checks.push(
    await run("token", async () => {
      if (!cfgOk) return { status: "skipped", detail: "settings are invalid" };
      if (!hasToken) return { status: "fail", detail: "NOTION_TOKEN is not set.", fix: "Create an internal integration at notion.so/profile/integrations and put its secret in NOTION_TOKEN." };
      if (!opts.online) return { status: "skipped", detail: "offline check" };
      const me = await read(() => notion().users.me({}));
      const bot = me as { name?: string; bot?: { workspace_name?: string } };
      return { status: "ok", detail: `Connected as "${bot.name ?? me.id}"${bot.bot?.workspace_name ? ` in ${bot.bot.workspace_name}` : ""}.` };
    })
  );
  checks.push(
    await run("capabilities", async () => {
      if (!hasToken || !opts.online) return { status: "skipped", detail: "needs a working token" };
      const caps = await probeCapabilities();
      const missing = Object.entries(caps).filter(([, v]) => v === "no").map(([k]) => k);
      return {
        status: missing.length ? "warn" : "ok",
        detail: Object.entries(caps).map(([k, v]) => `${k}: ${v}`).join(", "),
        ...(missing.length ? { fix: `Turn on ${missing.join(", ")} in the integration's Capabilities tab.` } : {}),
      };
    })
  );
  checks.push(
    await run("pages shared", async () => {
      if (!hasToken || !opts.online) return { status: "skipped", detail: "needs a working token" };
      const r = await read(() => notion().search({ page_size: 1 } as never));
      return r.results.length
        ? { status: "ok", detail: "The integration can see at least one page or database." }
        : { status: "warn", detail: "The integration can't see any pages yet.", fix: "In Notion, open a page → ••• → Connections → add this integration." };
    })
  );
  checks.push(
    await run("local state", async () => {
      if (!cfgOk) return { status: "skipped", detail: "settings are invalid" };
      if ((!hasToken || !opts.online) && !config().NOTION_PLUS_WORKSPACE) return { status: "skipped", detail: "needs the token (online) to find this integration's folder" };
      const dir = await stateDir();
      const probe = path.join(dir, `.doctor-${process.pid}`);
      await fs.writeFile(probe, "ok");
      await fs.rm(probe, { force: true });
      await history(1);
      await loadCharts();
      await loadState();
      return { status: "ok", detail: `${dir} is writable; journal, chart recipes, and automation state read cleanly.` };
    })
  );
  checks.push(
    await run("upload folders", async () => {
      if (!cfgOk) return { status: "skipped", detail: "settings are invalid" };
      const dirs = config().uploadDirs;
      const missing: string[] = [];
      for (const d of dirs) await fs.stat(d).catch(() => missing.push(d));
      return missing.length
        ? { status: "warn", detail: `Missing: ${missing.join(", ")}`, fix: "Create them, or change NOTION_PLUS_UPLOAD_DIRS." }
        : { status: "ok", detail: dirs.join(", ") };
    })
  );
  checks.push(
    await run("chart renderer", async () => {
      const { renderChart } = await import("../services/charts.js");
      const { png } = await renderChart({ type: "bar", title: "check" }, [{ x: "a", y: 1 }]);
      return { status: "ok", detail: `Rendered a test chart (${png.length} bytes).` };
    })
  );
  checks.push(
    await run("automation rules", async () => {
      if (!cfgOk) return { status: "skipped", detail: "settings are invalid" };
      const { data, revision } = await loadRulesWithRevision();
      const enabled = data.rules.filter((r) => r.enabled).length;
      return {
        status: "ok",
        detail: `${rulesPath()}${rulesInRepo() ? " (the repository's file)" : ""}: ${data.rules.length} rules, ${enabled} enabled${revision ? `, revision ${revision}` : " (no file yet)"}.`,
      };
    })
  );
  checks.push(
    await run("automation runs", async () => {
      if (!cfgOk) return { status: "skipped", detail: "settings are invalid" };
      if ((!hasToken || !opts.online) && !config().NOTION_PLUS_WORKSPACE && !config().NOTION_PLUS_STATE) return { status: "skipped", detail: "needs the token (online) to find this integration's folder" };
      const state = await loadState();
      const entries = Object.entries(state.rules);
      if (!entries.length) return { status: "ok", detail: `No runs recorded on this machine (${await statePath()}).` };
      const unfinished = entries.filter(([, s]) => s.pending || (s.rows && Object.keys(s.rows).length)).map(([id]) => id);
      const last = entries.map(([, s]) => s.last_run?.at).filter(Boolean).sort().pop();
      return {
        status: unfinished.length ? "warn" : "ok",
        detail: `Last run ${last ?? "unknown"}.${unfinished.length ? ` Unfinished work for: ${unfinished.join(", ")}.` : ""}`,
        ...(unfinished.length ? { fix: "It's retried on the next run; notion_automation history shows why it stopped, and waive gives up on it." } : {}),
      };
    })
  );
  return checks;
}

export function registerDoctorTools(server: McpServer): void {
  server.registerTool(
    "notion_doctor",
    {
      title: "Check Setup",
      description:
        "Check that the server is set up and working, and say how to fix what isn't: settings, the token, the integration's " +
        "capabilities, whether any pages are shared with it, the local state folder (undo journal, chart recipes, automation " +
        "state), upload folders, the chart renderer, automation rules, and unfinished automation runs. Changes nothing. " +
        "Run it first when something doesn't work.",
      inputSchema: {
        offline: z.boolean().default(false).describe("Skip checks that call Notion."),
      },
      annotations: READ,
    },
    safe(async ({ offline }) => {
      const checks = await runDoctor({ online: !offline });
      const failed = checks.filter((c) => c.status === "fail");
      const warned = checks.filter((c) => c.status === "warn");
      return ok(
        { checks },
        {
          status: failed.length || warned.length ? "partial" : "ok",
          summary: failed.length
            ? `${failed.length} problem(s): ${failed.map((c) => c.check).join(", ")}.`
            : warned.length
              ? `Working, with ${warned.length} warning(s): ${warned.map((c) => c.check).join(", ")}.`
              : "Everything checked is working.",
        }
      );
    })
  );

  server.registerTool(
    "notion_capabilities",
    {
      title: "Capabilities",
      description:
        "What this server can do with the current integration: the areas it covers, the Notion API version, limits that " +
        "matter for planning (rows copied, blocks per copy, run limits), and which integration capabilities are available " +
        "(probed with read-only calls; write capabilities show as unknown until a write).",
      inputSchema: {},
      annotations: READ,
    },
    safe(async () => {
      const c = config();
      let probes: Record<string, string> | string = "needs NOTION_TOKEN";
      if (c.NOTION_TOKEN) {
        try {
          probes = await probeCapabilities();
        } catch (e) {
          probes = `couldn't probe: ${(e as Error).message.split("\n")[0]}`;
        }
      }
      return ok(
        {
          api_version: c.NOTION_VERSION,
          integration: probes,
          areas: {
            read: "search, pages and blocks (markdown or tree), find text, schemas, queries with filters, aggregation",
            edit: "patch one block, insert at an exact spot, replace text, delete blocks, page title/icon/cover/lock/move",
            data: "update properties, bulk update and create (CSV), create databases, change schemas, templates",
            copy: `duplicate pages with sub-pages and databases (up to ${MAX_COPY_ROWS} rows per data source, ${MAX_COPY_BLOCKS} blocks per copy), copy or move blocks`,
            visuals: "native database views (including charts), chart images (bar, line, area, scatter, pie, grouped, stacked), report pages",
            automations: "rules on conditions and schedules, resumable runs, export/import/deploy to GitHub Actions",
            safety: "dry runs, undo journal with conflict checks, notion_doctor",
          },
          limits: { automation_run_defaults: { max_rows: 200, max_requests: 3000, max_blocks: 5000, max_minutes: 20 } },
          not_supported_by_notion_api: ["Notion's built-in database automations", "linked database views (read or create)", "meeting notes blocks", "button properties"],
        },
        { summary: `API ${c.NOTION_VERSION}; ${typeof probes === "string" ? probes : `content read: ${probes.read_content}, comments read: ${probes.read_comments}`}.` }
      );
    })
  );
}
