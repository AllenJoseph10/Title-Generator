'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { UploadDropzone } from '@/components/app/upload-dropzone';
import { VideoPanel, VisionSummary } from '@/components/app/video-panel';
import { ProcessingPanel } from '@/components/app/processing';
import { TitleList, type TitleListHandle } from '@/components/app/title-list';
import { HistoryRail } from '@/components/app/history-rail';
import { HistoryModal } from '@/components/app/history-modal';
import { RegenerateMenu } from '@/components/app/regenerate-menu';
import { ShortcutsHelp } from '@/components/app/shortcuts-help';
import type { GenerateResponse } from '@/components/app/types';
import { toast } from '@/components/ui/toaster';
import { useKeyboard } from '@/lib/hooks/use-keyboard';

// Anthropic only. The provider picker was removed from the UI — the API still
// accepts either, so this constant is the single place to change if the choice
// ever comes back.
const PROVIDER = 'anthropic';

export default function Page() {
  const [busy, setBusy] = useState<null | 'upload' | 'generate'>(null);
  const [storagePath, setStoragePath] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [lastSteering, setLastSteering] = useState<string>('');
  const [avoidTitles, setAvoidTitles] = useState<string[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const titleListRef = useRef<TitleListHandle>(null);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    },
    [],
  );

  const reset = () => {
    setResult(null);
    setStoragePath(null);
    setFilename(null);
    setLastSteering('');
    setAvoidTitles([]);
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setVideoUrl(null);
  };

  const upload = useCallback(async (file: File) => {
    reset();
    setBusy('upload');
    setFilename(file.name);

    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = URL.createObjectURL(file);
    setVideoUrl(objectUrlRef.current);

    // Both calls are wrapped because `fetch` rejects with a bare
    // `TypeError: Failed to fetch` on any network-level failure — dropped
    // connection, CORS, an unreachable storage host. Unwrapped, that escaped
    // this callback as an unhandled rejection: the app crashed to the error
    // overlay and `busy` stayed stuck on 'upload', wedging the UI. Naming the
    // stage in the message is what makes the next occurrence diagnosable.
    let signRes: Response;
    try {
      signRes = await fetch('/api/upload-url', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: file.name, mime: file.type, size: file.size }),
      });
    } catch {
      toast.error('Could not reach the server to start the upload. Check your connection.');
      setBusy(null);
      return;
    }
    if (!signRes.ok) {
      const j = (await signRes.json().catch(() => ({}))) as { error?: string };
      toast.error(j.error ?? `upload-url failed (${signRes.status})`);
      setBusy(null);
      return;
    }
    const { signedUrl, storagePath: path } = (await signRes.json()) as {
      signedUrl: string;
      storagePath: string;
    };

    let putRes: Response;
    try {
      putRes = await fetch(signedUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type },
        body: file,
      });
    } catch {
      toast.error('Upload to storage failed before it completed. Try again.');
      setBusy(null);
      return;
    }
    if (!putRes.ok) {
      toast.error(`Upload failed (${putRes.status})`);
      setBusy(null);
      return;
    }
    setStoragePath(path);
    setBusy(null);
  }, []);

  const generate = useCallback(
    async (steering = '') => {
      if (!storagePath) return;
      setBusy('generate');
      const clientRequestId = crypto.randomUUID();
      // Same reason as the upload calls: a network-level failure here rejects
      // rather than returning a response, and generation runs long enough that
      // a dropped connection is a realistic outcome.
      let res: Response;
      try {
        res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            client_request_id: clientRequestId,
            storage_path: storagePath,
            niche_id: 'luxury-menswear',
            creator_handle: 'william_j_wade',
            steering: steering || undefined,
            avoid_titles: avoidTitles,
            vision_provider: PROVIDER,
            generation_provider: PROVIDER,
          }),
        });
      } catch {
        toast.error('Lost the connection while generating. Nothing was charged twice — try again.');
        setBusy(null);
        return;
      }
      const json = await res.json().catch(() => ({}) as { error?: string });
      if (!res.ok) {
        toast.error(json.error ?? `Generate failed (${res.status})`);
        setBusy(null);
        return;
      }
      setResult(json as GenerateResponse);
      setLastSteering(steering);
      setHistoryKey((k) => k + 1);
      setBusy(null);
    },
    [storagePath, avoidTitles],
  );

  const onLogout = async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  };

  // Page-level keyboard shortcuts. Title-row shortcuts (↑↓ c 1-9) live in TitleList.
  useKeyboard(
    (e) => {
      if (e.key === '?') {
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }
      if (helpOpen || historyId) return;
      if (e.key === 'g' && !e.metaKey && !e.ctrlKey) {
        if (storagePath && !result && !busy) {
          e.preventDefault();
          generate();
        }
      } else if (e.key === 'r' && !e.metaKey && !e.ctrlKey) {
        if (result && !busy) {
          e.preventDefault();
          generate('');
        }
      }
    },
    [storagePath, result, busy, helpOpen, historyId, generate],
  );

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border">
        <div className="container flex h-14 items-center justify-between">
          <div className="flex items-baseline gap-3">
            <h1 className="font-display text-xl tracking-tight">Hook Title Generator</h1>
            <span className="text-micro uppercase tracking-[0.12em] text-ink-muted">w. j. wade</span>
          </div>
          <Button variant="ghost" size="sm" onClick={onLogout}>
            <LogOut className="h-4 w-4" />
            Log out
          </Button>
        </div>
      </header>

      <main className="container flex-1 py-8">
        {!videoUrl ? (
          <div className="max-w-2xl mx-auto pt-8">
            <UploadDropzone onFile={upload} busy={!!busy} />
          </div>
        ) : (
          // Keyed on the clip so picking a different video replays the entrance.
          <div
            key={videoUrl}
            className="grid grid-cols-1 lg:grid-cols-[minmax(0,400px)_1fr] gap-8 lg:gap-16"
          >
            <div className="animate-panel-in">
              <VideoPanel videoUrl={videoUrl} filename={filename ?? undefined} />
            </div>

            <div
              className="min-w-0 max-w-2xl animate-panel-in"
              style={{ animationDelay: '140ms' }}
            >
              {result ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3 flex-wrap min-w-0">
                      <p className="font-mono text-xs text-ink-muted tabular-nums">
                        {result.titles.length} titles · ${result.costUsd?.toFixed(4) ?? '–'} ·{' '}
                        {result.durationMs ? `${(result.durationMs / 1000).toFixed(1)}s` : '–'}
                        {result.idempotent ? ' · cached' : ''}
                      </p>
                      {lastSteering && (
                        <span className="text-micro uppercase tracking-[0.08em] text-gold border border-gold/40 px-2 py-0.5 truncate max-w-[220px]">
                          {summarizeSteering(lastSteering)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <RegenerateMenu onRegenerate={generate} busy={busy === 'generate'} />
                      <Button variant="ghost" size="sm" onClick={reset}>
                        New video
                      </Button>
                    </div>
                  </div>
                  <Separator />
                  <TitleList
                    key={result.id}
                    ref={titleListRef}
                    titles={result.titles}
                    generationId={result.id}
                    // Accumulate rather than replace: TitleList remounts on
                    // `key={result.id}` and loses its own vote state on
                    // regenerate, so the first vote on the new set would
                    // otherwise overwrite prior rejects instead of adding to
                    // them — letting an earlier reject come back. `reset()`
                    // clears this explicitly, and the server caps the list at
                    // MAX_AVOID_TITLES regardless of how large it grows here.
                    onDislikedChange={(next) =>
                      setAvoidTitles((prev) => [...new Set([...prev, ...next])])
                    }
                  />
                  {result.visionDescription && (
                    <VisionSummary vision={result.visionDescription} />
                  )}
                </div>
              ) : busy === 'generate' ? (
                <GeneratingState />
              ) : busy === 'upload' ? (
                <ProcessingPanel
                  eyebrow="Uploading"
                  title="Sending your clip"
                  steps={[
                    { label: 'Prepared', state: 'done' },
                    { label: 'Uploading', state: 'active' },
                    { label: 'Ready', state: 'pending' },
                  ]}
                />
              ) : (
                // Centred against the clip and inset from it, so the call to
                // action sits out on the page rather than crowding the video.
                <div className="flex h-full flex-col justify-center lg:pl-8">
                  <div className="space-y-9">
                    <div>
                      <p className="text-micro uppercase tracking-[0.14em] text-gold">Ready</p>
                      <h2 className="mt-4 font-display text-[2rem] leading-[1.12] tracking-[-0.01em] sm:text-[2.5rem]">
                        Generate titles for this clip
                      </h2>
                      <p className="mt-5 max-w-[46ch] text-lg text-ink-dim">
                        Ten are written and the five strongest are shown, ranked against titles
                        whose performance has already been measured.
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-7">
                      <Button
                        onClick={() => generate()}
                        disabled={!storagePath}
                        size="lg"
                        className="h-12 px-7 text-base"
                      >
                        <Sparkles className="h-4 w-4" />
                        Generate titles
                      </Button>
                      <button
                        onClick={reset}
                        className="text-sm text-ink-muted underline-offset-4 transition-colors hover:text-ink-dim hover:underline"
                      >
                        Choose a different video
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* No wrapper margin here: an empty history still reserved its spacing
            and pushed the page into a scroll. The rail owns its own top margin
            alongside its divider, so it costs nothing when it renders nothing. */}
        <HistoryRail onSelect={setHistoryId} refreshKey={historyKey} />
      </main>

      <HistoryModal generationId={historyId} onClose={() => setHistoryId(null)} />
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

function summarizeSteering(s: string): string {
  const head = s.split(/[.!]/)[0] ?? s;
  return head.replace(/^Be |^Lean |^Avoid |^Keep /, '').trim().slice(0, 28);
}

function GeneratingState() {
  return (
    <div className="space-y-8">
      {/* Generation is one round trip, so no stage can be reported as finished.
          The stages are listed as what the request is doing — none is marked
          done or active, because the client genuinely does not know. */}
      <ProcessingPanel
        eyebrow="Working"
        title="Reading your clip and writing titles"
        note="This usually takes 10–20 seconds."
        steps={[
          { label: 'Reading the clip', state: 'pending' },
          { label: 'Matching what worked', state: 'pending' },
          { label: 'Writing and ranking', state: 'pending' },
        ]}
      />
      <div className="space-y-3 animate-pulse">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="space-y-2 py-3 border-b border-border">
            <div className="h-5 w-3/4 bg-bg-raised rounded-sm" />
            <div className="h-3 w-32 bg-bg-raised/60 rounded-sm" />
          </div>
        ))}
      </div>
    </div>
  );
}
