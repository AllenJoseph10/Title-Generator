import { Globe, Sparkles, ThumbsUp } from 'lucide-react';

// Three things a first-time tester cannot discover by looking: the browser
// floor, that the arrow beside Regenerate is a menu at all, and that the vote
// buttons have different scopes. Everything else on this screen explains itself.
//
// The icons deliberately match the ones on the controls they describe —
// Sparkles is the Regenerate button, ThumbsUp is the vote control — so the
// reader can map each line to something they will actually see.
const ITEMS = [
  {
    icon: Globe,
    label: 'Browsers',
    body: 'Works in a current Chrome, Edge, Safari or Firefox. Clips over 50 MB are shrunk in the browser before upload, which needs Safari 16.4 or later, or Firefox 130 or later.',
  },
  {
    icon: Sparkles,
    label: 'Regenerate modes',
    body: 'The arrow beside Regenerate opens five directions — more visceral, more contrarian, fresher angles, shorter and punchier, or more mystery. Each one re-runs the same clip with that direction applied to every title.',
  },
  {
    icon: ThumbsUp,
    label: 'Like and dislike',
    body: 'Dislike keeps a title out of the next regenerate for the clip you are on. Like is remembered for the creator, and shapes titles on later clips that look similar.',
  },
];

export function DashboardGuide() {
  return (
    <section
      aria-label="Before you start"
      className="mb-8 divide-y divide-border rounded-md border border-border bg-bg-raised/50"
    >
      {ITEMS.map(({ icon: Icon, label, body }) => (
        <div
          key={label}
          className="grid grid-cols-1 gap-1.5 px-5 py-4 sm:grid-cols-[170px_1fr] sm:gap-5"
        >
          <p className="flex items-center gap-2 text-micro uppercase tracking-[0.12em] text-ink-muted">
            <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />
            {label}
          </p>
          <p className="text-sm text-ink-dim text-balance">{body}</p>
        </div>
      ))}
    </section>
  );
}
