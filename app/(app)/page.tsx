'use client';

import { useCallback, useState } from 'react';

type Title = {
  text: string;
  hookFamily: string;
  templateSimilarityPrior: number;
};

type GenerateResponse = {
  id: string;
  titles: Title[];
  costUsd?: number;
  durationMs?: number;
  idempotent?: boolean;
};

function priorBucket(p: number): 'low' | 'med' | 'high' {
  if (p >= 0.66) return 'high';
  if (p >= 0.33) return 'med';
  return 'low';
}

const BUCKET_COLOR = { high: '#22c55e', med: '#eab308', low: '#9ca3af' } as const;

export default function Page() {
  const [busy, setBusy] = useState<null | 'upload' | 'generate'>(null);
  const [error, setError] = useState<string | null>(null);
  const [storagePath, setStoragePath] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [votes, setVotes] = useState<Record<number, -1 | 1>>({});

  const upload = useCallback(async (file: File) => {
    setBusy('upload');
    setError(null);
    setResult(null);
    setVotes({});

    const signRes = await fetch('/api/upload-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: file.name, mime: file.type, size: file.size }),
    });
    if (!signRes.ok) {
      const j = (await signRes.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? `upload-url failed (${signRes.status})`);
      setBusy(null);
      return;
    }
    const { signedUrl, storagePath: path } = (await signRes.json()) as { signedUrl: string; storagePath: string };

    const putRes = await fetch(signedUrl, {
      method: 'PUT',
      headers: { 'content-type': file.type },
      body: file,
    });
    if (!putRes.ok) {
      const txt = await putRes.text().catch(() => '');
      setError(`upload failed (${putRes.status}): ${txt.slice(0, 200)}`);
      setBusy(null);
      return;
    }
    setStoragePath(path);
    setBusy(null);
  }, []);

  const generate = useCallback(async () => {
    if (!storagePath) return;
    setBusy('generate');
    setError(null);
    setResult(null);
    const clientRequestId = crypto.randomUUID();
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_request_id: clientRequestId,
        storage_path: storagePath,
        niche_id: 'luxury-menswear',
        creator_handle: 'william_j_wade',
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error ?? `generate failed (${res.status})`);
    } else {
      setResult(json as GenerateResponse);
    }
    setBusy(null);
  }, [storagePath]);

  const vote = useCallback(
    async (titleIndex: number, v: -1 | 1) => {
      if (!result) return;
      setVotes((prev) => ({ ...prev, [titleIndex]: v }));
      const r = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ generation_id: result.id, title_index: titleIndex, vote: v }),
      });
      if (!r.ok) setError(`feedback failed (${r.status})`);
    },
    [result],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files?.[0];
      if (f) upload(f);
    },
    [upload],
  );

  return (
    <main style={{ maxWidth: 760 }}>
      <h1>Title Generator</h1>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => document.getElementById('file-input')?.click()}
        style={{
          border: `2px dashed ${dragOver ? '#0070f3' : '#999'}`,
          background: dragOver ? '#f0f7ff' : 'transparent',
          padding: 32,
          borderRadius: 8,
          textAlign: 'center',
          cursor: busy ? 'wait' : 'pointer',
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy === 'upload'
          ? 'Uploading…'
          : storagePath
            ? `✓ Ready: ${storagePath.split('/').pop()}`
            : 'Drag a silent MP4 or MOV (≤ 50 MB) here'}
        <input
          id="file-input"
          type="file"
          accept="video/mp4,video/quicktime"
          style={{ display: 'none' }}
          disabled={!!busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
          }}
        />
      </div>

      {storagePath && !result && (
        <button
          onClick={generate}
          disabled={!!busy}
          style={{ marginTop: 16, padding: '10px 20px', fontSize: 15, cursor: busy ? 'wait' : 'pointer' }}
        >
          {busy === 'generate' ? 'Generating…' : 'Generate titles'}
        </button>
      )}

      {error && <p style={{ color: '#c00', marginTop: 16 }}>{error}</p>}

      {result && (
        <section style={{ marginTop: 24 }}>
          <p style={{ color: '#666', fontSize: 13 }}>
            {result.titles.length} titles · ${result.costUsd?.toFixed(4) ?? '–'} · {result.durationMs ?? '–'}ms
            {result.idempotent ? ' · (cached)' : ''}
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #ddd', textAlign: 'left', fontSize: 12, color: '#666' }}>
                <th style={{ padding: '6px 8px', width: 32 }}>#</th>
                <th style={{ padding: '6px 8px' }}>Title</th>
                <th style={{ padding: '6px 8px', width: 140 }}>Hook</th>
                <th style={{ padding: '6px 8px', width: 90 }}>Strength</th>
                <th style={{ padding: '6px 8px', width: 90 }}></th>
              </tr>
            </thead>
            <tbody>
              {result.titles.map((t, i) => {
                const bucket = priorBucket(t.templateSimilarityPrior);
                const v = votes[i];
                return (
                  <tr key={i} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: '8px 8px', color: '#999' }}>{i + 1}</td>
                    <td style={{ padding: '8px 8px' }}>{t.text}</td>
                    <td style={{ padding: '8px 8px', fontFamily: 'monospace', fontSize: 12, color: '#666' }}>{t.hookFamily}</td>
                    <td style={{ padding: '8px 8px' }}>
                      <span
                        style={{
                          background: BUCKET_COLOR[bucket],
                          color: '#fff',
                          padding: '2px 8px',
                          borderRadius: 4,
                          fontSize: 11,
                          textTransform: 'uppercase',
                        }}
                      >
                        {bucket}
                      </span>
                    </td>
                    <td style={{ padding: '8px 8px' }}>
                      <button
                        onClick={() => vote(i, 1)}
                        disabled={v === 1}
                        style={{ marginRight: 4, opacity: v === 1 ? 1 : 0.5 }}
                      >
                        👍
                      </button>
                      <button onClick={() => vote(i, -1)} disabled={v === -1} style={{ opacity: v === -1 ? 1 : 0.5 }}>
                        👎
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
