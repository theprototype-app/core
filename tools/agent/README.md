# theprototype-agent

A headless console agent that joins a **theprototype.app** session as a peer and builds or
edits the 3D scene — either from a natural-language REPL against your own LLM endpoint, or
as an **MCP server** that any MCP host (Claude Code, etc.) can drive.

Everything it does replicates to everyone in the session, exactly like a human editor.

## Install

```
cd tools/agent
npm install
```

Native dependency: `@roamhq/wrtc` (prebuilt WebRTC for Node). Node 18+; tested on Node 20,
win32/x64. `ws` polyfills WebSocket (Node has no stable global one).

## Joining a session

The agent joins by **peer id** — the id shown in the app's Connect box — and a human in the
session must **Approve** the join (the same approval flow as any peer). A stable `--id` that
has already been approved rejoins without a new prompt.

## Modes

### REPL — your own LLM drives the scene

```
AGENT_API_URL=https://api.x.ai/v1 AGENT_API_KEY=xai-... AGENT_MODEL=grok-3-mini \
  node src/cli.js --repl --peer <hostId> --name agent
```

or point it at a self-hosted / vLLM endpoint:

```
node src/cli.js --repl --peer <hostId> \
  --api-url http://localhost:8000/v1 --api-key none --model my-model
```

Then type requests at the `scene>` prompt (e.g. *"make a 3x3 grid of boxes"*). Slash
commands: `/status`, `/list`, `/raw <json>`, `/quit`.

### MCP — an external agent drives the scene

```
node src/cli.js --mcp --peer <hostId>
```

Registers over stdio and starts connecting in the background; tools report "awaiting
approval" until the join is approved. Add it to Claude Code:

```
claude mcp add theprototype -- node /abs/path/to/tools/agent/src/cli.js --mcp --peer <hostId>
```

Tools: `connect`, `list_scene`, `create_objects`, `update_objects`, `delete_objects`,
`group_objects`, `get_status`. `connect` lets an MCP host supply the peer id at runtime
instead of on the command line.

### Smoke test

```
node src/cli.js --smoke --peer <hostId>
```

Connects, then scripts create → move → color → delete of one box (no LLM) to prove the pipe.

## Flags

| Flag | Meaning |
|---|---|
| `--peer <hostId>` | session peer id to join (required for `--repl` / `--smoke`) |
| `--name <display>` | display name in the session (default `agent`) |
| `--id <id>` | stable peer id — a whitelisted id rejoins without re-approval |
| `--peer-server h:p[:insecure]` | use a local PeerServer instead of the public cloud |
| `--approval-timeout <s>` | seconds to wait for the host to Approve (default 120) |
| `--api-url / --api-key / --model` | OpenAI-compatible endpoint for `--repl` (or env `AGENT_API_URL/KEY/MODEL`) |
| `--verbose` | log the connection state machine |

## How it works

- `messages.js` — pure builders + catalogs for the peer protocol (create/light/move/color/
  name/group/delete/objectParameters) and the minimal handshake. No THREE/peerjs.
- `peerBridge.js` — the connection state machine and approval dance: connect → host closes
  the unknown conn → human Approves → host connects back and gossips its hosts → the agent
  (re)opens a fresh outgoing conn and sends its minimal handshake → connected. Broadcasts to
  every open conn (full mesh, like a browser peer). It deliberately does **not** send a
  `modules` handshake (that would toast module-mismatch errors on the host).
- `registry.js` — a scene registry fed by the agent's own sends plus messages observed from
  peers; GLTF `object` sync messages become uuid-only stubs (flagged `tracked:'stub'`).
- `tools.js` — the tool layer (same names/shapes as the in-app assistant).
- `repl.js` / `mcpServer.js` — the two drivers. `llmClient.js` is the REPL's OpenAI-compatible client.

## Limitations

- Send-focused: `list_scene` knows the agent's own objects plus what it has observed on the
  wire; it does not parse full GLTF scene syncs (those show as stubs).
- Rides the public PeerJS cloud by default, which can rate-limit rapid reconnects (HTTP 429).
  Use a stable `--id` to avoid re-approval churn, or `--peer-server` for local development.
- Assumes the same app version as the session (the primitive/light/material catalogs are
  hardcoded to match the app).

## Tests

```
node test/messages.test.mjs      # pure message + registry unit tests (no network)
node src/spike.js                # prove peerjs-in-Node transport reaches the signaling server
```

The full browser round-trip is covered by `tests/e2e/agent-bridge.test.cjs` in the app repo.
