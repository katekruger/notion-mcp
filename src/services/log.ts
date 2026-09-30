// Structured logs on stderr (stdout carries the MCP protocol). One JSON object per line, so a scheduler or log
// collector can follow a run by its run_id. NOTION_PLUS_LOG=off silences them; =text prints plain lines.
export type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const mode = process.env.NOTION_PLUS_LOG ?? "json";
  if (mode === "off") return;
  const at = new Date().toISOString();
  if (mode === "text") {
    const rest = Object.entries(fields).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
    console.error(`${at} ${level} ${event}${rest ? " " + rest : ""}`);
    return;
  }
  console.error(JSON.stringify({ at, level, event, ...fields }));
}
