import 'server-only';
import OpenAI from 'openai';
import { openaiEmbeddingCost } from '../pricing';

const MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIM = 1536;

let client: OpenAI | null = null;
function openai(): OpenAI {
  if (client) return client;
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY must be set');
  client = new OpenAI({ apiKey: key });
  return client;
}

export type EmbeddingResult = {
  vector: number[];
  tokens: number;
  costUsd: number;
};

export async function embed(text: string): Promise<EmbeddingResult> {
  const res = await openai().embeddings.create({ model: MODEL, input: text });
  const vector = res.data[0]?.embedding;
  if (!vector || vector.length !== EMBEDDING_DIM) {
    throw new Error(`embedding: expected ${EMBEDDING_DIM} dims, got ${vector?.length}`);
  }
  const tokens = res.usage.total_tokens;
  return { vector, tokens, costUsd: openaiEmbeddingCost(MODEL, tokens) };
}

export async function embedMany(texts: string[]): Promise<EmbeddingResult[]> {
  if (texts.length === 0) return [];
  const res = await openai().embeddings.create({ model: MODEL, input: texts });
  // OpenAI guarantees order matches input.
  const tokens = res.usage.total_tokens;
  const perCallCost = openaiEmbeddingCost(MODEL, tokens);
  // Apportion cost roughly evenly across inputs (only used for forensics, not billing).
  const perInputCost = perCallCost / texts.length;
  return res.data.map((d) => {
    if (!d.embedding || d.embedding.length !== EMBEDDING_DIM) {
      throw new Error(`embedding: bad dim ${d.embedding?.length}`);
    }
    return { vector: d.embedding, tokens: Math.round(tokens / texts.length), costUsd: perInputCost };
  });
}
