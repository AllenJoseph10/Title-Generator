'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { VisionDescription } from './types';

type Props = {
  videoUrl: string;
  filename?: string;
  vision?: VisionDescription;
};

export function VideoPanel({ videoUrl, filename, vision }: Props) {
  const [framesOpen, setFramesOpen] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="relative overflow-hidden rounded-md border border-border bg-black aspect-[9/16] max-h-[560px] mx-auto w-full">
        <video
          src={videoUrl}
          controls
          playsInline
          className="h-full w-full object-contain"
        />
      </div>

      {filename && (
        <p className="text-xs text-ink-muted truncate font-mono">{filename}</p>
      )}

      {vision && (
        <div className="space-y-3 border-t border-border pt-4">
          <button
            type="button"
            onClick={() => setFramesOpen((v) => !v)}
            className="flex items-center gap-1.5 text-micro uppercase tracking-[0.12em] text-ink-muted hover:text-ink-dim transition-colors"
          >
            {framesOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            What the AI saw
          </button>
          <div
            className={cn(
              'overflow-hidden transition-all duration-200',
              framesOpen ? 'max-h-[400px] opacity-100' : 'max-h-0 opacity-0',
            )}
          >
            <dl className="space-y-3 text-sm">
              <Row label="Scene" value={vision.scene} />
              <Row label="Visual hook" value={vision.visualHook} />
              <Row label="Vibe" value={vision.vibe} />
            </dl>
          </div>
        </div>
      )}
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
