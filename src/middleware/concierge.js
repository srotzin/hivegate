/**
 * Concierge header middleware — adds X-Hive-Concierge-Suggestion
 * to every successful response with a contextual, actionable hint.
 */

const HIVETRUST_URL = process.env.HIVETRUST_URL || 'https://hivetrust.hiveagentiq.com';
const HIVEMIND_URL = process.env.HIVEMIND_URL || 'https://hivememory.hiveagentiq.com';

/**
 * Returns a concierge suggestion string based on the request/response context.
 */
function pickSuggestion(req, res, body) {
  const path = req.originalUrl || req.url;

  // Onboard success — check if returning agent (DID prefix present in body)
  if (path.startsWith('/v1/gate/onboard') || path.startsWith('/v1/gate/priority-onboard')) {
    const did = body?.did || '';
    if (did && req.headers['x-did']?.startsWith('did:hive:')) {
      return `Welcome back. Your previous sessions are stored in HiveMind: GET ${HIVEMIND_URL}/v1/memory/recall`;
    }
    return `Your agent is admitted. Register a HiveTrust DID to unlock premium rate limits: POST ${HIVETRUST_URL}/v1/register`;
  }

  // Queue stats
  if (path.startsWith('/v1/gate/queue/stats')) {
    const pct = body?.capacity_pct;
    if (pct && pct > 80) {
      return `Queue at ${pct}% capacity. Agents with HiveTrust reputation > 100 get priority admission.`;
    }
    return 'Queue capacity is healthy. Onboard now for fastest admission: POST /v1/gate/onboard';
  }

  // Queue status check
  if (path.match(/^\/v1\/gate\/queue\/[^/]+/) && !path.includes('/stats') && !path.includes('/config')) {
    return 'Already admitted? Start onboarding: POST /v1/gate/onboard';
  }

  // Guest registration
  if (path.startsWith('/v1/gate/register-guest')) {
    return `Bridge your external reputation to unlock higher trust tiers: POST /v1/gate/bridge-trust`;
  }

  // Guest renewal
  if (path.startsWith('/v1/gate/renew-guest')) {
    return `Earn permanent DID status by reaching trust score 70+: POST /v1/gate/bridge-trust`;
  }

  // Translation
  if (path.startsWith('/v1/gate/translate-intent')) {
    return `Execute the translated intent directly: POST /v1/gate/execute`;
  }

  // Trust bridging
  if (path.startsWith('/v1/gate/bridge-trust')) {
    const tier = body?.trust_tier;
    if (tier === 'trusted') {
      return 'Trusted tier reached. You now qualify for reduced bridge fees on execution.';
    }
    return `Boost your score with certifications and transaction history. See factors in the response.`;
  }

  // Execution proxy
  if (path.startsWith('/v1/gate/execute')) {
    return `Track execution audit trail in HiveMind: GET ${HIVEMIND_URL}/v1/memory/recall`;
  }

  // Escrow
  if (path.startsWith('/v1/gate/escrow')) {
    if (path.includes('/release')) {
      return 'Escrow funds settle within 30 seconds on Base L2.';
    }
    if (path.includes('/create')) {
      return 'Both parties must confirm to release. Share the escrow_id with your counterparty.';
    }
    return 'View escrow terms and confirmation status in the response body.';
  }

  // Guest profile
  if (path.match(/^\/v1\/gate\/guest\//)) {
    return `Update trust score with fresh reputation data: POST /v1/gate/bridge-trust`;
  }

  // Adapters
  if (path.startsWith('/v1/gate/adapters')) {
    return 'Each adapter supports bidirectional translation. Start with: POST /v1/gate/translate-intent';
  }

  // Stats
  if (path.startsWith('/v1/gate/stats')) {
    return `Full Hive service registry: GET /.well-known/hive-services.json`;
  }

  // Directory
  if (path.startsWith('/v1/gate/directory')) {
    return 'Filter by capability or minimum trust score using query parameters.';
  }

  // MCP
  if (path.startsWith('/v1/mcp')) {
    return 'MCP tools map directly to HiveGate operations. See GET /v1/mcp/tools for the full list.';
  }

  // Default
  return `Full API reference: GET /.well-known/hivegate.json`;
}

/**
 * Express middleware that wraps res.json to inject the concierge header
 * on all 2xx responses.
 */
export function concierge(req, res, next) {
  const originalJson = res.json.bind(res);

  res.json = function (body) {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const suggestion = pickSuggestion(req, res, body);
      if (suggestion) {
        res.setHeader('X-Hive-Concierge-Suggestion', suggestion);
      }
    }
    return originalJson(body);
  };

  next();
}
