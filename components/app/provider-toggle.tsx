'use client';

import { cn } from '@/lib/utils';

export type Provider = 'anthropic' | 'openai';

const PROVIDERS: Array<{ id: Provider; label: string }> = [
  { id: 'anthropic', label: 'Claude' },
  { id: 'openai', label: 'OpenAI' },
];

type Props = {
  value: Provider;
  onChange: (p: Provider) => void;
  disabled?: boolean;
};

export function ProviderToggle({ value, onChange, disabled }: Props) {
  return (
    <div
      role="radiogroup"
      aria-label="AI provider"
      className={cn(
        'inline-flex border border-border rounded-md bg-bg-raised p-0.5',
        disabled && 'opacity-50 pointer-events-none',
      )}
    >
      {PROVIDERS.map((p) => {
        const active = value === p.id;
        return (
          <button
            key={p.id}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(p.id)}
            className={cn(
              'px-3 h-7 text-xs font-medium rounded-sm transition-colors',
              active ? 'bg-ink text-bg' : 'text-ink-dim hover:text-ink',
            )}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}
