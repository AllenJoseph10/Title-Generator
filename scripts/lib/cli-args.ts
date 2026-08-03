// Pure CLI-argument validation, isolated so it can be exhaustively tested
// without spinning up the whole script (which requires ANTHROPIC_API_KEY,
// touches the filesystem, etc).

export class InvalidArgError extends Error {}

// Validates the value passed to --recheck.
//
// The caller's mode switch is `recheck ? recheckBranch : mutatingBranch`, so
// ANY falsy value for `recheck` — including NaN from `parseInt('--recheck')`
// with no following value, or 0 from `--recheck 0` — falls through to the
// mutating branch. That is the exact opposite of --recheck's documented
// "reports differences, does not mutate the manifest" guarantee. So an
// invalid value must throw, never return something falsy that silently
// selects the wrong branch.
export function parseRecheckValue(raw: string | undefined): number {
  const n = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new InvalidArgError(
      `--recheck requires a positive integer (got ${raw === undefined ? '<missing>' : JSON.stringify(raw)}). ` +
        `A missing, non-numeric, zero, or negative value must fail fast here — falling through to the ` +
        `default branch would WRITE to the manifest, the opposite of --recheck's report-only guarantee.`,
    );
  }
  return n;
}
