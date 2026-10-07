# Settings inventory — R21 Settings redesign (step 1, for review)

Lane `37-settings`, core `feat/37-settings`, base 1.25.0 (f2be8687). Spec:
`cloud/plans/core/lanes/37/settings-redesign/SPEC.md` + roadmap 38 handoff SPEC §1–§3.

**What this is.** Every category, section, setting and submenu in the Settings window as of 1.25.0: what it is called
today, what control it uses, its scope, and where its value is stored. Each row also shows the planned new label, control
and section. **Nothing about what a setting stores or does changes.** Only the layout, grouping, control type and copy do.
After the redesign, a test walks this table and checks that every storage key still reads and writes the same values.

**How to read the tables**

- **Scope**: `D` = this device only (local preference, never sent or saved into a scene). `S` = shared (other people see
  the effect, or it travels with your identity). `—` = an action (a button that does something, stores nothing).
- **Store → key**: the Svelte store the row binds, then the exact `localStorage` key (through `safeStorage`) it persists
  under. `(json)` = the value is a JSON object, and the row writes one field of it. `(idb)` = IndexedDB.
- **Now** / **New**: control types. `toggle` (switch), `check` (checkbox), `select` (dropdown), `seg` (segmented),
  `range` (slider), `num` (number field), `text`, `color`, `btn` (button), `nav` (NavRow → a sub-page), `info` (text only).
- **New label** is left blank when the label stays. New descriptions are one sentence each. The full copy is in the
  migration commits. Each new description says what the setting does, not how it is built.
- A row whose label changes keeps its **old label as a search keyword**, so searching the old name still finds it.

---

## 1. Navigation (all categories)

| Today (sidebar order) | New group | New position | Deep-link key (`settingsSection`, unchanged) |
|---|---|---|---|
| Interface | General | 1 | `interface` |
| Controls | General | 2 | `controls` |
| Input | General | 3 | `input` |
| Touch controls | General | 4 | `touch` |
| Shortcuts | General | 5 (moves up from 12th) | `shortcuts` |
| Scene | Workspace | 6 | `scene` |
| Explorer | Workspace | 7 | `explorer` |
| Node types | Workspace | 8 (moves above Export) | `nodetypes` |
| Export | Workspace | 9 | `export` |
| VR | Devices & services | 10 | `vr` |
| AI | Devices & services | 11 | `ai` |
| Connection | Devices & services | 12 | `connection` |
| About | **About & what's new** (pinned to the bottom, unread dot = `whatsNewUnseen`) | 13 | `about` |

- **Desktop (≥ 640 px)**: the left menu is grouped under small uppercase headers. Search moves into the modal header. The
  content column is about 660 px max. A submenu opens as a sub-page in the content area, with a breadcrumb
  ("VR › Remap buttons") and a back button.
- **Mobile (< 640 px)**: the horizontal category chips are removed. Screen 1 shows the "Settings" title, a close button,
  a full-width search field (16 px text) and the categories as grouped NavRows (52 px tall). Tapping one pushes the
  category page ("‹ Settings · Title · ✕"). A submenu pushes again ("‹ VR").
- **Search**: results become a list of matching rows. Each result shows its path ("Interface › Sound") and jumps to the
  row. Every row label, every registered `keywords` list and every old label stays searchable.

## 2. Footer and destructive actions

| Today | Where it goes | Behaviour |
|---|---|---|
| Footer **Reset settings** (`safeStorage.clear()`: wipes **all** of this browser's local storage for the app, including window positions, Explorer column widths and AI keys; **no confirmation** today) | Each category gets a quiet footer link, **"Reset ‹Category› to defaults"** (desktop: bottom left in the warning text colour; mobile: end of the page). It asks for confirmation and clears only the keys listed in that category's table below. **About › Danger zone › "Reset all settings"** keeps today's wipe-everything behaviour, now behind a confirmation. | Category reset is new, as the spec requires. Reset all = unchanged, plus a confirmation. |
| Footer **Clear saved session** (`clearSavedSession()`: deletes the autosave snapshot, idb `latest`) | **About › Danger zone**, with a confirmation | Unchanged, plus a confirmation |
| Footer **What's new** (closes Settings, opens the What's new dialog) | **About & what's new › What's new**. It opens as a sub-page inside Settings, showing the same changelog. The logo menu entry keeps opening the stand-alone dialog. | Same content and the same "seen" bookkeeping |
| (none) | Desktop footer right: "Changes save automatically" + a primary **Done** (closes). Mobile: the note sits at the end of each page. | — |

The sticky footer with three big buttons is removed.

## 3. The categories

### 3.1 Interface — "How the app looks, sounds and greets you."

| # | Section now → new | Current label | Now | Scope | Store → key | New label | New | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | Appearance | Allow text selection everywhere | toggle | D | `allowTextSelection` → `allowTextSelection` | | toggle | |
| 2 | Avatars | Your character | btn "Customize character…" | — | opens Character panel (closes Settings) | | btn "Customize" | |
| 3 | Avatars | Show everyone as classic heads | toggle | D | `peersAsClassic` → `avatars:peersClassic` | Show others as classic heads | toggle | badge *This device* (replaces "On this device only") |
| 4 | Appearance | Theme | select (Dark, Light, Green console, 8-bit, High contrast + custom) | D | `theme` → `theme` | | select | badge *This device*. 5+ options, so it stays a dropdown (see Decision A). |
| 4b | Appearance | **NEW** (NOTES-38 #19) | — | D | `uiDensity` → `ui:density` (absent = Comfortable) | Density | segmented Comfortable / Compact (on its own line on a phone) | badge *This device*. Intentional NEW row, not in 1.25.0: Compact sets `data-density="compact"` on `<html>` (desktop only; phones keep 44 px targets). |
| 5 | Appearance | Custom theme | 2 btns + chips of loaded themes (✕ removes) | D | `customThemes` → `customThemes` | | btn pair "Export" / "Load file…" (wide), loaded themes as removable chips under the row | |
| 6 | Sound *(section badge This device)* | Game sounds | range 0–1 (% in the description) | D | `gameSoundVolume` → `game:soundVolume` | | range + mono readout "80%" | |
| 7 | Sound | Music | range 0–1 | D | `gameMusicVolume` → `game:musicVolume` | | range + mono readout | |
| 8 | Notifications | Welcome on start | toggle + "open it now" link | D | `showWelcomeOnStart` → `showWelcomeOnStart` | Welcome card on start | toggle; link "Open it now" in the description | |
| 9 | Notifications | Announce new versions | toggle | D | `showWhatsNewNotice` → `showWhatsNewNotice` | | toggle | |
| 10 | Notifications | Toasts in drawer only | toggle | D | `toastsInDrawerOnly` → `toastsInDrawerOnly` | Show pop-ups only in the drawer | toggle | |
| 11 | Notifications → **Tours** | Show tours automatically | toggle | D | `tours.autoStartEnabled` → `toursAutoStart` | | toggle | |
| 12 | Tours | VR welcome | btn "Start VR welcome" + status text | — | `startVRWelcome()`; status from tour records | VR welcome tour | btn "Start"; status ("Not seen yet") as the row value | |
| 13 | Tours | Editor tour | btn "Start editor tour" + status | — | `startEditorTour()` | | btn "Start"; status as value | |
| 14 | Tours | Offer Enter VR | toggle | D | `xrOfferEnabled` → `xrOfferSession` | Offer Enter VR in a headset browser | toggle | |
| 15 | Tours | Reset tours | btn "Reset all" | — (removes every `tour.<id>` + `toursAutoStart`) | `resetAllTours()` | | btn "Reset" | an action, so the category reset does not run it (it only resets `toursAutoStart`) |
| 16 | Windows & chrome | Show Rooms button *(only with the cloud plugin)* | toggle | D | `showRoomsButton` → `showRoomsButton` | | toggle | |
| 17 | Windows & chrome | Floating toolbar | toggle | D | `floatingToolbar` → `floatingToolbar` | Lift the toolbar above docked panels | toggle | |
| 18 | Windows & chrome | Toolbar always on top | toggle | D | `toolbarAlwaysOnTop` → `toolbarOnTop` | | toggle | |
| 19 | Windows & chrome | Window positions | btn "Reset" | — | `resetWindowLayout()` | | btn "Reset" | |
| 20 | Windows & chrome | Touch tools | toggle | D | `touchTools` → `touchTools` | | toggle | |
| 21 | Windows & chrome | Allow undocking (touch) | toggle | D | `mobileUndockAllowed` → `mobileUndockAllowed` | Allow undocking on touch screens | toggle | |
| 22 | Lists & menus | Advanced mode | check | D | `advancedMode` → `advancedMode` | Show system objects in the object list | **toggle** | old label kept as a keyword |
| 23 | Lists & menus | Environment in list | check | D | `showEnvInList` → `showEnvInList` | Show the environment in the object list | **toggle** | |
| 24 | Lists & menus | Object search in menu | check | D | `objectSearchEnabled` → `objectSearchEnabled` | Object search in the right-click menu | **toggle** | |
| 25 | Viewport | Show FPS + draw calls | toggle | D | `perfStatsShown` → `perfStats:show` | Show FPS and draw calls | toggle | the same store as VR › Display › "FPS and draw calls" (headset only) |
| 26 | Viewport | Send performance reports *(only when the build has a reports URL)* | toggle | D | `perfReportsOn` → `perfReports:send` | | toggle | |
| 27 | Viewport | Dock resizes the viewport | toggle | D | `viewPrefs.dockPushesViewport` → `viewPrefs` (json) | | toggle | |

Section order in the new page: **Appearance** (theme, custom theme, text selection) · **Avatars** · **Sound** ·
**Notifications** · **Tours** · **Windows & chrome** · **Lists & menus** · **Viewport**. In the mockup, Appearance holds
these three rows in this order.

### 3.2 Controls — "Keyboard, mouse and trackpad."

| # | Section | Current label | Now | Scope | Store → key | New label | New | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | Keyboard & mouse | Shift+A quick add | toggle | D | `enableShiftAdd` → `enableShiftAdd` | Shift+A opens the Add menu | toggle | |
| 2 | Keyboard & mouse | Show helpers in Play (debug) | toggle | D | `helpersInPlay` → `helpersInPlay` | Show helpers in Play | toggle | badge *Debug* |
| 3 | Keyboard & mouse | Double-click to open notes | toggle | D | `noteDoubleClickToOpen` → `noteDoubleClickToOpen` | | toggle | |
| 4 | Trackpad | Trackpad gestures | select Auto/On/Off | D | `trackpadMode` → `trackpadMode` | | **seg** Auto · On · Off | |
| 5 | Trackpad | Two-finger pan | toggle | D | `panEnabled` → `trackpadPanEnabled` | | toggle | |
| 6 | Trackpad | Reverse trackpad pan | toggle | D | `reversePan` → `trackpadReversePan` | | toggle | |
| 7 | Trackpad | Pinch zoom | toggle | D | `pinchZoomEnabled` → `trackpadPinchZoom` | | toggle | |
| 8 | Trackpad | Allow browser pinch zoom | toggle | D | `allowBrowserZoom` → `allowBrowserZoom` | | toggle | |
| 9 | Trackpad → **Diagnostics** (collapsible, closed) | Wheel diagnostics | info + table of the last 8 wheel events | — | `lastWheelEvents` (live, not stored) | | collapsible block | the spec's "Controls › wheel diagnostics into a collapsible Diagnostics block" |

### 3.3 Input — "Gamepad and the node editor's mouse."

| # | Section | Current label | Now | Scope | Store → key | New label | New | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | Gamepad | Gamepad | toggle | D | `gamepadPrefs.enabled` → `gamepadPrefs` (json) | Use a connected gamepad | toggle | |
| 2 | Gamepad | Swap sticks | toggle | D | `gamepadPrefs.swapSticks` (json) | | toggle | |
| 3 | Gamepad | Invert look Y | toggle | D | `gamepadPrefs.invertY` (json) | | toggle | |
| 4 | Gamepad | Stick deadzone | num (DEADZONE_RANGE, step 0.01) | D | `gamepadPrefs.deadzone` (json) | | **range** + mono readout | same min/max/step |
| 5 | Gamepad | Look sensitivity | num (SENSITIVITY_RANGE, step 0.1) | D | `gamepadPrefs.lookSensitivity` (json) | | **range** + readout "1.0×" | same min/max/step |
| 6 | Bindings | Per-game controls | info | — | — | — | muted footnote under Gamepad | no longer a row |
| 7 | Node editor | Mouse bindings | select (Classic / Select-first) | D | `flowMouseBindings` → `flow:mouseBindings` | Node editor mouse | **seg** Classic · Select-first (wide) | |
| 8 | Node editor | Node editor opens | select (Where it was left / Framed) | D | `nodeEditorOpens` → `flow:opens` | | **seg** Where left · Framed (wide) | |

### 3.4 Touch controls — "The on-screen stick and action buttons for phones and tablets."

| # | Section | Current label | Now | Scope | Store → key | New label | New | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | On-screen controls *(badge This device)* | Show touch controls | seg (tp-seg) Auto/Always/Never | D | `touchPrefs.visibility` → `touchControlsPrefs` (json) | | seg (Segmented primitive) | |
| 2 | On-screen controls | Show in edit | toggle | D | `touchPrefs.showInEdit` (json) | | toggle | |
| 3 | On-screen controls | Haptic tick | toggle | D | `touchPrefs.haptics` (json) | | toggle | |
| 4 | On-screen controls | Look speed | range (readout in the description) | D | `touchLookSpeed` → `touchLookSpeed` | | range + readout "1.00×" | |
| 5 | On-screen controls | Layout | btns "Edit layout" / "Reset" | — + D | `openTouchLayoutEditor()` / `resetTouchLayout('game'\|'global')` → `touchControlsLayouts` | | btn pair "Reset" · "Edit layout" | |
| 6 | Button looks | one row per action: Jump, Fire, Use, Grab, Crouch, Sprint, Reload, Up, Down (+ any the open scene's game adds) — each with previews, Released/Pressed image (Upload · Explorer… · ✕), Tint, Size, "Default look" | ~10 controls in one row | D | `touchTextures[actionId]` → `touchControlsTextures` (json: released, pressed, tint, scale) | | **3-column tile grid** (icon, name, "Default"/"Custom"); a tile is a **nav** to a sub-page | **SUBMENU** below |

**Submenu — Touch controls › ‹Action›** (for example "Touch controls › Jump"), one per action:

| Row | Control | Writes |
|---|---|---|
| Preview | released + pressed button previews | — |
| Released image | btn pair "Upload…" · "From Explorer…" (+ "Clear" when set) | `touchTextures[id].released` |
| Pressed image | same | `touchTextures[id].pressed` |
| Tint | color | `touchTextures[id].tint` |
| Size | range + readout | `touchTextures[id].scale` |
| Use the default look | btn (only when customised) | `clearTouchTexture(id)` |

### 3.5 Shortcuts — "Click a shortcut's keys, then press the new combination."

| # | Section | Current | Now | Scope | Store → key | New | Notes |
|---|---|---|---|---|---|---|---|
| 1 | page note | "Click a shortcut's keys to rebind it – Esc cancels" | info | — | — | the page description | |
| 2 | page note | non-Latin layout note *(conditional)* | info (amber) | — | `nonLatinLayoutSeen` | muted note under the description | |
| 3 | header | Reset all | btn | D | `resetAllShortcuts()` → removes `shortcutOverrides` | becomes the footer's "Reset Shortcuts to defaults" (confirm) | same function |
| 4 | one **section per group**: Mesh edit, Node editor, Transform, UV editor, Animation, Movement, Camera, Objects, Panels, Scene, History, Voice, Help (13 today; module groups are added at runtime) — the group scope ("keys work in the Node editor") | 3-column grid of rows | | | section header + a muted scope subtitle | |
| 5 | each shortcut (44 static + runtime) | key button (rebindable) or locked `kbd` + lock icon; ↺ reset icon when changed; "Swap / Cancel" conflict line | D | `shortcutOverrides` (json; removed when empty) | **one column of rows**: label left, key button right (locked: muted key + lock), ↺ icon button, the conflict line under the row | capture still swallows the key press (voice PTT, Esc) |

### 3.6 Scene — "How the 3D view draws, saves and behaves on this device." (35 rows → 9 sections)

| # | Section now → **new** | Current label | Now | Scope | Store → key | New label | New | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | — → **Viewport** | Show grid | check | D | `showGrid` → `showGrid` (stored `'false'` only when hidden; removed when shown) | | **toggle** | keep the inverted write exactly |
| 2 | — → Viewport | Light helper length | num 0.2–50 | D | `lightHelperLength` → `lightHelperLength` | | num (+ "m") | |
| 3 | — → Viewport | Simulation controls | check | D | `showSimControls` → `showSimControls` | Show the simulation controls | **toggle** | |
| 4 | — → **Performance** | Shadow quality | select Off/Low/Medium/High | D | `shadowQuality` → `shadowQuality` | | **seg** Off · Low · Medium · High | |
| 5 | — → Performance | Reduce quality when the scene is heavy | check | D | `autoQuality` → `autoQuality` | | **toggle** | |
| 6 | — → Performance | Simplify distant models | check | D | `lodEnabled` → `lodEnabled` | | **toggle** | |
| 7 | — → Performance | Draw repeated kit pieces together | check | D | `kitInstancingEnabled` → `kitInstancing` | | **toggle** | |
| 8 | — → Performance | Water quality | select Auto/High/Medium/Low (headset) | D | `waterQuality` → `water:quality` | | **seg** Auto · High · Medium · Low | |
| 9 | — → **Collaboration** | Sync animations | check | D | `syncedAnimations` → `syncedAnimations` | | **toggle** | |
| 10 | — → Collaboration | Spatial voice | check | D | `spatialVoice` → `spatialVoice` | | **toggle** | |
| 11 | — → Collaboration | Ping color + sound | color + select (5 sounds) + "▶ Preview" | S (peers see/hear your ping) | `pingColor` → `pingColor`, `pingSound` → `pingSound` | **two rows**: "Ping colour" (color) · "Ping sound" (select + ▶ preview icon) | | one 3-control row → two rows; nothing lost |
| 12 | — → **Saving & checkpoints** | Autosave | check | D | `autosaveEnabled` → `autosave` | | **toggle** | |
| 13 | — → Saving & checkpoints | Auto-restore on load | check | D | `autoRestoreEnabled` → `autoRestore` | | **toggle** | |
| 14 | Checkpoints → Saving & checkpoints | Keep automatic checkpoints | toggle | D | `autoCheckpoints` → `checkpoints:auto` | | toggle | |
| 15 | Checkpoints → Saving & checkpoints | Automatic checkpoint every | select 5/10/30/60 min | D | `autoCheckpointMinutes` → `checkpoints:every` | | **seg** 5 · 10 · 30 · 60 min | |
| 16 | Checkpoints → Saving & checkpoints | Checkpoint storage | select 100 MB/250 MB/500 MB/1 GB + "Open the timeline" | D | `checkpointCapMb` → `checkpoints:capMb` | | **seg** 100 MB · 250 MB · 500 MB · 1 GB; link "Open the timeline" in the description | |
| 17 | — → Saving & checkpoints | When opening another scene | select Ask/Keep modules/Unload modules | D | `modulesOnOpen` → `scenes:modulesOnOpen` | | **seg** Ask · Keep · Unload | |
| 18 | Selection → **Editing** | Double-click action | select (Open properties / Edit mesh / Focus and isolate / Select same type) | D | `doubleClickAction` → `doubleClickAction` | | **seg** Properties · Edit mesh · Isolate · Same type (wide) | see Decision D |
| 19 | Units | Length | select m/cm/mm/in/ft | D | `lengthUnit` → `lengthUnit` | | select (5 options) | |
| 20 | Units | Angle | select degrees/radians | D | `angleUnit` → `angleUnit` | | **seg** Degrees · Radians | |
| 21 | Duplicate → **Duplicates** | Carry animation clips | toggle | D | `duplicateCarriesAnimation` → `duplicateCarriesAnimation` | | toggle | |
| 22 | Duplicates | Carry object flow | toggle | D | `duplicateCarriesFlow` → `duplicateCarriesFlow` | | toggle | |
| 23 | Duplicates | Carry shader graph | toggle | D | `duplicateCarriesShader` → `duplicateCarriesShader` | | toggle | |
| 24 | Duplicates | Share materials | toggle | D (the effect is S) | `shareDuplicatedMaterials` → `shareDuplicatedMaterials` | | toggle | badge *Shared* (the edit reaches everyone) |
| 25 | Wireframe & outline → **Colours** | Wireframe color | color | D | `viewPrefs.wireColor` (json) | Wireframe colour | color | |
| 26 | Colours | Selection outline color | color | D | `viewPrefs.outlineColor` (json) | Selection outline colour | color | |
| 27 | Colours | Edit Mesh wireframe | check "Auto" + color | D | `viewPrefs.editWireColor` (json: `'auto'` or hex) | Edit mesh wireframe colour | **seg** Auto · Custom (+ swatch when Custom) | writes the same `'auto'`/`#2f81f7` values |
| 28 | Colours | Reset line colors | btn | — | `resetViewPrefs()` | Reset line colours | btn "Reset" | |
| 29 | Loading → **Loading placeholders** | Loading placeholders | select Modern/Colored boxes | D | `placeholderStyle` → `placeholderStyle` (JSON string) + `placeholderStyleChosen` | Placeholder style | **seg** Modern · Boxes | |
| 30 | Loading placeholders | Placeholder grid texture | toggle | D | `placeholderGrid.on` (json) | | toggle | disabled unless Modern |
| 31 | Loading placeholders | Grid size (m) | num 0.05–10 | D | `placeholderGrid.size` (json) | Grid size | num (+ "m") | |
| 32 | Loading placeholders | Grid color | color | D | `placeholderGrid.color` (json) | Grid colour | color | |
| 33 | Loading placeholders | Grid opacity | range 0–1 | D | `placeholderGrid.opacity` (json) | | range + readout % | |
| 34 | Loading placeholders | Placeholder animation speed | range 0–4 | D | `placeholderGrid.speed` (json) | Animation speed | range + readout "1.00×" | |
| 35 | Loading placeholders | Stuck after (seconds) | num 1–120 | D | `placeholderStuckSeconds` → `placeholderStuckSeconds` | Stuck after | num (+ "s") | |

**Not in Settings, out of scope here.** Configure Scene's *Hold camera until loaded*, *Start simulation on load*,
*Selection passes through* and *Fluid budget* are **scene data** (the `scenePhysics` singleton, replicated and saved).
They live in the Inspector (`menu/scene/*.svelte`), not in this window. Roadmap 38's R5 (Inspector) covers them.

### 3.7 Explorer — "Files, sharing and the recycle bin."

| # | Section now → new | Current label | Now | Scope | Store → key | New label | New | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | — → **Sharing** | When you add files during a session | select Ask each time/Share automatically/Keep them local | D | `shareNewFiles` → `shared:shareNewFiles` | | **seg** Ask · Share · Keep local (wide) | |
| 2 | Sharing | Download shared files automatically | check | D | `autoDownload` → `shared:autoDownload` | | **toggle** | |
| 3 | Sharing | Offer to merge unsaved work on connect | check | D | `mergeOnConnect` → `connect:mergeOnConnect` | | **toggle** | |
| 4 | Sharing | Who can unshare a file | native select Anyone/Only whoever shared it | D | `unshareAuthority` → `shared:unshareAuthority` | | **seg** Anyone · Who shared it | |
| 5 | — → **Files** | Keep versions per scene | num 0–200 | D | `keepVersionsSetting` → `project:keepVersions` | | num | |
| 6 | Files | When importing files already in your library | select Ask/Skip them/Import as copies | D | `duplicateImportMode` → `importDuplicateMode` | | **seg** Ask · Skip · Copy | |
| 7 | Files | Save name | text | D | `saveNameTemplate` → `saveNameTemplate` | | text (wide) | |
| 8 | Deleted files | Keep a recycle bin | check | D | `recycleBinEnabled` → `shared:recycleBin` | | **toggle** | |
| 9 | Deleted files | Delete without asking | check | D | `deleteWithoutConfirm` → `shared:deleteNoConfirm` | | **toggle** | |
| 10 | Deleted files | Keep deleted files after a reload | check | D | `keepRecycleBin` → `shared:keepRecycleBin` | | **toggle** | |
| 11 | Deleted files | Deleted files log | check | D | `deletedLogEnabled` → `shared:deletedLog` | | **toggle** | |
| 12 | Disk | Storage used | btn "Show breakdown" | — | `openStorageModal()` | | btn "Show breakdown" | closes Settings first (no modal on a modal) |

### 3.8 Node types — "Hide the node types you never use from the palette, add menus and search on this device."

| # | Current | Now | Scope | Store → key | New | Notes |
|---|---|---|---|---|---|---|
| 1 | intro text | info | — | — | page description | |
| 2 | Filter node types… + "Turn all on (N off)" | text field + btn | — / D | `disabledNodeTypes.set([])` | search field (results show matching types inline as rows, with their group as the path); "Turn all on" becomes the footer's "Reset Node types to defaults" | same function |
| 3 | one block per node group (core catalog + module groups): group checkbox + one checkbox per type, "· N in use" | 3-column grid of ~200 checkboxes | D | `disabledNodeTypes` → `disabledNodeTypes` (json array) | one **nav** per group (value "12 of 14 on") | **SUBMENU** below |

**Submenu — Node types › ‹Group›**: first row "All ‹Group› nodes" (toggle = `setNodeTypesEnabled(types, on)`),
then one toggle row per type (description "3 in use" when used). Each writes `disabledNodeTypes`.

### 3.9 Export — "What the next exported game starts with." *(Shared component: the Publish / Export dialog's Settings tab renders the same rows.)*

| # | Current label | Now | Scope | Store → key | New label | New | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Show Made with ThePrototype badge | check, checked + disabled | — | none (always on) | Show the Made with ThePrototype badge | toggle on + disabled, badge *Always on* | |
| 2 | Start fullscreen | check | D | `exportPrefs.startFullscreen` → `export:prefs` (json) | | **toggle** | |
| 3 | Show FPS | check | D | `exportPrefs.showFps` (json) | | **toggle** | |
| 4 | Quality | select Auto/High/Medium/Low | D | `exportPrefs.quality` (json) | | **seg** Auto · High · Medium · Low | |
| 5 | Include VR button | check | D | `exportPrefs.vrButton` (json) | | **toggle** | |
| 6 | Use CDN for packs | check | D | `exportPrefs.useCdnForPacks` (json) | | **toggle** | |
| 7 | Compress textures | check, disabled | — | none | | toggle, disabled, badge *Not yet* | |

### 3.10 VR — "Comfort, body, buttons and display in the headset (the same table as the headset's own Settings)."

Rows 2–25 come from the one schema in `src/lib/vr/settingsSchema.js` (desktop rows only). The headset's radial and
panel read the same table. The "· now X" suffix is removed from every row (the control already shows the value).
Checkboxes become toggles.

| # | Section | Current label | Now | Scope | Store → key | New label | New | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | — → **General** | VR override | check | D | `vrOverride` → `vrOverride` (`'true'` when on, removed when off) | Play on the screen, even in a headset | **toggle** | keep the write exactly |
| 2 | Comfort | Turning | select Snap/Smooth/Off | D | `vrSmoothTurn` → `vrSmoothTurn`, `vrSnapAngle` → `vrSnapAngle` (0 = off) | | **seg** Snap · Smooth · Off | |
| 3 | Comfort | Snap angle | select 15°/30°/45°/90° | D | `vrSnapAngleLast` → `vrSnapAngleLast` (+ `vrSnapAngle`) | | **seg** | |
| 4 | Comfort | Smooth speed | select 45/90/135/180 °/s | D | `vrSmoothTurnSpeed` → `vrSmoothTurnSpeed` | | **seg** | |
| 5 | Comfort | Mirror turn | check | D | `vrMirrorSnapTurn` → `vrMirrorSnapTurn` | | **toggle** | new description: "A left flick turns you right, and the other way round." (the spec asks for one) |
| 6 | Comfort | Comfort vignette | check | D | `vrComfortVignette` → `vrComfortVignette` | | **toggle** | |
| 7 | Comfort | Teleport | check | D | `vrTeleportEnabled` → `vrTeleportEnabled` | | **toggle** | |
| 8 | Comfort | Flying | check | D | `vrFlying` → `vrFlying` | | **toggle** | |
| 9 | Body | Stance | select Standing/Seated | D | `vrStance` → `vrStance` | | **seg** | |
| 10 | Body | Height | select of 0.05 steps (−50…+50 cm) | D | `vrHeightOffset` → `vrHeightOffset` | | **range** + readout "+10 cm" | same steps |
| 11 | Controls | Menu hand | select Right/Left | D | `vrMenuHand` → `vrMenuHand` | | **seg** | |
| 12 | Controls | Hold to open menu | check | D | `vrMenuHold` → `vrMenuHold` | | **toggle** | |
| 13 | Controls | Left-handed | check | D | derived: `mirrorBindings()` on `vrBindings` → `vrBindings` | | **toggle** | |
| 14 | Controls | Grab style | select Rigid/Move only/Rotate only | D | `vrGrabStyle` → `vrGrabStyle` | | **seg** | |
| 15 | Controls | (inline 4-column remap table: Action · Hand · Button · What it does; conflict Swap/Cancel; "Reset buttons") | table | D | `vrBindings` → `vrBindings` (json) | **nav "Remap buttons"** | | **SUBMENU** below |
| 16 | Display | Refresh rate | select Max/90 Hz/120 Hz | D | `vrTargetHz` → `vrTargetHz` | | **seg** | |
| 17 | Display | Statistics card | check | D | `vrStatsOpen` → `vrStats` | | **toggle** | |
| 18 | Display | Peer hands | select Model/Hands/Spheres | D | `peerHandStyle` → `peerHandStyle` | | **seg** | |
| 19 | Display | Passthrough | red toggle (+ "not supported on this device") | D | `vrPassthrough` → `vrPassthrough` | | toggle (accent colour; the "not supported" note stays) | |
| 20 | Display | Selection wireframe | check | D | `vrWireframeSelection` → `vrWireframe` | | **toggle** | |
| 21 | Display | Reset panel positions | btn | — | `resetWindowPoses()` | | btn "Reset" | |
| 22 | Display | Game HUD | select Follow head/Fixed in world/Wrist only | D | `vrHudPlacement` → `vr:hudPlacement` | | **seg** Head · World · Wrist | |
| 23 | Display | Game HUD size | select Small/Medium/Large | D | `vrHudSize` → `vr:hudSize` | | **seg** | |
| 24 | Display | Button hints | check | D | `vrHudHints` → `vr:hudHints` | | **toggle** | |
| 25 | Editing | Hold to move vertex | check | D | `vrVertexHold` → `vrVertexHold` | | **toggle** | |
| 26 | Editing | Sleeve palette | check | D | `vrSleeveEnabled` → `vrSleeveEnabled` | | **toggle** | badge *Experimental* |
| 27 | Editing | Face edit limit | num (free) | D | `vrFaceCap` → `vrFaceCap` | | num | |
| 28 | Editing | Vertex edit limit | num (free) | D | `vrVertexCap` → `vrVertexCap` | | num | |
| 29 | — → **Avatar** | My hand model | native select (Default + library objects) | S (your peers see it) | `myHandModel` → `myHandModel` | | select | badge *Shared* |
| 30 | — → **Colocation** | Colocation (status + Colocate here / Stop / Forget ‹room›) | 3 btns + status | — / D | `colocateHereFromView()`, `stopColocation()`, `forgetRoom()` (`colocation-anchors-v1`; Forget also clears that room in `colocation-nudge-v1`) | | status as the value; btn group (wide) | |
| 31 | Colocation | Fine-tune *(only while colocated)* | 4 DragRows X/Y/Z/Yaw + Reset | D | `roomNudge` → `colocation-nudge-v1` (per room) | | **nav "Fine-tune"** | **SUBMENU** below |
| 32 | Colocation | Ghost hands | toggle | D | `colocatedGhostHands` → `colocatedGhostHands` | | toggle | |
| 33 | — → **Advanced** | Colocation probe (dev) | btns "Probe AR capabilities" / "Clear stored anchor" | — / D | `runArProbe()`, `clearProbeState()` (`arprobe-findings-v1`, `arprobe-anchor-v1`) | Colocation probe | btn pair | the dev-only row moves to Advanced, as the spec requires |
| 34 | Advanced | Probe report *(after a run)* | mono list | — | `probeFindings` | | mono block under the probe row | |

Headset-only rows (no desktop row today, unchanged): Reset height, Remap buttons (the headset page), Reset buttons,
FPS and draw calls, Microphone.

**Submenu — VR › Remap buttons**: one row per VR action: Move, Turn, Teleport (sticks), Radial menu, Edit / Interact,
Game menu, Talk / jump, Ping (buttons), Drag the world (grip), Grab, Select / use (locked). Each row has a label and the
action's one-line description on the left. On the right: **seg** Left · Right for the hand, and a **select** for the
button (buttons only). Locked rows show "Both · ‹control›" muted. A conflict shows an inline line under the row,
"⚠ ‹button› is already ‹action›. Swap them · Cancel". The last row is "Reset buttons" (`resetBindings()`). Left-handed
also sits here. Writes `vrBindings` (unchanged).

**Submenu — VR › Fine-tune**: X, Y, Z (DragRow, metres, ±`NUDGE_MAX_M`), Yaw (DragRow, ±15°), Reset. Writes
`setRoomNudge` / `resetRoomNudge` (unchanged), plus the description.

### 3.11 AI — "The scene assistant, voice typing and mesh generation."

| # | Section | Current label | Now | Scope | Store → key | New label | New | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | **Assistant** | Enable assistant | toggle | D | `aiEnabled` → `aiEnabled` | | toggle | |
| 2 | Assistant | Providers (list: radio = active, label, model, Edit, ✕; "+ Add provider") | list | D | `aiProviders` → `aiProviders` (json), `aiActiveProvider` → `aiActiveProvider` | — | one **nav** per provider (label · model, badge *Active* on the active one) + **nav "Add provider"** | **SUBMENU** below |
| 3 | Assistant | New / Edit provider (inline form) | form | D | writes `aiProviders` | — | the provider sub-page | |
| 4 | **Voice typing** | Voice typing provider | native select OpenAI/Groq/Self-hosted + status | D | `sttConfig.preset` → `aiStt` (json) | | **seg** OpenAI · Groq · Self-hosted, status badge *Ready* / *Needs a key* | |
| 5 | Voice typing | Voice typing server (Base URL, API key, Model, Language, Test connection) | form | D | `sttConfig.*` (json) | | **nav "Server"** (value = host) | **SUBMENU** below |
| 6 | **Mesh generation** | Mesh generation | toggle | D | `meshGenEnabled` → `meshGenEnabled` | | toggle | |
| 7 | Mesh generation | Mesh providers (list + "+ Add mesh provider") | list | D | `meshProviders` → `meshProviders` (json), `meshActiveProvider` → `meshActiveProvider` | — | **nav** per provider + **nav "Add mesh provider"** | **SUBMENU** below |
| 8 | Mesh generation | New / Edit mesh provider (inline form) | form | D | writes `meshProviders` | — | the mesh provider sub-page | |
| 9 | (end) | Storage ("API keys are stored unencrypted …") | info row | — | — | — | muted footnote at the end of the page | no longer a row |

**Submenu — AI › ‹Provider›** (and "AI › Add provider"): Preset (select), Label (text), Base URL (text), API key
(password), Model (text + suggestions), Stream responses (toggle), Physics tools (toggle + "Local & small models guide"
link), Temperature (text). The actions row has Save (primary), Test connection, Cancel, plus **Use this provider** (=
the old radio) and **Remove** (= the old ✕) on an existing one. The test result line goes under the actions. Writes
`addAiProvider` / `updateAiProvider` / `removeAiProvider` / `setAiActiveProvider` (unchanged).

**Submenu — AI › Voice typing server**: Base URL, API key, Model, Language hint (text rows) + Test connection. Writes
`setSttConfig` (unchanged).

**Submenu — AI › ‹Mesh provider›**: Kind (select ComfyUI/Meshy), Label, URL, Key/token. For ComfyUI: Workflow JSON
(textarea) and Output node. Otherwise: Mode (seg Preview · Refine) and Asset proxy. Then Save / Cancel, plus Use this
provider / Remove. Writes `addMeshProvider` / `updateMeshProvider` / … (unchanged).

### 3.12 Connection — "How you find other people."

| # | Section | Current label | Now | Scope | Store → key | New label | New | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | **Session** | Session size | num 2–HARD_PEER_CAP | D | `softPeerCap` → `connect:softPeerCap` | | num | |
| 2 | **Signaling server** | Signaling server | select Default/Public PeerJS cloud/Custom server/Local dev | D | `peerServerConfig.mode` → `peerServerConfig` (json) | | **seg** Default · Public · Custom · Local dev (wide) | |
| 3 | Signaling server | Server host *(Custom only)* | text | D | `peerServerConfig.custom.host` (json) | | → submenu | **SUBMENU "Custom server"**, a nav shown when mode = Custom (value = the host) |
| 4 | Signaling server | Port + path *(Custom)* | 2 texts in one row | D | `.custom.port`, `.custom.path` | → "Port" and "Path" rows | | split into one control per row |
| 5 | Signaling server | Secure (wss) *(Custom)* | check | D | `.custom.secure` | | → toggle | |
| 6 | Signaling server | TURN URLs *(Custom)* | text | D | `.custom.turnUrls` | | → text | |
| 7 | Signaling server | TURN credentials *(Custom)* | 2 texts | D | `.custom.turnUsername`, `.custom.turnCredential` | → "TURN username", "TURN credential" | | split |
| 8 | Signaling server | STUN URLs *(Custom)* | text | D | `.custom.stunUrls` | | → text | |
| 9 | Signaling server | Apply changes | btn "Apply" + "Reload" link | — | `applyPeerServer()` / `location.reload()` | | btn pair "Reload" · "Apply" | |

### 3.13 About & what's new

| # | Section | Current label | Now | Scope | New | Notes |
|---|---|---|---|---|---|---|
| 1 | **About** | Version | info | — | value in mono | |
| 2 | About | Cloud plugin *(when loaded)* | info | — | value in mono | |
| 3 | About | Diagnostics | btn "Copy diagnostics" | — | btn "Copy" | |
| 4 | **What's new** | (footer btn today) | btn | — | **nav "What's new"** with the unread dot → sub-page with the changelog | |
| 5 | **Links** | Dev Builds / Source Code / Modules / Docs | links | — | one nav per link (external icon), "Dev builds", "Source code", "Modules", "Docs" | sentence case |
| 6 | **Danger zone** | Clear saved session (footer today) | btn | — | btn (warning text), confirm | from the footer |
| 7 | Danger zone | Reset settings (footer today) | btn | — | "Reset all settings", btn (warning), confirm | from the footer, same `safeStorage.clear()` |

About has no "Reset … to defaults" footer link (it holds no settings).

## 4. Sub-pages (all of them)

| Path | Opened from | Holds |
|---|---|---|
| Touch controls › ‹Action› (9 built-in + a game's own) | the Button looks tile | images, tint, size, default look |
| Node types › ‹Group› (one per palette group) | a nav per group | the group toggle + one toggle per type |
| VR › Remap buttons | nav in VR › Controls | the remap table as rows |
| VR › Fine-tune | nav in VR › Colocation (while colocated) | X / Y / Z / Yaw + Reset |
| AI › ‹Provider› / Add provider | nav per provider | the provider form |
| AI › Voice typing server | nav in Voice typing | the STT server form |
| AI › ‹Mesh provider› / Add mesh provider | nav per mesh provider | the mesh provider form |
| Connection › Custom server | nav, when the mode is Custom | host, port, path, wss, TURN, STUN |
| About › What's new | nav | the changelog |

Every sub-page has a breadcrumb + back on desktop and "‹ Parent" on mobile. None of them is a modal on top of Settings.
Three things leave Settings on purpose, as they do today: *Customize character*, *Storage breakdown* and *Edit touch
layout*. Each closes Settings and opens its own window.

## 5. Decisions taken in this plan (say if you want otherwise; G and H are in §6)

- **A. Theme stays a dropdown.** The mockup draws System · Light · Dark as a segmented control. The app has five built-in
  themes plus custom ones and no "System" value. Under the spec's own rule (5+ options → dropdown) it stays a dropdown,
  with the same values. Adding "System" (follow the OS light/dark) would be a new behaviour, so it is not in this lane.
- **B. "Reset settings" keeps working, behind a confirmation.** Today it wipes **all** of the app's local storage with
  no question asked. The new per-category reset clears only that category's keys. The old wipe-everything button lives on
  as About › Danger zone › "Reset all settings".
- **C. Renamed labels.** Every row with a "New label" keeps its old label as a search keyword, so a search for the old
  name still lands on it.
  old label as a search keyword.
- **D. 2–4 options always become a segmented control**, with short labels where the old ones were long ("Properties ·
  Edit mesh · Isolate · Same type"). A dropdown is kept only for 5+ options or open lists: Theme, Length unit, Ping sound,
  My hand model, the VR remap button picker, provider presets.
- **E. Scope badges** go where today's copy says "this device only" / "local to you" (the spec: the badge replaces the
  prose). A section is badged when all its rows share the scope. *Shared* goes on the rows whose effect reaches other
  people (Share materials, Ping colour/sound, My hand model). Nearly every setting is per-device, so badging every row
  would be noise.
- **F. Number fields with a fixed range become sliders with a mono readout** (gamepad deadzone and sensitivity, VR
  height). Open-ended numbers stay number fields (light helper length, keep versions, session size, edit limits, grid
  size, stuck seconds).

## 6. Storage keys by category (what each category's reset clears)

The rule: a category reset puts back the default of **every setting row on that page**. It never runs an action row
(Reset tours, Window positions, Clear stored anchor…), and it never touches data (saved providers, colocation anchors,
tour progress, checkpoints). Two JSON keys hold fields from two places, so those are reset **by field**, not by key:
`viewPrefs` (Interface: `dockPushesViewport`; Scene: `wireColor`, `outlineColor`, `editWireColor`) and `export:prefs`
(this page: `startFullscreen`, `showFps`, `quality`, `vrButton`, `useCdnForPacks`; the Publish dialog's own `preset`,
`thumbnail`, `viewportW/H` and `embedUrl` stay). A reset goes through each store's own setter, so stores, keys and any
side effects (theme classes, `vrBindings` ↔ `vrMenuHand`) stay consistent. Nothing is written with a raw `removeItem`
behind a store's back.

| Category | Keys (localStorage, via safeStorage) |
|---|---|
| Interface | `allowTextSelection` `avatars:peersClassic` `theme` `customThemes`* `game:soundVolume` `game:musicVolume` `showWelcomeOnStart` `showWhatsNewNotice` `toastsInDrawerOnly` `toursAutoStart` `xrOfferSession` `showRoomsButton` `floatingToolbar` `toolbarOnTop` `touchTools` `mobileUndockAllowed` `advancedMode` `showEnvInList` `objectSearchEnabled` `perfStats:show` `perfReports:send` `viewPrefs.dockPushesViewport` `ui:density` (NEW) |
| Controls | `enableShiftAdd` `helpersInPlay` `noteDoubleClickToOpen` `trackpadMode` `trackpadPanEnabled` `trackpadReversePan` `trackpadPinchZoom` `allowBrowserZoom` |
| Input | `gamepadPrefs` `flow:mouseBindings` `flow:opens` |
| Touch controls | `touchControlsPrefs` `touchLookSpeed` `touchControlsTextures` `touchControlsLayouts` |
| Shortcuts | `shortcutOverrides` |
| Scene | `showGrid` `lightHelperLength` `showSimControls` `shadowQuality` `autoQuality` `lodEnabled` `kitInstancing` `water:quality` `syncedAnimations` `spatialVoice` `pingColor` `pingSound` `autosave` `autoRestore` `checkpoints:auto` `checkpoints:every` `checkpoints:capMb` `scenes:modulesOnOpen` `doubleClickAction` `lengthUnit` `angleUnit` `duplicateCarriesAnimation` `duplicateCarriesFlow` `duplicateCarriesShader` `shareDuplicatedMaterials` `viewPrefs.wireColor` `viewPrefs.outlineColor` `viewPrefs.editWireColor` `placeholderStyle` (+`placeholderStyleChosen`) `placeholderGrid` `placeholderStuckSeconds` |
| Explorer | `shared:shareNewFiles` `shared:autoDownload` `connect:mergeOnConnect` `shared:unshareAuthority` `project:keepVersions` `importDuplicateMode` `saveNameTemplate` `shared:recycleBin` `shared:deleteNoConfirm` `shared:keepRecycleBin` `shared:deletedLog` |
| Node types | `disabledNodeTypes` |
| Export | `export:prefs.{startFullscreen, showFps, quality, vrButton, useCdnForPacks}` |
| VR | `vrOverride` `vrSmoothTurn` `vrSnapAngle` `vrSnapAngleLast` `vrSmoothTurnSpeed` `vrMirrorSnapTurn` `vrComfortVignette` `vrTeleportEnabled` `vrFlying` `vrStance` `vrHeightOffset` `vrMenuHand` `vrMenuHold` `vrBindings` `vrGrabStyle` `vrTargetHz` `vrStats` `peerHandStyle` `vrPassthrough` `vrWireframe` `vr:hudPlacement` `vr:hudSize` `vr:hudHints` `vrVertexHold` `vrSleeveEnabled` `vrFaceCap` `vrVertexCap` `myHandModel` `colocatedGhostHands` |
| AI | `aiEnabled` `meshGenEnabled` `aiStt` (preset, base URL, model, language; see Decision G for keys and providers) |
| Connection | `connect:softPeerCap` `peerServerConfig` |
| About | — (no settings; the Danger zone holds the two global actions) |

\* `customThemes` is the list of themes you loaded. **Decision H**: the Interface reset sets the theme back to Dark
but **keeps** your loaded themes (they are files you added, not preferences). Removing one stays its ✕.

- **G. The AI reset keeps your providers and API keys.** It switches the assistant and mesh generation off and puts the
  voice-typing preset back. It does not delete `aiProviders`, `aiActiveProvider`, `meshProviders` or
  `meshActiveProvider`, because re-typing keys after a misclick would be expensive. Remove a provider on its own
  sub-page. "Reset all settings" still wipes everything, as today.

Exact defaults, encodings and write timing for every key (for example, `showGrid` is present only as `'false'`,
`avatars:peersClassic` stores `'1'`/`'0'`, and `scenes:modulesOnOpen` is removed for "Ask") are in
**[`settings-storage-keys.md`](settings-storage-keys.md)**. The storage-key test (`tests/unit/settingsInventory`)
is generated from that table: for every row it writes a non-default value through the new UI's code path and asserts
the same key and the same string as 1.25.0.
