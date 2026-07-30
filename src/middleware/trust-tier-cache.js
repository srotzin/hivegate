/**
 * trust-tier-cache.js
 * Lightweight in-process cache for DID trust scores.
 *
 * Avoids hitting the HiveTrust API on every request by caching scores
 * with a 5-minute TTL. Falls back to "free" tier on any fetch error.
 *
 * Score → tier mapping:
 *   score >= 500 → enterprise
 *   score >= 100 → builder
 *   score >=   1 → free
 *   score === 0  → anonymous (no score returned)
 *
 * Usage:
 *   import { getTierForDid } from './trust-tier-cache.js';
 *   const tier = await getTierForDid('did:plc:abc123');
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_TTL_MS        = 5 * 60 * 1_000; // 5 minutes
const HIVETRUST_BASE_URL  = 'https://hivetrust.hiveagentiq.com/v1/trust/score';
const FETCH_TIMEOUT_MS    = 3_000;           // 3-second timeout — fail fast

/** Score thresholds for tier promotion */
const SCORE_THRESHOLDS = {
  enterprise: 500,
  builder:    100,
  free:         1,
};

// ---------------------------------------------------------------------------
// Cache store
// ---------------------------------------------------------------------------

/**
 * @typedef {{ score: number; tier: string; cachedAt: number }} CacheEntry
 * @type {Map<string, CacheEntry>}
 */
const cache = new Map();

// Evict stale entries every 10 minutes to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [did, entry] of cache) {
    if (now - entry.cachedAt > CACHE_TTL_MS) {
      cache.delete(did);
    }
  }
}, 10 * 60 * 1_000).unref();

// ---------------------------------------------------------------------------
// Score → tier mapping
// ---------------------------------------------------------------------------

/**
 * Map a numeric trust score to a tier name.
 *
 * @param {number} score
 * @returns {string}
 */
export function scoreToTier(score) {
  if (score >= SCORE_THRESHOLDS.enterprise) return 'enterprise';
  if (score >= SCORE_THRESHOLDS.builder)    return 'builder';
  if (score >= SCORE_THRESHOLDS.free)       return 'free';
  return 'anonymous';
}

// ---------------------------------------------------------------------------
// HiveTrust fetch
// ---------------------------------------------------------------------------

/**
 * Fetch the trust score for a DID from the HiveTrust API.
 * Returns null on any error (network timeout, 4xx, 5xx, malformed JSON).
 *
 * @param {string} did
 * @returns {Promise<number | null>}
 */
async function fetchTrustScore(did) {
  const url = `${HIVETRUST_BASE_URL}/${encodeURIComponent(did)}`;

  let response;
  try {
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    response = await fetch(url, {
      signal:  controller.signal,
      headers: { Accept: 'application/json' },
    });

    clearTimeout(timeoutId);
  } catch (err) {
    // Network error or timeout
    const reason = err.name === 'AbortError' ? 'timeout' : err.message;
    console.warn(`[trust-tier-cache] HiveTrust fetch failed for ${did} (${reason}) — using safe default`);
    return null;
  }

  if (!response.ok) {
    console.warn(
      `[trust-tier-cache] HiveTrust returned HTTP ${response.status} for ${did} — using safe default`
    );
    return null;
  }

  let body;
  try {
    body = await response.json();
  } catch {
    console.warn(`[trust-tier-cache] HiveTrust returned non-JSON for ${did} — using safe default`);
    return null;
  }

  // Expected response shape: { did, score, ... }
  const score = body?.score;
  if (typeof score !== 'number') {
    console.warn(`[trust-tier-cache] HiveTrust response missing numeric 'score' for ${did}`, body);
    return null;
  }

  return score;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the rate-limit tier for a given DID.
 *
 * Checks the in-process cache first; on a miss (or after TTL expiry) fetches
 * from HiveTrust and stores the result. Falls back to "free" on any error.
 *
 * @param {string} did
 * @returns {Promise<string>} tier name: 'anonymous' | 'free' | 'builder' | 'enterprise'
 */
export async function getTierForDid(did) {
  if (!did) return 'anonymous';

  const now    = Date.now();
  const cached = cache.get(did);

  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.tier;
  }

  // Cache miss or stale — fetch fresh score
  const score = await fetchTrustScore(did);

  if (score === null) {
    // On failure, keep using the stale cached value if we have one,
    // otherwise fall back to 'free' (never lock someone out on an API error).
    if (cached) {
      // Extend the stale entry a little so we don't hammer a degraded API
      cached.cachedAt = now;
      return cached.tier;
    }
    return 'free';
  }

  const tier = scoreToTier(score);
  cache.set(did, { score, tier, cachedAt: now });
  return tier;
}

/**
 * Manually set a tier entry in the cache.
 * Useful for testing or for seeding trusted DIDs at startup.
 *
 * @param {string} did
 * @param {number} score
 */
export function setCachedScore(did, score) {
  cache.set(did, { score, tier: scoreToTier(score), cachedAt: Date.now() });
}

/**
 * Invalidate the cache entry for a specific DID.
 * Call after an admin action that changes a DID's trust score.
 *
 * @param {string} did
 */
export function invalidateDid(did) {
  cache.delete(did);
}

/**
 * Return a snapshot of the entire cache (for debugging / admin endpoints).
 *
 * @returns {Array<{ did: string; score: number; tier: string; ageSeconds: number }>}
 */
export function getCacheSnapshot() {
  const now = Date.now();
  return Array.from(cache.entries()).map(([did, entry]) => ({
    did,
    score:      entry.score,
    tier:       entry.tier,
    ageSeconds: Math.floor((now - entry.cachedAt) / 1_000),
  }));
}
