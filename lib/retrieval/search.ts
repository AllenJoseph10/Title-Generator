import 'server-only';
import { db } from '@/lib/db/client';
import type { CorpusTitle } from '@/lib/providers/types';
import { isHookFamily } from '@/lib/hooks/taxonomy';
import { mmrRerank, type MmrCandidate } from './mmr';

const RPC_LIMIT = 30;
const FINAL_K = 8;
const MMR_LAMBDA = 0.6; // Slight tilt toward diversity over pure relevance.

export type RetrievedRow = {
  id: string;
  title: string;
  hook_family: string;
  save_rate_estimate: number | null;
  embedding: number[];
  similarity: number;
};

export type RetrievalResult = {
  examples: CorpusTitle[];
  neighbors: RetrievedRow[]; // top-K after MMR, kept for prior computation
};

export async function retrieveAndRerank(
  nicheId: string,
  queryEmbedding: number[],
): Promise<RetrievalResult> {
  const rpc = await db().rpc('match_corpus_titles', {
    p_niche_id: nicheId,
    p_query_embed: queryEmbedding as unknown as string, // pgvector accepts JSON array
    p_match_limit: RPC_LIMIT,
  });
  if (rpc.error) throw new Error(`retrieve: ${rpc.error.message}`);
  const rows = (rpc.data ?? []) as Array<RetrievedRow & { embedding: number[] | string }>;
  if (rows.length === 0) return { examples: [], neighbors: [] };

  // pgvector may return embeddings as a string like "[0.1,0.2,...]" via PostgREST.
  const normalized = rows.map((r): RetrievedRow => ({
    ...r,
    embedding: typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding,
  }));

  const candidates: MmrCandidate<RetrievedRow>[] = normalized.map((r) => ({
    item: r,
    relevance: r.similarity,
    embedding: r.embedding,
  }));
  const reranked = mmrRerank(candidates, FINAL_K, MMR_LAMBDA);

  const examples: CorpusTitle[] = reranked
    .map((r) => r.item)
    .filter((r) => isHookFamily(r.hook_family))
    .map((r) => ({
      id: r.id,
      title: r.title,
      hookFamily: r.hook_family as CorpusTitle['hookFamily'],
      saveRateEstimate: r.save_rate_estimate,
    }));

  return { examples, neighbors: reranked.map((r) => r.item) };
}
