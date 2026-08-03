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
  performance_score: number | null;
  view_outlier_score: number | null;
  creator_handle: string | null;
  visual_description: string | null;
  // TITLE-space vector. The RPC ranks on description_embedding but returns
  // this one, because MMR must diversify the chosen examples as titles —
  // eight different scenes whose hooks are phrased identically would be
  // useless as few-shot prompts.
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

  const picked = reranked.map((r) => r.item);
  const known = picked.filter((r) => isHookFamily(r.hook_family));
  // This filter drops rows silently, which is how an import that wrote an
  // unrecognised hook_family would surface as "the model just got worse"
  // rather than as an error. Say so instead.
  if (known.length < picked.length) {
    const bad = [...new Set(picked.filter((r) => !isHookFamily(r.hook_family)).map((r) => r.hook_family))];
    console.warn(
      `retrieve: dropped ${picked.length - known.length} of ${picked.length} corpus rows with ` +
        `unrecognised hook_family: ${bad.join(', ')}. Check the importer against lib/hooks/taxonomy.ts.`,
    );
  }

  const examples: CorpusTitle[] = known.map((r) => ({
    id: r.id,
    title: r.title,
    hookFamily: r.hook_family as CorpusTitle['hookFamily'],
    performanceScore: r.performance_score,
  }));

  return { examples, neighbors: reranked.map((r) => r.item) };
}
