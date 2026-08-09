import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db/client';
import { embed } from '@/lib/providers/openai/embedding';
import { prunableIds, LIKED_CAP_PER_CREATOR } from '@/lib/feedback/rules';
import { displayTitles } from '@/lib/generation/constants';

export const runtime = 'nodejs';

type Body = { generation_id?: unknown; title_index?: unknown; vote?: unknown };

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Body | null;
  if (
    !body ||
    typeof body.generation_id !== 'string' ||
    typeof body.title_index !== 'number' ||
    !Number.isInteger(body.title_index) ||
    body.title_index < 0 ||
    body.title_index > 99
  ) {
    return NextResponse.json({ error: 'generation_id (uuid), title_index (int) required' }, { status: 400 });
  }
  if (body.vote !== -1 && body.vote !== 1) {
    return NextResponse.json({ error: 'vote must be -1 or 1' }, { status: 400 });
  }

  const up = await db()
    .from('title_feedback')
    .upsert(
      { generation_id: body.generation_id, title_index: body.title_index, vote: body.vote },
      { onConflict: 'generation_id,title_index' },
    );
  if (up.error) return NextResponse.json({ error: up.error.message }, { status: 500 });

  if (body.vote === 1) {
    // Best-effort. A like that fails to index is a missed voice signal, not a
    // lost vote: the ledger row above already stands, and a thumbs-up must not
    // surface an error. But every step's `.error` IS checked and thrown here —
    // supabase-js returns errors rather than throwing them, so skipping that
    // check would let a failed write pass through silently, with the catch
    // below never firing and nothing logged anywhere.
    try {
      const gen = await db()
        .from('generations')
        .select('vision_description, generated_titles, generation_attempts(creator_handle, niche_id)')
        .eq('id', body.generation_id)
        .single();
      if (gen.error || !gen.data) throw new Error(gen.error?.message ?? 'generation not found');

      const attempt = gen.data.generation_attempts as unknown as {
        creator_handle: string | null;
        niche_id: string;
      };
      // The client only ever saw displayTitles(...) — sorted and sliced to 5 —
      // so title_index is an index into THAT list, not the raw 10-wide stored
      // array. Rows written before the ranking change landed are stored in
      // model-emission order, where the two orders diverge.
      const titles = displayTitles(
        gen.data.generated_titles as Array<{
          text: string;
          hookFamily: string;
          templateSimilarityPrior: number;
        }>,
      );
      const picked = titles[body.title_index];
      const vision = gen.data.vision_description as { scene: string; visualHook: string };
      if (!picked || !attempt?.creator_handle) throw new Error('missing title or creator_handle');

      // MUST match lib/generation/orchestrator.ts byte for byte, or these
      // vectors land in a different space from corpus_titles.description_embedding.
      const text = `${vision.scene} ${vision.visualHook}`.slice(0, 8000);
      const { vector } = await embed(text);

      const likedUp = await db().from('liked_titles').upsert(
        {
          generation_id: body.generation_id,
          title_index: body.title_index,
          creator_handle: attempt.creator_handle,
          niche_id: attempt.niche_id,
          title: picked.text,
          hook_family: picked.hookFamily,
          visual_description: text,
          description_embedding: vector as unknown as string,
        },
        { onConflict: 'generation_id,title_index' },
      );
      if (likedUp.error) throw new Error(likedUp.error.message);

      const existing = await db()
        .from('liked_titles')
        .select('id, created_at')
        .eq('creator_handle', attempt.creator_handle);
      if (existing.error) throw new Error(existing.error.message);
      const victims = prunableIds(existing.data ?? [], LIKED_CAP_PER_CREATOR);
      if (victims.length > 0) {
        const del = await db().from('liked_titles').delete().in('id', victims);
        if (del.error) throw new Error(del.error.message);
      }
    } catch (e) {
      console.warn(`feedback: like not indexed: ${(e as Error).message}`);
    }
  } else {
    // A flip from like to dislike must retract the earlier like, or
    // liked_titles keeps injecting a title into future prompts as
    // creator-approved after the ledger has recorded it as rejected. Same
    // best-effort contract as the like path: this must not error the response.
    try {
      const del = await db()
        .from('liked_titles')
        .delete()
        .eq('generation_id', body.generation_id)
        .eq('title_index', body.title_index);
      if (del.error) throw new Error(del.error.message);
    } catch (e) {
      console.warn(`feedback: like retraction failed: ${(e as Error).message}`);
    }
  }

  return NextResponse.json({ ok: true });
}
