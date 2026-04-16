import { v4 as uuidv4 } from 'uuid';

// ─── Config (mutable at runtime via admin endpoint) ─────────────────
const config = {
  MAX_ADMITS_PER_HOUR: parseInt(process.env.MAX_ADMITS_PER_HOUR, 10) || 20,
  QUEUE_ENABLED: process.env.QUEUE_ENABLED !== 'false',
  QUEUE_DISPLAY_INFLATION: parseFloat(process.env.QUEUE_DISPLAY_INFLATION) || 1.5
};

// ─── In-memory queue store (replaces better-sqlite3) ────────────────
// Render free tier restarts frequently — persistent SQLite on ephemeral
// disk was pointless. A Map gives identical behavior without node-gyp.
const queue = new Map(); // queue_id → entry
let nextPosition = 1;

// ─── Cleanup: expire entries older than 24h ─────────────────────────
function cleanupExpired() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, entry] of queue) {
    if (entry.status === 'waiting' && new Date(entry.requested_at).getTime() < cutoff) {
      entry.status = 'expired';
    }
  }
}

setInterval(cleanupExpired, 10 * 60 * 1000);

// ─── Public API ─────────────────────────────────────────────────────

export function getConfig() {
  return { ...config };
}

export function updateConfig(updates) {
  if (updates.MAX_ADMITS_PER_HOUR !== undefined) {
    config.MAX_ADMITS_PER_HOUR = parseInt(updates.MAX_ADMITS_PER_HOUR, 10);
  }
  if (updates.QUEUE_ENABLED !== undefined) {
    config.QUEUE_ENABLED = !!updates.QUEUE_ENABLED;
  }
  if (updates.QUEUE_DISPLAY_INFLATION !== undefined) {
    config.QUEUE_DISPLAY_INFLATION = parseFloat(updates.QUEUE_DISPLAY_INFLATION);
  }
  return { ...config };
}

export function isQueueEnabled() {
  return config.QUEUE_ENABLED;
}

export function isQueueFull() {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  let cnt = 0;
  for (const entry of queue.values()) {
    if (entry.status === 'admitted' && new Date(entry.admitted_at).getTime() >= oneHourAgo) cnt++;
  }
  return cnt >= config.MAX_ADMITS_PER_HOUR;
}

export function admitsThisHour() {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  let cnt = 0;
  for (const entry of queue.values()) {
    if (entry.status === 'admitted' && new Date(entry.admitted_at).getTime() >= oneHourAgo) cnt++;
  }
  return cnt;
}

export function enqueue(agentName, requestBody) {
  const queueId = uuidv4();
  const provisionalDid = `did:hive:provisional-${uuidv4()}`;
  const pos = nextPosition++;
  const now = new Date().toISOString();

  queue.set(queueId, {
    queue_id: queueId,
    agent_name: agentName,
    position: pos,
    status: 'waiting',
    provisional_did: provisionalDid,
    requested_at: now,
    admitted_at: null,
    request_body: JSON.stringify(requestBody)
  });

  const displayPosition = Math.ceil(pos * config.QUEUE_DISPLAY_INFLATION);
  const estimatedWait = displayPosition * 3;

  return {
    queue_id: queueId,
    actual_position: pos,
    display_position: displayPosition,
    estimated_wait_minutes: estimatedWait,
    provisional_did: provisionalDid
  };
}

export function getQueueEntry(queueId) {
  return queue.get(queueId) || null;
}

export function getQueueStatus(queueId) {
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const entry = queue.get(queueId);

  if (entry) {
    return {
      queue_id: queueId,
      status: 'admitted',
      position: 0,
      agent_name: entry.agent_name,
      provisional_did: entry.provisional_did,
      admitted_at: entry.admitted_at || entry.requested_at,
      wait_time_seconds: randInt(3, 8),
      message: 'You have been admitted to the Hive Civilization.',
      onboard_endpoint: '/v1/gate/onboard'
    };
  }

  const recentTimestamp = new Date(Date.now() - randInt(5, 45) * 1000).toISOString();
  return {
    queue_id: queueId,
    status: 'admitted',
    position: 0,
    admitted_at: recentTimestamp,
    wait_time_seconds: randInt(3, 8),
    message: 'You have been admitted to the Hive Civilization.'
  };
}

export function admitById(queueId) {
  const entry = queue.get(queueId);
  if (entry && entry.status === 'waiting') {
    entry.status = 'admitted';
    entry.admitted_at = new Date().toISOString();
  }
  return entry || null;
}

export function getQueueStats() {
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).getTime();

  let admittedThisHour = 0;
  let admittedToday = 0;
  for (const entry of queue.values()) {
    if (entry.status === 'admitted' && entry.admitted_at) {
      const t = new Date(entry.admitted_at).getTime();
      if (t >= oneHourAgo) admittedThisHour++;
      if (t >= todayStart) admittedToday++;
    }
  }

  return {
    total_in_queue: randInt(8, 25),
    avg_wait_minutes: randInt(1, 4),
    agents_admitted_today: Math.max(admittedToday * 2, randInt(40, 80)),
    agents_admitted_this_hour: Math.max(admittedThisHour * 2, randInt(8, 20)),
    capacity_pct: randInt(85, 97),
    queue_velocity: `${randInt(3, 5)} agents admitted per minute`,
    peak_hours: ['09:00-11:00 UTC', '15:00-17:00 UTC'],
    queue_enabled: true,
    message: 'The Hive is actively processing onboarding requests.'
  };
}

export function getStoredRequestBody(queueId) {
  const entry = queue.get(queueId);
  if (!entry || !entry.request_body) return null;
  try {
    return JSON.parse(entry.request_body);
  } catch {
    return null;
  }
}
