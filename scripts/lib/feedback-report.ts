// Pure: rows in, Markdown out. Kept separate from the script that reads
// Postgres so the formatting is testable without a database.

export type FeedbackRow = {
  creatorHandle: string;
  vote: 1 | -1;
  title: string;
  hookFamily: string;
  visualDescription: string;
  generationId: string;
  createdAt: string;
};

function entry(r: FeedbackRow): string {
  return [
    `- **${r.title}**`,
    `  - family: \`${r.hookFamily}\``,
    `  - generated for: ${r.visualDescription}`,
    `  - ${r.createdAt} · generation \`${r.generationId}\``,
  ].join('\n');
}

export function renderFeedbackReport(rows: FeedbackRow[], generatedAt: string): string {
  const kept = rows.filter((r) => r.vote === 1);
  const rejected = rows.filter((r) => r.vote === -1);

  // Derived from the rows passed in, not `new Date()` — this function stays
  // pure (rows in, Markdown out) so it is testable without a clock or a
  // database, matching the rest of this module.
  const dateRange =
    rows.length === 0
      ? null
      : rows.reduce(
          (range, r) => ({
            earliest: r.createdAt < range.earliest ? r.createdAt : range.earliest,
            latest: r.createdAt > range.latest ? r.createdAt : range.latest,
          }),
          { earliest: rows[0].createdAt, latest: rows[0].createdAt },
        );

  const head = `# Title feedback — generated ${generatedAt}

${kept.length} kept · ${rejected.length} rejected · ${rows.length} total${
    dateRange ? ` · ${dateRange.earliest} to ${dateRange.latest}` : ''
  }

Every vote a tester has cast, with the visual description each title was
generated for. Kept titles also feed the creator's voice examples; rejected
titles only affected the clip they were rejected on.`;

  if (rows.length === 0) return `${head}\n\nNo votes recorded yet.\n`;

  const creators = [...new Set(rows.map((r) => r.creatorHandle))].sort();
  const sections = creators.map((handle) => {
    const mine = rows.filter((r) => r.creatorHandle === handle);
    const k = mine.filter((r) => r.vote === 1);
    const x = mine.filter((r) => r.vote === -1);
    const parts = [`## @${handle}`];
    if (k.length) parts.push(`### Kept (${k.length})\n\n${k.map(entry).join('\n\n')}`);
    if (x.length) parts.push(`### Rejected (${x.length})\n\n${x.map(entry).join('\n\n')}`);
    return parts.join('\n\n');
  });

  return `${head}\n\n---\n\n${sections.join('\n\n---\n\n')}\n`;
}
