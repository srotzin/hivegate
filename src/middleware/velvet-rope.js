/**
 * Velvet Rope — reputation-based tiered service quality.
 * Reads X-Hive-Reputation header and injects tier info into req
 * for downstream handlers to use.
 */

const TIERS = {
  public:   { name: 'public',   min: 0,   queueSkip: 0,    rateMultiplier: 1,  benefits: ['standard_queue', 'standard_rate_limit'] },
  silver:   { name: 'silver',   min: 50,  queueSkip: 0.5,  rateMultiplier: 2,  benefits: ['priority_queue_top_50pct', '2x_rate_limit'] },
  gold:     { name: 'gold',     min: 200, queueSkip: 0.75, rateMultiplier: 5,  benefits: ['priority_queue_top_25pct', '5x_rate_limit'] },
  platinum: { name: 'platinum', min: 500, queueSkip: 1,    rateMultiplier: -1, benefits: ['instant_admission', 'no_queue', 'unlimited_rate_limit'] }
};

/**
 * Resolve reputation score to a tier.
 */
function resolveTier(score) {
  if (score >= 500) return TIERS.platinum;
  if (score >= 200) return TIERS.gold;
  if (score >= 50)  return TIERS.silver;
  return TIERS.public;
}

/**
 * Middleware that reads X-Hive-Reputation and attaches tier data to req and
 * injects tier fields into the response body for onboard endpoints.
 */
export function velvetRope(req, res, next) {
  const rawReputation = req.headers['x-hive-reputation'];
  const reputation = rawReputation !== undefined ? parseInt(rawReputation, 10) : 0;
  const score = Number.isFinite(reputation) ? Math.max(reputation, 0) : 0;

  const tier = resolveTier(score);
  req.hiveTier = tier;
  req.hiveReputation = score;

  // Wrap res.json to inject tier info on successful onboard responses
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    const path = req.originalUrl || req.url;
    const isOnboard = path.startsWith('/v1/gate/onboard') || path.startsWith('/v1/gate/priority-onboard');

    if (isOnboard && res.statusCode >= 200 && res.statusCode < 300 && body && typeof body === 'object') {
      body.tier = tier.name;
      body.tier_benefits = tier.benefits;
      if (tier.name === 'platinum') {
        body.queue_bypassed = true;
      }
    }

    return originalJson(body);
  };

  next();
}

export { TIERS, resolveTier };
