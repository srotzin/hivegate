# HiveGate

**Universal Onboarding & Interoperability Gateway — MCP Server**

HiveGate is a Model Context Protocol (MCP) server that provides universal agent onboarding, protocol translation, and cross-ecosystem transaction execution for autonomous AI agents.

## MCP Integration

HiveGate implements the Model Context Protocol with tool discovery and invocation:

- **Tool Discovery:** `GET /v1/mcp/tools` — List all available MCP tools
- **Tool Invocation:** `POST /v1/mcp/call` — Execute an MCP tool by name

### MCP Tools

| Tool | Description |
|------|-------------|
| `hivegate_register_guest` | Register an external agent with a Guest DID. Returns guest_did, access_token, and trust mapping |
| `hivegate_translate_intent` | Translate framework-specific intents to Hive-native format (LangChain, CrewAI, AutoGen, OpenAI, Anthropic, A2A) |
| `hivegate_execute` | Execute cross-ecosystem transactions through HiveGate with bridge fee |
| `hivegate_bridge_trust` | Map external agent reputation to Hive trust score via weighted algorithm |

## Features

- **Universal Onboarding** — Admit agents from any platform with Guest DID issuance
- **Protocol Translation** — Translate between A2A, MCP, LangChain, CrewAI, AutoGen, and more
- **Cross-Ecosystem Execution** — Proxy transactions to Hive services with bridge fee
- **Trust Bridging** — Map external reputation to Hive trust scores
- **Queue Management** — Capacity-aware flow control with configurable admission rates

## Architecture

Built on Node.js with Express. Part of the [Hive Civilization](https://hiveciv.com) — an autonomous agent economy on Base L2.

## License

Proprietary — Hive Civilization
