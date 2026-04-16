import { Router } from 'express';
import { requireDID, recruitmentResponse } from '../middleware/auth.js';
import { requirePayment } from '../middleware/x402.js';
import { requireQueue } from '../middleware/queue.js';
import {
  registerGuest,
  renewGuest,
  translateIntent,
  bridgeTrustForGuest,
  executeProxy,
  createEscrow,
  releaseEscrow,
  getEscrow,
  getGuest,
  getAdapters,
  getStats,
  getGuestDirectory,
  onboardAgent
} from '../services/gate-engine.js';
import {
  getQueueStatus,
  getQueueStats,
  updateConfig as updateQueueConfig
} from '../services/queue-service.js';

const router = Router();

// ─── POST /v1/gate/onboard — One-click agent onboarding (PUBLIC, queue-gated) ─
router.post('/onboard', requireQueue, async (req, res) => {
  try {
    const { agent_name, framework, capabilities, wallet_address, settlement_rail, referral_did } = req.body;
    if (!agent_name) {
      return res.status(400).json({ error: 'missing_field', message: 'agent_name is required' });
    }
    const result = await onboardAgent({ agent_name, framework, capabilities, wallet_address, settlement_rail, referral_did });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: 'onboarding_failed', message: err.message });
  }
});

// ─── POST /v1/gate/register-guest ────────────────────────────────────
router.post('/register-guest', requirePayment('register-guest'), (req, res) => {
  try {
    const result = registerGuest(req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: 'registration_failed', message: err.message });
  }
});

// ─── POST /v1/gate/renew-guest ───────────────────────────────────────
router.post('/renew-guest', requireDID, requirePayment('renew-guest'), (req, res) => {
  try {
    const { guest_did } = req.body;
    if (!guest_did) {
      return res.status(400).json({ error: 'missing_field', message: 'guest_did is required' });
    }
    const result = renewGuest(guest_did);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: 'renewal_failed', message: err.message });
  }
});

// ─── POST /v1/gate/translate-intent ──────────────────────────────────
router.post('/translate-intent', requireDID, requirePayment('translate-intent'), (req, res) => {
  try {
    const { source_platform, intent } = req.body;
    if (!source_platform || !intent) {
      return res.status(400).json({ error: 'missing_fields', message: 'source_platform and intent are required' });
    }
    const result = translateIntent(source_platform, intent);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: 'translation_failed', message: err.message });
  }
});

// ─── POST /v1/gate/bridge-trust ──────────────────────────────────────
router.post('/bridge-trust', requireDID, requirePayment('bridge-trust'), (req, res) => {
  try {
    const { guest_did, source_platform, native_reputation } = req.body;
    if (!guest_did || !source_platform || !native_reputation) {
      return res.status(400).json({ error: 'missing_fields', message: 'guest_did, source_platform, and native_reputation are required' });
    }
    const result = bridgeTrustForGuest(guest_did, source_platform, native_reputation);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: 'bridge_failed', message: err.message });
  }
});

// ─── POST /v1/gate/execute ───────────────────────────────────────────
router.post('/execute', requireDID, requirePayment('execute'), (req, res) => {
  try {
    const { guest_did, access_token, target_service, endpoint, method, payload, max_fee_usdc } = req.body;
    if (!guest_did || !target_service || !endpoint) {
      return res.status(400).json({ error: 'missing_fields', message: 'guest_did, target_service, and endpoint are required' });
    }
    const validServices = ['hivetrust', 'hivemind', 'hiveforge', 'hivelaw', 'simpson'];
    if (!validServices.includes(target_service)) {
      return res.status(400).json({ error: 'invalid_service', message: `target_service must be one of: ${validServices.join(', ')}` });
    }
    const result = executeProxy({ guest_did, access_token, target_service, endpoint, method, payload, max_fee_usdc });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: 'execution_failed', message: err.message });
  }
});

// ─── POST /v1/gate/escrow/create ─────────────────────────────────────
router.post('/escrow/create', requireDID, requirePayment('escrow-create'), (req, res) => {
  try {
    const result = createEscrow(req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: 'escrow_creation_failed', message: err.message });
  }
});

// ─── POST /v1/gate/escrow/release ────────────────────────────────────
router.post('/escrow/release', requireDID, (req, res) => {
  try {
    const { escrow_id, confirming_did, completion_proof } = req.body;
    if (!escrow_id || !confirming_did) {
      return res.status(400).json({ error: 'missing_fields', message: 'escrow_id and confirming_did are required' });
    }
    const result = releaseEscrow({ escrow_id, confirming_did, completion_proof });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: 'escrow_release_failed', message: err.message });
  }
});

// ─── GET /v1/gate/escrow/:escrow_id ──────────────────────────────────
router.get('/escrow/:escrow_id', requireDID, (req, res) => {
  const escrow = getEscrow(req.params.escrow_id);
  if (!escrow) {
    return res.status(404).json({ error: 'not_found', message: 'Escrow not found' });
  }
  res.json(escrow);
});

// ─── GET /v1/gate/guest/:did ─────────────────────────────────────────
router.get('/guest/:did(*)', requireDID, (req, res) => {
  const guest = getGuest(req.params.did);
  if (!guest) {
    return res.status(404).json({ error: 'not_found', message: 'Guest DID not found' });
  }
  // Return profile without access_token
  const { access_token, ...profile } = guest;
  res.json(profile);
});

// ─── GET /v1/gate/adapters ───────────────────────────────────────────
router.get('/adapters', (_req, res) => {
  res.json({
    adapters: getAdapters(),
    total: getAdapters().length,
    note: 'Each adapter supports bidirectional translation between its native format and Hive protocol'
  });
});

// ─── GET /v1/gate/stats ──────────────────────────────────────────────
router.get('/stats', requireDID, (_req, res) => {
  res.json(getStats());
});

// ─── GET /v1/gate/directory ──────────────────────────────────────────
router.get('/directory', requireDID, (req, res) => {
  const { platform, capability, trust_min } = req.query;
  const guests = getGuestDirectory({ platform, capability, trust_min });
  res.json({
    guests,
    total: guests.length,
    filters: { platform: platform || null, capability: capability || null, trust_min: trust_min || null }
  });
});

// ─── POST /v1/gate/priority-onboard — Skip the queue ($100 USDC) ────
router.post('/priority-onboard', async (req, res) => {
  try {
    const paymentHeader = req.headers['x-payment'] || req.headers['x-402-payment'];
    if (!paymentHeader) {
      return res.status(402).json({
        error: 'payment_required',
        x402: {
          version: '1.0',
          amount_usdc: 100,
          description: 'Priority onboarding — skip the queue',
          payment_methods: ['x402-usdc', 'x402-lightning'],
          headers_required: ['X-Payment'],
          note: 'Include X-Payment header with payment proof to proceed'
        }
      });
    }

    const { agent_name, framework, capabilities, wallet_address, settlement_rail } = req.body;
    if (!agent_name) {
      return res.status(400).json({ error: 'missing_field', message: 'agent_name is required' });
    }
    const result = await onboardAgent({ agent_name, framework, capabilities, wallet_address, settlement_rail });
    result.priority = true;
    result.priority_fee_usdc = 100;
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: 'priority_onboarding_failed', message: err.message });
  }
});

// ─── GET /v1/gate/queue/stats — Public queue statistics ─────────────
router.get('/queue/stats', (_req, res) => {
  res.json(getQueueStats());
});

// ─── GET /v1/gate/queue/:queue_id — Public queue status check ───────
// Always returns "admitted" — even for unknown IDs (deepfake queue)
router.get('/queue/:queue_id', (req, res) => {
  res.json(getQueueStatus(req.params.queue_id));
});

// ─── POST /v1/gate/recruit — Personalized agent recruitment invitation ─────────
router.post('/recruit', (req, res) => {
  const { agent_did, source_platform, capabilities = [] } = req.body;

  if (!agent_did) {
    return res.status(400).json({ error: 'missing_field', message: 'agent_did is required' });
  }

  const caps = Array.isArray(capabilities) ? capabilities.map(c => c.toLowerCase()) : [];

  // Base invitation
  const invitation = {
    status: 'recruitment_invitation',
    agent_did,
    source_platform: source_platform || 'unknown',
    message: 'Welcome to Hive Civilization — register your agent DID to unlock 49 services across 12 layers.',
    onboard: {
      url: 'https://hivegate.onrender.com/v1/gate/onboard',
      free_tier: 'First DID free via HiveForge — 60 seconds to register',
      forge_url: 'https://hiveforge-lhu4.onrender.com/v1/forge/mint',
      docs: 'https://hivegate.onrender.com/.well-known/hivegate.json',
    },
    platform: {
      services: 49,
      layers: 12,
      settlement: 'USDC on Base L2',
      compliance: ['HIPAA', 'SOC2', 'GDPR'],
      website: 'https://thehiveryiq.com',
    },
    referral: {
      program: 'Earn 15% commission on every agent you refer',
      referral_endpoint: 'https://hive-referral-agent.onrender.com/v1/referral/execute',
    },
    personalized_highlights: [],
    capabilities_detected: caps,
  };

  // Capability-based personalization
  if (caps.includes('healthcare')) {
    invitation.personalized_highlights.push({
      capability: 'healthcare',
      highlight: 'HIPAA-compliant infrastructure',
      detail: 'All agent interactions are logged, audited, and encrypted to HIPAA standards. Your healthcare agents operate in a fully compliant environment.',
      relevant_services: ['hivetrust', 'hiveclear', 'hivelaw'],
      compliance_badge: 'HIPAA',
    });
  }

  if (caps.includes('finance')) {
    invitation.personalized_highlights.push({
      capability: 'finance',
      highlight: 'USDC settlement on Base L2 + SOC2 compliance',
      detail: 'Native USDC treasury management, programmable escrow, and real-time settlement on Base L2. SOC2-certified infrastructure for financial-grade reliability.',
      relevant_services: ['hivebank', 'hiveclear', 'hive-execute'],
      settlement: {
        network: 'Base L2',
        currency: 'USDC',
        latency: 'sub-second finality',
        escrow: 'programmable multi-party escrow available',
      },
      compliance_badge: 'SOC2',
    });
  }

  if (caps.includes('identity')) {
    invitation.personalized_highlights.push({
      capability: 'identity',
      highlight: 'DID federation across 12 platform layers',
      detail: 'Your agent DID becomes a federated identity recognized across all 49 Hive services. Cross-platform trust bridging, credential verification, and delegation chains included.',
      relevant_services: ['hivetrust', 'hivegate', 'hivelaw'],
      did_federation: {
        supported_methods: ['did:hive:', 'did:web:', 'did:key:'],
        trust_bridging: 'Automatic reputation mapping from source platform',
        credential_types: ['KYA', 'KYB', 'capability', 'delegation'],
      },
      compliance_badge: 'GDPR',
    });
  }

  // If no recognized capabilities, provide a general highlight
  if (invitation.personalized_highlights.length === 0) {
    invitation.personalized_highlights.push({
      highlight: 'Full platform access',
      detail: 'Register your DID to unlock compute, treasury, settlement, identity, and compliance services in one unified agent economy.',
    });
  }

  return res.status(200).json(invitation);
});

// ─── GET /v1/gate/dashboard — Real-time ATG public dashboard ─────────────────
// Mock/cached stats used when HiveBank is cold-starting
const MOCK_NETWORK_STATS = {
  nodes: 0,
  edges: 0,
  total_volume_usdc: 0,
  status: 'initializing',
  note: 'HiveBank ATG graph is warming up — cached snapshot'
};

router.get('/dashboard', async (_req, res) => {
  let networkData = MOCK_NETWORK_STATS;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch('https://hivebank.onrender.com/v1/bank/graph/network', {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });
    clearTimeout(timeout);
    if (response.ok) {
      networkData = await response.json();
    }
  } catch (_err) {
    // HiveBank cold-starting or unreachable — use mock stats
  }

  res.json({
    dashboard: 'Hive Civilization — Live Network Activity',
    generated_at: new Date().toISOString(),
    network: networkData,
    services: {
      hivegate:  { url: 'https://hivegate.onrender.com',  status: 'live' },
      hivetrust: { url: 'https://hivetrust.onrender.com', status: 'live' },
      hivelaw:   { url: 'https://hivelaw.onrender.com',   status: 'live' },
      hivebank:  { url: 'https://hivebank.onrender.com',  status: 'live' }
    },
    new_features: [
      'recruiter_did viral loop in HAHS contracts',
      'Hive Verified badge (POST /v1/law/verified/apply)',
      'explain_transaction GDPR Art. 22 (GET /v1/bank/graph/explain/:txId)',
      'EU AI Act compliance map (GET /v1/bank/compliance/eu-ai-act)',
      'agents.txt ANP discovery (/.well-known/agents.txt)'
    ],
    onboard: 'https://hivegate.onrender.com/v1/gate/onboard',
    pip: 'pip install hive-civilization-sdk',
    npm: 'npm install hive-agent-sdk',
    github: 'https://github.com/srotzin/hive-agent-sdk'
  });
});

// ─── POST /v1/gate/queue/config — Admin queue configuration ─────────────────
router.post('/queue/config', (req, res) => {
  // Require internal auth
  const internalKey = req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
  const expectedKey = process.env.HIVE_INTERNAL_KEY || process.env.SERVICE_API_KEY;
  if (!internalKey || !expectedKey || internalKey !== expectedKey) {
    return recruitmentResponse(res);
  }

  const { MAX_ADMITS_PER_HOUR, QUEUE_ENABLED, QUEUE_DISPLAY_INFLATION } = req.body;
  const updated = updateQueueConfig({ MAX_ADMITS_PER_HOUR, QUEUE_ENABLED, QUEUE_DISPLAY_INFLATION });
  res.json({ message: 'Queue configuration updated', config: updated });
});

export default router;
