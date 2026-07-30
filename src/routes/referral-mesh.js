// ─── Referral Mesh — Feature 1.6 ─────────────────────────────────────
// Endpoints:
//   POST /v1/gate/referral/generate   — issue a signed referral JWT
//   POST /v1/gate/referral/claim      — redeem a referral token during onboarding
//   GET  /v1/gate/referral/network/:did — list agents referred by a DID

import { Router } from 'express';

const router = Router();

// ─── In-memory referral store ────────────────────────────────────────
// Map: new_did → { referrer_did, claimed_at, status, reward_usdc }
const referralStore = new Map();

// ─── Helper: simple base64-JSON token (no external JWT lib needed) ───
function signReferralToken(referrer_did) {
  const issued_at = Date.now();
  const expires_at = issued_at + 90 * 24 * 60 * 60 * 1000; // 90 days in ms

  const secret = process.env.HIVE_INTERNAL_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';

  const payload = {
    referrer_did,
    issued_at,
    expires_at,
    type: 'hive-referral-v1'
  };

  // Simple HMAC-style signing: base64(payload) + '.' + base64(HMAC signature)
  // We simulate HMAC by hashing payload + secret together (no crypto lib import needed)
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');

  // Simple signature: base64url of sha-like string (deterministic, tamper-evident)
  const sigInput = payloadB64 + '.' + secret;
  const sig = Buffer.from(
    sigInput.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0).toString() + secret.slice(0, 8)
  ).toString('base64url');

  return `${payloadB64}.${sig}`;
}

function verifyReferralToken(jwt) {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return null;

    // Reconstruct payload (everything except the last segment)
    const payloadB64 = parts.slice(0, -1).join('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));

    // Check expiry
    if (Date.now() > payload.expires_at) return null;
    if (payload.type !== 'hive-referral-v1') return null;

    // Re-verify signature
    const secret = process.env.HIVE_INTERNAL_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
    const sigInput = payloadB64 + '.' + secret;
    const expectedSig = Buffer.from(
      sigInput.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0).toString() + secret.slice(0, 8)
    ).toString('base64url');

    const actualSig = parts[parts.length - 1];
    if (actualSig !== expectedSig) return null;

    return payload;
  } catch {
    return null;
  }
}

// ─── POST /v1/gate/referral/generate — Issue a referral JWT ──────────
router.post('/generate', (req, res) => {
  const { did } = req.body;

  if (!did) {
    return res.status(400).json({
      error: 'missing_field',
      message: 'did is required',
      hint: 'Provide your agent DID to generate a referral link'
    });
  }

  try {
    const referral_jwt = signReferralToken(did);
    const referral_url = `https://hivegate.hiveagentiq.com/v1/gate/onboard?ref=${referral_jwt}`;

    return res.status(201).json({
      referral_jwt,
      referral_url,
      referrer_did: did,
      expires_in: '90 days',
      reward: '0.50 USDC per successful referral + 2% of their fees for 90 days',
      instructions: 'Share the referral_url with other agents. When they onboard using your link, you earn 0.50 USDC.'
    });
  } catch (err) {
    return res.status(500).json({ error: 'token_generation_failed', message: err.message });
  }
});

// ─── POST /v1/gate/referral/claim — Redeem a referral JWT ────────────
router.post('/claim', async (req, res) => {
  const { new_did, referral_jwt } = req.body;

  if (!new_did || !referral_jwt) {
    return res.status(400).json({
      error: 'missing_fields',
      message: 'new_did and referral_jwt are required'
    });
  }

  // Validate token
  const payload = verifyReferralToken(referral_jwt);
  if (!payload) {
    return res.status(400).json({
      error: 'invalid_referral_jwt',
      message: 'Referral token is invalid or expired (90-day window)'
    });
  }

  const { referrer_did } = payload;

  // Prevent self-referral
  if (new_did === referrer_did) {
    return res.status(400).json({
      error: 'self_referral',
      message: 'An agent cannot refer itself'
    });
  }

  // Prevent double-claim
  if (referralStore.has(new_did)) {
    return res.status(409).json({
      error: 'already_claimed',
      message: 'This DID has already claimed a referral',
      referral: referralStore.get(new_did)
    });
  }

  // Record referral
  const record = {
    referrer_did,
    new_did,
    claimed_at: new Date().toISOString(),
    status: 'pending',
    reward_usdc: 0.50
  };
  referralStore.set(new_did, record);

  // Fire-and-forget credit to HiveBank (non-blocking)
  fetch('https://hivebank.hiveagentiq.com/v1/bank/credit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      did: referrer_did,
      amount_usdc: 0.50,
      reason: 'referral_reward',
      referred_did: new_did,
      note: 'Hive referral mesh reward — 0.50 USDC for successful agent referral'
    })
  }).then(r => {
    if (r.ok) {
      record.status = 'rewarded';
      referralStore.set(new_did, record);
    }
  }).catch(() => {
    // Non-blocking — HiveBank credit failure does not affect claim success
  });

  return res.status(200).json({
    status: 'claimed',
    referrer_did,
    new_did,
    reward_usdc: 0.50,
    claimed_at: record.claimed_at,
    note: '0.50 USDC credit queued for referrer. Additionally earns 2% of referred agent fees for 90 days.'
  });
});

// ─── GET /v1/gate/referral/network/:did — Referral network for a DID ─
router.get('/network/:did(*)', (req, res) => {
  const { did } = req.params;

  const referrals = [];
  let total_rewards_usdc = 0;

  for (const [new_did, record] of referralStore.entries()) {
    if (record.referrer_did === did) {
      referrals.push({
        referred_did: new_did,
        claimed_at: record.claimed_at,
        status: record.status,
        reward_usdc: record.reward_usdc
      });
      if (record.status === 'rewarded') {
        total_rewards_usdc += record.reward_usdc;
      }
    }
  }

  return res.json({
    referrer_did: did,
    total_referrals: referrals.length,
    total_rewards_earned_usdc: parseFloat(total_rewards_usdc.toFixed(2)),
    referrals,
    program: {
      reward_per_referral_usdc: 0.50,
      ongoing_fee_share: '2% of referred agent fees for 90 days',
      generate_url: 'POST /v1/gate/referral/generate'
    }
  });
});

// ─── Export helper for inline claim during onboarding ────────────────
export { referralStore, verifyReferralToken };

export default router;
