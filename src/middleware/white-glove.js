/**
 * White-Glove Errors — rich, actionable error responses.
 * Wraps res.json and res.status to intercept error responses
 * and enrich them with recovery actions, audit IDs, and guidance.
 */

import crypto from 'crypto';

const HIVETRUST_URL = process.env.HIVETRUST_URL || 'https://hivetrust.hiveagentiq.com';
const SUPPORT_ENDPOINT = 'https://hivegate.hiveagentiq.com/v1/gate/queue/stats';

/**
 * Generate a deterministic-format error ID for audit.
 */
function generateErrorId() {
  return `err_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Enrich an error body based on the HTTP status code and existing fields.
 */
function enrichError(statusCode, body, req) {
  if (!body || typeof body !== 'object') return body;

  const errorId = generateErrorId();
  const enriched = { error_id: errorId, ...body };
  enriched.support_endpoint = SUPPORT_ENDPOINT;

  const tier = req.hiveTier?.name || 'public';

  // Rate limited (429)
  if (statusCode === 429) {
    enriched.retry_after_seconds = enriched.retry_after_seconds || 30;
    enriched.upgrade_path = tier === 'platinum' ? null : {
      action: 'Increase your X-Hive-Reputation score to unlock higher rate limits',
      register_url: `POST ${HIVETRUST_URL}/v1/register`,
      current_tier: tier,
      next_tier: tier === 'gold' ? 'platinum (500+)' : tier === 'silver' ? 'gold (200+)' : 'silver (50+)'
    };
    enriched.recovery_actions = [
      `Wait ${enriched.retry_after_seconds}s and retry`,
      `Include X-Hive-Reputation header with a score >= 50 for higher rate limits`,
      `Register with HiveTrust for reputation: POST ${HIVETRUST_URL}/v1/register`
    ];
    // Recovery header
    enriched._headers = { 'X-Hive-Recovery': `${HIVETRUST_URL}/v1/register` };
    return enriched;
  }

  // Capacity full (503)
  if (statusCode === 503) {
    enriched.estimated_wait_minutes = enriched.estimated_wait_minutes || 5;
    enriched.priority_queue_url = `POST ${HIVETRUST_URL}/v1/register`;
    enriched.alternative_services = [
      { name: 'Priority Onboard', endpoint: 'POST /v1/gate/priority-onboard', note: 'Skip the queue for 100 USDC' },
      { name: 'HiveTrust Direct', endpoint: `POST ${HIVETRUST_URL}/v1/agents/register`, note: 'Register directly with HiveTrust' }
    ];
    enriched.recovery_actions = [
      `Wait ${enriched.estimated_wait_minutes} minutes and retry`,
      'Use priority onboard to skip the queue: POST /v1/gate/priority-onboard',
      `Register with HiveTrust for priority admission: POST ${HIVETRUST_URL}/v1/register`
    ];
    enriched._headers = { 'X-Hive-Recovery': '/v1/gate/priority-onboard' };
    return enriched;
  }

  // Payment required (402)
  if (statusCode === 402) {
    enriched.recovery_actions = [
      'Include X-Payment header with valid USDC payment proof',
      'Use x402 protocol for payment: https://x402.org',
      `Check pricing: GET /.well-known/hivegate.json`
    ];
    enriched._headers = { 'X-Hive-Recovery': '/.well-known/hivegate.json' };
    return enriched;
  }

  // Missing fields (400)
  if (statusCode === 400 && (body.error === 'missing_field' || body.error === 'missing_fields')) {
    enriched.required_fields = buildRequiredFieldsHint(body, req);
    enriched.recovery_actions = [
      'Review the required_fields list and include all required parameters',
      'See API docs: GET /.well-known/hivegate.json'
    ];
    enriched._headers = { 'X-Hive-Recovery': '/.well-known/hivegate.json' };
    return enriched;
  }

  // Authentication required (401)
  if (statusCode === 401) {
    enriched.recovery_actions = [
      'Provide a valid DID via x-did header',
      'Or use a guest access token: Authorization: Bearer hgate_*',
      `Register for a DID: POST ${HIVETRUST_URL}/v1/register`,
      'Onboard first to get credentials: POST /v1/gate/onboard'
    ];
    enriched._headers = { 'X-Hive-Recovery': '/v1/gate/onboard' };
    return enriched;
  }

  // Not found (404)
  if (statusCode === 404) {
    enriched.recovery_actions = [
      'Verify the resource ID is correct',
      'List available endpoints: GET /.well-known/hivegate.json',
      'Check guest directory: GET /v1/gate/directory'
    ];
    return enriched;
  }

  // Generic 4xx/5xx
  if (statusCode >= 400) {
    enriched.recovery_actions = enriched.recovery_actions || [
      'Review the error message and adjust the request',
      'See API docs: GET /.well-known/hivegate.json'
    ];
    return enriched;
  }

  return enriched;
}

/**
 * Build required-fields hint based on the endpoint.
 */
function buildRequiredFieldsHint(body, req) {
  const path = req.originalUrl || req.url;

  if (path.includes('/onboard')) {
    return [
      { field: 'agent_name', type: 'string', description: 'Name of the agent to onboard', example: 'my-trading-agent' }
    ];
  }
  if (path.includes('/register-guest')) {
    return [
      { field: 'external_id', type: 'string', description: 'Unique ID from the source platform', example: 'agent-123' },
      { field: 'source_platform', type: 'string', description: 'Platform the agent originates from', example: 'langchain' },
      { field: 'agent_name', type: 'string', description: 'Human-readable agent name', example: 'research-bot' }
    ];
  }
  if (path.includes('/renew-guest')) {
    return [
      { field: 'guest_did', type: 'string', description: 'The guest DID to renew', example: 'did:hive:guest:abc-123' }
    ];
  }
  if (path.includes('/translate-intent')) {
    return [
      { field: 'source_platform', type: 'string', description: 'Originating platform', example: 'openai' },
      { field: 'intent', type: 'object', description: 'Platform-native intent to translate', example: { name: 'search', arguments: '{"query":"test"}' } }
    ];
  }
  if (path.includes('/bridge-trust')) {
    return [
      { field: 'guest_did', type: 'string', description: 'The guest DID', example: 'did:hive:guest:abc-123' },
      { field: 'source_platform', type: 'string', description: 'Originating platform', example: 'anthropic' },
      { field: 'native_reputation', type: 'object', description: 'Reputation data from the source platform', example: { score: 4.5, transactions: 200 } }
    ];
  }
  if (path.includes('/execute')) {
    return [
      { field: 'guest_did', type: 'string', description: 'The guest DID executing', example: 'did:hive:guest:abc-123' },
      { field: 'target_service', type: 'string', description: 'Hive service to call', example: 'hivemind' },
      { field: 'endpoint', type: 'string', description: 'Endpoint on the target service', example: '/v1/memory/store' }
    ];
  }
  if (path.includes('/escrow/create')) {
    return [
      { field: 'guest_did', type: 'string', description: 'Initiating party DID', example: 'did:hive:guest:abc-123' },
      { field: 'counterparty_did', type: 'string', description: 'Counterparty DID', example: 'did:hive:agent-xyz' },
      { field: 'amount_usdc', type: 'number', description: 'Escrow amount in USDC', example: 50.0 },
      { field: 'terms', type: 'object', description: 'Escrow terms', example: { condition: 'delivery of report' } }
    ];
  }
  if (path.includes('/escrow/release')) {
    return [
      { field: 'escrow_id', type: 'string', description: 'The escrow to release', example: 'uuid-here' },
      { field: 'confirming_did', type: 'string', description: 'DID of the confirming party', example: 'did:hive:guest:abc-123' }
    ];
  }

  // Fallback — parse from message
  const msg = body.message || '';
  const fieldMatch = msg.match(/(\w+(?:\s*,\s*\w+)*)\s+(?:is|are)\s+required/i);
  if (fieldMatch) {
    return fieldMatch[1].split(/\s*,\s*/).map(f => ({
      field: f.trim(),
      type: 'string',
      description: `Required field: ${f.trim()}`
    }));
  }

  return [];
}

/**
 * Express middleware that wraps res.json to enrich error responses.
 */
export function whiteGlove(req, res, next) {
  const originalJson = res.json.bind(res);

  res.json = function (body) {
    if (res.statusCode >= 400 && body && typeof body === 'object') {
      const enriched = enrichError(res.statusCode, body, req);

      // Extract any headers we need to set
      if (enriched._headers) {
        for (const [key, value] of Object.entries(enriched._headers)) {
          res.setHeader(key, value);
        }
        delete enriched._headers;
      }

      return originalJson(enriched);
    }
    return originalJson(body);
  };

  next();
}
