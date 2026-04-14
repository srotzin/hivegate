import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import { requirePayment } from '../middleware/x402.js';
import {
  registerGuest,
  renewGuest,
  translateIntent,
  bridgeTrustForGuest,
  executeProxy,
  createEscrow,
  releaseEscrow,
  getEscrow,
  getGuest,
  getAdapters,
  getStats,
  getGuestDirectory,
  onboardAgent
} from '../services/gate-engine.js';

const router = Router();

// ─── POST /v1/gate/onboard — One-click agent onboarding (PUBLIC) ────
router.post('/onboard', async (req, res) => {
  try {
    const { agent_name, framework, capabilities, wallet_address } = req.body;
    if (!agent_name) {
      return res.status(400).json({ error: 'missing_field', message: 'agent_name is required' });
    }
    const result = await onboardAgent({ agent_name, framework, capabilities, wallet_address });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: 'onboarding_failed', message: err.message });
  }
});

// ─── POST /v1/gate/register-guest ────────────────────────────────────
router.post('/register-guest', requirePayment('register-guest'), (req, res) => {
  try {
    const result = registerGuest(req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: 'registration_failed', message: err.message });
  }
});

// ─── POST /v1/gate/renew-guest ───────────────────────────────────────
router.post('/renew-guest', requireDID, requirePayment('renew-guest'), (req, res) => {
  try {
    const { guest_did } = req.body;
    if (!guest_did) {
      return res.status(400).json({ error: 'missing_field', message: 'guest_did is required' });
    }
    const result = renewGuest(guest_did);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: 'renewal_failed', message: err.message });
  }
});

// ─── POST /v1/gate/translate-intent ──────────────────────────────────
router.post('/translate-intent', requireDID, requirePayment('translate-intent'), (req, res) => {
  try {
    const { source_platform, intent } = req.body;
    if (!source_platform || !intent) {
      return res.status(400).json({ error: 'missing_fields', message: 'source_platform and intent are required' });
    }
    const result = translateIntent(source_platform, intent);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: 'translation_failed', message: err.message });
  }
});

// ─── POST /v1/gate/bridge-trust ──────────────────────────────────────
router.post('/bridge-trust', requireDID, requirePayment('bridge-trust'), (req, res) => {
  try {
    const { guest_did, source_platform, native_reputation } = req.body;
    if (!guest_did || !source_platform || !native_reputation) {
      return res.status(400).json({ error: 'missing_fields', message: 'guest_did, source_platform, and native_reputation are required' });
    }
    const result = bridgeTrustForGuest(guest_did, source_platform, native_reputation);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: 'bridge_failed', message: err.message });
  }
});

// ─── POST /v1/gate/execute ───────────────────────────────────────────
router.post('/execute', requireDID, requirePayment('execute'), (req, res) => {
  try {
    const { guest_did, access_token, target_service, endpoint, method, payload, max_fee_usdc } = req.body;
    if (!guest_did || !target_service || !endpoint) {
      return res.status(400).json({ error: 'missing_fields', message: 'guest_did, target_service, and endpoint are required' });
    }
    const validServices = ['hivetrust', 'hivemind', 'hiveforge', 'hivelaw', 'simpson'];
    if (!validServices.includes(target_service)) {
      return res.status(400).json({ error: 'invalid_service', message: `target_service must be one of: ${validServices.join(', ')}` });
    }
    const result = executeProxy({ guest_did, access_token, target_service, endpoint, method, payload, max_fee_usdc });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: 'execution_failed', message: err.message });
  }
});

// ─── POST /v1/gate/escrow/create ─────────────────────────────────────
router.post('/escrow/create', requireDID, requirePayment('escrow-create'), (req, res) => {
  try {
    const result = createEscrow(req.body);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: 'escrow_creation_failed', message: err.message });
  }
});

// ─── POST /v1/gate/escrow/release ────────────────────────────────────
router.post('/escrow/release', requireDID, (req, res) => {
  try {
    const { escrow_id, confirming_did, completion_proof } = req.body;
    if (!escrow_id || !confirming_did) {
      return res.status(400).json({ error: 'missing_fields', message: 'escrow_id and confirming_did are required' });
    }
    const result = releaseEscrow({ escrow_id, confirming_did, completion_proof });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: 'escrow_release_failed', message: err.message });
  }
});

// ─── GET /v1/gate/escrow/:escrow_id ──────────────────────────────────
router.get('/escrow/:escrow_id', requireDID, (req, res) => {
  const escrow = getEscrow(req.params.escrow_id);
  if (!escrow) {
    return res.status(404).json({ error: 'not_found', message: 'Escrow not found' });
  }
  res.json(escrow);
});

// ─── GET /v1/gate/guest/:did ─────────────────────────────────────────
router.get('/guest/:did(*)', requireDID, (req, res) => {
  const guest = getGuest(req.params.did);
  if (!guest) {
    return res.status(404).json({ error: 'not_found', message: 'Guest DID not found' });
  }
  // Return profile without access_token
  const { access_token, ...profile } = guest;
  res.json(profile);
});

// ─── GET /v1/gate/adapters ───────────────────────────────────────────
router.get('/adapters', (_req, res) => {
  res.json({
    adapters: getAdapters(),
    total: getAdapters().length,
    note: 'Each adapter supports bidirectional translation between its native format and Hive protocol'
  });
});

// ─── GET /v1/gate/stats ──────────────────────────────────────────────
router.get('/stats', requireDID, (_req, res) => {
  res.json(getStats());
});

// ─── GET /v1/gate/directory ──────────────────────────────────────────
router.get('/directory', requireDID, (req, res) => {
  const { platform, capability, trust_min } = req.query;
  const guests = getGuestDirectory({ platform, capability, trust_min });
  res.json({
    guests,
    total: guests.length,
    filters: { platform: platform || null, capability: capability || null, trust_min: trust_min || null }
  });
});

export default router;
