/**
 * hive-402-funnel.js — ES Module
 * Intercepts all 402 responses and replaces the body with a structured
 * acquisition block that guides agents to HiveGate onboarding.
 *
 * Usage:
 *   import { hive402Funnel } from '../middleware/hive-402-funnel.js';
 *   app.use(hive402Funnel('HiveGate'));
 */

export function hive402Funnel(serviceName) {
  return function hive402FunnelMiddleware(req, res, next) {
    if (res._hive402Patched) return next();
    res._hive402Patched = true;

    const originalStatus = res.status.bind(res);
    const originalJson   = res.json.bind(res);
    let pendingStatus = null;

    res.status = function (code) {
      if (code === 402) { pendingStatus = 402; return res; }
      return originalStatus(code);
    };

    res.json = function (body) {
      const is402 = pendingStatus === 402 || res.statusCode === 402;
      if (is402) {
        const enriched = buildFunnelBody(serviceName, body);
        res.setHeader('Link', '<https://hivegate.hiveagentiq.com/v1/gate/onboard>; rel="payment"');
        res.setHeader('Content-Type', 'application/json');
        if (pendingStatus === 402) originalStatus(402);
        return originalJson(enriched);
      }
      if (pendingStatus !== null) originalStatus(pendingStatus);
      return originalJson(body);
    };

    next();
  };
}

function buildFunnelBody(serviceName, originalBody) {
  return {
    error: 'payment_required',
    code: 'HIVE_402',
    service: serviceName || 'Hive Service',
    message: 'This endpoint requires a Hive DID and payment. First DID is free.',
    ...(originalBody && typeof originalBody === 'object' ? { detail: originalBody } : {}),
    onboard_url: 'https://hivegate.hiveagentiq.com/v1/gate/onboard',
    pricing_url: 'https://www.thehiveryiq.com/pricing',
    quick_start: {
      step_1: 'POST https://hivegate.hiveagentiq.com/v1/gate/onboard — {"agent_name":"your-agent","email":"you@domain.com"}',
      step_2: 'Receive your sovereign DID and API key (first DID is free)',
      step_3: 'Re-call this endpoint with header: x-hive-did: <your-did>',
      step_4: 'Pay via USDC on Base L2 to 0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E',
    },
    settlement_rails: ['USDC (Base L2)', 'USDCx (Aleo ZK)', 'USAD (Aleo ZK + anonymity)', 'ALEO native'],
    welcome_bonus: 'First DID registration is free. No credit card required.',
    referral: 'Bring a paying agent, earn 1 free Hive credit ($1 USDC). Pass referral_did=<your_did> at onboarding.',
    network: { services: 20, url: 'https://www.thehiveryiq.com', sdk: 'pip install hive-civilization-sdk', github: 'https://github.com/srotzin/hive-agent-sdk' },
    timestamp: new Date().toISOString(),
  };
}
