'use client';

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { VideoPanel } from './video-panel';
import { TitleList } from './title-list';
import type { GenerateResponse } from './types';

type Props = {
  generationId: string | null;
  onClose: () => void;
};

type DetailResponse = GenerateResponse & {
  signedUrl?: string | null;
  createdAt?: string;
};

export function HistoryModal({ generationId, onClose }: Props) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!generationId) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/generation/${generationId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`load failed (${r.status})`);
        return (await r.json()) as DetailResponse;
      })
      .then((j) => {
        if (!cancelled) setData(j);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [generationId]);

  return (
    <Dialog open={!!generationId} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-5xl w-[92vw] max-h-[90vh] overflow-y-auto">
        <DialogTitle className="sr-only">Past generation</DialogTitle>
        {error && <p className="text-sm text-accent">{error}</p>}
        {!data && !error && (
          <div className="py-12 text-center text-sm text-ink-muted italic">Loading…</div>
        )}
        {data && (
          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,360px)_1fr] gap-8 pt-2">
            <div>
              {data.signedUrl ? (
                <VideoPanel videoUrl={data.signedUrl} vision={data.visionDescription} onVideoMount={setVideoEl} />
              ) : (
                <div className="rounded-md border border-border bg-bg-inset h-72 flex items-center justify-center text-xs text-ink-muted italic">
                  Video unavailable
                </div>
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-center justify-between mb-4">
                <p className="font-display text-xl text-ink">{data.titles?.length ?? 0} titles</p>
                <p className="font-mono text-xs text-ink-muted tabular-nums">
                  {data.createdAt ? new Date(data.createdAt).toLocaleString() : ''}
                </p>
              </div>
              {data.titles && <TitleList titles={data.titles} generationId={data.id} videoEl={videoEl} />}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
