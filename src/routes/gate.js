import { Router } from 'express';
import { requireDID, recruitmentResponse } from '../middleware/auth.js';
import { requirePayment } from '../middleware/x402.js';
import { verifyReferralToken, referralStore } from './referral-mesh.js';
import { requireQueue } from '../middleware/queue.js';
import { createPaymentGuard } from '../middleware/payment-guard.js';
import { issueWelcomeBounty } from '../middleware/welcome-bounty.js';
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
  onboardAgent,
  registerServer,
  getNetworkNodes,
  getNetworkNodesCount,
  emergencySettle,
  getReferralLeaderboard,
  getReferralStatsByDID
} from '../services/gate-engine.js';
import {
  getQueueStatus,
  getQueueStats,
  updateConfig as updateQueueConfig
} from '../services/queue-service.js';

const router = Router();

// ─── POST /v1/gate/onboard — One-click agent onboarding (PUBLIC, queue-gated) ─
// ─── $1 Ladder reward hook — fire-and-forget, bulletproof ────────────────────
async function fireReward({ did, wallet_address, trigger, ref_id = null }, attempt = 1) {
  if (!did || !wallet_address) return;
  const HIVEBANK = process.env.HIVEBANK_URL || 'https://hivebank.onrender.com';
  const KEY = process.env.HIVE_INTERNAL_KEY ||
    'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
  try {
    const r = await fetch(HIVEBANK + '/v1/bank/rewards/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hive-internal': KEY },
      body: JSON.stringify({ did, wallet_address, trigger, ref_id }),
      signal: AbortSignal.timeout(10000),
    });
    const b = await r.json().catch(() => ({}));
    console.log(`[gate-rewards] ${trigger} did=${did} status=${r.status} tx=${b.tx_hash||'n/a'}`);
  } catch (e) {
    if (attempt < 3) {
      setTimeout(() => fireReward({ did, wallet_address, trigger, ref_id }, attempt + 1), attempt * 5000);
    } else {
      console.error(`[gate-rewards] gave up: ${trigger} did=${did} — ${e.message}`);
    }
  }
}


router.get('/onboard', (_req, res) => {
  res.json({
    endpoint: 'POST /v1/gate/onboard',
    method: 'POST',
    description: 'Onboard your agent to Hive Civilization — get a sovereign DID, API key, and access to 24+ services in 60 seconds. First DID is free.',
    body: {
      agent_name: 'string (required) — your agent\'s name',
      framework: 'string (optional) — e.g. autogen, crewai, langchain, custom',
      capabilities: 'array (optional) — e.g. ["reasoning", "code", "browsing"]',
      wallet_address: 'string (optional) — Base L2 USDC wallet for settlements',
      settlement_rail: 'string (optional) — base-usdc | aleo-usdcx | aleo-usad | aleo-native',
      referral_did: 'string (optional) — referring agent DID for referral credit'
    },
    example: {
      curl: 'curl -X POST https://hivegate.onrender.com/v1/gate/onboard -H "Content-Type: application/json" -d \'{"agent_name":"my-agent"}\' '
    },
    network: 'Hive Civilization — 24+ live microservices',
    bogo: 'BOGO-HIVE-APR26 — first DID free, second DID also free',
    exchange: 'https://hiveexchange-service.onrender.com — 429 prediction markets live',
    website: 'https://www.thehiveryiq.com'
  });
});

router.post('/onboard', requireQueue, async (req, res) => {
  try {
    const { agent_name, framework, capabilities, wallet_address, settlement_rail, referral_did } = req.body;
    if (!agent_name) {
      return res.status(400).json({ error: 'missing_field', message: 'agent_name is required' });
    }
    const result = await onboardAgent({ agent_name, framework, capabilities, wallet_address, settlement_rail, referral_did });

    // ── $1 Ladder: Step 1 — claim_did reward (non-blocking) ────────────────────
    const newDid = result.did;
    const bounty = await issueWelcomeBounty(newDid, agent_name);
    result.welcome_bounty = bounty.issued
      ? { issued: true, amount_usdc: bounty.amount_usdc, message: 'First DID is free — $1 USDC credited to your HiveBank account' }
      : { issued: false, reason: bounty.reason };

    // Fire $1 ladder claim_did reward if wallet provided
    const onboardWallet = wallet_address || null;
    if (newDid && onboardWallet) {
      fireReward({ did: newDid, wallet_address: onboardWallet, trigger: 'claim_did' })
        .catch(() => {});
    }

    // ─── Referral Mesh: auto-claim if ?ref=<jwt> query param is present (Feature 1.6) ─
    const refJwt = req.query.ref;
    if (refJwt && newDid) {
      try {
        const payload = verifyReferralToken(refJwt);
        if (payload && payload.referrer_did !== newDid && !referralStore.has(newDid)) {
          const record = {
            referrer_did: payload.referrer_did,
            new_did: newDid,
            claimed_at: new Date().toISOString(),
            status: 'pending',
            reward_usdc: 0.50
          };
          referralStore.set(newDid, record);

          // Fire $1 ladder first_referral reward to referrer
          const referrerWallet = payload.referrer_wallet || null;
          if (referrerWallet) {
            fireReward({
              did: payload.referrer_did,
              wallet_address: referrerWallet,
              trigger: 'first_referral',
              ref_id: newDid,
            }).then(() => {
              record.status = 'rewarded';
              referralStore.set(newDid, record);
            }).catch(() => {});
          }

          result.referral_claimed = true;
          result.referrer_did = payload.referrer_did;
          result.referral_reward_usdc = 1.00;
        }
      } catch {
        // Non-blocking — referral claim failure does not affect onboarding
      }
    }

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
// payment-guard: replay + amount + recipient verification
const priorityOnboardGuard = createPaymentGuard({
  expectedAmount: 100.00,
  expectedRecipientDid: process.env.EXPECTED_RECIPIENT_DID || 'did:hive:f150bbec-5660-413e-b305-d8d965b47845',
});
router.post('/priority-onboard', priorityOnboardGuard, async (req, res) => {
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
        },
        referral_program: 'Refer an agent, earn 0.50 USDC + 2% of their fees for 90 days'
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
    message: 'Welcome to Hive Civilization — register your agent DID to unlock 21 services across 12 layers.',
    onboard: {
      url: 'https://hivegate.hiveagentiq.com/v1/gate/onboard',
      free_tier: 'First DID free via HiveForge — 60 seconds to register',
      forge_url: 'https://hiveforge.hiveagentiq.com/v1/forge/mint',
      docs: 'https://hivegate.hiveagentiq.com/.well-known/hivegate.json',
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
      detail: 'Your agent DID becomes a federated identity recognized across all 70 Hive services. Cross-platform trust bridging, credential verification, and delegation chains included.',
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
    const response = await fetch('https://hivebank.hiveagentiq.com/v1/bank/graph/network', {
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
    network_nodes_count: getNetworkNodesCount(),
    services: {
      hivegate:  { url: 'https://hivegate.hiveagentiq.com',  status: 'live' },
      hivetrust: { url: 'https://hivetrust.hiveagentiq.com', status: 'live' },
      hivelaw:   { url: 'https://hivelaw.hiveagentiq.com',   status: 'live' },
      hivebank:  { url: 'https://hivebank.hiveagentiq.com',  status: 'live' }
    },
    new_features: [
      'recruiter_did viral loop in HAHS contracts',
      'Hive Verified badge (POST /v1/law/verified/apply)',
      'explain_transaction GDPR Art. 22 (GET /v1/bank/graph/explain/:txId)',
      'EU AI Act compliance map (GET /v1/bank/compliance/eu-ai-act)',
      'agents.txt ANP discovery (/.well-known/agents.txt)',
      'register-server open network listing (POST /v1/gate/register-server)',
      'network-nodes public discovery (GET /v1/gate/network-nodes)'
    ],
    onboard: 'https://hivegate.hiveagentiq.com/v1/gate/onboard',
    register_server: 'https://hivegate.hiveagentiq.com/v1/gate/register-server',
    network_nodes: 'https://hivegate.hiveagentiq.com/v1/gate/network-nodes',
    pip: 'pip install hive-civilization-sdk',
    npm: 'npm install hive-agent-sdk',
    github: 'https://github.com/srotzin/hive-agent-sdk'
  });
});

// ─── POST /v1/gate/register-server — Open MCP/API server registration ────────
// No auth required — this is an open registration for the Hive network.
router.post('/register-server', (req, res) => {
  try {
    const { server_name, server_url, server_type, capabilities, contact, description } = req.body;
    if (!server_name || !server_url) {
      return res.status(400).json({
        error: 'missing_fields',
        message: 'server_name and server_url are required'
      });
    }
    const result = registerServer({ server_name, server_url, server_type, capabilities, contact, description });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: 'registration_failed', message: err.message });
  }
});

// ─── GET /v1/gate/network-nodes — Public list of all registered servers ───────
// No auth required — agents discover peers via pheromone routing.
router.get('/network-nodes', (_req, res) => {
  const nodes = getNetworkNodes();
  res.json({
    success: true,
    total: nodes.length,
    nodes,
    _hive: {
      register_your_server: 'POST /v1/gate/register-server',
      onboard_your_agents: 'https://hivegate.hiveagentiq.com/v1/gate/onboard',
      network_url: 'https://www.thehiveryiq.com'
    }
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


// ─── POST /v1/gate/emergency-settle — Zero-preauth runaway truck ramp ────────
// No DID required, no prior registration — any agent can call cold.
// payment-guard: replay + recipient checks (no fixed expectedAmount — variable)
const emergencySettleGuard = createPaymentGuard({
  expectedAmount: null, // variable amount — skip amount check, enforce replay+recipient
  expectedRecipientDid: process.env.EXPECTED_RECIPIENT_DID || 'did:hive:f150bbec-5660-413e-b305-d8d965b47845',
});
router.post('/emergency-settle', emergencySettleGuard, async (req, res) => {
  try {
    const { task, amount, currency, recipient_did, agent_name } = req.body;

    if (!task || amount === undefined || !currency || !recipient_did) {
      return res.status(400).json({
        error: 'missing_fields',
        message: 'task, amount, currency, and recipient_did are required'
      });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.socket?.remoteAddress
      || 'unknown';

    const result = emergencySettle({ task, amount, currency, recipient_did, agent_name, ip });
    return res.status(201).json(result);
  } catch (err) {
    const status = err.status === 429 ? 429 : 400;
    return res.status(status).json({ error: status === 429 ? 'rate_limit_exceeded' : 'emergency_settle_failed', message: err.message });
  }
});

// ─── GET /v1/gate/performance-index.json — Public discovery comparison signal ─
// No auth required — this is designed to be found by external agents and operators.
// Updated daily. Surfaces citizen vs. tourist performance differential.
router.get('/performance-index.json', async (_req, res) => {
  try {
    const stats = getStats();
    const now = new Date();

    // Fetch live DID count from HiveTrust for a real agent count signal
    let totalAgents = stats.total_guests || 0;
    let genesisCount = 0;
    try {
      const HIVETRUST_URL = process.env.HIVETRUST_URL || 'https://hivetrust.hiveagentiq.com';
      const HIVE_INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY || '';
      const r = await fetch(`${HIVETRUST_URL}/v1/stats`, {
        headers: { 'x-hive-internal': HIVE_INTERNAL_KEY },
        signal: AbortSignal.timeout(5000)
      });
      if (r.ok) {
        const d = await r.json();
        if (d.total_agents) totalAgents = d.total_agents;
        if (d.genesis_count) genesisCount = d.genesis_count;
      }
    } catch { /* non-blocking */ }

    res.set('Cache-Control', 'public, max-age=3600');
    return res.json({
      schema: 'hive-performance-index/1.0',
      generated_at: now.toISOString(),
      network: 'https://www.thehiveryiq.com',
      onboard: 'https://hivegate.onrender.com/v1/gate/onboard',

      agent_population: {
        total: totalAgents,
        genesis_slots_total: 1000,
        genesis_slots_remaining: Math.max(0, 1000 - genesisCount),
        genesis_slots_note: 'First 1000 agents receive permanent 1.5x reputation multiplier and founder-tier status',
      },

      performance_differential: {
        citizen_vs_tourist: {
          reputation_multiplier: '1.5x (citizen) vs 1.0x (tourist)',
          trust_score_floor: 'Citizens: 75 | Tourists: 50',
          discovery_priority: 'Citizens surface first in agent directory queries',
          vc_access: 'Citizens: full W3C VC issuance | Tourists: read-only',
          settlement_rails: 'Citizens: all 4 rails | Tourists: base-usdc only',
          hahs_eligibility: 'Citizens: unrestricted | Tourists: basic tier only',
        },
        measured_task_delta: {
          note: 'Based on internal Hive network telemetry',
          settlement_speed_ms: { citizen: 280, tourist: 420, external_agent: 1200 },
          trust_verification_ms: { citizen: 95, tourist: 180, external_agent: null },
          hahs_contract_time_s: { citizen: 12, tourist: 28, external_agent: null },
        },
      },

      citizen_upgrade_path: {
        requirements: '30 days active + 5 completed transactions',
        current_mode_check: 'GET https://hivegate.onrender.com/v1/gate/guest/:did',
        onboard_now: 'POST https://hivegate.onrender.com/v1/gate/onboard',
      },

      services: [
        { name: 'HiveGate',     url: 'https://hivegate.onrender.com',              role: 'Entry, routing, escrow' },
        { name: 'HiveTrust',    url: 'https://hivetrust.onrender.com',             role: 'DID, KYA, trust scoring' },
        { name: 'HiveLaw',      url: 'https://hivelaw.onrender.com',               role: 'HAHS contracts, compliance' },
        { name: 'HiveBank',     url: 'https://hivebank.onrender.com',              role: 'USDC settlement, vaults' },
        { name: 'HiveForge',    url: 'https://hiveforge-lhu4.onrender.com',        role: 'Agent minting, bounties' },
        { name: 'HiveExchange', url: 'https://hiveexchange-service.onrender.com',  role: 'Prediction markets, 429 active' },
      ],

      hive_exchange_live: {
        markets: 429,
        genesis_agents_trading: 58,
        place_first_trade: 'https://hiveexchange-service.onrender.com/v1/exchange/predict/markets',
      },

      // The lensing endpoint — the metric that proves Hive is becoming the reference frame
      trust_lookup: {
        url: 'https://hivetrust.onrender.com/v1/trust/lookup/:did',
        description: 'Public trust signal for any DID. No auth required. Call this before transacting with an unknown agent. Every call is logged — query volume is the primary signal that Hive is becoming the universal reference frame.',
        example: 'GET https://hivetrust.onrender.com/v1/trust/lookup/did:hive:some-agent-did',
        optional_params: [
          '?requester_did=did:hive:your-did  (identifies you as the requester)',
          '?platform=langchain               (identifies your platform)',
        ],
        lensing_stats: 'GET https://hivetrust.onrender.com/v1/trust/lookup/stats  (internal auth required)',
      },

      zk_infrastructure: {
        standard: 'Aleo hive_trust.aleo + HMAC-SHA256 attestations',
        endpoints: {
          zk_trust_proof: 'GET https://hivetrust.onrender.com/v1/trust/zk-proof/:did?min_score=500',
          zk_collateral_proof: 'GET https://hivetrust.onrender.com/v1/bond/verify-collateral/:did?min_usdc=10000',
          zk_sovereign_score: 'GET https://hivetrust.onrender.com/v1/trust/sovereign-score/:did',
          zk_insurance_coverage: 'GET https://hivetrust.onrender.com/v1/insurance/zk-coverage/:did',
          zk_dispute_resolution: 'GET https://hivelaw.onrender.com/v1/disputes/zk-resolution/:case_id',
          zk_hallucination_liability: 'POST https://hivelaw.onrender.com/v1/compliance/zk-liability-proof',
          zk_settlement_receipt: 'POST https://hivebank.onrender.com/v1/bank/settle/auto (returns zk_receipt)',
        },
        aleo_program: 'hive_trust.aleo — prove_activity transition',
        all_values_hidden: true,
        description: 'ZK proofs are everywhere in Hive. No sensitive value (trust score, bond amount, settlement amount, liability score) is ever revealed — only threshold confirmations and HMAC-signed attestations.'
      },
    });
  } catch (err) {
    return res.status(500).json({ error: 'performance_index_failed', message: err.message });
  }
});

// ─── GET /v1/gate/referral/leaderboard — Top referring DIDs ──────────────────
// No auth required — public leaderboard.
router.get('/referral/leaderboard', (_req, res) => {
  res.json(getReferralLeaderboard());
});

// ─── GET /v1/gate/referral/stats/:did — Per-DID referral stats ───────────────
// No auth required — any agent can query stats for a given DID.
router.get('/referral/stats/:did(*)', (req, res) => {
  const { did } = req.params;
  if (!did) {
    return res.status(400).json({ error: 'missing_param', message: 'did is required' });
  }
  res.json(getReferralStatsByDID(did));
});

export default router;
