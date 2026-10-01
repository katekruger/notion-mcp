// Layouts for flow and relationship charts, computed here rather than by a renderer so they are deterministic (the
// same data always draws the same picture) and testable without rendering. Both take edges {from, to, value}.

export interface Edge {
  from: string;
  to: string;
  value: number;
}

export interface SankeyNode {
  name: string;
  column: number;
  value: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Order of first appearance; picks the color. */
  index: number;
}

export interface SankeyLink {
  from: string;
  to: string;
  value: number;
  /** SVG path of the ribbon, in chart coordinates. */
  path: string;
  /** Index of the source node, for its color. */
  index: number;
}

export const MAX_GRAPH_NODES = 60;

function nodesOf(edges: Edge[]): string[] {
  const seen = new Set<string>();
  for (const e of edges) {
    seen.add(e.from);
    seen.add(e.to);
  }
  return [...seen];
}

/**
 * Sankey layout: columns by longest path from a source (sinks pushed to the last column), node heights proportional
 * to flow, and ribbons ordered to cross as little as a simple layout can. Throws on a cycle, which a Sankey can't draw.
 */
export function sankeyLayout(edges: Edge[], width: number, height: number, opts: { nodeWidth?: number; padding?: number } = {}): { nodes: SankeyNode[]; links: SankeyLink[] } {
  const nodeWidth = opts.nodeWidth ?? 14;
  const padding = opts.padding ?? 12;
  const names = nodesOf(edges);
  if (names.length > MAX_GRAPH_NODES) throw new Error(`${names.length} nodes is too many for one Sankey (at most ${MAX_GRAPH_NODES}); group the small ones first.`);
  for (const e of edges) if (e.from === e.to) throw new Error(`"${e.from}" flows into itself; a Sankey can't show that.`);

  // Merge duplicate edges.
  const merged = new Map<string, Edge>();
  for (const e of edges) {
    const k = `${e.from}\u0000${e.to}`;
    const m = merged.get(k);
    if (m) m.value += e.value;
    else merged.set(k, { ...e });
  }
  const links = [...merged.values()];

  // Columns: Kahn's algorithm; anything left over is in a cycle.
  const indeg = new Map(names.map((n) => [n, 0]));
  for (const l of links) indeg.set(l.to, (indeg.get(l.to) ?? 0) + 1);
  const column = new Map(names.map((n) => [n, 0]));
  const queue = names.filter((n) => indeg.get(n) === 0);
  let seen = 0;
  while (queue.length) {
    const n = queue.shift() as string;
    seen++;
    for (const l of links.filter((x) => x.from === n)) {
      column.set(l.to, Math.max(column.get(l.to) ?? 0, (column.get(n) ?? 0) + 1));
      indeg.set(l.to, (indeg.get(l.to) ?? 0) - 1);
      if (indeg.get(l.to) === 0) queue.push(l.to);
    }
  }
  if (seen < names.length) {
    const stuck = names.filter((n) => (indeg.get(n) ?? 0) > 0);
    throw new Error(`The flows loop back (${stuck.slice(0, 4).join(", ")}${stuck.length > 4 ? ", …" : ""}); a Sankey needs flows that only go forward.`);
  }
  const last = Math.max(...column.values());
  for (const n of names) if (!links.some((l) => l.from === n)) column.set(n, last);

  const inflow = (n: string) => links.filter((l) => l.to === n).reduce((s, l) => s + l.value, 0);
  const outflow = (n: string) => links.filter((l) => l.from === n).reduce((s, l) => s + l.value, 0);
  const value = new Map(names.map((n) => [n, Math.max(inflow(n), outflow(n))]));

  const columns: string[][] = Array.from({ length: last + 1 }, () => []);
  for (const n of names) columns[column.get(n) ?? 0].push(n);
  // One scale for every column, set by the fullest one.
  const k = Math.min(...columns.filter((c) => c.length).map((c) => (height - padding * (c.length - 1)) / c.reduce((s, n) => s + (value.get(n) ?? 0), 0)));
  const step = last === 0 ? 0 : (width - nodeWidth) / last;

  const nodes = new Map<string, SankeyNode>();
  for (const [ci, col] of columns.entries()) {
    const total = col.reduce((s, n) => s + (value.get(n) ?? 0) * k, 0) + padding * (col.length - 1);
    let y = (height - total) / 2; // center short columns
    for (const n of col) {
      const h = (value.get(n) ?? 0) * k;
      nodes.set(n, { name: n, column: ci, value: value.get(n) ?? 0, x0: ci * step, x1: ci * step + nodeWidth, y0: y, y1: y + h, index: names.indexOf(n) });
      y += h + padding;
    }
  }

  // Ribbons leave each node ordered by where they arrive, and arrive ordered by where they left, so they don't twist.
  const outY = new Map(names.map((n) => [n, nodes.get(n)?.y0 ?? 0]));
  const inY = new Map(names.map((n) => [n, nodes.get(n)?.y0 ?? 0]));
  const byTarget = [...links].sort((a, b) => (nodes.get(a.to)?.y0 ?? 0) - (nodes.get(b.to)?.y0 ?? 0));
  const start = new Map<Edge, number>();
  for (const l of byTarget) {
    start.set(l, outY.get(l.from) ?? 0);
    outY.set(l.from, (outY.get(l.from) ?? 0) + l.value * k);
  }
  const bySource = [...links].sort((a, b) => (nodes.get(a.from)?.y0 ?? 0) - (nodes.get(b.from)?.y0 ?? 0));
  const end = new Map<Edge, number>();
  for (const l of bySource) {
    end.set(l, inY.get(l.to) ?? 0);
    inY.set(l.to, (inY.get(l.to) ?? 0) + l.value * k);
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  const out: SankeyLink[] = links.map((l) => {
    const s = nodes.get(l.from) as SankeyNode;
    const t = nodes.get(l.to) as SankeyNode;
    const h = l.value * k;
    const [x0, x1] = [s.x1, t.x0];
    const xm = (x0 + x1) / 2;
    const [y0, y1] = [start.get(l) ?? 0, end.get(l) ?? 0];
    const path =
      `M${r(x0)},${r(y0)}C${r(xm)},${r(y0)} ${r(xm)},${r(y1)} ${r(x1)},${r(y1)}` +
      `L${r(x1)},${r(y1 + h)}C${r(xm)},${r(y1 + h)} ${r(xm)},${r(y0 + h)} ${r(x0)},${r(y0 + h)}Z`;
    return { from: l.from, to: l.to, value: l.value, path, index: s.index };
  });
  return { nodes: [...nodes.values()], links: out };
}

export interface NetworkNode {
  name: string;
  x: number;
  y: number;
  /** Sum of the weights of its edges. */
  degree: number;
  /** Label placement: which side of the circle it is on. */
  align: "left" | "right" | "center";
  baseline: "top" | "bottom" | "middle";
}

/**
 * Circular network layout: nodes on a circle in order of first appearance (a stable order reads better across
 * refreshes than one that reshuffles as numbers change), edges as straight lines between them.
 */
export function circleLayout(edges: Edge[], width: number, height: number, labelRoom = 60): { nodes: NetworkNode[]; edges: (Edge & { x1: number; y1: number; x2: number; y2: number })[] } {
  const names = nodesOf(edges);
  if (names.length > MAX_GRAPH_NODES) throw new Error(`${names.length} nodes is too many for one network chart (at most ${MAX_GRAPH_NODES}).`);
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.max(20, Math.min(width, height) / 2 - labelRoom);
  const degree = new Map(names.map((n) => [n, 0]));
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + e.value);
    degree.set(e.to, (degree.get(e.to) ?? 0) + e.value);
  }
  const r = (n: number) => Math.round(n * 100) / 100;
  const nodes = names.map((name, i): NetworkNode => {
    // Start at the top and go clockwise.
    const a = -Math.PI / 2 + (2 * Math.PI * i) / names.length;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    return {
      name,
      x: r(cx + radius * cos),
      y: r(cy + radius * sin),
      degree: degree.get(name) ?? 0,
      align: Math.abs(cos) < 0.2 ? "center" : cos > 0 ? "left" : "right",
      baseline: Math.abs(sin) < 0.2 ? "middle" : sin > 0 ? "top" : "bottom",
    };
  });
  const at = new Map(nodes.map((n) => [n.name, n]));
  return {
    nodes,
    edges: edges.map((e) => {
      const a = at.get(e.from) as NetworkNode;
      const b = at.get(e.to) as NetworkNode;
      return { ...e, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    }),
  };
}
