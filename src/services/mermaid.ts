// Mermaid helpers: a light syntax check before writing, and a Gantt chart built from dated rows.
const DIAGRAMS = [
  "graph", "flowchart", "sequenceDiagram", "classDiagram", "stateDiagram", "stateDiagram-v2", "erDiagram", "journey", "gantt",
  "pie", "timeline", "mindmap", "quadrantChart", "xychart-beta", "gitGraph", "sankey-beta", "block-beta", "requirementDiagram",
  "C4Context", "C4Container", "C4Component", "architecture-beta", "kanban", "packet-beta", "radar-beta",
];

/** Notion renders Mermaid client-side; catch the mistakes that would show an error box instead of a diagram. */
export function checkMermaid(code: string): void {
  const lines = code.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("%%"));
  if (lines.length === 0) throw new Error("The Mermaid diagram is empty.");
  const kind = lines[0].split(/\s+/)[0];
  if (!DIAGRAMS.includes(kind)) {
    throw new Error(`Mermaid diagrams start with a type (${DIAGRAMS.slice(0, 11).join(", ")}, …); got "${lines[0].slice(0, 40)}".`);
  }
  let depth = 0;
  for (const ch of code) {
    if (ch === "[" || ch === "(" || ch === "{") depth++;
    if (ch === "]" || ch === ")" || ch === "}") depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) throw new Error("The Mermaid diagram has unbalanced brackets.");
  if (kind === "gantt" && !lines.some((l) => /:\s*\S/.test(l) && !/^(title|dateFormat|axisFormat|section|excludes|todayMarker|tickInterval)\b/.test(l))) {
    throw new Error("The Gantt chart has no tasks.");
  }
}

export interface GanttTask {
  name: string;
  start: string;
  end?: string | null;
  section?: string;
  status?: "done" | "active" | "crit" | null;
}

/** Text safe inside a Gantt task name (no colons or hashes, which Mermaid treats as syntax). */
function clean(s: string): string {
  return s.replace(/[:#;]/g, " ").replace(/\s+/g, " ").trim() || "(untitled)";
}

export function ganttChart(title: string | undefined, tasks: GanttTask[]): string {
  if (tasks.length === 0) throw new Error("No dated rows to put in the Gantt chart.");
  const lines = ["gantt", ...(title ? [`    title ${clean(title)}`] : []), "    dateFormat YYYY-MM-DD", "    axisFormat %b %d"];
  const sections = new Map<string, GanttTask[]>();
  for (const t of tasks) {
    const key = t.section ? clean(t.section) : "";
    sections.set(key, [...(sections.get(key) ?? []), t]);
  }
  let n = 0;
  for (const [section, list] of sections) {
    if (section) lines.push(`    section ${section}`);
    for (const t of list) {
      const start = t.start.slice(0, 10);
      const end = t.end ? t.end.slice(0, 10) : null;
      const tag = t.status ? `${t.status}, ` : "";
      const span = end && end > start ? end : "1d";
      lines.push(`    ${clean(t.name)} :${tag}t${++n}, ${start}, ${span}`);
    }
  }
  return lines.join("\n");
}
