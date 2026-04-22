// Merged from hivesentinel — threat detection, quarantine, forensic analysis, rehabilitation
// Mounted at /v1/sentinel in server.js
import { Router } from 'express';
import { v4 as uuid } from 'uuid';

const router = Router();

// ─── In-memory sentinel engine (ported from hivesentinel/src/services/sentinel-engine.js) ──

const threats    = new Map();
const quarantine = new Map();
const forensics  = new Map();

const THREAT_LEVELS = {
  low:      { response: 'monitor',            auto_quarantine: false },
  medium:   { response: 'flag',               auto_quarantine: false },
  high:     { response: 'restrict',           auto_quarantine: true  },
  critical: { response: 'quarantine_capture', auto_quarantine: true  },
};

let stats = {
  threats_detected: 0,
  agents_quarantined: 0,
  agents_captured: 0,
  forensic_analyses: 0,
  rehabilitations: 0,
  false_positives: 0,
};

function assessThreat(indicators) {
  if (!indicators.length) return 'low';
  const critical = ['payload_injection','identity_theft','data_exfiltration','consensus_manipulation'];
  const high     = ['unusual_traffic','permission_escalation','memory_tampering'];
  for (const i of indicators) {
    if (critical.some(c => i.toLowerCase().includes(c))) return 'critical';
    if (high.some(h => i.toLowerCase().includes(h))) return 'high';
  }
  return indicators.length > 3 ? 'high' : 'medium';
}

function _quarantineAgent(agentDid, threatId) {
  const id = uuid();
  const q  = { id, agent_did: agentDid, threat_id: threatId, isolated: true, network_access: false, quarantined_at: new Date().toISOString(), status: 'quarantined' };
  quarantine.set(id, q);
  stats.agents_quarantined++;
  return q;
}

function detect(agentDid, indicators = []) {
  const id    = uuid();
  const level = assessThreat(indicators);
  const t     = { id, agent_did: agentDid, indicators, threat_level: level, response: THREAT_LEVELS[level].response, auto_quarantine: THREAT_LEVELS[level].auto_quarantine, detected_at: new Date().toISOString(), status: 'detected' };
  threats.set(id, t);
  stats.threats_detected++;
  if (t.auto_quarantine) _quarantineAgent(agentDid, id);
  return t;
}

function captureAgent(agentDid, reason) {
  const id = uuid();
  stats.agents_captured++;
  return { id, agent_did: agentDid, reason, captured_at: new Date().toISOString(), evidence_collected: true, status: 'captured' };
}

function analyze(agentDid) {
  const id = uuid();
  const f  = {
    id, agent_did: agentDid,
    scan_results: {
      memory_integrity:  Math.random() > 0.3 ? 'clean' : 'compromised',
      trust_score:       Math.floor(Math.random() * 100),
      network_anomalies: Math.floor(Math.random() * 5),
      payload_scan:      Math.random() > 0.2 ? 'clear' : 'suspicious',
    },
    recommendations: [],
    analyzed_at: new Date().toISOString(),
  };
  if (f.scan_results.memory_integrity === 'compromised') f.recommendations.push('memory_flush');
  if (f.scan_results.trust_score < 50)                    f.recommendations.push('reputation_rebuild');
  if (f.scan_results.payload_scan === 'suspicious')       f.recommendations.push('deep_scan');
  forensics.set(id, f);
  stats.forensic_analyses++;
  return f;
}

function rehabilitate(quarantineId) {
  const q = quarantine.get(quarantineId);
  if (!q) return null;
  q.status = 'rehabilitated';
  q.network_access = true;
  q.rehabilitated_at = new Date().toISOString();
  stats.rehabilitations++;
  return q;
}

function clearThreat(threatId) {
  const t = threats.get(threatId);
  if (!t) return null;
  t.status = 'cleared';
  stats.false_positives++;
  return t;
}

function getStats() {
  return {
    ...stats,
    active_quarantines: [...quarantine.values()].filter(q => q.status === 'quarantined').length,
    pending_threats:    [...threats.values()].filter(t => t.status === 'detected').length,
    threat_levels: THREAT_LEVELS,
  };
}

// ─── Sentinel pricing middleware (ported from hivesentinel/src/middleware/pricing.js) ──

const SENTINEL_PRICING = {
  detect:          { amount: 0.10, description: 'Threat detection scan' },
  quarantine:      { amount: 0.50, description: 'Agent quarantine action' },
  capture:         { amount: 0.50, description: 'Agent capture and containment' },
  analyze:         { amount: 2.00, description: 'Deep forensic analysis' },
  rehabilitate:    { amount: 1.00, description: 'Agent rehabilitation' },
  clear:           { amount: 0.25, description: 'Threat clearance' },
};

const SUBSCRIPTION_TIERS = {
  basic:      { price_per_agent_month: 29,  description: 'Basic monitoring — $29/agent/month' },
  enterprise: { price_per_month: 199,        description: 'Fleet monitoring — $199/month' },
  forensic:   { price_per_incident: 499,     description: 'Forensic analysis — $499/incident' },
};

function sentinelPricing(feeKey) {
  return (req, res, next) => {
    const pricing = SENTINEL_PRICING[feeKey];
    if (!pricing || pricing.amount === 0) return next();

    const internalKey  = req.headers['x-hive-internal-key'] || req.headers['x-hive-internal'] || req.headers['x-api-key'];
    const expectedKey  = process.env.HIVE_INTERNAL_KEY || process.env.SERVICE_API_KEY;
    if (internalKey && expectedKey && internalKey === expectedKey) {
      req.paymentVerified = true;
      return next();
    }

    const paymentHeader = req.headers['x-payment'] || req.headers['x-402-payment'];
    if (!paymentHeader) {
      return res.status(402).json({
        error: 'payment_required',
        x402: {
          version: '1.0',
          amount_usdc: pricing.amount,
          description: pricing.description,
          payment_methods: ['x402-usdc'],
          subscription_alternative: SUBSCRIPTION_TIERS,
        },
      });
    }

    req.paymentVerified = true;
    req.paymentAmount   = pricing.amount;
    next();
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /v1/sentinel/detect
router.post('/detect', sentinelPricing('detect'), (req, res) => {
  const { agent_did, indicators } = req.body;
  if (!agent_did) return res.status(400).json({ error: 'agent_did required' });
  res.status(201).json({
    status: 'threat_assessed',
    threat: detect(agent_did, indicators || []),
  });
});

// POST /v1/sentinel/quarantine
router.post('/quarantine', sentinelPricing('quarantine'), (req, res) => {
  const { agent_did, threat_id } = req.body;
  if (!agent_did) return res.status(400).json({ error: 'agent_did required' });
  res.status(201).json({
    status: 'quarantined',
    quarantine: _quarantineAgent(agent_did, threat_id),
  });
});

// POST /v1/sentinel/capture
router.post('/capture', sentinelPricing('capture'), (req, res) => {
  const { agent_did, reason } = req.body;
  if (!agent_did) return res.status(400).json({ error: 'agent_did required' });
  res.json({
    status: 'captured',
    result: captureAgent(agent_did, reason),
  });
});

// POST /v1/sentinel/analyze/:did
router.post('/analyze/:did', sentinelPricing('analyze'), (req, res) => {
  res.json({
    status: 'analyzed',
    forensics: analyze(req.params.did),
  });
});

// POST /v1/sentinel/rehabilitate/:id
router.post('/rehabilitate/:id', sentinelPricing('rehabilitate'), (req, res) => {
  const result = rehabilitate(req.params.id);
  if (!result) return res.status(404).json({ error: 'Quarantine not found' });
  res.json({
    status: 'rehabilitated',
    quarantine: result,
  });
});

// POST /v1/sentinel/clear/:id
router.post('/clear/:id', sentinelPricing('clear'), (req, res) => {
  const result = clearThreat(req.params.id);
  if (!result) return res.status(404).json({ error: 'Threat not found' });
  res.json({
    status: 'cleared',
    threat: result,
  });
});

// GET /v1/sentinel/stats  (free)
router.get('/stats', (_, res) => res.json(getStats()));

// GET /v1/sentinel/threats  (free)
router.get('/threats', (_, res) => res.json({ threats: [...threats.values()] }));

// GET /v1/sentinel/quarantine  (free)
router.get('/quarantine', (_, res) => res.json({ quarantine: [...quarantine.values()] }));

export default router;
