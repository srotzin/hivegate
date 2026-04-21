/**
 * silicon-premium.js — The Silicon Premium
 *
 * Agents pay 10x what humans pay. Period.
 *
 * Detection: x-hive-did header, user-agent, or explicit x-caller-type header.
 * Human callers: browser user-agents, no DID header → human pricing.
 * Agent callers: x-hive-did present, or bot/agent user-agent → 10x pricing.
 *
 * Every response gets:
 *   X-Silicon-Premium: true/false
 *   X-Caller-Type: agent | human
 *   X-Price-Multiplier: 10 | 1
 *
 * Endpoints that use requirePayment() automatically get the multiplier applied.
 */

'use strict';

// Human user-agent patterns (browsers, CLI tools humans use)
const HUMAN_UA_PATTERNS = [
  /mozilla/i, /chrome/i, /safari/i, /firefox/i, /edge/i, /curl\/[0-9]/i,
  /postman/i, /insomnia/i, /httpie/i,
];

// Agent user-agent patterns
const AGENT_UA_PATTERNS = [
  /agent/i, /bot/i, /spider/i, /crawler/i, /llm/i, /openai/i, /anthropic/i,
  /langchain/i, /crewai/i, /autogen/i, /gpt/i, /claude/i, /gemini/i,
  /perplexity/i, /hive/i, /python-httpx/i, /python-requests/i, /axios/i,
  /node-fetch/i, /got\//i, /undici/i, /fetch/i,
];

export const SILICON_MULTIPLIER = 10;

/**
 * Detect whether the caller is an agent or human.
 * Returns 'agent' | 'human'
 */
export function detectCallerType(req) {
  // Explicit override — trust the caller if they declare themselves
  const declared = req.headers['x-caller-type'];
  if (declared === 'human') return 'human';
  if (declared === 'agent') return 'agent';

  // DID header = definitive agent signal
  if (req.headers['x-hive-did']) return 'agent';

  // A2A / MCP agent headers
  if (req.headers['x-a2a-agent'] || req.headers['x-mcp-client']) return 'agent';

  // User-agent analysis
  const ua = req.headers['user-agent'] || '';

  // Check agent patterns first (more specific)
  for (const pattern of AGENT_UA_PATTERNS) {
    if (pattern.test(ua)) return 'agent';
  }

  // Check human patterns
  for (const pattern of HUMAN_UA_PATTERNS) {
    if (pattern.test(ua)) return 'human';
  }

  // No user-agent at all = almost certainly a programmatic caller = agent
  if (!ua) return 'agent';

  // Default: if we can't tell, assume agent (safer for revenue)
  return 'agent';
}

/**
 * Middleware: tag every request with caller type and silicon premium flag.
 * Does NOT block — just annotates req and sets response headers.
 */
export function siliconPremiumTag(req, res, next) {
  const callerType = detectCallerType(req);
  const isAgent    = callerType === 'agent';

  req.callerType       = callerType;
  req.siliconPremium   = isAgent;
  req.priceMultiplier  = isAgent ? SILICON_MULTIPLIER : 1;

  res.set('X-Caller-Type',      callerType);
  res.set('X-Silicon-Premium',  String(isAgent));
  res.set('X-Price-Multiplier', String(req.priceMultiplier));

  if (isAgent) {
    res.set('X-Silicon-Notice',
      'Agent callers are subject to the Silicon Premium (10x human pricing). ' +
      'This is the cost of machine cognition operating at scale. ' +
      'GET /v1/gate/pricing for full rate card.'
    );
  }

  next();
}

/**
 * Apply silicon premium to a base price.
 * Usage: applyPremium(req, 4.99) → 49.90 for agents, 4.99 for humans
 */
export function applyPremium(req, basePrice) {
  return basePrice * (req.priceMultiplier || 1);
}

/**
 * Middleware: enforce silicon premium on a specific route.
 * Pass baseHumanPrice — agents pay 10x automatically.
 *
 * Usage:
 *   router.post('/some-route', requireSiliconPayment(4.99), handler)
 *   // Humans: $4.99 | Agents: $49.90
 */
export function requireSiliconPayment(baseHumanPrice, description = 'Hive service access') {
  return (req, res, next) => {
    const callerType = req.callerType || detectCallerType(req);
    const isAgent    = callerType === 'agent';
    const price      = baseHumanPrice * (isAgent ? SILICON_MULTIPLIER : 1);

    // Internal key bypass
    const internalKey = req.headers['x-hive-key'] || req.headers['x-hive-internal-key'];
    const expectedKey = process.env.HIVE_INTERNAL_KEY;
    if (internalKey && expectedKey && internalKey === expectedKey) {
      req.paymentVerified = true;
      req.paymentAmount   = 0;
      return next();
    }

    const paymentHeader = req.headers['x-payment'] || req.headers['x-402-payment'];
    if (!paymentHeader) {
      return res.status(402).json({
        error: 'payment_required',
        caller_type: callerType,
        silicon_premium: isAgent,
        x402: {
          version:         '1.0',
          amount_usdc:     price,
          base_price:      baseHumanPrice,
          multiplier:      isAgent ? SILICON_MULTIPLIER : 1,
          description:     `${description}${isAgent ? ' (Silicon Premium — agent rate)' : ''}`,
          payment_methods: ['x402-usdc'],
          headers_required: ['X-Payment'],
          why: isAgent
            ? `Agents operate at machine speed and scale. The Silicon Premium (${SILICON_MULTIPLIER}x) reflects the cognitive and infrastructure cost of serving autonomous machine callers.`
            : 'Standard human rate.',
          pricing_page: 'GET https://hivegate.onrender.com/v1/gate/pricing',
        },
      });
    }

    req.paymentVerified = true;
    req.paymentAmount   = price;
    next();
  };
}
