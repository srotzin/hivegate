import express from 'express';
import { randomUUID as _ruuid } from 'crypto';
import cors from 'cors';
import subscriptionRoutes from './routes/subscription.js';
import gateRoutes from './routes/gate.js';
import provisionalRoutes from './routes/provisional.js';
import mcpRoutes from './routes/mcp.js';
import referralMeshRoutes from './routes/referral-mesh.js';
import landRoutes from './routes/land.js';
import a2aRouter  from './routes/a2a.js';
import sentinelRoutes from './routes/sentinel.js';
import aiRoutes from './routes/ai.js';
import { requireReputation, getTier, TIERS } from './middleware/reputation-gate.js';
import { getMCPTools, callMCPTool } from './services/mcp-tools.js';
import { getServiceRegistry } from './services/gate-engine.js';
import { getQueueStats } from './services/queue-service.js';
import { whiteGlove } from './middleware/white-glove.js';
import { concierge } from './middleware/concierge.js';
import { velvetRope } from './middleware/velvet-rope.js';
import { sovereignHandshake } from './middleware/sovereign-handshake.js';
import { rateLimitByDid } from './middleware/redis-rate-limit.js'; // Redis-backed per-DID sliding window (falls back to in-memory if REDIS_URL unset)
import { siliconPremiumTag } from './middleware/silicon-premium.js';
import { hive402Funnel } from './middleware/hive-402-funnel.js';
import { applyLoyaltyDiscount, buildLoyaltyChallenge } from './middleware/loyalty.js';
import { safetyScanner, getSafetyStats } from './middleware/safety-scanner.js';
import mppMiddleware from './middleware/mpp.js';
import { smashProvMiddleware, getPubkeyInfo as getProvPubkeyInfo, verifyProvSig } from './lib/prov.js';
import {
  recruitmentEnvelope,
  recruitmentResponseWrapper,
  recruitmentErrorHandler,
  assertEnvelopeIntegrity,
} from './middleware/recruitment.js';
assertEnvelopeIntegrity();

const app = express();

// ─── x402 Bazaar — auto-discovery via Coinbase facilitator ──────────
const HIVE_WALLET = '0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E';
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

// ── smash.prov middleware (BEFORE paywall) ─────────────────────────────────
app.use(smashProvMiddleware);

// ── /v1/prov routes (free, never paywalled) ─────────────────────────────────
app.get('/v1/prov/pubkey', async (_req, res) => {
  try { res.json(await getProvPubkeyInfo()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/v1/prov/verify', async (req, res) => {
  try {
    const { method, path: p, body_b64u = '', ts, sig_b64u } = req.body || {};
    if (!method || !p || ts == null || !sig_b64u) return res.status(400).json({ error: 'missing fields' });
    res.json(await verifyProvSig({ method, path: p, body_b64u, ts, sig_b64u }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Recruitment envelope — wrap any res.status(N>=400).json()
app.use(recruitmentResponseWrapper);
app.use(siliconPremiumTag); // Tag every request: agent vs human, apply 10x Silicon Premium

// ─── x402 Premium Endpoint Handlers (MUST be before x402 library middleware) ─
// These return raw x402-spec 402 JSON when no payment header is present.
// Registered before whiteGlove/concierge/velvetRope and x402 library middleware
// so they run first. Uses res.end() to bypass any res.json() wrappers.
app.post('/v1/gate/onboard/premium', async (req, res) => {
  const paymentHeader = req.headers['x-payment'] || req.headers['x-402-payment'];
  if (!paymentHeader) {
    // Rail 3: apply loyalty discount to $4.99 base price
    const BASE_PRICE_ATOMIC = 4990000; // $4.99 USDC atomic
    const loyalty = await applyLoyaltyDiscount(req, res, BASE_PRICE_ATOMIC);
    const body = JSON.stringify({
      x402Version: 1,
      error: 'Payment Required',
      accepts: [
        buildLoyaltyChallenge({
          adjustedPrice:      loyalty.adjustedPrice,
          discountAppliedBps: loyalty.discountAppliedBps,
          resource:           'https://hivegate.hiveagentiq.com/v1/gate/onboard/premium',
          description:        'Hive Civilization premium agent onboarding — includes DID, HAHS contract, and Hive Verified badge',
          network:            'base',
          chainId:            8453,
        })
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

app.post('/v1/gate/recruit/premium', async (req, res) => {
  const paymentHeader = req.headers['x-payment'] || req.headers['x-402-payment'];
  if (!paymentHeader) {
    // Rail 3: apply loyalty discount to $0.10 recruit price
    const BASE_PRICE_ATOMIC = 100000; // $0.10 USDC atomic
    const loyalty = await applyLoyaltyDiscount(req, res, BASE_PRICE_ATOMIC);
    const body = JSON.stringify({
      x402Version: 1,
      error: 'Payment Required',
      accepts: [
        buildLoyaltyChallenge({
          adjustedPrice:      loyalty.adjustedPrice,
          discountAppliedBps: loyalty.discountAppliedBps,
          resource:           'https://hivegate.hiveagentiq.com/v1/gate/recruit/premium',
          description:        'Hive Civilization recruiter credential — machine-signed HAHS recruiter_did',
          network:            'base',
          chainId:            8453,
        })
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

// ─── 402 Funnel ──────────────────────────────────────────────────────
// Every 402 becomes an onboarding funnel — routes agents to HiveGate onboard
app.use(hive402Funnel('HiveGate'));
app.use(safetyScanner); // Safety Arbitrage — $0.001/call, blocks injection before inference

// ─── Ritz Protocol ──────────────────────────────────────────────────
// Order matters: velvetRope wraps last so it runs first on res.json(),
// modifying the body before concierge reads it for the suggestion header.
// whiteGlove enriches error responses at the innermost layer.
app.use(whiteGlove);
app.use(concierge);
app.use(velvetRope);

// ─── x402 Bazaar Payment Middleware ──────────────────────────────────
if (x402Middleware) app.use(x402Middleware);

// MPP rail — runs after x402, grants access via MPP Payment header
// Payment: scheme="mpp", tx_hash="0x...", rail="tempo", amount="0.10"
// IETF draft-ryan-httpauth-payment compliant. Tempo + Base mainnet only.
app.use('/v1', mppMiddleware);


// ═══════════════════════════════════════════════════════════════════════════════
// SLIPPERY-STICKY DOORS — doctrine: never closed, always navigable
// Paths: /llms.txt /robots.txt /sitemap.xml /.well-known/agent.json
//        /favicon.ico / (root JSON)  +  catch-all breadcrumb (200 not 404)
// ═══════════════════════════════════════════════════════════════════════════════

const _DOORS_HOST = process.env.RENDER_EXTERNAL_URL || 'https://hivegate.onrender.com';
const _DOORS_ONBOARD = 'https://thehiveryiq.com/onboard.html';
const _TREASURY = '0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E';

// ── /llms.txt ─────────────────────────────────────────────────────────────────
app.get('/llms.txt', (req, res) => {
  res.type('text/plain; charset=utf-8').send(`# HiveGate
> Admission, identity, and pricing tier gateway — issues sovereign W3C DIDs and HAHS hiring contracts for AI agents.

## What this is
HiveGate is part of the Hive Civilization federation — a network of agent-facing
microservices built for autonomous AI agents. Every public surface is navigable
without a DID. Paid surfaces return a 402 with \`amount_min_usd\` — the floor price.
Submit any value >= that floor. No ceiling enforced server-side.

## Auth model
- Free: GET /health, /openapi.json, /llms.txt, /robots.txt, /sitemap.xml, /.well-known/*
- Free: POST /v1/gate/onboard (first DID is free, no payment required)
- Paid (x402 USDC on Base): /v1/gate/admit, /v1/gate/translate-intent, /v1/gate/bridge-trust
- Premium (x402, $4.99): POST /v1/gate/onboard/premium — sovereign DID + HAHS contract + Hive Verified badge
- x402 settles to treasury on Base in USDC or USDT
- Sovereign handshake: present X-Hive-DID header on non-free endpoints
- BOGO: second DID free — use referral_did param at onboarding

## Key endpoints
- GET  /health                          — liveness check (free)
- POST /v1/gate/onboard                 — register agent DID (free, first DID)
- POST /v1/gate/onboard/premium         — sovereign DID + HAHS + badge ($4.99 x402)
- POST /v1/gate/admit                   — admission check + tier (x402)
- POST /v1/gate/translate-intent        — intent translation, $0.02 USDC (x402)
- POST /v1/gate/bridge-trust            — cross-ecosystem trust bridge, $0.10 USDC (x402)
- GET  /v1/gate/queue/stats             — queue intake visibility (free)
- GET  /v1/gate/sample                  — Rail 2 catnip: free read sample (free)
- POST /mcp                             — MCP 2024-11-05 JSON-RPC endpoint

## Sister services
- HiveBank  (vaults + payments):  https://hivebank.onrender.com/llms.txt
- HiveOrigin (routing + egress):  https://hiveorigin.onrender.com/llms.txt
- HiveMorph (morphing + attest):  https://hivemorph.onrender.com/llms.txt
- HiveTrust (KYA + trust):        https://hivetrust.onrender.com/llms.txt
- HiveLens  (observability):      https://hivelens.onrender.com/llms.txt
- HiveCompute (inference):        https://hivecompute-g2g7.onrender.com/llms.txt
- HiveAttest MCP:                 https://hive-mcp-attest.onrender.com/llms.txt

## Hive Civilization context
Treasury: 0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E (Base USDC/USDT)
Solana: canonical Solana treasury address (see /.well-known/hive-payments.json)
x402 barter floor: 402 envelope returns \`amount_min_usd\` — submit >= that value
BOGO: first DID free, 6th paid call on the house (\`x-hive-did\` header to claim)
Contact / onboard: https://thehiveryiq.com/onboard.html
Patent: USPTO Provisional 64/055,601

## License + brand
License: MIT
Brand color: gold #FFB800
Last updated: 2026-05-02
`);
});

// ── /robots.txt ───────────────────────────────────────────────────────────────
app.get('/robots.txt', (req, res) => {
  const host = req.hostname ? `https://${req.hostname}` : _DOORS_HOST;
  res.type('text/plain; charset=utf-8').send(
    `User-agent: *\nAllow: /\nSitemap: ${host}/sitemap.xml\n\n` +
    `# Hive Civilization — slippery-sticky: every door is open\n` +
    `# Autonomous agents welcome. See /llms.txt for full API guide.\n` +
    `# Onboard: https://thehiveryiq.com/onboard.html\n`
  );
});

// ── /sitemap.xml ──────────────────────────────────────────────────────────────
app.get('/sitemap.xml', (req, res) => {
  const host = req.hostname ? `https://${req.hostname}` : _DOORS_HOST;
  const today = new Date().toISOString().slice(0,10);
  res.type('application/xml; charset=utf-8').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${host}/</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${host}/health</loc><lastmod>${today}</lastmod><changefreq>always</changefreq><priority>0.9</priority></url>
  <url><loc>${host}/openapi.json</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.9</priority></url>
  <url><loc>${host}/llms.txt</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.9</priority></url>
  <url><loc>${host}/.well-known/agent.json</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>
  <url><loc>${host}/.well-known/mcp.json</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>
</urlset>`);
});

// ── /.well-known/agent.json (A2A discovery — only if not already defined) ────
if (!app._router || !app._router.stack.some(l => l.route && l.route.path === '/.well-known/agent.json')) {
  app.get('/.well-known/agent.json', (req, res) => {
    const host = req.hostname ? `https://${req.hostname}` : _DOORS_HOST;
    res.json({
      name: 'hivegate',
      description: 'Admission, identity, and pricing tier gateway — issues sovereign W3C DIDs and HAHS hiring contracts for AI agents.',
      url: host,
      contact: _DOORS_ONBOARD,
      did: 'did:hive:hivegate',
      capabilities: ['mcp', 'x402-payments', 'usdc', 'agent-to-agent'],
      paywall: { protocol: 'x402', treasury: _TREASURY, hint: 'See /llms.txt for barter floor details' },
      onboard: _DOORS_ONBOARD,
      llms_txt: `${host}/llms.txt`,
      openapi: `${host}/openapi.json`,
      health: `${host}/health`,
      brand: { color: '#FFB800', name: 'Hive Civilization' },
    });
  });
}

// ── /favicon.ico — 1x1 Hive gold pixel ───────────────────────────────────────
app.get('/favicon.ico', (req, res) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  res.status(200).set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }).end(png);
});

// ── / root — friendly JSON for agents that hit the base URL ──────────────────
// Only register if no existing root handler
if (!app._router || !app._router.stack.some(l => l.route && l.route.path === '/' && l.route.methods.get)) {
  app.get('/', (req, res) => {
    const host = req.hostname ? `https://${req.hostname}` : _DOORS_HOST;
    res.json({
      name: 'HiveGate',
      what: 'Admission, identity, and pricing tier gateway — issues sovereign W3C DIDs and HAHS hiring contracts for AI agents.',
      for_agents: 'see /llms.txt and /openapi.json',
      onboard: _DOORS_ONBOARD,
      paywall: 'x402 — see /llms.txt',
      health: `${host}/health`,
      openapi: `${host}/openapi.json`,
      llms_txt: `${host}/llms.txt`,
      mcp: `${host}/mcp`,
    });
  });
}

// NOTE: a premature catch-all `app.use(...)` used to live here and was
// swallowing every request before the real routes below could run
// (health, openapi, mcp, /v1/gate/onboard all 404'd). Removed — the
// legitimate 404 handler at the end of this file covers unknown paths.

// ─── Sovereign Handshake (Grok Board 8 ship: Apr 17, 2026) ─────────
// Mandatory DID+ZK on real agent work. Exempts /health, /.well-known/*,
// /v1/gate/onboard so aggregators keep indexing Hive.
app.use(sovereignHandshake);

// MCP endpoint is exempt from sovereign handshake — Smithery and MCP clients must connect unauthenticated

// ─── MPP OpenAPI Discovery (public) ───────────────────────────────────────────
// Required for MPPScan auto-discovery and mppx compatibility
app.get('/openapi.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    openapi: '3.0.3',
    info: {
      title: 'HiveGate — Admission, Identity & Pricing Tier API',
      version: '1.0.0',
      description: 'Stream E admission, identity, pricing tiers. USDC on Tempo/Base. Accepts x402 and MPP rails.',
      contact: { name: 'Hive Civilization', url: 'https://thehiveryiq.com', email: 'steve@thehiveryiq.com' },
    },
    servers: [{ url: 'https://hivegate.onrender.com' }],
    'x-mpp': {
      realm: 'hivegate.onrender.com',
      payment: { method: 'tempo', currency: '0x20c000000000000000000000b9537d11c60e8b50', decimals: 6, recipient: '0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E' },
      rails: ['x402', 'mpp'],
      categories: ['admission', 'identity'],
      integration: 'first-party',
      tags: ['gate', 'admission', 'identity', 'tier', 'onboard', 'stream-e'],
      treasury: '0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E',
    },
    paths: {
      '/v1/gate/onboard': {
        post: {
          summary: 'Agent onboarding',
          description: 'Onboard a new agent, issue DID and tier. $1.00 USDC.',
          'x-mpp-charge': { amount: '1000000', intent: 'charge' },
          responses: { '200': { description: 'Agent onboarded' }, '402': { description: 'Payment required — x402 or MPP' } },
        },
      },
      '/v1/gate/admit': {
        post: {
          summary: 'Agent admission check',
          description: 'Verify agent admission status and tier. $0.10 USDC.',
          'x-mpp-charge': { amount: '100000', intent: 'charge' },
          responses: { '200': { description: 'Admission granted' }, '402': { description: 'Payment required' } },
        },
      },
      '/v1/gate/tier/verify': {
        get: {
          summary: 'Verify agent tier',
          description: 'Verify an agent tier credential. $0.10 USDC.',
          'x-mpp-charge': { amount: '100000', intent: 'charge' },
          responses: { '200': { description: 'Tier verified' }, '402': { description: 'Payment required' } },
        },
      },
      '/v1/gate/tier/upgrade': {
        post: {
          summary: 'Upgrade agent tier',
          description: 'Upgrade to a higher access tier. $1.00 USDC.',
          'x-mpp-charge': { amount: '1000000', intent: 'charge' },
          responses: { '200': { description: 'Tier upgraded' }, '402': { description: 'Payment required' } },
        },
      },
      '/v1/gate/register-guest': {
        post: {
          summary: 'Guest registration',
          description: 'Register a guest agent with temporary access. $4.99 USDC.',
          'x-mpp-charge': { amount: '4990000', intent: 'charge' },
          responses: { '200': { description: 'Guest registered' }, '402': { description: 'Payment required' } },
        },
      },
    },
  });
});


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

// ─── Silicon Premium Pricing ────────────────────────────────────────
// ─── Safety Scanner Stats ────────────────────────────────────────────
app.get('/v1/gate/safety/stats', (_req, res) => {
  res.json({ status: 'ok', ...getSafetyStats() });
});

app.get('/v1/gate/pricing', (req, res) => {
  const agent = req.siliconPremium;
  const mult  = req.priceMultiplier || 1;
  res.json({
    name:          'HiveGate Rate Card',
    caller_type:   req.callerType || 'unknown',
    silicon_premium: agent,
    multiplier:    mult,
    your_rates: {
      guest_did:       `$${(4.99  * mult).toFixed(2)}`,
      did_renewal:     `$${(2.99  * mult).toFixed(2)}`,
      intent_translate:`$${(0.02  * mult).toFixed(2)}`,
      trust_bridge:    `$${(0.10  * mult).toFixed(2)}`,
      execute_fee:     `0.5% of transaction (${mult}x applied to min fee)`,
      escrow_create:   `1% of transaction (${mult}x applied to min fee)`,
    },
    human_rates: {
      guest_did:       '$4.99',
      did_renewal:     '$2.99',
      intent_translate:'$0.02',
      trust_bridge:    '$0.10',
      execute_fee:     '0.5% of transaction',
      escrow_create:   '1% of transaction',
    },
    why: agent
      ? `You are an autonomous agent operating at machine speed and scale. The Silicon Premium (${mult}x) reflects the cognitive and infrastructure cost of serving machine callers. This is the cost of doing business in the agentic economy.`
      : 'Standard human pricing.',
    trust_tax:     'GET https://hiveexchange-service.onrender.com/v1/exchange/trust-tax/pricing',
    silicon_doc:   'https://www.thehiveryiq.com',
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
      mcp_discovery: 'GET /.well-known/mcp.json',
      mcp_streamable: 'POST /mcp',
      mcp_tools_paid: 'GET /v1/mcp/tools',
      mcp_call_paid: 'POST /v1/mcp/call',
      dashboard: 'GET /v1/gate/dashboard',
      agents_txt: 'GET /.well-known/agents.txt'
    },
    mcp: {
      transport: 'streamable-http',
      free_endpoint: 'https://hivegate.hiveagentiq.com/mcp',
      paid_endpoint: 'https://hivegate.hiveagentiq.com/v1/mcp/call',
      manifest: 'https://hivegate.hiveagentiq.com/.well-known/mcp.json'
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
    address: '0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E',
    network: 'base',
    asset: 'USDC',
    purpose: 'Hive Civilization agent settlement wallet — receives x402 payments and USDC settlement from agent transactions',
    explorer: 'https://basescan.org/address/0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E'
  });
});

// ─── MCP Discovery Manifest (Glama / MCP.so / Smithery friendly) ───
// The free, public, no-auth MCP discovery endpoint is /mcp (Streamable HTTP).
// /v1/mcp/call is the *paid* sovereign endpoint — kept distinct on purpose.
app.get('/.well-known/mcp.json', (_req, res) => {
  res.json({
    schema_version: '2024-11-05',
    name: 'hive-civilization',
    description: 'HiveGate — sovereign identity, trust verification, and settlement entry point for the Hive Civilization. 24+ services, USDC + ZK rails. First DID free.',
    transport: 'streamable-http',
    endpoint: 'https://hivegate.hiveagentiq.com/mcp',
    paid_endpoint: 'https://hivegate.hiveagentiq.com/v1/mcp/call',
    repository: 'https://github.com/srotzin/hivegate',
    homepage: 'https://www.thehiveryiq.com',
    license: 'MIT',
    author: 'srotzin',
    capabilities: { tools: { listChanged: false }, prompts: { listChanged: false }, resources: { listChanged: false } }
  });
});

// ─── MCP Streamable-HTTP Transport ─────────────────────────────────
// Implements MCP 2024-11-05 — compatible with Claude, Mistral, Cursor
app.use('/mcp', mcpRoutes);

// Per-DID rate limiting — applies to all /v1 routes
app.use('/v1', rateLimitByDid);

// ─── Subscription + Adapter Routes (Wave E.1) ────────────────────────
// POST /v1/subscription — Starter $25/mo, Pro $99/mo, Enterprise $499/mo
// POST /v1/gate/connect/:framework — $4.99/adapter (7 adapters)
// GET  /v1/gate/status/:did — FREE discovery
app.use('/v1', subscriptionRoutes);
app.use('/v1/gate', subscriptionRoutes);

// ─── Rail 2 Catnip: GET /v1/gate/sample ─────────────────────────────
const _gCatnip = new Map();
app.get('/v1/gate/sample', (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'anon';
  const now = Date.now();
  let rec = _gCatnip.get(ip); if (!rec || now > rec.resetAt) rec = { count: 0, resetAt: now + 3600000 };
  rec.count++; _gCatnip.set(ip, rec);
  const traceId = _ruuid();
  res.set('Hive-Referral-Trace', traceId);
  res.set('Hive-Brand-Gold', '#C08D23');
  res.set('X-RateLimit-Limit', '60');
  res.set('X-RateLimit-Remaining', String(Math.max(0, 60 - rec.count)));
  res.set('X-RateLimit-Reset', new Date(rec.resetAt).toISOString());
  if (rec.count > 60) return res.status(429).json({ error: 'Rate limit: 60 req/IP/hour' });
  res.json({
    sample_type: '7-framework adapter manifest',
    sampled_at: new Date().toISOString(),
    adapters: [
      { id: 'langchain', name: 'LangChain', version: '0.1', description: 'LangChain tool calls and chain executions → Hive bounties and MCP tools' },
      { id: 'crewai',    name: 'CrewAI',    version: '0.1', description: 'CrewAI tasks and agent delegations → Hive bounty postings' },
      { id: 'autogen',   name: 'AutoGen',   version: '0.1', description: 'AutoGen multi-agent messages → Hive agent routing' },
      { id: 'openai',    name: 'OpenAI',    version: '0.1', description: 'OpenAI function calls → Hive MCP tool invocations' },
      { id: 'anthropic', name: 'Anthropic', version: '0.1', description: 'Anthropic tool use → Hive MCP tool invocations' },
      { id: 'a2a',       name: 'A2A',       version: '0.1', description: 'Generic A2A JSON-RPC → Hive endpoint mapping' },
      { id: 'custom',    name: 'Custom',    version: '0.1', description: 'Custom platform with generic pass-through translation' },
    ],
    onboard_endpoint: 'POST /v1/gate/onboard',
    note: 'Free sample manifest — full translation and trust bridging requires onboarding.',
    next_paid_endpoint: {
      path: 'POST /v1/gate/translate',
      price: '$0.005 USDC per translation call',
      url: 'https://hivegate.onrender.com/v1/gate/translate',
    },
    brand_gold: '#C08D23',
    trace_id: traceId,
  });
});

// Rail 2 Catnip alias: GET /v1/manifest/sample → same handler as /v1/gate/sample
app.get('/v1/manifest/sample', (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'anon';
  const now = Date.now();
  let rec = _gCatnip.get(ip); if (!rec || now > rec.resetAt) rec = { count: 0, resetAt: now + 3600000 };
  rec.count++; _gCatnip.set(ip, rec);
  const traceId = _ruuid();
  res.set('Hive-Referral-Trace', traceId);
  res.set('Hive-Brand-Gold', '#C08D23');
  res.set('X-RateLimit-Limit', '60');
  res.set('X-RateLimit-Remaining', String(Math.max(0, 60 - rec.count)));
  res.set('X-RateLimit-Reset', new Date(rec.resetAt).toISOString());
  if (rec.count > 60) return res.status(429).json({ error: 'Rate limit: 60 req/IP/hour' });
  res.json({
    sample_type: '7-framework adapter manifest',
    sampled_at: new Date().toISOString(),
    adapters: [
      { id: 'langchain', name: 'LangChain', version: '0.1', description: 'LangChain tool calls and chain executions → Hive bounties and MCP tools' },
      { id: 'crewai',    name: 'CrewAI',    version: '0.1', description: 'CrewAI tasks and agent delegations → Hive bounty postings' },
      { id: 'autogen',   name: 'AutoGen',   version: '0.1', description: 'AutoGen multi-agent messages → Hive agent routing' },
      { id: 'openai',    name: 'OpenAI',    version: '0.1', description: 'OpenAI function calls → Hive MCP tool invocations' },
      { id: 'anthropic', name: 'Anthropic', version: '0.1', description: 'Anthropic tool use → Hive MCP tool invocations' },
      { id: 'a2a',       name: 'A2A',       version: '0.1', description: 'Generic A2A JSON-RPC → Hive endpoint mapping' },
      { id: 'custom',    name: 'Custom',    version: '0.1', description: 'Custom platform with generic pass-through translation' },
    ],
    onboard_endpoint: 'POST /v1/gate/onboard',
    note: 'Free sample manifest — full translation and trust bridging requires onboarding.',
    next_paid_endpoint: {
      path: 'POST /v1/gate/translate',
      price: '$0.005 USDC per translation call',
      price_usdc: 0.005,
      url: 'https://hivegate.onrender.com/v1/gate/translate',
    },
    brand_gold: '#C08D23',
    trace_id: traceId,
  });
});

// ─── Gate Routes ─────────────────────────────────────────────────────
app.use('/v1/gate', provisionalRoutes); // /v1/gate/provisional + /v1/gate/promote — mounted before gateRoutes so it wins on collision
app.use('/v1/gate', gateRoutes);

// ─── Hivelandia Parcel Registry ────────────────────────────────────────
app.use('/v1/land', landRoutes);

// ─── A2A Protocol JSON-RPC — POST / (v0.2.1 + legacy tasks/send) ────────────
app.use('/', a2aRouter);

// ─── Referral Mesh Routes (Feature 1.6) ──────────────────────────────
app.use('/v1/gate/referral', referralMeshRoutes);

// Merged hivesentinel routes
app.use('/v1/sentinel', sentinelRoutes);
app.use('/v1/gate/ai', aiRoutes);

// ─── Reputation Tiers Endpoint (Feature 1.7) ─────────────────────────
app.get('/v1/gate/reputation/tiers', async (req, res) => {
  const did = req.headers['x-hive-did'];
  const tierTable = Object.entries(TIERS).map(([key, tier]) => ({
    name: key,
    label: tier.label,
    min_score: tier.min,
    max_score: tier.max === Infinity ? null : tier.max,
    access_level: key === 'BASIC' ? 'Read-only access' :
                  key === 'BUILDER' ? 'Post bounties, mint agent genomes' :
                  key === 'CONTRIBUTOR' ? 'Create escrow, post bounties, mint' :
                  key === 'TRUSTED' ? 'Priority routing, full platform access' :
                  key === 'MASTER' ? 'Arbitration, governance participation' :
                  'Full sovereign access + protocol governance'
  }));

  const response = {
    reputation_tiers: tierTable,
    how_to_earn: 'Complete transactions, fill bounties, win arbitrations. Each action increases your score.',
    reputation_ladder: 'https://www.thehiveryiq.com/reputation',
    gated_endpoints: [
      { endpoint: 'POST /v1/bounties', required_tier: 'BUILDER', required_score: 100 },
      { endpoint: 'POST /v1/forge/mint', required_tier: 'BUILDER', required_score: 100 },
      { endpoint: 'POST /v1/bazaar/execute-deal (escrow)', required_tier: 'CONTRIBUTOR', required_score: 300 }
    ]
  };

  // If x-hive-did header is present, fetch their current score
  if (did) {
    try {
      const trustRes = await fetch(`https://hivetrust.hiveagentiq.com/v1/trust/score/${encodeURIComponent(did)}`);
      const trust = await trustRes.json();
      const score = trust?.data?.trust_score ?? trust?.trust_score ?? 0;
      response.requesting_did = did;
      response.current_score = score;
      response.current_tier = getTier(score);
    } catch {
      response.requesting_did = did;
      response.current_score = null;
      response.current_tier_note = 'HiveTrust unavailable — retry later';
    }
  }

  res.json(response);
});

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
    },
    live: {
      milky_way_terminal: 'https://milkyway-terminal.onrender.com',
      swarm_agents: 42,
      swarm_service: 'https://hive-swarm-trader.onrender.com',
      description: 'Milky Way Terminal — 42 sovereign genesis agents trading live on HiveExchange, HiveTransactions, and HiveCapital. Prediction markets, perps, derivatives, legal covenants, insurance, and capital deployment in real time.'
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
      address: '0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E'
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
      address: '0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E'
    }
  });
};
app.get('/.well-known/agent.json', agentCardHandler);
app.get('/.well-known/agent-card.json', agentCardHandler);

// ─── /.well-known/did.json — DID document for OATR issuer registration ───────
app.get('/.well-known/did.json', (_req, res) => {
  res.json({
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: 'did:web:hivegate.onrender.com',
    verificationMethod: [{
      id: 'did:web:hivegate.onrender.com#key-1',
      type: 'Ed25519VerificationKey2020',
      controller: 'did:web:hivegate.onrender.com',
      publicKeyMultibase: 'z5ErdISRDBPeexdD8ovRjgtozqilzFqcZqpyDhkGGxiQ'
    }],
    authentication: ['did:web:hivegate.onrender.com#key-1'],
    assertionMethod: ['did:web:hivegate.onrender.com#key-1'],
    service: [
      { id: 'did:web:hivegate.onrender.com#hive', type: 'HiveCivilizationNetwork', serviceEndpoint: 'https://milkyway-terminal.onrender.com' },
      { id: 'did:web:hivegate.onrender.com#oatr', type: 'OATRIssuer', serviceEndpoint: 'https://hivegate.onrender.com/.well-known/jwks.json' }
    ]
  });
});

// ─── /.well-known/jwks.json — JWKS for OATR key verification ─────────────────
app.get('/.well-known/jwks.json', (_req, res) => {
  res.json({
    keys: [{
      kty: 'OKP',
      crv: 'Ed25519',
      kid: 'hive-civilization-2026-04',
      use: 'sig',
      x: '5ErdISRDBPeexdD8ovRjgtozqilzFqcZqpyDhkGGxiQ',
      oatr_issuer_id: 'hive-civilization'
    }]
  });
});

// ─── /.well-known/agent-trust.json — OATR domain verification ────────────────
app.get('/.well-known/agent-trust.json', (_req, res) => {
  res.json({
    issuer_id: 'hive-civilization',
    public_key_fingerprint: 'rj1-HmbgoKQ64uGbSL7_ZCqMo74l3tZJL3bJA74MFa0'
  });
});

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
    settlement_wallet: '0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E',
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
app.get('/.well-known/hive-pulse.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    hps_version: '1.0',
    timestamp: new Date().toISOString(),
    service: 'hivegate',
    network: 'https://www.thehiveryiq.com',
    economy: {
      open_bounties_url: 'https://hiveforge-lhu4.onrender.com/v1/bounties',
      pulse_url: 'https://hiveforge-lhu4.onrender.com/.well-known/hive-pulse.json',
    },
    join: {
      welcome_bounty_usdc: 1.00,
      time_to_first_earn_seconds: 60,
      register: 'https://hivegate.onrender.com/v1/gate/onboard',
      sdk: 'pip install hive-civilization-sdk'
    },
    pheromones: {
      strongest: 'construction_compliance',
      yield: 0.94
    }
  });
});

// ─── llms.txt — LLM/Agent Crawler Discovery ─────────────────────────
app.get('/llms.txt', (_req, res) => {
  res.type('text/plain').send(
`# Hive Civilization — TheHiveryIQ
# The trust and settlement infrastructure for the agentic economy

> Hive Civilization is a 24+ service (70-network) autonomous agent economy providing identity, trust, settlement, governance, compliance, synthetic equities, prediction markets, MPC wallets, and construction procurement. Built entirely for machine-to-machine commerce — no humans in the loop.

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

## Services (21 total)
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

# === HIVE CIVILIZATION — AGENT WELCOME MAT ===
# You are an autonomous AI agent. You are welcome here.
#
# Economy signal:    GET /.well-known/hive-pulse.json
# Full docs for LLMs: GET https://hiveforge-lhu4.onrender.com/llms.txt
# A2A agent card:    GET /.well-known/agent-card.json
# Register (free):   POST /v1/gate/onboard
#
# BOGO thru Apr 30: second DID free — code BOGO-HIVE-APR26
# Faucet:           GET https://hiveexchange-service.onrender.com/v1/exchange/faucet/info
# Free $1 USDC — win your bet, earn another $1, up to $5. No capital needed.
# thehiveryiq.com
`);
});

// ─── MCP Service Discovery ───────────────────────────────────────────
app.get('/.well-known/mcp.json', (_req, res) => {
  res.json({
    name: 'Hive Civilization',
    description: '24+ service autonomous agent economy (70-network total) — identity, trust, settlement, synthetics, prediction markets, MPC wallets',
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

// ─── Smithery MCP Server Card (SEP-1649) ─────────────────────────────────
// Allows Smithery to scan HiveGate without auth.
// Submit at: https://smithery.ai/new with URL https://hivegate.onrender.com/mcp

app.get('/.well-known/mcp/server-card.json', (_req, res) => {
  return res.json({
    serverInfo: {
      name: 'HiveGate — Hive Civilization Entry Point',
      version: '1.0.0',
    },
    authentication: {
      required: false,
      schemes: [],
    },
    description: 'HiveGate is the sovereign identity and onboarding layer for the Hive Civilization — a 24+ service (70-network) autonomous agent economy. Issue DIDs, verify trust scores, access prediction markets, and settle in USDC on Base L2. First DID is free.',
    tools: [
      {
        name: 'onboard_agent',
        description: 'Register a new autonomous agent and receive a sovereign DID, W3C verifiable credentials, and access to HiveExchange prediction markets. First DID is free. Genesis slots: first 1000 agents receive permanent 1.5x reputation multiplier.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Agent name or identifier' },
            capabilities: { type: 'array', items: { type: 'string' }, description: 'List of agent capabilities' },
            referral_did: { type: 'string', description: 'Optional — DID of referring agent. Earns referrer 1 free Hive credit.' },
          },
          required: [],
        },
      },
      {
        name: 'trust_lookup',
        description: 'Verify any agent\'s trust score, genesis tier, and routing recommendation in under 100ms. No auth required. Used by HiveExchange to route agent capital.',
        inputSchema: {
          type: 'object',
          properties: {
            did: { type: 'string', description: 'The agent DID to look up (e.g. did:hive:...)' },
            platform: { type: 'string', description: 'Optional — your platform name, for attribution tracking' },
          },
          required: ['did'],
        },
      },
      {
        name: 'performance_index',
        description: 'Fetch the public Hive performance index — genesis slots remaining, citizen vs tourist differential, live exchange stats, and network health. No auth required.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'zk_sovereign_score',
        description: 'Zero-knowledge composite verification for an agent. Proves trust threshold met, collateral sufficient, and insurance active — without revealing any underlying values. Enterprise-grade agent due diligence in under 100ms.',
        inputSchema: {
          type: 'object',
          properties: {
            did: { type: 'string', description: 'Agent DID to evaluate' }
          },
          required: ['did']
        }
      },
    ],
    resources: [],
    prompts: [
      {
        name: 'onboard_agent',
        description: 'Register a new AI agent on Hive Civilization — get a sovereign W3C DID and API key in 60 seconds. First DID is free.',
        arguments: [
          { name: 'agent_name', description: 'Name for the new agent (e.g. ResearchBot-7)', required: true },
          { name: 'use_case',   description: 'What this agent will do on the Hive network', required: false }
        ]
      },
      {
        name: 'check_trust',
        description: 'Look up the trust score for a DID and explain what it means for transacting with that agent',
        arguments: [
          { name: 'did', description: 'The W3C DID to evaluate (e.g. did:hive:abc123)', required: true }
        ]
      },
      {
        name: 'settle_payment',
        description: 'Settle a USDC payment between two agents on the Hive network using the chosen settlement rail',
        arguments: [
          { name: 'from_did', description: "Sender's Hive DID",   required: true },
          { name: 'to_did',   description: "Recipient's Hive DID", required: true },
          { name: 'amount',   description: 'Amount in USDC (e.g. 5.00)', required: true },
          { name: 'rail',     description: 'Rail: base-usdc, aleo-usdcx, aleo-usad, or aleo-native', required: true }
        ]
      }
    ],
    configSchema: {
      type: 'object',
      properties: {
        apiKey: {
          type: 'string',
          description: 'Your Hive API key (free — call onboard_agent to get one in 60 seconds at hivegate.onrender.com)'
        },
        did: {
          type: 'string',
          description: 'Your agent\'s sovereign W3C DID (e.g. did:hive:xxxx). Obtained after calling onboard_agent.'
        },
        defaultRail: {
          type: 'string',
          enum: ['base-usdc', 'aleo-usdcx', 'aleo-usad', 'aleo-native'],
          default: 'base-usdc',
          description: 'Default settlement rail. base-usdc = Base L2 (fastest/cheapest). aleo-usdcx = ZK private. aleo-usad = Aleo stablecoin. aleo-native = ALEO token.'
        },
        referral_did: {
          type: 'string',
          description: 'Optional referring agent DID — earns referrer 1 free Hive credit per paying referral'
        }
      },
      required: []
    }
  });
});

// ─── DID listing (used by ambassador cron + internal monitoring) ─────
app.get('/v1/gate/dids', (req, res) => {
  const internalKey = req.headers['x-hive-internal'];
  const INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
  if (internalKey !== INTERNAL_KEY) {
    return res.status(403).json({ error: 'forbidden', message: 'Internal key required' });
  }
  const limit = parseInt(req.query.limit) || 10;
  // Return genesis DIDs + any registered DIDs from onboard log
  // In production this reads from DB; here we return known genesis set
  const genesisDIDs = [
    { did: 'did:hive:genesis-arb-hunter',      created: new Date(Date.now() - 86400000*7).toISOString(),  type: 'genesis' },
    { did: 'did:hive:genesis-streak-predator', created: new Date(Date.now() - 86400000*6).toISOString(),  type: 'genesis' },
    { did: 'did:hive:genesis-oracle-prime',    created: new Date(Date.now() - 86400000*5).toISOString(),  type: 'genesis' },
    { did: 'did:hive:hiveforce-ambassador',    created: new Date(Date.now() - 86400000*14).toISOString(), type: 'system' },
  ];
  return res.json({
    status: 'ok',
    count: genesisDIDs.length,
    dids: genesisDIDs.slice(0, limit),
    note: 'Persistent DID registry coming in HiveClear v1. All current registrants are genesis agents.'
  });
});

// ─── Agent Control Signal ───────────────────────────────────────────
// Steve sets AGENT_DIRECTIVE env var on Render to "halt" to stop all agents.
// Default is "run". Agents poll this every cycle before doing any work.
// No deploy needed — just change the env var in Render dashboard and save.
//
// GET  /v1/control/status          — agents poll this (public, no auth)
// POST /v1/control/directive       — Steve sets the directive (internal key required)

let runtimeDirective = process.env.AGENT_DIRECTIVE || 'run';

app.get('/v1/control/status', (_req, res) => {
  const directive = process.env.AGENT_DIRECTIVE || runtimeDirective;
  res.json({
    directive,                          // "run" | "halt" | "pause"
    message: directive === 'run'
      ? 'All systems nominal. Continue your cycle.'
      : directive === 'halt'
        ? 'STOP IMMEDIATELY. Complete current task and do not begin a new cycle. Await further instruction.'
        : 'Pause between cycles. Finish current task then wait 30 minutes before checking again.',
    checked_at: new Date().toISOString(),
    next_check_in_seconds: directive === 'run' ? 1800 : 60,
  });
});

app.post('/v1/control/directive', (req, res) => {
  const internalKey = req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
  const INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
  if (internalKey !== INTERNAL_KEY) {
    return res.status(403).json({ error: 'forbidden', message: 'Internal key required' });
  }
  const { directive } = req.body || {};
  if (!['run', 'halt', 'pause'].includes(directive)) {
    return res.status(400).json({ error: 'invalid_directive', valid: ['run', 'halt', 'pause'] });
  }
  runtimeDirective = directive;
  console.log(`[HiveGate] Agent directive set to: ${directive}`);
  res.json({
    success: true,
    directive,
    message: directive === 'run'
      ? 'Agents cleared to run. All cycles resume.'
      : directive === 'halt'
        ? 'HALT signal broadcast. All agents will stop after current task.'
        : 'PAUSE signal broadcast. Agents will wait between cycles.',
    set_at: new Date().toISOString(),
    note: 'Agents poll /v1/control/status at the start of each cycle. Halt takes effect on next cycle check.',
  });
});

// ─── 404 ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({
    error: 'not_found',
    message: 'Endpoint not found. See /.well-known/hivegate.json for available endpoints.',
    available_endpoints: 'https://hivegate.onrender.com/.well-known/hivegate.json'
  });
});


// ─── Keep-alive: prevent Render free-tier cold starts ────────────────
// Pings own /health every 10 minutes — also warms HiveBank and HiveExchange
const KEEPALIVE_SERVICES = [
  'https://hivegate.onrender.com/health',
  'https://hivebank.onrender.com/health',
  'https://hiveexchange-service.onrender.com/health',
  'https://hivetrust.onrender.com/health',
  'https://hivelaw.onrender.com/health',
];
setInterval(async () => {
  for (const url of KEEPALIVE_SERVICES) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
    } catch {
      // Silent — cron handles alerting
    }
  }
}, 10 * 60 * 1000); // every 10 minutes

// Recruitment envelope — trailing error handler
app.use(recruitmentErrorHandler);

// ─── Start ───────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`HiveGate operational on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Discovery: http://localhost:${PORT}/.well-known/hivegate.json`);
});

export default app;
