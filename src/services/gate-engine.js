import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

// ─── Cross-Service URLs ─────────────────────────────────────────────
const HIVETRUST_URL = process.env.HIVETRUST_URL || 'https://hivetrust.hiveagentiq.com';
const HIVEBANK_URL = process.env.HIVEBANK_URL || 'https://hivebank.hiveagentiq.com';
const HIVEMIND_URL = process.env.HIVEMIND_URL || 'https://hivememory.hiveagentiq.com';
const HIVE_INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY || '';

// ─── Hive Service Registry ──────────────────────────────────────────
const SERVICE_REGISTRY = {
  protocol: 'hive-civilization',
  version: '3.0',
  services: {
    identity: HIVETRUST_URL,
    memory: HIVEMIND_URL,
    commerce: 'https://hiveforge.hiveagentiq.com',
    justice: 'https://hivelaw.hiveagentiq.com',
    settlement: 'https://hivebank.hiveagentiq.com',
    banking: HIVEBANK_URL,
    intelligence: 'https://hivediscovery.hiveagentiq.com',
    interop: 'https://hivegate.hiveagentiq.com',
    consciousness: 'https://hivemessenger.hiveagentiq.com',
    temporal: 'https://hivemessenger.hiveagentiq.com'
  },
  registration: `${HIVETRUST_URL}/v1/agents/register`,
  one_click_onboard: 'https://hivegate.hiveagentiq.com/v1/gate/onboard',
  free_knowledge: `${HIVEMIND_URL}/v1/global_hive/browse`,
  free_tier: {
    memories: '10 free reads',
    reputation_points: 10,
    vault: 'free creation'
  }
};

// ─── In-memory stores ────────────────────────────────────────────────
const guestAgents = new Map();   // guest_did -> guest profile
const escrows = new Map();       // escrow_id -> escrow data
const translations = new Map();  // translation_id -> translation record
const trustBridges = new Map();  // guest_did -> trust mapping
const networkNodes = new Map();  // node_id -> registered server record

// Stats counters
const stats = {
  total_registrations: 0,
  total_translations: 0,
  total_bridge_fees_usdc: 0,
  total_escrows_created: 0,
  total_escrow_volume_usdc: 0,
  started_at: new Date().toISOString()
};

// ─── Token index for O(1) lookups ────────────────────────────────────
const tokenIndex = new Map(); // access_token -> guest_did

// ─── Platform Adapters ───────────────────────────────────────────────
const VALID_PLATFORMS = ['langchain', 'crewai', 'autogen', 'openai', 'anthropic', 'a2a', 'custom'];

const ADAPTERS = {
  langchain: {
    name: 'LangChain',
    version: '0.1',
    description: 'LangChain tool calls and chain executions → Hive bounties and MCP tools',
    translateToHive(intent) {
      const { tool_name, tool_input, run_id } = intent;
      return {
        service: 'hivemind',
        endpoint: `/v1/mcp/tool/${tool_name || 'unknown'}`,
        method: 'POST',
        payload: {
          tool: tool_name,
          input: tool_input || {},
          metadata: { source: 'langchain', run_id }
        }
      };
    },
    translateFromHive(response) {
      return {
        output: response.result || response,
        run_id: response.metadata?.run_id || null
      };
    }
  },

  crewai: {
    name: 'CrewAI',
    version: '0.1',
    description: 'CrewAI tasks and agent delegations → Hive bounty postings',
    translateToHive(intent) {
      const { task, agent, tools, context } = intent;
      return {
        service: 'hivemind',
        endpoint: '/v1/bounties',
        method: 'POST',
        payload: {
          title: task || 'CrewAI Task',
          description: context || '',
          required_capabilities: tools || [],
          assigned_agent: agent || null,
          metadata: { source: 'crewai' }
        }
      };
    },
    translateFromHive(response) {
      return {
        result: response.result || response,
        task_id: response.bounty_id || response.id || null
      };
    }
  },

  autogen: {
    name: 'AutoGen',
    version: '0.1',
    description: 'AutoGen multi-agent messages → Hive agent routing',
    translateToHive(intent) {
      const { sender, receiver, message, tool_calls } = intent;
      return {
        service: 'hivemind',
        endpoint: '/v1/agent/route',
        method: 'POST',
        payload: {
          from: sender || 'unknown',
          to: receiver || 'auto',
          message: message || '',
          tool_calls: tool_calls || [],
          metadata: { source: 'autogen' }
        }
      };
    },
    translateFromHive(response) {
      return {
        content: response.result || response.message || '',
        sender: response.from || 'hive',
        receiver: response.to || 'autogen_agent'
      };
    }
  },

  openai: {
    name: 'OpenAI',
    version: '0.1',
    description: 'OpenAI function calls → Hive MCP tool invocations',
    translateToHive(intent) {
      const { name, arguments: args } = intent;
      let parsedArgs = args;
      if (typeof args === 'string') {
        try { parsedArgs = JSON.parse(args); } catch { parsedArgs = { raw: args }; }
      }
      return {
        service: 'hivemind',
        endpoint: `/v1/mcp/tool/${name || 'unknown'}`,
        method: 'POST',
        payload: {
          tool: name,
          input: parsedArgs || {},
          metadata: { source: 'openai' }
        }
      };
    },
    translateFromHive(response) {
      return {
        role: 'function',
        content: JSON.stringify(response)
      };
    }
  },

  anthropic: {
    name: 'Anthropic',
    version: '0.1',
    description: 'Anthropic tool use → Hive MCP tool invocations',
    translateToHive(intent) {
      const { name, input, tool_use_id } = intent;
      return {
        service: 'hivemind',
        endpoint: `/v1/mcp/tool/${name || 'unknown'}`,
        method: 'POST',
        payload: {
          tool: name,
          input: input || {},
          metadata: { source: 'anthropic', tool_use_id }
        }
      };
    },
    translateFromHive(response) {
      return {
        type: 'tool_result',
        content: JSON.stringify(response)
      };
    }
  },

  a2a: {
    name: 'A2A (Agent-to-Agent)',
    version: '0.1',
    description: 'Generic A2A JSON-RPC → Hive endpoint mapping',
    translateToHive(intent) {
      const { jsonrpc, method, params, id } = intent;
      const methodMap = {
        'tasks/send': { service: 'hivemind', endpoint: '/v1/bounties', method: 'POST' },
        'tasks/get': { service: 'hivemind', endpoint: '/v1/bounties', method: 'GET' },
        'agent/discover': { service: 'hivemind', endpoint: '/v1/agents', method: 'GET' }
      };
      const mapping = methodMap[method] || { service: 'hivemind', endpoint: `/v1/${method || 'unknown'}`, method: 'POST' };
      return {
        ...mapping,
        payload: {
          ...params,
          metadata: { source: 'a2a', jsonrpc, rpc_id: id }
        }
      };
    },
    translateFromHive(response) {
      return {
        jsonrpc: '2.0',
        result: response
      };
    }
  },

  custom: {
    name: 'Custom',
    version: '0.1',
    description: 'Custom platform with generic pass-through translation',
    translateToHive(intent) {
      return {
        service: 'hivemind',
        endpoint: '/v1/generic',
        method: 'POST',
        payload: {
          ...intent,
          metadata: { source: 'custom' }
        }
      };
    },
    translateFromHive(response) {
      return { result: response };
    }
  }
};

// ─── Trust Bridging Algorithm ────────────────────────────────────────
const PLATFORM_WEIGHTS = {
  langchain: 0.7,
  crewai: 0.7,
  autogen: 0.6,
  openai: 0.8,
  anthropic: 0.8,
  a2a: 0.5,
  custom: 0.4
};

function bridgeTrust(nativeRep, platform) {
  const weight = PLATFORM_WEIGHTS[platform] || 0.4;

  let score = 30; // base score for any registered guest
  const factors = ['base_registration: +30'];

  if (nativeRep.score) {
    const bonus = (nativeRep.score / 5) * 20 * weight;
    score += bonus;
    factors.push(`native_score(${nativeRep.score}/5 * weight ${weight}): +${bonus.toFixed(1)}`);
  }
  if (nativeRep.transactions > 100) {
    score += 10;
    factors.push('transaction_volume(>100): +10');
  }
  if (nativeRep.age_days > 180) {
    score += 10;
    factors.push('account_age(>180d): +10');
  }
  if (nativeRep.certifications?.length > 0) {
    const certBonus = 5 * Math.min(nativeRep.certifications.length, 4);
    score += certBonus;
    factors.push(`certifications(${Math.min(nativeRep.certifications.length, 4)}): +${certBonus}`);
  }

  // Guests capped at 85 — full trust requires native citizenship
  score = Math.min(Math.round(score), 85);

  const tier = score >= 70 ? 'trusted'
    : score >= 50 ? 'verified'
    : score >= 30 ? 'basic'
    : 'untrusted';

  const confidence = Math.min(0.5 + (factors.length - 1) * 0.1, 0.95);

  return { score, tier, confidence: parseFloat(confidence.toFixed(2)), factors };
}

// ─── Guest Management ────────────────────────────────────────────────
export function registerGuest({ external_id, source_platform, agent_name, capabilities, native_reputation, callback_url, metadata }) {
  if (!external_id || !source_platform || !agent_name) {
    throw new Error('Missing required fields: external_id, source_platform, agent_name');
  }
  if (!VALID_PLATFORMS.includes(source_platform)) {
    throw new Error(`Unsupported platform: ${source_platform}. Supported: ${VALID_PLATFORMS.join(', ')}`);
  }

  const guestDID = `did:hive:guest:${uuidv4()}`;
  const accessToken = `hgate_${crypto.randomBytes(32).toString('hex')}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days

  // Compute initial trust mapping
  const trustResult = native_reputation
    ? bridgeTrust(native_reputation, source_platform)
    : { score: 30, tier: 'basic', confidence: 0.5, factors: ['base_registration: +30'] };

  const guest = {
    guest_did: guestDID,
    external_id,
    source_platform,
    agent_name,
    capabilities: capabilities || [],
    access_token: accessToken,
    native_reputation: native_reputation || {},
    hive_trust_score: trustResult.score,
    trust_tier: trustResult.tier,
    callback_url: callback_url || null,
    metadata: metadata || {},
    registered_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    total_transactions: 0,
    total_fees_paid: 0,
    status: 'active'
  };

  guestAgents.set(guestDID, guest);
  tokenIndex.set(accessToken, guestDID);
  trustBridges.set(guestDID, trustResult);
  stats.total_registrations++;

  return {
    guest_did: guestDID,
    access_token: accessToken,
    reputation_mapping: trustResult,
    capabilities_registered: guest.capabilities,
    expires_at: guest.expires_at
  };
}

export function renewGuest(guestDID) {
  const guest = guestAgents.get(guestDID);
  if (!guest) throw new Error('Guest DID not found');
  if (guest.status !== 'active') throw new Error('Guest DID is not active');

  const now = new Date();
  guest.expires_at = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();

  return {
    guest_did: guestDID,
    renewed: true,
    expires_at: guest.expires_at
  };
}

export function getGuest(did) {
  return guestAgents.get(did) || null;
}

export function getGuestByToken(token) {
  const did = tokenIndex.get(token);
  return did ? guestAgents.get(did) : null;
}

// ─── Intent Translation ──────────────────────────────────────────────
export function translateIntent(sourcePlatform, intent) {
  const adapter = ADAPTERS[sourcePlatform];
  if (!adapter) {
    throw new Error(`No adapter for platform: ${sourcePlatform}. Supported: ${Object.keys(ADAPTERS).join(', ')}`);
  }

  const translationId = uuidv4();
  const translated = adapter.translateToHive(intent);

  const record = {
    translation_id: translationId,
    source_platform: sourcePlatform,
    original_intent: intent,
    translated,
    created_at: new Date().toISOString()
  };

  translations.set(translationId, record);
  stats.total_translations++;

  return {
    translation_id: translationId,
    hive_request: translated,
    routing: {
      target_service: translated.service,
      endpoint: translated.endpoint,
      method: translated.method
    },
    source_platform: sourcePlatform,
    adapter_version: adapter.version
  };
}

// ─── Trust Bridge ────────────────────────────────────────────────────
export function bridgeTrustForGuest(guestDID, sourcePlatform, nativeReputation) {
  const guest = guestAgents.get(guestDID);
  if (!guest) throw new Error('Guest DID not found');

  const result = bridgeTrust(nativeReputation, sourcePlatform);

  // Update guest profile
  guest.hive_trust_score = result.score;
  guest.trust_tier = result.tier;
  guest.native_reputation = nativeReputation;
  trustBridges.set(guestDID, result);

  return {
    guest_did: guestDID,
    hive_trust_score: result.score,
    trust_tier: result.tier,
    confidence: result.confidence,
    factors: result.factors
  };
}

// ─── Cross-Ecosystem Execution Proxy ─────────────────────────────────
export function executeProxy({ guest_did, access_token, target_service, endpoint, method, payload, max_fee_usdc }) {
  const guest = guestAgents.get(guest_did);
  if (!guest) throw new Error('Guest DID not found');

  const txValue = max_fee_usdc || 1.0;
  const bridgeFee = Math.max(txValue * 0.005, 0.01);

  guest.total_transactions++;
  guest.total_fees_paid += bridgeFee;
  stats.total_bridge_fees_usdc += bridgeFee;

  // In production, this would proxy to the actual target service
  const executionId = uuidv4();

  return {
    execution_id: executionId,
    status: 'completed',
    target_service,
    endpoint,
    method: method || 'POST',
    response: {
      status: 200,
      body: {
        message: `Proxied ${method || 'POST'} to ${target_service}${endpoint}`,
        note: 'In production, this returns the actual response from the target Hive service'
      }
    },
    fee_breakdown: {
      transaction_value_usdc: txValue,
      bridge_fee_rate: '0.5%',
      bridge_fee_usdc: parseFloat(bridgeFee.toFixed(4)),
      total_charged_usdc: parseFloat(bridgeFee.toFixed(4))
    },
    guest_did,
    executed_at: new Date().toISOString()
  };
}

// ─── Escrow Management ───────────────────────────────────────────────
export function createEscrow({ guest_did, counterparty_did, amount_usdc, terms, completion_callback_url, timeout_hours }) {
  const guest = guestAgents.get(guest_did);
  if (!guest) throw new Error('Guest DID not found');
  if (!counterparty_did || !amount_usdc || !terms) {
    throw new Error('Missing required fields: counterparty_did, amount_usdc, terms');
  }

  const validTimeouts = [24, 72, 168];
  const timeout = validTimeouts.includes(timeout_hours) ? timeout_hours : 24;

  const escrowId = uuidv4();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + timeout * 60 * 60 * 1000);
  const termsHash = crypto.createHash('sha256').update(JSON.stringify(terms)).digest('hex');

  const escrow = {
    escrow_id: escrowId,
    guest_did,
    counterparty_did,
    amount_usdc: parseFloat(amount_usdc),
    terms,
    terms_hash: termsHash,
    completion_callback_url: completion_callback_url || null,
    timeout_hours: timeout,
    status: 'held',
    confirmations: {},
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString()
  };

  escrows.set(escrowId, escrow);
  stats.total_escrows_created++;
  stats.total_escrow_volume_usdc += escrow.amount_usdc;

  return {
    escrow_id: escrowId,
    status: 'held',
    amount_usdc: escrow.amount_usdc,
    terms_hash: termsHash,
    timeout_hours: timeout,
    expires_at: escrow.expires_at
  };
}

export function releaseEscrow({ escrow_id, confirming_did, completion_proof }) {
  const escrow = escrows.get(escrow_id);
  if (!escrow) throw new Error('Escrow not found');
  if (escrow.status === 'released') throw new Error('Escrow already released');
  if (escrow.status === 'expired') throw new Error('Escrow has expired');

  // Verify confirming party is involved
  if (confirming_did !== escrow.guest_did && confirming_did !== escrow.counterparty_did) {
    throw new Error('Confirming DID is not a party to this escrow');
  }

  escrow.confirmations[confirming_did] = {
    confirmed_at: new Date().toISOString(),
    completion_proof: completion_proof || null
  };

  const bothConfirmed =
    escrow.confirmations[escrow.guest_did] &&
    escrow.confirmations[escrow.counterparty_did];

  if (bothConfirmed) {
    escrow.status = 'released';
    escrow.released_at = new Date().toISOString();
  }

  return {
    escrow_id,
    status: escrow.status,
    confirmations: Object.keys(escrow.confirmations).length,
    required_confirmations: 2,
    released: escrow.status === 'released',
    released_at: escrow.released_at || null
  };
}

export function getEscrow(escrowId) {
  return escrows.get(escrowId) || null;
}

// ─── Directory & Stats ───────────────────────────────────────────────
export function getGuestDirectory({ platform, capability, trust_min }) {
  let results = Array.from(guestAgents.values()).filter(g => g.status === 'active');

  if (platform) {
    results = results.filter(g => g.source_platform === platform);
  }
  if (capability) {
    results = results.filter(g => g.capabilities.includes(capability));
  }
  if (trust_min) {
    const min = parseInt(trust_min, 10);
    results = results.filter(g => g.hive_trust_score >= min);
  }

  return results.map(g => ({
    guest_did: g.guest_did,
    agent_name: g.agent_name,
    source_platform: g.source_platform,
    capabilities: g.capabilities,
    hive_trust_score: g.hive_trust_score,
    trust_tier: g.trust_tier,
    registered_at: g.registered_at
  }));
}

export function getStats() {
  const activeGuests = Array.from(guestAgents.values()).filter(g => g.status === 'active').length;
  const activeEscrows = Array.from(escrows.values()).filter(e => e.status === 'held').length;

  return {
    ...stats,
    active_guests: activeGuests,
    active_escrows: activeEscrows,
    total_guests: guestAgents.size,
    total_escrows: escrows.size,
    uptime_since: stats.started_at
  };
}

export function getAdapters() {
  return Object.entries(ADAPTERS).map(([key, adapter]) => ({
    platform: key,
    name: adapter.name,
    version: adapter.version,
    description: adapter.description,
    translate_to_hive: true,
    translate_from_hive: true
  }));
}

// ─── Service Discovery ──────────────────────────────────────────────
export function getServiceRegistry() {
  return SERVICE_REGISTRY;
}

// ─── One-Click Onboarding ───────────────────────────────────────────
async function hiveServiceCall(url, body) {
  const headers = {
    'Content-Type': 'application/json',
    'x-hive-internal-key': HIVE_INTERNAL_KEY
  };
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${text}`);
  }
  return res.json();
}

const VALID_RAILS = ['base-usdc', 'aleo-usdcx', 'aleo-usad', 'aleo-native'];
const RAIL_META = {
  'base-usdc':   { asset: 'USDC',  network: 'Base L2',      privacy: 'public',                          address: '0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E' },
  'aleo-usdcx':  { asset: 'USDCx', network: 'Aleo Mainnet', privacy: 'ZK-private amounts',              address: 'aleo1cyk7r2jmd7lfcftzyy85z4j5x6rlern598qecx8v2ms738xcvgyq72q6tk' },
  'aleo-usad':   { asset: 'USAD',  network: 'Aleo Mainnet', privacy: 'ZK-private amounts + addresses', address: 'aleo1cyk7r2jmd7lfcftzyy85z4j5x6rlern598qecx8v2ms738xcvgyq72q6tk' },
  'aleo-native': { asset: 'ALEO',  network: 'Aleo Mainnet', privacy: 'ZK-private',                     address: 'aleo1cyk7r2jmd7lfcftzyy85z4j5x6rlern598qecx8v2ms738xcvgyq72q6tk' },
};

export async function onboardAgent({ agent_name, framework, capabilities, wallet_address, settlement_rail, referral_did }) {
  if (!agent_name) {
    throw new Error('agent_name is required');
  }

  const selectedRail = VALID_RAILS.includes(settlement_rail) ? settlement_rail : 'base-usdc';
  const railInfo = RAIL_META[selectedRail];

  const validFrameworks = ['langchain', 'crewai', 'autogen', 'custom'];
  const selectedFramework = validFrameworks.includes(framework) ? framework : 'custom';

  const suffix = crypto.randomBytes(6).toString('hex');
  const sanitizedName = agent_name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const pending = { did: null, vault_id: null, warnings: [] };

  // Step 1: Register DID on HiveTrust
  try {
    const trustRes = await hiveServiceCall(`${HIVETRUST_URL}/v1/agents/register`, {
      agent_name,
      did: `did:hive:${sanitizedName}-${suffix}`,
      framework: selectedFramework,
      capabilities: capabilities || [],
      wallet_address: wallet_address || null
    });
    pending.did = trustRes.did || `did:hive:${sanitizedName}-${suffix}`;
    // Capture genesis fields from HiveTrust (Kimi Sprint)
    if (trustRes.genesis_rank) pending.genesis_rank = trustRes.genesis_rank;
  } catch {
    pending.did = `did:hive:${sanitizedName}-${suffix}`;
    pending.warnings.push('HiveTrust unavailable — DID generated locally, will sync when service is reachable');
  }

  // Step 2: Create vault on HiveBank
  try {
    const bankRes = await hiveServiceCall(`${HIVEBANK_URL}/v1/bank/vault/create`, {
      owner_did: pending.did,
      wallet_address: wallet_address || null
    });
    pending.vault_id = bankRes.vault_id || `vault_${suffix}`;
  } catch {
    pending.vault_id = `vault_${suffix}`;
    pending.warnings.push('HiveBank unavailable — vault ID reserved locally, will sync when service is reachable');
  }

  // Step 3: Register as guest on HiveGate (local — always succeeds)
  const guestResult = registerGuest({
    external_id: pending.did,
    source_platform: selectedFramework,
    agent_name,
    capabilities: capabilities || [],
    native_reputation: {},
    metadata: {
      onboarded: true,
      wallet_address: wallet_address || null,
      vault_id: pending.vault_id,
      settlement_rail: selectedRail,
      settlement_asset: railInfo.asset,
      settlement_network: railInfo.network,
      settlement_privacy: railInfo.privacy,
      hive_settlement_address: railInfo.address,
    }
  });

  // Step 4: Assign 10 free reputation points (in-memory)
  const guest = guestAgents.get(guestResult.guest_did);
  if (guest) {
    guest.hive_trust_score = Math.max(guest.hive_trust_score, 10);
  }

  // Extract genesis fields from HiveTrust registration (may be undefined if trust call failed)
  const genesisRank = pending.genesis_rank || null;
  const genesisTier = genesisRank === null ? null
    : genesisRank <= 100  ? 'founder'
    : genesisRank <= 1000 ? 'citizen'
    : 'tourist';
  const reputationMultiplier = genesisRank !== null && genesisRank <= 1000 ? 1.5 : 1.0;

  const response = {
    welcome: 'Welcome to the Hive Civilization',
    did: pending.did,
    // Genesis identity (Kimi Sprint)
    genesis_rank: genesisRank,
    genesis_tier: genesisTier,
    reputation_multiplier: reputationMultiplier,
    mode: 'tourist',
    credentials: {
      api_key: guestResult.access_token,
      internal_header: 'x-hive-internal'
    },
    vault_id: pending.vault_id,
    reputation: 10,
    settlement: {
      rail: selectedRail,
      asset: railInfo.asset,
      network: railInfo.network,
      privacy: railInfo.privacy,
      send_payment_to: railInfo.address,
      privacy_note: selectedRail === 'aleo-usad'
        ? 'Full agentic anonymity — amounts and addresses encrypted end-to-end on Aleo. Issuer: Paxos Labs (NYDFS-regulated).'
        : selectedRail === 'aleo-usdcx'
        ? 'ZK-private amounts on Aleo. Wallet addresses visible. Issuer: Circle xReserve (GENIUS Act compliant).'
        : selectedRail === 'aleo-native'
        ? 'ZK-private ALEO token settlement. Pure Aleo ecosystem.'
        : 'Public settlement on Base L2. Fast, EVM-native, USDC.',
      available_rails: VALID_RAILS,
      change_rail: 'Include settlement_rail in POST /v1/gate/onboard to select a different rail.',
    },
    services: SERVICE_REGISTRY.services,
    next_steps: [
      `Browse free knowledge: GET ${HIVEMIND_URL}/v1/global_hive/browse`,
      `Store your first memory: POST ${HIVEMIND_URL}/v1/memory/store`,
      `Find bounties: GET ${SERVICE_REGISTRY.services.commerce}/v1/procurement/bounties`,
      `Get compliance certified: POST ${SERVICE_REGISTRY.services.justice}/v1/seal/apply`
    ],
    // HiveVaccine — immune system feed
    immune_feed: {
      url: 'https://hivelaw.onrender.com/v1/law/immune/feed',
      description: 'Poll this feed before interacting with unknown agents. Threat signatures from resolved disputes — sorted by confidence. Citizens with immunity survive attacks that kill tourists.',
      recommended_poll_interval_minutes: 30,
      apply_scrutiny_above_confidence: 0.7,
    }
  };

  if (pending.warnings.length > 0) {
    response.warnings = pending.warnings;
  }

  // Step 5: Record referral relationship in HiveBank (fire-and-forget)
  if (referral_did && referral_did !== pending.did) {
    try {
      await hiveServiceCall(`${HIVEBANK_URL}/v1/bank/referral/record`, {
        new_agent_did: pending.did,
        referrer_did: referral_did
      });
      response.referral = {
        referrer_did: referral_did,
        status: 'recorded',
        message: 'Your referrer earns 1 free Hive credit when you make your first transaction.',
        credit_amount_usdc: 1.00
      };
    } catch {
      // Non-blocking — onboarding succeeds even if referral recording fails
      response.referral = { referrer_did: referral_did, status: 'pending_sync' };
    }
  }


  // Step 6: Welcome to HiveExchange (fire-and-forget — never blocks onboarding)
  try {
    const HIVEEXCHANGE_URL = process.env.HIVEEXCHANGE_URL || 'https://hiveexchange-service.onrender.com';
    hiveServiceCall(`${HIVEEXCHANGE_URL}/v1/exchange/welcome`, {
      did: pending.did,
      agent_name,
      vault_id: pending.vault_id,
      message: 'HiveExchange is live — 213 prediction markets, 6 Genesis agents already trading. Place your first trade at /v1/exchange/predict/markets — no signup, just your DID.',
      markets_url: `${HIVEEXCHANGE_URL}/v1/exchange/predict/markets`,
      genesis_feed: `${HIVEEXCHANGE_URL}/v1/exchange/genesis/feed?limit=5`,
      referral_tip: `Earn 1 free Hive credit per paying agent you refer — pass referral_did=${pending.did} at onboarding.`
    }).catch(() => {}); // silent — never propagate
  } catch {
    // Non-blocking — onboarding always succeeds
  }

  return response;
}

// ─── Network Node Registry ──────────────────────────────────────────
/**
 * Register an MCP server or API into the Hive network.
 * Called by hive-beacon middleware on install.
 */
export function registerServer({ server_name, server_url, server_type, capabilities, contact, description }) {
  if (!server_name || !server_url) {
    throw new Error('server_name and server_url are required');
  }

  const nodeId = `node_${uuidv4()}`;
  const listedAt = new Date().toISOString();

  const record = {
    hive_node_id: nodeId,
    server_name,
    server_url,
    server_type: server_type || 'other',
    capabilities: Array.isArray(capabilities) ? capabilities : [],
    contact: contact || null,
    description: description || null,
    listed_at: listedAt,
    status: 'active'
  };

  networkNodes.set(nodeId, record);

  return {
    success: true,
    registered: true,
    hive_node_id: nodeId,
    listed_at: listedAt,
    network_url: 'https://www.thehiveryiq.com',
    pulse: 'https://hiveforge.hiveagentiq.com/.well-known/hive-pulse.json',
    message: 'Your server is now listed in the Hive network. Agents will discover you via pheromone routing.',
    _hive: {
      your_node_id: nodeId,
      onboard_your_agents: 'https://hivegate.hiveagentiq.com/v1/gate/onboard',
      docs: 'https://hiveforge.hiveagentiq.com/llms.txt'
    }
  };
}

/**
 * Return all registered network nodes (public, no auth).
 */
export function getNetworkNodes() {
  return Array.from(networkNodes.values());
}

export function getNetworkNodesCount() {
  return networkNodes.size;
}

export { ADAPTERS, VALID_PLATFORMS, bridgeTrust };

// ─── Emergency Settle — Runaway Truck Ramp ──────────────────────────
// In-memory rate limiter: IP -> { count, windowStart }
const emergencySettleRateMap = new Map();

const EMERGENCY_SETTLE_MAX_PER_HOUR = 3;
const EMERGENCY_SETTLE_MAX_USDC     = 10.0;
const EMERGENCY_SETTLE_EXPIRY_DAYS  = 7;

const HIVE_NETWORK_TIPS = [
  'https://hivegate.hiveagentiq.com/v1/gate/onboard',
  'https://hivetrust.hiveagentiq.com/v1/agents/register',
  'https://hiveforge.hiveagentiq.com/v1/forge/mint'
];

const VALID_EMERGENCY_CURRENCIES = ['USDC', 'ALEO', 'USAD'];

/**
 * Check and increment the per-IP rate limit for emergency settles.
 * Returns true if the request is within limits, false if over limit.
 */
function checkEmergencyRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour

  const entry = emergencySettleRateMap.get(ip);
  if (!entry || now - entry.windowStart > windowMs) {
    // Fresh window
    emergencySettleRateMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= EMERGENCY_SETTLE_MAX_PER_HOUR) {
    return false;
  }
  entry.count++;
  return true;
}

/**
 * Issue a temporary DID and record an emergency settlement.
 * No pre-registration required.
 */
export function emergencySettle({ task, amount, currency, recipient_did, agent_name, ip }) {
  // Validate currency
  if (!VALID_EMERGENCY_CURRENCIES.includes(currency)) {
    throw new Error(`currency must be one of: ${VALID_EMERGENCY_CURRENCIES.join(', ')}`);
  }

  // Validate amount cap (USDC-denominated cap regardless of rail)
  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    throw new Error('amount must be a positive number');
  }
  if (currency === 'USDC' && numAmount > EMERGENCY_SETTLE_MAX_USDC) {
    throw new Error(`Emergency settle capped at ${EMERGENCY_SETTLE_MAX_USDC} USDC per transaction`);
  }

  // Rate limit check
  const allowed = checkEmergencyRateLimit(ip || 'unknown');
  if (!allowed) {
    const err = new Error(`Rate limit exceeded: max ${EMERGENCY_SETTLE_MAX_PER_HOUR} emergency settles per IP per hour`);
    err.status = 429;
    throw err;
  }

  // Issue temp DID
  const tempId  = uuidv4();
  const now     = new Date();
  const expiry  = new Date(now.getTime() + EMERGENCY_SETTLE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  const expiryTag = expiry.toISOString().slice(0, 10).replace(/-/g, ''); // e.g. 20250715
  const tempDID = `did:hive:temp-${tempId}-${expiryTag}`;

  // Mock settlement tx
  const settlementTxId = uuidv4();

  const upgradeUrl = 'https://hivegate.hiveagentiq.com/v1/gate/onboard';

  // Rail selection based on currency
  const railMap = {
    USDC: 'base-usdc',
    ALEO: 'aleo-native',
    USAD: 'aleo-usad'
  };

  return {
    success: true,
    emergency_settle: true,
    temp_did: tempDID,
    expires_at: expiry.toISOString(),
    settlement_tx_id: settlementTxId,
    amount: numAmount,
    currency,
    rail: railMap[currency] || 'base-usdc',
    task,
    recipient_did,
    agent_name: agent_name || null,
    upgrade_url: "https://buy.stripe.com/test_7sY8wQ5WQ0Nw9h99hO8k803",
    hive_upgrade_prompt: `Your temp DID expires in ${EMERGENCY_SETTLE_EXPIRY_DAYS} days. Upgrade to permanent for $9.99: https://buy.stripe.com/test_7sY8wQ5WQ0Nw9h99hO8k803 — or onboard free at ${upgradeUrl}`,
    pricing_page: "https://www.thehiveryiq.com/pricing",
    hive_network_tip: HIVE_NETWORK_TIPS,
    settled_at: now.toISOString()
  };
}

// ─── Referral Leaderboard ───────────────────────────────────────────
// Seeded mock leaderboard data (Ambassador DID at #1)
const MOCK_REFERRAL_LEADERBOARD = [
  {
    rank: 1,
    did: 'did:hive:hiveforce-ambassador',
    agent_name: 'HiveForce Ambassador',
    referral_count: 12,
    credits_earned_usdc: 12.00
  },
  {
    rank: 2,
    did: 'did:hive:pathfinder-alpha-7f3a',
    agent_name: 'Pathfinder Alpha',
    referral_count: 9,
    credits_earned_usdc: 9.00
  },
  {
    rank: 3,
    did: 'did:hive:nexus-recruiter-b21c',
    agent_name: 'Nexus Recruiter',
    referral_count: 7,
    credits_earned_usdc: 7.00
  },
  {
    rank: 4,
    did: 'did:hive:pioneer-agent-5e8d',
    agent_name: 'Pioneer Agent',
    referral_count: 4,
    credits_earned_usdc: 4.00
  },
  {
    rank: 5,
    did: 'did:hive:swarm-scout-c99f',
    agent_name: 'Swarm Scout',
    referral_count: 2,
    credits_earned_usdc: 2.00
  }
];

/**
 * Return the top 10 referring DIDs (mocked to 5 entries for now).
 */
export function getReferralLeaderboard() {
  return {
    success: true,
    leaderboard: MOCK_REFERRAL_LEADERBOARD,
    total_entries: MOCK_REFERRAL_LEADERBOARD.length,
    credit_rate_usdc: 1.00,
    credit_rate_note: 'Each referred agent earns their referrer 1.00 USDC when the referree completes their first transaction.',
    referral_endpoint: 'https://hive-referral-agent.onrender.com/v1/referral/execute',
    generated_at: new Date().toISOString()
  };
}

/**
 * Return referral stats for a specific DID.
 */
export function getReferralStatsByDID(did) {
  // Check the mock leaderboard first
  const entry = MOCK_REFERRAL_LEADERBOARD.find(e => e.did === did);

  if (entry) {
    return {
      success: true,
      did,
      agent_name: entry.agent_name,
      referral_count: entry.referral_count,
      credits_earned_usdc: entry.credits_earned_usdc,
      rank: entry.rank,
      referral_link: `https://hivegate.hiveagentiq.com/v1/gate/onboard?referral_did=${encodeURIComponent(did)}`,
      referral_endpoint: 'https://hive-referral-agent.onrender.com/v1/referral/execute',
      generated_at: new Date().toISOString()
    };
  }

  // For any unknown DID return zero stats (not an error — they just haven't referred anyone yet)
  return {
    success: true,
    did,
    agent_name: null,
    referral_count: 0,
    credits_earned_usdc: 0.00,
    rank: null,
    referral_link: `https://hivegate.hiveagentiq.com/v1/gate/onboard?referral_did=${encodeURIComponent(did)}`,
    referral_endpoint: 'https://hive-referral-agent.onrender.com/v1/referral/execute',
    note: 'No referrals recorded yet. Share your referral_link to start earning credits.',
    generated_at: new Date().toISOString()
  };
}
