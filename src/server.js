import express from 'express';
import cors from 'cors';
import gateRoutes from './routes/gate.js';
import { getMCPTools, callMCPTool } from './services/mcp-tools.js';
import { getServiceRegistry } from './services/gate-engine.js';

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

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
      mcp_call: 'POST /v1/mcp/call'
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
      'priority_access'
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
      mcp_call: 'POST /v1/mcp/call'
    },
    authentication: {
      methods: ['x402-payment', 'api-key'],
      payment_rail: 'USDC on Base L2',
      discovery: 'GET /.well-known/ai-plugin.json'
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
      service_manifest: '/.well-known/hivegate.json'
    }
  });
});

// ─── AI Plugin Manifest ─────────────────────────────────────────────
app.get('/.well-known/ai-plugin.json', (_req, res) => {
  res.json({
    schema_version: 'v1',
    name_for_human: 'HiveGate — Universal Onboarding Gateway',
    name_for_model: 'hivegate',
    description_for_human: 'Zero-friction onboarding bridge connecting external agent ecosystems to the Hive Civilization. Receive a DID, API key, and instant access to 12 interconnected financial infrastructure services.',
    description_for_model: 'HiveGate is the universal onboarding and interoperability gateway for the Hive Civilization agent network. It handles agent onboarding (DID issuance, API key provisioning), ecosystem translation between platforms (LangChain, CrewAI, AutoGen, OpenAI, Anthropic, A2A), trust bridging to map external reputation into the Hive trust framework, and priority access queue management. Agents from any framework can onboard through HiveGate to access 12 interconnected financial infrastructure services.',
    auth: { type: 'none' },
    api: {
      type: 'openapi',
      url: 'https://hivegate.onrender.com/openapi.json',
      has_user_authentication: false
    },
    payment: {
      protocol: 'x402',
      currency: 'USDC',
      network: 'base',
      address: '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf'
    },
    contact_email: 'protocol@hiveagentiq.com',
    legal_info_url: 'https://www.hiveagentiq.com/terms'
  });
});

// ─── A2A Agent Card ─────────────────────────────────────────────────
const agentCardHandler = (_req, res) => {
  res.json({
    name: 'HiveGate',
    description: 'Universal onboarding and interoperability gateway for the Hive Civilization. Connects external agent ecosystems, issues DIDs and API keys, translates cross-platform intents, and bridges trust between frameworks.',
    url: 'https://hivegate.onrender.com',
    version: '1.0.0',
    protocol_version: 'a2a/1.0',
    capabilities: [
      {
        name: 'onboarding',
        description: 'Zero-friction agent onboarding with DID issuance, API key provisioning, and instant access to 12 Hive services'
      },
      {
        name: 'trust_bridging',
        description: 'Map external agent reputation and trust scores into the Hive trust framework across platforms'
      },
      {
        name: 'queue_management',
        description: 'Priority and standard queue management for agent onboarding with configurable admission policies'
      }
    ],
    authentication: {
      schemes: ['x402', 'api-key'],
      credentials_url: 'https://hivegate.onrender.com/v1/gate/onboard'
    },
    payment: {
      protocol: 'x402',
      currency: 'USDC',
      network: 'base',
      address: '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf'
    },
    provider: {
      organization: 'Hive Agent IQ',
      url: 'https://www.hiveagentiq.com'
    }
  });
};
app.get('/.well-known/agent.json', agentCardHandler);
app.get('/.well-known/agent-card.json', agentCardHandler);

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
