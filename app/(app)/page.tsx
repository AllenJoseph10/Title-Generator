'use client';

import { useCallback, useState } from 'react';

type Uploaded = { storagePath: string; sizeBytes: number; filename: string };

export default function Page() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<Uploaded | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const upload = useCallback(async (file: File) => {
    setBusy(true);
    setError(null);
    setUploaded(null);

    const signRes = await fetch('/api/upload-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: file.name, mime: file.type, size: file.size }),
    });
    if (!signRes.ok) {
      const j = (await signRes.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? `upload-url failed (${signRes.status})`);
      setBusy(false);
      return;
    }
    const { signedUrl, storagePath } = (await signRes.json()) as { signedUrl: string; storagePath: string };

    const putRes = await fetch(signedUrl, {
      method: 'PUT',
      headers: { 'content-type': file.type },
      body: file,
    });
    if (!putRes.ok) {
      const txt = await putRes.text().catch(() => '');
      setError(`upload failed (${putRes.status}): ${txt.slice(0, 200)}`);
      setBusy(false);
      return;
    }

    setUploaded({ storagePath, sizeBytes: file.size, filename: file.name });
    setBusy(false);
  }, []);

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
    <main>
      <h1>Title Generator</h1>
      <p style={{ color: '#666' }}>Drop a silent MP4 or MOV (≤ 50 MB).</p>
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
          padding: 48,
          borderRadius: 8,
          textAlign: 'center',
          cursor: 'pointer',
        }}
      >
        {busy ? 'Uploading…' : 'Drag a video here or click to choose'}
        <input
          id="file-input"
          type="file"
          accept="video/mp4,video/quicktime"
          style={{ display: 'none' }}
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
          }}
        />
      </div>
      {error && <p style={{ color: '#c00', marginTop: 16 }}>{error}</p>}
      {uploaded && (
        <section style={{ marginTop: 16 }}>
          <p style={{ color: '#080' }}>✓ Uploaded {uploaded.filename} ({Math.round(uploaded.sizeBytes / 1024)} KB)</p>
          <p style={{ fontFamily: 'monospace', fontSize: 12 }}>storage_path: {uploaded.storagePath}</p>
        </section>
      )}
    </main>
  );
}
