#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerReadTools } from "./tools/read.js";
import { registerPageTools } from "./tools/pages.js";
import { registerBlockTools } from "./tools/blocks.js";
import { registerSafetyTools, registerSchemaTools } from "./tools/schema.js";
import { registerAutomationTools } from "./tools/automations.js";

const server = new McpServer(
  { name: "notion-plus-mcp-server", version: "0.1.0" },
  {
    instructions:
      "Local Notion server focused on precise edits. Workflow: find ids with notion_search, read with notion_get_page " +
      "(block ids appear in ⟨…⟩) or notion_get_schema, then make the smallest possible edit: notion_patch_block for one block, " +
      "notion_insert_blocks to add content at an exact spot, notion_replace_text for wording changes, notion_update_properties " +
      "for row fields. Preview bulk and find/replace changes with dry_run before applying. Every write returns an undo_id.",
  }
);

registerReadTools(server);
registerPageTools(server);
registerBlockTools(server);
registerSchemaTools(server);
registerSafetyTools(server);
registerAutomationTools(server);

async function main(): Promise<void> {
  if (!process.env.NOTION_TOKEN) {
    console.error("Warning: NOTION_TOKEN is not set; every tool call will fail until it is.");
  }
  await server.connect(new StdioServerTransport());
  console.error("notion-plus-mcp-server running on stdio");
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
