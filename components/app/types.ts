export type Title = {
  text: string;
  hookFamily: string;
  templateSimilarityPrior: number;
};

export type VisionDescription = {
  scene: string;
  vibe: string;
  visualHook: string;
  durationSec?: number;
};

export type GenerateResponse = {
  id: string;
  titles: Title[];
  visionDescription?: VisionDescription;
  storagePath?: string;
  costUsd?: number;
  durationMs?: number;
  idempotent?: boolean;
};

export type HistoryItem = {
  id: string;
  createdAt: string;
  storagePath: string;
  topTitle: string;
  sceneSummary: string;
};

export type Strength = 'low' | 'med' | 'high';

export function priorBucket(p: number): Strength {
  if (p >= 0.66) return 'high';
  if (p >= 0.33) return 'med';
  return 'low';
}

export const STRENGTH_VARIANT = {
  high: 'positive',
  med: 'warning',
  low: 'neutral',
} as const;
