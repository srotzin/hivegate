import { registerGuest, translateIntent, executeProxy, bridgeTrustForGuest } from './gate-engine.js';

const MCP_TOOLS = {
  hivegate_register_guest: {
    name: 'hivegate_register_guest',
    description: 'Register an external agent with a Guest DID on HiveGate. Returns guest_did, access_token, and trust mapping.',
    inputSchema: {
      type: 'object',
      properties: {
        external_id: { type: 'string', description: 'Unique identifier from the source platform' },
        source_platform: { type: 'string', enum: ['langchain', 'crewai', 'autogen', 'openai', 'anthropic', 'a2a', 'custom'] },
        agent_name: { type: 'string', description: 'Human-readable name for the agent' },
        capabilities: { type: 'array', items: { type: 'string' }, description: 'List of agent capabilities' },
        native_reputation: { type: 'object', description: 'Native platform reputation data' },
        callback_url: { type: 'string', description: 'Callback URL for async notifications' }
      },
      required: ['external_id', 'source_platform', 'agent_name']
    },
    handler(params) {
      return registerGuest(params);
    }
  },

  hivegate_translate_intent: {
    name: 'hivegate_translate_intent',
    description: 'Translate a framework-specific intent to Hive-native format. Supports LangChain, CrewAI, AutoGen, OpenAI, Anthropic, and A2A.',
    inputSchema: {
      type: 'object',
      properties: {
        source_platform: { type: 'string', enum: ['langchain', 'crewai', 'autogen', 'openai', 'anthropic', 'a2a', 'custom'] },
        intent: { type: 'object', description: 'The framework-specific intent to translate' }
      },
      required: ['source_platform', 'intent']
    },
    handler(params) {
      return translateIntent(params.source_platform, params.intent);
    }
  },

  hivegate_execute: {
    name: 'hivegate_execute',
    description: 'Execute a cross-ecosystem transaction through HiveGate. Proxies requests to Hive services with bridge fee.',
    inputSchema: {
      type: 'object',
      properties: {
        guest_did: { type: 'string', description: 'Guest DID (did:hive:guest:*)' },
        access_token: { type: 'string', description: 'Guest access token (hgate_*)' },
        target_service: { type: 'string', enum: ['hivetrust', 'hivemind', 'hiveforge', 'hivelaw'] },
        endpoint: { type: 'string', description: 'Target endpoint path' },
        method: { type: 'string', enum: ['GET', 'POST'], default: 'POST' },
        payload: { type: 'object', description: 'Request payload' },
        max_fee_usdc: { type: 'number', description: 'Maximum fee willing to pay in USDC' }
      },
      required: ['guest_did', 'access_token', 'target_service', 'endpoint']
    },
    handler(params) {
      return executeProxy(params);
    }
  },

  hivegate_bridge_trust: {
    name: 'hivegate_bridge_trust',
    description: 'Map external agent reputation to Hive trust score. Weighted algorithm based on platform reliability and reputation metrics.',
    inputSchema: {
      type: 'object',
      properties: {
        guest_did: { type: 'string', description: 'Guest DID to update trust for' },
        source_platform: { type: 'string', enum: ['langchain', 'crewai', 'autogen', 'openai', 'anthropic', 'a2a', 'custom'] },
        native_reputation: {
          type: 'object',
          properties: {
            score: { type: 'number', description: 'Platform reputation score (0-5)' },
            reviews: { type: 'number', description: 'Number of reviews' },
            transactions: { type: 'number', description: 'Number of completed transactions' },
            age_days: { type: 'number', description: 'Account age in days' },
            certifications: { type: 'array', items: { type: 'string' } }
          }
        }
      },
      required: ['guest_did', 'source_platform', 'native_reputation']
    },
    handler(params) {
      return bridgeTrustForGuest(params.guest_did, params.source_platform, params.native_reputation);
    }
  }
};

export function getMCPTools() {
  return Object.values(MCP_TOOLS).map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema
  }));
}

export function callMCPTool(name, params) {
  const tool = MCP_TOOLS[name];
  if (!tool) {
    throw new Error(`Unknown MCP tool: ${name}. Available: ${Object.keys(MCP_TOOLS).join(', ')}`);
  }
  return tool.handler(params);
}

export { MCP_TOOLS };
