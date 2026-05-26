'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

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
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-10">
          <h1 className="font-display text-3xl tracking-tight text-ink">Title Generator</h1>
          <p className="text-micro uppercase tracking-[0.12em] text-ink-muted mt-2">
            Private · single tenant
          </p>
        </div>
        <form onSubmit={onSubmit} className="space-y-4">
          <input
            type="password"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            placeholder="passcode"
            autoFocus
            className="w-full h-11 px-4 bg-bg-raised border border-border focus:border-ink-muted rounded-md text-ink placeholder:text-ink-muted outline-none transition-colors"
          />
          <Button type="submit" disabled={busy || !passcode} size="lg" className="w-full">
            {busy ? '…' : 'Enter'}
          </Button>
          {error && <p className="text-sm text-accent text-center pt-1">{error}</p>}
        </form>
      </div>
    </main>
  );
}
