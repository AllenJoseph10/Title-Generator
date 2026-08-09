import 'server-only';
import { extractFrames } from '@/lib/media/frames';
import { probeVideo } from '@/lib/media/probe';
import { classifyCandidates, familiesFromNeighbours } from '@/lib/hooks/classify';
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
import { openaiVision } from '@/lib/providers/openai/vision';
import { openaiGeneration } from '@/lib/providers/openai/generation';
import { embed, embedMany } from '@/lib/providers/openai/embedding';
import { retrieveAndRerank } from '@/lib/retrieval/search';
import { computeTitlePrior } from '@/lib/retrieval/prior';
import { matchLikedTitles } from '@/lib/retrieval/liked';

const MAX_DURATION_SEC = 60;
const TARGET_FRAMES = 8;

// Re-exported for callers that already import from the orchestrator. The
// definition (and the `displayTitles` read-path helper) lives in
// ./constants so lightweight API routes can reach it without this module's
// `server-only` + ffmpeg + provider-SDK graph.
export { DISPLAY_COUNT } from './constants';

export function selectVisionProvider(id: ProviderId): VisionProvider {
  switch (id) {
    case 'anthropic':
      return anthropicVision;
    case 'openai':
      return openaiVision;
    default:
      throw new Error(`vision provider not implemented: ${id}`);
  }
}

export function selectGenerationProvider(id: ProviderId): GenerationProvider {
  switch (id) {
    case 'anthropic':
      return anthropicGeneration;
    case 'openai':
      return openaiGeneration;
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
  creatorHandle: string;
  avoidTitles?: string[];
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

  // Embed the query (scene + visual hook) and retrieve corpus neighbors.
  const queryText = `${visionRes.description.scene} ${visionRes.description.visualHook}`.slice(0, 8000);
  const queryEmbed = await embed(queryText).catch((e: Error) => {
    throw new PipelineError('vision', `embed query: ${e.message}`);
  });
  const retrieval = await retrieveAndRerank(input.nicheId, queryEmbed.vector).catch((e: Error) => {
    throw new PipelineError('vision', `retrieve: ${e.message}`);
  });

  // A failure here must not cost the user their generation: kept titles are a
  // nudge, and the corpus examples above are the real signal.
  const likedTitles = await matchLikedTitles(input.creatorHandle, queryEmbed.vector).catch(
    (e: Error) => {
      console.warn(`liked retrieve failed, continuing without: ${e.message}`);
      return [];
    },
  );

  // Which hook families the generator must cover, derived from the videos
  // retrieval actually found similar. This runs after retrieval by necessity:
  // it reads the neighbours' labels.
  //
  // classifyCandidates remains only as the cold-start fallback, for a niche
  // with no corpus yet. It is a keyword matcher over vibe adjectives, and an
  // audit against the 175 labelled rows found it returned the same three
  // families for 83% of them (scripts/audit-family-selector.ts).
  const requiredFamilies: HookFamily[] =
    retrieval.examples.length > 0
      ? familiesFromNeighbours(retrieval.examples)
      : classifyCandidates(visionRes.description.vibe, visionRes.description.visualHook);

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
      likedTitles,
      avoidTitles: input.avoidTitles,
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

  // Nothing downstream sorted these before, so the app's "ranked" titles were
  // in model-emission order and the prior only painted a badge. Ordering here
  // is what makes the prior load-bearing. Ties keep emission order.
  titles.sort((a, b) => b.templateSimilarityPrior - a.templateSimilarityPrior);

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
