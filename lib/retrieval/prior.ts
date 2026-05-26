import { cosineSimilarity } from './mmr';
import type { HookFamily } from '@/lib/hooks/taxonomy';

const FALLBACK_PRIOR = 0.5;
const NEAREST_K = 5;
const FAMILY_PRIOR_BLEND = 0.3; // 30% weight on family-level prior, 70% on neighbors.

export type CorpusNeighbor = {
  hook_family: string;
  save_rate_estimate: number | null;
  embedding: number[];
};

// Compute the templateSimilarityPrior for one generated title.
// Definition: mean save_rate_estimate of the K nearest corpus neighbors to the
// generated title's embedding, blended with the average save_rate_estimate of
// the title's own hook_family (so we still produce a reasonable signal when
// neighbors are sparse).
export function computeTitlePrior(
  generatedEmbedding: number[],
  generatedFamily: HookFamily,
  neighbors: CorpusNeighbor[],
): number {
  if (neighbors.length === 0) return FALLBACK_PRIOR;

  const scored = neighbors
    .filter((n) => n.embedding && n.embedding.length === generatedEmbedding.length)
    .map((n) => ({
      similarity: cosineSimilarity(generatedEmbedding, n.embedding),
      saveRate: n.save_rate_estimate,
    }));
  if (scored.length === 0) return FALLBACK_PRIOR;

  scored.sort((a, b) => b.similarity - a.similarity);
  const top = scored.slice(0, NEAREST_K).filter((s) => s.saveRate !== null);
  const neighborMean = top.length > 0
    ? top.reduce((s, x) => s + (x.saveRate ?? 0), 0) / top.length
    : FALLBACK_PRIOR;

  const familyRates = neighbors.filter((n) => n.hook_family === generatedFamily && n.save_rate_estimate !== null);
  const familyMean = familyRates.length > 0
    ? familyRates.reduce((s, n) => s + (n.save_rate_estimate ?? 0), 0) / familyRates.length
    : neighborMean;

  const blended = (1 - FAMILY_PRIOR_BLEND) * neighborMean + FAMILY_PRIOR_BLEND * familyMean;
  return clamp01(blended);
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return FALLBACK_PRIOR;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// Map a numeric prior to a UI bucket per spec ("not a decimal score").
export type PriorBucket = 'low' | 'med' | 'high';
export function priorToBucket(prior: number): PriorBucket {
  if (prior >= 0.66) return 'high';
  if (prior >= 0.33) return 'med';
  return 'low';
}
