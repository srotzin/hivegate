import { getGuest, getGuestByToken } from '../services/gate-engine.js';

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

  return res.status(401).json({
    error: 'authentication_required',
    message: 'Provide a DID via x-did, X-HiveTrust-DID, Authorization: Bearer did:hive:*, or a guest access token (hgate_*)',
    supported_headers: ['x-did', 'X-HiveTrust-DID', 'Authorization: Bearer did:hive:*', 'Authorization: Bearer hgate_*']
  });
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
