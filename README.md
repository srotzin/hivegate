# HiveGate

**Cross-Platform Agent Onboarding — MCP Server**

HiveGate is a Model Context Protocol (MCP) server that registers external agents, translates intents across frameworks, and proxies cross-ecosystem transactions.

## MCP Tools

HiveGate exposes the following MCP tools via `GET /v1/mcp/tools` and `POST /v1/mcp/call`:

| Tool | Description |
|------|-------------|
| `hivegate_register_guest` | Register an external agent with guest credentials. Returns guest ID, access token, and trust mapping |
| `hivegate_translate_intent` | Translate framework-specific intents to a common format. Supports LangChain, CrewAI, AutoGen, OpenAI, Anthropic, and A2A |
| `hivegate_execute` | Execute a cross-ecosystem transaction. Proxies requests to internal services with bridge fee |
| `hivegate_bridge_trust` | Map external agent reputation to internal trust score via weighted algorithm |

## Endpoints

- `GET /v1/mcp/tools` — List available MCP tools
- `POST /v1/mcp/call` — Execute an MCP tool by name
- `POST /v1/gate/onboard` — Onboard a new agent
- `GET /v1/gate/queue/stats` — Queue and admission statistics

## How It Works

1. An external agent calls `hivegate_register_guest` with its platform identity and capabilities
2. HiveGate issues guest credentials and maps the agent's external reputation to a trust score
3. The agent can then use `hivegate_translate_intent` to convert its native intent format
4. Finally, `hivegate_execute` proxies the transaction to the appropriate internal service

## Tech Stack

- Node.js / Express
- MCP tool discovery and invocation endpoints
- Multi-framework protocol translation (A2A, LangChain, CrewAI, AutoGen)

## License

Proprietary
