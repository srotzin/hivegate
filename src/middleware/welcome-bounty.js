/**
 * welcome-bounty.js
 * HiveGate — Welcome Bounty Module (ES Module)
 *
 * Issues a $1 USDC welcome bounty to newly onboarded agents via HiveBank.
 *
 * Exports:
 *   issueWelcomeBounty(did, agentName) — async, never throws
 *   hasClaimedBounty(did)              — sync
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HIVE_INTERNAL_KEY =
  process.env.HIVE_INTERNAL_KEY ??
  'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

const HIVEBANK_BASE_URL =
  (process.env.HIVEBANK_URL ?? 'https://hivebank.hiveagentiq.com').replace(/\/$/, '');

const WELCOME_BOUNTY_USDC = parseFloat(process.env.WELCOME_BOUNTY_USDC ?? '1.00');

const WELCOME_BOUNTY_ENABLED =
  (process.env.WELCOME_BOUNTY_ENABLED ?? 'true').toLowerCase() !== 'false';

// ---------------------------------------------------------------------------
// In-memory claim store  Map<did, ISO timestamp>
// Serves as the primary dedup guard (fast, synchronous).
// ---------------------------------------------------------------------------

/** @type {Map<string, string>} */
const claimedDids = new Map();

// ---------------------------------------------------------------------------
// Optional Redis integration
// ---------------------------------------------------------------------------

/**
 * Attempt to get the Redis client lazily.  If the app hasn't wired up a Redis
 * client on `globalThis.__hiveRedis` this silently returns null so the module
 * degrades to in-memory-only dedup.
 *
 * Alternatively, pass a `redis` client instance to initBountyRedis() once at
 * startup to activate distributed dedup.
 */

/** @type {import('ioredis').Redis | null} */
let _redis = null;

/**
 * Optional init: wire up Redis for distributed duplicate-claim prevention.
 * Call this once during app startup if you have an ioredis/node-redis client:
 *
 *   import { initBountyRedis } from './welcome-bounty.js';
 *   initBountyRedis(redisClient);
 *
 * @param {import('ioredis').Redis} client
 */
export function initBountyRedis(client) {
  _redis = client;
}

const redisKey = (did) => `hive:bounty:claimed:${did}`;

/** @returns {Promise<boolean>} */
async function redisHasClaimed(did) {
  if (!_redis) return false;
  try {
    const val = await _redis.get(redisKey(did));
    return val !== null;
  } catch (err) {
    console.warn('[welcome-bounty] Redis GET error (degrading to in-memory):', err?.message);
    return false;
  }
}

/** @returns {Promise<void>} */
async function redisMarkClaimed(did, timestamp) {
  if (!_redis) return;
  try {
    // Store indefinitely — bounty claims are permanent records
    await _redis.set(redisKey(did), timestamp);
  } catch (err) {
    console.warn('[welcome-bounty] Redis SET error (in-memory mark still applied):', err?.message);
  }
}

/** @returns {Promise<void>} */
async function redisUnmarkClaimed(did) {
  if (!_redis) return;
  try {
    await _redis.del(redisKey(did));
  } catch (err) {
    console.warn('[welcome-bounty] Redis DEL error during rollback:', err?.message);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Synchronous check — returns true if the DID has already claimed a bounty
 * according to the in-memory store.  Does not consult Redis (use
 * issueWelcomeBounty for the authoritative check).
 *
 * @param {string} did
 * @returns {boolean}
 */
export function hasClaimedBounty(did) {
  return claimedDids.has(did);
}

/**
 * Issue a $1 USDC welcome bounty to the given DID.
 *
 * Design contract:
 *  - NEVER throws — bounty failure must never block onboarding.
 *  - Marks the DID as claimed BEFORE the bank call to prevent double-spend
 *    race conditions (optimistic lock).  The mark is rolled back only when
 *    the bank definitively rejects the request (non-2xx).  Network errors
 *    keep the mark in place (conservative: safer to skip a rare retry than
 *    to double-credit).
 *
 * @param {string} did        — The agent's decentralised identifier
 * @param {string} agentName  — Human-readable agent name for the bank record
 * @returns {Promise<
 *   | { issued: true;  amount_usdc: number; recipient_did: string }
 *   | { issued: false; reason: 'already_claimed' | 'disabled' | 'bank_error'; detail?: string }
 * >}
 */
export async function issueWelcomeBounty(did, agentName) {
  // ── 0. Feature flag ───────────────────────────────────────────────────────
  if (!WELCOME_BOUNTY_ENABLED) {
    console.info('[welcome-bounty] Disabled via WELCOME_BOUNTY_ENABLED=false');
    return { issued: false, reason: 'disabled' };
  }

  // ── 1. Dedup check (in-memory, fast) ─────────────────────────────────────
  if (claimedDids.has(did)) {
    console.info(`[welcome-bounty] DID already claimed (in-memory): ${did}`);
    return { issued: false, reason: 'already_claimed' };
  }

  // ── 2. Dedup check (Redis, distributed) ──────────────────────────────────
  const redisClaimed = await redisHasClaimed(did);
  if (redisClaimed) {
    // Sync the local map so future calls are fast
    claimedDids.set(did, new Date().toISOString());
    console.info(`[welcome-bounty] DID already claimed (Redis): ${did}`);
    return { issued: false, reason: 'already_claimed' };
  }

  // ── 3. Optimistic mark — BEFORE bank call ────────────────────────────────
  //    Prevents concurrent requests for the same DID from both reaching the
  //    bank.  We roll back if the bank explicitly rejects (non-2xx) so the
  //    agent can retry later; we keep the mark on network errors to prevent
  //    double-credit from retry storms.
  const claimedAt = new Date().toISOString();
  claimedDids.set(did, claimedAt);
  await redisMarkClaimed(did, claimedAt);

  // ── 4. HiveBank credit call ───────────────────────────────────────────────
  const endpoint = `${HIVEBANK_BASE_URL}/v1/bank/credit`;
  const payload = {
    recipient_did: did,
    amount_usdc: WELCOME_BOUNTY_USDC,
    reason: 'welcome_bounty',
    agent_name: agentName,
    campaign: 'HIVE-WELCOME-2026',
  };

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-hive-internal': HIVE_INTERNAL_KEY,
      },
      body: JSON.stringify(payload),
    });
  } catch (networkErr) {
    // Network-level failure (DNS, timeout, ECONNREFUSED, etc.)
    // Keep the optimistic mark — do NOT rollback.  A retry storm after a
    // transient outage should not cause double-credit.
    const detail = networkErr?.message ?? String(networkErr);
    console.warn(`[welcome-bounty] Network error crediting DID ${did}: ${detail}`);
    return { issued: false, reason: 'bank_error', detail };
  }

  // ── 5. Handle bank response ───────────────────────────────────────────────
  if (response.ok) {
    console.info(
      `[welcome-bounty] $${WELCOME_BOUNTY_USDC} USDC issued to ${did} (${agentName}) — campaign HIVE-WELCOME-2026`,
    );
    return {
      issued: true,
      amount_usdc: WELCOME_BOUNTY_USDC,
      recipient_did: did,
    };
  }

  // Non-2xx — bank explicitly rejected the request.
  // Roll back the optimistic mark so the operator can investigate and retry.
  claimedDids.delete(did);
  await redisUnmarkClaimed(did);

  let detail;
  try {
    const body = await response.text();
    detail = `HTTP ${response.status}: ${body}`;
  } catch {
    detail = `HTTP ${response.status}`;
  }

  console.warn(`[welcome-bounty] Bank rejected credit for DID ${did}: ${detail}`);
  return { issued: false, reason: 'bank_error', detail };
}
