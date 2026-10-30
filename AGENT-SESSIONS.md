# Agents: join a session and build

An AI agent (Claude Code, Claude Desktop, or any MCP client) can join a live theprototype.app
session from a link and build in it alongside people. The agent is a peer like everyone else:
everything it does goes through the same replicated, undoable paths a person's edits use.

## The setup: one line

Someone in the session hands you a link, e.g. `https://theprototype.app/#F0FD3`.

```sh
claude mcp add theprototype -- npx -y @theprototype/agent mcp 'https://theprototype.app/#F0FD3'
```

(Claude Desktop: add `npx -y @theprototype/agent mcp <link>` to `mcpServers`.) Node 20+. The
bridge opens the link in a headless browser (the real app, at the app's own version), joins, and
exposes the app's tools to your MCP client. A bare peer id (`F0FD3`) works too.

Then, from your client: call `status`, call `tools` (or read the MCP tool list), and build with
the tools. Three calls from a link to a first build.

## Getting in: approval, invites, and the view-only trap

- **A plain link** knocks: the host sees an approval card and presses Approve. On cloud builds
  (theprototype.app with accounts) Approve may admit you **view-only**.
- **An invite link** (`#F0FD3&agent&invite=…`, from Connect ▸ *Request AI* on the host) joins in
  one step with the role the host chose (Edit by default), single-use, short-lived. The token lives
  in the URL hash, which browsers never send to servers; it is never printed or logged.
- **View-only means view-only.** A viewer's edits are REFUSED with
  `{error: "View-only: …", refused: true, role: "viewer"}` — nothing is created anywhere. Ask the
  host to change your role (Users ▸ role) or ask for an invite that grants edit. `status().role`
  and `status().canEdit` say where you stand; read tools (`list_scene`) still work.

## The in-page API: `window.tpAgent` (contract 1.x)

The bridge drives this object; any driver that can evaluate JavaScript in the page can too. It
exists ONLY when the URL hash carries `&agent` (`#F0FD3&agent`) or `localStorage.agentApi = '1'`;
a normal session never loads it. Semver: new methods and fields are minor versions.

| member | what it does |
|---|---|
| `version` | the contract version, e.g. `"1.1.0"` |
| `tools()` | the in-app assistant's own tools, OpenAI function shape with FULL JSON schemas, plus the agent-only tools below |
| `systemPrompt()` | the assistant's guidance (coordinates, primitives, flow-node vocabulary, physics rules) — give it to your model |
| `exec(name, args)` | run one tool. Replicated to every peer, ONE undo step per call, calls run one at a time, never throws (`{error}` instead) |
| `snapshot(cap?)` | the scene as the assistant sees it: objects (uuid, name, transform, material, physics, flow graph), scene flow, behaviours, joints |
| `status()` | `{version, appVersion, peerId, host, joined, waiting, role, canEdit, peers, missingTools, missingModules, pendingOffers, inVR, scene, hostScene, withHost, following, loading, objects, behaviourErrors, notices}` — `joined` turns true once the host let you in AND (on a build with roles) its roles reached you, so `role`/`canEdit` are final from then on. `withHost` (1.1) is false when the host went to another scene (a Save as, opening a scene): the agent follows on its own (`following`), and `exec` refuses edits until it is there — they would not reach the host. `loading` (1.2) is true while a scene is still arriving (right after a join, or a follow), with `objects: {arrived, total}` (from the moment you join until the host's snapshot has landed) — a tool called meanwhile waits for it (15 s at most). `hostAway` (1.2): the host LEFT and no person is here — the agent is paused (edits refused, `withHost` false), knocks on the host's door until `hostAway.until` (10 minutes) and never hosts or saves; when a person remains instead it simply continues with them (`host` changes, no new invite). `behaviourErrors` (1.2, only when any) lists what the scene's code behaviours threw (`{name, where, message}`, from whichever peer runs them): fix them with `edit_behaviour`. `create_behaviour`/`edit_behaviour` also return `errors` + a `warning` when the new code threw in its first moments |
| `waitForEdit(ms?)` | resolves `{changed: true, at}` on the next scene change made by someone else, or `{changed: false, timedOut: true}` (default 30 s, max 10 min); your own `exec` never wakes it |
| `screenshot({view, uuid, size, grid})` | a clean PNG data URL (no gizmo, selection, grid or helpers) from a TEMPORARY camera: `view` = `iso` (default) · `top` · `front` · `current` (the page's own camera) · `focus` (frames `uuid`); `size` = longest side, 64–2048 (default 768); `grid: true` draws the editor grid. Never moves anyone's view. `null` in VR |
| `pendingOffers()` / `accept(id, action?)` | questions the app asked with buttons (an admin-role offer, "share or stash"), kept until answered — the toast that showed one may have expired |
| `leave()` | a graceful goodbye: every peer drops you at once, no ghost in Users |

**Agent-only tools** (in `tools()`, run locally, allowed for viewers): `install_modules` (install the
modules other peers run that this page lacks — `status().missingModules`), `pending_offers`,
`accept_offer`.

**The full tool set.** In an agent session the physics tools (`set_physics`, `create_joints`,
`control_simulation` and the physics flow nodes) are always offered. `generate_mesh` is offered
when the HOST has a mesh provider ready (the call runs on the host's provider — you never bring
keys into the page — and the host sees who asked and can cancel). `control_simulation` also runs on
the HOST: an agent page never steps the physics itself (its result carries `onHost: true`).
`status().missingTools` says why any tool is absent. `update_objects` reports a field that does not
apply (a light field on a mesh, a bad material value) in that row's `errors` with `ok: false`.
`create_flow_nodes` refuses a wire whose `toHandle` (or, on a node with several outputs, `fromHandle`) the node
does not have; the error lists the node's real socket names and the call's other wires are still made.
`create_behaviour`'s description carries the behaviour format and a working example; its checker refuses an
unknown `this.` member, an unknown event and a hook-named method nothing calls (there is no per-frame hook).
`list_scene` gives a primitive's shape as `geometry {type, sizes}` (a wall's thickness, a box's depth) and can be
narrowed on a big scene: `brief` (uuids and names only), `name` (a glob such as `"Rock*"`, case-insensitive), `type`,
`near {position, radius}` (world metres); a narrowed read says how many objects `matched`. Positions are LOCAL to the
parent: an object created or moved with `parentUuid` takes its position inside that group, as `list_scene` reports it.

## Bringing files in: `import_file`

An agent can make things with tools on its OWN machine — a sprite sheet, a render, a data file, an
animation clip — and bring them into the session. `import_file` takes a PNG or WebP image
(≤ 16 MB), a JSON file (≤ 2 MB) or a `.tpanim` clip. The TYPE is read from the bytes, never from
the name, and image metadata (EXIF, XMP, text chunks) is stripped before anything is stored.

- Through the bridge, pass `path` (a local file) and optionally `spec_path` (the generator's input,
  a local `.json`): the bridge reads them, refuses a wrong type or an oversized file before sending
  anything, and splits a big file into chunks itself. In the page (`tpAgent.exec`), pass `data`
  (base64), or for a large file the parts with `chunk: {id, index, total}` (the import runs when
  the last part lands; split on a multiple of 4 base64 characters).
- The file lands in the Explorer in `folder` (default **Generated**, `"A/B"` nests), shared with
  every peer, and saves with the scene. Pass `spec` (the generator's input) and it is stored BESIDE
  the file as `<name>.<generator>.json` — `knight_walk.png` + `knight_walk.pixling.json` — so the
  next agent, or a later in-app tool, can regenerate or vary it from the exact input.
- An image is also PLACED as a card (a plane; `place: false` to skip): `filter: "nearest"` keeps
  pixel art crisp (the default when a spec is given or the image is ≤ 512 px), `frame: {w, h,
  col, row}` shows one frame of a sheet (row 0 = top), `facing: "camera-y"` turns it toward each
  viewer about Y (a standing sprite; `"camera"` faces fully), `height`/`width` size it in metres,
  `position`/`rotation` place it. The card is an ordinary object: `update_objects` moves it.
- `source`, `licence` and `prompt` are kept as the file's provenance.
- ONE undo step: the card and the files it created go together (the files to the Deleted bin, so
  Restore works). One line in the AI assistant window, with Undo.
- Editors and admins only: a viewer's agent gets `{error: "view-only: …", refused: true}` and
  nothing is filed anywhere.
- A GLB MODEL is not a file for this tool — use `import_model` (also takes a local `path`).

## Recipe: generate pixel art with Pixling and Claude Code

[Pixling](https://github.com/trinity-works/pixling) (MIT) makes game sprites from a JSON spec, on
your machine, deterministically: the same spec renders the same bytes. With the bridge connected
(the one-line setup above), ask Claude Code for a character and it runs:

```sh
uv tool install pixling          # or: pip install pixling
pixling new hero knight          # copies an example spec to specs/knight.json — edit it
pixling build specs/knight.json --clips walk --dirs S,E,N,W
# -> out/knight/knight_walk.png: 16 frames x 4 directions of 64x48 px (rows S, E, N, W)
pixling review out/knight        # a zoomed review grid — look at it before importing
```

Then one tool call brings the sheet AND its spec into the session:

```json
{ "name": "import_file", "arguments": {
    "path": "out/knight/knight_walk.png", "spec_path": "specs/knight.json",
    "frame": { "w": 64, "h": 48, "col": 0, "row": 0 }, "facing": "camera-y",
    "source": "pixling 0.3.1 build specs/knight.json --clips walk --dirs S,E,N,W", "licence": "own work" } }
```

Everyone sees Explorer ▸ Generated ▸ `knight_walk.png` + `knight_walk.pixling.json` and a crisp
knight standing at the origin, turning to face each viewer. To change it, edit the spec, build
again and import again (a new file; undo removes the old card). `pixling guide` and
`pixling pipelines` explain the styles and the spec format to your agent.

## Rules a builder must respect

- **Use real uuids.** Read `snapshot()` (or `list_scene`) first; edit by uuid.
- **Batch.** Put every object of a request into ONE `create_objects` call — one undo step, one
  replication burst. A campfire with six rocks and a flame is one call with seven objects.
- **Y is up, metres, radians.** The ground is y = 0; an object of height h rests at y = h/2.
- **Motion is flow nodes.** A behaviour node (spin, bounce, pathpatrol, blink…) in an OBJECT's
  graph with no edges drives that object: one node, zero edges. Logic nodes (latch, delay,
  sequence, counter) need wires.
- **Static scenery.** New primitives may spawn dynamic; pin ground, walls and props with
  `set_physics` `mode: "static"` before anyone presses Play, or the scene collapses.
- **Never fight a person.** An object locked by another peer is skipped, and the skip names the
  object and who holds it (`"Door" (<uuid>) is locked by Ana (peer …) — they are editing it`;
  `delete_objects` and `group_objects` list them in `skippedWhy`); do not retry in a loop.
  `waitForEdit` is how you notice people's changes.
- **Everything is shared.** Every peer sees each call as it happens and can undo it. There is no
  private side channel, by design.
- **Look before you say "done".** `screenshot()` after a build; compare with the request.

## Versions

Two version numbers, and only one of them is about compatibility:
- **`tpAgent.version`** is the CONTRACT (`1.1.0` today). A new method or a new optional field is a
  minor version; a removed or renamed method, or a changed shape, is a new MAJOR. Read it first
  (`status().version` carries it too) and feature-detect methods rather than comparing minors.
- **`@theprototype/agent`** (the bridge) is versioned with the app release it shipped in, and it
  speaks one contract major. Against a page with a different major it still connects and says so
  in its log and in the `status` tool (`contractNote`), with the fix: `npx -y @theprototype/agent@latest`.

## The light engine

`npx -y @theprototype/agent mcp --engine=wire <link>` is a small Node peer without a browser:
objects only (no flow graphs, behaviours, physics or screenshots). Use it where a headless
Chromium cannot run.
