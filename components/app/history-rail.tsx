'use client';

import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { HistoryItem } from './types';

type Props = {
  onSelect: (id: string) => void;
  refreshKey?: number;
};

export function HistoryRail({ onSelect, refreshKey }: Props) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/generations')
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((j) => {
        if (!cancelled) setItems(j.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // The rail owns its own divider so that an empty history leaves no trace —
  // a separator with nothing under it reads as a broken section.
  if (items === null) return null;
  if (items.length === 0) return null;

  return (
    <div className="mt-16 space-y-2 border-t border-border pt-6">
      <div className="flex items-center gap-2 text-micro uppercase tracking-[0.12em] text-ink-muted">
        <Clock className="h-3 w-3" />
        Recent
      </div>
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <li key={item.id}>
            <button
              onClick={() => onSelect(item.id)}
              className={cn(
                'w-full text-left grid grid-cols-[110px_1fr_auto] gap-4 py-3 items-start',
                'hover:bg-bg-raised/40 transition-colors px-2 -mx-2 rounded-sm',
              )}
            >
              <span className="text-xs text-ink-muted font-mono tabular-nums pt-0.5">
                {formatDate(item.createdAt)}
              </span>
              <span className="text-sm text-ink truncate min-w-0">
                {item.topTitle || item.sceneSummary || '—'}
              </span>
              <span className="text-xs text-ink-muted truncate max-w-[200px] hidden lg:block">
                {item.sceneSummary}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
