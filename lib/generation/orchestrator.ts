import 'server-only';
import { extractFrames } from '@/lib/media/frames';
import { probeVideo } from '@/lib/media/probe';
import { classifyCandidates } from '@/lib/hooks/classify';
import type { HookFamily } from '@/lib/hooks/taxonomy';
import type {
  GeneratedTitle,
  VisionDescription,
  VisionProvider,
  GenerationProvider,
  ProviderId,
} from '@/lib/providers/types';
import { anthropicVision } from '@/lib/providers/anthropic/vision';
import { anthropicGeneration } from '@/lib/providers/anthropic/generation';
import { embed, embedMany } from '@/lib/providers/openai/embedding';
import { retrieveAndRerank } from '@/lib/retrieval/search';
import { computeTitlePrior } from '@/lib/retrieval/prior';

const MAX_DURATION_SEC = 60;
const TARGET_FRAMES = 8;

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
  visionProviderId: ProviderId;
  generationProviderId: ProviderId;
  steering?: string;
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

  // Embed the query (scene + visual hook) and retrieve corpus neighbors.
  const queryText = `${visionRes.description.scene} ${visionRes.description.visualHook}`.slice(0, 8000);
  const queryEmbed = await embed(queryText).catch((e: Error) => {
    throw new PipelineError('vision', `embed query: ${e.message}`);
  });
  const retrieval = await retrieveAndRerank(input.nicheId, queryEmbed.vector).catch((e: Error) => {
    throw new PipelineError('vision', `retrieve: ${e.message}`);
  });

  const generator = selectGenerationProvider(input.generationProviderId);
  const genRes = await generator
    .generate({
      description: visionRes.description,
      nicheId: input.nicheId,
      styleBrief: input.styleBrief,
      retrievedExamples: retrieval.examples,
      styleFingerprint: input.styleFingerprint,
      requiredFamilies,
      steering: input.steering,
    })
    .catch((e: Error) => {
      throw new PipelineError('generate', e.message);
    });

  // Embed each generated title to compute prior vs neighbors. One batched call.
  let titles: GeneratedTitle[];
  let priorEmbedCostUsd = queryEmbed.costUsd;
  if (retrieval.neighbors.length > 0) {
    const titleEmbeds = await embedMany(genRes.titles.map((t) => t.text)).catch((e: Error) => {
      throw new PipelineError('generate', `embed titles: ${e.message}`);
    });
    priorEmbedCostUsd += titleEmbeds.reduce((s, e) => s + e.costUsd, 0);
    titles = genRes.titles.map((t, i) => ({
      text: t.text,
      hookFamily: t.hookFamily,
      templateSimilarityPrior: computeTitlePrior(titleEmbeds[i].vector, t.hookFamily, retrieval.neighbors),
    }));
  } else {
    // No corpus rows for this niche yet. Prior falls back to 0.5 for every title.
    titles = genRes.titles.map((t) => ({
      text: t.text,
      hookFamily: t.hookFamily,
      templateSimilarityPrior: 0.5,
    }));
  }

  const durationMs = Math.round(performance.now() - t0);
  const costUsd = visionRes.costUsd + genRes.costUsd + priorEmbedCostUsd;
  const tokensIn = visionRes.tokensIn + genRes.tokensIn + genRes.tokensInCacheRead + genRes.tokensInCacheWrite;
  const tokensOut = visionRes.tokensOut + genRes.tokensOut;

  return {
    visionDescription: visionRes.description,
    titles,
    retrievedCorpusIds: retrieval.examples.map((e) => e.id),
    costUsd,
    tokensIn,
    tokensOut,
    durationMs,
  };
}
