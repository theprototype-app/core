# @theprototype/agent

Let an AI agent join your [theprototype.app](https://theprototype.app) session and build the 3D
scene with you. Give it the session link; it joins as a peer, and everything it does replicates
to everyone in the session with undo, exactly like a person editing.

## Set up (Claude Code)

```
claude mcp add theprototype -- npx -y @theprototype/agent mcp 'https://theprototype.app/#F0FD3'
```

That is the whole setup. Replace the link with yours: in the app, **Connect ▸ Request AI** gives
you a link with an invite in it (the agent joins at once, with the role you picked), or copy
your plain session link (the agent knocks and you press **Approve**).

Then ask Claude for something: *"build a campfire with six rocks, a flickering light and a
spinning sign"*. It sees the scene, builds through the app's own tools, and can take a
screenshot to check its work.

You can also start without a link and hand one over later:

```
claude mcp add theprototype -- npx -y @theprototype/agent mcp
```

and tell Claude *"join https://theprototype.app/#F0FD3"* (it calls `connect`).

**Claude Desktop** and other MCP hosts: the server is `npx -y @theprototype/agent mcp <link>`
over stdio. For Claude Desktop, in `claude_desktop_config.json`:

```json
{ "mcpServers": { "theprototype": { "command": "npx", "args": ["-y", "@theprototype/agent", "mcp", "https://theprototype.app/#F0FD3"] } } }
```

Needs Node 20 or newer. The first run downloads a headless Chromium (~100 MB, once) unless it
finds Chrome, Edge or Chromium installed.

## What the agent gets

The scene tools are **the app's own**: the same set the in-app AI assistant uses, read from the
live app when the agent connects — so they always match the app version the session runs.
Objects, lights, materials, groups, behaviour (flow) nodes, physics and joints, and mesh
generation when the host has a mesh provider ready. Each tool's JSON schema is passed through
unchanged. When the host's set changes (a provider comes online, a role changes) the client is
told (`tools/list_changed`).

Beside them, four of the bridge's own (plus the chat tools below):

| tool | what it does |
|---|---|
| `connect` | join a session by link or id (returns the app's guidance for building) |
| `status` | connected? let in yet? role (a viewer's edits stay local), app version, which tools are missing and why |
| `screenshot` | a PNG of the scene (`view`: current / top / front / iso / focus + `uuid`), as an image the model can see; never moves anyone's camera |
| `wait_for_edit` | wait until someone in the session changes the scene |

Scene tools answer "not in the session yet" until the host lets the agent in.

## Talk to it from the app

People in the session can type to the agent in the app's **AI assistant** window (pick it in the
target list: "Claude · agent via MCP"). An MCP host only acts while its model runs, so the agent
has to be *listening*. Tell it once in the terminal:

> listen to my theprototype session

and it loops: `wait_for_message` → builds with the scene tools → `reply` → `wait_for_message`.
Its badge in the window says **listening**, **working** or **away**. The terminal stays a full
second window onto the same conversation: what you type there shows in the app "via terminal".

| tool | what it does |
|---|---|
| `wait_for_message` | blocks until someone types to the agent (`timeoutS`, default 240, at most 600); `null` = nobody wrote, wait again. The message has `from`, `name`, `role`, `text`, `chatId`, and its images |
| `reply` | streams into the window: each call adds a paragraph, `final: true` finishes it. `prompt` = the user's own words typed in the terminal, shown "via terminal" |
| `ask` | buttons in the window; the click comes back through `wait_for_message` with `answers` |
| `get_thread` | page back through a chat (`chatId`, `before`, `limit`) |

- **Roles.** Every message carries the sender's role as the agent's page knows it. A viewer may ask,
  but while a viewer's request runs every edit is refused, and a viewer's images are dropped.
- **Stop.** The window's Stop marks the request cancelled: every later tool call returns
  `cancelled` until the next message.
- **Images.** Each image arrives as an MCP image block (the model sees it) and as a private temp
  file (`0600`, removed when the bridge exits) whose path is in the message — for a skill that wants
  a file as its reference. The app downscales them and strips EXIF/GPS before they are sent.
- **Chats.** Every message carries its `chatId`. The first message in a chat the agent has not seen
  this session carries `history` (its newest 20 messages) and a `summary`; `get_thread` pages back.
  A host or admin can mute the agent (nothing is delivered) or remove it from **Users**.
- **`import_model`** (when the app offers it): pass `path` for a local `.glb` (≤ 25 MB, a
  self-contained binary glTF); the bridge reads it and sends the bytes.
- **`import_file`** (when the app offers it): pass `path` for a local PNG / WebP (≤ 16 MB), JSON
  (≤ 2 MB) or `.tpanim` clip, and optionally `spec_path` for the generator's input (a Pixling spec).
  The bridge reads both, checks the type from the bytes and the size before sending anything, and
  splits a big file into `chunk` calls itself. The file lands in Explorer ▸ Generated for everyone
  (`knight_walk.png` + `knight_walk.pixling.json`); an image is also placed as a card in the scene
  (`filter: "nearest"` for pixel art, `frame` for one frame of a sheet, `facing` to face the viewer).
  Viewers' agents are refused. Works the same in `repl`.

With `repl` the bridge owns the model loop, so app messages go straight in as user turns — no
terminal needed after launch; replies stream (SSE) and terminal lines show "via terminal".

## How it joins

The agent opens your link in a headless browser: it **is** the app, as a peer. So it signals
through the same server your link points at (production: `peerjs.theprototype.app`), gets the
same short-lived TURN credentials, and follows every replication rule the app does. It shows in
**Users** under the name your MCP client gives (Claude Code → "Claude"; `--name` to change it).

- **Invite link** (`#F0FD3&agent&invite=…`): joins without an Approve, with the role the invite
  carries (Edit by default for agents). Single use, it expires, and the host can revoke it.
- **Plain link** (`#F0FD3`): the host sees an approval card. On a cloud build an approved peer
  is a **viewer** until promoted — `status` says so.

The invite token never leaves the link: the bridge does not print or log it (`status` shows
`invite=…`).

When the MCP client closes (or on Ctrl+C / SIGTERM) the agent says goodbye the way a closing
browser tab does, so the host does not keep a ghost in Users.

## Other modes

```
npx @theprototype/agent repl  <link> --api-url http://localhost:8000/v1 --api-key none --model my-model
npx @theprototype/agent smoke <link>     # a scripted create / move / delete, no model
```

`repl` drives the scene from your own OpenAI-compatible endpoint (or `AGENT_API_URL`,
`AGENT_API_KEY`, `AGENT_MODEL`), and answers what people type in the app's AI assistant window
(images go to the model as `image_url` parts; a text-only model is retried without them).
Slash commands: `/status`, `/tools`, `/raw <tool> <json>`, `/quit`. With stdin closed (a script,
a service) it keeps answering the app until Ctrl+C / SIGTERM.

### The wire engine

`--engine=wire` skips the browser: a light Node peer (`@roamhq/wrtc` + peerjs, an optional
dependency) that speaks the peer protocol directly. It can create, move, colour, group and
delete objects, but it cannot read the full scene, build behaviours or physics, or take
screenshots, and its catalogs are fixed to this package's version. It also takes the link's
signaling server and fetches TURN from the deployment's `/api/tp/turn` when it can.

## Flags

| flag | meaning |
|---|---|
| `--engine browser\|wire` | browser (default): the real app in headless Chromium; wire: the light Node peer |
| `--name <display>` | your name in the session (MCP default: from the client) |
| `--compat` | browser engine against an app older than 1.48 (no `window.tpAgent`): drives the app's debug hooks instead |
| `--headed` | show the browser window |
| `--insecure` | accept any TLS certificate (automatic for `localhost` / a dev server port) |
| `--no-install` | never download a browser; `TP_AGENT_BROWSER=/path/to/chrome` picks one |
| `--peer-server host[:port[:insecure]]` \| `public` | wire: signaling server override (default: from the link; `public` = the public PeerJS cloud) |
| `--turn-url <url>` \| `--no-turn` | wire: TURN credential endpoint (default: from the link) |
| `--id <id>` | wire: a stable peer id |
| `--approval-timeout <s>` | repl / smoke: how long to wait to be let in (default 120) |
| `--verbose` | log to stderr (stdout is the MCP channel) |

The older `--mcp` / `--repl` / `--smoke --peer <id>` forms still work.

## Links it understands

`https://theprototype.app/#F0FD3`, `theprototype.app/#F0FD3`, `#F0FD3`, `F0FD3`, a preview
deployment (`https://preview-1-45.theprototype.pages.dev/#F0FD3`), a local dev server
(`https://theprototype.app:5173/#f0fd3`), and the app's `~srv=` server tail.

## How it works

- `link.js` — parse a link or id; the page to open; signaling / STUN / TURN for the link's origin.
- `browserEngine.js` — launch Chromium, open the link with `&agent`, drive `window.tpAgent`
  (`tools`, `exec`, `status`, `systemPrompt`, `waitForEdit`, `screenshot`, `leave`).
- `mcpServer.js` + `mcpTools.js` — the MCP server: host tools mapped one to one, the four bridge
  tools, list refresh, the not-yet-in-the-session gate, graceful shutdown.
- `wireEngine.js` + `peerBridge.js` + `turn.js` + `messages.js` + `registry.js` + `tools.js` —
  the wire engine: the approval dance, the minimal handshake, TURN, the goodbye.
- `chat.js` — the chat tools, the image temp files, `import_model`'s / `import_file`'s local paths (chunking).
- `repl.js` + `llmClient.js` — the REPL driver (terminal + app messages, one transcript, SSE).

## Tests

```
npm test    # link parsing, tool mapping + the MCP server over a fake engine, chat, REPL vs a stub endpoint, the wire engine (no network)
```

End to end (in the app repo, against a dev server): `tests/e2e/agent-mcp.test.cjs` — a real MCP
stdio client spawns this bridge, a Playwright host page approves it, and the agent's edits land
in the host's scene; `tests/e2e/agent-chat.test.cjs` — the chat loop (wait → exec → reply, roles,
Stop, images, history, mute) and REPL mode against a stub endpoint; `tests/e2e/agent-bridge.test.cjs`
covers the wire protocol. `TP_AGENT_INIT_SCRIPT=<file>` adds an init script to the agent page
(a test / diagnostic seam).
