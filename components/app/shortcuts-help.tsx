'use client';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

type Props = {
  open: boolean;
  onClose: () => void;
};

const ROWS: Array<{ keys: string[]; desc: string }> = [
  { keys: ['g'],         desc: 'Generate titles' },
  { keys: ['r'],         desc: 'Regenerate (same direction)' },
  { keys: ['↑', '↓'],    desc: 'Move between titles' },
  { keys: ['c'],         desc: 'Copy focused title' },
  { keys: ['1', '–', '9'], desc: 'Copy title 1–9 directly' },
  { keys: ['Esc'],       desc: 'Close dialogs / previews' },
  { keys: ['?'],         desc: 'Toggle this help' },
];

export function ShortcutsHelp({ open, onClose }: Props) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 pt-2">
          {ROWS.map((r) => (
            <div key={r.desc} className="contents">
              <dt className="flex gap-1.5 items-center">
                {r.keys.map((k, i) => (
                  <kbd
                    key={i}
                    className="inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-sm border border-border bg-bg-inset px-1.5 font-mono text-xs text-ink"
                  >
                    {k}
                  </kbd>
                ))}
              </dt>
              <dd className="text-sm text-ink-dim self-center">{r.desc}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
