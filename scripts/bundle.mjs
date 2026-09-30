// Build an MCP Bundle (.mcpb) for this platform: npm run bundle → bundles/notion-plus-<version>-<platform>-<arch>.mcpb
// Chart images use a native renderer, so bundles are per platform; the release workflow builds one for each.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`manifest.json version ${manifest.version} doesn't match package.json ${pkg.version}. Update manifest.json.`);
  process.exit(1);
}

run("npm", ["run", "build"]);
const stage = mkdtempSync(path.join(os.tmpdir(), "notion-plus-bundle-"));
try {
  for (const item of ["dist", "package.json", "package-lock.json", "manifest.json", "README.md", "LICENSE"]) {
    cpSync(path.join(root, item), path.join(stage, item), { recursive: true });
  }
  mkdirSync(path.join(stage, "automations"), { recursive: true });
  writeFileSync(path.join(stage, "automations", "rules.json"), JSON.stringify({ version: 1, timezone: "UTC", rules: [] }, null, 2) + "\n");
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);
  const outDir = path.join(root, "bundles");
  mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `notion-plus-${pkg.version}-${process.platform}-${process.arch}.mcpb`);
  run(process.execPath, [path.join(root, "node_modules", "@anthropic-ai", "mcpb", "dist", "cli", "cli.js"), "pack", stage, out]);
  console.log(`\nBundle: ${out}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
