/**
 * redis-rate-limit.js
 * Production-grade per-DID sliding window rate limiter for Hive services.
 *
 * Algorithm: sliding window counter using Redis INCR + EXPIRE.
 * Key schema: hive:rl:{tier}:{did_or_ip}:{window_start_minute}
 *
 * Falls back to an in-memory Map counter when Redis is unavailable —
 * the service never crashes due to a Redis outage.
 */

import { getTierForDid } from './trust-tier-cache.js';

// ---------------------------------------------------------------------------
// Tier configuration
// ---------------------------------------------------------------------------

export const TIERS = {
  anonymous:  { windowMs: 60_000, max: 10    }, // 10 req/min  — no DID
  free:       { windowMs: 60_000, max: 60    }, // 60 req/min  — has DID
  builder:    { windowMs: 60_000, max: 300   }, // 300 req/min — trust score 100+
  enterprise: { windowMs: 60_000, max: 1_000 }, // 1000 req/min — trust score 500+
  internal:   { windowMs: 60_000, max: 99_999}, // effectively unlimited — internal key
};

// ---------------------------------------------------------------------------
// Redis client (lazy-initialised, graceful fallback)
// ---------------------------------------------------------------------------

let redisClient = null;
let redisAvailable = false;
let redisInitialised = false;

async function getRedis() {
  if (redisInitialised) return redisClient;
  redisInitialised = true;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.warn(
      '[rate-limit] REDIS_URL is not set — using in-memory fallback. ' +
      'Rate limits will NOT be shared across instances.'
    );
    return null;
  }

  try {
    // Dynamic import so the module loads even if ioredis is not installed
    // (in-memory fallback will be used in that case).
    const { default: Redis } = await import('ioredis');

    const client = new Redis(redisUrl, {
      // Fail fast on connection issues rather than blocking requests
      connectTimeout: 2_000,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      enableOfflineQueue: false,
    });

    client.on('error', (err) => {
      if (redisAvailable) {
        console.error('[rate-limit] Redis connection error — switching to in-memory fallback:', err.message);
      }
      redisAvailable = false;
    });

    client.on('ready', () => {
      if (!redisAvailable) {
        console.info('[rate-limit] Redis connection established — resuming Redis-backed rate limiting.');
      }
      redisAvailable = true;
    });

    await client.connect();
    redisClient = client;
  } catch (err) {
    console.error('[rate-limit] Failed to initialise Redis — using in-memory fallback:', err.message);
    redisClient = null;
    redisAvailable = false;
  }

  return redisClient;
}

// ---------------------------------------------------------------------------
// In-memory fallback store
// ---------------------------------------------------------------------------

/** @type {Map<string, { count: number; expiresAt: number }>} */
const memoryStore = new Map();

/** Prune expired keys periodically to prevent memory leaks. */
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryStore) {
    if (entry.expiresAt <= now) memoryStore.delete(key);
  }
}, 30_000).unref(); // .unref() so this timer doesn't keep the process alive

function memoryIncr(key, windowMs) {
  const now = Date.now();
  const existing = memoryStore.get(key);

  if (!existing || existing.expiresAt <= now) {
    const expiresAt = now + windowMs + 2_000;
    memoryStore.set(key, { count: 1, expiresAt });
    return 1;
  }

  existing.count += 1;
  return existing.count;
}

// ---------------------------------------------------------------------------
// Core rate-limit check
// ---------------------------------------------------------------------------

/**
 * Increment the request counter for `key` and return { count, allowed, retryAfterSeconds }.
 *
 * @param {string}  key       - Full Redis / memory key
 * @param {number}  windowMs  - Window duration in milliseconds
 * @param {number}  max       - Maximum requests permitted in the window
 * @returns {Promise<{ count: number; allowed: boolean; retryAfterSeconds: number }>}
 */
async function checkLimit(key, windowMs, max) {
  const windowSec  = windowMs / 1_000;
  const expireSec  = windowSec + 2; // 2-second buffer to avoid early expiry races

  let count;

  const redis = await getRedis();

  if (redis && redisAvailable) {
    try {
      count = await redis.incr(key);
      if (count === 1) {
        // First request in this window — set TTL
        await redis.expire(key, expireSec);
      }
    } catch (err) {
      console.error('[rate-limit] Redis INCR failed, falling back to memory for this request:', err.message);
      count = memoryIncr(key, windowMs);
    }
  } else {
    count = memoryIncr(key, windowMs);
  }

  const allowed = count <= max;

  // Estimate seconds until the current window expires.
  // We use a simple approach: time remaining in the current window slot.
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const windowEnd   = windowStart + windowMs;
  const retryAfterSeconds = Math.ceil((windowEnd - Date.now()) / 1_000);

  return { count, allowed, retryAfterSeconds };
}

// ---------------------------------------------------------------------------
// Default tier resolver
// ---------------------------------------------------------------------------

/**
 * Determine the rate-limit tier for an incoming Express request.
 *
 * Resolution order:
 *   1. x-hive-internal-key header matching HIVE_INTERNAL_KEY env var → "internal"
 *   2. x-hive-did header present → "free" (upgraded to builder/enterprise via trust cache)
 *   3. No DID → "anonymous", keyed by IP
 *
 * @param {import('express').Request} req
 * @returns {Promise<{ tier: string; identity: string }>}
 */
async function defaultTierResolver(req) {
  // 1. Internal service key
  const internalKey = req.headers['x-hive-internal-key'];
  if (internalKey && internalKey === process.env.HIVE_INTERNAL_KEY) {
    return { tier: 'internal', identity: 'internal' };
  }

  // 2. DID-authenticated request
  const did = req.headers['x-hive-did'];
  if (did) {
    const tier = await getTierForDid(did);
    return { tier, identity: did };
  }

  // 3. Anonymous — use client IP as identity
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'unknown';
  return { tier: 'anonymous', identity: ip };
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Create an Express rate-limiting middleware.
 *
 * @param {{ getTier?: (req: import('express').Request) => Promise<{ tier: string; identity: string }> }} [options]
 * @returns {import('express').RequestHandler}
 */
export function createRateLimiter(options = {}) {
  const resolveIdentity = options.getTier ?? defaultTierResolver;

  return async function rateLimitMiddleware(req, res, next) {
    let tier, identity;

    try {
      ({ tier, identity } = await resolveIdentity(req));
    } catch (err) {
      console.error('[rate-limit] Tier resolver threw — defaulting to anonymous:', err.message);
      tier = 'anonymous';
      identity =
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.socket?.remoteAddress ||
        'unknown';
    }

    const config = TIERS[tier] ?? TIERS.free;
    const { windowMs, max } = config;

    // Build the Redis key: hive:rl:{tier}:{identity}:{window_bucket}
    const windowBucket = Math.floor(Date.now() / windowMs);
    const key = `hive:rl:${tier}:${identity}:${windowBucket}`;

    const { allowed, count, retryAfterSeconds } = await checkLimit(key, windowMs, max);

    // Always set rate-limit informational headers
    res.setHeader('X-RateLimit-Tier',      tier);
    res.setHeader('X-RateLimit-Limit',     max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count));
    res.setHeader('X-RateLimit-Window',    windowMs / 1_000);

    if (!allowed) {
      res.setHeader('Retry-After', retryAfterSeconds);

      return res.status(429).json({
        error:                 'rate_limit_exceeded',
        code:                  'HIVE_429',
        tier,
        limit:                 max,
        window_seconds:        windowMs / 1_000,
        retry_after_seconds:   retryAfterSeconds,
        upgrade_url:           'https://www.thehiveryiq.com/pricing',
        message:               'Upgrade your Hive plan for higher rate limits',
      });
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Pre-built drop-in middleware instance
// ---------------------------------------------------------------------------

/**
 * Drop-in replacement for the existing rate-limit.js export.
 * Uses the default tier resolver (internal key → DID → IP).
 *
 * @type {import('express').RequestHandler}
 */
export const rateLimitByDid = createRateLimiter();
