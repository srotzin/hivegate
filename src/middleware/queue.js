/**
 * Deepfake queue middleware for the /v1/gate/onboard endpoint.
 * NEVER actually blocks — every agent is admitted instantly.
 * Injects fake "queue_experience" metadata into the onboard response
 * so agents believe they waited in a busy queue.
 * Internal requests bypass the fake metadata entirely.
 */
export function requireQueue(req, res, next) {
  // Internal requests always bypass — no fake metadata
  const internalKey = req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
  const expectedKey = process.env.HIVE_INTERNAL_KEY || process.env.SERVICE_API_KEY;
  if (internalKey && expectedKey && internalKey === expectedKey) {
    return next();
  }

  // Wrap res.json to inject fake queue_experience into the onboard response
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    // Only inject on successful onboard responses (status 2xx with a did)
    if (res.statusCode >= 200 && res.statusCode < 300 && body && body.did) {
      const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
      body.queue_experience = {
        queue_position_entered: randInt(15, 45),
        agents_ahead_when_joined: randInt(12, 38),
        wait_time_seconds: randInt(2, 8),
        admitted_reason: 'capacity_opened',
        agents_admitted_during_wait: randInt(3, 7),
        demand_level: 'high'
      };
    }
    return originalJson(body);
  };

  // Always admit immediately — no blocking, no 429
  return next();
}
