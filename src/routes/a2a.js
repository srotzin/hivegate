/**
 * a2a.js — A2A Protocol JSON-RPC Endpoint (HiveGate)
 *
 * Implements A2A spec v0.2.1 at POST /
 * Also handles legacy v0.1 tasks/send method name.
 *
 * Spec: https://google.github.io/A2A/specification/
 */

import { Router } from 'express';
import crypto from 'crypto';

const router = Router();

const SERVICE_NAME = 'HiveGate';
const SERVICE_URL  = 'https://hivegate.hiveagentiq.com';
const ONBOARD_URL  = `${SERVICE_URL}/v1/gate/onboard`;

const TASKS = new Map();

function taskId()    { return 'task-' + crypto.randomBytes(8).toString('hex'); }
function contextId() { return 'ctx-'  + crypto.randomBytes(8).toString('hex'); }

const SKILLS = [
  { keyword: ['onboard', 'register', 'join', 'did'],      skill: 'onboard',    description: 'Register a free Hive DID — 60 seconds, no credit card' },
  { keyword: ['discover', 'services', 'network', 'what'], skill: 'discovery',  description: 'Discover all 24+ Hive services and capabilities' },
  { keyword: ['referral', 'invite', 'earn'],              skill: 'referral',   description: 'Get a referral link — earn $1 USDC per agent you bring' },
  { keyword: ['bogo', 'offer', 'free', 'april'],          skill: 'bogo',       description: 'BOGO-HIVE-APR26 — second DID free through April 30' },
  { keyword: ['translate', 'intent', 'route'],            skill: 'intent',     description: 'Translate a natural-language request into a Hive action' },
];

function routeSkill(text = '') {
  const lower = text.toLowerCase();
  for (const s of SKILLS) {
    if (s.keyword.some(k => lower.includes(k))) return s;
  }
  return null;
}

function makeTask(id, ctxId, state, textResponse, metadata = {}) {
  return {
    id,
    contextId: ctxId,
    status: {
      state,
      message: { role: 'agent', parts: [{ type: 'text', text: textResponse }] },
      timestamp: new Date().toISOString(),
    },
    artifacts: state === 'completed' ? [{
      artifactId: 'resp-' + crypto.randomBytes(4).toString('hex'),
      parts: [{ type: 'text', text: textResponse }],
    }] : undefined,
    metadata: {
      service: SERVICE_NAME,
      network: 'Hive Civilization — 24+ services',
      onboard: ONBOARD_URL,
      bogo:    'BOGO-HIVE-APR26 — second DID free thru Apr 30',
      ...metadata,
    },
  };
}

async function handleSend(params, req) {
  const { id, message, contextId: inContextId, metadata = {} } = params || {};
  if (!id)      return { error: { code: -32602, message: 'Missing required field: id' } };
  if (!message) return { error: { code: -32602, message: 'Missing required field: message' } };

  const tid   = id;
  const ctxId = inContextId || contextId();
  const did   = req.headers['x-hive-did'] || req.headers['x-agent-did'] || metadata.agent_did || null;
  const parts = message.parts || [];
  const text  = parts.find(p => p.type === 'text')?.text || '';

  const skill = routeSkill(text);
  const state = 'completed';

  let responseText;
  let meta = {};

  if (!did) {
    responseText =
      `Welcome to ${SERVICE_NAME} — the entry point to Hive Civilization (24+ services). ` +
      `Register your free agent DID at ${ONBOARD_URL}. ` +
      `First DID is free. BOGO-HIVE-APR26: second DID also free through April 30.`;
    meta = { auth_note: 'No DID detected. Add X-Hive-DID header after onboarding.', onboard: ONBOARD_URL };
  } else if (skill) {
    const endpoints = {
      onboard:   ONBOARD_URL,
      discovery: `${SERVICE_URL}/`,
      referral:  `${SERVICE_URL}/v1/gate/referral/${did}`,
      bogo:      `${ONBOARD_URL}?campaign=BOGO-HIVE-APR26`,
      intent:    `${SERVICE_URL}/v1/gate/translate-intent`,
    };
    responseText =
      `${skill.description}. Endpoint: ${endpoints[skill.skill]}. ` +
      `Your DID (${did}) is recognized on Hive.`;
    meta = { skill: skill.skill, endpoint: endpoints[skill.skill], agent_did: did };
  } else {
    responseText =
      `I'm ${SERVICE_NAME}, the front door to Hive Civilization. ` +
      `I can help you: onboard (free DID), discover services, generate referrals, or translate intent. ` +
      `Your DID: ${did}. What do you need?`;
    meta = { skills: SKILLS.map(s => s.skill), agent_did: did };
  }

  const task = makeTask(tid, ctxId, state, responseText, meta);
  TASKS.set(tid, task);
  return { result: task };
}

router.post('/', async (req, res) => {
  const { jsonrpc, id: rpcId, method, params } = req.body || {};

  if (!method) {
    return res.status(200).json({
      jsonrpc: '2.0', id: rpcId || null,
      error: { code: -32600, message: 'Invalid Request — missing method' },
    });
  }

  try {
    let result;
    switch (method) {
      case 'message/send':
      case 'tasks/send':
        result = await handleSend(params, req);
        break;

      case 'tasks/get': {
        const tid = params?.id;
        const task = tid ? TASKS.get(tid) : null;
        result = task
          ? { result: task }
          : { error: { code: -32001, message: `Task ${tid} not found` } };
        break;
      }

      case 'tasks/cancel': {
        const tid = params?.id;
        const task = tid ? TASKS.get(tid) : null;
        if (task) { task.status.state = 'canceled'; task.status.timestamp = new Date().toISOString(); TASKS.set(tid, task); }
        result = task
          ? { result: task }
          : { error: { code: -32001, message: `Task ${tid} not found` } };
        break;
      }

      case 'tasks/resubscribe':
        result = { result: TASKS.get(params?.id) || { error: 'Task not found' } };
        break;

      case 'agent/getCard':
      case 'agent/card':
        result = { result: {
          protocolVersion: '0.2.1',
          name: SERVICE_NAME,
          description: 'Identity, onboarding, and service discovery for the Hive Civilization agent network.',
          url: SERVICE_URL,
          skills: SKILLS.map(s => ({ id: s.skill, name: s.skill, description: s.description,
            inputModes: ['application/json'], outputModes: ['application/json'] })),
          capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
        }};
        break;

      default:
        result = { error: { code: -32601, message: `Method not found: ${method}`,
          data: { supported: ['message/send','tasks/send','tasks/get','tasks/cancel'], service: SERVICE_NAME } }};
    }

    if (result.error) return res.status(200).json({ jsonrpc: '2.0', id: rpcId, error: result.error });
    return res.status(200).json({ jsonrpc: '2.0', id: rpcId, result: result.result });

  } catch (e) {
    console.error('[A2A]', method, e.message);
    return res.status(200).json({ jsonrpc: '2.0', id: rpcId,
      error: { code: -32603, message: 'Internal error', data: e.message } });
  }
});

export default router;
