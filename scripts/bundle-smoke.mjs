#!/usr/bin/env node
// Install-test a built bundle the way a host would use it: unpack the .mcpb into a clean folder, start its server
// over stdio, run MCP initialize and tools/list, check every tool is there with a usable schema, and call
// notion_doctor offline (which also renders a chart with the bundled native renderer). No Notion access needed.
//   node scripts/bundle-smoke.mjs [bundles/notion-plus-<version>-<platform>-<arch>.mcpb]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
  console.error(`bundle smoke: FAILED: ${msg}`);
  process.exit(1);
};

let bundle = process.argv[2];
if (!bundle) {
  const dir = path.join(root, "bundles");
  const found = readdirSync(dir).filter((f) => f.endsWith(".mcpb")).map((f) => path.join(dir, f));
  bundle = found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!bundle) fail("no bundle in bundles/; run npm run bundle first.");
}

// What the server should expose: the same tool modules, registered in-process from the build.
const expected = new Map();
const registry = { registerTool: (name, config) => expected.set(name, config) };
for (const f of ["read", "pages", "blocks", "schema", "automations", "content", "database", "visuals", "doctor", "templates", "workflows"]) {
  const mod = await import(pathToFileURL(path.join(root, "dist", "tools", `${f}.js`)).href);
  for (const [k, fn] of Object.entries(mod)) if (k.startsWith("register") && typeof fn === "function") fn(registry);
}

const work = mkdtempSync(path.join(os.tmpdir(), "notion-plus-bundle-smoke-"));
try {
  const unpacked = path.join(work, "bundle");
  execFileSync(process.execPath, [path.join(root, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js"), "unpack", bundle, unpacked], { stdio: "inherit" });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(unpacked, "dist", "index.js")],
    cwd: work,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("NOTION"))),
      NOTION_TOKEN: "ntn_bundle_smoke_dummy",
      NOTION_PLUS_HOME: path.join(work, "home"),
      NOTION_PLUS_WORKSPACE: "bundle-smoke",
      NOTION_PLUS_LOG: "off",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "bundle-smoke", version: "1.0.0" });
  await client.connect(transport);
  const info = client.getServerVersion();
  const pkgVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  if (info?.version !== pkgVersion) fail(`server reports version ${info?.version}, package.json says ${pkgVersion}.`);

  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  const missing = [...expected.keys()].filter((n) => !names.has(n));
  const extra = [...names].filter((n) => !expected.has(n));
  if (missing.length || extra.length) fail(`tools differ. Missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"}.`);
  for (const t of tools) {
    if (t.inputSchema?.type !== "object") fail(`${t.name} has no object input schema.`);
    if (!t.description || t.description.length < 20) fail(`${t.name} has no real description.`);
    if (typeof t.annotations?.readOnlyHint !== "boolean") fail(`${t.name} has no readOnlyHint.`);
  }

  const res = await client.callTool({ name: "notion_doctor", arguments: { offline: true } });
  const env = JSON.parse(res.content[0].text);
  if (!env.status || !env.summary || !Array.isArray(env.data?.checks)) fail(`notion_doctor didn't return an envelope: ${res.content[0].text.slice(0, 300)}`);
  const chart = env.data.checks.find((c) => c.check === "chart renderer");
  if (chart?.status !== "ok") fail(`chart renderer: ${JSON.stringify(chart)}`);
  const broken = env.data.checks.filter((c) => c.status === "fail" && c.check !== "token");
  if (broken.length) fail(`doctor checks failed: ${JSON.stringify(broken)}`);

  await client.close();
  console.log(`bundle smoke: ok. ${path.basename(bundle)} starts, lists ${tools.length} tools, and renders charts.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
