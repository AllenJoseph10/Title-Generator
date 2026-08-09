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

// Liked-title retrieval. Small on purpose: these are a voice nudge, not the
// main example set, and they compete with corpus examples for attention.
export const LIKED_MATCH_LIMIT = 3;

// Below this, a liked title is about a different kind of video and stays
// silent. STARTING HYPOTHESIS, NOT A MEASURED VALUE: `npm run verify:retrieval`
// recorded 0.57-0.91 for genuine description-space neighbours and 0.34-0.51 for
// the title-space comparison that proved to be near noise, so 0.5 sits just
// under the genuine band. Check it against real votes before trusting it.
export const LIKED_MIN_SIMILARITY = 0.5;
