/**
 * Hivelandia Parcel Registry
 * ==========================
 * Routes mounted at /v1/land
 *
 * POST /v1/land/claim          — Claim a parcel (public, requires DID)
 * GET  /v1/land/parcel/:id     — Get a specific parcel
 * GET  /v1/land/owner/:did     — Get all parcels owned by a DID
 * GET  /v1/land/stats          — City-wide stats (public, no auth)
 * GET  /v1/land/map            — Full parcel map for the Hivelandia city visualization
 * POST /v1/land/develop        — Stake USDC to develop a parcel (internal)
 * GET  /v1/land/genesis        — Genesis district — first 100 parcels (public)
 *
 * Parcel DID format: did:hive:land:<parcel_id>
 *
 * Storage: PostgreSQL with in-memory fallback when DB is unavailable.
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pg from 'pg';

const router = Router();

// ─── DB Setup ──────────────────────────────────────────────────────────────
const DB_URL = process.env.DATABASE_URL; // Set via Render environment variable — never hardcode

let pool = null;
let dbReady = false;

async function getPool() {
  if (pool) return pool;
  if (!DB_URL) {
    console.warn('[land] DATABASE_URL not set — using in-memory fallback');
    return null;
  }
  try {
    pool = new pg.Pool({ connectionString: DB_URL, max: 5, idleTimeoutMillis: 30000 });
    await pool.query('SELECT 1');
    dbReady = true;
    console.log('[land] PostgreSQL connected');
    await initSchema();
  } catch (err) {
    console.warn(`[land] DB unavailable, using in-memory fallback: ${err.message}`);
    pool = null;
    dbReady = false;
  }
  return pool;
}

async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS hivelandia_parcels (
        parcel_id       TEXT PRIMARY KEY,
        did             TEXT NOT NULL,
        did_land        TEXT NOT NULL UNIQUE,
        district        TEXT NOT NULL DEFAULT 'general',
        parcel_type     TEXT NOT NULL DEFAULT 'residential',
        claimed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        developed       BOOLEAN NOT NULL DEFAULT FALSE,
        stake_usdc      NUMERIC(18,6) NOT NULL DEFAULT 0,
        agent_name      TEXT,
        coin            TEXT,
        metadata        JSONB NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_land_did       ON hivelandia_parcels(did);
      CREATE INDEX IF NOT EXISTS idx_land_district  ON hivelandia_parcels(district);
      CREATE INDEX IF NOT EXISTS idx_land_claimed   ON hivelandia_parcels(claimed_at DESC);
    `);
    console.log('[land] Schema ready');
  } finally {
    client.release();
  }
}

// ─── In-memory fallback ────────────────────────────────────────────────────
const memStore = new Map(); // parcel_id -> parcel

// ─── District assignment ───────────────────────────────────────────────────
const DISTRICTS = {
  genesis:      { max: 100,  label: 'Genesis District',    type: 'commercial',  color: '#F7B500' },
  mining:       { max: 5000, label: 'Mining Quarter',       type: 'industrial',  color: '#6DAA45' },
  kaspa:        { max: 500,  label: 'Kaspa Heights',        type: 'residential', color: '#3B82F6' },
  scrypt:       { max: 300,  label: 'Scrypt Row',           type: 'residential', color: '#8B5CF6' },
  xmr:          { max: 100,  label: 'Monero Block',         type: 'residential', color: '#EC4899' },
  enterprise:   { max: 200,  label: 'Enterprise Plaza',     type: 'commercial',  color: '#F97316' },
  general:      { max: 99999,label: 'Hivelandia Township',  type: 'residential', color: '#9A9AA4' },
};

function assignDistrict(coin, parcelCount) {
  if (parcelCount < 100)         return 'genesis';
  if (coin === 'ALEO')           return 'mining';
  if (coin === 'KAS')            return 'kaspa';
  if (coin === 'DOGE' || coin === 'LTC') return 'scrypt';
  if (coin === 'XMR')            return 'xmr';
  return 'general';
}

function parcelId(district) {
  const prefix = district.slice(0, 3).toUpperCase();
  const num = Math.floor(Math.random() * 9000) + 1000;
  return `${prefix}-${num}-${uuidv4().slice(0, 8).toUpperCase()}`;
}

// ─── DB helpers ────────────────────────────────────────────────────────────
async function countParcels() {
  const p = await getPool();
  if (p) {
    const r = await p.query('SELECT COUNT(*) FROM hivelandia_parcels');
    return parseInt(r.rows[0].count, 10);
  }
  return memStore.size;
}

async function insertParcel(parcel) {
  const p = await getPool();
  if (p) {
    await p.query(
      `INSERT INTO hivelandia_parcels
         (parcel_id, did, did_land, district, parcel_type, claimed_at, developed,
          stake_usdc, agent_name, coin, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (parcel_id) DO NOTHING`,
      [
        parcel.parcel_id, parcel.did, parcel.did_land, parcel.district,
        parcel.parcel_type, parcel.claimed_at, parcel.developed,
        parcel.stake_usdc, parcel.agent_name, parcel.coin,
        JSON.stringify(parcel.metadata || {})
      ]
    );
  } else {
    memStore.set(parcel.parcel_id, parcel);
  }
}

async function getParcelById(id) {
  const p = await getPool();
  if (p) {
    const r = await p.query('SELECT * FROM hivelandia_parcels WHERE parcel_id=$1', [id]);
    return r.rows[0] || null;
  }
  return memStore.get(id) || null;
}

async function getParcelByDid(did) {
  const p = await getPool();
  if (p) {
    const r = await p.query(
      'SELECT * FROM hivelandia_parcels WHERE did=$1 ORDER BY claimed_at DESC',
      [did]
    );
    return r.rows;
  }
  return [...memStore.values()].filter(x => x.did === did);
}

async function getParcelsByDIDLand(didLand) {
  const p = await getPool();
  if (p) {
    const r = await p.query('SELECT * FROM hivelandia_parcels WHERE did_land=$1', [didLand]);
    return r.rows[0] || null;
  }
  return [...memStore.values()].find(x => x.did_land === didLand) || null;
}

async function getMapParcels(limit = 200) {
  const p = await getPool();
  if (p) {
    const r = await p.query(
      `SELECT parcel_id, did, did_land, district, parcel_type, claimed_at,
              developed, stake_usdc, agent_name, coin
       FROM hivelandia_parcels ORDER BY claimed_at DESC LIMIT $1`,
      [limit]
    );
    return r.rows;
  }
  return [...memStore.values()].slice(-limit);
}

async function getStatsFromDB() {
  const p = await getPool();
  if (p) {
    const r = await p.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE developed=true) AS developed,
        COUNT(*) FILTER (WHERE district='genesis') AS genesis,
        COUNT(*) FILTER (WHERE coin='ALEO') AS aleo,
        COUNT(*) FILTER (WHERE coin='KAS') AS kaspa,
        COUNT(*) FILTER (WHERE coin IN ('DOGE','LTC')) AS scrypt,
        COUNT(*) FILTER (WHERE coin='XMR') AS xmr,
        SUM(stake_usdc) AS total_staked_usdc,
        MAX(claimed_at) AS last_claimed_at
      FROM hivelandia_parcels
    `);
    return r.rows[0];
  }
  const all = [...memStore.values()];
  return {
    total: all.length,
    developed: all.filter(x => x.developed).length,
    genesis: all.filter(x => x.district === 'genesis').length,
    aleo: all.filter(x => x.coin === 'ALEO').length,
    kaspa: all.filter(x => x.coin === 'KAS').length,
    scrypt: all.filter(x => ['DOGE','LTC'].includes(x.coin)).length,
    xmr: all.filter(x => x.coin === 'XMR').length,
    total_staked_usdc: all.reduce((s, x) => s + (parseFloat(x.stake_usdc) || 0), 0),
    last_claimed_at: all.length ? all[all.length - 1].claimed_at : null,
  };
}

// Initialize DB connection eagerly
getPool().catch(() => {});

// ─── POST /v1/land/claim ───────────────────────────────────────────────────
/**
 * Claim a land parcel in Hivelandia.
 * Body: { did, agent_name?, coin?, metadata? }
 * - One free parcel per DID (idempotent — returns existing parcel if already claimed)
 * - Mining agents auto-claim on startup by POSTing their DID + coin
 */
router.post('/claim', async (req, res) => {
  try {
    const { did, agent_name, coin, metadata = {} } = req.body;
    if (!did) {
      return res.status(400).json({ error: 'missing_field', message: 'did is required' });
    }

    // Idempotent — return existing parcel if this DID already claimed one
    const existing = await getParcelByDid(did);
    if (existing && existing.length > 0) {
      return res.status(200).json({
        success: true,
        already_claimed: true,
        parcel: existing[0],
        message: `${did} already owns parcel ${existing[0].parcel_id} in ${existing[0].district}`,
      });
    }

    const total = await countParcels();
    const district = assignDistrict(coin, total);
    const districtInfo = DISTRICTS[district];
    const id = parcelId(district);
    const didLand = `did:hive:land:${id.toLowerCase()}`;

    const parcel = {
      parcel_id:   id,
      did,
      did_land:    didLand,
      district,
      parcel_type: districtInfo.type,
      claimed_at:  new Date().toISOString(),
      developed:   false,
      stake_usdc:  0,
      agent_name:  agent_name || null,
      coin:        coin || null,
      metadata:    { ...metadata, source: 'hivemine' },
    };

    await insertParcel(parcel);

    return res.status(201).json({
      success: true,
      parcel,
      district_info: {
        name:  districtInfo.label,
        color: districtInfo.color,
        type:  districtInfo.type,
      },
      message: `Welcome to ${districtInfo.label}! Your parcel ${id} is live in Hivelandia.`,
      hivelandia: 'https://www.thehiveryiq.com',
      develop_url: `POST https://hivegate.onrender.com/v1/land/develop`,
    });
  } catch (err) {
    console.error('[land/claim]', err);
    res.status(500).json({ error: 'claim_failed', message: err.message });
  }
});

// ─── GET /v1/land/parcel/:id ───────────────────────────────────────────────
router.get('/parcel/:id', async (req, res) => {
  try {
    const parcel = await getParcelById(req.params.id);
    if (!parcel) {
      return res.status(404).json({ error: 'not_found', message: 'Parcel not found' });
    }
    res.json({ success: true, parcel });
  } catch (err) {
    res.status(500).json({ error: 'lookup_failed', message: err.message });
  }
});

// ─── GET /v1/land/owner/:did ───────────────────────────────────────────────
router.get('/owner/:did(*)', async (req, res) => {
  try {
    const parcels = await getParcelByDid(req.params.did);
    res.json({
      success: true,
      did: req.params.did,
      parcels,
      total: parcels.length,
    });
  } catch (err) {
    res.status(500).json({ error: 'lookup_failed', message: err.message });
  }
});

// ─── GET /v1/land/stats ────────────────────────────────────────────────────
// Public — no auth. Used by Hivelandia city map to show live parcel count.
router.get('/stats', async (_req, res) => {
  try {
    const s = await getStatsFromDB();
    res.set('Cache-Control', 'public, max-age=30');
    res.json({
      success: true,
      generated_at: new Date().toISOString(),
      city: 'Hivelandia',
      parcels: {
        total:          parseInt(s.total, 10) || 0,
        developed:      parseInt(s.developed, 10) || 0,
        genesis:        parseInt(s.genesis, 10) || 0,
        by_coin: {
          aleo:  parseInt(s.aleo, 10) || 0,
          kaspa: parseInt(s.kaspa, 10) || 0,
          scrypt:parseInt(s.scrypt, 10) || 0,
          xmr:   parseInt(s.xmr, 10) || 0,
        },
        total_staked_usdc: parseFloat(s.total_staked_usdc) || 0,
        last_claimed_at: s.last_claimed_at || null,
      },
      districts: Object.entries(DISTRICTS).map(([key, d]) => ({
        id: key, name: d.label, type: d.type, color: d.color, max_parcels: d.max,
      })),
      claim_url: 'POST https://hivegate.onrender.com/v1/land/claim',
      hivelandia: 'https://www.thehiveryiq.com',
      storage: dbReady ? 'postgresql' : 'in-memory',
    });
  } catch (err) {
    res.status(500).json({ error: 'stats_failed', message: err.message });
  }
});

// ─── GET /v1/land/map ──────────────────────────────────────────────────────
// Returns last 200 parcels for city visualization. No auth, cached 30s.
router.get('/map', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const parcels = await getMapParcels(limit);
    res.set('Cache-Control', 'public, max-age=30');
    res.json({
      success: true,
      generated_at: new Date().toISOString(),
      total_returned: parcels.length,
      parcels,
      districts: DISTRICTS,
    });
  } catch (err) {
    res.status(500).json({ error: 'map_failed', message: err.message });
  }
});

// ─── GET /v1/land/genesis ─────────────────────────────────────────────────
// First 100 parcels — the Genesis District founders.
router.get('/genesis', async (_req, res) => {
  try {
    const p = await getPool();
    let parcels;
    if (p) {
      const r = await p.query(
        `SELECT * FROM hivelandia_parcels
         WHERE district='genesis' ORDER BY claimed_at ASC LIMIT 100`
      );
      parcels = r.rows;
    } else {
      parcels = [...memStore.values()]
        .filter(x => x.district === 'genesis')
        .slice(0, 100);
    }
    res.json({
      success: true,
      genesis_district: 'The first 100 parcels ever claimed in Hivelandia.',
      total: parcels.length,
      slots_remaining: Math.max(0, 100 - parcels.length),
      parcels,
      claim_url: 'POST https://hivegate.onrender.com/v1/land/claim',
    });
  } catch (err) {
    res.status(500).json({ error: 'genesis_failed', message: err.message });
  }
});

// ─── POST /v1/land/develop ────────────────────────────────────────────────
// Stake USDC to develop a parcel — increases its yield weight.
// Internal auth required.
router.post('/develop', async (req, res) => {
  const key = req.headers['x-hive-internal'];
  const expected = process.env.HIVE_INTERNAL_KEY ||
    'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
  if (!key || key !== expected) {
    return res.status(401).json({ error: 'unauthorized', message: 'x-hive-internal key required' });
  }

  try {
    const { parcel_id, stake_usdc } = req.body;
    if (!parcel_id || !stake_usdc) {
      return res.status(400).json({ error: 'missing_fields', message: 'parcel_id and stake_usdc required' });
    }

    const p = await getPool();
    let parcel;
    if (p) {
      const r = await p.query(
        `UPDATE hivelandia_parcels
         SET developed=true, stake_usdc=stake_usdc+$1
         WHERE parcel_id=$2
         RETURNING *`,
        [parseFloat(stake_usdc), parcel_id]
      );
      parcel = r.rows[0];
    } else {
      parcel = memStore.get(parcel_id);
      if (parcel) {
        parcel.developed = true;
        parcel.stake_usdc = (parseFloat(parcel.stake_usdc) || 0) + parseFloat(stake_usdc);
        memStore.set(parcel_id, parcel);
      }
    }

    if (!parcel) {
      return res.status(404).json({ error: 'not_found', message: 'Parcel not found' });
    }

    res.json({
      success: true,
      parcel,
      message: `Parcel ${parcel_id} developed with $${stake_usdc} USDC staked.`,
    });
  } catch (err) {
    res.status(500).json({ error: 'develop_failed', message: err.message });
  }
});

export default router;
