'use client';

import { useState } from 'react';

export default function LoginPage() {
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passcode }),
    });
    if (res.ok) {
      window.location.href = '/';
      return;
    }
    setError('Invalid passcode');
    setBusy(false);
  }

  return (
    <main style={{ maxWidth: 360 }}>
      <h1>Sign in</h1>
      <form onSubmit={onSubmit}>
        <input
          type="password"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          placeholder="passcode"
          autoFocus
          style={{ width: '100%', padding: 8, fontSize: 16 }}
        />
        <button type="submit" disabled={busy || !passcode} style={{ marginTop: 12, padding: '8px 16px' }}>
          {busy ? '…' : 'Enter'}
        </button>
        {error && <p style={{ color: '#c00', marginTop: 12 }}>{error}</p>}
      </form>
    </main>
  );
}
