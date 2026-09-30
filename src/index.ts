#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerReadTools } from "./tools/read.js";
import { registerPageTools } from "./tools/pages.js";
import { registerBlockTools } from "./tools/blocks.js";
import { registerSafetyTools, registerSchemaTools } from "./tools/schema.js";
import { registerAutomationTools } from "./tools/automations.js";
import { registerContentTools } from "./tools/content.js";
import { registerDatabaseTools } from "./tools/database.js";
import { registerVisualTools } from "./tools/visuals.js";
import { VERSION } from "./version.js";
import { journalWrites } from "./tools/util.js";

const mcp = new McpServer(
  { name: "notion-plus-mcp-server", version: VERSION },
  {
    instructions:
      "Local Notion server focused on precise edits. Workflow: find ids with notion_search, read with notion_get_page " +
      "(block ids appear in ⟨…⟩) or notion_get_schema, then make the smallest possible edit: notion_patch_block for one block, " +
      "notion_insert_blocks to add content at an exact spot, notion_replace_text for wording changes, notion_update_properties " +
      "for row fields, notion_update_page for title/icon/cover/moves. Read a page as markdown (notion_get_page format=markdown) " +
      "when you need its full formatting; the same markdown can be inserted back. Preview bulk, move, and find/replace changes " +
      "with dry_run before applying. Every write returns an undo_id.",
  }
);

// Tools register through a wrapper that journals each write before it happens.
const server = journalWrites(mcp);

registerReadTools(server);
registerPageTools(server);
registerBlockTools(server);
registerContentTools(server);
registerSchemaTools(server);
registerDatabaseTools(server);
registerVisualTools(server);
registerSafetyTools(server);
registerAutomationTools(server);

async function main(): Promise<void> {
  if (!process.env.NOTION_TOKEN) {
    console.error("Warning: NOTION_TOKEN is not set; every tool call will fail until it is.");
  }
  await mcp.connect(new StdioServerTransport());
  console.error("notion-plus-mcp-server running on stdio");
}

main().catch((error) => {
  console.error("Fatal:", error);
  process.exit(1);
});
