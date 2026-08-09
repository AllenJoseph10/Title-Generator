'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { VisionDescription } from './types';

type Props = {
  videoUrl: string;
  filename?: string;
};

// Assumed until the real one is measured. Most clips are 9:16, so this is the
// shape the box holds for the moment before metadata arrives.
const FALLBACK_RATIO = 9 / 16;

// The left column is the clip and nothing else. Everything written about the
// clip — what the model saw, the controls, the titles — lives in the right
// column, so the two sides read as "the video" and "what we did with it".
export function VideoPanel({ videoUrl, filename }: Props) {
  // The box used to be hardcoded to 9:16, which is wrong for any clip that
  // isn't: Instagram feed video is 4:5, and reposted or screen-recorded footage
  // can be anything. object-contain then fitted the clip inside the wrong shape,
  // so it rendered small and narrow inside thick black bars. Read the real ratio
  // off the element instead. The parent keys this component on the clip URL, so
  // this resets to the fallback when a different video is picked.
  const [ratio, setRatio] = useState(FALLBACK_RATIO);

  return (
    // The wrapper spans the column and both children centre themselves within
    // it, which keeps the caption under the video. It must NOT be `w-fit`: the
    // box's width below is a percentage, and resolving that against a
    // shrink-to-fit parent whose width comes from the box is circular — measured
    // in Chrome, it collapses the box to about 1px.
    <div className="flex flex-col gap-3">
      {/* Width-driven, so aspect-ratio always derives the height and the clip
          can never letterbox. Two caps bound it on both axes: the column's own
          width, and the height budget below that keeps the page from scrolling.
          A landscape clip therefore shrinks rather than overflowing. */}
      <div
        className="relative mx-auto overflow-hidden rounded-md border border-border bg-black"
        style={{
          aspectRatio: String(ratio),
          width: `min(100%, calc(min(560px, 100vh - 11rem) * ${ratio}))`,
        }}
      >
        <video
          src={videoUrl}
          controls
          playsInline
          crossOrigin="anonymous"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            // videoWidth/videoHeight are DISPLAY dimensions — the browser has
            // already applied the rotation matrix, so portrait footage stored as
            // a rotated landscape frame reports portrait here.
            if (v.videoWidth > 0 && v.videoHeight > 0) setRatio(v.videoWidth / v.videoHeight);
          }}
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
