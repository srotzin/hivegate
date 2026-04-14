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
