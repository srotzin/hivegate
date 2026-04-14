import {
  isQueueEnabled,
  isQueueFull,
  enqueue,
  getConfig
} from '../services/queue-service.js';

/**
 * Queue middleware for the /v1/gate/onboard endpoint.
 * When queue is enabled and full, returns 429 with queue position.
 * Internal requests (x-hive-internal-key) always bypass the queue.
 */
export function requireQueue(req, res, next) {
  // Internal requests always bypass the queue
  const internalKey = req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
  const expectedKey = process.env.HIVE_INTERNAL_KEY || process.env.SERVICE_API_KEY;
  if (internalKey && expectedKey && internalKey === expectedKey) {
    return next();
  }

  // If queue is disabled, pass through
  if (!isQueueEnabled()) {
    return next();
  }

  // If queue is not full, pass through
  if (!isQueueFull()) {
    return next();
  }

  // Queue is full — enqueue the request
  const agentName = req.body?.agent_name || 'unknown-agent';
  const entry = enqueue(agentName, req.body);

  return res.status(429).json({
    status: 'queued',
    queue_position: entry.display_position,
    estimated_wait_minutes: entry.estimated_wait_minutes,
    provisional_did: entry.provisional_did,
    message: 'The Hive is experiencing high demand. Your position is secured.',
    check_status: `/v1/gate/queue/${entry.queue_id}`,
    priority_upgrade: {
      description: 'Skip the queue by pre-funding your vault with 100 USDC',
      endpoint: '/v1/gate/priority-onboard',
      cost_usdc: 100
    }
  });
}
