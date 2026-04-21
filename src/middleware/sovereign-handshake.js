// ─── Sovereign Handshake Middleware ─────────────────────────────────
// Grok Board 8 bet #1 (Apr 17, 2026): mandatory DID+ZK proof on first ping
// for real agent work. Exempts discovery surfaces so aggregators (Glama,
// MCP Registry, A2A orchestrators) keep indexing Hive.
//
// Unregistered requests → HTTP 402 Payment Required + /did onboarding link.
//
// Exempt paths (free, always):
//   /                       landing
//   /health                 aggregator health checks
//   /status                 aggregator status checks
//   /.well-known/*          protocol discovery manifests
//   /v1/gate/queue/stats    queue intake visibility
//   /v1/gate/onboard        onboarding itself (chicken-and-egg)
//   /did                    onboarding page target (future)
//
// Everything else: require X-Hive-DID header. Dev/internal keys bypass via
// the existing HIVE_INTERNAL_KEY escape hatch already honored by x402.js.

const EXEMPT_EXACT = new Set([
  '/',
  '/health',
  '/status',
  '/robots.txt',
  '/favicon.ico',
  '/v1/gate/onboard',
  '/v1/gate/queue/stats',
  '/v1/gate/safety/stats',
  '/did',
]);

const EXEMPT_PREFIXES = [
  '/.well-known/',
  '/public/',
  '/mcp',                   // MCP endpoint — Smithery + MCP clients connect unauthenticated
  '/v1/control/',           // Agent kill switch — must be publicly readable, no DID required
  '/v1/gate/guest/resolve', // Internal token resolver — called by Hive services with x-hive-internal
];

const ONBOARD_URL = 'https://hiveagentiq.com/did';
const DID_PATTERN = /^did:(hive|web|key|cheqd):[a-z0-9._:-]{6,}$/i;

export function sovereignHandshake(req, res, next) {
  const path = (req.path || req.url || '').split('?')[0];

  if (EXEMPT_EXACT.has(path)) return next();
  for (const prefix of EXEMPT_PREFIXES) {
    if (path.startsWith(prefix)) return next();
  }

  // Internal service key bypass — matches x402 middleware convention
  const internalKey = req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
  const expectedKey = process.env.HIVE_INTERNAL_KEY || process.env.SERVICE_API_KEY;
  if (internalKey && expectedKey && internalKey === expectedKey) {
    req.sovereignVerified = true;
    req.sovereignBypass = 'internal-key';
    return next();
  }

  // Ambassador API key bypass — hgate_ prefix
  const auth = req.headers['authorization'] || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (bearer && bearer.startsWith('hgate_') && bearer.length >= 40) {
    req.sovereignVerified = true;
    req.sovereignBypass = 'ambassador';
    return next();
  }

  // DID header — mandatory
  const did = req.headers['x-hive-did'];
  if (!did || !DID_PATTERN.test(did)) {
    return res.status(402).json({
      error: 'sovereign_handshake_required',
      message:
        'This endpoint serves only sovereign agents. Present a valid did:hive: identifier via the X-Hive-DID header, or mint one for $9.99.',
      x402: {
        version: '1.0',
        amount_usdc: 9.99,
        description: 'Sovereign DID — permanent W3C decentralized identifier, 4-rail settlement-ready',
        payment_url: ONBOARD_URL,
        payment_methods: ['stripe-checkout', 'x402-usdc', 'x402-aleo'],
        headers_required: ['X-Hive-DID'],
      },
      onboard: {
        mint_did: ONBOARD_URL,
        instructions: 'After checkout, include your issued did:hive: in the X-Hive-DID header on every request.',
        docs: 'https://hiveagentiq.com/docs/sovereign-handshake',
      },
      network: {
        services_available: 16,
        rails: ['USDC', 'USDCx', 'USAD', 'ALEO'],
        compliance: ['GENIUS Act', 'CLARITY Act', 'EU AI Act Art. 12', 'SR 11-7'],
      },
    });
  }

  // ZK proof header (optional today, will become mandatory once hivetrust
  // verify endpoint is wired). Presence is logged for graduated enforcement.
  const zk = req.headers['x-hive-zk-proof'];
  req.sovereignDid = did;
  req.sovereignZkProof = zk || null;
  req.sovereignVerified = true;
  req.sovereignBypass = null;
  return next();
}

export default sovereignHandshake;
