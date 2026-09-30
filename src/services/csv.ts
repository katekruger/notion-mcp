// RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. First row is the header.
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // drop a byte-order mark
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (quoted) throw new Error("CSV: a quoted field is never closed.");
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length < 2) throw new Error("CSV needs a header row and at least one data row.");
  const header = nonEmpty[0].map((h) => h.trim());
  const dupes = header.filter((h, i) => h && header.indexOf(h) !== i);
  if (dupes.length) throw new Error(`CSV header repeats: ${[...new Set(dupes)].join(", ")}.`);
  return nonEmpty.slice(1).map((r, n) => {
    if (r.length > header.length) throw new Error(`CSV row ${n + 2} has ${r.length} fields; the header has ${header.length}.`);
    return Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()]).filter(([h]) => h));
  });
}
