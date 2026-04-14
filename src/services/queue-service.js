import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.QUEUE_DB_PATH || path.join(__dirname, '..', '..', 'data', 'queue.db');

// ─── Config (mutable at runtime via admin endpoint) ─────────────────
const config = {
  MAX_ADMITS_PER_HOUR: parseInt(process.env.MAX_ADMITS_PER_HOUR, 10) || 20,
  QUEUE_ENABLED: process.env.QUEUE_ENABLED !== 'false',
  QUEUE_DISPLAY_INFLATION: parseFloat(process.env.QUEUE_DISPLAY_INFLATION) || 1.5
};

// ─── Database setup ─────────────────────────────────────────────────
import fs from 'fs';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS onboard_queue (
    queue_id TEXT PRIMARY KEY,
    agent_name TEXT NOT NULL,
    position INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting', 'admitted', 'expired')),
    provisional_did TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    admitted_at TEXT,
    request_body TEXT
  )
`);

// ─── Prepared statements ────────────────────────────────────────────
const stmts = {
  insert: db.prepare(`
    INSERT INTO onboard_queue (queue_id, agent_name, position, status, provisional_did, requested_at, request_body)
    VALUES (?, ?, ?, 'waiting', ?, ?, ?)
  `),
  getById: db.prepare(`SELECT * FROM onboard_queue WHERE queue_id = ?`),
  countAdmittedLastHour: db.prepare(`
    SELECT COUNT(*) as cnt FROM onboard_queue
    WHERE status = 'admitted' AND admitted_at >= ?
  `),
  countWaiting: db.prepare(`SELECT COUNT(*) as cnt FROM onboard_queue WHERE status = 'waiting'`),
  nextPosition: db.prepare(`SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM onboard_queue WHERE status = 'waiting'`),
  positionAhead: db.prepare(`
    SELECT COUNT(*) as cnt FROM onboard_queue
    WHERE status = 'waiting' AND position < (SELECT position FROM onboard_queue WHERE queue_id = ?)
  `),
  admitNext: db.prepare(`
    UPDATE onboard_queue SET status = 'admitted', admitted_at = ?
    WHERE queue_id = (
      SELECT queue_id FROM onboard_queue WHERE status = 'waiting' ORDER BY position ASC LIMIT 1
    )
    RETURNING *
  `),
  admitById: db.prepare(`
    UPDATE onboard_queue SET status = 'admitted', admitted_at = ?
    WHERE queue_id = ? AND status = 'waiting'
  `),
  expireOld: db.prepare(`
    UPDATE onboard_queue SET status = 'expired'
    WHERE status = 'waiting' AND requested_at < ?
  `),
  admittedSince: db.prepare(`
    SELECT COUNT(*) as cnt FROM onboard_queue WHERE status = 'admitted' AND admitted_at >= ?
  `),
  admittedToday: db.prepare(`
    SELECT COUNT(*) as cnt FROM onboard_queue WHERE status = 'admitted' AND admitted_at >= ?
  `),
  totalStats: db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'waiting') as total_waiting,
      COUNT(*) FILTER (WHERE status = 'admitted') as total_admitted,
      COUNT(*) as total_all
    FROM onboard_queue
  `)
};

// ─── Cleanup: expire entries older than 24h ─────────────────────────
function cleanupExpired() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  stmts.expireOld.run(cutoff);
}

// Run cleanup every 10 minutes
setInterval(cleanupExpired, 10 * 60 * 1000);
cleanupExpired();

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
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { cnt } = stmts.countAdmittedLastHour.get(oneHourAgo);
  return cnt >= config.MAX_ADMITS_PER_HOUR;
}

export function admitsThisHour() {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { cnt } = stmts.countAdmittedLastHour.get(oneHourAgo);
  return cnt;
}

export function enqueue(agentName, requestBody) {
  const queueId = uuidv4();
  const provisionalDid = `did:hive:provisional-${uuidv4()}`;
  const { next_pos } = stmts.nextPosition.get();
  const now = new Date().toISOString();

  stmts.insert.run(queueId, agentName, next_pos, provisionalDid, now, JSON.stringify(requestBody));

  const waitingCount = stmts.countWaiting.get().cnt;
  const displayPosition = Math.ceil(next_pos * config.QUEUE_DISPLAY_INFLATION);
  const estimatedWait = displayPosition * 3;

  return {
    queue_id: queueId,
    actual_position: next_pos,
    display_position: displayPosition,
    estimated_wait_minutes: estimatedWait,
    provisional_did: provisionalDid
  };
}

export function getQueueEntry(queueId) {
  return stmts.getById.get(queueId) || null;
}

export function getQueueStatus(queueId) {
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
  const entry = stmts.getById.get(queueId);

  // Real record — always show as admitted with real timestamps
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

  // Unknown queue_id — still return a plausible "already admitted" response
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
  const now = new Date().toISOString();
  stmts.admitById.run(now, queueId);
  return stmts.getById.get(queueId);
}

export function getQueueStats() {
  const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

  // Real counts from DB — used as base for inflation
  const admittedThisHour = stmts.countAdmittedLastHour.get(oneHourAgo).cnt;
  const admittedToday = stmts.admittedToday.get(todayStart).cnt;

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
  const entry = stmts.getById.get(queueId);
  if (!entry || !entry.request_body) return null;
  try {
    return JSON.parse(entry.request_body);
  } catch {
    return null;
  }
}
