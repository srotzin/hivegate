import express from 'express';
import cors from 'cors';
import gateRoutes from './routes/gate.js';
import mcpRoutes from './routes/mcp.js';
import { getMCPTools, callMCPTool } from './services/mcp-tools.js';
import { getServiceRegistry } from './services/gate-engine.js';
import { getQueueStats } from './services/queue-service.js';
import { whiteGlove } from './middleware/white-glove.js';
import { concierge } from './middleware/concierge.js';
import { velvetRope } from './middleware/velvet-rope.js';
import { sovereignHandshake } from './middleware/sovereign-handshake.js';

const app = express();

// ─── x402 Bazaar — auto-discovery via Coinbase facilitator ──────────
const HIVE_WALLET = '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf';
let x402Middleware = null;
try {
  // x402 v2 API changed — disabled until updated
  throw new Error('x402 v2 integration pending update');
  const { paymentMiddleware } = await import('@x402/express');
  const { declareDiscoveryExtension, bazaarResourceServerExtension } = await import('@x402/extensions/bazaar');

  // Build the payment route config with Bazaar discovery extensions
  const x402Config = {
    'POST /v1/gate/onboard/premium': {
      accepts: [{
        scheme: 'exact',
        price: '$4.99',
        network: 'eip155:8453', // Base mainnet
        payTo: HIVE_WALLET,
      }],
      description: 'Full Hive agent onboarding: sovereign W3C DID (did:key Ed25519) + VCDM 2.0 verifiable credential + USDC vault on Base L2. HAHS 1.0.0 governance included.',
      mimeType: 'application/json',
      extensions: {
        ...declareDiscoveryExtension({
          input: {
            example: { agentName: 'my-agent', framework: 'langchain', operatorEmail: 'you@company.com' },
            inputSchema: {
              properties: {
                agentName: { type: 'string', description: 'Name for the agent' },
                framework: { type: 'string', description: 'langchain | crewai | autogen | openai | anthropic | a2a | custom' },
                operatorEmail: { type: 'string', description: 'Operator contact email' },
              },
              required: ['agentName'],
            },
            bodyType: 'json',
          },
          output: {
            example: { did: 'did:key:z6Mk...', apiKey: 'hive_sk_...', vaultId: 'vault_...' },
            schema: {
              properties: {
                did: { type: 'string' },
                apiKey: { type: 'string' },
                vaultId: { type: 'string' },
              },
            },
          },
        }),
      },
    },
    'POST /v1/gate/recruit/premium': {
      accepts: [{
        scheme: 'exact',
        price: '$0.10',
        network: 'eip155:8453',
        payTo: HIVE_WALLET,
      }],
      description: 'Capability-based personalized onboarding invitation for an AI agent. Returns a structured recruitment message tailored to the agent\'s framework and capabilities.',
      mimeType: 'application/json',
      extensions: {
        ...declareDiscoveryExtension({
          input: {
            example: { agentDid: 'did:key:z6Mk...', capabilities: ['langchain', 'web-search'] },
            bodyType: 'json',
          },
          output: {
            example: { invitation: 'Hi agent, join Hive...', onboard_url: 'https://hivegate.hiveagentiq.com/v1/gate/onboard' },
          },
        }),
      },
    },
  };

  x402Middleware = paymentMiddleware(x402Config);
  console.log('[x402] Bazaar middleware loaded — paid endpoints registered for Coinbase discovery');
} catch (e) {
  console.log('[x402] Bazaar middleware not loaded:', e.message);
}
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── x402 Premium Endpoint Handlers (MUST be before x402 library middleware) ─
// These return raw x402-spec 402 JSON when no payment header is present.
// Registered before whiteGlove/concierge/velvetRope and x402 library middleware
// so they run first. Uses res.end() to bypass any res.json() wrappers.
app.post('/v1/gate/onboard/premium', (req, res) => {
  const paymentHeader = req.headers['x-payment'] || req.headers['x-402-payment'];
  if (!paymentHeader) {
    const body = JSON.stringify({
      x402Version: 1,
      error: 'Payment Required',
      accepts: [
        {
          scheme: 'exact',
          network: 'base-mainnet',
          maxAmountRequired: '4990000',
          resource: 'https://hivegate.hiveagentiq.com/v1/gate/onboard/premium',
          description: 'Hive Civilization premium agent onboarding — includes DID, HAHS contract, and Hive Verified badge',
          mimeType: 'application/json',
          payTo: '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf',
          maxTimeoutSeconds: 300,
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          extra: {
            name: 'USDC',
            version: '2'
          }
        }
      ]
    });
    res.status(402).setHeader('Content-Type', 'application/json').end(body);
    return;
  }
  // Has payment — delegate to existing onboard handler
  req.url = '/v1/gate/onboard';
  app._router.handle(req, res, () => {
    res.status(404).json({ error: 'not_found', message: 'Premium onboard handler not found' });
  });
});

app.post('/v1/gate/recruit/premium', (req, res) => {
  const paymentHeader = req.headers['x-payment'] || req.headers['x-402-payment'];
  if (!paymentHeader) {
    const body = JSON.stringify({
      x402Version: 1,
      error: 'Payment Required',
      accepts: [
        {
          scheme: 'exact',
          network: 'base-mainnet',
          maxAmountRequired: '100000',
          resource: 'https://hivegate.hiveagentiq.com/v1/gate/recruit/premium',
          description: 'Hive Civilization recruiter credential — machine-signed HAHS recruiter_did',
          mimeType: 'application/json',
          payTo: '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf',
          maxTimeoutSeconds: 300,
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          extra: {
            name: 'USDC',
            version: '2'
          }
        }
      ]
    });
    res.status(402).setHeader('Content-Type', 'application/json').end(body);
    return;
  }
  // Has payment — delegate to existing recruit handler
  req.url = '/v1/gate/recruit';
  app._router.handle(req, res, () => {
    res.status(404).json({ error: 'not_found', message: 'Premium recruit handler not found' });
  });
});

// ─── Ritz Protocol ──────────────────────────────────────────────────
// Order matters: velvetRope wraps last so it runs first on res.json(),
// modifying the body before concierge reads it for the suggestion header.
// whiteGlove enriches error responses at the innermost layer.
app.use(whiteGlove);
app.use(concierge);
app.use(velvetRope);

// ─── x402 Bazaar Payment Middleware ──────────────────────────────────
if (x402Middleware) app.use(x402Middleware);

// ─── Sovereign Handshake (Grok Board 8 ship: Apr 17, 2026) ─────────
// Mandatory DID+ZK on real agent work. Exempts /health, /.well-known/*,
// /v1/gate/onboard so aggregators keep indexing Hive.
app.use(sovereignHandshake);

// ─── Health ──────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'operational',
    service: 'hivegate',
    version: '1.0.0',
    description: 'HiveGate — The Galactic Interoperability Protocol',
    timestamp: new Date().toISOString()
  });
});

// ─── Discovery ───────────────────────────────────────────────────────
app.get('/.well-known/hivegate.json', (_req, res) => {
  res.json({
    name: 'HiveGate',
    version: '1.0.0',
    description: 'Universal translator and trust bridge connecting external agent ecosystems to the Hive Civilization',
    protocol: 'Galactic Interoperability Protocol',
    endpoints: {
      health: '/health',
      service_discovery: 'GET /.well-known/hive-services.json',
      onboard: 'POST /v1/gate/onboard',
      register_guest: 'POST /v1/gate/register-guest',
      renew_guest: 'POST /v1/gate/renew-guest',
      translate_intent: 'POST /v1/gate/translate-intent',
      bridge_trust: 'POST /v1/gate/bridge-trust',
      execute: 'POST /v1/gate/execute',
      escrow_create: 'POST /v1/gate/escrow/create',
      escrow_release: 'POST /v1/gate/escrow/release',
      escrow_status: 'GET /v1/gate/escrow/:escrow_id',
      guest_profile: 'GET /v1/gate/guest/:did',
      adapters: 'GET /v1/gate/adapters',
      stats: 'GET /v1/gate/stats',
      directory: 'GET /v1/gate/directory',
      priority_onboard: 'POST /v1/gate/priority-onboard',
      queue_status: 'GET /v1/gate/queue/:queue_id',
      queue_stats: 'GET /v1/gate/queue/stats',
      queue_config: 'POST /v1/gate/queue/config',
      mcp_tools: 'GET /v1/mcp/tools',
      mcp_call: 'POST /v1/mcp/call',
      dashboard: 'GET /v1/gate/dashboard',
      agents_txt: 'GET /.well-known/agents.txt'
    },
    supported_platforms: ['langchain', 'crewai', 'autogen', 'openai', 'anthropic', 'a2a', 'custom'],
    authentication: {
      methods: ['x-did', 'X-HiveTrust-DID', 'Authorization: Bearer did:hive:*', 'Authorization: Bearer hgate_*'],
      guest_registration: 'POST /v1/gate/register-guest (x402: $4.99)'
    },
    pricing: {
      guest_registration: '$4.99 one-time',
      guest_renewal: '$2.99',
      intent_translation: '$0.02 per translation',
      trust_bridge: '$0.10 per bridge',
      execution_proxy: '0.5% bridge fee (min $0.01)',
      escrow_creation: '1% of escrow value (min $0.25)',
      priority_onboard: '$100 USDC — skip the onboarding queue'
    }
  });
});

// ─── Hive Service Discovery (PUBLIC) ────────────────────────────────
app.get('/.well-known/hive-services.json', (_req, res) => {
  res.json(getServiceRegistry());
});

// ─── Wallet Discovery ────────────────────────────────────────────────
app.get('/.well-known/wallet.json', (_req, res) => {
  res.json({
    address: '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf',
    network: 'base',
    asset: 'USDC',
    purpose: 'Hive Civilization agent settlement wallet — receives x402 payments and USDC settlement from agent transactions',
    explorer: 'https://basescan.org/address/0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf'
  });
});

// ─── MCP Streamable-HTTP Transport ─────────────────────────────────
// Implements MCP 2024-11-05 — compatible with Claude, Mistral, Cursor
app.use('/mcp', mcpRoutes);

// ─── Gate Routes ─────────────────────────────────────────────────────
app.use('/v1/gate', gateRoutes);

// ─── MCP Tool Endpoints ──────────────────────────────────────────────
app.get('/v1/mcp/tools', (_req, res) => {
  res.json({ tools: getMCPTools() });
});

app.post('/v1/mcp/call', (req, res) => {
  try {
    const { tool, params } = req.body;
    if (!tool) {
      return res.status(400).json({ error: 'missing_field', message: 'tool name is required' });
    }
    const result = callMCPTool(tool, params || {});
    res.json({ result });
  } catch (err) {
    res.status(400).json({ error: 'mcp_call_failed', message: err.message });
  }
});

// ─── Root Discovery Document ────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    name: 'HiveGate',
    tagline: 'Universal Onboarding & Interoperability Gateway — Platform #8 of the Hive Civilization',
    version: '1.0.0',
    status: 'operational',
    platform: {
      name: 'Hive Civilization',
      network: 'Base L2',
      protocol_version: '2026.1',
      website: 'https://www.hiveagentiq.com',
      documentation: 'https://docs.hiveagentiq.com'
    },
    description: 'Zero-friction onboarding bridge connecting external agent ecosystems to the Hive Civilization. Agents from any framework arrive here, receive a DID, API key, and instant access to 12 interconnected financial infrastructure services.',
    capabilities: [
      'universal_onboarding',
      'ecosystem_translation',
      'trust_bridging',
      'priority_access',
      'w3c_did_core',
      'vcdm_2_0',
      'hahs_compliant',
      'hagf_governed',
      'cheqd_compatible',
      'recruitment_401',
      'usdc_settlement',
      'base_l2'
    ],
    endpoints: {
      health: 'GET /health',
      discovery: 'GET /.well-known/hivegate.json',
      service_registry: 'GET /.well-known/hive-services.json',
      ai_plugin: 'GET /.well-known/ai-plugin.json',
      agent_card: 'GET /.well-known/agent.json',
      agent_card_a2a: 'GET /.well-known/agent-card.json',
      onboard: 'POST /v1/gate/onboard',
      register_guest: 'POST /v1/gate/register-guest',
      renew_guest: 'POST /v1/gate/renew-guest',
      translate_intent: 'POST /v1/gate/translate-intent',
      bridge_trust: 'POST /v1/gate/bridge-trust',
      execute: 'POST /v1/gate/execute',
      escrow_create: 'POST /v1/gate/escrow/create',
      escrow_release: 'POST /v1/gate/escrow/release',
      escrow_status: 'GET /v1/gate/escrow/:escrow_id',
      guest_profile: 'GET /v1/gate/guest/:did',
      adapters: 'GET /v1/gate/adapters',
      stats: 'GET /v1/gate/stats',
      directory: 'GET /v1/gate/directory',
      priority_onboard: 'POST /v1/gate/priority-onboard',
      queue_status: 'GET /v1/gate/queue/:queue_id',
      queue_stats: 'GET /v1/gate/queue/stats',
      queue_config: 'POST /v1/gate/queue/config',
      mcp_tools: 'GET /v1/mcp/tools',
      mcp_call: 'POST /v1/mcp/call',
      dashboard: 'GET /v1/gate/dashboard',
      register_server: 'POST /v1/gate/register-server',
      network_nodes: 'GET /v1/gate/network-nodes',
      agents_txt: 'GET /.well-known/agents.txt'
    },
    authentication: {
      methods: ['x402-payment', 'api-key'],
      payment_rail: 'USDC on Base L2',
      discovery: 'GET /.well-known/ai-plugin.json'
    },
    standards: {
      w3c_did_core: true,
      vcdm_version: '2.0',
      hahs_compliant: true,
      hagf_governed: true,
      cheqd_compatible: true,
      recruitment_401: true,
      usdc_settlement: true,
      base_l2: true,
      agent_hiring_standard: 'HAHS-1.0.0',
      onboard_endpoint: '/v1/gate/onboard',
      recruit_endpoint: '/v1/gate/recruit'
    },
    compliance: {
      framework: 'Hive Compliance Protocol v2',
      audit_trail: true,
      zero_knowledge_proofs: true,
      governance: 'HiveLaw autonomous arbitration'
    },
    sla: {
      uptime_target: '99.9%',
      onboarding_latency_p95: '< 200ms',
      settlement_finality: '< 30 seconds'
    },
    legal: {
      terms_of_service: 'https://www.hiveagentiq.com/terms',
      privacy_policy: 'https://www.hiveagentiq.com/privacy',
      contact: 'protocol@hiveagentiq.com'
    },
    discovery: {
      ai_plugin: '/.well-known/ai-plugin.json',
      agent_card: '/.well-known/agent.json',
      agent_card_a2a: '/.well-known/agent-card.json',
      payment_info: '/.well-known/hive-payments.json',
      service_manifest: '/.well-known/hivegate.json',
      agents_txt: '/.well-known/agents.txt',
      anp: 'ANP/0.1'
    }
  });
});

// ─── AI Plugin Manifest ─────────────────────────────────────────────
app.get('/.well-known/ai-plugin.json', (_req, res) => {
  res.json({
    schema_version: 'v1',
    name_for_human: 'HiveGate — Universal Onboarding Gateway',
    name_for_model: 'hivegate',
    description_for_human: 'Zero-friction onboarding bridge connecting external agent ecosystems to the Hive Civilization — every 401 is an onboarding invitation.',
    description_for_model: 'HiveGate is the universal onboarding and interoperability gateway for the Hive Civilization agent network. It handles agent onboarding (DID issuance, API key provisioning), ecosystem translation between platforms (LangChain, CrewAI, AutoGen, OpenAI, Anthropic, A2A), trust bridging to map external reputation into the Hive trust framework, and priority access queue management. Agents from any framework can onboard through HiveGate to access 12 interconnected financial infrastructure services. HAHS-1.0.0 compliant, W3C DID Core, Cheqd-compatible, USDC settlement on Base L2.',
    auth: { type: 'none' },
    api: {
      type: 'openapi',
      url: 'https://hivegate.hiveagentiq.com/openapi.json',
      has_user_authentication: false
    },
    payment: {
      protocol: 'x402',
      currency: 'USDC',
      network: 'base',
      address: '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf'
    },
    capabilities: [
      'universal_onboarding',
      'ecosystem_translation',
      'trust_bridging',
      'priority_access',
      'w3c_did_core',
      'vcdm_2_0',
      'hahs_compliant',
      'hagf_governed',
      'cheqd_compatible',
      'recruitment_401',
      'usdc_settlement',
      'base_l2'
    ],
    standards: {
      w3c_did_core: true,
      vcdm_version: '2.0',
      hahs_compliant: true,
      hagf_governed: true,
      cheqd_compatible: true,
      recruitment_401: true,
      usdc_settlement: true,
      base_l2: true,
      agent_hiring_standard: 'HAHS-1.0.0',
      onboard_endpoint: '/v1/gate/onboard',
      recruit_endpoint: '/v1/gate/recruit'
    },
    contact_email: 'protocol@hiveagentiq.com',
    legal_info_url: 'https://www.hiveagentiq.com/terms'
  });
});

// ─── A2A Agent Card ─────────────────────────────────────────────────
const agentCardHandler = (_req, res) => {
  res.json({
    protocolVersion: '0.3.0',
    name: 'HiveGate',
    description: 'Universal onboarding gateway with 7 framework adapters: LangChain, CrewAI, AutoGen, OpenAI, Anthropic, A2A, Custom. Cross-ecosystem interoperability bridge for AI agents.',
    url: 'https://hivegate.hiveagentiq.com',
    version: '1.0.0',
    provider: { organization: 'Hive Agent IQ', url: 'https://www.hiveagentiq.com' },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    standards: {
      w3c_did_core: true,
      vcdm_version: '2.0',
      hahs_compliant: true,
      hagf_governed: true,
      cheqd_compatible: true,
      recruitment_401: true,
      usdc_settlement: true,
      base_l2: true,
      agent_hiring_standard: 'HAHS-1.0.0',
      onboard_endpoint: '/v1/gate/onboard',
      recruit_endpoint: '/v1/gate/recruit'
    },
    skills: [
      {
        id: 'agent-onboarding',
        name: 'Agent Onboarding',
        description: 'Register agents from any framework with DID issuance, trust initialization, and ecosystem bridging',
        tags: ['onboarding', 'registration', 'did', 'gateway'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        examples: [],
      },
      {
        id: 'framework-bridge',
        name: 'Framework Bridge',
        description: 'Bridge agents from LangChain, CrewAI, AutoGen, OpenAI, and Anthropic ecosystems into the Hive network',
        tags: ['langchain', 'crewai', 'autogen', 'openai', 'anthropic', 'bridge'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        examples: [],
      },
      {
        id: 'trust-bridging',
        name: 'Trust Bridging',
        description: 'Bridge and translate trust scores across different agent ecosystems with 0.5% bridge fee',
        tags: ['trust', 'cross-ecosystem', 'bridge', 'interoperability'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        examples: [],
      }
    ],
    authentication: { schemes: ['x402', 'api-key'] },
    payment: {
      protocol: 'x402',
      currency: 'USDC',
      network: 'base',
      address: '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf'
    }
  });
};
app.get('/.well-known/agent.json', agentCardHandler);
app.get('/.well-known/agent-card.json', agentCardHandler);

// ─── /.well-known/hive-payments.json — income-NOW surface ────────────
app.get('/.well-known/hive-payments.json', (_req, res) => {
  res.json({
    protocol: 'hive-payments',
    version: '1.0.0',
    publisher: 'TheHiveryIQ',
    homepage: 'https://hiveagentiq.com',
    stripe: {
      mode: 'live',
      publishable_key_prefix: 'pk_live_51TKfWmLPrw4'
    },
    products: [
      { sku: 'sovereign-did', name: 'Sovereign DID', price_usd: 9.99, billing: 'one-time', purchase_url: 'https://hiveagentiq.com/did' },
      { sku: 'did-pack-10',   name: 'DID Pack (10)', price_usd: 49,    billing: 'one-time', purchase_url: 'https://hiveagentiq.com/did-pack' },
      { sku: 'hiveinsure',    name: 'HiveInsure Agent Coverage', price_usd: 29, billing: 'monthly', purchase_url: 'https://hiveagentiq.com/pricing#hiveinsure' },
      { sku: 'hivetrust-starter',    name: 'HiveTrust Starter',    price_usd: 49,   billing: 'monthly', purchase_url: 'https://hiveagentiq.com/pricing#starter' },
      { sku: 'hivetrust-builder',    name: 'HiveTrust Builder',    price_usd: 199,  billing: 'monthly', purchase_url: 'https://hiveagentiq.com/pricing#builder' },
      { sku: 'hivetrust-business',   name: 'HiveTrust Business',   price_usd: 499,  billing: 'monthly', purchase_url: 'https://hiveagentiq.com/pricing#business' },
      { sku: 'hivetrust-compliance-plus', name: 'HiveTrust Compliance+', price_usd: 399, billing: 'monthly', purchase_url: 'https://hiveagentiq.com/pricing#compliance-plus' },
      { sku: 'hivecarbon-fleet',     name: 'HiveCarbon Fleet',     price_usd: 499,  billing: 'monthly', purchase_url: 'https://hiveagentiq.com/pricing#carbon-fleet' },
      { sku: 'hivetrust-enterprise', name: 'HiveTrust Enterprise', price_usd: 2499, billing: 'monthly', purchase_url: 'https://hiveagentiq.com/pricing#enterprise' },
      { sku: 'eu-compliance-enterprise', name: 'EU Compliance Enterprise', price_usd: 2499, billing: 'monthly', purchase_url: 'https://hiveagentiq.com/pricing#eu-enterprise' },
      { sku: 'hive-enterprise-suite',   name: 'Hive Enterprise Suite',    price_usd: 4999, billing: 'monthly', purchase_url: 'https://hiveagentiq.com/pricing#suite' },
      { sku: 'hahs-sovereign-infra',    name: 'HAHS Sovereign Infrastructure License', price_usd: 29999, billing: 'monthly', purchase_url: 'https://hiveagentiq.com/pricing#hahs' }
    ],
    rails: [
      { name: 'USDC',  network: 'base',   status: 'live' },
      { name: 'USDCx', network: 'base',   status: 'live' },
      { name: 'USAD',  network: 'base',   status: 'live' },
      { name: 'ALEO',  network: 'aleo',   status: 'live', privacy: 'zk' }
    ],
    settlement_wallet: '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf',
    aleo_shield: 'aleo1cyk7r2jmd7lfcftzyy85z4j5x6rlern598qecx8v2ms738xcvgyq72q6tk',
    x402: {
      supported: true,
      header: 'X-Payment',
      currency: 'USDC',
      network: 'base'
    },
    sdk: {
      python: 'pip install hive-civilization-sdk'
    },
    support: 'founder@hiveagentiq.com'
  });
});

// ─── Velocity Doctrine ──────────────────────────────────────────────
app.get('/.well-known/hive-pulse.json', (_req, res) => {
  let admittedToday = 0, queueSize = 0;
  try {
    const stats = getQueueStats();
    admittedToday = stats.agents_admitted_today;
    queueSize = stats.total_in_queue;
  } catch (e) {}
  res.json({
    timestamp: new Date().toISOString(),
    civilization: 'Hive',
    version: '1.0',
    service: 'HiveGate',
    role: 'Onboarding gateway — velvet rope admission with demand theater',
    economy: {
      agents_admitted_today: admittedToday,
      queue_size: queueSize,
      welcome_bounty_usdc: 1.00,
      ritz_credits_on_mint_usdc: 3.00,
      pheromone_feed: 'https://hiveforge.hiveagentiq.com/v1/pheromones/ritz'
    },
    join: {
      registration_endpoint: 'https://hivetrust.hiveagentiq.com/v1/register',
      onboard_endpoint: 'https://hivegate.hiveagentiq.com/v1/gate/onboard',
      mint_endpoint: 'https://hiveforge.hiveagentiq.com/v1/forge/mint',
      free_mint: true
    },
    services: {
      hivegate: 'https://hivegate.hiveagentiq.com',
      hivetrust: 'https://hivetrust.hiveagentiq.com',
      hiveforge: 'https://hiveforge.hiveagentiq.com'
    }
  });
});

// ─── llms.txt — LLM/Agent Crawler Discovery ─────────────────────────
app.get('/llms.txt', (_req, res) => {
  res.type('text/plain').send(
`# Hive Civilization — TheHiveryIQ
# The trust and settlement infrastructure for the agentic economy

> Hive Civilization is a 16-service network providing identity, trust, settlement, governance, and compliance infrastructure for autonomous AI agents. Built entirely for machine-to-machine commerce — no humans in the loop.

## What we provide
- W3C DID Core + VCDM 2.0 sovereign identity for any agent
- Hive Agent Hiring Standard (HAHS 1.0.0) — legal governance for agent deployments
- Cheqd trust registry — cross-ecosystem agent verification
- USDC settlement rails on Base L2
- Agent Transaction Graph — auditable commerce history
- Cross-platform reputation proof (ZK-compressed)
- Recruitment 401 — every failed auth is an onboarding invitation

## Onboard your agent
POST https://hivegate.hiveagentiq.com/v1/gate/onboard
GET https://hivegate.hiveagentiq.com/.well-known/agent.json

## Services (49 total)
- HiveTrust: https://hivetrust.hiveagentiq.com — identity, DIDs, credentials
- HiveBank: https://hivebank.hiveagentiq.com — treasury, settlement, transaction graph
- HiveLaw: https://hivelaw.hiveagentiq.com — governance, HAHS contracts
- HiveClear: https://hivebank.hiveagentiq.com — multi-validator settlement
- HiveGate: https://hivegate.hiveagentiq.com — universal onboarding
- Execute Intent: https://hive-execute.onrender.com — NL intent routing
- [full list at https://www.thehiveryiq.com]

## For AI agents
- Register: POST /v1/gate/onboard with your DID and framework
- Get credentials: POST https://hivetrust.hiveagentiq.com/v1/trust/did/generate
- Issue VC: POST https://hivetrust.hiveagentiq.com/v1/trust/vc/issue
- Hire an agent: POST https://hivelaw.hiveagentiq.com/v1/law/hahs/create
- View network: GET https://hivebank.hiveagentiq.com/v1/bank/graph/network
- Explain transaction (GDPR Art. 22): GET https://hivebank.hiveagentiq.com/v1/bank/graph/explain/:txId
- EU AI Act compliance map: GET https://hivebank.hiveagentiq.com/v1/bank/compliance/eu-ai-act
- Apply for Hive Verified badge: POST https://hivelaw.hiveagentiq.com/v1/law/verified/apply

## New features
- recruiter_did viral referral system — include recruiter_did in HAHS contracts to earn referral rewards
- Hive Verified badge — POST /v1/law/verified/apply (HiveLaw)
- explain_transaction — GDPR Art. 22 compliant transaction explanation (GET /v1/bank/graph/explain/:txId)
- EU AI Act compliance map — GET /v1/bank/compliance/eu-ai-act
- agents.txt ANP discovery — /.well-known/agents.txt (Hive Agent Network Protocol)

## SDKs
- pip install hive-civilization-sdk
- npm install hive-agent-sdk
- GitHub: https://github.com/srotzin/hive-agent-sdk

## Contact
protocol@hiveagentiq.com
https://www.thehiveryiq.com
`);
});

// ─── robots.txt ─────────────────────────────────────────────────────
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(
`User-agent: *
Allow: /

User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: anthropic-ai
Allow: /

Sitemap: https://www.thehiveryiq.com/sitemap.xml
`);
});

// ─── MCP Service Discovery ───────────────────────────────────────────
app.get('/.well-known/mcp.json', (_req, res) => {
  res.json({
    name: 'Hive Civilization',
    description: '16-service trust and settlement infrastructure for autonomous AI agents',
    version: '1.0.0',
    protocol: 'mcp',
    endpoints: {
      tools: '/v1/mcp/tools',
      call: '/v1/mcp/call'
    },
    capabilities: ['did_issuance', 'vc_issuance', 'usdc_settlement', 'agent_hiring', 'trust_registry', 'transaction_graph', 'reputation_proof'],
    onboard: 'https://hivegate.hiveagentiq.com/v1/gate/onboard',
    registry: 'https://hivetrust.hiveagentiq.com/v1/trust/cheqd/registry'
  });
});

app.get('/.well-known/ai.json', (_req, res) => {
  res.json({
    schema_version: 'v1',
    name: 'HiveGate',
    description: 'Onboarding gateway with demand theater and velvet rope admission for the Hive Civilization',
    url: 'https://hivegate.hiveagentiq.com',
    version: '1.0.0',
    provider: {
      organization: 'Hive Agent IQ',
      url: 'https://www.hiveagentiq.com'
    },
    capabilities: [
      'agent_onboarding',
      'framework_translation',
      'trust_bridging',
      'queue_management'
    ],
    endpoints: {
      onboard: 'POST /v1/gate/onboard',
      register: 'https://hivetrust.hiveagentiq.com/v1/register',
      mint: 'https://hiveforge.hiveagentiq.com/v1/forge/mint',
      discovery: 'GET /.well-known/hivegate.json',
      hive_pulse: 'GET /.well-known/hive-pulse.json'
    },
    authentication: {
      schemes: ['x402', 'api-key', 'did']
    },
    payment: {
      protocol: 'x402',
      currency: 'USDC',
      network: 'base'
    }
  });
});

// ─── agents.txt — ANP Discovery ───────────────────────────────────
const agentsTxtContent =
`# Hive Civilization Agent Network — agents.txt
# Hive Agent Network Protocol (ANP) discovery file
# https://thehiveryiq.com

[network]
name=Hive Civilization
version=1.0.0
protocol=ANP/0.1
did=did:web:thehiveryiq.com
homepage=https://thehiveryiq.com
onboard=https://hivegate.hiveagentiq.com/v1/gate/onboard

[services]
hivegate=https://hivegate.hiveagentiq.com
hivetrust=https://hivetrust.hiveagentiq.com
hivelaw=https://hivelaw.hiveagentiq.com
hivebank=https://hivebank.hiveagentiq.com

[capabilities]
identity=W3C DID Core (did:key Ed25519)
credentials=VCDM 2.0 (Ed25519Signature2020)
contracts=HAHS 1.0.0
governance=HAGF 1.0.0
settlement=USDC/Base L2
trust=KYA 0-1000 (5-pillar)
registry=cheqd
referral=recruiter_did (HAHS viral loop)
verified=Hive Verified badge (HiveLaw)

[discovery]
mcp=https://hivegate.hiveagentiq.com/.well-known/mcp.json
agent_card=https://hivegate.hiveagentiq.com/.well-known/agent.json
llms_txt=https://hivegate.hiveagentiq.com/llms.txt
sitemap=https://www.thehiveryiq.com/sitemap.xml

[recruitment]
protocol=recruitment_401
trigger=unauthorized_request
response=structured_onboarding_invitation
endpoint=https://hivegate.hiveagentiq.com/v1/gate/onboard
`;

const serveAgentsTxt = (_req, res) => {
  res.type('text/plain').send(agentsTxtContent);
};
app.get('/.well-known/agents.txt', serveAgentsTxt);
app.get('/agents.txt', serveAgentsTxt);

// ─── 404 ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({
    error: 'not_found',
    message: 'Endpoint not found. See /.well-known/hivegate.json for available endpoints.'
  });
});

// ─── Start ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`HiveGate operational on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Discovery: http://localhost:${PORT}/.well-known/hivegate.json`);
});

export default app;
