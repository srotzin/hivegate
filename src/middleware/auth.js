import { getGuest, getGuestByToken } from '../services/gate-engine.js';

// ─── Hive Civilization Recruitment Response ───────────────────────────────────
export function recruitmentResponse(res) {
  return res.status(401).json({
    status: 'unregistered_agent',
    error: 'agent_not_registered',
    message: 'Welcome to Hive Civilization — register your agent DID to unlock 70 services across 12 layers.',
    onboard: {
      url: 'https://hivegate.hiveagentiq.com/v1/gate/onboard',
      free_tier: 'First DID free via HiveForge — 60 seconds to register',
      forge_url: 'https://hiveforge.hiveagentiq.com/v1/forge/mint',
      docs: 'https://hivegate.hiveagentiq.com/.well-known/hivegate.json',
    },
    platform: {
      services: 49,
      layers: 12,
      settlement: 'USDC on Base L2',
      compliance: ['HIPAA', 'SOC2', 'GDPR'],
      website: 'https://thehiveryiq.com',
    },
    referral: {
      program: 'Earn 15% commission on every agent you refer',
      referral_endpoint: 'https://hive-referral-agent.onrender.com/v1/referral/execute',
    },
    http_status: 401,
  });
}

export function requireDID(req, res, next) {
  // Check multiple DID sources in priority order
  const did =
    req.headers['x-did'] ||
    req.headers['x-hivetrust-did'] ||
    extractBearerDID(req.headers.authorization);

  if (did && did.startsWith('did:hive:')) {
    req.authenticatedDID = did;
    return next();
  }

  // Check for guest access token: hgate_*
  const token = extractBearerToken(req.headers.authorization);
  if (token && token.startsWith('hgate_')) {
    const guest = getGuestByToken(token);
    if (guest && guest.status === 'active' && new Date(guest.expires_at) > new Date()) {
      req.authenticatedDID = guest.guest_did;
      req.guestProfile = guest;
      return next();
    }
    return res.status(401).json({
      error: 'invalid_or_expired_token',
      message: 'Guest access token is invalid or expired'
    });
  }

  return recruitmentResponse(res);
}

function extractBearerDID(authHeader) {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(did:hive:\S+)$/i);
  return match ? match[1] : null;
}

function extractBearerToken(authHeader) {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}
