'use client';

import { useState } from 'react';

type SpikeResult = {
  frames: number;
  durationMs: number;
  sizes: number[];
  inputBytes: number;
};

export default function Page() {
  const [result, setResult] = useState<SpikeResult | { error: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function onFile(file: File) {
    setBusy(true);
    setResult(null);
    const res = await fetch('/api/spike/frames', {
      method: 'POST',
      headers: { 'content-type': file.type },
      body: file,
    });
    const json = await res.json();
    setResult(json);
    setBusy(false);
  }

  return (
    <main>
      <h1>ffmpeg spike</h1>
      <p>Drop an MP4 or MOV (≤ 50 MB). Returns 8 in-memory JPEG sizes and elapsed ms.</p>
      <input
        type="file"
        accept="video/mp4,video/quicktime"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
      {busy && <p>processing…</p>}
      {result && <pre>{JSON.stringify(result, null, 2)}</pre>}
    </main>
  );
}
