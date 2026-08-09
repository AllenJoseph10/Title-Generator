'use client';

// Shared "the app is working" panel.
//
// Two honesty rules shape this:
//   - Ticks are only shown for work that has genuinely finished. Upload knows
//     that preparation completed, so it ticks it.
//   - Generation is a single round trip, so its stages cannot be tracked. They
//     are listed as what the request is doing, with no per-stage state claimed,
//     rather than a fake progress march.

type Step = { label: string; state: 'done' | 'active' | 'pending' };

export function ProcessingPanel({
  eyebrow,
  title,
  note,
  steps,
}: {
  eyebrow: string;
  title: string;
  note?: string;
  steps: Step[];
}) {
  return (
    <div className="space-y-6">
      <div>
        <p className="text-micro uppercase tracking-[0.12em] text-gold">{eyebrow}</p>
        <h2 className="mt-2 font-display text-2xl leading-snug text-ink">{title}</h2>
        {note && <p className="mt-2 max-w-[46ch] text-sm text-ink-dim">{note}</p>}
      </div>

      <IndeterminateBar />

      <ol className="space-y-3">
        {steps.map((s) => (
          <li key={s.label} className="flex items-center gap-3">
            <StepMark state={s.state} />
            <span
              className={
                s.state === 'pending'
                  ? 'text-sm text-ink-muted'
                  : s.state === 'done'
                    ? 'text-sm text-ink-dim'
                    : 'text-sm text-ink'
              }
            >
              {s.label}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function IndeterminateBar() {
  return (
    <div className="h-[3px] w-full max-w-[320px] overflow-hidden rounded-sm bg-bg-inset">
      <div className="h-full w-1/3 animate-track rounded-sm bg-gold" />
    </div>
  );
}

function StepMark({ state }: { state: Step['state'] }) {
  if (state === 'done') {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-gold/20">
        <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 text-gold" aria-hidden>
          <path
            d="M1 5.2 3.8 8 9 2.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }
  if (state === 'active') {
    return (
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        <span className="h-2 w-2 animate-pulse rounded-full bg-gold" />
      </span>
    );
  }
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
      <span className="h-2 w-2 rounded-full border border-border-strong" />
    </span>
  );
}
