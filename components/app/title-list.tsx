'use client';

import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Copy, Check, ThumbsUp, ThumbsDown, Eye } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toaster';
import { cn } from '@/lib/utils';
import { BurnInPreview } from './burn-in-preview';
import { useKeyboard } from '@/lib/hooks/use-keyboard';
import {
  priorBucket,
  STRENGTH_VARIANT,
  type Title,
} from './types';

type Props = {
  titles: Title[];
  generationId: string;
  videoEl?: HTMLVideoElement | null;
};

export type TitleListHandle = {
  copy: (index: number) => void;
  focusFirst: () => void;
};

export const TitleList = forwardRef<TitleListHandle, Props>(function TitleList(
  { titles, generationId, videoEl },
  ref,
) {
  const [copied, setCopied] = useState<number | null>(null);
  const [votes, setVotes] = useState<Record<number, -1 | 1>>({});
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number>(0);
  const rowRefs = useRef<Array<HTMLLIElement | null>>([]);

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

  useImperativeHandle(ref, () => ({
    copy: (i: number) => {
      const t = titles[i];
      if (t) onCopy(i, t.text);
    },
    focusFirst: () => rowRefs.current[0]?.focus(),
  }));

  const focusRow = (i: number) => {
    const next = Math.max(0, Math.min(titles.length - 1, i));
    rowRefs.current[next]?.focus();
    setFocusedIndex(next);
  };

  useKeyboard(
    (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        focusRow(focusedIndex + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        focusRow(focusedIndex - 1);
      } else if (e.key === 'c' && !e.metaKey && !e.ctrlKey) {
        const t = titles[focusedIndex];
        if (t) {
          e.preventDefault();
          onCopy(focusedIndex, t.text);
        }
      } else if (/^[1-9]$/.test(e.key)) {
        const idx = parseInt(e.key, 10) - 1;
        const t = titles[idx];
        if (t) {
          e.preventDefault();
          onCopy(idx, t.text);
        }
      } else if (e.key === 'Escape') {
        if (previewIndex !== null) {
          e.preventDefault();
          setPreviewIndex(null);
        }
      }
    },
    [focusedIndex, titles, previewIndex],
  );

  return (
    <motion.ol
      className="divide-y divide-border"
      initial="hidden"
      animate="visible"
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: 0.04 } },
      }}
    >
      {titles.map((t, i) => {
        const bucket = priorBucket(t.templateSimilarityPrior);
        const v = votes[i];
        return (
          <motion.li
            key={i}
            ref={(el) => {
              rowRefs.current[i] = el;
            }}
            tabIndex={0}
            onFocus={() => setFocusedIndex(i)}
            variants={{
              hidden: { opacity: 0, y: 6 },
              visible: { opacity: 1, y: 0, transition: { duration: 0.22, ease: 'easeOut' } },
            }}
            className={cn(
              'group relative grid grid-cols-[28px_1fr_auto] gap-4 py-4 items-start outline-none',
              'focus-visible:bg-bg-raised/60 rounded-sm -mx-2 px-2 transition-colors',
              focusedIndex === i && 'bg-bg-raised/30',
            )}
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

            <div className="flex items-center gap-1 md:opacity-60 md:group-hover:opacity-100 transition-opacity">
              {videoEl && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setPreviewIndex((p) => (p === i ? null : i))}
                  aria-label="Preview burn-in"
                  className={cn(previewIndex === i && 'text-ink bg-bg-inset')}
                >
                  <Eye className="h-3.5 w-3.5" />
                </Button>
              )}
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
            {videoEl && <BurnInPreview videoEl={videoEl} title={t.text} open={previewIndex === i} />}
          </motion.li>
        );
      })}
    </motion.ol>
  );
});
