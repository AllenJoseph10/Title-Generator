'use client';

import { useEffect, useRef, useState } from 'react';
import { Sparkles, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type SteeringOption = {
  label: string;
  value: string;
};

const STEERING_OPTIONS: SteeringOption[] = [
  { label: 'Same direction',     value: '' },
  { label: 'More visceral',      value: 'Be more visceral and specific. Use concrete sensory nouns. Avoid abstractions.' },
  { label: 'More contrarian',    value: 'Lean harder into contrarian truths — challenge a widely-held assumption in each title.' },
  { label: 'Fresher angles',     value: 'Avoid every angle already implied by the retrieved examples. Find unobvious framings.' },
  { label: 'Shorter / punchier', value: 'Keep every title under 8 words. Cut every non-essential word.' },
  { label: 'More mystery',       value: 'Lean into mystery and information gaps. Make the viewer feel they cannot scroll past.' },
];

type Props = {
  onRegenerate: (steering: string) => void;
  busy?: boolean;
};

export function RegenerateMenu({ onRegenerate, busy }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative inline-flex">
      <Button
        variant="outline"
        size="sm"
        onClick={() => onRegenerate('')}
        disabled={busy}
        className="rounded-r-none border-r-0"
      >
        <Sparkles className="h-3.5 w-3.5" />
        {busy ? 'Generating…' : 'Regenerate'}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="rounded-l-none px-2"
        aria-label="Regenerate options"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </Button>
      {open && (
        <ul
          className={cn(
            'absolute right-0 top-full mt-1 z-40 min-w-[220px]',
            'border border-border bg-bg-raised rounded-md shadow-xl py-1 animate-slide-up',
          )}
        >
          {STEERING_OPTIONS.slice(1).map((opt) => (
            <li key={opt.label}>
              <button
                onClick={() => {
                  setOpen(false);
                  onRegenerate(opt.value);
                }}
                className="block w-full text-left px-3 py-1.5 text-sm text-ink hover:bg-bg-inset transition-colors"
              >
                {opt.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
