import { Globe, Sparkles, ThumbsUp } from 'lucide-react';

// Three things a first-time tester cannot discover by looking: the browser
// floor, that the arrow beside Regenerate is a menu at all, and that the vote
// buttons have different scopes. Everything else on this screen explains itself.
//
// Kept to a single short line of copy each. This sits above the dropzone, so
// every line it grows pushes the thing people actually came here to use further
// down the page — the guide is a caption, not a section.
//
// The icons deliberately match the ones on the controls they describe —
// Sparkles is the Regenerate button, ThumbsUp is the vote control — so the
// reader can map each line to something they will actually see.
const ITEMS = [
  {
    icon: Globe,
    label: 'Browsers',
    body: 'Current Chrome, Edge, Safari or Firefox. Shrinking clips over 50 MB needs Safari 16.4+ or Firefox 130+.',
  },
  {
    icon: Sparkles,
    label: 'Regenerate',
    body: 'The arrow beside Regenerate re-runs the clip five ways: visceral, contrarian, fresher, shorter, mystery.',
  },
  {
    icon: ThumbsUp,
    label: 'Like / dislike',
    body: "Dislike drops a title from this clip's next regenerate. Like is remembered for the creator.",
  },
];

export function DashboardGuide() {
  return (
    // gap-px over a border-coloured background draws the hairlines between
    // cells, and collapses to horizontal rules when this stacks on mobile —
    // which divide-x cannot do.
    <section
      aria-label="Before you start"
      className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-3"
    >
      {ITEMS.map(({ icon: Icon, label, body }) => (
        <div key={label} className="flex flex-col gap-1.5 bg-bg-raised px-4 py-3">
          <p className="flex items-center gap-1.5 text-micro uppercase tracking-[0.1em] text-ink-muted">
            <Icon className="h-3 w-3 shrink-0" strokeWidth={1.5} />
            {label}
          </p>
          <p className="text-xs leading-relaxed text-ink-dim">{body}</p>
        </div>
      ))}
    </section>
  );
}
