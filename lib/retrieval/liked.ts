import 'server-only';
import { db } from '@/lib/db/client';
import type { LikedTitle } from '@/lib/providers/types';
import { aboveFloor } from '@/lib/feedback/rules';
import { LIKED_MATCH_LIMIT, LIKED_MIN_SIMILARITY } from './constants';

type Row = {
  title: string;
  hook_family: string;
  visual_description: string;
  similarity: number;
};

// Reuses the query vector the orchestrator already computed for corpus
// retrieval — no extra embedding call on the generation path.
export async function matchLikedTitles(
  creatorHandle: string,
  queryEmbedding: number[],
): Promise<LikedTitle[]> {
  const rpc = await db().rpc('match_liked_titles', {
    p_creator_handle: creatorHandle,
    p_query_embed: queryEmbedding as unknown as string, // pgvector accepts a JSON array
    p_match_limit: LIKED_MATCH_LIMIT,
  });
  if (rpc.error) throw new Error(`liked retrieve: ${rpc.error.message}`);

  return aboveFloor((rpc.data ?? []) as Row[], LIKED_MIN_SIMILARITY)
    .map((r) => ({
      title: r.title,
      hookFamily: r.hook_family,
      visualDescription: r.visual_description,
    }));
}
