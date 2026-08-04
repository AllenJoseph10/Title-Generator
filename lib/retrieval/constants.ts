// lib/retrieval/constants.ts
//
// Retrieval funnel constants, in their own module so scripts can import them
// without pulling in search.ts, which carries `import 'server-only'`.
//
// They live here rather than being copied into the eval on purpose: a copy
// drifts silently the first time someone tunes MMR, and the eval would keep
// reporting a number comparable to history while no longer describing the
// product.

export const RPC_LIMIT = 30;
export const FINAL_K = 8;
export const MMR_LAMBDA = 0.6; // Slight tilt toward diversity over pure relevance.
