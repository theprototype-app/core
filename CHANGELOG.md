# Changelog

<!-- This file is rendered INSIDE the app (What's new, from the logo menu) as well as
     on GitHub, so keep entries short, human and emoji-led: one "## <version>" heading
     per release, newest first. HTML comments like this one are stripped before
     rendering, so maintainer notes stay out of the user-facing window. -->

## 1.52.0 — sessions in your Explorer 🗂️

- **The host's files in your Explorer.** Joining a session shows them as *"<Host>'s session"*, read-only, above your Library: open images, videos and text, copy any file into your Library, and **Save on host** if you can edit. Nothing downloads until you open or copy, and more than about 50 MB asks first.
- **Hosts choose what guests see.** Connect ▸ Info ▸ Guests see: Current scene's files (default), every scene on this device and shared files, Whole library or None.
- **Save project with several libraries open** asks which to save, with the active one ticked. Settings ▸ Save options ▸ *When several libraries are open* remembers your answer, and Ctrl+S follows it.
- **Save project with unsaved changes** names the scene and offers *Save scene and project*, so edits are never dropped without a word.
- **Opening a project** takes you back to the scene you had open.
- **Android keeps the extension.** `.tp` and `.tpscene` downloads no longer arrive as `.tp.zip`.
- **Review versions** always lands now, even from a minimized dock, and offers to fetch a scene this device has no copy of.
- **The AI button always opens the window.** With no provider set up it offers Connect Claude, with the two steps for the claude.ai side and a Copy link button, or your own provider.
- **Claude on claude.ai can do more in your tab:** use physics and run the simulation at full speed, whether you host or joined; animate a model's named parts; know who it acts as and see where everyone stands and looks, so "put a tree in front of me" lands in front of you, in VR too; and join a session from a link once you press Join on a card in the tab.
- **Join from a running Claude Code.** `@theprototype/agent serve --port <n>` is MCP over HTTP on this machine, with the full tool list from the start.

## 1.51.0 — characters and motion 🕺

- **Clips are their own files.** A `.tpanim` is a small clip file in the Explorer (VRM Animation inside, so it opens in
  VRM tools too). Import `.vrma`, `.bvh`, animation `.glb` or `.fbx`, then drop a clip on a character: it plays on every
  peer, the bytes travel once and the model never changes.
- **Any clip on any humanoid.** VRM, Mixamo, Meshy, UniRig, KayKit and Quaternius rigs map onto the VRM 1.0 humanoid by
  themselves (fix the map by hand if you like). *Apply clip…* fits a clip to each character's skeleton.
- **Free CC0 packs.** Characters (10 avatars) and Motion (87 clips: locomotion, jumps, sitting, swimming, combat…),
  in the Asset Browser's new Motion tab, plus an Avatars tab reading the Open Source Avatars registry.
- **VRM characters** with spring bones, expressions (a Set Expression node too) and their licence in the Inspector.
- **Game-ready clips.** In place or moving, *Loop it*, trim, split, join with a crossfade, *Extract clips* from a model;
  a Crossfade on Play Animation and a new **Blend by Speed** node, so characters stop snapping between poses.
- **Animation states.** A window per character with states and transitions. The one-click **Locomotion preset** makes
  even a fresh VRM walk, run and jump under the Player controller, filling missing clips from the Motion pack. New
  nodes: Set Animation Parameter, On Animation State.
- **Skeleton fix-ups.** Rename, move, add, delete and mirror bones; automatic weights, smoothing and a weight brush.
- **Download a character with its clips.** One GLB for Blender, Unity, Unreal and Godot (default), model + clip files,
  or the model alone; one clip as `.tpanim`, `.glb`, `.vrma` or `.bvh`.
- **Animate a model's named parts** and attach things to its sockets (Attach to Socket node); agents get the
  `animate_parts` tool.
- **Licence warnings.** Everything records where it came from. Licences that ask for credit or restrict sharing warn you
  in Download, Export and Publish, and never block.

## 1.50.0 — talk to your agent 💬

- **Chat with the AI agents in your session.** The AI assistant window lists them next to your own assistant: pick
  one and chat. Everyone in the session sees the conversation, the replies stream in, and every step the agent takes
  shows between the messages. Claude Code listens after one sentence in its terminal (*"listen to my theprototype
  session"*), what you type there shows "via terminal", and a `repl` agent answers with no terminal at all.
- **Stop, mute, roles.** Stop cancels what the agent is doing; the host can mute an agent from its peer menu. Viewers
  can ask, and the agent will not change the scene for them.
- **Pictures in AI chats.** The **+** button, paste, drop or a drag from the Explorer — shrunk and **stripped of
  location data on your device** before they are sent. *Keep in Explorer* saves one with the scene.
- **Agents bring things in.** `import_model` imports a GLB (≤ 25 MB, self-contained) as one undo step with its named
  parts and where it came from; `import_file` brings PNG / WebP / JSON / `.tpanim` files into Explorer ▸ Generated and
  places an image as a card — crisp for pixel art, one frame of a sprite sheet. New recipes: better models with
  img2threejs, pixel art with Pixling.
- **Chats are files.** Every conversation is a `.tpchat` in Explorer ▸ Scene ▸ chats, saved with the scene, private
  unless you switch on *Include when publishing*. The history icon lists them; New chat starts one; double-click a chat
  to reopen it, and the agent gets its history.
- **In VR** the AI panel talks to the same agent — type, or hold the talk button and speak.
- For developers: `tpAgent` contract 1.3.0 (`nextMessage`, `reply`, `ask`, `thread`, …); `@theprototype/agent` 1.50.0
  adds `wait_for_message`, `reply`, `ask`, `get_thread`, `import_model` and `import_file` with local paths.

## 1.49.0 — talk to Claude from claude.ai and voice 🎙️

- **The Claude connector.** Add theprototype as a connector in claude.ai (web, desktop, phone), press **Connect
  Claude** in the AI assistant of your open tab, and Claude builds there by chat or voice — with your own access.
  Every step shows in Agent activity as *Claude (connector)* with its own Undo; a viewer's Claude can look but not
  build, and locked objects stay locked. Keep the tab open and in front; **Disconnect** stops it at once, and
  Settings ▸ Connected apps lists and revokes the apps you allowed. Signed-in theprototype.app only.
- **Agents know the nodes before they wire them.** `describe_node_types` tells an agent each flow node's inputs,
  outputs and params, and `what_can_you_do` answers "what can you do here?" in a sentence you can hear; the
  connector speaks voice-first (short answers, no ids or JSON).
- For developers: `npm run catalog:agent` generates the static agent tool catalog (`tools/agent/catalog.json`) from
  the app itself, and CI fails when it is stale.

## 1.48.1 — fixes for AI agents and game logic 🔧

- **A deleted object's logic stops.** Its flow graph used to keep running on every peer until a reload (and a
  late joiner received it too). It now sleeps, and undoing the delete brings it back to life.
- **Game rounds keep their referee.** Whoever is running a kit game round stays in charge when someone new
  joins, instead of the round moving to the newcomer.
- **Agents read the scene the way you see it.** Inside a group, the positions an agent gives are local to the
  group (as list_scene reports them); list_scene shows a shape's sizes (a wall's thickness, a box's depth) and can
  be narrowed — names only, by a name pattern, by type, or near a point.
- **A locked object says who has it.** When an agent cannot change something because someone is editing it, it
  is told which object and who holds it.
- **Camera Rig:** two rigs complaining at once show one notice, naming the object.
- **Fixes from the agent test:** every light type survives an autosave restore; Body Wave and Jiggle stack on one
  object; HUD Text and Bar show wired strings; a behaviour's `on.load` sees the scene a joiner lands in and releases
  what its last run registered; deleted lights and avatar photo cards free their textures; a phone in the background
  keeps its link for a minute; a rejoin is told only live peers, and a join pulls the node graphs once; a shared Set
  Variable changes once per event in multiplayer.
- **A guest's reload goes back to the session**: reloading the tab while joined comes back on the same id and the host
  lets it straight back in, with no new approval card.

## 1.48.0 — AI agents in your session, invite links, and a people menu 🤖

Send Claude (or any AI agent) your session link and build together: the agent joins as a peer, uses the app's own
tools and shows you every step. Invite links let a friend or an agent in without an approval card, and a new menu on
every person in the Connected panel lets the host remove someone.

### 🤖 AI agents in your session

- **Join from a link**: `claude mcp add theprototype -- npx -y @theprototype/agent mcp '<link>'` adds theprototype to
  Claude Code (or any MCP client). The agent drives the real app in a headless browser — objects, flow nodes,
  physics, and 3D generation on your own provider — with the in-app assistant's own tools, read live from your app.
- **It sees what it built** through clean screenshots (no gizmos or toasts) that never move anyone's view, and it
  leaves cleanly when you close it.
- **No body, clear marks**: an agent shows as a robot with an "AI" label in Users — no character, no voice, no
  cursor — and a small camera marker shows where it last looked (Settings can hide it).
- **See where it is working**: a small bot icon with the agent's name stands over the object it is editing (or the
  spot its last screenshot looked at), on desktop and in VR. It fades while the agent is idle, hides in Play, and
  leaves with the agent; Settings ▸ Connection ▸ **Show where AI agents look** switches it off.
- **Every step in the AI assistant window**, on every peer: "Claude · created 12 objects (Campfire)". Click a line
  to select those objects; editors can Undo it.
- A view-only agent is told so instead of building things nobody else sees. llms.txt now says how an agent joins.
- **It goes where you go**: save as another name or open another scene and the agent follows; while it travels (or
  while you work in a private scene) it holds its edits, so nothing lands in a scene you left. An agent never
  becomes the host, never decides a game's rules for the people playing, and never hands you its old world when you
  open a new or another scene. Its page no longer redraws a view nobody watches, so it follows you in seconds.
- **When the host leaves**, the agent carries on with the person who takes over. If everyone has left it pauses —
  reading only, building nothing — and waits for its host (10 minutes by default), then asks to come back in.
- **The physics runs on your machine**: when an agent starts the simulation it runs on the host's page, so balls
  fall at their real speed (an agent's page used to step the world slowly for everyone).
- **Better building tools**: lights take their colour, intensity, range, cone and aim when created or updated;
  `group_objects` keeps the name you give it; sizes must be positive numbers; a field that does not apply to an
  object says so instead of reporting success; big flow graphs are read page by page (`list_scene {flow, page}`);
  `create_behaviour` returns the node's id and its inputs and outputs; a wire to a socket the node does not have
  is refused with the node's real socket names (it used to be accepted and do nothing).
- **Code behaviours explain themselves**: `create_behaviour` carries its own format and a working example (some
  clients drop the app's instructions), and the checker refuses what would silently do nothing — a `this.` member
  that does not exist (a behaviour drives effect nodes through its outputs; it does not move objects itself) or a
  per-frame hook such as `onTick` (there is none: repeat with `this.after`).
- Material parameters are validated (each key and value checked, on every peer).
- **It knows when a scene is still arriving** and **when a behaviour fails**: status reports a scene that is still
  loading (from the moment it joins), a tool called meanwhile waits for the scene first, and a code behaviour that
  throws says so with its error, so the agent can fix it instead of guessing.
- **Game-kit nodes work for AI**: the agent and the in-app assistant can now create every `kit-*` node (they were
  all "unknown"), a half-valid node batch says it was only partly applied, and hinges take an exact pivot point.

### 🔗 Invite links (Connect ▸ Request AI)

- One sheet with two tabs, **Person** and **AI agent**: pick **View** or **Edit** (cloud builds; View is the default
  for people, Edit for agents), how long it lasts (10 min / 30 min / 24 h) and how many may use it. Copy it as a
  link, a ready MCP command or one sentence for any chat.
- An invite joins with no approval card. Users lists your active invites, who used each one, and Revoke.
- AI agents never ride "Allow guests to join automatically" unless you also tick **Let AI agents join as guests**.
- The invite key lives in the link's `#` part, which browsers never send to servers, and only your app checks it.

### 👥 People menu

- Right-click (or long-press, or Shift+F10) anyone in the Connected panel: **View profile**, **Copy peer id**,
  **Go to**, **Watch**, **Show what they're editing**, **View character**, **Copy their look**, **Mute voice** and
  **Hide** (for you only). Also in VR under Tools ▸ People.
- The host (or an admin on theprototype.app) can **Remove from session** or **Remove and block** — every peer drops
  them and a re-dial is refused with "You were removed from this session"; **Allow back** in Users undoes the block.
  A removal sent by anyone else is ignored.

## 1.47.0 — Game logic in the headset, and a phone in a shared room 🥽

- 🔀 **Edit game logic in VR**: radial ▸ **Tools ▸ Logic** opens the scene's node graph as a panel in the headset, and
  **Selected ▸ Edit logic** opens the selected object's own flow. Trigger-drag a card to move it; drag from a socket to
  wire it with the laser (green while the types fit, red when they don't); drag from a wired input to pick that wire up
  and move it, or drop it on the empty graph to remove it. Click a card and its values open on a **wrist pad**: − / +
  for numbers, the VR keyboard for text, ‹ › for choices and colours, plus Rename, Unwire and Delete. **+ Node**
  adds nodes from the same groups as the desktop palette. Undo / redo, Fit, zoom (the stick) and pan work too, a grip
  carries the panel, and peers on the desktop see every edit live. Viewers get the panel read-only. Groups are
  read-only in VR, and custom, object-flow and sound nodes are still added on the desktop.
- 📱 **A phone joins a headset's room**: on an Android phone, **More ▸ Join room (AR)** (or the Play menu ▸
  **Join the room (AR)**). Tap the floor at the point the headsets calibrated on, then a point along the agreed edge
  (at least 30 cm away), and the phone sees the scene where the headsets do — same room key, same anchored objects.
  **Recalibrate** redoes the two taps. An unfolded phone's Play menu now offers **Play on a table (AR)** and **Join the room (AR)** too.

## 1.46.0 — Every panel in its own window, and files from the Code tab 🪟

Spread the editor over two monitors: pop out any panel, or a whole dock, into its own window and move tabs between
windows. And the Code tab now makes, renames, moves and deletes files and folders itself.

### 🪟 Any panel in its own window

- **Pop out any panel**: right-click a dock tab, a sidebar tab or a floating window's header ▸ **Pop out into a new
  window** — the Explorer, Properties / Configure Scene, the Node editor, Timeline, Animation, UV, Shader and HUD
  editors, the Profiler, the Debugger, Chat, the AI assistant and Code. Drag the window to any monitor; everything
  stays live. Or drag a tab out of the browser window and let go.
- **A whole dock at once**: **Pop out the whole dock** / **Pop out this sidebar** opens one window with every tab.
- **Tabs between windows**: a window with one panel shows just its name — that name is the tab: drag it, or
  right-click for **Dock back** / **Move to…**. Drop a second panel on it (or use its **+**) and a tab strip appears;
  back to one panel, the strip goes. A popped-out dock always shows its tabs (Settings ▸ Interface ▸ **Always show
  tab strip in windows** shows them everywhere).
- **One panel, one place**: adding a panel that is open somewhere else moves it there. Drag a tab onto any window's
  header, or back into the app (left sidebar, right sidebar, bottom dock — or anywhere else to put it back where it
  was).
- **Your windows come back**: reload and the windows reopen where they were (per monitor setup). If the browser blocks
  pop-ups, a bar offers **Open 2 windows** — one click per window. **Bring all windows back** (command palette, or any
  tab menu) puts everything back in the app. Closing the app's tab closes its windows.
- Desktop only — phones, touch screens and VR keep one window.

### 📁 Files from the Code tab

- Create, rename, move and delete files and folders from the Code tab (**Project ▸ Files**): **New file** (Script,
  Note or JSON), **New folder**, rename (F2), move (drag, **Move to**, or Ctrl+X then Ctrl+V), delete (Del, to
  Deleted). New scripts start from a behaviour template and open in a tab. Undo with Ctrl+Z in the file tree or the
  toast. Files made here are Explorer files and follow its sharing rules; viewers can only read. Works in the pop-out
  window too.

### 🔧 Fixes

- Renaming a shared file (or renaming / moving a shared folder) now reaches everyone in the session.
- Saving a shared file no longer leaves an extra copy of its old version in the Library.
- The dock's tab strip passes the accessibility check, and Delete closes the focused dock tab.

## 1.45.1 — Fixes: path waypoints, AI connections, object flows, HDRI drops, local objects 🔧

- 🛤️ **Path patrol**: placing waypoints no longer traps the viewport. A **Placing waypoints** box shows while it is on
  (with the count, **Undo last point** and **Done**); Esc, Done, deselecting the object, clicking the object itself,
  clicking the node editor, pressing Play or muting the node all end it. The object holds still while you place
  points.
- 🤖 **AI connections** (Settings ▸ AI): a base URL typed without `https://` or pasted with `/chat/completions` on the
  end now works, and **Will call …** under the field shows the exact address. Test connection answers within about
  10 s and says which problem it is — the server cannot be reached, it does not allow this site (CORS, with the flag
  for vLLM / Ollama / LM Studio), a rejected key, a model the server does not know, or a vLLM started without tool
  calling. The same reasons show in the assistant.
- 🔀 **Add flow to Scene graph** on an object with no flow now creates the flow (with a Flow Input and a Flow Output)
  and adds it — one Undo, everyone sees it. It is greyed out with **Locked by …** while someone else holds the object.
- 🌅 Dropping an **HDRI** from the Explorer onto the viewport now says where it goes, with **Open Environment**.
- 📦 **Local objects** stay yours: a downloaded scene, a whole-scene export, a published or submitted scene and a game
  export leave them out and say so ("1 local object was not included"). Share them from the object list to include
  them.
- 🧊 Compressed **(KTX2) textures** load again. Since 1.43.1 the site's security policy stopped the texture decoder, so
  imported models kept full-size textures in GPU memory and "For Quest / web" exports could not be opened back in the
  app. The decoder is rebuilt to run under that policy.
- Collaboration messages are checked against the sending peer.

## 1.45.0 — Build in the headset: measure, arrange, paint, scatter, browse assets and shrink the world 🥽

Everything you need to build a scene now works with the headset on: measure and line things up, paint terrain and
scatter, pull models off your wrist and drop them in, and scale the whole world down to a miniature to work from above.

### 📏 Measure and arrange

- **Tools ▸ Measure**: tap points with the laser — they snap to corners, edges and faces (and to the grid when grid
  snapping is on). Chains of points, labels that turn to face you and stay readable, a double tap (or **Keep**) makes it
  a measurement item like on the desktop; **Selected ▸ Edit measurement** moves its points.
- **Selected ▸ Arrange** for two or more objects: pick the axis, then Align min / centre / max, Even centres / gaps,
  Drop to ground or Align to — the same as the desktop, one Undo, everyone sees it.

### 🌍 Shrink the world

- In Edit, **both grips always grab the world**, wherever you point: pull your hands together to shrink it down to a
  **1:50 miniature**, apart to grow it, twist to turn it. It clicks (with a buzz) at 1:50 · 1:10 · 1:5 · 1:2 · 1:1 · 2× · 5×
  · 10×, a readout shows the scale, and **Back to 1:1** sits on the quick menu while the world is off life size. The
  comfort vignette closes in while it scales or turns. Only you see it.
- To scale or turn an **object** with two hands, grab it and move it a little first, then add the second grip. Grips
  never pick up the terrain, locked objects, things bigger than about 2 m or a room you are standing in.
- Settings ▸ VR ▸ **Both grips scale the world**: Always (new) or Only in empty air (the old way).

### 🖌️ Brushes on the controller

- Quick menu ▸ Sculpt ▸ **Paint** (terrain layers 1-4) and **Scatter** (paint, erase, rotate, scale, relax, choose a
  source). The trigger paints; the stick sets radius and strength (or density); a ring shows the brush on the ground
  and a buzz starts each stroke. Works in a miniature too.

### 📦 Asset Browser on your wrist

- **Add ▸ Assets** opens a browser on your wrist: packs, free CC0 models and your library, searchable with the VR
  keyboard. Trigger-drag a card into the scene, or click it and place copies with the laser (it snaps, the stick turns
  it, grip stops). Grip the panel off your wrist to pin it in the air; grip it back to return it.
- **Hand tracking**: no controllers needed to browse and place — a pinch is the trigger, pinch-drag drops a model. Tools
  that need precision ask you to pick up a controller.

### 🔧 Fixes

- Someone who joined your room no longer comes back from a network or signaling blip as View-only — their edits kept
  staying on their own screen while you still saw them as an Editor (hosted site; seen on 1.43.2 and 1.44.0).
- **On Impact** now fires when an object hits something from any side — a ball thrown at a wall or a target — not only
  when it lands (new **From** option: any side / landing only; On Impact nodes in existing scenes keep landing only).
- Rotate and Motor nodes spin up from rest when they switch on, and an auto-starting HUD Timer counts down from its full
  time (both used to start as if they had been running since midnight).
- Set Game State, Set Variable, HUD Rows, HUD Set Input, Device Param and Note Trigger show the sockets they read, so
  you can wire them by hand; a HUD Timer's **start** socket starts it.
- The Sequence card shows its wait times at the normal card width; thirteen node descriptions say what the node really
  does.
- The profile button opens with Enter or Space instead of on focus, so Tab moves past it, and Esc returns to it. At
  large UI scales on a narrow phone, window headers stay on one row with the close button beside the title.

## 1.44.0 — Quick wins: play from where you stand, trace over a picture, share files in, embed anywhere ⚡

Small things you feel in every session: try the corner you are building without walking there, trace a plan, send a
file from your phone into the app, paste a scene link into Notion — and movement that stays smooth on bad Wi-Fi.

### ▶️ Play here

- **Play here** starts Play where your camera is — standing on whatever is under it, facing your view — and Stop puts
  the camera and your selection back. <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd>, right-click Play, the
  viewport menu's Tools, an optional toolbar button (Customize toolbar), on a phone Play's long press or More, and in VR
  Tools ▸ Play here.

### 🖼️ Reference images

- Drop an image on the viewport ▸ **Use as reference**: a see-through, unclickable picture on the ground or facing
  your view to trace over. Opacity, size and height in Tools ▸ Reference images. Hidden in Play, never in exports or
  published scenes; yours only unless you tick **Share with session**.

### 📲 Share into the app

- Install the app and it appears in your phone's **share sheet**: share a picture and it lands in your Library (or
  becomes a reference image); share a .glb/.gltf and it is placed in your scene; share a .tpscene and it opens.
- **Open files from your desktop**: with the app installed, double-click a .tpscene to open it, or a .glb/.gltf to add
  it to the scene you have open — a second file goes to the same window.

### 🔗 Embed anywhere

- Paste a public scene link (/s/…) into **Notion, WordPress, Discourse** and other oEmbed / Iframely sites and the
  game plays in place.

### 📶 Smoother together

- Movement — avatars, VR hands, dragged, held and thrown objects, physics — rides a new fast channel between players,
  so a lossy connection no longer freezes and jumps it (5 % loss: 95 % of gaps 74 ms, was 249 ms). Edits stay reliable
  and in order; older peers fall back by themselves.
- 👻 People whose app crashed or lost its connection leave the Users list on their own, and leaving never shows
  "Connection error". A short Wi-Fi drop heals the session instead of ending it.
- 🚪 When a guest joins your public room automatically you get a notice with **Turn off** and **Remove**, and the
  Connect bar says **Public · guests join**.
- 🚩 Report a public room or a person from the room list and the Users list.

### 💾 Kept on your device

- Packs, skies, converted textures and CC0 downloads are kept on the device (stored once per content), so scenes
  load again without the network. Settings ▸ Storage shows the use, sets a size limit and clears it; the app asks once
  to keep the storage, and says why.

### 🤖 AI assistant

- As a viewer, the assistant tells you it can't change the scene instead of "creating" things nobody sees.
- Things it builds stay where they are when you press Play, unless you ask for physics.

### 🔧 Fixes

- Right-clicking the viewport opens its menu on every platform again.
- Two-peer sync: anything the host does while a just-approved joiner is still connecting now reaches that joiner as
  soon as its connection opens, instead of only after the joiner's full scene download (seconds later on slow machines).
- After a network drop that only one side noticed, edits flow both ways again: the side still holding the dead link
  switches to the fresh one and catches up on what it missed.
- Offers (like being made admin) keep their Accept / Decline buttons in Notifications.
- A late joiner sees a shader graph on an object that arrives after it; physics actions fire even at very low frame
  rates; viewers' Explorer fills in (project, shared files and big material presets reach viewers).
- Deleting a file you never shared no longer tells the session its name.
- The README, the welcome window and the docs now say plainly how it works: sessions are peer-to-peer, and our
  servers handle signaling and relay, accounts and cloud saves, assets, community pages, anonymous error reports and
  counters.

## 1.43.2 — A dependency fix 🔧

- 🔧 Updated **body-parser** (a security advisory, GHSA-27r3-jxmh-p828) in the development tools and the agent bridge.
  The app you open in the browser does not use it and is unchanged; the downloadable release builds are published
  again from this version.

## 1.43.1 — Security: scene code runs in a sandbox 🔒

A security fix ([GHSA-r74q-9hg7-wrgr](https://github.com/theprototype-app/core/security/advisories/GHSA-r74q-9hg7-wrgr)).
Until now, code carried inside a scene — Script nodes, Behaviour files, the Player code of a Character Controller and
**Custom (code)** HUD elements — ran as part of the app page itself, so a scene someone opened (a shared play link, an
embed, a session peer's scene) could read what the page keeps: AI provider keys and, on theprototype.app, your sign-in.
Please update; self-hosters, rebuild from this release.

- 🔒 **Scene code runs in a sandbox**: a separate JavaScript engine (QuickJS, WebAssembly) that has only the scene API
  it is given — no page, storage, cookies, network or DOM. Your scripts and the bundled games work as before; a
  scene with code loads the engine while the scene is opening.
- 🧩 **Custom (code) HUD elements** draw through a small document whose markup is cleaned before it is shown
  (text, boxes, styles, SVG, a 2D canvas). Event listeners, timers and images by URL are not available inside one.
- 🛡️ **Built apps ship a Content-Security-Policy**, so injected scripts do not run. Self-hosting? The policy is in
  every page; `build/_headers` holds the one line (`frame-ancestors`) a server has to send itself.
- 🔑 A diagnostics bundle never contains your API keys.
- 📡 An invite link that names a different signaling server asks before switching to it.
- ▶️ Optional for hosted setups: `VITE_PLAY_ORIGIN` serves play links and embeds from a second origin. On
  theprototype.app, play links and embeds now open from play.theprototype.app.
- 🧱 Installed modules are trusted code and are unchanged — install only modules you trust (see SECURITY.md).
- ☁️ On theprototype.app: your sign-in renews itself while you use the app and is no longer kept where page code
  can read it; **Sign out everywhere** ends every session at once; and roles in a room are verified — only the host
  or an admin can change who may edit, and when the host leaves an admin or editor takes over.

## 1.43.0 — Scatter everywhere: any model, on any object, edited by hand, the same on every device 🌿

Scatter grew up: pack items, prefabs and mixes of models, on any object (not just terrains), filled to a count with
masks and spacing, then edited one instance at a time — and still only a few hundred bytes to send.

### 🪨 What you can scatter

- **Pack items** (a Nature Kit rock), **prefabs** and **Use as scatter source** on any object, as well as primitives
  and Library models. A prefab scatters as its look; **To objects** brings the real prefab back, logic and all.
- 🎲 **Mix models by weight** (three rocks at 50/30/20), with **Tint** (a little colour variation) and **Sink** (push
  them into the ground).
- A scatter is its settings + a seed + your hand edits: everyone in the session, and every reload, gets exactly the
  same instances. **Re-roll** gives a new layout and keeps every instance you edited.

### 🌍 Scatter on any object

- Properties ▸ Scatter ▸ **Add scatter** on any mesh or placed model — moss on a rock, barnacles on a ship. The
  instances move, turn and scale with it.
- **Fill** by count or density, keep a **minimum spacing**, and limit it by **slope**, **height** or a **painted
  terrain layer**.

### ✋ Edit instances

- The Scatter brush has tools now: **Paint, Erase, Rotate, Scale, Relax** and **Select** — click or box-select
  instances, move/turn/size them with the gizmo, re-roll or delete them. **Affects** limits a tool to one model.
- 🔁 **Convert both ways**: instances **To objects**, or several copies of one object ▸ **Make scatter**.
- Terrain paint ▸ **Detail** sets each terrain's paint resolution (64–512).

### 📱 Fast on every device

- Far scatter fades out to stay inside each device's budget (Quest, phone, desktop); nearby instances and every
  collider stay the same everywhere, so a ball bounces off the same rock on a phone and a PC. Settings ▸ Scene ▸
  Performance ▸ **Distant scatter**.

### 🔧 Under the hood

- Updated: svelte 5.57.2, vite 8.3.5, vitest 5.0.5, @threlte/extras 9.22.3, three-mesh-bvh 0.9.16, @lucide/svelte
  1.61.0, iwer 2.7.0, axe-core 4.14.0, prettier 3.9.10, Playwright 1.64.1 (three stays 0.186.1).
- Dependency updates now arrive automatically, tested by the full e2e battery before they reach a release.

## 1.42.0 — Together and anywhere: type code together, pop the editor out to a second screen, play on a real table 🤝

Two people can now write the same script at once, the code editor can live on its own monitor, and an Android phone can
put your scene on the table in front of you.

### ✍️ Write code together

- **Shared typing in the Code tab**: open the same Script or Behaviour node (or script file) as someone in your session
  and you both type into one text — two people in one line both keep what they typed, nothing is overwritten.
- 👀 **See each other**: everyone's cursor and selection show in their colour, and an **Editing with you** strip names
  who is there and where ("Ana is on line 4") — a screen reader reads it too.
- Someone who joins late sees the current text, unsaved edits included. Viewers can read along but not type.
  **Ctrl+S** saves exactly as before, and **Ctrl+Z** undoes only your own typing.
- 📄 **Text documents from the Explorer** (.txt, .md …) open in the Code tab from the preview's **Edit**, and are shared
  the same way.

### 🖥️ The code editor on a second monitor

- **Pop out** in the Code tab's header opens the editor in its own browser window — drag it to any screen. Saving,
  errors and shared typing stay live; **Dock back** (or closing the window) returns it to the app. Desktop only.
- 🖼️ Checkpoint and saved-scene thumbnails show just the scene — no gizmo, grid or helpers.
- 🐘 Very large scenes skip automatic checkpoints (with a one-time notice);
  Settings ▸ Scene ▸ **Auto checkpoints on large scenes** turns them back on.

### 📱 Play on a real table (Android)

- **AR table**: on an Android phone with Chrome, More ▸ **AR table** shows the camera, finds a table, and a tap
  places your scene on it. Pinch to resize, twist to turn, **Move** to put it somewhere else, then **Play** — tap
  things to click them, and a game's HUD shows on screen. Everyone else in the room keeps playing the same game.
- iPhone and desktop show "AR needs Android Chrome" instead.

## 1.41.0 — Accessibility: bigger UI, high contrast, the whole editor by keyboard, screen readers, and games everyone can play ♿

A pass over the editor and over the games you make, for people who see, hear, move or hold a controller differently.
Everything here is saved on this device and never sent to other people in your session.

### 🔎 See it

- 🔠 **UI scale**: Settings ▸ **Accessibility** (a new page) ▸ **UI scale**, 90–150 %. Every panel, sheet, dock,
  toolbar, menu, toast and the phone layout grows with it; the 3D view keeps its full resolution.
- 🌗 **High contrast** is a real theme now: white text on black at **7:1**, every button, border and switch at 3:1,
  a thick yellow selection outline and bigger, brighter move/rotate/scale handles. Pick it in Interface ▸ Theme or
  with the **High contrast** switch on the Accessibility page.
- 🎨 **Colour-blind safe status colours in every theme** — the budget chip, connection quality, badges, draw-call
  counts and node sockets use a set people with red-green or blue-yellow colour blindness can tell apart, and every
  status also has a **shape** (disc, triangle, cross). Node sockets have a shape per type.
- 🌀 **Motion**: *Follow system* / *Reduce* / *Full*. Reduce makes sheet swipes, dock slides, toasts, the camera
  fly-to and pulsing indicators instant.

### ⌨️ Use it without a mouse

- **Tab** walks every control in reading order with a visible focus ring; **arrow keys** move inside toolbars;
  **F6** jumps between regions; a **skip link** goes to the 3D view and **Esc** gives the keyboard back.
- Menus, dialogs, docks and sheets open, walk and close from the keyboard, and focus goes back where it was.
  **Shift+F10** (or the Menu key) opens the selection's menu. The object list is a tree you walk with the arrows.

### 🔊 Hear it

- 🗣️ **Screen readers**: toasts are read aloud (errors interrupt), selecting an object says its name and kind, the
  object list is a proper tree, and every icon button, menu and window has a name.
- 💬 **Captions**: Timeline audio clips, Sound and Game Sound nodes take a caption line; Settings ▸ Accessibility ▸
  **Show captions** turns them on everywhere, the editor included.

### 🎮 Games everyone can play

- **Pause menu ▸ Accessibility** in every game (and on the start card of play links, embeds and exports): captions
  and their size, a **colour-blind filter**, **HUD text size** and **remappable controls**. Kept per player per game.
- 🥽 **VR comfort**: the comfort vignette is *Off* / *Low* / *High*, **Recenter** for seated play, and **One-handed**
  mode (one controller walks, turns, teleports and opens the menus).

### 🛠️ Under the hood

- A new accessibility check in CI blocks serious and critical axe-core violations on the main surfaces.

## 1.40.0 — Physics and water: bodies that never miss a wall, tanks that pour into pools, fluid on the graphics card 🌊

Fast things hit what they should, the body that is hit hears about it, and a fluid tank's water finally reaches the pool
it pours into.

### 🧲 Physics

- 🎯 **Continuous collision, per object**: select a dynamic body ▸ Properties ▸ Physics ▸ **Continuous collision** —
  *Scene default*, *On* or *Off*. Turn it on for a bullet or a thrown ball so it never passes through a thin wall;
  the scene-wide switch stays the default. Saved, shared, and it applies to a running simulation at once.
- 💥 **On Impact fires on the object that was hit**: a falling body landing on a **static** or **kinematic** object (a
  pressure plate, a target, a moving platform) fires that object's On Impact too, with **other** = the body that
  landed. Two dynamic bodies still fire once.
- 🦆 **Pool party** toys float like foam — the beach ball, swim rings, lilo and duck ride high on the water.

### 🌊 Water and fluid

- 💧 **Fluid tanks pour into pools**: a pour that lands on a water surface crossing the tank joins the pool, ripples
  it where it lands and splashes a couple of droplets back up — the same for every player, nothing extra on the
  network. A tank standing in a pool keeps the water it holds.
- ⚡ **GPU fluid**: Settings ▸ Scene ▸ Performance ▸ **GPU fluid** (*Auto* / *Off*). Auto measures this device once
  and runs fluid tanks on the graphics card (WebGPU) only where that is clearly faster — here an 8000-particle tank
  steps in ~3 ms instead of ~36 ms. The processor stays the fallback (no WebGPU, a slower GPU, a lost device).
  Pours onto pools work on either.

### 🛠️ Fixes and polish

- 👀 A person who joins **View only** now sees the room's HUD, HUD values, shader graphs, animation and room anchor
  straight away.
- ✏️ Joining with **Editor access** makes you an editor on your own screen too (you were treated as view-only until you
  reloaded).
- 💾 **Save scene & connect** keeps your scene as a real version in your own project on every build.
- 🔤 3D labels and VR panel text no longer fetch fonts from a third-party CDN — they work offline, behind a blocker and
  in exported games.
- 🧹 Error reports also remove server names and IP addresses; preview builds file reports under their own label.
- 🪟 A window closed and reopened in quick succession (Modules, Settings…) no longer closes itself.
- 🔒 The build tool is updated for a security advisory.

## 1.39.0 — Logic you can see: a node graph debugger, a Timeline for cutscenes, and fixes that stay fixed 🔎

Pause your game logic and watch it run, put camera shots, clips, sounds and events on a timeline, and keep the
measurements you take.

### 🔎 Node graph debugger

- 🐞 **Breakpoints** on nodes (**F9**, or the node menu): in Play, an event reaching one **pauses** your view of the
  logic. **Step** (F10) runs one event at a time, **wires show their live values**, and a **watch list** follows
  variables. It is **local to you** — other players keep playing.
- 🔗 Several HUD Buttons can now drive **one** module node input (no more Delay bridges or duplicate buttons); the
  Football and Dungeon Realms templates are simpler for it. Edit Mesh toolbox tooltips show **rebound** keys.

### 🎬 Timeline

- 🎞️ A new **Timeline** editor (**Alt+T**, the dock's "+", the phone More sheet): tracks for **camera shots** (with a
  glide between two cameras), **animation clips**, **audio** and **events**. Drag and resize items with snapping, scrub
  the ruler, one undo per gesture. A sequence is scene data — saved, shared live and undoable.
- ▶️ Play it with the new **Play Sequence** node or **Autoplay** when Play starts — also in exported games. **On
  Sequence Event** fires your graph from a sequence (and `end` when it finishes).

### 🧱 Building

- 🪨 **Scattered models can be solid**: each scatter model gets a **Collider** (Box, Sphere or Mesh hull) in
  Properties ▸ Scatter, so a thrown ball stops on a rock for every player.
- 📏 **Measurements are kept in the scene** like strokes: listed in the object list, shared with everyone, saved, and
  editable — select one and press **Tab** to pick a point up and put it down (it snaps). Labels no longer pile up on
  short segments. (This replaces 1.38's pinned measurements that only you could see.)

### 🛠️ Fixes and polish

- 💠 The **budget chip** can be moved in **Edit positions** (Reset position puts it back beside the toolbar) and hidden
  (its "−" there, or Customize toolbar… ▸ Budget chip); opening its ▾ menu no longer makes it vanish.
- 🎨 Large free (CC0) **materials reach every connected person** (they arrive in the background, once), and saving a
  material preset is quicker when your library holds large ones.
- 📜 **Settings ▸ About ▸ Third-party licences** lists every open-source library in the app with its licence.
- ⚡ Small models (under the import thresholds) are placed **without loading the optimizer**.
- 🪟 Statistics can be grouped with other windows; a floating window dropped onto a split dock pane shows in that pane;
  the pinned Connect bar keeps a rounded corner over the logo row; a ✓ pressed right after an Edit-positions drag is
  no longer ignored.

### 🛡️ Reliability

- 🩺 **Anonymous error and crash reports** help fix what breaks — on by default, **Settings ▸ Privacy** turns them off.
  No account, no IP address, no scene content.
- 📶 A public **status page** at [status.theprototype.app](https://status.theprototype.app).
- 🥽 Under the hood: the VR checks now run on an emulated Quest 3 (Meta's IWER), and the test suites are green against
  deployed builds.

## 1.38.0 — Build precisely: snapping measurements, align and distribute, free CC0 assets and terrain paint 📐

Line things up exactly, bring in free assets without leaving the app, and paint and dress a terrain with a brush.

### 📐 Measure, align and distribute

- 📏 **Measure snaps** to corners, edges and faces, **chains segments** with a running total and the angle between
  them, and **pins** dimension labels in the viewport that only you see (**Clear measurements** removes them). On touch,
  tap the points; the toolbox has Pin and Undo point.
- 🧲 **Align** (min / centre / max on X, Y or Z — to the selection or to the active object), **Distribute** (even
  centres or even gaps, three or more objects) and **Drop to ground** for a selection: in the Properties **Arrange**
  section and the object menu's **Transform ▸**. One undo each, live for everyone. (The object menu's "Align to ground"
  is now **Drop to ground** and moves the whole selection.)

### 🌍 Free assets (CC0)

- 🛍️ **Asset Browser** (main menu or the Add menu): **Poly Haven** models, skies (HDRIs) and textures and **ambientCG**
  materials — search, categories, thumbnails, 1k / 2k / 4k (1k on a headset or phone, 2k on a desktop). The lists are
  saved on this device, so the browser still opens offline.
- 📥 A model lands in your Library (a "Poly Haven" folder) through the same path as a file drop — so a big one is
  **optimized on import** like any other; a sky lights the scene for everyone; a material becomes a **material preset**
  with its maps. Every asset keeps its **CC0 credit** (site, authors, licence, link) in the Explorer's Properties and
  the Inspector — the optimized copy and the placed object included.

### 🏔️ Terrain paint and scatter

- 🎨 **Paint four texture layers** onto a Terrain with the **Paint** brush in the Sculpt toolbox; each layer's colour,
  texture and tiling are in the Inspector. One stroke = one undo, live for everyone, saved with the scene (older apps
  open a painted terrain unpainted).
- 🌲 **Scatter** trees, rocks or any Library model or primitive with a brush: density, scale range, random rotation,
  align to the slope, paint and erase. Drawn as instances, counted by the **budget chip**, and dense models switch to
  lighter **levels of detail** with distance.

## 1.37.0 — Fast on every device: big models slim down on import, a budget meter, HEIC photos and Race shadows in VR 🚀

Heavy models and photos now come in ready for a Quest or a phone, and you can see at a glance whether a scene fits.

### 📦 Importing and exporting

- 🪶 **Big models are optimized as they come in**: over 50k triangles or with a texture over 2048 px, an import gets a
  level-of-detail chain and its textures are resized and GPU-compressed (KTX2/Basis — about an eighth of the texture
  memory on a Quest). The original stays in the Library; the toast offers **Keep original only**.
- ⚙️ **Settings ▸ Import** holds the defaults (thresholds, LOD levels, max texture size, compression). A file's
  **Properties** in the Explorer has its own **Import settings** and **Reimport**.
- 🔭 **Configure Scene ▸ Level of detail**: one LOD distance for the whole scene, shared with everyone in it.
- 📤 **Export presets**: *Optimize for* **Full quality** or **For Quest / web** — a GLTF becomes a compact `.glb`
  (KTX2 + meshopt + LOD), a Scene keeps its format with compressed texture copies and LOD chains. The last choice is
  remembered.
- 🖼️ **HEIC / HEIF photos** (iPhone pictures) import as images and textures: decoded once to JPEG, so everyone in the
  room sees them. The decoder downloads only the first time you need it.

### 📊 Will it fit?

- 🚦 **Scene budget chip** beside the toolbar: green / amber / red for a **Quest**, a **phone** or a **desktop**, judged
  with the perf gate's own numbers. Click it for **Statistics ▸ Budget** — draw calls, triangles, texture memory, lights
  and shadows against that device, and the heaviest objects (click one to select it, with what optimizing on import
  would save). On a folded phone it is **More ▸ Tools & View ▸ Budget**.

### 🏎️ Games

- 🌲 **Race keeps its shadows in VR**: one sun, fitted around the player — 89 draw calls / 153k triangles with shadows
  (was 142 / 306k). Adaptive quality still drops shadows if the headset cannot hold its frame rate.

### 🐞 Fixed

- 🧊 KTX2 files load with their textures compressed on the GPU, and stay that way through the wire and autosave.

### 🔧 For module authors

- 🧩 `api.quality.keepShadowsInVR({radius})` — a game that budgets its shadow keeps it in the headset.

## 1.36.0 — Your 1.35 review: clusters you can reach, windows you can park anywhere, and a cleaner dock 🧲

Everything from your review of the 1.35 preview, plus a tooling clean-up.

### 🧩 The top of the screen

- 🖱️ **Right-click the Connect bar** (long press on touch) for Move, Pin to top row / Float, Reset position and Reset all
  — in Edit positions or outside it. A moved Connect bar now stays where you put it.
- 👀 **The buttons beside the logo** (hidden by default on desktop) come back from Edit positions: their menu's **Show
  cluster** turns them on, and their grip really moves them, like every other cluster.
- ⚡ **No more sliding**: the logo, the buttons beside it, the corner buttons, the profile and the Connect bar jump to
  their new place at once when a sidebar is pinned, unpinned or closed.
- 👤 **The profile menu opens under the profile button** wherever it is — beside a pinned right sidebar or moved in Edit
  positions.

### 🪟 Windows and the dock

- 🧲 **Hold Ctrl (Cmd on a Mac) while dragging a floating window** to place it anywhere — over a sidebar or the dock —
  without docking. Docking stays the default; the lit target says "Hold Ctrl to place without docking", and you can press
  or release the key mid-drag. On touch, drop a window clear of the targets, or take a docked one out with its tab's
  **Undock into a floating window**.

### 🐞 Fixed

- 📸 Switching dock tabs no longer flashes a docked Statistics, Objects, Chat or AI assistant window full screen for a
  frame (after the docked Image editor or Node editor).
- 🧹 The empty dock's tab strip no longer shows a sliver of a tab bar left of its "+".

### 🔧 Tooling

- 🛡️ The open Dependabot alerts are cleared (none critical, high or medium left); an unused dev dependency (gh-pages) is
  gone.
- 📌 Node 24.19.0 and npm 11.17.0 are pinned in `.nvmrc` / `.mise.toml`, and CI reads the same file.
- 🧾 Every release now ships an SPDX **SBOM**, and CI fails on a critical or high vulnerability (grype).

## 1.35.0 — Your 1.34 review: windows that move and dock anywhere, a dock that splits, and a toolbar you place 🪟

Everything from your review of the 1.34 preview, plus four bugs the test clean-up found.

### 🪟 Floating windows

- ✋ **A floating window moves by any empty part of it**, not only its header — a click on a row or a button still does
  what it did.
- 🧲 **Every floating window docks by drag** — onto the dock's tab strip, the bottom edge or either sidebar, grouped or
  not, with the mouse and on an unfolded phone by touch.
- 📋 **A window menu** on a header or group tab (right-click, or a long press): Dock to bottom, Move to the left/right
  sidebar, Float, Group with…, Bring to front, Reset size, Close.

### 🗂️ The dock and the sidebars

- ➕ **T opens an empty dock** with only its "+" when nothing is docked, and the empty dock takes a drop.
- 🎯 **Every "+" lists every window**: one that is already open is ticked, says where it is and comes to the front there
  — no second copy (the dock's "+" no longer docks or removes a window: Undock and Close stay on the tab and its menu).
  **Ctrl/Cmd- or Shift-click** picks several without closing the menu.
- 🗃️ **Sidebars get a "+" too**, stay open when you empty them, and **Ctrl+B / Ctrl+Alt+B** show and hide the left and
  right sidebar (their tabs stay open).
- ↔️ **The dock splits side by side**: a Split button (and Split right / Split with / Swap sides / Unsplit in the tab
  menu) puts two windows in one "A / B" tab with a draggable divider; drag a tab onto a pane to swap it in. Splits are
  remembered.
- 📐 Docked Statistics, Chat, Shader editor, Objects, Live profiler and AI windows stop at a **Full-height sidebar** like
  the editors do.

### 🧰 The toolbar and the Connect bar

- 👆 **Move toolbar works by touch**: drag the bar with a finger and lift to place it.
- 🧩 **Edit positions arranges every button cluster** — the toolbar, both corner stacks, the buttons beside the logo, the
  top-right group and the Connect bar: drag one anywhere, it snaps to edges, sidebars and other clusters and never
  overlaps; **Rotate to vertical / horizontal**, Reset position, Reset all, Hide. Positions survive fold/unfold,
  resizing and sidebars, and Layouts carry them.
- 📌 **Connect: Pinned or Float**, from its drawer; a floating Connect bar with no room on the top row turns compact, and
  a pinned one squares its corner beside an open sidebar. The buttons beside the logo follow a pinned left sidebar.

### 🎯 Focus mode and Settings

- 🖼️ **A Viewport button beside Exit focus** shows or hides the 3D preview without leaving focus mode — and focus mode
  remembers your choice (shown by default).
- ⚙️ **Opening Settings no longer closes** an open sidebar or docked windows.

### 🐞 Fixed

- 📊 Profiler: a selection counts exactly the frames you picked (a click is one frame, Shift+→ adds one).
- 🔌 An invite link pinned to a server that cannot be reached brings you back online on your previous server within a
  second — it could stay offline until a reload.
- ⚡ Opening a big scene no longer stalls the window past 200 ms on a phone (the object list's icons are much cheaper).
- 🔁 "ResizeObserver loop completed with undelivered notifications" no longer appears when the toolbar changes size
  beside a pinned sidebar, or when a crowded top row turns the Connect bar compact.
- 🧾 Typing with the Node editor open no longer floods the diagnostics log; a repeated identical line is counted (×N).
- 🍔 Under a pinned Connect bar an open left sidebar starts below the logo, so the menu stays in reach (the unfolded
  phone pins the bar by default now); in focus mode the Exit focus pill sits clear of the dock's new Split button.

## 1.34.0 — Your 1.33 review: copy and paste any value, a toolbar that fits, and a real full-screen focus 📋

Everything from your review of the 1.33 preview.

### 📋 Copy, paste and reset values

- 📋 **Right-click any value** in Properties or Configure Scene (long-press on a touch screen) for **Copy**, **Paste**
  and **Reset to default** — one number, a whole vector (Position / Rotation / Scale, or just X, Y or Z), a colour, a
  choice, a switch, or a **whole section** from its header (also *Copy as JSON*).
- ⌨️ **Ctrl+C / Ctrl+V over a field** copies and pastes without a menu. With several objects selected, a section can be
  **pasted to all of them** at once. Every paste is one undo.
- 📝 It is plain text: paste into a notepad or a code editor, change it, paste it back — `1, 2, 3`, `Vector3(1, 2, 3)`,
  `#ff8800`, JSON and `name: value` lines all work. The wrong kind of value is refused with the reason.

### 🖥️ Sidebars

- 🗂️ **Sidebar tabs get an ×, a right-click menu** (long press on touch: Close, Close others, Undock, Move to the other
  side, Move to the bottom dock) and **scroll** like the dock's tabs.
- 🎯 **Drag a tab anywhere**: into the 3D view to float it, onto the dock to dock it, onto the other side — every drop is
  highlighted first ("Float here", "Move to dock", "Add as tab"), never a silent drop.
- 🪟 **Any window can live in a sidebar** — Node editor, Code, Explorer, Shader, Statistics … — with **no extra window
  header**: the sidebar tab is its header.
- 🔒 On the desktop the panel-header **lock sits beside Full height** in the sidebar's tab row.
- ↔️ **Resizing a sidebar** moves the logo and profile button with the edge, without lag, and a narrow sidebar never
  scrolls sideways on a touch screen.
- 📱 On a phone, **Statistics is a dock tab** like Objects and Properties.

### 🧰 The toolbar

- ⏩ **Buttons that do not fit fold into a » menu** — from the right end, Play never — and come back by themselves as
  room returns. Nothing is switched off.
- 🖱️ **A right-click anywhere on the toolbar** — gaps included — opens its menu, never the browser's.
- ➖ **The "…" button and the Connect bar can be hidden** like any other button; hidden buttons stay hidden (the
  phone too).
- 🧱 **The toolbar keeps clear of pinned sidebars**: Move toolbar stops at their edge, Edit positions lays its bar beside
  any open sidebar, and *Lift corner buttons* moves the corner buttons beside a pinned sidebar.
- ↩️ **With a mouse, Edit positions arranges the row beside the logo** too; Undo, Redo and Multi-select can go onto the
  bottom toolbar or into a corner. An emptied group left of your profile picture leaves no empty box.
- 🔝 **The Connect bar takes its own row** only when the top row is full, and goes back to the middle when room returns.
- 💡 The phone's **More tip** goes away once you have arranged the bar (*Settings ▸ Interface ▸ Reset tips* brings it back).

### 🎯 Focus mode 2.0

- ⛶ **A maximized docked window fills the whole window** (Ctrl+Space or Maximize in its tab menu) — the sidebars step
  aside and come back exactly as they were.
- 🖼️ **The 3D view stays with you as a picture-in-picture** in the corner: live, resizable, movable, closable — and
  interactive: orbit, pan, zoom, click to select, W / E / R and the gizmo, F to frame, Delete.
- 📷 **The camera preview is resizable** too.

## 1.33.0 — Your 1.32 review: sidebars your way, a phone bar you arrange, and focus mode 🎯

Everything from your review of the 1.32 preview.

### 🖥️ Sidebars on the desktop

- 🗂️ **One sidebar per side, panels as tabs**: Configure Scene / Properties, Objects and any window docked to an edge
  share their side's sidebar as tabs — opening one brings its tab forward instead of a second column. **Drag a tab to
  the other side** to dock it there (the side lights up), or drop a floating window on a sidebar to add it as a tab.
- ↕️ **Full height**: the button in a sidebar's header runs it from the top edge to the bottom edge — that corner's
  buttons slide inward and the bottom dock gets narrower beside it. The main menu always opens above sidebars.
- 🔒 **Panel headers can scroll away**: a lock in the Properties and Configure Scene headers keeps the name and
  *Filter properties* on top (the default) or lets them scroll with the properties — per panel, on desktop and phone
  (**Settings ▸ Interface ▸ Sticky panel headers**).
- 🛠️ A pinned Properties panel no longer slides when you select after deselecting.

### 📱 The phone bar, arranged from More

- 👆 **Press and hold any item in More and drag it onto the bar** — or along it, or off it. Play too: off the bar it
  waits in More ▸ Windows. *Edit bar…* is gone; a 1.32 bar carries over.
- ➕ **Up to seven items** (icons only past five on a narrow phone). More gains **Inspect, Move, Rotate, Scale,
  Statistics, Tools & View and Focus mode**, all placeable on the bar.
- 🎚️ **Show switches** at the bottom of More: *Selection toolbar*, *Dock tab row* and *Grab handle* (the edge still
  resizes without it).
- 🛠️ The burger menu's **Save options** open full screen, with no gap on the right.

### 🪟 Windows, the dock and focus mode

- 📥 **Every floating window docks by dropping it on the dock's tab row** — exactly where the marker shows, the window
  see-through while you aim. Objects, Statistics, the Live profiler, Chat and the AI assistant dock too.
- ↔️ **Floating windows overlap the dock** and resize past its top edge.
- 🎯 **Focus mode — Ctrl+Space**: the 3D view alone, or the docked window under the mouse filling the screen. Esc or
  Ctrl+Space brings everything back; also **View ▸ Focus mode**, a dock tab's menu, or **More ▸ Focus mode** on a phone.

### 🧰 The toolbar

- ✋ **Edit positions reaches the top-right icons** (notes, notifications, peers) **and the touch tools** (undo, redo,
  multi-select); each corner holds up to **four** buttons, with one **+** for the next place.
- ⬆️ **Lift corner buttons above docked panels** (off by default), next to *Always on top* in the toolbar's menus.
- 💾 **Workspace layouts keep the toolbar** — its buttons, corners and position — with the desktop and the phone bar
  kept separately in one layout.
- 🏷️ The menus say **Pivot** and **Microphone**.

### 🌊 Quality and notices

- 🎛️ **Configure Scene starts with a Quality preset** (Auto / High / Medium / Low, this device) plus the automatic
  quality, shadow and model switches.
- 🔔 **One** auto-quality notice instead of stacked ones, and the unsaved-scene notice no longer flickers while a peer
  edits.

## 1.32.0 — Your 1.31 review, fixed: sheets that swipe away, tidy docks and a reef that swims 🐠

Everything you flagged in 1.31 and in the 1.32 preview, fixed — plus an Image editor and a real reef in the Aquarium.

### 📱 On a phone

- 👆 **Every sheet has one grab bar**: menus, the Inspector, Configure Scene, Add, the Explorer and every docked window,
  the profile menu, notes and Customize character. Drag the bar to resize (each sheet remembers its height), swipe it
  down to the bottom to close. The bar never scrolls away, and no sheet covers **Play** or the selection toolbar.
- 👤 **Customize character and Profile settings open again** from the profile menu.
- 🗂️ **Explorer: press and hold a file or folder** for its action sheet — no more browser image callout; hold and move
  to pick it up. The rename field's selected text is readable, and the toolbar scrolls sideways so the project name
  is always reachable.
- ➕ **The dock's "+" lists every window** with a show/hide switch.
- 🛠️ Fixed a "Something went wrong: ResizeObserver loop" message with the Explorer docked.

### 🪟 Docked and floating windows

- ✖️ **Close a docked window from its tab** — the window itself has no ✕ any more. **Undock** moves to the dock strip,
  left of *Minimize the dock*, and undocks the window you are looking at (**Settings ▸ Interface ▸ Windows & chrome ▸
  Undock button** → *All as one tabbed group* takes them all out together).
- 📥 **A floating tab group has a "Dock all tabs" button**, and **dropping a docked tab onto a floating window adds it as
  a tab** instead of opening another window. Tab groups no longer lose their header after switching tabs.
- 🏷️ **Long object and file names stay on one line** with "…" (hover or press and hold for the full name) and never
  push a window's controls out of place.
- 🧭 The dock's tab strip stays painted behind every tab and **keeps its scroll** when you pick a tab.
- 🗔 **Workspace layouts** is a proper dialog on desktop and phone.

### 🖼️ Images

- 📷 **A big photo becomes a texture** instead of being refused — it is scaled to 1024 px.
- ✂️ **New Image editor** (Explorer ▸ Edit image…, the preview's pencil, or Edit beside a texture): crop, rotate, flip,
  resize, brightness / contrast / saturation, **Save** or **Save as copy**, and a version history with **Restore
  original**. Saving updates every texture made from the image, for everyone in the session.

### 🌊 Smoother, and honest about it

- 💧 **Water refraction (and every other automatic quality setting) no longer switches off and on by itself** on phones:
  a setting that had to be lowered again right after coming back stays lowered for that scene.
- 🔔 **One notice when quality is lowered for you** — *"Lowered water quality to keep it smooth · Keep full quality"* —
  replacing the "Simplified water" strip and the object list's quality toast.

### 🐠 The Aquarium is a reef

- 🐟 **Templates ▸ Examples ▸ Aquarium**: clownfish, regal blue tangs and emperor angelfish swim around a reef arch,
  staghorn coral, eelgrass and Amazon swords from the new **Aquarium Kit** pack. Simple stand-ins show at once and turn
  into the real fish as they download.
- 🧭 **Four new motion nodes for anything** (node editor ▸ Animation): **Follow Path** (speed, loop / ping-pong,
  banking), **Wander**, **Orient to Velocity** and **Body Wave** — a wave travelling along a fish, snake, flag or tail.
- ✨ **Fish scales material preset**: an iridescent thin film over a scale relief, drawn lighter on phones and headsets.
- 🛠️ Fixed: LOD groups stuck on their first level in scenes with water.

### 🔁 …and your review of the 1.32 preview

- 🎛️ **Toolbar ▸ Edit positions** (right-click or press and hold any toolbar button): drag the toolbar and corner
  buttons into place, remove one with the red **−**, add one with the green **+** (up to three in each corner, Play
  always stays), then the green **✓** applies. A custom button order no longer shows the wrong icons after a reload.
- ✋ **Selection toolbar**: **Inspect** is an icon that opens *and closes* the properties, and only looks pressed when
  they are open; **Select multiple** and **Interact** sit after Scale. Interact clears the selection and gives it back
  when you leave it. On touch, **tap a selected object to deselect it**. Adding an object no longer opens the
  properties (an open panel follows the new object).
- 🫳 **Carrying things in Interact** follows your finger or cursor from the point you grabbed — no more objects
  flung at the camera — and lets go with a gentle throw.
- 📱 **Phone drawers behave like a phone's sheets**: lists scroll, and at the top of the list a pull down (or a
  flick) closes the drawer, with resistance and snap points. The main menu closes when you press outside it, the
  selection toolbar no longer floats over menus or drawers, and an open note steps through **all** notes (‹ ›) and
  returns to where you opened it.
- 🪟 **Tabbed floating windows drag smoothly by touch** (tab names too); press and hold a tab for **Ungroup / Dock /
  Close**. On desktop, **drop a window or tab onto the dock's tab bar** to dock it exactly where the marker shows. The
  dock's **+** lists every window — **Node editor** and **Image editor** included — and the Image editor can be a
  dock tab.
- 🧑‍🎨 **Customize character opens a studio** around your character (**Show in scene** previews it in the world),
  keeps it fully framed when you fold or unfold the phone, and **Surprise me** deals a new look on every press;
  presets show their defaults and your edits become a **Custom** entry.
- 🪜 **Dialogs cover the whole screen** (the logo included) and What's new sits above every button. Questions about
  deleting, restoring or replacing things are **dialogs** instead of toasts (*Delete flow*, *Restore previous
  session?*, …). **Settings rows fit their window**: a switch, a short
  list, a colour, a button or a small set of choices stays beside its label, and only what cannot fit (wide choices,
  text fields) moves underneath — on a phone, an unfolded phone and a narrow desktop window alike.
- 🟢 **The connection pill shows a coloured dot** (grey, pulsing yellow, green, red) and says **Connecting… /
  Connected / Offline** beside it whenever there is room; when the top bar is crowded it shrinks to the dot alone —
  and **reconnecting after switching tabs no longer toasts**. Only a connection that gives up leaves one notification.
- 👥 **The connected-people panel is wider**: one row per person (name, then where they are underneath, actions on the
  right), nothing wraps or breaks; on a phone it is a drawer like the notifications.
- 🧩 **Node editor**: a one-line breadcrumb bar — tap a crumb to jump to its siblings, hold for the full name.
- 📈 **Profiler**: hideable sidebars, a **Details** + **Settings** sidebar on the right and a resizable split between
  the graph and the list.
- 🗂️ On a phone the Explorer's press-and-hold menu stays open, and docked windows open with their sidebars hidden
  until you show them.
- 📱 **On a phone, Properties, Objects, Notes, Layouts and Configure Scene are tabs of the bottom dock** (beside the
  Explorer and the Node editor) instead of drawers behind it: **Inspect** brings Properties to the front, nothing
  covers the Play button, and when you unfold the phone or switch to a desktop each panel goes back to its sidebar or
  window — and returns when you fold it again. Menus, notifications, your profile and Add stay drawers. Tapping the
  bottom-bar button of the view on screen minimizes it (with undocking on, it shows and hides that floating window),
  and the main menu closes as Configure Scene opens on a phone (on a desktop it stays open).
- 🎮 **Phone bottom bar**: **More** can be taken off the bar (a one-time note tells you to press and hold any bar item
  to get it back), the press-and-hold menu's header reads **More ▸ Edit bar…** and opens More, and **Play can move**
  along the bar. Play starts as plain **Play**, like on a desktop; pick VR or AR from its press-and-hold menu and its
  icon follows. The selection toolbar now follows a drawer as you resize it, without lagging behind, and the profile
  drawer no longer repeats your picture.
- 📂 **Main menu ▸ Project** has a compact two-column layout — **New from template…**, **Load** | **Save ▾**,
  **Import** | **Export…** — where **▾** opens one **Save options** dialog with every save setting. A phone keeps the
  list; **Settings ▸ Interface ▸ Project actions** switches between Auto, Compact and List.
- 🧩 **Modules on a phone**: Enable/Download/Remove sit to the right of each module, a long description expands when
  you tap it (tap again to fold it), and the dev-URL row fits the screen. In Browse, **Install** several modules at
  once: each card keeps **Installing…** until it is done, none cancels another, and a failed one says why with
  **Retry**. Core no longer opens on a long empty scrollbar after a long Browse list.

## 1.31.0 — Drag to place: see the size and the spot before you let go 📦

Drag any object from the Explorer onto the scene and see exactly where it will land and how big it is — the way a
content browser works in a desktop 3D tool.

- 🖱️ **Drag from Explorer ▸ Packs or ▸ Library onto the viewport** (pack items, your Library models, prefabs). A
  ghost sits on whatever is under the pointer — the floor, a table, the side of a wall — and follows the grid when
  snapping is on (hold **Shift** to move it freely). Let go and it is placed right there, as **one undo step**, and
  everyone in the session sees it. A click (no drag) still places in front of the camera.
- 🔄 **R** (or the mouse wheel) turns it 15° while you drag, **Shift+R** turns it back; hold **Alt** as you let go to
  drop it at the camera's focus point; drag several selected cards to drop them side by side in a row.
- 📏 **Its size beside the pointer: width × depth × height in metres**, plus triangles and download size. An item
  that is already loaded previews as a see-through copy of the real model; a heavy or not-yet-downloaded one as its
  box (hovering the viewport starts the download, so the drop is quick). A placed pack item shows your loading
  Placeholder Style until its file arrives.
- 🛑 **Changed your mind?** Esc, dropping back on the Explorer or letting go anywhere else places nothing and leaves
  no undo entry. The ghost turns **amber** when it would sit mostly inside another object (you can still place it)
  and **red** where there is nothing to stand on.
- 📱 **On a phone or tablet**: press and hold a card until it lifts, then drag — the Explorer tucks itself away so
  you can see where you are dropping.
- ⚙️ **Settings ▸ Scene ▸ Performance ▸ Placement preview**: Full model / Within budget (default) / Box only, a
  triangle budget (50,000 on a computer, 15,000 on a phone or headset) and Show dimensions.
- ✅ **See what is downloaded**: Explorer ▸ Packs marks downloaded items with a ✓ (size in the tooltip) and the filter
  has **Downloaded**. A pack item's **Delete is now "Delete cache (size)"** — it frees the download and the item stays
  in the pack; a pack's menu has **Delete downloads**, and **Storage** lists Pack downloads with **Clear all pack
  downloads**.
- 🧩 For pack authors: every pack item now carries its size, bounds, triangle count and download size in the
  manifest (`kit-build dims`, checked by the packs CI) — see PACKS.md "Item dimensions".

In VR the radial Add menu still places in front of you; drag-to-place in VR comes later.

## 1.30.0 — A calm new look: one interface on a desk and in a pocket ✨

Every window, menu, modal, the main HUD and the phone layout move onto one small kit of parts. Everything you
can do — every shortcut, setting, scrub field and panel — works exactly as before.

### 🧭 The main HUD

- 🧰 **One glass toolbar** at the bottom: the accent marks the armed tool, and **Play is the only orange control**.
  The logo, the corner buttons and the top-right group (notes · notifications · peers) share the same glass look
  and reach 44 px on touch.
- 🔗 **The Connect bar collapses to a compact chip once you are connected** (status, who is here, avatars, mic) and
  expands on click; while reconnecting it says for how long ("Reconnecting · 2 min") — the attempt count is in
  Connect ▸ Info. A speaker's avatar gets a soft green ring.
- 🍞 **Calmer toasts**: three at a time, the rest behind "+N more".
- ⌨️ **New: Ctrl+K command palette** — search tools, windows, menus and every setting from one box.
- ▶️ **New: a small "Playing · Press Esc to stop" banner** while you play; a scene can hide it or show its own text.
  The play options have their own section now: **Configure Scene ▸ Play** (pointer, reach, flying, the banner, the
  spawn point). Games keep their Menu · Esc button.
- 👤 The profile menu and Profile settings use the new rows.

### 🪟 Windows, tabs and menus

- 🪟 **One window header everywhere** — Explorer, Objects, Chat, AI, Notes, the Notification centre and every docked
  or floating tool window: icon, title, actions, pin and close in the same places.
- 🗂️ **One tab strip** for docked and floating windows: pill tabs with the view's icon and their own **✕**; more tabs
  than fit scroll sideways while **+** stays put, and a docked view no longer repeats its name under its tab.
- 📋 **One menu style** for the right-click, Add and viewport menus (32 px rows, icons, right-aligned shortcuts).
  The **object right-click menu is shorter**: Properties, Rename, Duplicate and Delete first, then Focus / Ping /
  Note and the editing modes, with Transform, Mesh, Physics & effects, Prefab and Save as… one level down. Nothing
  was removed.
- 🔔 **Repeated notifications are grouped** — one entry with ×N and the latest time.
- 🫥 **No native scrollbars anywhere** — lists show a thin scrollbar only while you scroll or hover.

### 🎛️ Inspector

- 🗂️ **Collapsible sections**, aligned property rows for position, rotation, scale and every slider (scrubbing,
  typing and undo work exactly as before), the object's name in the header, Shared / This device badges instead of
  explanations, switches instead of checkboxes (a middle position when the selected objects disagree), environment
  presets as chips, and one **+ Light ▾** menu.

### 🪪 Dialogs

- 🧩 **Modules, Sessions, Checkpoints, Templates, Storage, Publish / Export, Import and every confirm dialog** share one
  modal header and window style, with one emphasised action per view, kit tabs, toggles and buttons, and a filter in
  Modules.
- 🧍 **Customize character is a drawer** you can resize by its edge; your character stands centred in the space beside
  it, and Apply and Cancel return the camera exactly where it was.

### 📱 Phone

- 📱 **A decluttered phone layout**: the logo top-left, a Connect chip (tap it for your invite link, the join field,
  Info and Toasts) and a bottom bar (**Add · Objects · Play · Explorer · More**) you can rearrange from More ▸ Edit bar
  or a long press. A selection toolbar (Move, Rotate, Scale, Inspect, Undo, Redo) appears only while something is
  selected; with nothing selected, More ▸ Edit has Undo, Redo, Select multiple and Interact.
- 📜 **Windows open as bottom sheets above the bar** — Play stays in reach — that you drag between peek, half and
  full; each remembers its height on this device, and the selection toolbar rides on top of the open sheet. Settings
  and dialogs open full-screen. Every control from the old phone layout is still reachable.

- 🎞️ **Editors on a phone**: the Animation window shows one pane at a time (Channels, Timeline, Key, Clip) with finger
  dragging, two-finger pan and pinch; the Shader editor gives the canvas the whole screen with the palette and the
  properties as sheets; toolbars that do not fit (UV editor, Profiler, Animation, Shader) scroll sideways with a fade
  where more is hidden.

### 🎨 Look and themes

- 🔵 **One accent colour**: blue marks what you can act on or have selected; orange is kept for Play, recording and
  live states. The light theme and custom `.theme.json` themes now restyle every surface.
- 🔤 IBM Plex type, one icon set at two sizes (16 / 20) with the first in-house glyphs (Interact, VR, physics, joints,
  fluids); menu icons that showed blank squares now show their icons.
- 🧱 **/kit** — every part of the new UI in every state, for module authors building their own panels (new:
  `ScrollStrip` for rows that can run out of width).

### 🔒 Under the hood

- Behaviour-lock suites pin every setting, shortcut, scrub field, panel and the object list, so the redesign changes the
  look and nothing else; CI rejects raw colours outside the tokens, native scrollbars and Flowbite.

## 1.29.0 — Groundwork for cloud saves and rooms that stay ☁️

- ☁️ **Groundwork for cloud saves and kept rooms** on theprototype.app: the app can now tell the cloud plugin when the
  scene changes, fingerprint what is in it, and hand over or open a whole project. Saving scenes and projects to your
  account with versions, and rooms that stay when everyone leaves, switch on on theprototype.app separately — the
  open-source app is unchanged.
- 🧩 **For plugin authors**: `cloudApi.sceneRevision()`, `onSceneChange(fn)`, `sceneSignature()`,
  `buildProjectBundle()` and `openRemoteProject({url})`; `buildSceneBundle({signature: true})` adds `meta.signature`
  (opt-in). All additive, nothing listens until a plugin asks (OPEN-CORE.md § 5).

## 1.28.0 — Sculpt and snap the world from the headset, cut with a polyline knife 🔪

### 🥽 VR

- ⛰️ **Sculpt terrain in VR**: radial menu ▸ **Add ▸ Terrain** puts a terrain in front of you and starts sculpting (or
  select one and pick **Selected ▸ Sculpt terrain**). Hold the trigger to Raise, Lower, Smooth or Flatten; the pointing
  hand's thumbstick sets brush size and strength. Every stroke is one undo step and everyone sees it.
- 🧲 **The two-grip world grab snaps**: the world turns in 15° steps and sticks at 1×, 2×, 5× and 10× (and ½, ⅕, ⅒)
  with a light tick and a readout between your hands. Turn it off in Settings ▸ VR ▸ Controls ▸ World grab snapping.
- 🏠 **Dollhouse teleport**: **Scene ▸ Dollhouse** shows the whole scene as a model on a table — point into it and pull
  the trigger to stand there.
- 🧱 **Add ▸ Architecture ▸** in the radial menu: the same walls, doors, windows and stairs as the desktop Add menu.

### ✂️ Mesh editing

- 🔪 **The knife cuts polylines**: Shift+click adds corners, Enter ends, Backspace takes one back (Back / Cut buttons on
  touch); the corners become real vertices. A two-click cut that ends inside the mesh now ends where you clicked.
- 🪞 **Live symmetry** (Edit Mesh toolbox ▸ Symmetry): every edit and vertex drag is mirrored across the axis, from the
  side you edited — one undo step for both halves.
- 🗺️ **New module: Smart unwrap (xatlas)** adds **Unwrap ▸ Smart (xatlas)** to the UV editor: automatic seams and an
  overlap-free packed atlas, one undo step (Modules ▸ Browse).

<!-- 1.28 fixes on the way: Backspace now reaches a pending knife cut (the viewport Backspace row stood down too late).
     New third-party code inside the smart-unwrap module zip only: xatlas-wasm 0.1.3 (MIT). -->

## 1.27.0 — Sky images, walls and stairs, smarter nodes and sparks that fly 🏛️

### 🌅 World

- 🌄 **Sky images (HDRI)**: a 360° photo can be the scene's sky AND its light — objects take on its colours, shiny
  things and water reflect it, and the sun light moves to where the photo's sun is. Five built-in skies (Clear sky,
  Meadow, Sunrise, Starlight, Photo studio) or **Upload HDRI…** your own `.hdr`/`.exr`; rotation, image light, sky
  blur and tone mapping (ACES / AgX / Neutral) in Configure Scene ▸ Environment. Exposure now works on the desktop
  picture too. **Settings ▸ Scene ▸ Sky image quality** picks Full or the lighter headset tier on this device.
- 🧱 **Architecture in the Add menu**: parametric walls with door and window openings, doors (single/double, hinge,
  in/out, glass panes, open on click or when you walk up) and windows (fixed or casement) that open for everyone, and
  straight, L, U and spiral stairs the walker can climb — every dimension editable in the Inspector, pieces land on
  the 1 m grid.

### 🧠 Nodes

- ➕ **Math and Gate take up to eight inputs** (+ input / −): add, multiply, min, max, AND, OR and XOR work across all
  of them.
- 🔀 **The Switcher is a multi-way switch**: each item has its own input and **value** passes on the selected one —
  picked by hand or by a wired index.
- 🎥 **Camera Rig node**: a camera object follows and/or looks at a target with damping and an offset — and never
  moves anyone's editor view.

### ✨ Effects and physics

- 🎆 **Particles drawn four ways**: sprites, stretched sparks, per-particle trails and a ribbon along the emitter's
  path, plus **Inherit velocity** (sparks fly off a moving object). New presets: Ribbon trail and Magic wisps.
- 🔗 **Joints break live**: detaching during a simulation pulls the objects apart with sparks, for everyone;
  duplicating both ends of a joint copies the joint.
- 🚗 **Drivable Car 1.3.0** steers with its front wheels; new **Blocks** module drops 100 physics blocks in one draw
  call (Modules ▸ Browse).
- ☁️ On theprototype.app, What's New starts with a section about the hosted service.

### 🔢 Number fields and undo

- ↩️ **One drag or one typed edit is one undo step** in every scrub field (Inspector, shader nodes, Animation window);
  **Escape** after typing puts back the value you started with; the Inspector's transform rows show restored values
  the moment you press Ctrl+Z; the Animation window's Speed is undoable; selecting a node in the Shader editor is no
  longer an edit sent to everyone.

<!-- Module SDK (1.27): api.physics.setJointMotorPosition, createJoint limits / contacts / sparks options,
     api.physics.rapier(); cloudApi.setWhatsNewSection({title, markdown}). Module gallery now reads modules@format-1
     (retagged per modules release; RELEASING.md). -->

## 1.26.0 — Edit many at once: prefabs that update, material presets and a new Settings 🧰

### 🎯 Selections

- 🧮 **The Inspector edits a whole selection.** Rows that differ show a dash (checkboxes go indeterminate, lists show
  —); one edit is ONE undo step and reaches everyone as one change. Visibility, shadow, render-order and culling flags
  and every Light row are now undoable, and Light rows edit all selected lights at once.
- 📍 **Pivot point: Median, Active or Individual** — in the Inspector, the object menu, a new **Pivot** button on the
  toolbar (after Scale) and VR Settings ▸ Editing. In VR, grip any member of a selection to move the whole set; twist
  or push the stick to rotate and scale it about the pivot.
- 🗂️ **Drag a selection onto a group or any object** in the object list to put it inside; drop it on the list to
  bring it back to the top.

### 🧱 Prefabs and materials

- 🔁 **Prefabs update their copies.** Editing a prefab (Update from selection, or an instance's Prefab ▸ Apply
  changes) offers **Update N instances** — each copy keeps its own changes unless you pick Reset overrides; one undo,
  and everyone in the room sees it. Right-click a placed copy for **Prefab ▸ Update / Reset / Unlink / Select all**.
  Prefabs carry their objects' node graphs.
- 📁 **Folders and tags in the Library's Prefabs tab**: New folder, Move to folder, drag onto a folder card, a
  breadcrumb, tags in Properties and a tag filter + tag search.
- 🎨 **Material presets**: save, rename and share named looks. A starter set (wood, metal, plastic, glass, stone,
  rubber, neon) is one click away at the top of Inspector ▸ Material; your presets stay on your device and everyone
  in the session can use them.
- 🩹 Texture maps no longer vanish when a multi-slot material change is undone or reaches a peer.

### 🪟 Workspace, chat and notes

- 🧭 **Settings, redesigned**: a grouped menu (General · Workspace · Devices & services, About & what's new pinned),
  cards with one control per row, toggles, segmented controls and sliders with readouts, "This device" badges,
  sub-pages with a breadcrumb (push navigation on a phone), search results that show their path and jump to the row,
  a per-category **Reset … to defaults** that asks first, and **Interface ▸ Density** (Comfortable / Compact).
  Clear saved session and Reset all settings moved to About ▸ Danger zone. No stored setting changed.
- 🗔 **Workspace layouts**: save the windows you have open (panels, docked or floating, sizes, docks, tab groups)
  under a name and switch in one click — menu ▸ Layouts, or Settings ▸ Interface ▸ Windows & chrome.
- 💬 **Chat v2**: @mentions in each person's colour, emoji shortcodes (`:tada:`), an unread badge, and the chat so far
  for people who join late or reopen a saved session.
- 🧵 **Reply to a note** in a thread; adding, editing and resolving notes is undoable.
- ↩️ **Undo after destructive actions**: Clear scene, Delete selection, Remove module and Reset all settings show a
  toast with **Undo** for about 8 seconds — for everyone in the session for scene changes, on this device for modules
  and settings.
- 🐞 **Report a problem** (menu, and in VR): a screenshot, boxes around what is wrong and a note, sent to the team
  with your consent when you are signed in — or kept on your device.
- 🔧 Small fixes: **Z** cycles your view mode (Shaded → Shaded + AO → Wireframe), the edit-mode wireframe re-tints
  the moment a colour changes, VR note pins stay on their objects while you grab the world, and dropdowns open
  correctly inside a full-screen dialog.

### 🧍 Characters

- 🦶 **Characters stand on the floor** in Play and keep their feet planted.
- 💫 **Knocked off, not spinning**: an idle character now sees stars — orbiting stars, a woozy sway, star eyes —
  instead of spinning its head (Settings ▸ Interface ▸ Avatars ▸ Knocked-off idle: Off / 10 / 20 / 60 s).
- 🕊️ **Flying in Play is opt-in per game**: off unless a game wants it, and a scene can remove it (Configure Scene ▸
  Physics ▸ Play mode ▸ Flying). Football, Marble maze, Target toss and Stars Room now walk on desktop.

### 🏎️ Race and modules

- 📱 **Race on phones and in VR**: on a phone the stick steers and Gas/Brake sit under your right thumb; in a headset
  you sit in the car and the left stick drives (a VR player could not drive before).
- 🏔️ The Race mountains get grass, rock and snow by slope and height.
- 🧩 Module SDK: `api.registerPointerHandler`, `api.onClickMiss`, `api.camera()`, `api.onPlayMode` / `api.inGame()`,
  `api.vrSeat` / `api.vrUnseat`, `api.input().touch` and the `drive` touch preset; Untangle aims with `api.camera()`.

## 1.25.0 — Your feedback, fixed: panels that keep their keys, water that behaves 🌊

### ⌨️ Panels and windows

- ⌨️ **Keys follow the panel you are in.** W/A/S/D no longer fly the camera from the Explorer, Inspector, node Graph
  view, HUD editor or any tool window, and the panel that has the keys shows an outline. The Object list keeps
  Delete / F / Ctrl+D, T/N/O work from anywhere, and C opens chat only from the 3D view.
- 🎚️ **Sliders and number fields in nodes never drag the graph**, and the behaviour view stops flickering.
- 🖱️ No browser menu on a right-click while you drag a window; the undocked Code window's tabs are clickable;
  Ctrl+Z works with a checkbox or slider focused and inside the Profiler timeline.

### 🧑‍💻 Code workspace

- ✏️ **The Player node's code opens and saves** like any other code node (with the engine source beside it, read-only).
- 🗂️ **Sidebars**: Open editors and a searchable Project tree on the left (module sources open read-only with
  **Make editable copy**); Outline, Problems, Bound nodes and Find in files on the right (**Ctrl+B**, **Ctrl+Alt+B**,
  **Ctrl+Shift+F**).
- 📑 The tab strip scrolls and tabs drag to reorder; **Ctrl+P** quick open, **Ctrl+Shift+O** go to symbol, a guard
  before closing unsaved code, full keyboard navigation and a light-theme editor.

### 🧩 Node graphs

- 🔍 **The node editor opens with the whole graph in view** — or where you left it, saved with the scene
  (Settings ▸ Input ▸ Node editor opens).
- 🧹 **Tidy graph** (button, right-click menu, **L**; **Shift+L** only fixes overlaps and crossings) — one undo, and
  everyone in the room sees it.
- 🗺️ **Every game's Main graph is tidied**: nothing overlaps and no wire crosses a card; Waves, Stars Room, Towers,
  Jam Room and Untangle read as group cards with notes.

### 🎯 Selecting and loading

- 🐟 **Click things inside or behind water.** **Alt+click** cycles everything under the cursor (hold Alt to preview,
  "2 of 4"), and Configure Scene ▸ Advanced ▸ **Selection passes through** chooses what clicks go through. Game rays
  and the VR laser skip water and triggers. **Ping is now Ctrl+Alt+click.**
- 🧭 **Opening a scene while another is loading always gives you the newest one.** The load bar shows progress from
  the click, scenes draw their shapes first and the water a moment later.

### 🌊 Water and simulations

- 🛟 **Things under water rise or sink by their density**; Island Ocean's boat rides the swell; the Jelly Room
  renders again.
- 🎛️ **Every water setting works on every preset** (Opacity, Visibility, Foam…), and a selected object under water
  sits exactly under its outline.
- ▶️ **Start simulation on load** (Configure Scene) and one **Reset / Pause** for the whole simulation — tanks,
  bodies, drops and fluid alike; play links start the simulation too.
- 🫧 Bubble emitters you can see, **Add ▸ Water ▸ Pour** emitters, and fluid tanks that spill when tipped.
- 📱 **Phones**: water and fluid follow the quality level live, the quality climbs back up once a scene has loaded,
  and the simplified water still bends the light (a one-time notice says how to get the full look).

### 💧 Fluids (new)

- 💧 **Add ▸ Water ▸ Fluid** — real particle water poured into the scene, with hard caps so it can never run away; it
  pools, splashes, lands on meshes and joins water it is poured into. **Physics ▸ Fluid** on any mesh chooses how it
  meets the water.
- 🌀 **Add ▸ Water ▸ Flow path** — a river, chute or pipe that carries water and floating things; a looping river
  recycles its water.
- ⚙️ New nodes **Rotate / Motor** and **Float Along Flow**; one scene-wide **Fluid budget** (Configure Scene ▸
  Physics) that the quality governor lowers when frames drop.
- 🏭 **New example: Water works** — a closed-loop water diorama.

### 🔧 Fixes

- An old game scene with two modules no longer opens with its two Code link cards on top of each other.
- Particle fluid no longer tunnels through thin walls under pressure.

## 1.24.0 — Characters that walk, a race, and your games' stats 🏁

### 🧍 Characters

- 🧍 **Everyone is a rigged character now** — nine CC0 KayKit adventurers and skeletons that walk, run, strafe and jump
  with their camera, and reach for their VR controllers with their arms. Without a pick you get one chosen from your id;
  the classic floating head is one click away.
- 🎨 **Customize Character is a side panel** (profile menu) with a live preview on your own character: body, the
  character's own head or a stylised one (or your photo card), hats, outfit colour, and your ping colour and sound.
  **Settings ▸ Interface ▸ Avatars** can show everyone else as classic heads.

### 🏎️ Race

- 🏎️ **New game: Race** — up to four players: click a car, press Start, three laps round a valley. A lap counts only
  when you have driven all of it. Laps, speed and grip live on the **Race rules** node in the Main graph; move the
  road's points and the race follows.

### 🔷 Edit Mesh

- ✂️ **Slide edges, fill holes (F), connect (J) and dissolve vertices, solidify, and separate faces into a new
  object.** Edge bevels miter their corners where four or more faces meet; vertex bevels get segments (rounded corners).
- ➕ **Boolean union / subtract / intersect** for two meshes, from the object menu (also "Subtract, keep the cutter").

### 🕰️ Checkpoints and Settings

- 🕰️ **Checkpoints** — save a named version of your scene (**Ctrl+Shift+S**) and let autosave add automatic ones; a
  timeline restores, compares, renames, notes and pins them. They stay on this device.
- ⚙️ **Settings is a window** with a section sidebar (chips on phones); search still spans every section.

### 🎬 Share

- 🎬 **Tools ▸ Recording…** — record a turntable or a flythrough of the viewport as a webm; it lands in the Explorer's
  Recordings folder.
- 🖼️ **Publish / Export ▸ Community gallery** — build a submission for the community gallery and send it to GitHub in
  two clicks.

### ❤️ Community

- 🆔 **Every game keeps one permanent id**: re-exports and the play link count as the same game, by build and by
  source. A copy or a remix becomes a new game.
- 📊 **Your games & stats** in the profile menu and the Publish dialog; a **Mine** filter in the community browser
  (in the app and on /community).
- ❤️ **Hearts in the app** — on community cards, a play link's start card and the pause menu.
- 🛡️ Staff Insights and moderation (report queue, hide / feature / remove / suspend, an audit log, review requests);
  auto-hide now counts only reports from accounts older than three days.

### 🥽 VR

- 🥽 **A game's HUD floats in front of you in the headset**, laid out as on the desktop: it follows your head with a
  little lag, stays fixed in the world, or lives on your wrist (**Settings ▸ VR ▸ Display ▸ Game HUD**). Button hints
  say what to press. Replaces the old top strip.
- 🤖 **Tools ▸ AI in VR** opens an AI chat panel that shares the desktop assistant's conversation; hold the mic or the
  talk button to speak to it.
- 🎙️ **Voice typing for the AI assistant** (Settings ▸ AI): OpenAI, Groq or a self-hosted Whisper server; a mic in the
  AI window.
- ⌨️ The VR keyboard gains punctuation and Clear; the VR Settings panel has a **Search** tab.

### 🧑‍💻 For module authors

- `api.hud.vrHud()`; HUD element kinds may give `vrText(element, runtime)`. VR game cards draw in one pass (was two).
- Untangle 2.4.1 takes its VR readout from core's HUD on 1.24.

## 1.23.0 — Game rules you can read and change 🧩

### 🧩 Every game's rules on its Main graph

- 🧩 **Each rebuilt game's rules are one readable node on its Main graph** — Mini Golf, Football, Dungeon Realms, The
  Alchemist's Escape, Sky Run, Target Toss and Marble Maze — wired to the game's buttons, HUD, sounds and kit nodes.
  Tune a number in the node's **ⓘ properties** or change its code with **Ctrl+S**: it changes on every player's screen
  and is saved with the scene. The engine (the ball, putting, the VR putter) stays in the module, read-only behind a
  **Code** link.
- 🗺️ **The scene's graph is the Main graph**, pinned first in the Flow list. Opening an older scene adds links to its
  object graphs and to the code that runs it, so nothing is hidden.
- ⚙️ **Every node's properties in the side panel** (ⓘ) — Script inputs, Behaviour params, module nodes; a wired input
  says "wired".
- 🔗 **Double-click a node to open its code.** Module code opens read-only, with **Make editable copy**.
- 📜 Script nodes grow the inputs and outputs their code uses; scripts get `api.object`, `raycast`, `keys` and `spawn`.
- ➗ Math gains sin, cos, pow, abs, round, floor, clamp and negate. Value wires are worked out once per frame, so big
  graphs stay fast and a loop cannot hang.

### 💻 The code workspace

- 💻 **Code workspace** (bottom dock ▸ Code, or floating): scripts, behaviours, script files, module sources and the
  graph as JSON, in tabs. **Ctrl+S** checks the code and hot-reloads every node that runs it, on every peer — broken
  code never applies, and the tab and the node say where it broke.
- 📁 **Scripts are Explorer files**: Save as file, Use file, Unbind — one file can drive many nodes.
- 🧾 **Graph JSON**: edit a whole graph as text and apply it back.

### 🕸️ A node editor that knows its keys

- ⌨️ **Keys follow the panel you are in** — C opens chat only from the 3D view. Press **?** for the shortcut sheet.
- 📦 **Groups** with their own sockets (Ctrl+G; Tab or double-click to go in), **notes and frames** with markdown,
  right-click menus for the canvas, a node or a selection, mute / collapse / align / nudge, and undo for every node edit.
- 🧰 **Settings ▸ Node types** hides the types you never use; groups save and load as **.tpnode** files; the Edit Mesh
  keys are rebindable.

### 🔧 Fixes

- 🔢 HUD Button, On Game State and HUD Timer wired into a number input now give a number.
- 🕰️ A Mini Golf, Escape, Sky Run, Target Toss or Marble Maze saved before 1.23 says so when it opens and offers the
  Games tab, where the game opens with its readable rules.

### 🧑‍💻 For module authors

- `api.kit.provide(spec, impl)` lends a game's rules an **engine piece** (`kit.<piece>.<call>`, its events, its values);
  behaviours gain `inputs`, `outputs` and `this.emit`; `api.flow.seedGraph` seeds a wired example graph once.
- Football 1.4.0 and Dungeon Realms 2.4.0 keep their match and floor rules on the Main graph.

## 1.22.0 — Water, a VR welcome, and every VR setting in the headset 🌊

### 🌊 Water

- 🌊 **Add ▸ Water** — a tank, a pool, an ocean, a round pool, or **Properties ▸ Water ▸ Make it water…** on any
  object: waves, see-through refraction, caustics on the floor, foam, a sky or mirror reflection, underwater fog when
  you dive in, and bubbles that rise and pop. Everyone sees the same water, waves in step.
- 🎨 **Nine presets** — pool, aquarium, ocean, lake, river (it flows), lava, swamp, toxic, ice — and **Save as preset…**
  for your own. **Settings ▸ Water quality** (Auto / High / Medium / Low); headsets get a light Quest tier.
- 🛟 **Things float**: dynamic objects in water float, sink or drift with the current; **Inspector ▸ Physics ▸ Floats**
  picks foam, wood, stone… or a density, and a splash ripples the surface.
- 🧪 **Create ▸ Simulation ▸ Fluid tank** — particle fluid you can pour, drain and slosh; toys float in it. A smooth
  surface on desktop, drops on a Quest.
- 🍮 **Jiggle node** (Effects) — springy secondary motion and jelly wobble on any object, swinging bone chains on rigged
  models.
- 🌧️ **Rain and Snow** particle presets (Add ▸ Effects). Modules get `api.water`. Water is editable in VR.
- 🏝️ **Five new examples**: Aquarium, Pool party, Island ocean, Jelly room, Fluid tank toy.

### 🧱 Colliders that match the shape

- 🏛️ **Exact mesh colliders** for static scenery — pools, tunnels and arches collide as they look (Inspector ▸ Physics ▸
  Collider ▸ Exact mesh). Static Arch and Corner use it automatically.
- 🧩 **Decompose** splits a concave object into convex pieces in the background, so a dynamic arch or cup keeps its
  openings.
- 👻 **Collision groups** (Group + Collides with): ghost walls the player walks through, projectile-only barriers; water
  is a pass-through trigger.
- 🎯 **On Impact / On Enter / On Exit** get "only with" an object and an "other" output naming what was touched.
- 🥽 **Edit collider** in the VR radial menu — shape a custom collider in the headset.

### 🥽 VR

- 👋 **Welcome to ThePrototype VR** plays on your first VR entry: Quest 2 / 3 / 3S controller drawings that follow your
  button layout, each step waits for you to do it, Skip any time. Restart it from Settings ▸ Tours or radial ▸
  Settings ▸ Welcome tour.
- ⚙️ **Every VR setting in the headset**: a Settings ring per page (Comfort · Body · Controls · Display · Editing ·
  Microphone) plus a panel you can drive with the stick. **Smooth turning, the comfort vignette, seated mode and height**
  now work everywhere, not only in games.
- 🎮 **Remap every VR button** (Settings ▸ VR ▸ Controls, or in the headset), with a left-handed layout and a swap when
  two actions collide.
- 🧭 **The radial menu** shows the desktop's icons and names (Objects · Add · Scene · Tools · Redo · Undo · Chat ·
  Settings), Delete is last, and letting go over a ▸ opens that ring.
- 📲 A headset browser **offers Enter VR by itself** — once, follows passthrough, remembers a decline.

### 🧭 Getting started

- 🗺️ **A 6-step editor tour** after the first-visit Welcome card (a touch version on phones); restart it from Settings ▸
  Tours or the logo menu ▸ Tours.
- 🎥 **Opening a scene puts the camera on its saved view at once**, and moving while it loads is never undone
  ("Back to start view", Home). New scene option **Hold camera until loaded** (Configure Scene ▸ Camera).
- 🧊 **Modern loading placeholders are the default** (an explicit Colored boxes choice is kept).
- 👥 **Community** in the profile menu, right under Support — the published scenes and contests.

### 🔧 Fixes

- 📦 Exports drop the host's analytics script quietly (listed under Details); other external scripts still warn.
- 🔗 A peer that joins while an object is animating gets its true resting pose, and peers notice and heal a flow graph
  that drifted apart.

## 1.21.0 — Publish anywhere, touch buttons, readable themes 📦

### 📦 Publish / Export

- 📦 **Publish / Export** (the menu item that was "Publish") opens one window with three tabs: Publish, Export and
  Settings.
- ▶️ **A play link that starts the game**: publishing gives a `/p/<id>` link (and a QR code) that opens straight into
  Play — no editor, a start card, fullscreen and Enter VR when the device can.
- 🗜️ **Export a game as a zip** that runs anywhere static files are served: presets for **itch.io** (upload the zip as
  is, Kind = HTML), **a static host**, or **an embed snippet** for your own page. Everything is inside the zip, with
  relative paths — no calls back to us.
- 🏷️ A small **"Made with ThePrototype"** badge sits in the bottom-right corner of play links, embeds and exports —
  a see-through T with solid dark-grey accents, so a game's colours never tint the logo.

### 👆 Touch screens

- 🕹️ **On-screen action buttons** (Jump, Throw, Grab…) next to the move stick, taken from the game's own controls.
  Move, resize, fade and re-skin them (pressed/released pictures) in **Settings ▸ Touch controls** or from the pause
  menu; Auto / Always / Never. Sky Run, Target Toss, Mini Golf, Marble Maze, Towers and the Escape room come with
  layouts. Modules declare theirs with `api.input.actions`.
- 🤏 Safari trackpad pinch now zooms the editor viewport.
- 📱 **The menu fits short and folding phone screens** and scrolls by touch (OPPO Find N6 folded and unfolded); folding
  or unfolding no longer leaves the page zoomed out.
- 🔋 **Phone quality no longer steps down on a steady menu**: it is judged against the phone's own refresh rate and left
  alone while the scene is trivially light.

### ⏳ Loading you can see

- 🧊 **Modern loading placeholders** (Settings ▸ Scene ▸ Loading; coloured boxes stay the default): a translucent
  hologram with a grid that fills as the file downloads.
- ✋ **Move, select and edit pieces while they load** — the model lands where you put it, for everyone.
- 🔁 **Stuck or failed pieces tell you**: amber after 10 s without data, retried three times, then red with Retry,
  Replace model… and Delete (right-click or double-click), plus a "Retry all" toast.

### 🎨 Easier to read and use

- 🎨 **The Profiler is readable in every theme** — and the same fix across number fields, the Explorer, the shader
  editor and the light-theme drawers.
- 🔎 **Settings search** also finds keywords ("dark" finds Theme), highlights what matched, and Esc clears it.
- 🖱️ **No accidental text selection** in menus and panels; **Settings ▸ Interface ▸ Allow text selection everywhere**
  turns it back on.
- 📊 **Live profiler** moved into the Profiler tab (the **Live** button in its header).
- 🌫️ Fog near/far you set by hand stay set.
- 🐑 Ctrl+D with nothing selected never duplicates a stale object.

### 📚 Docs

- 📚 New pages for Publish & Export, Touch controls, Loading placeholders, Colliders, the HUD editor and Themes, plus
  a backfill of everything from 1.0 to 1.20 that the docs had missed.

## 1.20.0 — Five new games, a profiler, and a kit to build games from 🎮

### 🎮 Five new games in the Games tab (no download needed)

- 🧪 **The Alchemist's Escape** — an escape room in three rooms: open the drawer, find the key, unlock the chest, set the
  dials, pull the levers in the right order and twist the crank to raise the gate, then place three gems to open the
  vault. Hints after a minute in a room, three stages to practise, best time saved on this device. Desktop and VR.
- 🔮 **Marble Maze** — tilt the board (WASD/arrows or drag; in VR grip the handles and twist) and roll the marble through
  five mazes to the gold ring; holes send you back, three coins and a par time per maze for 1-3 stars.
- ⛳ **Mini Golf** — six holes (a ramp, a windmill, a bank shot, sand and a hump); putt by dragging back from the ball or
  swing a putter in VR; par, a scorecard, your best round saved. Any hole from the Levels page.
- ☁️ **Sky Run** — a floating obstacle course: jumps, moving platforms, vanishing tiles, spinning arms; flags save your
  spot, coins and par times earn stars; best time per stage saved. Comfort vignette on by default in VR.
- 🎯 **Target Toss** — tin-can pyramids, swinging targets, pop-ups and a moving cart; five stages against the clock,
  combos, 1-3 stars. VR grab-and-throw; desktop hold-to-charge.
- 🛗 Moving platforms now carry a walking player.

### 📈 See how it runs on YOUR device

- 📈 **The Profiler tab** (dock ＋ menu): record *Light* (frame time, draw calls, triangles, quality — costs
  nothing) or *Detailed* (which objects, materials and shadow casters the draws went to, CPU time per phase).
  Read it on a timeline against the Quest budget (72 fps, 150 calls, 300k triangles), drag a range or click a
  frame for a tree (scene → module → object → mesh) and a ranked *Who draws most*; click a row to select the
  object. Compare two recordings; export/import `.tpprof` files.
- 🥽 **Profile the headset from the desktop**: in VR, System ▸ Profile ▸ Record / Record detailed / Stop /
  Report moment (a small "● REC" pill while recording). On the desktop, menu ▸ Live profiler watches a
  headset in your room live (~2 KB/s); Detailed asks it for a 10-s detailed recording.
- 🧾 **Always-on light recorder**: the last ~30 s of frame data with markers for scene loads, teleports, grabs,
  menus, quality changes, XR entry/exit and every stall over 100 ms (with what was happening).
- 📮 **Send performance reports** (Settings ▸ Interface, off by default; a preview build offers it once,
  production never asks): anonymous 10-s windows of frame times, draw calls and module versions — no account,
  no scene content — with a dot on the FPS counter while it is on.
- 📸 **Report this moment** (menu, and VR System ▸ Profile): the last 30 s + what your eye saw + a note,
  saved as a recording and sent when you agree.
- ⚠️ **Stale-module warning**: an installed module older than the one this release shipped with gets a toast
  and an Update row in Modules.

### 🧰 Build games from a kit

- 🧰 **The game kit** — `api.kit.*` for modules and a **Kit:** node group per piece, both from one spec:
  *rules* (grab reach, a grab veto, play bounds, jump height that every grab path obeys), *round* (intro
  countdown, time limit, pause, win/lose, results — Restart works while playing), *levels* (unlocks, stars,
  progress per device, feeds the pause-menu level picker), *score* (counted once, per-player rows, device best,
  leaderboard), *pickups* (taken once, respawn, grants, walk-into-it).
- 👾 **Entities**: *spawner* copies of a template with their own health, tags and data; *health* (damage once on
  the authority, area damage, heal, revive, regen, armour); *mover* (chase / patrol / arrive with avoidance, STUCK
  detection and recovery round walls, crowds queue at the goal, knock-back). A host leaving mid-wave hands
  everything over.
- 🗼 **Towers runs on the kit** (no behaviour change; saved stars kept). One authority decides every kit change,
  so a press seen by every peer counts once.

### ✍️ Game logic as code, seen as nodes

- ✍️ **Behaviours**: write game logic as one small JavaScript file in a Behaviour node (params, replicated state,
  event handlers, kit calls). It runs on the session's authority and its state reaches everyone; timers survive
  the host leaving; random numbers are seeded. A lint refuses code that would make peers disagree and names the line.
- 🔭 **The live node view**: *Open view* draws a behaviour as read-only nodes with live values, a glow on whatever
  just fired, timer countdowns and errors; param knobs rewrite the number in the code (one undo step) for everyone.
- 🧮 **Script node v2**: typed inputs and outputs (`return { … }`), live output values, a determinism lint.
- 📝 **Flow Code view as compact text** (2.1–2.4× shorter than JSON, lossless) with a JSON toggle.
- 🤖 **AI assistant** reads graphs as compact text (Stars Room: 4.5× less per turn), adds nodes from text, and
  creates/edits behaviours (linted before they apply).

### 🧩 Modules

- 🧹 **Modules unload completely and live**: every handler, node, menu, input claim, music, timer, listener, game
  level/setting and owned object a module registers is taken down when it is switched off, removed, updated or
  reloaded; core modules disable without a reload. New for authors: `api.onUnload`, `api.timers`, `api.listen`,
  `api.own`.
- 📦 **`api.loadModel`**: the app's own glTF loader for modules (Draco, Meshopt, KTX2 on demand), cached per file,
  automatic LODs, released with the module. Waves 2.3.0 (24 % smaller) and Dungeon Kit 2.4.0 (65 % smaller) use it.

### 🛠️ For contributors

- 🚦 **Perf budgets are a CI gate**: every game and level is held to the Quest budget (≤150 draw calls, ≤300k
  triangles, ≤2 lights, texture MB) in a headset-analogue profile — counts only; known offenders sit on a dated,
  owned allow-list (`perf/budgets.json`). `scripts/scene-lint.cjs` checks saved scenes in the author scripts and
  CI; VR-eye screenshots (`scripts/eye-shots.cjs`) render both headset eyes off-screen.
- 🗂️ The four files every change collided in are split: the module SDK (`src/lib/sdk/`, one table), the test
  debug hooks (`src/lib/debugHooks.js`), one file per template (`scripts/templates/`) and the VR controls
  (`src/lib/vr/`). No behaviour change.
- 🧪 A headless logic sim (`tests/unit/sim`) proves game rules with fake peers in milliseconds.

## 1.19.1 — New levels show up straight away 🔄

- 🔄 **The General tab, the packs list and the module gallery show what was just released.** They used to
  keep the list your browser had fetched up to a week earlier, so a device that had opened Templates
  before 1.19.0 did not see the Wizard's Tower or Market Town Square. Every list is now checked with the
  server each time (an unchanged one costs almost nothing), and noticing a new version of the app
  refreshes them even in a tab you never reloaded.
- 🧩 **Installing a module from Browse gets the version Browse shows**, not an older copy the browser kept.

## 1.19.0 — Doors that open, scenes that load, games that switch 🚪

### 🧱 New packs and levels

- 📦 **Four new packs**: **Interiors** (furniture, kitchen, bar, lights and wall trims that snap to the
  architecture walls), **Town & Market** (seamless street tiles, a fountain, stalls, a clock tower, an
  opening garden gate), **Interactive** (doors WITH their frames, gates, a portcullis, a trapdoor,
  shutters, chests, drawers, a lever, a pressure plate, an ambient banner, torch and fan) and
  **Arcane Study** (a wizard's hero props).
- 🏰 **Two new example levels** in Templates ▸ General — the **Wizard's Tower** (alchemy lab, study,
  bedchamber, a roof telescope) and **Market Town Square** (fountain, stalls, a bakery you walk into) —
  and the **Tavern Interior** rebuilt: its doors open, it is furnished from the Interiors kit and it
  stands on a street. The **Architecture shell** template is built from the kits too, with a door
  that opens.
- 🧊 **No more flicker** on kit pieces while you move around (the modular block and twelve others).

### 🚪 Things that move, only when asked

- 🚪 **Doors, lids and levers work** in Interact and Play: click (or point the VR laser, poke, or knock)
  and a door swings open with a sound, and you can walk through; click again and it shuts. Everyone in
  the session sees the same door. A sliding door can open as you walk up to it.
- 🛑 **Nothing animates by itself any more.** Placing or loading an animated model no longer starts it
  looping; only ambient pieces (a banner, a fan, a torch) move, and only in Interact/Play. The
  Animation panel can preview a clip in Edit without changing the scene. Animated pack items carry a
  small ▶ badge in the Explorer.

### 🔭 Levels of detail, like a pro tool

- 🔭 **Every pack object has LODs**, and far-away pieces draw with far fewer triangles.
- 🎚️ **Properties ▸ LOD**: a level bar whose edges you drag, Force LOD, select a level to preview and
  move it, replace a level with another object, generate levels, a "Show LOD level" overlay — and a
  LOD row in the VR properties panel.
- 🧮 **Kit levels draw far fewer calls**: every copy of a pack piece is drawn in one go (Settings ▸
  Performance ▸ Draw repeated kit pieces together) — the Tavern went from 394 to ~135 draw calls in a
  headset.

### ⏳ Scenes that load without freezing

- ⏳ **Opening and restoring big scenes no longer freezes the app**: a progress bar with Cancel, pieces
  stream in, and the autosave of a kit level is ~50× smaller (Castle Courtyard's restore on a phone
  went from a 90-second freeze to a responsive load).
- 🔁 **Opening another scene asks whether to keep the modules** the last one brought (Settings ▸ Scene:
  Ask, Keep or Unload). **Clear scene** asks too: clear the objects, or everything including the game
  setup and its modules. One game no longer leaks its music, gun, menu or spawn into the next.

### 🎮 The games

- 🙌 **Towers: two hands, two blocks** — hold a block in each hand; letting go of one never freezes
  the other.
- 📱 **Stars Room on phones**: phones start at a lighter quality (half the draw calls and render
  passes), so it no longer lags.
- 🪢 **Untangle 2.4.0**: in VR push the stick up/down to send the board or the held globe away or bring
  it closer (as with an object in Edit); the level picker and the Globe / 2D tabs show over the menu
  board.
- 🔤 **Crisper VR menus** (the game board and the wrist card render at full headset resolution) and
  the menu's **Menu / Top strip** buttons fit inside the board in every game.

### 🛠️ Editor

- 🧰 **Toolbar order**: Move, Rotate, Scale, **Interact**, **Play**, Object list, Node editor,
  Explorer, Animation. The Interact button no longer shows a red border on click or leaves two
  un-highlighted corners beside Play.
- ✋ **Edit inside a game**: every object can be moved while a game runs — a dropped body stays where
  you put it until you leave Edit. In VR, select a wall or floor first to grip it.
- 📈 **FPS and draw calls** as a setting (Settings ▸ Interface ▸ Viewport, and in VR): fps, frame
  time, draw calls (amber above 120, red above 150 — the Quest budget) and triangles.
- 🕹️ **VR stick push/pull**: holding the world with one grip, the stick sends it away or brings it
  closer, as with an object in Edit.

### 🩹 Fixes

- 🚶 In Play the walker no longer bumps into pass-through objects (grass, flowers, rugs); an open
  garden gate lets you through.
- 🚪 A door or chest from a pack saves as a reference to its pack file (a few hundred bytes instead of
  up to 1.4 MB).

### 🧩 For module makers

- `api.behavior` (list / state / trigger functional items) · `api.lod` handles gain `force(n)` and
  `levels()` · `api.claimInput('sticks')` · `addSetting({..., onLevels: true})` · `api.inScene()`
  (false while your module is left behind by a scene switch).

## 1.18.0 — Menus, levels and smooth frames in a headset 🥽

### ⏸️ Every game has a real menu

- ⏸️ **Pause any game.** Escape (or the Menu button in the corner) opens the same menu in every
  game: **Resume · Restart · Levels · Settings · How to play · Main menu**, plus Back to editor
  on a desktop. In a headset it is on the game board, and the left **X** button opens it.
- ⚙️ **Settings per game**, remembered on this device: music on/off and volume, sound effects
  on/off and volume, controller vibration, turning (snap, smooth or off, and the snap angle), a
  comfort vignette, Quality (Auto, Low, Medium, High) and **Show FPS** — a small frame counter
  on the screen, or on your wrist and top strip in VR. Games add their own rows (Stars Room:
  "Point to move stars", "Make stars with a clap"; Untangle: Globe or 2D board).
- 🗺️ **Levels in the menu.** A game that has levels shows them in the menu, on a desktop and in
  the headset (Towers' 12, Untangle's 30).

### 🥽 Pointing and moving in VR

- 🎯 **See where you point.** The controller laser is easier to see, ends in a solid dot, and the
  button under it lights up — on every game board and module menu.
- 🕹️ **The radial menu follows the thumbstick**: the sector you push towards lights up, and the
  trigger or a stick click picks it.
- 🪟 **Menus are never hidden** behind floors, pedestals or walls.
- 🌍 **Games can let you move the world.** Untangle and the Jam Room let your grips move, turn and
  scale the whole scene during the game, as in Edit (a grip on something you can hold still holds it).
- 🚀 **Teleport that stays inside.** Dungeon Realms, the Stars Room and the Jam Room let you
  teleport — onto floors only, inside the play area, never through a wall. The arc turns red where
  you cannot land. The Jam Room also lets you fly.

### 🎮 The games

- 🏗️ **Towers is a real game now**: twelve levels with planks, wedges, barrels, arches, balls and a
  heavy base, 1-3 stars a level and unlocks saved on your device. You can only grab what is close
  to you, so build steps and jump (Space, or **A** in VR); wind, a wobbling plate, an outline to
  fill and a star to deliver on top.
- 🌌 **Stars Room**: clap your hands in VR to make a new star (with a sparkle and a sound) — it
  flies and counts like the others; a setting to move stars only by touching them.
- 🪢 **Untangle**: in VR you start in front of the board, not inside it; Globe or 2D board and the
  level picker are in the headset menu; switching board keeps the level you have open, and one
  progress counts across both; the level bar sits at your waist, drawn over the scene.
- 🔫 **Waves**: the robots no longer stop and walk back to their portals when one of them is
  killed; lighter robots (a far version of each, smaller textures).
- 🏰 **Dungeon Realms** draws only the torches near you, with fewer lights in a headset.
- ⚽ **Football** drops the glass's costly see-through pass, four of its lights and both shadow
  maps; a goal's confetti follows the quality setting.

### 🩹 Found on the preview

- 🔤 **Crisp text in VR menus again.** After a heavy moment the headset could start the next VR
  session at a lower resolution, which blurred every menu's text. A headset now always renders at
  full resolution; the speed-ups below are what keep it smooth.
- ⬆️ **Games update the modules they need.** Opening a game that was made for a newer version of
  one of its modules than the one installed on your device now offers to update it (Waves on a
  headset could still be the 1.17 version, whose robots all walked back to their portals when you
  hit one).

### ⚡ Smoother frames

- ⚡ **Fixed the hitches**: the object list's module section re-read every module object every
  frame — that one cost Waves almost all of its frame time and gave Dungeon Realms a hitch every
  second. Four smaller per-frame costs are gone too.
- 🔭 **Automatic level of detail**: big models get simpler versions for the distance, built once
  and cached (Settings: "Simplify distant models").
- 🥽 **Auto quality in the headset**: a VR session starts with shadows off and steps quality down
  (and back up) by the headset's own frame rate; a game's Quality setting overrides it.

### 🧰 For authors

- `play.locomotion` gains `worldGrab`, and `teleport` is bounded by `play.bounds` (else the scene's
  content); `play.reach` limits grab distance. Configure Scene ▸ Physics ▸ Play mode.
- New nodes: **On Clap**, **Point Grab**, **Game Setting**; Spawn takes a place; a spawned copy
  answers to its template's events.
- Module SDK: `api.game.levels`, `addSetting`/`setting`, `setHelp`, `onRestart`, `api.quality`,
  `api.lod`, `api.vrPanel`, `api.locomotion`. `node scripts/perf-games.cjs` measures the seven games.
- 📦 Dependencies: three 0.186, Vite 8.3, Svelte 5.57.1, Playwright 1.63 and ten more minor updates.

## 1.17.0 — Games that look finished 🎨

### 🖐️ Dragging, clicking and selecting that do what you meant

- 🖐️ **Dragging in games no longer throws on Quest.** Every press in play logged a
  `setPointerCapture` InvalidStateError (about a hundred in one Untangle session) and leaving play
  could end in "Something went wrong": the editor's orbit controls stayed mounted in play and
  captured the pointer under a pointer lock. They stand down while you play now, and the capture
  is guarded.
- 🔀 **Edit and Interact.** A new cell at the end of the bottom bar (or the **I** key) switches
  the editor between Edit — every click selects, so every object can be moved — and Interact,
  where clicks and drags work the way they do in play (piano keys play, crates carry) without
  starting the game. Module click handlers say which modes they run in; by default a game piece
  answers in Interact and Play and an Edit click selects it.
- 👻 **Click through glass.** A see-through wall or a shell marked "Click-through in the viewport"
  (Inspector ▸ Object) no longer steals the click from what is behind it, and clicking the same
  spot again (after the double-click window) cycles down through everything under the cursor.
- 🧩 **Every module's content is in the object list.** A new "Module content" section lists the
  pieces a module builds outside the scene (the Untangle board, a piano, a dungeon) by name;
  click a row to frame it, hide it locally, or open the module's toolbox.

### 🎮 Games start when you press Start

- ▶️ **Test play.** A game no longer paints its menu over the editor with live buttons. A small
  "Game · menu" chip says the scene is a game, and ▶ Test play resets it to its menu, enters
  Play and puts the Start screen in front of you (also on the play button's right-click menu).
  The HUD editor's eye still previews the screens, inert.
- 🔁 **The round resets when the last player leaves.** Alone, leaving Play returns the game to its
  menu at once; with others, when the last player has been out for ten seconds.
- 🖱️ **Free-cursor games.** A scene can play with the real mouse cursor and no pointer lock
  (Untangle and the Jam Room do): the cursor aims, clicks fire On Click, press-drag carries. The
  editor grid no longer shows in Play.
- 💾 **Games remember things.** `api.storage` for modules and the new **Store Value** / **Stored
  Value** nodes keep a best score or your unlocked levels on this device (never shared, never
  saved into the scene). The HUD action "Save best score" wires one up.
- 🔇 **A quieter console.** The PCFSoftShadowMap deprecation, the router pushState warning and
  rapier's init warning are gone.

### 🎨 Seven games that look finished

- 🏗️ **Towers remembers your best height** — and looks finished: a sky, a tiled floor, wooden
  crates, glowing height rings, turning stars; Round over shows this round and your best.
- 🌌 **Stars Room is a space room** — a starfield behind glass, crystal stars, a start screen
  with Start round or Free play, a two-minute round, your best round saved.
- 🎸 **Jam Room is a game** — a small studio; press Start, then ▶ on the Transport, and keep the
  band going for eight bars. Played with the mouse, your best tempo saved.
- 🏟️ **Football** is a floodlit glass stadium with a live scoreboard.
- 🏰 **Dungeon Realms** is torch-lit stone under a vault, with glowing gems, animated portals and
  a Start menu you can click.
- 🌅 **Waves** is a sunset arena with a crystal tower that dims with your health, portals,
  readable enemies and hit flashes.
- 🪢 **Untangle, finished:** a real drag (press-drag-release, or click then click), a redrawn
  board, 30 levels per mode that unlock as you solve them (your progress stays on this device,
  with a Reset), and a new 3D mode — untangle the graph around a globe.
- Every game has a Start screen, Pause on **P**, and a restart.

### 🥽 Games in a headset

- 🎮 **Play in VR puts you in Interact.** A game opens in Interact in a headset: your grips grab
  and knock things instead of the world, the stick WALKS you (walls stop you, gravity holds you,
  small steps climb), and there is no flying or teleporting unless the scene allows it. The left
  **Y** button switches to Edit and back (a tick in your hand and a small wrist label say which),
  and the game can put you on its start spot. In Edit, grips move and scale the world again —
  in game scenes too.
- 👁️ **No more light helper in one eye.** Editor helpers drew into the left eye only in a
  headset. Now they are in both eyes in Edit and gone in Interact and Play — together with the
  grid, collider wireframes and selection outlines.
- 📋 **The game menu in VR.** A game's menu, pause and results screens float in front of you and
  answer your laser and trigger (or a poke); the score and timer sit on your left wrist and,
  if you like, in a strip at the top of your view.
- 🎹 **Hold the trigger and sweep.** Hold the trigger and brush across piano keys, drum steps,
  pads or buttons — each one you pass fires once.
- 🌍 **Module content follows the world.** Grab and turn the world and the Untangle board (and
  every module's content) turns with it.

### 🔊 Games that sound and feel like games

- 🔔 20 built-in game sounds, 7 music loops (quiet under the sound effects, only while you
  play), a big centred banner for moments like "GOAL!" or "Floor 3", sparkle / confetti / smoke /
  spark bursts, and controller vibration patterns (in Interact and Play only). Settings ▸ Sound
  has a "Game sounds" and a "Music" volume.
- 🧩 New Game nodes: **Announce**, **Game Sound**, **Effect Burst**, **Controller Buzz**,
  **Game Music** and the **On Grab** trigger.
- 🏗️ **Towers** tells you when your tower reaches each ring (a banner, sparkles at the ring,
  a chime), and the gold ring at the top is a fanfare with confetti. **Stars Room** sparkles where
  you hit a star and pays a coin when it lights. **The Jam Room is a VR cockpit**: stand in the
  middle and every instrument is in reach; a sweep also stomps the pedals and flips the mixer
  mutes (Music FX 0.2.0).
- ⚽ **Football plays like football**: your first touch kicks a match off, 3-2-1, GOAL! with
  confetti and a crowd, the conceding team kicks off, first to 5 or 3:00 with a golden goal;
  swing a controller through the ball to kick it; the consoles stand outside the court.
- 🏰 **Dungeon Realms is lit everywhere**, with real wall torches, footsteps, gem chimes, a
  "Floor N" banner and dungeon music; you can no longer walk through pillars, crates or chests.
- 🔫 **Waves is a VR shooter**: a gun in your hand (Blaster, Scatter, Beam), an ability on your
  grip (Shield, Slow-mo, Pulse), five levels of rigged grunts, runners and tanks walking at the
  crystal, a menu with How to play / Loadout / Options, and a Start board you shoot in a headset.
- 🪢 **Untangle** drags with a controller's trigger (laser or tip), lets you hold and turn the
  globe in one hand, and lost its drone: one sound per event and a quiet puzzle loop.

### 🧱 Kits and levels

- 🧱 Four new packs in Explorer ▸ Packs — **Modular Architecture**, **Nature & Terrain**,
  **Props & Interiors** and **Sci-fi & Modern** — over 120 pieces that snap to the 1 m grid (CC0,
  made with Meshy.ai).
- 🗺️ Three walkable example levels in Templates ▸ General: **Castle Courtyard**, **Forest
  Clearing** and **Tavern Interior**. Kit pieces are saved as references to their pack, so a
  level of 150 pieces is about 25 KB. Configure Scene ▸ Physics ▸ Play mode ▸ Spawn point.
- ↩️ Placing a kit piece is undoable (it was "too large for undo history").
- 🛠️ **Fixed:** moves made with the gizmo, Align to ground or an Explorer drop were refused by
  peers (a rotation sent with its order letters); loading a scene while the simulation runs no
  longer leaves the old physics world behind.

### 🧰 For authors

- 🧱 **Game and template defs can say more:** rounded boxes, capsules, rings, planes,
  ico/dodecahedra; spot, directional (shadows fitted to the scene) and hemisphere lights; glass,
  clearcoat, sheen and toon materials; animation and particle presets by name; click-through
  shells; custom skies with a gradient, fog and a solid ground. Games-tab cards are rendered with
  each game's own lighting.
- 🔤 **Centred HUD text is centred.** A single-line HUD text sat flush left inside its box
  whatever its alignment said.
- 🧩 SDK: `registerClickHandler(fn, {modes})`, `api.registerListedGroup(name, {label})`,
  `api.storage`, `api.editorMode()`, and `api.pointerRay()` is the crosshair ray under a pointer lock and the
  cursor's ray in a free-cursor game.

## 1.16.0 — Waves, and one world to keep 🌊

### 🎮 A new game, and a Games tab that can move again

- 🌊 **Waves — a new game on the Games tab.** Hold the goal against three waves of enemies
  walking in from the spawn pads; knock them down, the round ends when the last one falls. Two
  players plus a late joiner see the same wave, and every kill is credited to the hand that made
  it. (Needs the `health` and `waves` modules; the card offers to install them.)
- 🎮 **Seven games, not three.** The scenes and packs feeds are pinned to `format-2` / `format-1`
  refs instead of `v2` / `v1`. jsDelivr treated those as immutable version numbers, so the Games
  tab could never see a scene released after the first resolve (#230).

### 🥊 Physics that holds up with two players

- ⚖️ **Two players pressing Play at the same moment no longer start two physics simulations.**
  The lower peer id keeps the world and the other hands it over cleanly — a toast names the
  handover, and a third player watching agrees with them.
- 🥊 **Knocking a moving target works on the host too.** A body another writer was moving (a
  module walking it, a peer's stream) read as "carried" to the knock on the peer running the
  simulation, so the host's hand passed through it. The hit is now logged and shared; the shove
  alone is skipped.

### 🧹 Housekeeping

- 🧪 `open-core-m1`'s drawer-mount check had been asserting the pre-tabbed connect drawer since
  2026-07-25 and was carried as a known red ever since; it now drives the Rooms shortcut the app
  actually offers, and the suite is green. No product change.

## 1.15.1 — Knock, and a key you never typed 🔑

### 🚪 Gated cloud rooms work end to end

- 🚪 **A room with a code, or a knock with your name.** Joining a cloud room now carries what
  the room asks for: the right code lets you straight in, a wrong one is declined at once, and
  a knock shows the host *"Ada wants to join Amber Mesa"* on the approval card. (The plugin
  shipped this with 1.15.0 and fell back to the plain card until the engine could carry it.)

### ⚡ Hosted AI, zero configuration

- ⚡ **Signed in? The assistant can be set up for you.** The cloud plugin can now add a hosted
  provider to Settings ▸ AI — no key, URL or model to type. A provider you configured yourself
  always stays the selected one; the hosted row sits beside it to switch to. (Experimental —
  it appears only while our hardware is reachable.)
- ⏳ **"You are #3 in queue for the hosted AI."** The mesh-job card shows your place in the
  hosted queue while a text-to-3D job waits.

### 🧩 For plugin authors

- 🧩 **cloudApi v3.1**, all additive (no hooks-version bump): `connectToPeer(peerId, cloudMeta)`
  rides plain JSON on the join dial, `authProvider.decide(peerId, cloudMeta)` answers
  admit / deny / `{label}`, `cloudApi.dialMeta` is the probe; `api.aiPresets.{userHas, seed}`
  own one plugin-managed provider preset per domain, `api.setMeshJobStatus(fn)` is the line
  under the mesh-job card.

## 1.15.0 — Where everyone is 👥

### 👥 One session, and you can see who is in which scene (roadmap #22, the last three rounds)

- 👥 **See who is in each scene, right on the scene card.** Every scene in the Explorer shows
  who is standing in it (you included), and its menu offers **Join <name>** to travel there —
  even for a scene you have not downloaded yet. One session, scenes as tags: the invite link is
  unchanged.
- ✏️ **Rename a scene; its files follow.** Double-click the scene name in the Explorer header
  (or right-click it, or a scene card's **Rename scene…**). Every version file takes the new
  name, on every peer, and Travel nodes keep working — by name and by version. The header now
  reads `Scene [file.tpscene]`.
- 📋 **Paste a scene, get a scene.** Ctrl+C / Ctrl+V on a scene makes "Arena copy" — its own
  file, its own version history — instead of a second card for the same file.

### 🎮 Two more games on the Games tab, and Football gets its proof

- 🏰 **Dungeon Realms** — a seeded five-floor co-op crawl built from two modules: the Dungeon
  Kit generates, Realms plays. Gems, portals that unseal, a dragon's hoard at the top.
- 🧩 **Untangle** — a planar-graph puzzle on a lit board; drag the dots until nothing crosses
  and the next level appears, the same board on every peer.
- ⚽ **Football's whole match is now a test the app runs against itself** (two peers and a late
  joiner, the real scene and the real module) — a known race is recorded below.
- 🧱 Templates are read from each module's own definition, so a card and its module cannot drift.

### 🖼️ Embeds

- 🖼️ **A scene can live inside another page.** Open the app with `?embed=1` and the editor
  chrome stays hidden for the page's life, play keeps working, and a small corner link opens the
  full app. The community site's `/e/<id>` pages frame scenes with it.

### 🧰 Module SDK

- 🧰 **A module can ask where a graph fits, and listen instead of polling.** `api.flow.nodes()`
  returns node positions, `api.flow.freeRegion()` finds room for a built block, and
  `api.flow / game / peerVars.onChange()` fire once per frame when something changed.
- ↩️ **A module's node edits are undoable.** `api.flow.setNodeData` is one undo step, and
  `api.flow.setNodesData([...])` makes a whole group edit one step — the collectible manager's
  group settings use it.

### 🐞 Known

- Two players pressing Play inside the physics start-up window can both start a simulator
  (the `simulate` message has not landed yet when the second guard runs). Football's suite
  enters Play in order; a deterministic yield rule is the next ticket.

## 1.14.0 — Room for one more 🗜️

### 🗜️ Heavy models stop being a cliff (roadmap #26, the last held phase)

- 📥 **An import is weighed before it lands.** A model's real cost — triangles, draw calls and
  texture bytes — is measured against what the scene already holds, and anything heavy enough
  to hurt asks first instead of arriving and wedging the tab.
- 🗜️ **One dialog, three honest answers: Reduce, Load anyway, or Cancel.** Reduce simplifies
  the mesh on a background worker, so the window keeps drawing while it works, and a progress
  card tells you how far along it is. You are told afterwards what was reduced and by how much.
- ↩️ **A reduction you can take back.** The original file is kept for the session, so
  **Restore original model** on the object menu puts the full-detail version back — and it
  says why when it cannot, rather than being mysteriously greyed out.
- 🤖 Models an AI generates go through the same gate, because a generated mesh is as heavy as
  any other.

### ⚽ Football has a Games tab template

- ⚽ **Football is a starter you can open**, not only a toolbox recipe: the Games tab now lists
  it beside Towers and the Stars Room, built from the module's own definition so the two can
  never drift apart.

## 1.13.0 — Knock it about 🪐

### ✨ Knock things about (roadmap #24)

- 🌠 **Hit a floating object with your hand and it flies off.** In VR your hands, and on
  desktop the camera you walk with, now knock a physics object at the speed you hit it —
  the first thing a zero-g room needs and the thing grab-and-throw never covered. Configure
  Scene ▸ Physics ▸ **Knock** turns it on for a scene and sets the strength, the reach and
  the spin; it is off in every scene that does not ask for it.
- 💥 **An On Hit node** fires when something is knocked, with how hard (`speed`) and whether
  it was you (`byMe`), so a graph can burst particles in proportion or count only your own
  touches. **Who** can be narrowed to anyone / me / others.
- 🌟 **The Stars Room** — a new template in Games. Twenty-four stars and two planets float in
  a room with no gravity; knock them, watch them chime and drift, add more from the HUD, or
  press Start for a round that ends when every star is lit. Nothing to install.
- 🔄 **Someone joining a running simulation now knows it is running**, so their knocks and
  their grab work from the first second instead of after the next restart.
- 🩹 Fixed on the way: a Player Variable now reaches the node it is wired to, and a colour,
  shader-uniform or device effect keeps working on an object the physics simulation owns.

### 🎨 One scene look, and materials you can share

- 👀 **Watching someone shows you their look.** Watch a peer and you see the camera they are
  looking through, its grade, their view mode and their scene-look switches — the banner says
  when something cannot be adopted. It ends when you stop watching.
- 🌓 **Shader graphs have a Post domain**: build a post-processing effect as a node graph and
  drop it into the scene look. Ships with Posterise, Ordered dither, Edge detect (ink) and a
  graph-built Ambient occlusion.
- 🗂️ **Configure Scene ▸ Scene look** is now one section for the whole look — the post stack,
  the scene's default material and per-object shaders — with a line saying what it costs.
- 🙈 **Scene shaders can be switched off on your own screen** (Configure Scene ▸ View ▸
  Overrides), the way post already could. Nobody else's view changes.
- 🔗 **Duplicate can share a material instead of copying it** (Settings ▸ Scene ▸ Duplicate).
  A shared material carries its link through save, undo, a peer's copy and a late joiner, and
  the Material section has **Unlink** when you want your own again.

### 🧱 Modelling, windows and the node editor

- 🫱 **Proportional editing reaches your peers.** Drag a vertex with a falloff radius and the
  whole neighbourhood now arrives on every other screen (in one step, when you let go) —
  before, only the vertices you had selected moved for anybody else.
- 🔃 **Proportional rotate and scale**, not just move: the falloff blends the turn and the
  scale toward identity across the radius, so a rotation twists the surrounding surface
  instead of leaving it behind.
- 💬 Vertex slide now says why it stands down while a custom pivot is placed, instead of
  quietly doing nothing.
- 🪟 **Two windows on one screen edge.** Drop a second window onto a docked one and the edge
  splits into two stacked panels with a divider you can drag; the share is remembered per side.
- 🖱️ **Settings ▸ Input ▸ Node editor ▸ Mouse bindings** — keep Classic (left-drag pans, as
  always) or switch to Select-first, where a left drag draws a selection rectangle, dragging
  any selected node moves the whole set, and the right button pans.

### ⚽ VR Football (a module)

- 🥅 **Football** is a new game: two floating gates, one ball, red against blue, played with
  your hands. Open **Templates ▸ Games ▸ Football** for a ready-made pitch — loading it offers
  to install the Football module — or install the module from Browse and let its toolbox's
  **Build pitch** lay out the pitch, the gates and the rules in a scene of your own. Goals go
  to whoever touched the ball last, own goals land on the right sheet, and the mode decides
  when the match ends (first to N, a clock, or either). Scores, touches and own goals are per
  player, the gate lamps read from across the room, and a saved scene keeps the match log.
  Two people in one room can play it colocated.

### 🛠️ For people building on it

- 🥊 **`api.onHit(cb)` and `api.hitLog()`** — a module can react to a knock (uuid, who, how
  hard, where) or read the recent ones, which is what the football module's last-touch rule
  stands on.
- 🧩 The template author script gained one graph builder and a remap that resolves every
  object named in node data, so a game def can name objects instead of carrying uuids.

## 1.12.0 — Hold together 🛡️

### 🛡️ Connections that recover, and sessions with a size (roadmap #27 + #25)

- ⏱️ **A connection request now ends.** The pill counts down while you wait and the
  host's card shows how long someone has been waiting. After 90 seconds the request
  cancels itself and offers **Try again**, instead of sitting on *Requesting* for
  ever. Dialling someone who is not online ends the request too, rather than leaving
  it up beside a toast saying they are unreachable.
- 👥 **A session has a size.** Settings ▸ Connection ▸ **Session size** says how many
  people you expect. Past it an approval still works but warns you, and at 16 the
  approve buttons say the session is full — everyone connects to everyone, so one
  more person costs every other person bandwidth. Waiting requests are capped, and
  expired cards are dropped before live ones.
- 🔌 **The signaling link stops giving up.** Reconnection retries with a jittered
  backoff and no attempt limit, a closed peer is rebuilt rather than abandoned, and
  coming back online or returning to the tab retries immediately. The Connect pill
  shows a chip while it is retrying, so a dead link no longer looks like a dead app.
- 🧱 **One bad message can no longer kill a connection.** Everything arriving from a
  peer is shape-checked before it reaches the code that applies it, and anything
  malformed is counted and dropped instead of throwing. A peer sending repeated
  rubbish is reported once, not once per message.
- 🔁 **The editor survives a bad frame.** A throw inside the flow runtime or the
  physics step no longer ends the session: the frame is skipped, the failure is rate
  limited so one broken node cannot flood you, and the runtime can be resumed.
- 🩺 **Diagnostics you can copy.** Settings ▸ About ▸ **Copy diagnostics** puts a
  bundle on the clipboard — recent log entries, the last uncaught error and session
  details — so a problem can be reported with something in it.
- 🔁 **A runaway script no longer takes the room with it.** Script nodes run on every
  peer, every frame, so a `while (true)` in one node used to freeze everybody's tab,
  not just its author's. Every loop a script contains is now counted, and one that
  runs away stops with a *Script loop limit* badge on the node while the scene keeps
  running. A node that is merely slow — rather than infinite — is paused after it has
  spent too long in too many frames in a row, and editing its code starts it again.
- 🧯 **Safe mode.** Adding `#safe` to the app's address opens a scene with the flow
  runtime paused, so a scene whose scripts misbehave on load can still be opened,
  repaired and resumed. A restore that never completed a frame is also remembered: the
  next start offers the prompt with a warning instead of silently loading it again.
- 🧹 **Deleting gives the memory back.** Removing an object used to drop it from the
  scene and leave its geometry, materials and textures sitting on the graphics card
  until the page was closed, so a session that imported and deleted the same model ten
  times paid for ten copies. Deleting, clearing a scene and replacing an object now free
  what only that object was using — and never what something else still draws with,
  which matters because duplicates, clones and a material shared across a selection all
  point at the same resources.
- 🖥️ **A lost graphics context now says so.** When the browser takes the 3D context
  away — a driver update, a graphics reset, a phone under memory pressure — the viewport
  used to freeze silently while the rest of the app carried on answering, which reads as
  the whole thing having crashed. You get a panel explaining what happened, a button to
  save the scene (which is still intact, because it lives in the page rather than on the
  graphics card), and the view restores itself when the browser hands the context back.

### 💾 Storage that keeps your work (roadmap #27, wave 2)

- 💾 **Saving can no longer hang forever.** A database operation that is aborted or
  stops answering now fails and says so, instead of leaving the app waiting on it.
- 🪶 **Autosave stopped stuttering on big scenes.** It measures what saving actually
  costs and spaces itself out accordingly, it can no longer start a second save on top
  of the one already running, and when it cannot save at all it tells you rather than
  going quiet.
- 🕶️ **Settings keep working in Safari private mode and on a full disk.** Every
  preference now goes through one place that falls back to memory for the keys it
  cannot write, so a browser that refuses storage costs you the setting, not the app.
- 🎙️ **The microphone is given back.** Turning voice off, leaving voice mode or leaving
  a session now releases the device, so your operating system stops showing the
  recording indicator. Push-to-talk holds the device for a few seconds between presses
  on purpose — reacquiring it costs a renegotiation with every peer.

### 🚦 A scene that will not freeze you out (roadmap #26)

- 🚦 **A big scene stays responsive while it arrives.** Objects are created in slices
  rather than all at once, the viewport is refreshed once a frame instead of once per
  object, and an object list of thousands of rows draws only the rows you can see.
- 📊 **A Statistics panel, and a budget you can see.** The burger menu ▸ **Statistics**
  opens frame timings, draw calls, triangles, memory and per-message network counters.
  The object count in the status line carries a coloured dot that names whatever is over
  budget, and the numbers ride along in a diagnostics bundle.
- 🛑 **An oversized scene asks before it arrives.** A scene big enough to hurt is held at
  the door with **Open anyway / Cancel** instead of arriving and
  wedging the tab, and opening an oversized file warns you first.
- ⏸️ **A window that cannot keep up pauses instead of freezing.** A simulation that
  falls too far behind stops once, with a Resume button, and a viewport that has stopped
  drawing offers **Save now**, **Reduce** and **Resume** rather than appearing to have
  crashed.

### ⏱️ One clock, and a joiner that is told (roadmap #25 + #26, wave 3)

- ⏱️ **Everyone in a session now shares one clock.** Peers used to stamp events with
  their own machine's time, so anything comparing ages or ordering across peers was
  wrong by the difference between two computers. The session now runs on the host's
  clock, and a machine whose clock is minutes out is corrected on its first exchange.
- 🚪 **A refused join is told it was refused.** Being declined, and arriving at a session
  that is already full, now say so plainly instead of leaving you watching a request
  that never resolves.
- 🎚️ **A heavy scene gives up shadows before it gives up frames.** When a scene is too
  much for the machine, quality is reduced automatically and reversibly — starting with
  the passes that cost the most and show the least — so the room keeps moving. The
  budgets it steers by are measured on real scenes rather than estimated.

## 1.11.0 — Muscle memory ⌨️

### ⌨️ Input parity (roadmap #24, batch A)

- 🌍 **Hotkeys on every keyboard layout.** `G`, `F`, `Ctrl+Z`, WASD and every other
  letter shortcut now work on Russian, Greek, Hebrew, Arabic and CJK layouts (they
  resolve by the key's physical position), while AZERTY, Dvorak and QWERTZ keep the
  labels printed on their keys. Settings ▸ Shortcuts shows your layout's own label
  beside each letter where the browser can tell us.
- 🖱️ **A wheel that zooms on Linux.** Scrolling over the viewport is classified by
  what the device is, not how big one tick was — high-resolution wheels (Steam Deck,
  hi-res mice) dolly again, two-finger swipes still pan. Viewport menu ▸ View ▸
  **Mouse wheel** picks Zoom / Pan / Auto in one click, and Settings ▸ Controls has a
  **Wheel diagnostics** readout of the last eight wheel events for the odd machine.

### 🎯 Selection and windows (roadmap #24, batch B)

- 🔁 **1 / 2 / 3 bring the selection back.** Pressing the active mode key hides the
  gizmo and the selection, as before — and pressing any mode key again brings the same
  selection back in that mode, including a multi-select with the origin you placed
  and a face, edge or vertex pick inside Edit Mesh (the toolbox's gizmo button does
  the same).
- ⌨️ **Keyboard in the object list.** With the list focused, ↑/↓ walk the visible
  tree and select, Shift extends, → expands, ← collapses or goes to the parent,
  Home/End jump, Enter opens Properties, F2 renames, typing a name jumps to it, and
  ↓ from the search box drops you into the list.
- 🪟 **Windows keep their header.** A floating window or module toolbox can no longer
  be dragged so that its header hides under the Controls pill, the bottom band on
  touch and narrow screens, the dock, or a browser overlay — and a tall toolbox near
  the bottom scrolls its body instead.

### 🔗 Invite links (roadmap #24, batch D)

- 📋 **Paste an invite link into the open tab.** `https://…#75F41` pasted over a running
  app now dials that session without a reload. If you are already in a session it asks
  whether to leave first; your own id and the host you are with are refused with a
  message; a link that names another signaling server asks "Join … on that server?"
  and switches on the spot.
- 🔀 **Settings ▸ Connection ▸ Apply** switches the peer server without reloading and
  keeps your session id.

### 💡 Lights, helpers and origins (roadmap #24, batch E)

- 🔦 **Lights aim by rotation.** A directional or spot light shines where it points:
  turn it with the rotate gizmo and the shadow follows. "Aim at" points it once at a
  point you type or pick in the viewport. Old scenes with an aimed spot load aimed the
  same way.
- 🌅 **Lights have an origin.** Give a sun an origin and Rotate swings it around that
  point.
- 🙈 **Helpers hide in Play.** Light helpers, camera frustums and camera markers stay
  out of the game, camera previews and captures; "Show helpers in Play (debug)" brings
  them back with a DEBUG chip.
- 🎯 **Rotate about the origin you set.** Typing a rotation on a group with an origin
  turns it about that origin, a group's origin is one right-click away (Centre of
  children / World zero), and a selection has a pivot point: Median, Active object,
  Parent origin or Individual origins.

### 🖊️ UV painting (roadmap #24, batch F)

- ✍️ **Pen pressure in the UV editor.** Painting with a pen varies the stroke width
  (or, if you prefer, its opacity) with pressure; a mouse stroke is unchanged, and
  peers see the same widths live. Fast pen strokes are smoother too.
- 🩹 Fixed on the way: a pointer stroke in the UV editor painted only its first dab
  and never committed, and a peer watching a live stroke on an untextured material saw
  only its last segment.

### 📋 Explorer: Duplicate, Copy, Cut, Paste (roadmap #24, batch C)

- 📑 **Duplicate, Copy, Cut and Paste in the Explorer.** Right-click a file or a folder
  for Duplicate / Copy / Cut, right-click a folder or the background for Paste — or use
  Ctrl+D / Ctrl+C / Ctrl+X / Ctrl+V with the grid focused, on one card or a whole
  selection. A duplicate lands beside its source as "Tower copy.glb"; a cut row dims until
  you paste it. Prefabs duplicate too; packs stay read-only.
- 🪶 **A copy of a shared file costs your peers no download.** A shared file now travels as
  a row with its own identity beside its content hash, so peers who already hold the
  bytes make the copy from their own disk — ten copies, zero transfers. Deleting a copy
  removes only that copy, and editing one sends its new bytes once.
- 🗺️ **Duplicate a scene or a whole folder.** Duplicate on a scene asks for the copy's
  name (the name lives inside the file) and makes a scene of its own, with its own
  version history. Duplicate on a folder copies everything in it under a new folder —
  share the copy and peers who already hold the files get it for free. The Templates
  window's cards gained a small "save to Library" button that files a starter as a new
  scene without loading it.

## 1.10.0 — Publish, play, remix ☁️

The engine learned the moves a community needs — publish the open scene, open a
published one from a link, play it, remix it — and left every one of them switched off
until a cloud plugin asks. Without a plugin nothing changes.

### 🛠️ For people building on it

- ☁️ **The engine grew the seams a community tier plugs into** (cloudApi v3): build the
  open scene as a publishable `.tpscene` with the facts a card needs, load a published
  scene straight into the editor, read and set the camera (and recall a saved view for a
  hero shot), enter and leave play mode, mount a row under **Save** in the logo menu, and
  swap the Templates ▸ Community source. All inert without a plugin — the app behaves
  exactly as before. See `OPEN-CORE.md`.
- 🔗 **Scene links (`/?s=<id>`) are treated like invites:** the first-run welcome stands
  down so the scene you were sent is the first thing you see.
- 🏆 **Contest starters** for the first two community contests (Make a mirror, Follow the
  beat) are authored with `author-templates.cjs` like every other template.

## 1.9.0 — Plug it in 🔌

Sound stops being something a scene plays at you and becomes something you wire up.
Instruments and effects are objects you place, cables you can see are how they are
connected, and everyone in the room hears the same thing on the same beat. Plus the
first game template that ships as pure data.

### 🎛️ A music playground

- 🔌 **Cables you can see.** A device has inputs and outputs — click one, click
  another, and a wire hangs between them in the scene. Pull it out of an input to
  move it, click that input again to unplug, Escape to put it back. In VR you grab
  the cable and pull it across.
- 🎚️ **Instruments and effects are ordinary scene objects.** Place them, move them,
  group them, save them, duplicate them — a duplicated rig brings its cabling with
  it, and a saved scene carries the whole patch.
- ⏱️ **One clock the room shares.** Tempo, bars and beats are agreed across peers, so
  a pattern started on one machine lands on the beat on every other.
- 🎛️ **A Music toolbox** for device settings, presets and a mixer strip, and a
  Device section in the inspector that fans a knob across everything selected.
- 🎙️ **Record.** Capture the mic, turn a take into a sample, and bounce a looper's
  output into a file the scene carries.
- 🧩 **Four new flow nodes** — Device Param, Device Level, Transport and Note
  Trigger — so a graph can play, tune and read your rack.

> 🎵 **The instruments themselves ship as modules** (a beat lab, a pedal board, DJ
> decks, a voice rack) and are still being polished — this release is the engine,
> the cables and the toolbox they plug into. The **Jam Room** template is ready and
> will offer to install what it needs.

### 🏰 Towers

- 🎮 **The first game template that is pure data** — nothing to install, built out of
  the nodes and the HUD the editor already has.

### 🐛 Fixes

- 🖱️ **Scroll sets your fly speed in play mode again.** The editor's camera was
  quietly swallowing the wheel, so the speed never moved.
- 🔊 **Positional audio no longer hangs off a voice-chat setting.** Switching spatial
  voice off used to freeze the listener and silently break every positioned sound in
  the scene.
- 🎵 The four music nodes no longer claim to come from a module you have not
  installed.

### 🛠️ For people building on it

- 🧰 **`api.registerAudioDevice` and `api.audio`** — a module can add instruments,
  effects and their knobs, and they join the patch like anything else.
- 📦 **Explorer drops onto a module's mesh** (`registerDropHandler`), live parameter
  previews while a knob is turning, and a device kind now tells a scene which module
  it needs.
- 🌐 The templates, modules and packs feeds take a build-time override, so content
  can be tested before it is published.

## 1.8.0 — One library, many rooms 🗂️

The Explorer became shared: what you share, everyone in the session has, in the same
folders, with a recycle bin that works across peers. And the session became a set of
rooms that actually hold — a private scene stays private, an unnamed world is a place of
its own, and nothing crosses between rooms until somebody chooses to go.

### 🗂️ A library the whole session shares

- 📤 **Share a file or a folder** and every peer gets it, in the same place. Sharing a
  folder shares what you drop into it later; a per-file "not this one" is honoured.
- ⬇️ **Downloads happen by themselves** (switch it off for a metered connection), with a
  transfer log that shows per-file and overall progress.
- 🗑️ **Delete for everyone, with a recycle bin.** Deleting a shared file or folder moves
  every peer's copy to Deleted instead of destroying it. Deleted keeps the folder
  structure, so a folder comes back as a folder — into the place it came from, on every
  peer — and you can drag a file out of Deleted onto a Library folder to restore it there.
- 🧹 **"Clear the log" clears only the record** of files whose bytes are already gone;
  "Empty Deleted" remains the one that frees the disk.
- ❓ **Ask before sharing.** Add a file mid-session and a strip below the Library asks
  whether to share it, with a one-box rule for everything you add from now on.

### 📋 The Explorer as a file browser

- 📑 **A list view** with sortable, resizable, reorderable columns, remembered per view.
- 🖼️ **A real preview window**: images, sounds with a player, 3D models with a turntable
  and an animation transport, folders you can page through — several windows at once
  if you like, and a window you can fade and click through to model against.
- 💾 **Save as…** a prefab in its own format, and prefabs that are files.
- 🗄️ **Mount a saved project** beside your Library and browse it, edit it, save it back.
  A storage panel shows what is using the disk and lets you reclaim it.
- 📦 Sessions download as `.tpscene`, projects as `.tp`, and both import back.

### 🚪 Rooms that hold

- 🔒 **Edit a scene privately.** Opening a file the session has never seen asks: share
  it, or keep it on this machine. A private scene's name never leaves, peers see only
  "in a private scene", and they can ask you for it.
- 🧭 **The unnamed world is a room too.** Sharing a private scene no longer spills edits
  into a host who never saved anything, and a Join button takes you back to the
  session's world.
- 📛 **Saving names the room** — everyone standing in an untitled world takes the name.
- 🤝 **Joining is a decision, not a merge.** Connect with unsaved work and you choose:
  save it and join, dismiss it, or don't connect.
- 🔀 Diverged scene versions are merged by history and the winner is named.

### 🎛️ Controls, docks and phones

- 🧰 **The bottom dock was rebuilt** — a dock that rides above the viewport, one toggle per
  panel, the Explorer as a tab, a play-mode menu, a roster pill, and shortcuts you can
  rebind.
- 📱 **Colocation and room-scale AR**: several headsets share one physical room.
- ✨ A round of review fixes: dock tab order, mounted scenes opening into the viewport,
  toast outlines, menu icons, the Library that could not be squeezed out of the tree.

## 1.7.0 — Make a game, keep a project 🎮

The biggest release so far. You can build and play an actual game now — a HUD you
draw, logic nodes, a gamepad, a character controller — and the files behind it
finally behave like a project: named scenes you travel between, version history you
can go back through, and a session where everyone can see what exists and who is
where.

### 🎮 Games you can actually play

- 🖼️ **A HUD editor.** Draw menus, scores, bars, timers and lists on a 2D artboard
  and they render over your scene. Text, buttons, sliders, toggles, dropdowns and
  text fields; screens that show themselves at the right moment; and a HUD can belong
  to a camera, so looking through it brings its overlay.
- 🔌 **Bind a button to something in two clicks.** The Actions panel builds the nodes
  and the wiring for you — start the game, play an animation, fire an impulse, set a
  variable.
- 🧠 **The logic nodes game loops are made of** — latch, delay, sequence, once,
  counter with reset, a four-way select. Plus a real **pause** that pauses: physics
  stops, spins hold still and resume without a jump, menus keep working.
- 🎯 **A game shell**: state, rounds, outcomes and variables that every peer agrees
  on, with per-player variables for scores that are yours alone.
- 🎮 **Gamepad support**, and a **character controller as nodes** — walk, jump,
  camera follow, move speed, all authorable.
- 🏆 Collectibles, leaderboards, respawn, and a walkthrough on the docs site.

### 🗺️ Scenes, and travelling between them

- 🎬 **A scene is a file you can open, save and travel to.** Save the scene you are
  in, make another, and move between them — by hand, or with a Travel node that
  takes everybody together.
- 🕘 **Version history.** Every save keeps the one before it. Browse them, name them,
  pin them, restore one — nothing is destroyed by going back — and download the lot
  as a .zip. One card per scene instead of a shelf of look-alikes.
- 📦 **A whole project as one `.tp` file** — scenes, versions, library and all — to
  hand over or keep as a backup. Import one alongside yours, or open it to switch.

### 🗂️ The Explorer grows up

- 🧊 **Prefabs live here now**, with previews, export and the same menu everything
  else has.
- 🖱️ **Select more than one thing** — marquee, batch download, batch delete, drag
  several at once — and rename in place instead of through a browser prompt.
- 🏷️ **A Project ▸ Scene chip** beside the search says which project and scene you
  are in, and clicking the scene name takes you to its file.

### 👥 Everyone in one session

- 🌍 **Project scenes show up for every peer**, even before they hold the file —
  open one and it downloads from whoever has it. A scene somebody else creates no
  longer just fails to appear.
- 📍 **See who is in which scene**, right in the peer list. A peer in another scene
  is not drawn in your viewport and cannot be watched — with the reason on the
  button, not a dead control.
- 🚪 Rooms are simply who is where: one session, one project, several scenes.

### 📁 Files that behave

- 🧾 **A file you dragged in is yours, not the project's.** Opening one and editing
  it no longer quietly invents a project scene under a name you never chose; the
  first edit offers to save it in.
- 👯 **Importing something you already have says so** instead of silently doing
  nothing — skip it, or take a real copy. Settings ▸ Files has the rule.
- 💾 **Opening a scene over unsaved work always asks**, from the menu as well as a
  double-click, and it asks about brand-new scenes too.

### 🌄 Worlds

- ⛰️ **Procedural terrain** from a seed, and **splines** you can draw, edit forever
  and edit in VR.
- 🛣️ **Flatten** works both ways: carve a bed into the terrain along a spline, or
  drape the spline onto the ground. Pick the partner with a click.

### 🧲 Physics you can play with

- ✋ **Play mode is interact mode** — a reticle, grab, carry and throw, with the
  throw a peer sees smoothed rather than stepped.
- 🌍 Scene ground, out-of-bounds rules and the physics defaults worth having.
- 💥 **Physics nodes**: impulse, set velocity, on rest, measure, joint — and a
  **spawner** that can create bodies mid-simulation.

### 🎥 Looks

- 🎨 **A camera can carry its own look**, so switching cameras switches the grade,
  and a Set Look node can turn one on from a graph.

## 1.6.0 — Measure twice 📐

Numbers you can drag and type in your own units, copies that bring their behaviour
with them, a workspace that comes back when you ask for it, and a proper way to
select more than one thing — including on a phone.

### 📐 Units

- 📏 **Work in cm, mm, inches or feet.** Settings ▸ Scene ▸ Units picks how
  distances and angles are shown — positions, snapping steps, bevel widths,
  rotations. The scene itself is unchanged underneath; this is how you read it.
- ⌨️ **Or just type the unit.** `12cm`, `4in`, `1.5ft`, `2'`, `6"`, `90deg`,
  `1.57rad` — any numeric field takes a suffix and converts it, whichever unit is
  currently on display.

### 🖱️ One numeric field, everywhere

- 🎚️ **Drag to scrub, type to set** in node editor cards, shader nodes and the
  animation window — the same control the properties panel already had, with
  <kbd>Ctrl</kbd>/<kbd>Shift</kbd> for bigger and smaller steps and <kbd>Esc</kbd>
  to put it back.
- ↩️ **Scrubbing an animation key or a shader value is ONE undo step**, not one per
  pixel.

### 📋 Duplicate brings its behaviour

- 🧬 **A copy gets its own animation clips, object flow and shader graph.** Duplicate
  an animated, flow-driven, shader-driven object and the copy plays, runs and renders
  on its own — a copy of a shader-driven object used to come out frozen. Each carrier
  can be switched off in Settings ▸ Scene ▸ Duplicate.

### 👆 Selecting more than one thing

- 🔲 **Box-select mesh vertices, edges and faces.** Hold <kbd>Shift</kbd> or
  <kbd>Ctrl</kbd> and drag inside Edit Mesh — the same gesture that boxes objects in
  the viewport now boxes elements, in all three modes.
- 📱 **Touch tools.** Round Undo, Redo and Multi-select buttons beside the logo, on
  by default on phones. With Multi-select on, a tap ADDS to the selection and a drag
  on empty space boxes — for objects and for mesh elements, no keyboard needed.

### 🗂️ Your workspace, when you ask for it

- 🪟 **Restore brings your windows back.** Restoring a session — or loading a scene
  file — reopens the panels you had open and reselects what you had selected, and
  resumes an open Edit Mesh or Sculpt session with the elements you had picked. A
  plain page reload still starts clean.
- 🌳 **A Graphs list in the node and shader editors.** The objects that actually have
  a flow or a shader, with Scene at the root — click one to jump to its graph. Drag
  the bar under it to give the list more room.

### 🛠️ Also

- 🎨 Modules can add their own post-processing effects and shader compilers.
- 🧹 Settings descriptions read as sentences again instead of one word per line.

## 1.5.0 — Move it, properly 🎬

Animation you can trust: movements play from where the object actually is, pause
stops where you pressed it, edits show up the moment you make them, and the
channels that quietly did nothing now work.

### 🎬 Animation

- 📍 **Movements play from where the object is.** Move something after animating
  it and the clip runs from its new home instead of snapping back to where you
  first keyed it. *This changes clips you have already saved* — a door authored at
  the origin now opens wherever it stands.
- ⏸️ **Pause stops where you pressed it.** Pausing after the first loop used to
  jump to the last frame (or the first, playing backwards) and the timeline lost
  its place. Playing backwards pauses on a second press, too.
- 👀 **Edits show immediately.** Adding a channel, typing a key value, retiming or
  moving a marker re-poses the object there and then — no clicking the timeline to
  find out what changed.
- 🎨 **Recording catches colour and material edits as you make them.** With REC on,
  changing a colour or roughness in the properties panel keys it straight away
  instead of waiting until you clicked the object again.
- 🔴 **REC with no clips does the sensible thing** — the first change you make
  creates the clip, and says so.
- 🌑 **Fade, roughness and colour channels actually move.** A new track's second
  key was out of range for anything measured 0 to 1, so adding an Opacity channel
  did nothing at all.
- ✨ **Emission works, and it is yours to colour.** The glow channel had no colour
  to light up; now it takes the object's own, and the properties panel has a single
  **Emission** block — Strength and Colour — in place of the two overlapping ones.
- 🧅 **Onion skin reads as onion skin.** Ghosts sitting exactly on the object used
  to look like a second solid copy, and near-coplanar ones flickered against it.

### 🖱️ Selection

- ⌨️ **Ctrl+A** selects everything (and leaves mesh editing alone, where it still
  means "select all elements").
- 👆 **Double-click does what you choose** — open properties (the default), edit
  the mesh, select everything of the same kind, or focus and isolate.
- 🔍 **Tiny things stay clickable.** An object animated down to nothing gets a dot
  to aim at, so it can be picked in the viewport instead of only from the object
  list.

### 🧊 Bigger meshes

- 📈 **The mesh limits were measured, not guessed** — editing, unwrapping, UV
  dragging and sculpting now work on models roughly thirty times denser than
  before. Big edits still replicate; only the live preview of a gesture is kept
  local so the session stays smooth for everyone else.
- 🔧 **Edit Mesh opens on more models out of the box** (the limit moved from 1000
  to 2500 triangles, and it is still yours to raise in Settings).

### 🩹 Fixes

- 🖼️ **The edit wireframe no longer leaks into prefabs, sleeve slots, shared
  objects or imported files** — the last four paths it could be saved through.

## 1.4.0 — Move it 🎞️

An animation release. Objects can be keyframed now — real clips with a timeline,
curves and markers — the mesh tools apply and then let you tune the result, and
everything snaps to the geometry that is already there.

### 🎞️ Animation (new)

- 🎬 **Clips** — give an object named animations and keyframe its position,
  rotation, scale, visibility, colour, opacity, glow and light intensity.
- 📊 **A real timeline** — a dope sheet and a curve editor in one window: zoom,
  pan, box- or lasso-select keys, drag them, and set an A/B window to loop just
  the part you are working on.
- ✏️ **Easing you can grab** — pull the curve handles straight on the graph, or
  type the numbers.
- 🔴 **Auto-key** — switch it on and posing an object records the key for you.
- 🧅 **Onion skin** — faint ghosts of the keys either side of the playhead.
- 📌 **Markers** — name a moment in a clip and have a flow node fire when the
  playhead crosses it.
- 🎛️ **Presets** — door, drawer, elevator, turntable, pulse and blink, ready to
  drop on any object.
- 📤 **Export** — clips bake into the glTF you save.
- 🔗 **Flow nodes** — play a clip on click, react when one finishes, read its
  progress, or trigger on a marker. Everyone in the session sees the same thing
  at the same time.

### 🧰 Mesh tools that adjust

- 🎯 **Apply, then tune** — clicking bevel, loop cut or bridge does the thing
  immediately and turns the panel into a live adjust panel: change width, cuts
  or twist and watch it re-run. ✕ puts it back.
- 🎚️ **Real parameters** — bevel width in world units with an in/out shape,
  extrude each face on its own, inset depth, where a loop cut sits and which way
  it runs, bridge twist, cuts and flip, subdivide levels.
- 🎈 **Proportional editing everywhere** — vertices, edges and faces, with a ring
  on the model showing the falloff. The wheel resizes it mid-drag.
- ➕ **More operations** — extrude and subdivide edges, delete edges or vertices,
  duplicate faces, smooth a selection, triangulate, and turn triangles back into
  quads.
- 🎯 **Your own pivot** — transform a multi-selection about its centre, or drag
  the gizmo to park the pivot exactly where you want it.
- ↩️ **Undo and redo in the toolbox**, next to the tools.

### 🧲 Snapping

- 📍 **Snap to what is there** — vertices, edges, faces, surfaces or whole
  objects, with the target highlighted as you drag.
- 📐 **Align to a surface** — drop an object onto a face and let it take that
  face's angle.
- ⚓ **Pick your snap point** — click any point to snap FROM there instead of the
  object's centre.

### 🗺️ UV editor

- 🔀 **Move, rotate and scale** the map on 1 / 2 / 3, by drag, by a grab that
  follows the pointer, or with the arrow keys in exact texture pixels.
- ⌖ **A pivot you place** — drop the transform origin where you want it and drag
  it around.
- ⌨️ **Keyboard picking** — walk the points with the arrows and take them as you
  go.

### 🪟 Windows, toolbox & settings

- 🧰 **The mesh toolbox, redesigned** — element modes as tabs, the options for
  the tool you picked right under it, collapsible sections for whole-mesh work,
  and a new icon set. On a phone it becomes a bottom sheet.
- 📏 **Windows stay reachable** — no window can be sized past the screen any
  more, and double-clicking its corner resets it.
- 💾 **Pick up where you left off** — an option to restore your last scene
  automatically when the app opens.
- 🎨 **Your colours** — set the wireframe, selection outline and edit overlay
  colours.

### 🩹 Fixes

- 🖼️ **The edit wireframe is no longer saved into your scenes** — it used to be
  written into the file as a real object and come back as a permanent wireframe
  that stacked up on every save.
- ⌨️ **Tab switches element modes** while editing a mesh, so 1 / 2 / 3 stay move,
  rotate and scale like everywhere else.
- ❌ **Cancel is not a second undo** — it ends the session and restores the mesh,
  and now looks different from the undo button beside it.
- 🎙️ **Ctrl+V no longer opens the mic** — push-to-talk is a bare V hold.

## 1.3.0 — Shape it ✂️

A modelling release. The mesh tools grew up — bevel, knife, mirror, loops and
proportional editing — the app finally *remembers* your mesh's faces instead of
guessing them from triangles, and there is a whole new UV editor for laying out
and painting textures.

### ✂️ Mesh editing

- 🔷 **Edges are a real mode** — select them, walk a loop or a ring, dissolve
  them, and drag them with the gizmo like anything else. Press 1 / 2 / 3 to
  switch between vertices, edges and faces.
- 🪒 **Bevel** — round off a face, an edge or a corner, with width, segments and
  a shape control.
- 🔪 **Knife** — draw a line across the model and it cuts every face it crosses,
  with a rubber band showing where the cut will land.
- 🪞 **Symmetrize** — model one half, mirror it onto the other.
- 🎈 **Proportional editing** — move one vertex and its neighbours follow, fading
  off with distance.
- ➰ **Loops** — loop select, loop cut, grow and shrink a selection, select all,
  invert, or grab everything connected.
- 🎚️ **Vertex slide** — slide a vertex along its own edge instead of freehand.
- 🧮 **Clean-up** — recalculate normals, merge vertices by distance, and switch a
  mesh between smooth and flat shading.
- 🧩 **Quad picking** — clicking a face picks the quad you see, not one of the two
  triangles behind it.
- 🧰 **Real toolbars** — mesh edit and sculpt are proper tool palettes now: drag
  them, resize them, and read the shortcut cheat sheet next to them.
- ↩️ **Undo that fits the job** — selections undo too, a whole edit session
  collapses into one step when you finish, and Cancel puts the mesh back exactly
  as you found it.
- 👓 **Display options** — the selection outline steps out of the way while you
  edit, and the wireframe shows your quads rather than the raw triangles (the
  triangles are one toggle away).
- 🔗 **Convert to mesh** — turn a group or a whole selection into a single
  editable mesh, materials intact, in one undo step.

### 🧠 Your mesh remembers its faces

The app used to work out what a face was every time, by looking for triangles
lying flat against each other. That guess broke the moment you rotated an
extruded band, and the loop tools would quietly refuse to work. The face
structure is stored with the mesh now: the tools keep working after any edit,
and faces with more than four corners are finally a real thing.

### 🗺️ UV editor (new)

- 🧭 **A UV tab** — see how a texture wraps your model, and drag, box-select or
  lasso the points to fix it.
- 📐 **Unwrap** — box, planar, cylindrical and spherical projections, packed into
  the square for you, and it can unwrap just the faces you have selected.
- 🏝️ **Island tools** — rotate, flip, scale and fit a chunk of the map; select
  everything connected to what you picked.
- 🖌️ **Paint on the texture** — paint straight onto the model or the UV map, live
  for everyone in the session, one undo per stroke.
- 🎨 **Material slots** — a mesh can carry several materials, and you can assign
  faces to a slot and give each slot its own texture.
- 🔍 **Texture panel** — see a texture's size and cost, resize it, and switch on a
  test grid to spot stretching.

### 📦 Modules

- 🛍️ **Browse gallery** — a Browse tab in the modules manager lists everything
  published in the module gallery, one click to install.
- 🚚 **More in the gallery** — the piano, avatar, car, essentials and dungeon
  generator moved out of the app and into it, so the app starts leaner and they
  can improve on their own schedule.
- 🔁 **Live reload for authors** — point the manager at a local dev URL and your
  module reloads as you save it, disposing the old version cleanly.
- 📊 **Clearer installs** — progress, what actually landed and why something
  failed, right under the field.
- 🧱 **A world-building API** — modules can create objects, move them, set up
  physics and joints, follow a camera and read VR hands, without reaching into
  the app's internals.

### 🪄 Editing & scene

- 🎯 **The properties panel edits your whole selection** — change a colour,
  material or physics setting once and it applies to everything picked, as a
  single undo step. Values that differ show a dash.
- 📍 **Every object has its own origin** — set it to the bottom, the centre, the
  world, or place it by hand, and everything rotates and hinges around it.
- 🎞️ **FBX animations** — imported `.fbx` clips play, and an `.obj` picks up its
  `.mtl` materials.
- ⚡ **Faster picking** — clicking around a heavy scene is noticeably quicker.
- 🗂️ **Templates** — start from a ready-made scene: general starters, worked
  examples, and a community tab.
- ⚙️ **Settings, reorganised** — the overgrown Scene section split into Interface,
  Controls and Scene, and the search box has a clear button.

### 🌐 Sessions

- 👥 **Bigger sessions hold together** — everyone now really connects to everyone
  in a busy room (past five or so peers, some links used to be dropped while they
  were still forming).
- 🩹 **Blips heal** — a peer who drops for a moment reconnects instead of being
  torn out of the session, and a disconnect no longer frees other people's locks.

### 🧹 Fixes & housekeeping

- 💾 Saving a scene no longer kills its animations — imported clips and animations
  you authored both come back.
- 🖼️ Editing a textured model keeps its texture mapping, and painting an imported
  model no longer mirrors or untiles its texture.
- ↪️ Redo puts a created object back where you placed it, not at the world centre.
- 🧰 Under the hood: Vite 8 and a dependency refresh.

## 1.2.0 — Make it real 🔨

The biggest release since 1.0: physics you can shape, cameras you can frame,
notes you can actually read, and an assistant that builds behaviour instead of
just objects.

### 🧱 Physics & colliders

- 🧊 **Colliders v2** — pick a collision shape per object (or let it infer one
  from the geometry), see it as a wireframe, and change it **while the simulation
  runs** — joints and momentum survive the swap.
- 🚪 **Sensors** — mark a collider as a trigger volume: things pass through it and
  your flow gets Enter/Exit events.
- 🧪 **Materials & gravity** — ice, rubber, wood and metal presets, per-axis
  freeze, and a scene-wide gravity setting.
- 🔗 **Custom colliders** — hand-build a collision hull with the real mesh tools,
  in several separate pieces if the object needs it.
- 🎛️ **Physics nodes** — mass, bounciness, friction, angular velocity, motors,
  collider overrides, velocity readouts and impact/enter/exit events.

### ✂️ Modelling

- 🔺 **Edit Mesh Pro** — pick by face, triangle, connected shell **or the whole
  object**, then subdivide, flip, weld or bridge. Bridging two faces builds a
  watertight connector.
- 🖌️ **Sculpt any mesh** — the terrain brush now works on everything: raise,
  lower, smooth and flatten along the surface.
- 🧰 **Floating toolbars** — mesh edit and sculpt became draggable windows with
  keyboard shortcuts, and both show a contrast wireframe while you work.

### 🎥 Cameras

- 📸 **Camera objects** — place a camera in the scene, look through it, and frame
  a shot with letterbox guides.
- 🖼️ **Picture-in-picture** — watch a camera's view in a small window while you
  keep editing from your own viewpoint.

### 📝 Scene notes

- 🏷️ **Notes have substance** — a name, a description, a colour, a label and a pin
  shape, grouped by label in the notes drawer with arrows to walk through them.
- 📍 **Markers that behave** — a marker is never sliced in half by geometry again:
  it sits beside its exact spot on a thin leader line, dims when it is genuinely
  behind something, and crowded pins collapse into one badge that spreads out when
  you click it.
- 🎬 **Save a viewpoint** — store the camera framing with a note, and optionally
  let the camera **ride the note** as its object moves (Esc lets go).

### 🤖 Assistant

- 🧠 **It builds behaviour now** — the assistant can wire flow nodes, and with the
  physics tools switched on it can set up bodies, joints and simulations.

### 🧭 Interface

- 🗂️ **Context menus, redesigned** — grouped sections, icons, shortcut hints, and
  type-to-filter on the long ones.
- 🔢 **One number field everywhere** — drag to scrub, type with live updates, arrow
  keys step (hold Ctrl or Shift for bigger jumps).
- 🔔 **Calmer notifications** — one toast stack with an informational style, and
  the first-run and restore prompts now live in it like everything else.
- 📱 **Install it** — theprototype.app can be added to your home screen and
  launches standalone.
- ⭐ **Stars** — the welcome card shows the project's GitHub star count.
- ⌨️ **Menus by keyboard** — arrow through them, search them, and jump straight
  into a settings section from a link.

### 🥽 VR

- 🎒 **Sleeve palette** — a strip of ghost primitives on your forearm: drag one
  off, size it with the stick, drop it in the scene. Your own prefabs can live
  there too. (Off by default, in Settings ▸ VR.)

### 🧹 Fixes & housekeeping

- 🖱️ Shift-click multi-select, the gizmo after an inset or extrude, and dragging a
  whole shell all behave again.
- 🎨 The colour pickers apply colours again, with hex/RGB/HSV entry.
- 💾 Notes survive a reload, and a restored scene keeps its notes and flows.
- 📵 Ambient occlusion no longer starts on phones, where some drivers freeze the
  viewport with it — and the "old browser" notice now reads your real version.
- 👁️ Object-list rows show their eye / properties / delete buttons on hover again,
  and on a touch screen they stay visible — with a long press for the row menu.
- 📱 Dragging a window off the edge no longer drags the Connect bar, profile button
  and corner buttons along with it.
- ⌨️ On a phone the "+" menu and Settings search no longer pop the on-screen
  keyboard — a real (Bluetooth) keyboard still types straight into the filter, and
  Settings search filters again.
- 🎨 Opening Configure Scene no longer repaints a freshly added object.
- 🧰 Under the hood: three.js 0.185, Threlte stable, a rewritten flow editor
  (xyflow 1.x), Tailwind 4 with native dialogs, Vite 7 and Node 24.

## 1.1.0 — A sharper coat of paint 🎨

- ✒️ **New icon system** — crisp SVG icons (Lucide) everywhere, with meaningful
  colors: amber folders, tinted file types, red for anything destructive. Every
  theme (including 8-bit and your custom ones) controls the palette.
- 🖐️ **Trackpad navigation** — two-finger swipes pan the camera, pinch zooms,
  and the page itself never zooms by accident. Direction, pan and pinch are all
  configurable in Settings.
- ⏳ **Loading feedback** — dropping a pack model shows a loading toast, pack
  lists show a spinner on first open (no more stale flashes), and attribution
  opens instantly.
- ▶️ **Play button polish** — cleaner look, whole-button hover, and its
  neighbors no longer lose clicks to it.

## 1.0.1 — Going public 🌍

The engine is now open source (MIT): [github.com/theprototype-app/core](https://github.com/theprototype-app/core).
Star it, fork it, break it — bug reports and modules welcome.

- 📜 **Community files** — a contributing guide, code of conduct and security
  policy now ship with the repo.
- 🤖 **Agent-ready docs** — llms.txt links the public repository, README and
  module guide, so your coding agent can find its way around.
- 🏷️ Package metadata cleanup (name, license, repository).

## 1.0.0 — First release 🎉

The first tagged release. Everything below is in the box.

### 🧊 Build in 3D, together

- **Peer-to-peer sessions** — share a peer ID, approve the request, and everything
  you do shows up for everyone. No server holds your scene.
- **Objects & materials** — primitives, imports (`.glb/.gltf/.obj/.stl/.fbx`),
  groups, duplicate, snapping, measuring, per-object locks and multi-select.
- **Mesh & face editing** — push vertices, extrude/inset/move faces, and sculpt
  terrain with brush tools. Topology edits replicate as full geometry snapshots.
- **Voice chat & pings** — spatial voice, chat, cursors, ping markers and
  annotations so you can point at things while you talk.

### 🕹️ Make it move

- **Flow editor** — a node graph that drives the scene: events, effects, physics,
  sound, scripts. Every object can carry **its own graph**, and object flows can be
  embedded in the scene graph as nodes.
- **Physics** — rapier bodies, joints (weld/hinge with motors), drag & throw, and a
  simulation HUD. Flow-animated objects become kinematic bodies automatically.
- **Modules** — loadable play content with a documented SDK. Ships with a dungeon
  generator, piano, pong, a drivable car, avatars and clickable essentials.

### 🥽 VR

Full WebXR editing: hands **and** controllers, teleport/fly locomotion, grip-grab
world panning, a radial menu, follower panels you can grab and pose, a laser
keyboard, and in-headset mesh editing.

### 🤖 AI (bring your own key)

- **Scene assistant** — an OpenAI-compatible chat that can actually build: create,
  move, style and wire up objects, with one-click undo for a whole batch.
- **Text to 3D** — generate meshes through ComfyUI/TRELLIS or Meshy and drop them
  straight into the scene.

Both are opt-in and configured in **Settings ▸ AI** — nothing is sent anywhere
until you add an endpoint.

### 📦 Assets & files

- **Explorer** — a local asset library (IndexedDB) with folders, thumbnails,
  content-hash dedupe, 3D previews and drag-out placement.
- **Packs** — built-in asset packs, plus any pack from a `.zip` or a URL.
- **`.tpscene`** — the scene format: objects, flow graphs, annotations, joints and
  the assets they use, in one file. Autosave keeps a local snapshot too.

### 🎨 The app itself

Themes, camera bookmarks, view modes (shaded / AO / wireframe), a notification
centre, floating dockable windows, keyboard shortcuts you can look up, and a
responsive layout that works down to a phone.
