'use client';

import { useState } from 'react';
import { Copy, Check, ThumbsUp, ThumbsDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';
import { cn } from '@/lib/utils';
import {
  priorBucket,
  STRENGTH_VARIANT,
  type Title,
} from './types';

type Props = {
  titles: Title[];
  generationId: string;
};

export function TitleList({ titles, generationId }: Props) {
  const [copied, setCopied] = useState<number | null>(null);
  const [votes, setVotes] = useState<Record<number, -1 | 1>>({});

  const onCopy = async (i: number, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(i);
    toast.success('Copied');
    setTimeout(() => setCopied((c) => (c === i ? null : c)), 1200);
  };

  const onVote = async (i: number, v: -1 | 1) => {
    setVotes((prev) => ({ ...prev, [i]: v }));
    const r = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ generation_id: generationId, title_index: i, vote: v }),
    });
    if (!r.ok) toast.error(`Feedback failed (${r.status})`);
  };

  return (
    <ol className="divide-y divide-border">
      {titles.map((t, i) => {
        const bucket = priorBucket(t.templateSimilarityPrior);
        const v = votes[i];
        return (
          <li
            key={i}
            className="group grid grid-cols-[28px_1fr_auto] gap-4 py-4 items-start"
          >
            <span className="text-micro uppercase tracking-[0.08em] text-ink-muted pt-1.5 tabular-nums">
              {String(i + 1).padStart(2, '0')}
            </span>

            <div className="flex flex-col gap-2 min-w-0">
              <p className="font-display text-lg leading-snug text-ink text-balance">{t.text}</p>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-xs text-ink-muted">{t.hookFamily}</span>
                <span className="text-ink-muted">·</span>
                <Badge variant={STRENGTH_VARIANT[bucket]}>{bucket}</Badge>
              </div>
            </div>

            <div className="flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onCopy(i, t.text)}
                aria-label="Copy title"
              >
                {copied === i ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onVote(i, 1)}
                aria-label="Thumbs up"
                className={cn(v === 1 && 'text-positive bg-bg-inset')}
              >
                <ThumbsUp className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onVote(i, -1)}
                aria-label="Thumbs down"
                className={cn(v === -1 && 'text-accent bg-bg-inset')}
              >
                <ThumbsDown className="h-3.5 w-3.5" />
              </Button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
