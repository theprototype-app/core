# Changelog

<!-- This file is rendered INSIDE the app (What's new, from the logo menu) as well as
     on GitHub, so keep entries short, human and emoji-led: one "## <version>" heading
     per release, newest first. HTML comments like this one are stripped before
     rendering, so maintainer notes stay out of the user-facing window. -->

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
