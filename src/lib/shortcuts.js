import { get, writable } from 'svelte/store';
import { TControls, isLocked, isVRMode } from '../stores/sceneStore';
// 24-A1: the layout-independent key token (zero-import leaf, see keyOf.js)
import { keyOf } from './keyOf';
// 36 U11: which panel owns the keyboard (zero-import leaves)
import { scopeOfEvent, pickForScope, startKeyScope, setVrScopeProbe } from './keyScope';
import { runNodeAction, hasNodeAction, nodeEditorInsideGroup } from './nodeEditorActions';
import {
	chatHidden,
	settingsOpen,
	anyModalOpen,
	settingsSection,
	specatorMode,
	aiPromptBarOpen,
	showToast,
	showSimControls,
	armExplorerSceneSave,
	explorerClose
} from '../stores/appStore';
import { aiReady } from './ai/providers';
import {
	focusObject,
	duplicateSelection,
	requestDeleteSelection,
	setTransformMode,
	selectAllObjects,
	clearIsolation,
	isIsolated,
	toggleEditorMode
} from './objectActions';
import { undo, redo } from './history';
import { editingObject, enterEditMode, exitEditMode } from './meshEdit';
import { faceEditObject, meshEditHotkeys } from './faceEdit';
import { recallBookmark } from './cameraBookmarks';
// 36 L2: Home = the scene's start view (startView imports no history-family module)
import { backToStartView } from './startView';
import { snapTargets } from './snapping';
import { togglePanel, toggleDock } from './panelToggles';
// Phase 5: the play FAB's own entry point. playMode.js imports sceneStore +
// svelte/store ONLY (it says so at the top of the file, and that is deliberate),
// so this static edge adds nothing to shortcuts' subtree — which matters, because
// shortcuts sits inside history's import family and a cycle there TDZ-crashes the
// SSR prerender.
import { requestPlay } from './playMode';
import { selectedObject } from '../stores/sceneStore';
import { safeStorage } from './safeStorage';

// Single source of truth for keyboard shortcuts: the same registry binds the keys
// and renders the list in Settings -> Shortcuts. Other modules push entries via
// registerShortcut() so their keys show up in the list automatically.
//
// Phase 5 makes it REBINDABLE, on the Unity Shortcut Manager model: an entry's
// authored combo is its `defaultKeys`, a user override lives in localStorage keyed
// by a STABLE `id`, and `applyOverrides()` writes the effective combo back onto
// `keys`. Everything downstream — the matcher below, the Settings renderer, and
// editorNavigation's Shift+<key> probe — keeps reading `keys` and is untouched.

/**
 * @typedef {{
 *   id: string,
 *   keys: string,
 *   defaultKeys?: string,
 *   group: string,
 *   label: string,
 *   action?: () => void,
 *   when?: () => boolean,
 *   fixed?: boolean,
 *   fixedReason?: string,
 *   external?: boolean,
 *   scope?: string
 * }} Shortcut
 */

/** What a caller may hand registerShortcut — `id` is derived when absent.
 * @typedef {{ id?: string, keys: string, group: string, label: string,
 *   action?: () => void, when?: () => boolean,
 *   fixed?: boolean, fixedReason?: string,
 *   external?: boolean, scope?: string }} ShortcutInput */

/*
 * W5 adds two things to the shape above, and they are NOT the same thing.
 *
 * `external: true` — the combo is REBINDABLE here and executed somewhere else. Some
 * commands may only fire inside one editor's focus scope (the UV editor and the
 * animation timeline both claim keys in a CAPTURE-phase listener on their own pane,
 * because panel chrome swallows the delegated form and because their digits are taken
 * twice over app-wide). Such a command cannot be a registry `action` — the registry's
 * window listener has no idea where the focus is — but its BINDING still belongs in
 * one place, or Settings shows a key the user cannot change. So the registry owns the
 * combo, `handleKeydown` skips the row (it has no action), and the owning editor asks
 * `bindingOf(id)` what it should answer to. That is the distinction `isRebindable` was
 * built to draw and did not yet: `fixed` = a display label, `external` = a real combo
 * with an owner elsewhere.
 *
 * `scope` — WHERE a combo means something. Absent = global (the window listener).
 * Two rows COLLIDE only when their scopes are equal, so:
 *   · global vs global      -> conflict (the old, and only, behaviour)
 *   · same scope vs itself  -> conflict (two UV commands cannot both be G)
 *   · scoped vs global      -> fine    (the editor's capture handler stops the event
 *                                       before the registry ever sees it)
 *   · scope A vs scope B    -> fine    (two editors, never focused at once)
 * That is what lets Move-the-gizmo, arm-Move-in-UV and arm-Move-in-the-timeline all
 * default to G, which is the whole point of the key.
 */

/**
 * Delete the viewport selection from the keyboard (154). The node editor owns
 * Delete/Backspace while open; mesh edit + spectating keep the key too; text
 * fields + locked views are already excluded by handleKeydown. Groups confirm.
 */
function deleteFromViewport() {
	// 36 U11: the node editor no longer "owns Delete while open" — a key fires in the
	// scope that has focus, so Delete in the viewport deletes objects whether or not
	// the Flow pane happens to be open, and Delete in the Flow pane deletes nodes.
	if (get(editingObject) || get(faceEditObject) || get(specatorMode)) return;
	requestDeleteSelection();
}

/**
 * Toggle the quick AI prompt pill (roadmap #10). Opens only when a provider is
 * configured; otherwise points the user at Settings -> AI.
 */
function toggleAiPrompt() {
	if (get(aiPromptBarOpen)) {
		aiPromptBarOpen.set(false);
		return;
	}
	if (!aiReady()) {
		showToast('Enable an AI provider in Settings to use the assistant');
		settingsSection.set('ai');
		settingsOpen.set(true);
		return;
	}
	aiPromptBarOpen.set(true);
}

/** I3: the `?` cheat sheet overlay (ShortcutSheet.svelte renders it from `shortcuts`). */
export const cheatSheetOpen = writable(false);

/**
 * 36 B8: the mesh-edit commands — real combos, run by the mesh session's own handler.
 * @param {[string, string, string][]} table [id, keys, label] @returns {Shortcut[]}
 */
function meshRows(table) {
	return table.map(([id, keys, label]) => ({ id, keys, group: 'Mesh edit', scope: 'mesh', label, external: true }));
}

/**
 * Which mesh-edit command a combo means right now (overrides included), or null.
 * `Ctrl++` / `Ctrl+_` stay aliases of grow / shrink while those keep their defaults
 * (the shifted spellings of the same two keys).
 * @param {string} combo @returns {string | null}
 */
export function meshCommandFor(combo) {
	const row = shortcuts.find((s) => s.scope === 'mesh' && s.keys === combo);
	if (row) return row.id;
	if (combo === 'Ctrl++' && bindingOf('mesh.grow') === 'Ctrl+=') return 'mesh.grow';
	if (combo === 'Ctrl+_' && bindingOf('mesh.shrink') === 'Ctrl+-') return 'mesh.shrink';
	return null;
}

/**
 * 36 U11: build the node-editor rows from a compact table. Each row reaches the mounted
 * editor by NAME (nodeEditorActions) and declines the key when no editor is mounted.
 * @param {[string, string, string, string, any?][]} table [id, keys, action, label, arg?]
 * @returns {Shortcut[]}
 */
function nodeRows(table) {
	return table.map(([id, keys, name, label, arg]) => ({
		id,
		keys,
		group: 'Node editor',
		scope: 'nodes',
		label,
		when: () => hasNodeAction(name),
		action: () => runNodeAction(name, arg)
	}));
}

/** @type {Shortcut[]} */
export const shortcuts = [
	// transform hotkeys live on 1/2/3 — W/E/R belong to fly navigation now
	{
		id: 'transform.move',
		keys: '1',
		group: 'Transform',
		scope: 'viewport',
		label: 'Move (translate)',
		action: () => setTransformMode('translate')
	},
	{
		id: 'transform.rotate',
		keys: '2',
		group: 'Transform',
		scope: 'viewport',
		label: 'Rotate',
		action: () => setTransformMode('rotate')
	},
	{
		id: 'transform.scale',
		keys: '3',
		group: 'Transform',
		scope: 'viewport',
		label: 'Scale',
		action: () => setTransformMode('scale')
	},
	{
		// W5: Blender's G. A second name for Move, because that is the muscle memory
		// people arrive with — 1 keeps working and neither is the "real" one.
		//
		// G is in MESH_EDIT_KEYS, so while a live mesh session holds its hotkeys the
		// registry stands down for this key and G stays the session's grab. That is
		// correct and deliberate: inside a mesh edit, G means grab the ELEMENTS.
		id: 'transform.grab',
		keys: 'G',
		group: 'Transform',
		scope: 'viewport',
		label: 'Move (grab) — same as 1',
		action: () => setTransformMode('translate')
	},
	{
		// External + scoped: the UV editor arms this itself, from its own capture-phase
		// keydown, so it can only ever fire while that canvas holds focus. Listed and
		// rebindable here so the binding lives in ONE place.
		id: 'uv.grab',
		keys: 'G',
		group: 'UV editor',
		label: 'Arm Move (in the UV editor)',
		external: true,
		scope: 'uv'
	},
	{
		id: 'animation.grab',
		keys: 'G',
		group: 'Animation',
		label: 'Arm Move (in the timeline)',
		external: true,
		scope: 'animation'
	},
	{
		id: 'movement.fly',
		keys: 'W A S D',
		group: 'Movement',
		scope: 'viewport',
		label: 'Fly the camera (horizontal)',
		fixed: true,
		fixedReason: 'movement keys, handled by fly navigation'
	},
	{
		id: 'movement.fly-vertical',
		keys: 'Q / E',
		group: 'Movement',
		scope: 'viewport',
		label: 'Fly down / up',
		fixed: true,
		fixedReason: 'movement keys, handled by fly navigation'
	},
	{
		id: 'movement.fly-fast',
		keys: 'Shift (hold)',
		group: 'Movement',
		scope: 'viewport',
		label: 'Fly 3x faster',
		fixed: true,
		fixedReason: 'hold modifier, handled by fly navigation'
	},
	{
		// 36 L2: back to where the scene opened (its saved view). Quiet when no scene with
		// a saved view was loaded, so Home stays free for the lists that claim it
		id: 'camera.start-view',
		keys: 'Home',
		group: 'Camera',
		label: "Back to the scene's start view",
		action: () => backToStartView()
	},
	{
		id: 'camera.focus',
		keys: 'F',
		group: 'Camera',
		scope: 'viewport',
		label: 'Focus selected object',
		action: () => focusObject()
	},
	{
		id: 'objects.duplicate',
		keys: 'Ctrl+D',
		group: 'Objects',
		scope: 'viewport',
		label: 'Duplicate selection (whole set)',
		action: () => duplicateSelection()
	},
	{
		// Phase 85. A mesh session owns Ctrl+A for its own elements (and the UV
		// editor claims it in capture phase on its canvas), so this stands down
		// while one is open rather than selecting the whole scene behind it.
		id: 'objects.select-all',
		keys: 'Ctrl+A',
		group: 'Objects',
		scope: 'viewport',
		label: 'Select all objects',
		action: () => {
			if (get(editingObject) || get(faceEditObject)) return;
			selectAllObjects();
		}
	},
	{
		// 85: the way OUT of an isolation. `when` keeps the key untouched the rest
		// of the time — Escape belongs to a dozen local handlers in this app, which
		// is also why `rebindShortcut` refuses to bind anything else TO it.
		id: 'objects.leave-isolation',
		keys: 'Escape',
		group: 'Objects',
		scope: 'viewport',
		label: 'Leave isolation (double-click view)',
		when: () => isIsolated(),
		action: () => clearIsolation()
	},
	{
		id: 'objects.delete',
		keys: 'Delete',
		group: 'Objects',
		scope: 'viewport',
		label: 'Delete selection (a group asks first)',
		action: () => deleteFromViewport()
	},
	{
		id: 'objects.delete-backspace',
		keys: 'Backspace',
		group: 'Objects',
		scope: 'viewport',
		label: 'Delete selection (Backspace)',
		action: () => deleteFromViewport()
	},
	{
		id: 'objects.edit-mesh',
		keys: 'Tab',
		group: 'Objects',
		scope: 'viewport',
		label: 'Enter mesh edit mode (inside it Tab cycles Vertices/Edges/Faces; Esc exits)',
		action: () => {
			if (get(editingObject)) exitEditMode();
			else if (get(selectedObject)?.uuid) enterEditMode(get(selectedObject).uuid);
		}
	},
	{
		// 30 P1: Edit / Interact. Free outside a mesh session (I is MESH_EDIT_KEYS' inset
		// there, which is why the registry already stands down for it); `when` also stands
		// it down while sculpt, spline or draw own the letter keys (their probes), so a
		// stray I never flips the mode under a session.
		id: 'editor.interact-mode',
		keys: 'I',
		group: 'Objects',
		scope: 'viewport',
		label: 'Edit / Interact mode (Interact: clicks play with the scene instead of selecting)',
		when: () => !keySessionOpen(),
		action: () => toggleEditorMode()
	},
	{
		id: 'panels.object-list',
		keys: 'O',
		group: 'Panels',
		scope: 'viewport',
		// the key IS the toolbar button now (one tree in panelToggles): a buried
		// window is raised first and only closes on the next press
		label: 'Object list: show / bring to front / hide',
		action: () => togglePanel('objects')
	},
	{
		id: 'panels.node-editor',
		keys: 'N',
		group: 'Panels',
		scope: 'viewport',
		label: 'Node editor: show / bring to front / hide',
		action: () => togglePanel('flow')
	},
	/*
	 * A SHORTCUT FOR EVERY TOOLBAR TOOL, and the scheme is worth stating once.
	 *
	 * The two bare keys that already existed (O, N) keep their letters; the dock itself
	 * takes bare T; every other panel takes `Alt+` its initial. A BINDING NAMES THE TOOL,
	 * NEVER A TOOLBAR SLOT — Alt+A opens the Animation editor wherever it sits in the
	 * roster, and even when it is not on the toolbar at all, which is the whole reason
	 * these are registry rows and not indices into the button strip.
	 *
	 * WHY `Alt+`, AND WHY THE MODIFIER MUST NOT BE "TIDIED AWAY": three of the six
	 * letters — E (extrude), F (create face) and S (scale) — are bare MESH_EDIT_KEYS, so
	 * a bare row on any of them would silently do nothing for as long as a mesh session
	 * is open, because `handleKeydown` stands the WHOLE registry down for those combos.
	 * MESH_EDIT_KEYS holds literal COMBO STRINGS, and 'Alt+E' is a different string from
	 * 'E', so the prefixed rows are unaffected and keep working inside a session.
	 * (A, U and H are free bare — measured — but taking the modifier off only those
	 * three would mean a user has to remember WHICH half of one scheme needs Alt, which
	 * is a worse rule than one that is always true. `conflictOf` reports the collision as
	 * its `meshEdit` half if anybody tries it.) Measured before these rows were added:
	 * all seven combos free, `{shortcut: null, meshEdit: false}` each, and no row in the
	 * registry — `fixed` display rows included — displayed any of them.
	 *
	 * Every row is an ordinary rebindable entry: a user who wants bare F for Flow Code
	 * may have it, and is warned about the mesh-session stand-down when they ask.
	 */
	{
		id: 'panels.dock',
		keys: 'T',
		group: 'Panels',
		scope: 'viewport',
		// the tool dock: the strip that holds the Node editor, Explorer, Flow Code,
		// Animation, UV, Shader and HUD tabs. Minimizing leaves every tab open, and
		// since a minimized dock draws nothing at all, this key is one of the only
		// two ways back (the toolbar buttons are the other).
		label: 'Tool dock: show / hide (Node editor, Explorer, Animation, UV, Shader, HUD…)',
		action: () => toggleDock()
	},
	{
		id: 'panels.explorer',
		keys: 'Alt+E',
		group: 'Panels',
		scope: 'global',
		label: 'Explorer: show / bring to front / hide',
		action: () => togglePanel('explorer')
	},
	{
		id: 'panels.flow-code',
		keys: 'Alt+F',
		group: 'Panels',
		scope: 'global',
		label: 'Flow Code: show / bring to front / hide',
		action: () => togglePanel('flowcode')
	},
	{
		id: 'panels.animation',
		keys: 'Alt+A',
		group: 'Panels',
		scope: 'global',
		label: 'Animation: show / bring to front / hide',
		action: () => togglePanel('animation')
	},
	{
		id: 'panels.uv-editor',
		keys: 'Alt+U',
		group: 'Panels',
		scope: 'global',
		label: 'UV editor: show / bring to front / hide',
		action: () => togglePanel('uv')
	},
	{
		id: 'panels.shader-editor',
		keys: 'Alt+S',
		group: 'Panels',
		scope: 'global',
		label: 'Shader editor: show / bring to front / hide',
		action: () => togglePanel('shader')
	},
	{
		id: 'panels.hud-editor',
		keys: 'Alt+H',
		group: 'Panels',
		scope: 'global',
		label: 'HUD editor: show / bring to front / hide',
		action: () => togglePanel('hud')
	},
	{
		id: 'panels.chat',
		keys: 'C',
		group: 'Panels',
		scope: 'viewport',
		label: 'Toggle chat',
		action: () => chatHidden.update((value) => (value === 'hidden' ? '' : 'hidden'))
	},
	{
		id: 'panels.ai-prompt',
		keys: '`',
		group: 'Panels',
		scope: 'viewport',
		label: 'Toggle AI prompt bar',
		action: () => toggleAiPrompt()
	},
	{
		id: 'objects.quick-add',
		keys: 'Shift+A',
		group: 'Objects',
		scope: 'viewport',
		label: 'Add object at the cursor (enable in Settings)',
		action: () =>
			import('../stores/appStore').then(({ addMenu, addMenuOpener, enableShiftAdd }) => {
				// opt-in (Settings ▸ "Shift+A quick add", default off)
				if (!get(enableShiftAdd)) return;
				// Scene anchors the popover to the cursor and spawns under it (same
				// point resolution as the right-click Add menu). It declines when the
				// pointer has never moved, or in VR / play / spectator mode — then fall
				// back to a centred box and the object's default spot.
				if (get(addMenuOpener)?.()) return;
				addMenu.set({
					x: Math.round(window.innerWidth / 2 - 128),
					y: Math.round(window.innerHeight * 0.3),
					point: null
				});
			})
	},
	{
		id: 'scene.save',
		keys: 'Ctrl+S',
		group: 'Scene',
		scope: 'global',
		label: 'Save scene',
		/**
		 * User report: "Ctrl+S now saves session, instead it should save current open
		 * scene, right?" - yes. It used to call `saveSession('Session ' + timestamp)`,
		 * which mints a BRAND NEW timestamped entry on every press: a snapshot-the-app
		 * gesture wearing the standard save-my-document key, so ten presses left ten
		 * sessions and the scene you were editing was still unsaved.
		 *
		 * Named scene -> a new VERSION of it, which is what `sceneOpenGuard` already does
		 * with the same two arguments when it saves before opening something else. It is
		 * reached by dynamic import for the reason the old entry was: `levels` is in the
		 * history family and a static edge from here closes the cycle.
		 *
		 * UNNAMED scene -> Save As, the universal meaning of Save on a document that has
		 * no name. `armExplorerSceneSave` is the existing write-once ARM seam the Toasts
		 * offer and `startSceneSaveBootstrap` both use; it opens the Explorer's own inline
		 * naming rather than inventing a name the user never chose.
		 */
		action: async () => {
			const [{ currentLevel, saveSceneAsLevel }, { activeFolder }] = await Promise.all([
				import('./levels'),
				import('./explorer')
			]);
			const name = get(currentLevel)?.name;
			if (!name) {
				explorerClose.set(false);
				armExplorerSceneSave(null);
				return;
			}
			const saved = await saveSceneAsLevel(name, get(activeFolder) ?? null);
			showToast(saved ? 'Saved "' + name + '"' : 'Could not save "' + name + '"');
		}
	},
	{
		id: 'history.undo',
		keys: 'Ctrl+Z',
		group: 'History',
		scope: 'global',
		label: 'Undo',
		action: () => undo()
	},
	{
		id: 'history.redo',
		keys: 'Ctrl+Y',
		group: 'History',
		scope: 'global',
		label: 'Redo',
		action: () => redo()
	},
	{
		id: 'history.redo-alt',
		keys: 'Ctrl+Shift+Z',
		group: 'History',
		scope: 'global',
		label: 'Redo (alternative)',
		action: () => redo()
	},
	...[1, 2, 3, 4, 5].map((slot) => ({
		id: `camera.bookmark-${slot}`,
		keys: `Shift+${slot}`,
		group: 'Camera',
		scope: 'viewport',
		label: `Recall camera bookmark ${slot}`,
		action: () => recallBookmark(slot - 1)
	})),
	{
		id: 'scene.physics',
		keys: 'P',
		group: 'Scene',
		scope: 'viewport',
		label: 'Simulate physics (toggle)',
		action: () => {
			if (get(editingObject) || get(faceEditObject) || get(specatorMode)) return;
			// A3: the SimControls HUD is off by default; P still works, but the first
			// time it's used while the HUD is hidden, point users at the setting so the
			// transport (pause/stop/reset) is discoverable.
			if (!get(showSimControls) && typeof localStorage !== 'undefined' && !safeStorage.getItem('simHudHintSeen')) {
				safeStorage.setItem('simHudHintSeen', '1');
				showToast('Simulation controls are hidden — enable them in Settings → Scene to show the pause/stop/reset buttons.', [
					{
						label: 'Open Settings',
						action: () => {
							settingsSection.set('scene');
							settingsOpen.set(true);
						}
					}
				]);
			}
			import('./physics').then((m) => m.toggleSimulation());
		}
	},
	{
		// Phase 5. The play FAB on the keyboard — the button, its right-click mode
		// menu and this row all press `requestPlay`, so VR/AR vs desktop is decided
		// in ONE place and this entry never has to know which.
		//
		// Ctrl+Enter and not Ctrl+P: Ctrl+P is the browser's print dialog (a
		// preventDefault race we would lose in some builds) and bare P is already
		// physics. Ctrl+Enter was free across the whole registry. A user who wants
		// Alt+P can now have it — Alt became expressible in `comboOf` this phase.
		id: 'scene.play',
		keys: 'Ctrl+Enter',
		group: 'Scene',
		scope: 'global',
		label: 'Play / Enter VR·AR (right-click the play button for modes)',
		action: () => requestPlay()
	},
	{
		// 19-B P4: the element-snap master switch. Deliberately NOT the grid switch
		// — the grid keeps `snapEnabled` (VR's applySnapMode owns that one).
		id: 'scene.snapping',
		keys: 'M',
		group: 'Scene',
		scope: 'viewport',
		label: 'Toggle element snapping (vertex/face/surface targets)',
		action: () => {
			let enabled = false;
			snapTargets.update((t) => {
				enabled = !t.enabled;
				return { ...t, enabled };
			});
			showToast(enabled ? 'Element snapping on' : 'Element snapping off');
		}
	},
	{
		id: 'voice.push-to-talk',
		keys: 'V (hold)',
		group: 'Voice',
		scope: 'global',
		label: 'Push to talk while the mic toggle is off',
		// handled by voiceChat.js (needs keyup); listed here for discoverability
		fixed: true,
		fixedReason: 'hold key, handled by voiceChat'
	},
	/*
	 * 36 B8 — THE MESH-EDIT KEYMAP, rebindable. These were two bundled DISPLAY rows
	 * ('E I G S B F X / W'); each command is its own `external` row now (scope 'mesh'),
	 * so Settings ▸ Shortcuts can move it. MeshEditPopup's own keydown still runs them —
	 * it asks `meshCommandFor(combo)` which command a press means — and the registry's
	 * stand-down during a session follows the CURRENT keys (`meshEditKeys`).
	 */
	...meshRows([
		['mesh.mode-next', 'Tab', 'Next element mode (Vertices - Edges - Faces)'],
		['mesh.mode-prev', 'Shift+Tab', 'Previous element mode'],
		['mesh.select-all', 'Ctrl+A', 'Select all (any mode)'],
		['mesh.select-invert', 'Ctrl+I', 'Invert the selection (any mode)'],
		['mesh.grow', 'Ctrl+=', 'Grow the selection (faces)'],
		['mesh.shrink', 'Ctrl+-', 'Shrink the selection (faces)'],
		['mesh.move', 'G', 'Arm Move (faces)'],
		['mesh.extrude', 'E', 'Arm Extrude (faces)'],
		['mesh.inset', 'I', 'Arm Inset (faces)'],
		['mesh.subdivide', 'S', 'Subdivide (faces)'],
		['mesh.loopcut', 'C', 'Loop cut (faces)'],
		['mesh.bridge', 'B', 'Bridge (faces)'],
		['mesh.flip', 'F', 'Flip normals (faces)'],
		['mesh.delete', 'X', 'Delete the selection (faces; Delete too)'],
		['mesh.loop', 'L', 'Loop select (faces: again = perpendicular; edges: the chain)'],
		['mesh.weld', 'W', 'Weld the selected vertices (vertices)']
	]),
	/*
	 * 36 U11 — THE NODE EDITOR'S KEYMAP (scope 'nodes'). These fire only while the node
	 * editor holds keyboard focus (a press landed in it last), so they can reuse letters
	 * the viewport spends on something else: F frames nodes there and focuses the object
	 * here, N adds a note there and opens the editor here, Delete deletes whichever the
	 * user is looking at. Blender/Unreal conventions where they don't clash. Each row
	 * declines the key (`when`) unless a node editor is mounted, so a press in an empty
	 * scope is left alone.
	 */
	...nodeRows([
		['nodes.frame-selected', 'F', 'frame', 'Frame the selected nodes (all when none are selected)'],
		['nodes.frame-all', 'A', 'frameAll', 'Frame all nodes'],
		['nodes.frame-all-home', 'Home', 'frameAll', 'Frame all nodes (Home)'],
		['nodes.add-search', 'Shift+A', 'addSearch', 'Add a node at the cursor (search)'],
		['nodes.add-search-space', 'Space', 'addSearch', 'Add a node at the cursor (search) — Space'],
		['nodes.delete', 'Delete', 'delete', 'Delete the selected nodes and wires'],
		['nodes.delete-x', 'X', 'delete', 'Delete the selected nodes and wires (X)'],
		['nodes.delete-backspace', 'Backspace', 'delete', 'Delete the selected nodes and wires (Backspace)'],
		['nodes.duplicate', 'Ctrl+D', 'duplicate', 'Duplicate the selection (wires between copies kept)'],
		['nodes.select-all', 'Ctrl+A', 'selectAll', 'Select all nodes'],
		['nodes.copy', 'Ctrl+C', 'copy', 'Copy the selection'],
		['nodes.cut', 'Ctrl+X', 'cut', 'Cut the selection'],
		['nodes.paste', 'Ctrl+V', 'paste', 'Paste at the cursor'],
		['nodes.mute', 'M', 'mute', 'Mute / unmute the selection (a muted node does nothing)'],
		['nodes.collapse', 'H', 'collapse', 'Collapse / expand the selected nodes'],
		['nodes.group', 'Ctrl+G', 'group', 'Group the selection'],
		['nodes.ungroup', 'Ctrl+Shift+G', 'ungroup', 'Ungroup (the selected group, or the one you are in)'],
		['nodes.enter-group', 'Tab', 'toggleGroup', 'Enter the selected group / leave the one you are in'],
		['nodes.add-note', 'N', 'addNote', 'Add a note at the cursor'],
		['nodes.note-around', 'Shift+N', 'noteAround', 'Add a note around the selection (a frame)'],
		['nodes.tidy', 'L', 'tidy', 'Tidy the graph: lay it out left to right, nothing overlapping, no wire across a card'],
		['nodes.tidy-keep', 'Shift+L', 'tidyKeep', 'Fix overlaps and crossings, keeping the layout'],
		['nodes.align-column', 'Q', 'alignColumn', 'Align the selection into a column (left edges)'],
		['nodes.align-row', 'E', 'alignRow', 'Align the selection into a row (top edges)'],
		['nodes.distribute-v', 'Shift+Q', 'distributeV', 'Distribute the selection evenly top to bottom'],
		['nodes.distribute-h', 'Shift+E', 'distributeH', 'Distribute the selection evenly left to right'],
		['nodes.nudge-left', 'ArrowLeft', 'nudge', 'Nudge the selection left (Shift: ×5)', [-1, 0]],
		['nodes.nudge-right', 'ArrowRight', 'nudge', 'Nudge the selection right', [1, 0]],
		['nodes.nudge-up', 'ArrowUp', 'nudge', 'Nudge the selection up', [0, -1]],
		['nodes.nudge-down', 'ArrowDown', 'nudge', 'Nudge the selection down', [0, 1]],
		['nodes.nudge-left-far', 'Shift+ArrowLeft', 'nudge', 'Nudge the selection left ×5', [-5, 0]],
		['nodes.nudge-right-far', 'Shift+ArrowRight', 'nudge', 'Nudge the selection right ×5', [5, 0]],
		['nodes.nudge-up-far', 'Shift+ArrowUp', 'nudge', 'Nudge the selection up ×5', [0, -5]],
		['nodes.nudge-down-far', 'Shift+ArrowDown', 'nudge', 'Nudge the selection down ×5', [0, 5]]
	]),
	{
		// Esc leaves a group, but only while one is entered: `when` leaves the key alone
		// the rest of the time (Escape belongs to a dozen local handlers).
		id: 'nodes.leave-group',
		keys: 'Escape',
		group: 'Node editor',
		scope: 'nodes',
		label: 'Leave the group you are in',
		when: () => nodeEditorInsideGroup() && hasNodeAction('leaveGroup'),
		action: () => runNodeAction('leaveGroup')
	},
	{
		// I3: the cheat sheet, generated FROM this registry so it can never go stale.
		// Global (it describes every scope), and opens on the scope that has focus.
		id: 'help.cheatsheet',
		keys: '?',
		group: 'Help',
		scope: 'global',
		label: 'Keyboard cheat sheet (every scope; the focused one first)',
		action: () => cheatSheetOpen.update((open) => !open)
	},
	{
		id: 'help.shortcuts',
		keys: 'Ctrl+/',
		group: 'Help',
		scope: 'global',
		label: 'Show this shortcut list',
		action: () => {
			settingsSection.set('shortcuts');
			settingsOpen.set(true);
		}
	}
];

/* ------------------------------------------------------- rebinding (Phase 5) -- */

const OVERRIDES_KEY = 'shortcutOverrides';

/** Combos nothing may be rebound TO. Escape is owned by roughly a dozen local
 * handlers (mesh sessions, pick modes, modals, the isolation exit above), none of
 * which consults this registry — binding a command onto it would swallow one of
 * them silently, which is the failure nobody files as a shortcut bug. */
const DENY_KEYS = ['Escape'];

/** user rebinds, `{ id: keys }` @type {Record<string, string>} */
let overrides = {};

/** Read the stored overrides. SSR-guarded and try/catch'd: localStorage throws
 * outright in some privacy modes, and a shortcut registry may never be the reason
 * the app fails to boot. @returns {Record<string, string>} */
function loadOverrides() {
	try {
		if (typeof localStorage === 'undefined') return {};
		const raw = safeStorage.getItem(OVERRIDES_KEY);
		const parsed = raw ? JSON.parse(raw) : null;
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
		/** @type {Record<string, string>} */
		const clean = {};
		for (const [id, keys] of Object.entries(parsed)) if (typeof keys === 'string' && keys) clean[id] = keys;
		return clean;
	} catch {
		return {};
	}
}

function saveOverrides() {
	try {
		if (typeof localStorage === 'undefined') return;
		if (Object.keys(overrides).length) safeStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
		// an empty map is the DEFAULT state, so remove the key rather than store `{}`
		else safeStorage.removeItem(OVERRIDES_KEY);
	} catch {
		/* private mode: the rebind still applies for this session */
	}
}

/** Seed `defaultKeys` from whatever the entry was authored with. Runs once per
 * entry — at module init for the built-ins, and in registerShortcut for the rest. */
function seedDefaults() {
	for (const s of shortcuts) if (s.defaultKeys === undefined) s.defaultKeys = s.keys;
}

/**
 * Write the effective combo onto every entry's `keys`. This is the whole reason
 * nothing else in the app changed: the matcher, Settings' renderer and
 * editorNavigation's Shift+<key> probe all read `keys` and never learn that an
 * override exists. A `fixed` row is a display label ('W A S D'), not a combo, so
 * it is left alone.
 */
export function applyOverrides() {
	seedDefaults();
	for (const s of shortcuts) {
		if (s.fixed) continue;
		s.keys = overrides[s.id] ?? /** @type {string} */ (s.defaultKeys);
	}
}

seedDefaults();
overrides = loadOverrides();
applyOverrides();

/** @param {string} text */
function slug(text) {
	return String(text || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/**
 * 30 P1: editor SESSIONS that own the plain letter keys register a probe here — sculpt,
 * spline edit and draw (Scene, which already imports all three) — so a mode key can stand
 * down while one is open without this module importing them: shortcuts sits inside
 * history's import family, and splineEdit reaches vrControls, which would close a cycle.
 * @type {(() => boolean)[]} */
const keySessionProbes = [];

/** @param {() => boolean} probe @returns {() => void} unregister */
export function registerKeySessionProbe(probe) {
	keySessionProbes.push(probe);
	return () => {
		const index = keySessionProbes.indexOf(probe);
		if (index >= 0) keySessionProbes.splice(index, 1);
	};
}

/** Is any session holding the letter keys right now (mesh edit included)? */
export function keySessionOpen() {
	if (get(editingObject) || get(faceEditObject)) return true;
	return keySessionProbes.some((probe) => {
		try {
			return !!probe();
		} catch {
			return false;
		}
	});
}

/**
 * @param {ShortcutInput} shortcut
 */
export function registerShortcut(shortcut) {
	// Dedupe by ID, not by keys. Keys-dedupe was correct while every combo was
	// authored once and never moved; the moment a user override FREES a default
	// combo, a re-register would find no collision and push a duplicate entry.
	const id = shortcut.id || 'module:' + slug(shortcut.group) + ':' + slug(shortcut.label);
	if (shortcuts.some((s) => s.id === id)) return;
	shortcuts.push({ ...shortcut, id, defaultKeys: shortcut.keys });
	applyOverrides();
}

/** T2 (34 R6): drop ONE registered shortcut by id — a module toolbox's shortcut lives in
 * the shared 'Modules' group, so a group-wide unregister would take every module's with it.
 * @param {string} id */
export function unregisterShortcut(id) {
	for (let i = shortcuts.length - 1; i >= 0; i--) {
		if (shortcuts[i].id === id) shortcuts.splice(i, 1);
	}
}

/** A2: drop every registered shortcut of one group (module-binding teardown
 * for the dev-mode reload — a re-register lists them fresh). @param {string} group */
export function unregisterShortcutGroup(group) {
	for (let i = shortcuts.length - 1; i >= 0; i--) {
		if (shortcuts[i].group === group) shortcuts.splice(i, 1);
	}
}

/** May this entry be rebound at all?
 *
 * `fixed` rows are display LABELS ('W A S D', 'V (hold)') and never combos, so nothing
 * can be bound onto them. Otherwise a row needs an OWNER for the key: either an action
 * of its own, or `external: true` — which says the combo is real and somebody else runs
 * it (see the note at the top). A module's declared binding, which the module reads
 * straight off the keyboard with no combo of ours, has neither and stays listed for
 * discoverability alone.
 * @param {Shortcut} s */
export function isRebindable(s) {
	return !!s && !s.fixed && (typeof s.action === 'function' || s.external === true);
}

/**
 * The combo `id` currently answers to, overrides included — the read half of an
 * `external` row. An editor that owns its own keydown asks this instead of hard-coding
 * a letter, so rebinding the row in Settings actually moves the key.
 * @param {string} id @returns {string|null}
 */
export function bindingOf(id) {
	return shortcuts.find((s) => s.id === id)?.keys ?? null;
}

/** Where a row's combo means something; absent = global. @param {string=} id */
function scopeOf(id) {
	return shortcuts.find((s) => s.id === id)?.scope || 'global';
}

/**
 * 36 U11: can two rows hear the same press? Same scope always; a GLOBAL row also
 * collides with any scoped REGISTRY row, because in that scope the scoped row shadows
 * it (a key that silently does nothing there is the conflict worth warning about). An
 * `external` row is exempt from the global half: its editor's capture handler stops the
 * event before the registry sees it, which is the W5 rule that lets G be Move here and
 * Arm Move in two editors.
 * @param {Shortcut} a @param {string} scopeA @param {Shortcut} b
 */
function scopesCollide(a, scopeA, b) {
	const sb = b.scope || 'global';
	if (scopeA === sb) return true;
	if (a.external || b.external) return false;
	return scopeA === 'global' || sb === 'global';
}

/**
 * Who else already answers to this combo.
 *
 * Returns BOTH halves because they are different verdicts: `shortcut` is a hard
 * collision inside the registry (the caller offers a swap), while `meshEdit` is a
 * warning — MESH_EDIT_KEYS is a list of literal COMBOS, so the stand-down below
 * keeps working for a rebound combo too, and the key simply does nothing while a
 * mesh session is open. Worth saying out loud, never worth blocking.
 *
 * W5: the search is SCOPED. Only rows that can hear the same press collide — see the
 * scope rule at the top of the file. `scope` is taken from the row being rebound
 * unless a caller states one, so the existing `conflictOf(combo, id)` call site keeps
 * meaning what it always did.
 * @param {string} keys
 * @param {string} [excludeId]
 * @param {string|null} [scope]
 * @returns {{ shortcut: Shortcut | null, meshEdit: boolean }}
 */
export function conflictOf(keys, excludeId, scope) {
	const mine = (scope === undefined ? scopeOf(excludeId) : scope) || 'global';
	const self = shortcuts.find((s) => s.id === excludeId) ?? /** @type {Shortcut} */ ({ scope: mine });
	const other = shortcuts.find(
		(s) => s.id !== excludeId && isRebindable(s) && s.keys === keys && scopesCollide(self, mine, s)
	);
	return { shortcut: other ?? null, meshEdit: mine !== 'mesh' && meshEditKeys().includes(keys) };
}

/**
 * Bind `id` to `keys`. Refuses rather than clobbers: a collision comes back as
 * `{ok:false, conflict}` so the caller can offer the swap explicitly.
 * @param {string} id
 * @param {string} keys
 * @returns {{ ok: boolean, conflict?: Shortcut, meshEdit?: boolean, reason?: string }}
 */
export function rebindShortcut(id, keys) {
	const entry = shortcuts.find((s) => s.id === id);
	if (!entry) return { ok: false, reason: 'no such shortcut' };
	if (!isRebindable(entry)) return { ok: false, reason: entry.fixedReason || 'this row is not rebindable' };
	const combo = String(keys || '').trim();
	if (!combo) return { ok: false, reason: 'no keys' };
	// a bare modifier is not a shortcut (the capture UI filters these too, but a
	// programmatic caller can reach here)
	if (/(^|\+)(Control|Alt|Shift|Meta)$/.test(combo)) return { ok: false, reason: 'a modifier alone is not a shortcut' };
	if (DENY_KEYS.includes(combo)) return { ok: false, reason: `${combo} is reserved` };
	if (combo === entry.keys) return { ok: true }; // no-op, and never a self-conflict

	const { shortcut: other, meshEdit } = conflictOf(combo, id);
	if (other) return { ok: false, conflict: other, meshEdit };

	setOverride(id, combo);
	return { ok: true, meshEdit };
}

/** The write half of a rebind, shared with the Settings swap (which has to move
 * TWO rows at once and has already decided both are fine).
 * @param {string} id @param {string} keys */
export function setOverride(id, keys) {
	const entry = shortcuts.find((s) => s.id === id);
	if (!entry) return;
	// back at the default = no override, so "reset" and "typed the default back in"
	// leave identical state
	if (keys === entry.defaultKeys) delete overrides[id];
	else overrides[id] = keys;
	saveOverrides();
	applyOverrides();
}

/** @param {string} id */
export function resetShortcut(id) {
	delete overrides[id];
	saveOverrides();
	applyOverrides();
}

export function resetAllShortcuts() {
	overrides = {};
	saveOverrides();
	applyOverrides();
}

/** The stored overrides, for the UI's "is this row customised" test.
 * @returns {Record<string, string>} */
export function shortcutOverrides() {
	return { ...overrides };
}

/* ------------------------------------------------------------ the key handler -- */

/** D3: the bare keys MeshEditPopup's local keydown consumes while a session is
 * active and its hotkeys pref is on (faces E/I/G/S/B/F/X, M2 loop select L ·
 * vertices W) */
// Keys a live mesh-edit session owns outright — the registry stands down for
// these while one is open (two window keydown listeners cannot stop each other,
// so the global side has to ask).
// 1/2/3 came OFF this list: they are Move/Rotate/Scale everywhere in the app,
// and suppressing them here to spend them on element modes left a session with
// no way to switch the gizmo. Element modes moved to Tab/Shift+Tab, which the
// session now owns instead — Tab still ENTERS Edit Mesh from outside, and Esc
// (or Done) is still how you leave.
// Phase 5: this is a list of literal COMBOS, tested against the combo the user
// pressed — never against a shortcut id. So it keeps standing down correctly for
// whatever a user rebinds onto one of these keys, and stops standing down for a
// command they move OFF one. `conflictOf` warns about the first case.
// 36 B8: DERIVED from the mesh-edit rows' current combos (unmodified ones — the Ctrl
// selection chords never collided: the viewport's own Ctrl+A stands down in a session),
// so a rebound mesh key moves the stand-down with it.
function meshEditKeys() {
	return shortcuts.filter((s) => s.scope === 'mesh' && !/^(Ctrl|Alt)\+/.test(s.keys)).map((s) => s.keys);
}

/** True while Settings is listening for the next combo to bind. The registry has
 * to stand down for that press: it must be RECORDED, not executed. (Settings is a
 * modal, so `anyModalOpen` already mutes almost everything — this is the guard
 * that keeps the capture correct if it is ever opened anywhere else, and it is
 * what the suite pins.) */
let capturing = false;

/** @param {boolean} value */
export function setShortcutCapture(value) {
	capturing = !!value;
}

/**
 * The combo string for an event, in canonical `Ctrl+Alt+Shift+K` order.
 * Exported since Phase 5: Settings' capture listener must build the string the
 * matcher will later compare against, and there may only be one way to spell it.
 * @param {KeyboardEvent} event
 */
export function comboOf(event) {
	// 24-A1: `keyOf` keeps the two rules this used to spell out — digits by code so
	// Shift+1 stays "Shift+1" instead of "!", single characters uppercased — and adds
	// the one that was missing: a NON-ASCII character (a Cyrillic/Greek/Hebrew layout)
	// resolves to the physical key, so `G`, `F`, `Ctrl+Z` work on every layout. Latin
	// layouts produce byte-identical combos (the hotkeys-layout suite pins the registry).
	let key = keyOf(event);
	// 36 I3: a SHIFTED SYMBOL already says Shift (`?` is Shift+/ on a US layout and a
	// different key elsewhere), so the modifier is not part of its name — `?` must match
	// `?` on every layout. Letters and digits keep it (Shift+A, Shift+1). Space gets a name.
	if (key === ' ') key = 'Space';
	const symbol = key.length === 1 && !/[a-z0-9]/i.test(key);
	return (
		(event.ctrlKey || event.metaKey ? 'Ctrl+' : '') +
		// Phase 5: Alt was previously unrepresentable, so no default uses it — every
		// existing combo is Alt-free and comes out byte-identical. It exists for
		// rebinding, where it roughly doubles the free space.
		(event.altKey ? 'Alt+' : '') +
		(event.shiftKey && !symbol ? 'Shift+' : '') +
		key
	);
}

/**
 * 24-A1: set the first time a keydown carries a non-ASCII character on a lettered
 * physical key — i.e. the user is on a non-Latin layout and letter shortcuts are
 * resolving by POSITION. Settings ▸ Shortcuts reads it to say so where the browser
 * cannot map the labels itself (`navigator.keyboard.getLayoutMap` is Chromium-only).
 * @type {import('svelte/store').Writable<boolean>} */
export const nonLatinLayoutSeen = writable(false);

/** @param {KeyboardEvent} event */
function handleKeydown(event) {
	const raw = event.key || '';
	if (raw.length === 1 && !/[a-z0-9]/i.test(raw) && /^Key[A-Z]$/.test(event.code || '') && !get(nonLatinLayoutSeen))
		nonLatinLayoutSeen.set(true);
	// Settings is recording this press as a binding — the registry must not also
	// ACT on it.
	if (capturing) return;
	// 36 U11: WHERE the press happened. Text entry (chat, node widgets, property inputs)
	// and code editors never reach a registry action; every other press belongs to the
	// pane that last took a pointer press or focus (keyScope.js).
	const focused = scopeOfEvent(event);
	if (focused === 'text' || focused === 'code') return;
	// play mode owns the keyboard (WASD)
	if (get(isLocked)) return;

	const combo = comboOf(event);
	// 36 L4: inside an open popover/menu (the profile dropdown is a flowbite popover) Tab
	// is the browser's focus navigation — the global Tab (enter Edit Mesh) left every
	// menu row unreachable by keyboard
	const target = /** @type {any} */ (event.target);
	if ((combo === 'Tab' || combo === 'Shift+Tab') && target?.closest?.('[popover], [role="menu"], dialog')) return;
	// D3: while a mesh-edit session owns its hotkeys, bare mesh-edit keys never
	// match the registry — F would ALSO focus the object mid-edit. Delete
	// self-guards; 1/2/3 intentionally stay (gizmo mode on the proxy).
	if (
		(focused === 'viewport' || focused === 'vr') &&
		meshEditKeys().includes(combo) &&
		(get(editingObject) || get(faceEditObject)) &&
		get(meshEditHotkeys)
	)
		return;
	// `external` rows are somebody else's key (an editor's own capture handler runs
	// them) and are skipped EXPLICITLY, not merely by having no action: they share
	// combos with global rows on purpose — G is Move here and Arm Move in two editors
	// — and a bare `find` on `keys` could return one of them and shadow the real
	// command depending on where it happened to sit in the array.
	// 36 U11: of the rows bound to this combo, the FOCUSED scope's own row wins, a global
	// row answers otherwise (keyScope.pickForScope). A row that declines (`when`) is not a
	// candidate, so it never blocks a row further down the chain.
	const live = shortcuts.filter(
		(s) => s.keys === combo && !s.external && typeof s.action === 'function' && (!s.when || s.when())
	);
	const shortcut = pickForScope(live, focused);
	if (!shortcut || !shortcut.action) return;
	// 15-B6: app modals are non-modal <dialog>s, so the page behind them is NOT
	// inert and these window handlers still fire — every modal now mutes them
	// (was Settings only, which is also why panel toggles couldn't fight the
	// hidePanels snapshot). The help list stays live — by ID since Phase 5, so
	// the exemption follows the command when a user rebinds it.
	if (get(anyModalOpen) && shortcut.id !== 'help.shortcuts' && shortcut.id !== 'help.cheatsheet') return;
	// A binding may decline the key (85: Escape only means "leave isolation" WHILE
	// something is isolated). Declining rows were filtered out above, BEFORE
	// preventDefault, so a declined key is left completely untouched for whoever else
	// handles it — registering Escape would otherwise swallow the browser default on
	// every press in the app.

	event.preventDefault();
	shortcut.action();
}

let started = false;

export function startShortcuts() {
	if (started || typeof window === 'undefined') return;
	started = true;
	// re-read: the module-level pass runs during SSR/prerender too, where there is
	// no localStorage to read from
	overrides = loadOverrides();
	applyOverrides();
	startKeyScope();
	setVrScopeProbe(() => !!get(isVRMode));
	window.addEventListener('keydown', handleKeydown);
}
