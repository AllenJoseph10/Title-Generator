'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { PipelineAnimation } from '@/components/landing/pipeline-animation';

const REASONS = [
  {
    heading: 'Ranked, not guessed',
    body: 'Every suggestion is scored against the measured performance of real titles, so the order carries information. You are not reading five equally confident guesses.',
  },
  {
    heading: 'It has seen what failed, too',
    body: 'The reference set includes videos that underperformed, marked as such. A model that has only ever been shown winners has no reference for a weak line.',
  },
  {
    heading: 'Built for silent video',
    body: 'These are burned-in titles — the text you type over the clip — not captions and not a spoken hook. The whole pipeline is tuned for that one job.',
  },
];

export default function LandingPage() {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passcode: token }),
    });
    if (res.ok) {
      window.location.href = '/';
      return;
    }
    setError('That access token was not recognised. Check it and try again.');
    setBusy(false);
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-border">
        <div className="mx-auto max-w-[1180px] px-6 py-6">
          <h1 className="font-display text-2xl leading-none tracking-tight text-ink sm:text-3xl">
            Hook Title Generator
          </h1>
        </div>
      </header>

      <main className="mx-auto max-w-[1180px] px-6 pb-24 pt-12 sm:pt-16">
        <div className="grid gap-x-16 gap-y-14 lg:grid-cols-[minmax(0,1fr)_352px] lg:items-start">
          {/* ---- Hero (left column, row 1) ---- */}
          <section className="lg:col-start-1 lg:row-start-1">
            <h2 className="font-display text-[2.125rem] leading-[1.07] tracking-[-0.02em] text-balance sm:text-[2.875rem]">
              The words on screen decide who stops scrolling.
            </h2>
            <p className="mt-6 max-w-[48ch] text-lg text-ink-dim">
              Drop in a silent clip. Get five burned-in title ideas, each ranked against real
              titles whose performance has already been measured.
            </p>
          </section>

          {/* ---- Access (right column, sticky) ---- */}
          <aside className="lg:sticky lg:top-8 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start">
            <div className="border border-border bg-bg-raised p-6">
              <p className="text-micro uppercase tracking-[0.12em] text-gold">Early access</p>
              <h2 className="mt-3 font-display text-xl leading-snug text-ink">
                Enter your access token
              </h2>
              <form onSubmit={onSubmit} className="mt-4 space-y-3">
                {/* The heading above already names this field, so the label is
                    visually hidden rather than repeated on screen. */}
                <label htmlFor="access-token" className="sr-only">
                  Access token
                </label>
                <input
                  id="access-token"
                  type="text"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Paste your token"
                  autoFocus
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? 'access-token-error' : undefined}
                  className="h-14 w-full rounded-md border border-border bg-bg px-4 font-sans text-lg text-ink outline-none transition-colors placeholder:text-ink-muted focus:border-gold/60"
                />
                <Button type="submit" disabled={busy || !token} size="lg" className="w-full">
                  {busy ? 'Checking…' : 'Enter'}
                </Button>
                {error && (
                  <p id="access-token-error" role="alert" className="pt-1 text-sm text-accent">
                    {error}
                  </p>
                )}
              </form>
            </div>

            <p className="mt-4 border-l-2 border-border-strong py-1 pl-4 text-sm text-ink-muted">
              This is a beta. What you are testing does not reflect the finished product — the
              output, the features and the design are all subject to change.
            </p>
          </aside>

          {/* ---- How it works + why (left column, row 2) ---- */}
          <div className="lg:col-start-1 lg:row-start-2">
            <section>
              <div className="mb-6 flex items-center gap-4">
                <h3 className="text-micro uppercase tracking-[0.14em] text-ink-muted">
                  How it works
                </h3>
                <span className="h-px flex-1 bg-border" />
              </div>
              <PipelineAnimation />
            </section>

            <section className="mt-16">
              <div className="mb-6 flex items-center gap-4">
                <h3 className="text-micro uppercase tracking-[0.14em] text-ink-muted">
                  Why it helps
                </h3>
                <span className="h-px flex-1 bg-border" />
              </div>
              <dl className="grid gap-px bg-border sm:grid-cols-3">
                {REASONS.map((r) => (
                  <div key={r.heading} className="bg-bg p-5 pt-6">
                    <dt className="font-display text-lg leading-snug text-ink">{r.heading}</dt>
                    <dd className="mt-2 text-sm text-ink-dim">{r.body}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
