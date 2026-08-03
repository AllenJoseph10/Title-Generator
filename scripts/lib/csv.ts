// RFC-4180 field quoting. Captions routinely contain commas, quotes and
// newlines; without this a single caption can shift every later column.
export function csvField(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function csvRow(values: Array<string | number | null | undefined>): string {
  return values.map(csvField).join(',');
}

// The inverse of csvRow. A state machine rather than a split on commas,
// because `visual_description` and `caption` both routinely contain commas
// and quotes, and a naive split silently shifts every later column — the
// exact failure this module's quoting exists to prevent, just in reverse.
//
// Record separators are CR, LF or CRLF *outside* quotes. Inside quotes the
// bytes are preserved verbatim, so a newline that was part of a caption
// survives the round trip.
export function parseCsvRows(text: string): string[][] {
  // Strip the UTF-8 BOM merge-dataset.ts writes for Excel's benefit —
  // otherwise it becomes part of the first header name.
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  // Distinguishes "the file ended with a newline" (nothing pending) from
  // "the last line has no trailing newline" (one more row to flush).
  let pending = false;
  let inQuotes = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (inQuotes) {
      if (c !== '"') { field += c; continue; }
      if (s[i + 1] === '"') { field += '"'; i++; continue; } // escaped quote
      inQuotes = false;
      continue;
    }

    if (c === '"') { inQuotes = true; pending = true; continue; }
    if (c === ',') { row.push(field); field = ''; pending = true; continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i++; // CRLF counts once
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      pending = false;
      continue;
    }
    field += c;
    pending = true;
  }

  if (pending || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Parse into records keyed by the header row.
//
// A row whose field count does not match the header is an error, never a
// row to pad or truncate: a short row means the file is corrupt, and
// quietly filling the gap would put a caption fragment into `views`.
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];

  const header = rows[0];
  const records: Record<string, string>[] = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && row[0] === '') continue; // stray blank line
    if (row.length !== header.length) {
      throw new Error(
        `parseCsv: line ${r + 1} has ${row.length} fields, expected ${header.length}. ` +
          `The file is malformed — refusing to guess which column is missing.`,
      );
    }
    const record: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) record[header[c]] = row[c];
    records.push(record);
  }
  return records;
}
