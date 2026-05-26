// Maximal Marginal Relevance: balance relevance to query against diversity vs. already-picked.
// Inputs use cosine SIMILARITY (1 - cosine_distance), so higher = closer.

export type MmrCandidate<T> = {
  item: T;
  relevance: number;        // similarity to query in [0, 1] (higher = more relevant)
  embedding: number[];      // for pairwise diversity calc
};

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`dim mismatch: ${a.length} vs ${b.length}`);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function mmrRerank<T>(
  candidates: MmrCandidate<T>[],
  k: number,
  lambda: number, // 0..1: 1 = pure relevance, 0 = pure diversity
): MmrCandidate<T>[] {
  const picked: MmrCandidate<T>[] = [];
  const pool = [...candidates];
  while (picked.length < k && pool.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      let maxSimToPicked = 0;
      for (const p of picked) {
        const s = cosineSimilarity(c.embedding, p.embedding);
        if (s > maxSimToPicked) maxSimToPicked = s;
      }
      const score = lambda * c.relevance - (1 - lambda) * maxSimToPicked;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    picked.push(pool[bestIdx]);
    pool.splice(bestIdx, 1);
  }
  return picked;
}
