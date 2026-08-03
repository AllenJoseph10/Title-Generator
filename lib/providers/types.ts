import type { HookFamily } from '@/lib/hooks/taxonomy';

export type ProviderId = 'anthropic' | 'openai' | 'gemini';

export type VisionInput =
  | { kind: 'frames'; jpegs: Buffer[] }
  | { kind: 'video'; signedUrl: string; mimeType: string };

export type VisionDescription = {
  scene: string;
  subject: string;
  setting: string;
  vibe: string[];
  visualHook: string;
  rawJson: unknown;
};

export type CorpusTitle = {
  id: string;
  title: string;
  hookFamily: HookFamily;
  // Percentile rank (0-1) of the video's share rate across the corpus.
  // NULL means unmeasured, never zero. Formerly `saveRateEstimate` — saves
  // proved unobtainable from every source, see
  // docs/findings/2026-08-02-performance-metric-decision.md.
  performanceScore: number | null;
};

export type GeneratedTitle = {
  text: string;
  hookFamily: HookFamily;
  templateSimilarityPrior: number;
};

export type VisionPassResult = {
  description: VisionDescription;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
};

export type GenerationPassResult = {
  titles: Omit<GeneratedTitle, 'templateSimilarityPrior'>[];
  tokensIn: number;
  tokensInCacheRead: number;
  tokensInCacheWrite: number;
  tokensOut: number;
  costUsd: number;
};

export interface VisionProvider {
  id: ProviderId;
  needsFrames: boolean;
  describe(input: VisionInput): Promise<VisionPassResult>;
}

export type GenerateArgs = {
  description: VisionDescription;
  nicheId: string;
  styleBrief: string;
  retrievedExamples: CorpusTitle[];
  styleFingerprint: string[];
  requiredFamilies: HookFamily[];
  steering?: string;
};

export interface GenerationProvider {
  id: ProviderId;
  generate(args: GenerateArgs): Promise<GenerationPassResult>;
}
