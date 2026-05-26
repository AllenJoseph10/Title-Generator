'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

type Props = {
  videoEl: HTMLVideoElement | null;
  title: string;
  open: boolean;
};

// Snapshot the current frame of the live <video>, then render the title
// on top in a style similar to burned-in TikTok/Reels titles.
export function BurnInPreview({ videoEl, title, open }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!open || !videoEl || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    if (!vw || !vh) {
      setReady(false);
      return;
    }
    // Aim for 9:16 frame, target 270x480 logical px.
    const targetW = 270;
    const targetH = Math.round((targetW * vh) / vw);
    canvas.width = targetW * 2; // retina
    canvas.height = targetH * 2;
    canvas.style.width = `${targetW}px`;
    canvas.style.height = `${targetH}px`;
    ctx.scale(2, 2);

    try {
      ctx.drawImage(videoEl, 0, 0, targetW, targetH);
    } catch {
      setReady(false);
      return;
    }

    // Title overlay — centered, two lines max, Inter Bold uppercase white with drop shadow.
    const fontSize = 18;
    ctx.font = `700 ${fontSize}px var(--font-inter), system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const words = title.split(/\s+/);
    const lines = layoutLines(ctx, words, targetW - 32, 3);
    const lineHeight = fontSize * 1.15;
    const blockHeight = lines.length * lineHeight;
    const startY = targetH / 2 - blockHeight / 2 + lineHeight / 2;

    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = '#ffffff';
    lines.forEach((line, i) => {
      ctx.fillText(line.toUpperCase(), targetW / 2, startY + i * lineHeight);
    });

    setReady(true);
  }, [open, videoEl, title]);

  if (!open) return null;

  return (
    <div
      role="tooltip"
      className={cn(
        'pointer-events-none absolute right-0 -top-2 z-30 -translate-y-full',
        'rounded-md border border-border bg-bg-raised p-2 shadow-xl animate-fade-in',
      )}
    >
      <canvas ref={canvasRef} className="rounded-sm bg-black" />
      <p className="mt-2 text-micro uppercase tracking-[0.12em] text-ink-muted text-center">
        {ready ? 'Burn-in preview' : 'Loading frame…'}
      </p>
    </div>
  );
}

function layoutLines(
  ctx: CanvasRenderingContext2D,
  words: string[],
  maxWidth: number,
  maxLines: number,
): string[] {
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const tentative = current ? `${current} ${w}` : w;
    if (ctx.measureText(tentative.toUpperCase()).width <= maxWidth) {
      current = tentative;
    } else {
      if (current) lines.push(current);
      current = w;
      if (lines.length >= maxLines) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines;
}
