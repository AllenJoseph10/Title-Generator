'use client';

import { useCallback, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Upload } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rejectUpload } from '@/lib/storage/constants';
import { toast } from '@/components/ui/toaster';

type Props = {
  onFile: (file: File) => void;
  busy?: boolean;
};

export function UploadDropzone({ onFile, busy }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reject here rather than letting /api/upload-url do it. The server check
  // stays as the real gate — this one exists so the user is told immediately,
  // in a message that names the limit, instead of after a round trip.
  const accept = useCallback(
    (f: File) => {
      const problem = rejectUpload(f.size, f.type);
      if (problem) {
        toast.error(problem);
        return;
      }
      onFile(f);
    },
    [onFile],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f) accept(f);
    },
    [accept],
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      whileHover={busy ? undefined : { scale: 1.005 }}
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
      {/* "up to 60s" alone was misleading: 4K/60 phone footage runs ~48 Mbps
          and hits the 50 mb cap in about 8 seconds, so the size limit binds
          long before the duration one. Naming the resolution makes the pair
          reachable rather than aspirational. */}
      <p className="text-micro uppercase tracking-[0.12em] text-ink-muted">
        mp4 or mov · ≤ 50 mb · up to 60s at 1080p
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,video/quicktime"
        disabled={busy}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) accept(f);
          // Clear it, so re-picking the same file after a rejection still fires.
          e.target.value = '';
        }}
      />
    </motion.div>
  );
}
