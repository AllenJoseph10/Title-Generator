'use client';

import { useCallback, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { cn } from '@/lib/utils';

type Props = {
  onFile: (file: File) => void;
  busy?: boolean;
};

export function UploadDropzone({ onFile, busy }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f) onFile(f);
    },
    [onFile],
  );

  return (
    <div
      onClick={() => !busy && inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={cn(
        'relative flex flex-col items-center justify-center gap-6 rounded-md border border-dashed transition-all',
        'min-h-[340px] px-12 py-16 cursor-pointer select-none',
        dragOver
          ? 'border-accent bg-accent-subtle/30'
          : 'border-border-strong hover:border-ink-muted hover:bg-bg-raised/40',
        busy && 'pointer-events-none opacity-50',
      )}
    >
      <Upload className="h-6 w-6 text-ink-dim" strokeWidth={1.25} />
      <div className="text-center">
        <p className="font-display text-2xl text-ink">Drop a silent clip</p>
        <p className="font-display text-2xl text-ink-dim italic">to generate titles</p>
      </div>
      <p className="text-micro uppercase tracking-[0.12em] text-ink-muted">
        mp4 or mov · up to 60s · ≤ 50 mb
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,video/quicktime"
        disabled={busy}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
    </div>
  );
}
