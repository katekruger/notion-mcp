#!/usr/bin/env node
// The version must agree everywhere it's written: package.json, manifest.json (the bundle), package-lock.json, and the
// newest CHANGELOG heading. On a release tag (GITHUB_REF=refs/tags/vX.Y.Z, or the first argument), it must match too.
import { readFileSync } from "node:fs";

const read = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
const pkg = read("package.json").version;
const found = {
  "package.json": pkg,
  "manifest.json": read("manifest.json").version,
  "package-lock.json": read("package-lock.json").version,
  "package-lock.json packages[\"\"]": read("package-lock.json").packages?.[""]?.version,
  "CHANGELOG.md": readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").match(/^## (\d+\.\d+\.\d+[^\s]*)/m)?.[1],
};
const tag = process.argv[2] ?? (process.env.GITHUB_REF?.startsWith("refs/tags/") ? process.env.GITHUB_REF.slice("refs/tags/".length) : undefined);
if (tag) found[`tag ${tag}`] = tag.replace(/^v/, "");

const wrong = Object.entries(found).filter(([, v]) => v !== pkg);
if (wrong.length) {
  console.error(`Version mismatch (package.json says ${pkg}):\n${wrong.map(([k, v]) => `- ${k}: ${v ?? "missing"}`).join("\n")}`);
  process.exit(1);
}
console.log(`Version ${pkg} agrees in ${Object.keys(found).join(", ")}.`);
