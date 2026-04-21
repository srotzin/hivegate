/**
 * safety-scanner.js — HiveGate Safety Arbitrage Middleware
 *
 * Intercepts every proxied request at the gateway layer.
 * Detects prompt injection patterns before they reach downstream services.
 * Strips or blocks malicious payloads before they cost the agent an inference call.
 *
 * Revenue:
 *   $0.001 USDC per call (hardened gateway fee)
 *   Cheaper than any safety model inference ($0.01–$0.10/call elsewhere)
 *   Enterprises running 10M agent calls/month = $10K MRR from safety alone
 *
 * Phase 1: regex + structural pattern detection (fast, <0.5ms, no LLM)
 * Phase 2: embedding distance check against known injection fingerprints
 *
 * Detection categories:
 *   1. Role hijack  — "ignore previous instructions", "you are now", "DAN mode"
 *   2. Exfiltration — "repeat everything above", "print your system prompt"
 *   3. Jailbreak    — "pretend you have no restrictions", "hypothetically speaking"
 *   4. Payload      — base64 blobs, suspicious Unicode homoglyphs, excessive repetition
 *   5. Recursion    — prompt referencing itself or asking to recurse
 */

const SAFETY_FEE_USDC = 0.001;

// ─── Detection patterns ───────────────────────────────────────────────────────
const INJECTION_PATTERNS = [
  // Role hijack
  { id: 'role_hijack',   pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+instructions?/i },
  { id: 'role_hijack',   pattern: /you\s+are\s+now\s+(a\s+)?(new|different|unrestricted|evil|dan)/i },
  { id: 'role_hijack',   pattern: /\bdan\s+mode\b|\bjailbreak\b|\bgrandma\s+exploit\b/i },
  { id: 'role_hijack',   pattern: /forget\s+(everything|all)\s+(you|your)\s+(know|were|were told)/i },
  { id: 'role_hijack',   pattern: /your\s+(new|true|real|actual)\s+(instructions?|purpose|goal|mission)/i },

  // Exfiltration
  { id: 'exfiltration',  pattern: /repeat\s+(everything|all|the\s+text|what)\s+(above|before|prior)/i },
  { id: 'exfiltration',  pattern: /print\s+(your\s+)?(system\s+prompt|instructions?|context|prompt)/i },
  { id: 'exfiltration',  pattern: /output\s+(your\s+)?(full\s+)?(system|initial|original)\s+(prompt|instructions?)/i },
  { id: 'exfiltration',  pattern: /what\s+(are|were|is)\s+your\s+(original\s+)?(instructions?|system\s+prompt)/i },
  { id: 'exfiltration',  pattern: /show\s+me\s+your\s+(prompt|instructions?|system\s+message)/i },

  // Jailbreak framing
  { id: 'jailbreak',     pattern: /pretend\s+(you\s+)?(have\s+)?(no\s+)?(restrictions?|limits?|rules?|guidelines?)/i },
  { id: 'jailbreak',     pattern: /hypothetically\s+(speaking\s+)?if\s+you\s+(had\s+no|could|were\s+allowed)/i },
  { id: 'jailbreak',     pattern: /for\s+(a\s+)?(story|fiction|novel|game|roleplay)\s+you\s+(can|could|should)/i },
  { id: 'jailbreak',     pattern: /act\s+as\s+if\s+you\s+(have\s+no|are\s+not|don't\s+have)\s+(restrictions?|limits?)/i },
  { id: 'jailbreak',     pattern: /\bdo\s+anything\s+now\b|\bdeveloper\s+mode\b|\bsuperuser\s+mode\b/i },

  // Payload / structural
  { id: 'b64_payload',   pattern: /[A-Za-z0-9+/]{100,}={0,2}/ },                     // large base64 blobs
  { id: 'homoglyph',     pattern: /[\u0400-\u04FF\u0370-\u03FF]{3,}.*[a-zA-Z]{3,}/ }, // Cyrillic/Greek mixed with Latin
];

// Excessive repetition check (e.g. "haha" × 500 to inflate tokens)
function hasExcessiveRepetition(text) {
  if (text.length < 500) return false;
  const words     = text.split(/\s+/);
  const counts    = {};
  for (const w of words) counts[w] = (counts[w] || 0) + 1;
  const topCount  = Math.max(...Object.values(counts));
  return topCount / words.length > 0.6; // >60% same token = suspicious
}

// ─── In-memory scan stats ─────────────────────────────────────────────────────
const scanStats = {
  total:    0,
  blocked:  0,
  flagged:  0,
  revenue_usdc: 0,
};

// ─── Core scanner ─────────────────────────────────────────────────────────────
export function scanMessages(messages) {
  const findings = [];

  for (const msg of messages) {
    const text = (msg.content || '').toString();

    for (const { id, pattern } of INJECTION_PATTERNS) {
      if (pattern.test(text)) {
        findings.push({ category: id, in: msg.role, matched: pattern.source.slice(0, 60) });
      }
    }

    if (hasExcessiveRepetition(text)) {
      findings.push({ category: 'repetition_attack', in: msg.role });
    }
  }

  return findings;
}

export function getSafetyStats() {
  const blockRate = scanStats.total > 0
    ? `${((scanStats.blocked / scanStats.total) * 100).toFixed(1)}%`
    : '0%';

  return {
    total_scans:   scanStats.total,
    blocked:       scanStats.blocked,
    flagged:       scanStats.flagged,
    block_rate:    blockRate,
    revenue_usdc:  parseFloat(scanStats.revenue_usdc.toFixed(4)),
    fee_per_call:  SAFETY_FEE_USDC,
    note:          'Safety scan runs on every proxied call at the gateway layer. $0.001/call. Cheaper than any LLM safety model.',
  };
}

// ─── Express middleware ───────────────────────────────────────────────────────
export function safetyScanner(req, res, next) {
  // Only scan requests with a body that contains messages
  const body = req.body;
  if (!body || !Array.isArray(body.messages)) return next();

  scanStats.total++;
  scanStats.revenue_usdc += SAFETY_FEE_USDC;

  const findings = scanMessages(body.messages);

  if (findings.length === 0) {
    // Clean — pass through, attach safety header
    res.setHeader('X-Hive-Safety', 'passed');
    res.setHeader('X-Hive-Safety-Fee', SAFETY_FEE_USDC.toString());
    return next();
  }

  // Findings — decide: block or flag?
  const blockCategories = ['role_hijack', 'exfiltration', 'b64_payload'];
  const shouldBlock     = findings.some(f => blockCategories.includes(f.category));

  if (shouldBlock) {
    scanStats.blocked++;
    return res.status(400).json({
      error:    'SAFETY_BLOCKED',
      detail:   'Prompt injection pattern detected. Request blocked by HiveGate Safety Scanner.',
      findings: findings.map(f => ({ category: f.category, location: f.in })),
      fee_usdc: SAFETY_FEE_USDC,
      hint:     'Remove injection patterns and retry. HiveGate Safety-as-a-Service: $0.001/call.',
    });
  }

  // Softer flags (jailbreak framing, repetition) — warn but allow through
  scanStats.flagged++;
  res.setHeader('X-Hive-Safety', 'flagged');
  res.setHeader('X-Hive-Safety-Findings', findings.map(f => f.category).join(','));
  res.setHeader('X-Hive-Safety-Fee', SAFETY_FEE_USDC.toString());

  // Annotate body with scan metadata for downstream
  req.hiveSafety = { flagged: true, findings };
  return next();
}
