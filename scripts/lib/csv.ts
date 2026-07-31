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
