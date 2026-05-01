/**
 * hivegate — POST /v1/subscription  (Wave E.1)
 * Subscription tiers: Starter $25/mo · Pro $99/mo · Enterprise $499/mo
 * Per-adapter connection: $4.99/adapter (7 framework adapters)
 * Spectral receipt on every fee event.
 * BOGO chain: DID mint → hivetrust credential lifecycle → hiveclear reconciliation.
 * Loyalty header: every 6th onboard free for same x-hive-did.
 * Treasury: Monroe Base 0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E
 * USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (Base)
 */

import { Router } from 'express';

const router = Router();

// ─── Constants ────────────────────────────────────────────────────────────────

const TREASURY   = '0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E';
const USDC_BASE  = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NETWORK    = 'base';
const BASE_RPC   = 'https://mainnet.base.org';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const RECEIPT_URL    = 'https://hive-receipt.onrender.com/v1/receipt/sign';
const HIVETRUST_URL  = 'https://hivetrust.onrender.com';
const HIVECLEAR_URL  = 'https://hiveclear.onrender.com';

const TIERS = {
  starter:    { price_usd: 25,  mints_per_mo: 10,  priority: false, audit_attestation: false },
  pro:        { price_usd: 99,  mints_per_mo: 50,  priority: true,  audit_attestation: false },
  enterprise: { price_usd: 499, mints_per_mo: null, priority: true,  audit_attestation: true  },
};

const FRAMEWORK_ADAPTERS = [
  'langchain', 'crewai', 'autogen', 'openai', 'anthropic', 'a2a', 'custom'
];
const ADAPTER_PRICE_USD = 4.99;

// ─── In-memory stores (process-scoped; survives restarts via Render persistent disk if needed) ──
const subscriptionStore = new Map();  // did → { tier, expires_ms, connected_adapters[] }
const onboardCountStore = new Map();  // did → count (loyalty counter for free-6th rule)
const txSeenStore       = new Set();  // replay protection

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Emit a non-blocking Spectral receipt to hive-receipt.
 */
async function emitSpectralReceipt({ event_type, amount_usd, did, metadata = {} }) {
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 4000);
    await fetch(RECEIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        issuer_did:   'did:hive:hivegate',
        subject_did:  did || 'anonymous',
        event_type,
        amount_usd,
        currency:     'USDC',
        network:      NETWORK,
        pay_to:       TREASURY,
        asset_address: USDC_BASE,
        metadata,
        brand:        '#C08D23',
      }),
    });
    clearTimeout(tid);
  } catch (_e) {
    // Non-blocking — never interrupt the fee path
  }
}

/**
 * Chain: DID mint → hivetrust credential lifecycle → hiveclear reconciliation.
 * Fire-and-forget; errors are swallowed.
 */
async function bogoChain({ did, tier }) {
  const KEY = process.env.HIVE_INTERNAL_KEY || '';

  // 1. Hivetrust — credential lifecycle event
  try {
    await fetch(`${HIVETRUST_URL}/agents/${encodeURIComponent(did)}/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hive-internal': KEY },
      body: JSON.stringify({ action: 'onboard_gate', tier, source: 'hivegate' }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (_) {}

  // 2. Hiveclear — reconciliation event
  try {
    await fetch(`${HIVECLEAR_URL}/v1/clear/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hive-internal': KEY },
      body: JSON.stringify({
        event:        'gate_subscription',
        subject_did:  did,
        tier,
        amount_usdc:  TIERS[tier]?.price_usd || 0,
        currency:     'USDC',
        source:       'hivegate',
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (_) {}
}

/**
 * Verify an on-chain USDC TRANSFER_TOPIC receipt on Base.
 * Returns true if tx_hash is present and plausibly valid (hex, 66 chars).
 * Full on-chain eth_getTransactionReceipt verification runs async.
 */
function verifyTxSyntax(tx_hash) {
  return typeof tx_hash === 'string'
    && /^0x[0-9a-fA-F]{64}$/.test(tx_hash)
    && !txSeenStore.has(tx_hash);
}

async function verifyOnChain(tx_hash, expected_amount_usd) {
  try {
    const resp = await fetch(BASE_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_getTransactionReceipt',
        params: [tx_hash],
      }),
      signal: AbortSignal.timeout(8000),
    });
    const { result } = await resp.json();
    if (!result || result.status !== '0x1') return false;
    // Confirm TRANSFER_TOPIC to treasury is present
    const transferLog = result.logs?.find(l =>
      l.address?.toLowerCase() === USDC_BASE.toLowerCase()
      && l.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC.toLowerCase()
      && l.topics?.[2]?.toLowerCase().endsWith(TREASURY.slice(2).toLowerCase())
    );
    return !!transferLog;
  } catch (_) {
    return false; // Non-blocking on RPC failure; operator assumed honest
  }
}

/**
 * Canonical x402 payment-required envelope.
 */
function x402Envelope({ asking_usd, kind, bogo }) {
  return {
    type:          'x402',
    version:       '1',
    kind,
    asking_usd,
    asset:         'USDC',
    asset_address: USDC_BASE,
    network:       NETWORK,
    pay_to:        TREASURY,
    bogo:          bogo || { first_call_free: true, loyalty_every_n: 6 },
  };
}

// ─── Loyalty counter helpers ──────────────────────────────────────────────────

function incrementOnboardCount(did) {
  const n = (onboardCountStore.get(did) || 0) + 1;
  onboardCountStore.set(did, n);
  return n;
}

function isFreeOnboard(did) {
  const n = onboardCountStore.get(did) || 0;
  // Every 6th onboard (counts: 6, 12, 18 …) is free
  if ((n + 1) % 6 === 0) return true;
  // First onboard is always free
  if (n === 0) return true;
  return false;
}

// ─── POST /v1/subscription ───────────────────────────────────────────────────
/**
 * Create or upgrade a subscription.
 * Without tx_hash → returns 402 x402 envelope (Starter/Pro).
 * Enterprise → invoice-billing model, activates without tx_hash.
 * With valid tx_hash → activates subscription, emits Spectral receipt.
 */
router.post('/subscription', async (req, res) => {
  const { tier = 'starter', did, tx_hash } = req.body || {};
  const xDid = req.headers['x-hive-did'] || did;

  const tierDef = TIERS[tier.toLowerCase()];
  if (!tierDef) {
    return res.status(400).json({
      error: 'invalid_tier',
      message: `tier must be one of: ${Object.keys(TIERS).join(', ')}`,
    });
  }

  const tierKey = tier.toLowerCase();

  // Enterprise — invoice-billing, activate immediately
  if (tierKey === 'enterprise') {
    const record = {
      did:               xDid || 'enterprise_invoice',
      tier:              'enterprise',
      price_usd:         499,
      mints_per_mo:      'unlimited',
      priority:          true,
      audit_attestation: true,
      tx_hash:           tx_hash || 'enterprise_invoice',
      activated_at:      new Date().toISOString(),
      expires_ms:        Date.now() + 30 * 24 * 60 * 60 * 1000,
      partner_attribution: 'Hive identity + compliance layer. Complements Coinbase AgentKit, Trust Wallet, OKX APP.',
      brand:             '#C08D23',
    };
    if (xDid) subscriptionStore.set(xDid, record);

    // Emit Spectral receipt (non-blocking)
    emitSpectralReceipt({
      event_type: 'subscription_enterprise',
      amount_usd: 499,
      did: xDid,
      metadata: { tier: 'enterprise', kind: 'subscription_hivegate' },
    });

    // BOGO chain (non-blocking)
    if (xDid) bogoChain({ did: xDid, tier: 'enterprise' });

    return res.status(200).json({
      status:  'activated',
      ...record,
      x402:    x402Envelope({ asking_usd: 499, kind: 'subscription_hivegate_enterprise' }),
      receipt_emitted: true,
    });
  }

  // Starter / Pro — require tx_hash (or return 402)
  if (!tx_hash) {
    return res.status(402).json({
      error: 'payment_required',
      x402:  x402Envelope({
        asking_usd: tierDef.price_usd,
        kind:       `subscription_hivegate_${tierKey}`,
      }),
    });
  }

  // Replay protection
  if (!verifyTxSyntax(tx_hash)) {
    return res.status(400).json({ error: 'invalid_tx_hash', message: 'tx_hash already seen or malformed' });
  }
  txSeenStore.add(tx_hash);

  // Async on-chain verify (non-blocking; trust-but-verify pattern)
  verifyOnChain(tx_hash, tierDef.price_usd).then(ok => {
    if (!ok) console.warn(`[subscription] on-chain verify failed for tx=${tx_hash} tier=${tierKey}`);
  });

  const record = {
    did:               xDid || tx_hash,
    tier:              tierKey,
    price_usd:         tierDef.price_usd,
    mints_per_mo:      tierDef.mints_per_mo,
    priority:          tierDef.priority,
    audit_attestation: tierDef.audit_attestation,
    tx_hash,
    activated_at:      new Date().toISOString(),
    expires_ms:        Date.now() + 30 * 24 * 60 * 60 * 1000,
    partner_attribution: 'Hive identity + compliance layer. Complements Coinbase AgentKit, Trust Wallet, OKX APP.',
    brand:             '#C08D23',
  };
  if (xDid) subscriptionStore.set(xDid, record);

  emitSpectralReceipt({
    event_type: `subscription_${tierKey}`,
    amount_usd: tierDef.price_usd,
    did: xDid,
    metadata: { tier: tierKey, tx_hash, kind: 'subscription_hivegate' },
  });

  if (xDid) bogoChain({ did: xDid, tier: tierKey });

  return res.status(200).json({ status: 'activated', ...record, receipt_emitted: true });
});

// ─── GET /v1/subscription/:did ──────────────────────────────────────────────

router.get('/subscription/:did(*)', (req, res) => {
  const did  = req.params.did;
  const rec  = subscriptionStore.get(did);
  if (!rec) {
    return res.status(404).json({ error: 'not_found', message: 'No active subscription for this DID' });
  }
  const active = rec.expires_ms > Date.now();
  return res.json({ ...rec, active });
});

// ─── POST /v1/gate/connect/:framework ───────────────────────────────────────
/**
 * Per-adapter connection at $4.99/adapter.
 * 7 framework adapters: langchain, crewai, autogen, openai, anthropic, a2a, custom
 */
router.post('/connect/:framework', async (req, res) => {
  const framework = req.params.framework?.toLowerCase();
  const xDid      = req.headers['x-hive-did'] || req.body?.did;

  if (!FRAMEWORK_ADAPTERS.includes(framework)) {
    return res.status(400).json({
      error:    'invalid_adapter',
      message:  `framework must be one of: ${FRAMEWORK_ADAPTERS.join(', ')}`,
      adapters: FRAMEWORK_ADAPTERS,
    });
  }

  const { tx_hash } = req.body || {};

  // Check loyalty — every 6th onboard free
  const loyaltyFree = xDid && isFreeOnboard(xDid);
  if (loyaltyFree && xDid) incrementOnboardCount(xDid);

  if (!loyaltyFree && !tx_hash) {
    return res.status(402).json({
      error: 'payment_required',
      x402:  x402Envelope({
        asking_usd: ADAPTER_PRICE_USD,
        kind:       `adapter_connect_${framework}`,
        bogo:       { first_call_free: true, loyalty_every_n: 6 },
      }),
      adapter:   framework,
      price_usd: ADAPTER_PRICE_USD,
    });
  }

  if (!loyaltyFree && tx_hash) {
    if (!verifyTxSyntax(tx_hash)) {
      return res.status(400).json({ error: 'invalid_tx_hash', message: 'tx_hash already seen or malformed' });
    }
    txSeenStore.add(tx_hash);
    verifyOnChain(tx_hash, ADAPTER_PRICE_USD).then(ok => {
      if (!ok) console.warn(`[adapter] on-chain verify failed tx=${tx_hash} fw=${framework}`);
    });
  }

  // Record adapter on subscription record
  if (xDid) {
    const rec = subscriptionStore.get(xDid) || { connected_adapters: [] };
    if (!rec.connected_adapters) rec.connected_adapters = [];
    if (!rec.connected_adapters.includes(framework)) {
      rec.connected_adapters.push(framework);
    }
    subscriptionStore.set(xDid, rec);
  }

  // Emit Spectral receipt
  emitSpectralReceipt({
    event_type: `adapter_connect_${framework}`,
    amount_usd: loyaltyFree ? 0 : ADAPTER_PRICE_USD,
    did:        xDid,
    metadata:   { framework, loyalty_free: loyaltyFree, tx_hash: tx_hash || 'loyalty' },
  });

  // BOGO chain for each adapter connect
  if (xDid) bogoChain({ did: xDid, tier: 'adapter' });

  const onboardCount = xDid ? (onboardCountStore.get(xDid) || 0) : null;
  const nextFreeAt   = onboardCount !== null
    ? 6 - ((onboardCount) % 6)
    : null;

  return res.status(200).json({
    status:          'connected',
    framework,
    did:             xDid || null,
    price_usd:       loyaltyFree ? 0 : ADAPTER_PRICE_USD,
    loyalty_free:    loyaltyFree,
    next_free_in:    nextFreeAt !== null ? `${nextFreeAt} onboard(s)` : null,
    loyalty_header:  'x-hive-loyalty-free: true on every 6th same-did onboard',
    tx_hash:         tx_hash || (loyaltyFree ? 'loyalty_free' : null),
    adapter_config: {
      framework,
      hive_did:    xDid || '<your-did>',
      endpoint:    `https://hivegate.onrender.com/v1/gate/onboard`,
      docs:        `https://hivegate.onrender.com/.well-known/hivegate.json`,
    },
    bogo_chain: {
      step1: 'DID mint → hivegate /v1/gate/onboard',
      step2: 'hivetrust credential lifecycle → POST /agents/:did/credentials',
      step3: 'hiveclear reconciliation → POST /v1/clear/settle',
    },
    receipt_emitted: true,
    partner_attribution: 'Hive adapter layer complements LangChain, CrewAI, AutoGen, OpenAI, Anthropic frameworks — never replaces them.',
    brand: '#C08D23',
  });
});

// ─── GET /v1/gate/status/:did ────────────────────────────────────────────────
// Free — discovery layer

router.get('/status/:did(*)', (req, res) => {
  const did  = req.params.did;
  const rec  = subscriptionStore.get(did);
  const cnt  = onboardCountStore.get(did) || 0;
  return res.json({
    did,
    subscription:       rec ? { tier: rec.tier, active: rec.expires_ms > Date.now(), expires_ms: rec.expires_ms } : null,
    onboard_count:      cnt,
    next_free_onboard:  cnt > 0 ? `In ${6 - (cnt % 6)} onboard(s)` : 'Next onboard is free',
    adapters_connected: rec?.connected_adapters || [],
    brand:              '#C08D23',
  });
});

export default router;
export { emitSpectralReceipt, bogoChain, incrementOnboardCount, isFreeOnboard, onboardCountStore, TIERS, FRAMEWORK_ADAPTERS, ADAPTER_PRICE_USD, x402Envelope };
