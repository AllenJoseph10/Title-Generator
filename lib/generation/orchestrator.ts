import 'server-only';
import { extractFrames } from '@/lib/media/frames';
import { probeVideo } from '@/lib/media/probe';
import { classifyCandidates } from '@/lib/hooks/classify';
import type { HookFamily } from '@/lib/hooks/taxonomy';
import type {
  CorpusTitle,
  GeneratedTitle,
  VisionDescription,
  VisionProvider,
  GenerationProvider,
  ProviderId,
} from '@/lib/providers/types';
import { anthropicVision } from '@/lib/providers/anthropic/vision';
import { anthropicGeneration } from '@/lib/providers/anthropic/generation';

const MAX_DURATION_SEC = 60;
const TARGET_FRAMES = 8;
const PLACEHOLDER_PRIOR = 0.5; // Step 5 replaces this with real similarity math.

export function selectVisionProvider(id: ProviderId): VisionProvider {
  switch (id) {
    case 'anthropic':
      return anthropicVision;
    default:
      throw new Error(`vision provider not implemented: ${id}`);
  }
}

export function selectGenerationProvider(id: ProviderId): GenerationProvider {
  switch (id) {
    case 'anthropic':
      return anthropicGeneration;
    default:
      throw new Error(`generation provider not implemented: ${id}`);
  }
}

export type PipelineInput = {
  videoBytes: Buffer;
  nicheId: string;
  styleBrief: string;
  styleFingerprint: string[];
  retrievedExamples: CorpusTitle[];
  visionProviderId: ProviderId;
  generationProviderId: ProviderId;
};

export type PipelineResult = {
  visionDescription: VisionDescription;
  titles: GeneratedTitle[];
  retrievedCorpusIds: string[];
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
};

export type PipelineStage = 'probe' | 'frames' | 'vision' | 'classify' | 'generate' | 'persist';
export class PipelineError extends Error {
  constructor(readonly stage: PipelineStage, message: string) {
    super(message);
    this.name = 'PipelineError';
  }
}

export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const t0 = performance.now();

  const probe = await probeVideo(input.videoBytes).catch((e: Error) => {
    throw new PipelineError('probe', e.message);
  });
  if (!probe.hasVideoStream) throw new PipelineError('probe', 'no video stream');
  if (probe.durationSec > MAX_DURATION_SEC) {
    throw new PipelineError('probe', `duration ${probe.durationSec.toFixed(1)}s exceeds ${MAX_DURATION_SEC}s`);
  }

  const frames = await extractFrames(input.videoBytes, TARGET_FRAMES).catch((e: Error) => {
    throw new PipelineError('frames', e.message);
  });

  const vision = selectVisionProvider(input.visionProviderId);
  const visionRes = await vision.describe({ kind: 'frames', jpegs: frames }).catch((e: Error) => {
    throw new PipelineError('vision', e.message);
  });

  const requiredFamilies: HookFamily[] = classifyCandidates(
    visionRes.description.vibe,
    visionRes.description.visualHook,
  );

  const generator = selectGenerationProvider(input.generationProviderId);
  const genRes = await generator
    .generate({
      description: visionRes.description,
      nicheId: input.nicheId,
      styleBrief: input.styleBrief,
      retrievedExamples: input.retrievedExamples,
      styleFingerprint: input.styleFingerprint,
      requiredFamilies,
    })
    .catch((e: Error) => {
      throw new PipelineError('generate', e.message);
    });

  const titles: GeneratedTitle[] = genRes.titles.map((t) => ({
    text: t.text,
    hookFamily: t.hookFamily,
    templateSimilarityPrior: PLACEHOLDER_PRIOR,
  }));

  const durationMs = Math.round(performance.now() - t0);
  const costUsd = visionRes.costUsd + genRes.costUsd;
  const tokensIn = visionRes.tokensIn + genRes.tokensIn + genRes.tokensInCacheRead + genRes.tokensInCacheWrite;
  const tokensOut = visionRes.tokensOut + genRes.tokensOut;

  return {
    visionDescription: visionRes.description,
    titles,
    retrievedCorpusIds: input.retrievedExamples.map((e) => e.id),
    costUsd,
    tokensIn,
    tokensOut,
    durationMs,
  };
}
