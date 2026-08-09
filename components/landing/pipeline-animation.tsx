'use client';

// The landing page's signature element: a looping, staged demonstration of the
// real pipeline. It is not decoration — each stage shows what actually happens
// (eight sampled frames, matching against corpus rows whose performance is
// measured, ten generated and five displayed), so a tester recognises the
// product once they are inside.
//
// Motion is CSS keyframes, not a JS animation library. Everything here is a
// one-shot entrance on mount, and every stage change remounts its subtree via
// `key`, so a stage can never be left holding a half-applied animation. Reduced
// motion is handled globally in app/globals.css.
//
// The viewport is aria-hidden; the stage captions below it are real buttons and
// carry the same information, so the section works without the animation.

import { useEffect, useState } from 'react';

const STAGES = [
  {
    n: '01',
    label: 'Drop in a clip',
    caption:
      'A silent video, up to 60 seconds. It is trimmed, downscaled and stripped of audio in your browser before it uploads.',
    ms: 3200,
  },
  {
    n: '02',
    label: 'The clip gets read',
    caption:
      'Eight frames are sampled across the video and described — the scene, the subject, the setting, the mood.',
    ms: 4200,
  },
  {
    n: '03',
    label: 'Matched against what already worked',
    caption:
      'That description is compared against real videos from creators in the same space, where every title already carries a measured performance.',
    ms: 4600,
  },
  {
    n: '04',
    label: 'Five ranked ideas',
    caption:
      'Ten titles are written, the five strongest are shown, strongest first. Pick the one you would post.',
    ms: 5000,
  },
] as const;

// Each stage is lit by its own wash, so the panel never sits on flat black and
// the colour tells you where you are: champagne while the clip is being read
// and matched, oxblood once the ranking lands.
const STAGE_WASH = [
  'bg-[radial-gradient(75%_85%_at_28%_50%,rgba(201,169,110,0.10),transparent_72%)]',
  'bg-[radial-gradient(80%_90%_at_34%_50%,rgba(201,169,110,0.20),transparent_72%)]',
  'bg-[radial-gradient(90%_95%_at_52%_50%,rgba(201,169,110,0.17),transparent_74%)]',
  'bg-[radial-gradient(95%_95%_at_58%_50%,rgba(163,36,52,0.30),transparent_74%)]',
];

const WINNING_TITLE = 'The coat that does all the work';

const DESCRIPTION_CHIPS = ['tailored wool overcoat', 'city street, dusk', 'unhurried, understated'];

const CORPUS_ROWS = [
  { handle: '@m.iles', title: 'Anyone can go from this:', score: 0.91, landed: true },
  { handle: '@budrys.jr', title: 'The £40 jacket everyone swears is designer', score: 0.78, landed: true },
  { handle: '@hqfran', title: 'Me and my 3 personalities:', score: 0.61, landed: true },
  { handle: '@aligordon', title: 'A guide to autumn outerwear', score: 0.11, landed: false },
];

const RANKED = [
  { title: WINNING_TITLE, strength: 'high' },
  { title: 'POV: you finally dress like the person you are becoming', strength: 'high' },
  { title: 'Me pretending this was a casual outfit choice', strength: 'med' },
  { title: '3 ways to wear grey without looking boring', strength: 'med' },
  { title: 'Autumn layering, done properly', strength: 'low' },
] as const;

const STRENGTH = {
  high: { dot: 'bg-positive', text: 'text-positive', label: 'Strong' },
  med: { dot: 'bg-gold', text: 'text-gold', label: 'Fair' },
  low: { dot: 'bg-ink-muted', text: 'text-ink-muted', label: 'Weak' },
} as const;

const PANEL_HEADINGS = [
  'Your clip',
  'What the model sees',
  'Titles that already ran',
  'Five ranked ideas',
];

export function PipelineAnimation() {
  const [stage, setStage] = useState(0);
  const [cycle, setCycle] = useState(0);
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    if (!playing) return;
    const id = setTimeout(() => {
      setStage((s) => {
        const next = (s + 1) % STAGES.length;
        if (next === 0) setCycle((c) => c + 1);
        return next;
      });
    }, STAGES[stage].ms);
    return () => clearTimeout(id);
  }, [stage, playing]);

  return (
    <div>
      <div
        aria-hidden
        className="relative h-[380px] overflow-hidden border border-border bg-bg-raised sm:h-[430px]"
      >
        {/* Stage wash — remounted per stage so it fades in. */}
        <div
          key={`wash-${stage}`}
          className={`absolute inset-0 animate-fade-in ${STAGE_WASH[stage]}`}
          style={{ animationDuration: '600ms' }}
        />
        {/* Faint measure grid, so the field behind the composition is not flat. */}
        <div className="absolute inset-0 bg-[radial-gradient(circle,rgba(245,240,230,0.05)_1px,transparent_1px)] bg-[length:22px_22px]" />
        <FrameTicks />

        <div className="relative flex h-full items-center justify-center gap-5 px-4 sm:gap-9 sm:px-9">
          <div className="shrink-0">
            <Clip stage={stage} cycle={cycle} />
          </div>

          {/* Auto height, vertically centred: a fixed box left the shorter
              stages hanging from the top with dead space beneath them. */}
          <div key={stage} className="relative w-full min-w-0 max-w-[196px] sm:max-w-[400px]">
            <div className="mb-3 flex animate-rise-in items-center gap-3">
              <p className="text-micro uppercase tracking-[0.12em] text-gold">
                {PANEL_HEADINGS[stage]}
              </p>
              <span className="h-px flex-1 bg-gold/25" />
            </div>
            <PanelBody stage={stage} />
          </div>
        </div>
      </div>

      <ol className="mt-px">
        {STAGES.map((s, i) => {
          const active = i === stage;
          return (
            <li key={s.n}>
              <button
                type="button"
                onClick={() => {
                  setPlaying(false);
                  setStage(i);
                }}
                aria-current={active ? 'step' : undefined}
                className={[
                  'group relative block w-full border-l-2 py-4 pl-4 pr-2 text-left transition-colors',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold',
                  active ? 'border-gold bg-bg-raised/60' : 'border-border hover:border-border-strong',
                ].join(' ')}
              >
                <div className="flex items-baseline gap-3">
                  <span
                    className={`font-mono text-micro tabular-nums transition-colors ${
                      active ? 'text-gold' : 'text-ink-muted'
                    }`}
                  >
                    {s.n}
                  </span>
                  <span
                    className={`font-display text-lg leading-tight transition-colors ${
                      active ? 'text-ink' : 'text-ink-dim'
                    }`}
                  >
                    {s.label}
                  </span>
                </div>
                <p
                  className={`mt-1.5 pl-[calc(0.75rem+2ch)] text-sm transition-colors ${
                    active ? 'text-ink-dim' : 'text-ink-muted'
                  }`}
                >
                  {s.caption}
                </p>

                {active && playing && (
                  <span
                    key={`${i}-${cycle}`}
                    style={{ animationDuration: `${s.ms}ms`, animationTimingFunction: 'linear' }}
                    className="absolute bottom-0 left-0 h-px w-full origin-left animate-grow-x bg-gold/50"
                  />
                )}
              </button>
            </li>
          );
        })}
      </ol>

      {!playing && (
        <button
          type="button"
          onClick={() => {
            setStage(0);
            setCycle((c) => c + 1);
            setPlaying(true);
          }}
          className="mt-4 text-micro uppercase tracking-[0.12em] text-ink-muted underline-offset-4 transition-colors hover:text-ink-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-gold"
        >
          Play the sequence
        </button>
      )}
    </div>
  );
}

/* ---------- pieces ---------- */

// Registration marks rather than a rounded card — the subject is video, and the
// product's identity is editorial, not SaaS.
function FrameTicks() {
  const corner = 'absolute h-3 w-3 border-ink-faint';
  return (
    <>
      <span className={`${corner} left-2 top-2 border-l border-t`} />
      <span className={`${corner} right-2 top-2 border-r border-t`} />
      <span className={`${corner} bottom-2 left-2 border-b border-l`} />
      <span className={`${corner} bottom-2 right-2 border-b border-r`} />
    </>
  );
}

function Clip({ stage, cycle }: { stage: number; cycle: number }) {
  return (
    <div className="relative">
      {stage === 0 && (
        <span className="pointer-events-none absolute -inset-3 animate-fade-in border border-dashed border-gold/40" />
      )}

      <div
        // Remounting on entry to stage 01 replays the drop.
        key={stage === 0 ? `drop-${cycle}` : 'clip'}
        className={[
          'relative h-[210px] w-[118px] overflow-hidden rounded-sm bg-[#1c1719] shadow-[0_18px_50px_-12px_rgba(0,0,0,0.9)] ring-1 ring-ink/10 sm:h-[268px] sm:w-[151px]',
          stage === 0 ? 'animate-drop-in' : '',
        ].join(' ')}
      >
        {/* An abstract standing figure — enough to read as "a video of a person" */}
        <div className="absolute inset-0 bg-[radial-gradient(115%_75%_at_50%_12%,#5c4733_0%,#2b2124_48%,#121013_100%)]" />
        <div className="absolute left-1/2 top-[21%] h-[15px] w-[15px] -translate-x-1/2 rounded-full bg-[#e8d5bb]/25 sm:h-[19px] sm:w-[19px]" />
        <div className="absolute left-1/2 top-[34%] h-[54%] w-[40px] -translate-x-1/2 rounded-t-[16px] bg-[#e8d5bb]/[0.16] sm:w-[52px]" />
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-black/70 to-transparent" />

        {stage === 1 && (
          <>
            <div className="absolute inset-x-0 h-12 animate-sweep bg-gradient-to-b from-transparent via-gold/50 to-transparent" />
            <div className="absolute inset-x-1.5 bottom-1.5 flex gap-[3px]">
              {Array.from({ length: 8 }).map((_, i) => (
                <span
                  key={i}
                  style={{ animationDelay: `${i * 90}ms` }}
                  className="h-[3px] flex-1 animate-rise-in bg-gold"
                />
              ))}
            </div>
          </>
        )}

        {/* The payoff: the winning line burned into the frame, which is the
            product's entire output. */}
        {stage === 3 && (
          <p
            style={{ animationDelay: '520ms' }}
            className="absolute inset-x-2.5 bottom-8 animate-rise-in text-center text-[11px] font-semibold leading-[1.25] text-white [text-shadow:0_1px_4px_rgba(0,0,0,0.95)] sm:text-[13px]"
          >
            {WINNING_TITLE}
          </p>
        )}
      </div>
    </div>
  );
}

function PanelBody({ stage }: { stage: number }) {
  if (stage === 0) return <DropBody />;
  if (stage === 1) return <DescriptionBody />;
  if (stage === 2) return <CorpusBody />;
  return <RankedBody />;
}

function DropBody() {
  return (
    <div style={{ animationDelay: '120ms' }} className="animate-rise-in">
      <p className="font-mono text-sm text-gold">clip.mp4</p>
      <p className="mt-1.5 font-mono text-[11px] text-ink-dim">14s · 1080×1920 · no audio</p>
      <p className="mt-4 text-[13px] leading-relaxed text-ink-dim">
        Trimmed, downscaled and stripped of audio in the browser before it uploads.
      </p>
    </div>
  );
}

function DescriptionBody() {
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {DESCRIPTION_CHIPS.map((c, i) => (
          <span
            key={c}
            style={{ animationDelay: `${150 + i * 180}ms` }}
            className="animate-rise-in rounded-sm border border-gold/35 bg-gold/[0.07] px-2.5 py-1.5 text-[12px] text-ink"
          >
            {c}
          </span>
        ))}
      </div>
      <p
        style={{ animationDelay: '750ms' }}
        className="mt-4 animate-rise-in font-mono text-[11px] text-ink-dim"
      >
        8 frames sampled
      </p>
    </>
  );
}

function CorpusBody() {
  return (
    <ul className="space-y-2.5">
      {CORPUS_ROWS.map((r, i) => (
        <li
          key={r.handle}
          style={{ animationDelay: `${100 + i * 130}ms` }}
          className={`animate-rise-in ${r.landed ? '' : 'opacity-50'}`}
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-[10px] text-ink-muted">{r.handle}</span>
            {r.landed ? (
              <span className="font-mono text-[10px] tabular-nums text-gold">
                {Math.round(r.score * 100)}
              </span>
            ) : (
              <span className="text-[10px] uppercase tracking-[0.1em] text-accent-hover">
                did not land
              </span>
            )}
          </div>
          <p
            className={`text-[12px] leading-snug ${
              r.landed ? 'text-ink' : 'text-ink-muted line-through'
            }`}
          >
            {r.title}
          </p>
          <div className="mt-1.5 h-[3px] w-full bg-bg-inset">
            <span
              style={{ width: `${r.score * 100}%`, animationDelay: `${260 + i * 130}ms` }}
              className={`block h-full origin-left animate-grow-x ${
                r.landed ? 'bg-gold' : 'bg-accent'
              }`}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function RankedBody() {
  return (
    <ul className="space-y-1.5">
      {RANKED.map((r, i) => {
        const s = STRENGTH[r.strength];
        return (
          <li
            key={r.title}
            style={{ animationDelay: `${100 + i * 120}ms` }}
            className={[
              'flex animate-rise-in items-start gap-2.5 border-l-2 py-1.5 pl-2.5 pr-2',
              i === 0 ? 'border-accent-hover bg-accent-subtle' : 'border-border',
            ].join(' ')}
          >
            <span className={`mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} />
            <span
              className={`min-w-0 flex-1 text-[12px] leading-snug ${
                i === 0 ? 'text-ink' : 'text-ink-dim'
              }`}
            >
              {r.title}
            </span>
            <span
              className={`shrink-0 pt-[2px] text-[9px] uppercase tracking-[0.1em] ${s.text}`}
            >
              {s.label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
