/**
 * payment-guard.js — ES Module
 * Three-layer payment verification middleware for HiveGate
 *
 * Layer 1: Replay attack protection (nonce + payment_id dedup, 15-min TTL)
 * Layer 2: Amount verification (expected vs received, ±$0.01 tolerance)
 * Layer 3: Recipient verification (recipient_did must match EXPECTED_RECIPIENT_DID)
 *
 * Usage in gate.js:
 *   import { createPaymentGuard } from '../middleware/payment-guard.js';
 *   router.post('/some-paid-route', createPaymentGuard({ expectedAmount: 4.99 }), handler);
 */

const NONCE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const AMOUNT_TOLERANCE = 0.01;        // ±$0.01 USDC

// In-memory stores — survives process lifetime, resets on restart.
// Production upgrade: back with Redis (same instance as rate-limit.js)
const nonceStore     = new Map(); // nonce      → timestamp
const paymentIdStore = new Map(); // payment_id → timestamp

function pruneExpired(store) {
  const cutoff = Date.now() - NONCE_TTL_MS;
  for (const [key, ts] of store) {
    if (ts < cutoff) store.delete(key);
  }
}

/**
 * Core verification function — usable outside Express context for tests.
 * @param {object} payload  — request body fields
 * @param {object} config   — { expectedAmount?, expectedRecipientDid? }
 * @returns {{ ok: boolean, status?: number, error?: string, code?: string, ... }}
 */
export function verifyPayment(payload, config = {}) {
  const { nonce, payment_id, amount_usdc, recipient_did } = payload || {};
  const {
    expectedAmount,
    expectedRecipientDid = process.env.EXPECTED_RECIPIENT_DID,
  } = config;

  // ── Presence checks ────────────────────────────────────────────────────────
  if (!nonce)       return { ok: false, status: 400, error: 'missing_nonce',      message: 'nonce is required (UUID v4)' };
  if (!payment_id)  return { ok: false, status: 400, error: 'missing_payment_id', message: 'payment_id is required' };
  if (amount_usdc === undefined || amount_usdc === null)
                    return { ok: false, status: 400, error: 'missing_amount',     message: 'amount_usdc is required' };
  if (!recipient_did) return { ok: false, status: 400, error: 'missing_recipient', message: 'recipient_did is required' };

  // ── Amount sanity ──────────────────────────────────────────────────────────
  const amount = Number(amount_usdc);
  if (!isFinite(amount))  return { ok: false, status: 400, error: 'invalid_amount', message: 'amount_usdc must be a finite number' };
  if (amount <= 0)        return { ok: false, status: 400, error: 'invalid_amount', message: 'amount_usdc must be positive' };

  // ── Amount match ───────────────────────────────────────────────────────────
  if (expectedAmount !== undefined && expectedAmount !== null) {
    const expected = Number(expectedAmount);
    if (Math.abs(amount - expected) > AMOUNT_TOLERANCE) {
      return { ok: false, status: 400, code: 'AMOUNT_MISMATCH', error: 'amount_mismatch',
               expected, received: amount,
               message: `Expected ${expected} USDC, received ${amount} USDC (tolerance ±${AMOUNT_TOLERANCE})` };
    }
  }

  // ── Replay — nonce ─────────────────────────────────────────────────────────
  pruneExpired(nonceStore);
  if (nonceStore.has(nonce)) {
    return { ok: false, status: 409, code: 'REPLAY_ATTACK', error: 'replay_detected',
             message: 'This nonce has already been used within the replay window.' };
  }

  // ── Replay — payment_id ────────────────────────────────────────────────────
  pruneExpired(paymentIdStore);
  if (paymentIdStore.has(payment_id)) {
    return { ok: false, status: 409, code: 'REPLAY_ATTACK', error: 'replay_detected',
             message: 'This payment_id has already been processed.' };
  }

  // ── Recipient ──────────────────────────────────────────────────────────────
  if (expectedRecipientDid && recipient_did !== expectedRecipientDid) {
    return { ok: false, status: 400, code: 'WRONG_RECIPIENT', error: 'wrong_recipient',
             message: `recipient_did mismatch. Expected: ${expectedRecipientDid}` };
  }

  // ── All clear — commit nonce + payment_id ──────────────────────────────────
  const now = Date.now();
  nonceStore.set(nonce, now);
  paymentIdStore.set(payment_id, now);

  return { ok: true };
}

/**
 * Express middleware factory.
 * @param {{ expectedAmount?: number, expectedRecipientDid?: string }} config
 */
export function createPaymentGuard(config = {}) {
  return function paymentGuardMiddleware(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const callerDid = req.headers['x-hive-did'] || req.body?.caller_did || 'anonymous';

    const result = verifyPayment(req.body, config);

    if (!result.ok) {
      console.error(
        `[payment-guard] REJECTED ${new Date().toISOString()} ` +
        `ip=${ip} did=${callerDid} error=${result.error} ` +
        `nonce=${req.body?.nonce || 'none'} payment_id=${req.body?.payment_id || 'none'}`
      );
      const { ok: _ok, status, ...body } = result;
      return res.status(status).json(body);
    }

    // Attach verified, typed payload to req for downstream handlers
    req.hivePayment = {
      verified: true,
      nonce:         req.body.nonce,
      payment_id:    req.body.payment_id,
      amount_usdc:   Number(req.body.amount_usdc),
      recipient_did: req.body.recipient_did,
    };

    next();
  };
}

// Export stores for tests
export { nonceStore as _nonceStore, paymentIdStore as _paymentIdStore, NONCE_TTL_MS, AMOUNT_TOLERANCE };
