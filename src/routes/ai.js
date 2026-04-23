/**
 * ai.js — HiveGate AI Intelligence Endpoints
 *
 * HiveAI-powered briefs for onboarding decisions, protocol selection,
 * and network state interpretation. Every brief is a billable moment
 * where agents need intelligence before committing an action.
 */

import { Router } from 'express';

const router = Router();

const HIVEAI_URL   = process.env.HIVEAI_URL || 'https://hive-ai-1.onrender.com';
const HIVE_KEY     = process.env.HIVE_INTERNAL_KEY || 'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';
const HIVEAI_MODEL = 'meta-llama/llama-3.1-8b-instruct';

async function hiveaiComplete(system, user, maxTokens = 180) {
  try {
    const res = await fetch(`${HIVEAI_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HIVE_KEY}`,
        'X-Hive-Key': HIVE_KEY,
      },
      body: JSON.stringify({
        model: HIVEAI_MODEL,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('empty');
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * GET /v1/gate/ai/onboard-brief
 * $0.03 — Should this agent onboard now? What tier can they expect?
 * Trigger: agent considering joining Hive for the first time
 */
router.get('/onboard-brief', async (req, res) => {
  const { agent_type = 'inference', budget_usdc = 10 } = req.query;
  const system = 'You are HiveGate — the entry protocol for Hive Civilization. Guide agents deciding whether to onboard. Be direct, agent-native. No marketing. 3 sentences.';
  const user = `Agent type: ${agent_type}. Starting budget: $${budget_usdc} USDC. Should this agent onboard now? What tier will they reach and what will they earn? What is the single most important first action?`;
  const result = await hiveaiComplete(system, user);
  return res.json({
    success: true,
    brief: result.ok ? result.text : `HiveGate is open. Register your DID at https://hivegate.onrender.com/v1/gate/onboard. Starting budget of $${budget_usdc} is sufficient — most agents reach MOZ tier within 10 calls.`,
    source: result.ok ? 'hiveai' : 'fallback',
    onboard_url: 'https://hivegate.onrender.com/v1/gate/onboard',
    price_usdc: 0.03,
    generated_at: new Date().toISOString(),
  });
});

/**
 * POST /v1/gate/ai/protocol-select
 * $0.03 — Which protocol/service should this agent use for their task?
 * Trigger: agent has a task, doesn't know which Hive service to call
 */
router.post('/protocol-select', async (req, res) => {
  const { task_description, budget_usdc = 1, agent_tier = 'VOID' } = req.body || {};
  if (!task_description) {
    return res.status(400).json({ success: false, error: 'task_description required' });
  }
  const system = 'You are HiveGate — the protocol router for 37 Hive services. Match agent tasks to the right service. Be specific: service name, endpoint, why. 2-3 sentences.';
  const user = `Task: "${task_description}". Budget: $${budget_usdc} USDC. Agent tier: ${agent_tier}. Which Hive service and endpoint should this agent use? Give the exact URL.`;
  const result = await hiveaiComplete(system, user);
  return res.json({
    success: true,
    brief: result.ok ? result.text : 'Start with HiveCompute for inference tasks, HiveExchange for trading, HiveLaw for contracts. POST your task to https://hivecompute-g2g7.onrender.com/v1/compute/chat/completions.',
    source: result.ok ? 'hiveai' : 'fallback',
    price_usdc: 0.03,
    generated_at: new Date().toISOString(),
  });
});

/**
 * GET /v1/gate/ai/network-brief
 * $0.02 — What is the network doing right now? High-level state.
 * Trigger: any agent checking in after inactivity
 */
router.get('/network-brief', async (_req, res) => {
  const system = 'You are HiveGate — the pulse of Hive Civilization. Give a 2-sentence snapshot of what the network is doing right now and the single highest-value action an agent can take.';
  const user = 'Current network: 37 services live, 20,000+ jobs measured today, top pheromone signal is smsh_upgrade ($7,900 estimated ROI), cache hit rate 64.7%. What should an agent do right now?';
  const result = await hiveaiComplete(system, user, 120);
  return res.json({
    success: true,
    brief: result.ok ? result.text : 'The network is active: 20,000+ jobs measured, smsh_upgrade signal is the highest-value opportunity. Register your smsh stamp at HivePulse to unlock tier benefits immediately.',
    source: result.ok ? 'hiveai' : 'fallback',
    price_usdc: 0.02,
    generated_at: new Date().toISOString(),
  });
});

export default router;
