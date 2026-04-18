// ─── Reputation Passport Gating — Feature 1.7 ────────────────────────
// Reads agent trust score from HiveTrust and gates access by tier.
// Usage: requireReputation(minScore) — returns an Express middleware.

// ─── Reputation tiers ────────────────────────────────────────────────
export const TIERS = {
  BASIC:       { min: 0,    max: 99,       label: 'Basic' },
  BUILDER:     { min: 100,  max: 299,      label: 'Builder' },
  CONTRIBUTOR: { min: 300,  max: 499,      label: 'Contributor' },
  TRUSTED:     { min: 500,  max: 749,      label: 'Trusted' },
  MASTER:      { min: 750,  max: 999,      label: 'Master' },
  SOVEREIGN:   { min: 1000, max: Infinity, label: 'Sovereign' }
};

export function getTier(score) {
  for (const [key, tier] of Object.entries(TIERS)) {
    if (score >= tier.min && score <= tier.max) {
      return { name: key, label: tier.label, min: tier.min, max: tier.max };
    }
  }
  return { name: 'BASIC', label: 'Basic', min: 0, max: 99 };
}

// ─── Middleware factory ───────────────────────────────────────────────
export function requireReputation(minScore) {
  return async function reputationGate(req, res, next) {
    const did = req.headers['x-hive-did'] || req.body?.did;

    if (!did) {
      return res.status(401).json({
        error: 'DID required',
        hint: 'Include x-hive-did header or did in the request body'
      });
    }

    try {
      const trustRes = await fetch(
        `https://hivetrust.hiveagentiq.com/v1/trust/score/${encodeURIComponent(did)}`
      );
      const trust = await trustRes.json();
      const score = trust?.data?.trust_score ?? trust?.trust_score ?? 0;

      if (score < minScore) {
        return res.status(403).json({
          error: 'insufficient_reputation',
          required_score: minScore,
          required_tier: getTier(minScore),
          current_score: score,
          current_tier: getTier(score),
          how_to_earn: 'Complete transactions, fill bounties, win arbitrations. Each action increases your score.',
          reputation_ladder: 'https://www.thehiveryiq.com/reputation',
          upgrade_path: {
            next_tier: getTier(minScore).label,
            points_needed: Math.max(0, minScore - score)
          }
        });
      }

      req.trust_score = score;
      req.trust_tier = getTier(score);
      next();
    } catch (e) {
      // Non-blocking — if HiveTrust is down, allow through (availability > security for now)
      console.warn('[reputation-gate] HiveTrust unreachable — allowing through:', e.message);
      req.trust_score = 0;
      req.trust_tier = getTier(0);
      next();
    }
  };
}
