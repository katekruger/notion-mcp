// Tool annotations tell clients which tools only read, which can destroy, and which are safe to repeat.
import { test } from "vitest";
import assert from "node:assert/strict";

const tools = new Map<string, { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean }>();
const registry = { registerTool: (name: string, c: { annotations?: object }) => tools.set(name, c.annotations ?? {}) };
for (const m of await Promise.all(
  ["read", "pages", "blocks", "schema", "automations", "content", "database", "visuals", "doctor", "templates", "workflows"].map((f) => import(`../src/tools/${f}.ts`))
)) {
  for (const [k, fn] of Object.entries(m)) if (k.startsWith("register") && typeof fn === "function") (fn as (r: unknown) => void)(registry);
}

const READ_ONLY = ["notion_search", "notion_get_page", "notion_get_blocks", "notion_find_blocks", "notion_get_schema", "notion_query", "notion_history", "notion_list_templates", "notion_aggregate", "notion_doctor", "notion_capabilities"];
const DESTRUCTIVE = ["notion_trash_page", "notion_delete_blocks", "notion_bulk_update", "notion_undo", "notion_schema", "notion_automation", "notion_copy_blocks", "notion_views", "notion_workflow"];
const IDEMPOTENT_WRITES = ["notion_update_properties", "notion_bulk_update", "notion_patch_block", "notion_update_page"];

test("every tool declares its annotations", () => {
  assert.equal(tools.size, 33);
  for (const [name, a] of tools) {
    for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint"] as const) assert.equal(typeof a[k], "boolean", `${name}.${k}`);
  }
});

test("read-only, destructive, and idempotent tools are marked as such", () => {
  for (const [name, a] of tools) {
    assert.equal(a.readOnlyHint, READ_ONLY.includes(name), `${name} readOnlyHint`);
    if (!a.readOnlyHint) {
      assert.equal(a.destructiveHint, DESTRUCTIVE.includes(name), `${name} destructiveHint`);
      assert.equal(a.idempotentHint, IDEMPOTENT_WRITES.includes(name), `${name} idempotentHint`);
    }
  }
});
