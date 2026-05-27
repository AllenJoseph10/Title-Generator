'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, LogOut, Keyboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { UploadDropzone } from '@/components/app/upload-dropzone';
import { VideoPanel } from '@/components/app/video-panel';
import { TitleList, type TitleListHandle } from '@/components/app/title-list';
import { HistoryRail } from '@/components/app/history-rail';
import { HistoryModal } from '@/components/app/history-modal';
import { RegenerateMenu } from '@/components/app/regenerate-menu';
import { ShortcutsHelp } from '@/components/app/shortcuts-help';
import { ProviderToggle, type Provider } from '@/components/app/provider-toggle';
import type { GenerateResponse } from '@/components/app/types';
import { toast } from '@/components/ui/toaster';
import { useKeyboard } from '@/lib/hooks/use-keyboard';

export default function Page() {
  const [busy, setBusy] = useState<null | 'upload' | 'generate'>(null);
  const [storagePath, setStoragePath] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [lastSteering, setLastSteering] = useState<string>('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [provider, setProvider] = useState<Provider>('anthropic');
  const titleListRef = useRef<TitleListHandle>(null);

  // Load saved provider preference on mount.
  useEffect(() => {
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem('provider') : null;
    if (saved === 'anthropic' || saved === 'openai') setProvider(saved);
  }, []);

  const updateProvider = (p: Provider) => {
    setProvider(p);
    if (typeof window !== 'undefined') window.localStorage.setItem('provider', p);
  };
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
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setVideoUrl(null);
    setVideoEl(null);
  };

  const upload = useCallback(async (file: File) => {
    reset();
    setBusy('upload');
    setFilename(file.name);

    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    objectUrlRef.current = URL.createObjectURL(file);
    setVideoUrl(objectUrlRef.current);

    const signRes = await fetch('/api/upload-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: file.name, mime: file.type, size: file.size }),
    });
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

    const putRes = await fetch(signedUrl, {
      method: 'PUT',
      headers: { 'content-type': file.type },
      body: file,
    });
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
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_request_id: clientRequestId,
          storage_path: storagePath,
          niche_id: 'luxury-menswear',
          creator_handle: 'william_j_wade',
          steering: steering || undefined,
          vision_provider: provider,
          generation_provider: provider,
        }),
      });
      const json = await res.json();
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
    [storagePath, provider],
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
            <h1 className="font-display text-xl tracking-tight">Title Generator</h1>
            <span className="text-micro uppercase tracking-[0.12em] text-ink-muted">w. j. wade</span>
          </div>
          <div className="flex items-center gap-3">
            <ProviderToggle value={provider} onChange={updateProvider} disabled={busy === 'generate'} />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setHelpOpen(true)}
              aria-label="Keyboard shortcuts"
            >
              <Keyboard className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={onLogout} aria-label="Log out">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="container flex-1 py-8">
        {!videoUrl ? (
          <div className="max-w-2xl mx-auto pt-8">
            <UploadDropzone onFile={upload} busy={!!busy} />
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,400px)_1fr] gap-8 lg:gap-10">
            <div>
              <VideoPanel
                videoUrl={videoUrl}
                filename={filename ?? undefined}
                vision={result?.visionDescription}
                onVideoMount={setVideoEl}
              />
              {!result && storagePath && (
                <Button onClick={() => generate()} disabled={!!busy} size="lg" className="w-full mt-6">
                  <Sparkles className="h-4 w-4" />
                  {busy === 'generate' ? 'Generating…' : 'Generate titles'}
                </Button>
              )}
              {!result && !busy && (
                <button
                  onClick={reset}
                  className="mt-4 text-xs text-ink-muted hover:text-ink-dim underline-offset-2 hover:underline w-full text-center"
                >
                  Choose a different video
                </button>
              )}
            </div>

            <div className="min-w-0 max-w-2xl">
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
                    ref={titleListRef}
                    titles={result.titles}
                    generationId={result.id}
                    videoEl={videoEl}
                  />
                </div>
              ) : busy === 'generate' ? (
                <GeneratingState />
              ) : (
                <div className="flex h-full items-center justify-center text-ink-muted text-sm italic min-h-[300px]">
                  Press Generate to see 10 ranked titles
                </div>
              )}
            </div>
          </div>
        )}

        <div className="mt-16">
          <Separator />
          <div className="pt-6">
            <HistoryRail onSelect={setHistoryId} refreshKey={historyKey} />
          </div>
        </div>
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
    <div className="space-y-4 animate-pulse">
      <div className="h-4 w-48 bg-bg-raised rounded-sm" />
      <div className="space-y-3 pt-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="space-y-2 py-3 border-b border-border">
            <div className="h-5 w-3/4 bg-bg-raised rounded-sm" />
            <div className="h-3 w-32 bg-bg-raised/60 rounded-sm" />
          </div>
        ))}
      </div>
    </div>
  );
}
