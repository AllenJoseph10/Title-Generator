import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db/client';
import { BUCKET } from '@/lib/storage/constants';
import { SESSION_COOKIE, verifySession, sessionHash } from '@/lib/auth/passcode';
import { runPipeline, PipelineError, type PipelineResult } from '@/lib/generation/orchestrator';
import type { ProviderId } from '@/lib/providers/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

const RATE_LIMIT_PER_DAY = 20;

type Body = {
  client_request_id?: unknown;
  storage_path?: unknown;
  niche_id?: unknown;
  creator_handle?: unknown;
  vision_provider?: unknown;
  generation_provider?: unknown;
};

export async function POST(req: NextRequest) {
  const sessionToken = req.cookies.get(SESSION_COOKIE)?.value ?? '';
  const session = await verifySession(sessionToken);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const sessHash = await sessionHash(sessionToken);

  const body = (await req.json().catch(() => null)) as Body | null;
  if (
    !body ||
    typeof body.client_request_id !== 'string' ||
    typeof body.storage_path !== 'string' ||
    typeof body.niche_id !== 'string'
  ) {
    return NextResponse.json(
      { error: 'client_request_id, storage_path, niche_id required' },
      { status: 400 },
    );
  }
  const visionProvider: ProviderId = (body.vision_provider as ProviderId) ?? 'anthropic';
  const generationProvider: ProviderId = (body.generation_provider as ProviderId) ?? 'anthropic';
  const creatorHandle = typeof body.creator_handle === 'string' ? body.creator_handle : null;

  // Idempotency: if a generation already exists for this client_request_id, return it.
  const existing = await db()
    .from('generations')
    .select('id, generated_titles, vision_description, retrieved_corpus_ids, cost_usd, duration_ms')
    .eq('client_request_id', body.client_request_id)
    .maybeSingle();
  if (existing.error) {
    return NextResponse.json({ error: `db: ${existing.error.message}` }, { status: 500 });
  }
  if (existing.data) {
    return NextResponse.json({
      id: existing.data.id,
      titles: existing.data.generated_titles,
      idempotent: true,
    });
  }

  // Rate limit on session attempts (success or failure) in last 24h.
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const rate = await db()
    .from('generation_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('passcode_session_hash', sessHash)
    .gte('started_at', since);
  if (rate.error) {
    return NextResponse.json({ error: `db: ${rate.error.message}` }, { status: 500 });
  }
  if ((rate.count ?? 0) >= RATE_LIMIT_PER_DAY) {
    return NextResponse.json({ error: 'rate limit: 20 generations per 24h' }, { status: 429 });
  }

  // Look up niche + fingerprint.
  const niche = await db()
    .from('niches')
    .select('id, style_brief')
    .eq('id', body.niche_id)
    .maybeSingle();
  if (niche.error) return NextResponse.json({ error: niche.error.message }, { status: 500 });
  if (!niche.data) return NextResponse.json({ error: `unknown niche_id: ${body.niche_id}` }, { status: 400 });

  let styleFingerprint: string[] = [];
  if (creatorHandle) {
    const fp = await db()
      .from('creator_style_fingerprints')
      .select('best_titles')
      .eq('creator_handle', creatorHandle)
      .maybeSingle();
    if (fp.error) return NextResponse.json({ error: fp.error.message }, { status: 500 });
    if (fp.data) styleFingerprint = fp.data.best_titles ?? [];
  }

  // Log the attempt BEFORE doing real work. Generations row only on success.
  const attempt = await db()
    .from('generation_attempts')
    .insert({
      client_request_id: body.client_request_id,
      storage_path: body.storage_path,
      niche_id: body.niche_id,
      vision_provider: visionProvider,
      generation_provider: generationProvider,
      passcode_session_hash: sessHash,
    })
    .select('id')
    .single();
  if (attempt.error) {
    return NextResponse.json({ error: `attempt: ${attempt.error.message}` }, { status: 500 });
  }
  const attemptId: string = attempt.data.id;

  // Download from Storage via direct REST (SDK's .download() is flaky on Node 20).
  const dlUrl = `${process.env.SUPABASE_URL}/storage/v1/object/${BUCKET}/${body.storage_path}`;
  const dlRes = await fetch(dlUrl, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
      authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''}`,
    },
  });
  if (!dlRes.ok) {
    const txt = await dlRes.text().catch(() => '');
    await markFailure(attemptId, 'persist', `download ${dlRes.status}: ${txt.slice(0, 200)}`);
    return NextResponse.json({ error: `storage download ${dlRes.status}` }, { status: 400 });
  }
  const videoBytes = Buffer.from(await dlRes.arrayBuffer());

  let result: PipelineResult;
  try {
    result = await runPipeline({
      videoBytes,
      nicheId: niche.data.id,
      styleBrief: niche.data.style_brief,
      styleFingerprint,
      visionProviderId: visionProvider,
      generationProviderId: generationProvider,
    });
  } catch (e) {
    const err = e as PipelineError | Error;
    const stage = err instanceof PipelineError ? err.stage : 'generate';
    await markFailure(attemptId, stage, err.message);
    return NextResponse.json({ error: `${stage}: ${err.message}` }, { status: 500 });
  }

  const ins = await db().from('generations').insert({
    id: attemptId,
    client_request_id: body.client_request_id,
    vision_description: result.visionDescription,
    retrieved_corpus_ids: result.retrievedCorpusIds,
    generated_titles: result.titles,
    cost_usd: result.costUsd,
    tokens_in: result.tokensIn,
    tokens_out: result.tokensOut,
    duration_ms: result.durationMs,
  });
  if (ins.error) {
    await markFailure(attemptId, 'persist', ins.error.message);
    return NextResponse.json({ error: `persist: ${ins.error.message}` }, { status: 500 });
  }

  return NextResponse.json({
    id: attemptId,
    titles: result.titles,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
  });
}

async function markFailure(attemptId: string, stage: string, message: string): Promise<void> {
  await db()
    .from('generation_attempts')
    .update({ failed_at: new Date().toISOString(), failure_stage: stage, failure_message: message.slice(0, 2000) })
    .eq('id', attemptId);
}
