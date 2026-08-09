'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { VisionDescription } from './types';

type Props = {
  videoUrl: string;
  filename?: string;
  onVideoMount?: (el: HTMLVideoElement | null) => void;
};

// The left column is the clip and nothing else. Everything written about the
// clip — what the model saw, the controls, the titles — lives in the right
// column, so the two sides read as "the video" and "what we did with it".
export function VideoPanel({ videoUrl, filename, onVideoMount }: Props) {
  return (
    // The wrapper shrinks to the clip's width so the caption sits directly
    // under the video. Previously the video was centred in the column while the
    // filename was left-aligned to the column, leaving it stranded to one side.
    <div className="mx-auto flex w-fit max-w-full flex-col gap-3">
      {/* Height drives the size, width follows from 9:16. Previously width
          drove it and max-height clamped the box, which both letterboxed the
          clip and made it tall enough to push the page into a scroll. The
          viewport cap keeps the whole panel visible without scrolling — see the
          budget in the comment below. */}
      <div className="relative aspect-[9/16] h-[min(560px,calc(100vh-11rem))] max-w-full overflow-hidden rounded-md border border-border bg-black">
        <video
          src={videoUrl}
          controls
          playsInline
          crossOrigin="anonymous"
          ref={onVideoMount}
          className="h-full w-full object-contain"
        />
      </div>

      {/* 11rem budget = header 3.5rem + main padding 4rem + this caption and its
          gap ~3.5rem. Anything taller and the page starts scrolling again. */}
      {filename && (
        <p className="truncate text-center font-mono text-xs text-ink-muted">{filename}</p>
      )}
    </div>
  );
}

export function VisionSummary({ vision }: { vision: VisionDescription }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-micro uppercase tracking-[0.12em] text-ink-muted hover:text-ink-dim transition-colors"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        What the AI saw
      </button>
      <div
        className={cn(
          'overflow-hidden transition-all duration-200',
          open ? 'max-h-[400px] opacity-100' : 'max-h-0 opacity-0',
        )}
      >
        <dl className="space-y-3 text-sm">
          <Row label="Scene" value={vision.scene} />
          <Row label="Visual hook" value={vision.visualHook} />
          <Row
            label="Vibe"
            value={Array.isArray(vision.vibe) ? vision.vibe.join(' · ') : vision.vibe}
          />
        </dl>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[80px_1fr] gap-3">
      <dt className="text-micro uppercase tracking-[0.08em] text-ink-muted pt-0.5">{label}</dt>
      <dd className="text-sm text-ink-dim text-balance">{value}</dd>
    </div>
  );
}
