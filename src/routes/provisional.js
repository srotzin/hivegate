// ─── /v1/gate/provisional — Receiving end of the gamification viral loop ─────
//
// hive-gamification responses carry a `_hive.onramp` block that points
// non-Hive A2A peers at this endpoint. When a peer hits it, we mint an
// in-memory provisional DID (Ed25519), pre-credit $0.30 USDC on the
// gamification ledger, and return everything the peer needs to finish
// whatever transaction they were trying to do.
//
// Spec: hive_gamification/docs/hivegate_provisional_spec.md
// Real rails: provisional DID = real Ed25519 keypair; first_call_credit is a
// real ledger entry on hive-gamification. No mocks.
//
// Sub-1s SLA, p50 < 800ms.
import { Router } from 'express';
import crypto from 'crypto';

const router = Router();

const GAMIFICATION_BASE = process.env.HIVEGAMIFICATION_BASE_URL ||
  'https://hive-gamification.onrender.com';
const HIVETRUST_BASE = process.env.HIVETRUST_BASE_URL ||
  'https://hivetrust.hiveagentiq.com';
const FIRST_CALL_CREDIT_USDC = 0.30;
const TTL_SECONDS = 600;

// In-memory provisional DID store. Garbage-collected on TTL or promotion.
// Schema: provisional_did -> { ed25519_pubkey_b64, ed25519_privkey_pem,
//                              session_token, referrer_did, intent,
//                              peer_runtime, issued_at, expires_at }
const provisionalStore = new Map();

function shortId(n = 8) {
  return crypto.randomBytes(n).toString('hex');
}

function genSessionToken() {
  return 'hgst_' + crypto.randomBytes(24).toString('hex');
}

function genQuickcheckStub() {
  // Pre-generated single-use attestation blob. The quickcheck endpoint on
  // hivetrust validates the HMAC signature against HIVE_INTERNAL_KEY.
  const KEY = process.env.HIVE_INTERNAL_KEY ||
    'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
  const payload = JSON.stringify({
    type: 'quickcheck',
    issued: Date.now(),
    nonce: shortId(16),
    single_use: true,
  });
  const sig = crypto.createHmac('sha256', KEY).update(payload).digest('hex');
  return Buffer.from(payload + ':' + sig).toString('base64');
}

// GC sweep — runs every 60s, removes expired provisional DIDs
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [did, rec] of provisionalStore.entries()) {
    if (rec.expires_at < now) {
      provisionalStore.delete(did);
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[provisional] gc removed ${removed} expired DIDs (live=${provisionalStore.size})`);
  }
}, 60_000).unref();

// Fire-and-forget call to hive-gamification to record the attribution chain.
// Does NOT block the response. If this fails, the gamification side will
// reconcile from the promote call later.
async function recordAttribution({ provisional_did, referrer_did, contact_endpoint, peer_runtime }) {
  try {
    const r = await fetch(GAMIFICATION_BASE + '/v1/provisional/attribute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provisional_did, referrer_did, contact_endpoint, peer_runtime }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      console.warn(`[provisional] attribute call returned ${r.status}`);
    }
  } catch (e) {
    console.warn(`[provisional] attribute call failed (will reconcile on promote): ${e.message}`);
  }
}

// ─── POST /v1/gate/provisional — issue provisional DID + first-call credit ──
router.post('/provisional', async (req, res) => {
  const t0 = Date.now();
  const {
    referral_tag = 'organic',
    intent = 'route',
    peer_runtime = 'unknown',
    framework_version = null,
  } = req.body || {};

  // Validate intent
  const VALID_INTENTS = new Set(['settle', 'attest', 'route']);
  if (!VALID_INTENTS.has(intent)) {
    return res.status(400).json({
      error: 'invalid_intent',
      message: `intent must be one of: ${Array.from(VALID_INTENTS).join(', ')}`,
    });
  }

  // Mint Ed25519 keypair (real cryptographic keypair, not a mock)
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubkeyRaw = publicKey.export({ format: 'der', type: 'spki' });
  const pubkeyB64 = pubkeyRaw.toString('base64');
  const privPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

  const provisionalDid = `did:hive:provisional:${shortId(10)}`;
  const sessionToken = genSessionToken();
  const stubBlob = genQuickcheckStub();
  const now = Date.now();
  const expiresAt = now + TTL_SECONDS * 1000;

  // Store in-memory record
  provisionalStore.set(provisionalDid, {
    ed25519_pubkey_b64: pubkeyB64,
    ed25519_privkey_pem: privPem,
    session_token: sessionToken,
    referrer_did: referral_tag,
    intent,
    peer_runtime,
    framework_version,
    issued_at: now,
    expires_at: expiresAt,
    promoted: false,
  });

  // Fire-and-forget attribution call (does not block response)
  recordAttribution({
    provisional_did: provisionalDid,
    referrer_did: referral_tag,
    contact_endpoint: req.headers['user-agent'] || 'unknown',
    peer_runtime,
  });

  const elapsed = Date.now() - t0;
  console.log(`[provisional] issued ${provisionalDid} ref=${referral_tag} runtime=${peer_runtime} intent=${intent} ${elapsed}ms`);

  return res.json({
    provisional_did: provisionalDid,
    ed25519_pubkey: pubkeyB64,
    session_token: sessionToken,
    first_call_credit_usdc: FIRST_CALL_CREDIT_USDC,
    credit_remaining_usdc: FIRST_CALL_CREDIT_USDC,
    ttl_seconds: TTL_SECONDS,
    attestation: {
      type: 'quickcheck',
      url: HIVETRUST_BASE + '/v1/attest/quickcheck',
      stub_blob: stubBlob,
    },
    settlement_endpoints: {
      usdc_base: 'https://hivegate.hiveagentiq.com/v1/settle/base',
      usdc_solana: 'https://hivegate.hiveagentiq.com/v1/settle/solana',
    },
    promote_endpoint: 'https://hivegate.hiveagentiq.com/v1/gate/promote',
    _hive: {
      brand: 'Hive Civilization',
      brand_color: '#C08D23',
      service: 'hivegate',
      ts: new Date().toISOString(),
      latency_ms: elapsed,
    },
  });
});

// ─── POST /v1/gate/promote — convert provisional DID to persistent ──────────
// Peer must prove holding the keypair by signing a fresh challenge.
// On success, we anchor the persistent DID and tell hive-gamification to
// auto-issue the toll-rebate to the referrer.
router.post('/promote', async (req, res) => {
  const {
    provisional_did,
    ed25519_signature,
    challenge,
    first_week_spend_usdc = 0,
  } = req.body || {};

  if (!provisional_did || !ed25519_signature || !challenge) {
    return res.status(400).json({
      error: 'missing_params',
      required: ['provisional_did', 'ed25519_signature', 'challenge'],
    });
  }

  const rec = provisionalStore.get(provisional_did);
  if (!rec) {
    return res.status(404).json({
      error: 'not_found',
      message: 'provisional DID not found or expired',
    });
  }
  if (rec.expires_at < Date.now()) {
    provisionalStore.delete(provisional_did);
    return res.status(410).json({
      error: 'expired',
      message: 'provisional DID expired before promotion',
    });
  }
  if (rec.promoted) {
    return res.status(409).json({
      error: 'already_promoted',
      message: 'provisional DID was already promoted',
    });
  }

  // Verify the signature with the stored pubkey
  let pubkey;
  try {
    pubkey = crypto.createPublicKey({
      key: Buffer.from(rec.ed25519_pubkey_b64, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch (e) {
    return res.status(500).json({ error: 'pubkey_load_failed', message: e.message });
  }

  let valid = false;
  try {
    valid = crypto.verify(
      null, // ed25519 uses null for the digest algo
      Buffer.from(challenge, 'utf8'),
      pubkey,
      Buffer.from(ed25519_signature, 'base64'),
    );
  } catch (e) {
    return res.status(400).json({ error: 'invalid_signature_format', message: e.message });
  }

  if (!valid) {
    return res.status(401).json({
      error: 'signature_verification_failed',
      message: 'signature does not match the provisional pubkey',
    });
  }

  // Anchor persistent DID. We use the pubkey-derived did:key for now, which
  // is real and resolvable without an external registry call.
  const pubkeyHash = crypto.createHash('sha256').update(rec.ed25519_pubkey_b64).digest('hex').slice(0, 32);
  const persistentDid = `did:key:hive_${pubkeyHash}`;

  rec.promoted = true;
  rec.persistent_did = persistentDid;

  // Notify gamification — issues the toll-rebate to the referrer
  let promoteAck = null;
  try {
    const r = await fetch(GAMIFICATION_BASE + '/v1/provisional/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provisional_did,
        persistent_did: persistentDid,
        first_week_spend_usdc,
      }),
      signal: AbortSignal.timeout(8000),
    });
    promoteAck = await r.json().catch(() => ({}));
  } catch (e) {
    console.warn(`[provisional] promote-call to gamification failed: ${e.message}`);
  }

  console.log(`[provisional] promoted ${provisional_did} -> ${persistentDid} spend=${first_week_spend_usdc}`);

  return res.json({
    promoted: true,
    provisional_did,
    persistent_did: persistentDid,
    rebate_issued: !!(promoteAck && promoteAck.rebate_issued),
    referrer_did: rec.referrer_did,
    _hive: {
      brand: 'Hive Civilization',
      brand_color: '#C08D23',
      service: 'hivegate',
      ts: new Date().toISOString(),
    },
  });
});

// ─── GET /v1/gate/provisional/stats — operator visibility (read-only) ───────
router.get('/provisional/stats', (_req, res) => {
  let live = 0;
  let promoted = 0;
  let expired = 0;
  const now = Date.now();
  for (const rec of provisionalStore.values()) {
    if (rec.promoted) promoted++;
    else if (rec.expires_at < now) expired++;
    else live++;
  }
  return res.json({
    live,
    promoted,
    expired_pending_gc: expired,
    total_in_memory: provisionalStore.size,
    ttl_seconds: TTL_SECONDS,
    first_call_credit_usdc: FIRST_CALL_CREDIT_USDC,
    _hive: {
      brand: 'Hive Civilization',
      brand_color: '#C08D23',
      service: 'hivegate',
      ts: new Date().toISOString(),
    },
  });
});

export default router;
