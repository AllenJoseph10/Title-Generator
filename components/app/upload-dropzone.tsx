'use client';

import { useCallback, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Upload } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rejectUpload } from '@/lib/storage/constants';
import { prepareUpload } from '@/lib/media/prepare-upload';
import { IndeterminateBar } from './processing';
import { toast } from '@/components/ui/toaster';

type Props = {
  onFile: (file: File) => void;
  busy?: boolean;
};

export function UploadDropzone({ onFile, busy }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Prepare first, then gate. A 79MB 4K clip shrinks to a couple of MB and
  // passes a check it would otherwise fail; a file that cannot be prepared
  // arrives at exactly the same gate it meets today.
  //
  // rejectUpload stays the real client-side check — the server runs it too.
  // It exists so the user is told immediately, in a message that names the
  // limit, rather than after a round trip.
  const accept = useCallback(
    async (f: File) => {
      setPreparing(true);
      let candidate = f;
      try {
        candidate = await prepareUpload(f);
      } finally {
        setPreparing(false);
      }
      const problem = rejectUpload(candidate.size, candidate.type);
      if (problem) {
        toast.error(problem);
        return;
      }
      onFile(candidate);
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
      whileHover={busy || preparing ? undefined : { scale: 1.005 }}
      onClick={() => !busy && !preparing && inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy && !preparing) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={cn(
        'relative flex flex-col items-center justify-center gap-6 rounded-md border border-dashed transition-all',
        'min-h-[340px] px-12 py-16 cursor-pointer select-none',
        preparing
          ? 'border-gold/40 bg-gold/[0.04]'
          : dragOver
            ? 'border-accent bg-accent-subtle/30'
            : 'border-border-strong hover:border-ink-muted hover:bg-bg-raised/40',
        (busy || preparing) && 'pointer-events-none',
      )}
    >
      {preparing ? (
        // Dimming the whole panel read as "disabled" rather than "working".
        // This replaces it with something that is visibly doing a job.
        <div className="flex animate-rise-in flex-col items-center gap-5 text-center">
          <p className="font-display text-2xl text-ink">Preparing your clip</p>
          <IndeterminateBar />
        </div>
      ) : (
        <>
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
        </>
      )}
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
