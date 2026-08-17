# Changelog

<!-- This file is rendered INSIDE the app (What's new, from the logo menu) as well as
     on GitHub, so keep entries short, human and emoji-led: one "## <version>" heading
     per release, newest first. HTML comments like this one are stripped before
     rendering, so maintainer notes stay out of the user-facing window. -->

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
