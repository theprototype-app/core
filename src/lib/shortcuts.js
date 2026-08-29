import { get } from 'svelte/store';
import { TControls, isLocked } from '../stores/sceneStore';
import {
	flowGraphClose,
	chatHidden,
	settingsOpen,
	anyModalOpen,
	settingsSection,
	specatorMode,
	aiPromptBarOpen,
	showToast,
	showSimControls
} from '../stores/appStore';
import { aiReady } from './ai/providers';
import {
	focusObject,
	duplicateSelection,
	requestDeleteSelection,
	setTransformMode,
	selectAllObjects,
	clearIsolation,
	isIsolated
} from './objectActions';
import { undo, redo } from './history';
import { editingObject, enterEditMode, exitEditMode } from './meshEdit';
import { faceEditObject, meshEditHotkeys } from './faceEdit';
import { recallBookmark } from './cameraBookmarks';
import { snapTargets } from './snapping';
import { togglePanel } from './panelToggles';
// Phase 5: the play FAB's own entry point. playMode.js imports sceneStore +
// svelte/store ONLY (it says so at the top of the file, and that is deliberate),
// so this static edge adds nothing to shortcuts' subtree — which matters, because
// shortcuts sits inside history's import family and a cycle there TDZ-crashes the
// SSR prerender.
import { requestPlay } from './playMode';
import { selectedObject } from '../stores/sceneStore';

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
	if (get(flowGraphClose) === false) return; // node editor owns the key while open
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

/** @type {Shortcut[]} */
export const shortcuts = [
	// transform hotkeys live on 1/2/3 — W/E/R belong to fly navigation now
	{
		id: 'transform.move',
		keys: '1',
		group: 'Transform',
		label: 'Move (translate)',
		action: () => setTransformMode('translate')
	},
	{
		id: 'transform.rotate',
		keys: '2',
		group: 'Transform',
		label: 'Rotate',
		action: () => setTransformMode('rotate')
	},
	{
		id: 'transform.scale',
		keys: '3',
		group: 'Transform',
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
		label: 'Fly the camera (horizontal)',
		fixed: true,
		fixedReason: 'movement keys, handled by fly navigation'
	},
	{
		id: 'movement.fly-vertical',
		keys: 'Q / E',
		group: 'Movement',
		label: 'Fly down / up',
		fixed: true,
		fixedReason: 'movement keys, handled by fly navigation'
	},
	{
		id: 'movement.fly-fast',
		keys: 'Shift (hold)',
		group: 'Movement',
		label: 'Fly 3x faster',
		fixed: true,
		fixedReason: 'hold modifier, handled by fly navigation'
	},
	{
		id: 'camera.focus',
		keys: 'F',
		group: 'Camera',
		label: 'Focus selected object',
		action: () => focusObject()
	},
	{
		id: 'objects.duplicate',
		keys: 'Ctrl+D',
		group: 'Objects',
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
		label: 'Leave isolation (double-click view)',
		when: () => isIsolated(),
		action: () => clearIsolation()
	},
	{
		id: 'objects.delete',
		keys: 'Delete',
		group: 'Objects',
		label: 'Delete selection (a group asks first)',
		action: () => deleteFromViewport()
	},
	{
		id: 'objects.delete-backspace',
		keys: 'Backspace',
		group: 'Objects',
		label: 'Delete selection (Backspace)',
		action: () => deleteFromViewport()
	},
	{
		id: 'objects.edit-mesh',
		keys: 'Tab',
		group: 'Objects',
		label: 'Enter mesh edit mode (inside it Tab cycles Vertices/Edges/Faces; Esc exits)',
		action: () => {
			if (get(editingObject)) exitEditMode();
			else if (get(selectedObject)?.uuid) enterEditMode(get(selectedObject).uuid);
		}
	},
	{
		id: 'panels.object-list',
		keys: 'O',
		group: 'Panels',
		// the key IS the toolbar button now (one tree in panelToggles): a buried
		// window is raised first and only closes on the next press
		label: 'Object list: show / bring to front / hide',
		action: () => togglePanel('objects')
	},
	{
		id: 'panels.node-editor',
		keys: 'N',
		group: 'Panels',
		label: 'Node editor: show / bring to front / hide',
		action: () => togglePanel('flow')
	},
	{
		id: 'panels.chat',
		keys: 'C',
		group: 'Panels',
		label: 'Toggle chat',
		action: () => chatHidden.update((value) => (value === 'hidden' ? '' : 'hidden'))
	},
	{
		id: 'panels.ai-prompt',
		keys: '`',
		group: 'Panels',
		label: 'Toggle AI prompt bar',
		action: () => toggleAiPrompt()
	},
	{
		id: 'objects.quick-add',
		keys: 'Shift+A',
		group: 'Objects',
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
		label: 'Save session',
		action: () =>
			import('./sessions').then(({ saveSession }) =>
				saveSession('Session ' + new Date().toLocaleString())
			)
	},
	{
		id: 'history.undo',
		keys: 'Ctrl+Z',
		group: 'History',
		label: 'Undo',
		action: () => undo()
	},
	{
		id: 'history.redo',
		keys: 'Ctrl+Y',
		group: 'History',
		label: 'Redo',
		action: () => redo()
	},
	{
		id: 'history.redo-alt',
		keys: 'Ctrl+Shift+Z',
		group: 'History',
		label: 'Redo (alternative)',
		action: () => redo()
	},
	...[1, 2, 3, 4, 5].map((slot) => ({
		id: `camera.bookmark-${slot}`,
		keys: `Shift+${slot}`,
		group: 'Camera',
		label: `Recall camera bookmark ${slot}`,
		action: () => recallBookmark(slot - 1)
	})),
	{
		id: 'scene.physics',
		keys: 'P',
		group: 'Scene',
		label: 'Simulate physics (toggle)',
		action: () => {
			if (get(editingObject) || get(faceEditObject) || get(specatorMode)) return;
			// A3: the SimControls HUD is off by default; P still works, but the first
			// time it's used while the HUD is hidden, point users at the setting so the
			// transport (pause/stop/reset) is discoverable.
			if (!get(showSimControls) && typeof localStorage !== 'undefined' && !localStorage.getItem('simHudHintSeen')) {
				localStorage.setItem('simHudHintSeen', '1');
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
		label: 'Play / Enter VR·AR (right-click the play button for modes)',
		action: () => requestPlay()
	},
	{
		// 19-B P4: the element-snap master switch. Deliberately NOT the grid switch
		// — the grid keeps `snapEnabled` (VR's applySnapMode owns that one).
		id: 'scene.snapping',
		keys: 'M',
		group: 'Scene',
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
		label: 'Push to talk while the mic toggle is off',
		// handled by voiceChat.js (needs keyup); listed here for discoverability
		fixed: true,
		fixedReason: 'hold key, handled by voiceChat'
	},
	{
		id: 'mesh-edit.ops',
		keys: 'E I G S B F X / W',
		group: 'Mesh edit',
		label: 'Mesh edit ops, only in Edit Mesh (toggle on the toolbar)',
		// handled by MeshEditPopup's local keydown; ONE bundled display row
		fixed: true,
		fixedReason: 'owned by the mesh-edit session'
	},
	{
		id: 'mesh-edit.loops',
		keys: 'L / Ctrl+ +- / Ctrl+A / Ctrl+I',
		group: 'Mesh edit',
		label: 'M2/M3: loop select · loop cut (C) · grow/shrink · select all/invert (faces)',
		// same local handler, same bundling reason as the row above
		fixed: true,
		fixedReason: 'owned by the mesh-edit session'
	},
	{
		id: 'help.shortcuts',
		keys: 'Ctrl+/',
		group: 'Help',
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
		const raw = localStorage.getItem(OVERRIDES_KEY);
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
		if (Object.keys(overrides).length) localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
		// an empty map is the DEFAULT state, so remove the key rather than store `{}`
		else localStorage.removeItem(OVERRIDES_KEY);
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
	return shortcuts.find((s) => s.id === id)?.scope ?? null;
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
	const mine = scope === undefined ? scopeOf(excludeId) : scope;
	const other = shortcuts.find(
		(s) => s.id !== excludeId && isRebindable(s) && s.keys === keys && (s.scope ?? null) === (mine ?? null)
	);
	return { shortcut: other ?? null, meshEdit: MESH_EDIT_KEYS.includes(keys) };
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
const MESH_EDIT_KEYS = ['E', 'I', 'G', 'S', 'B', 'F', 'X', 'W', 'L', 'C', 'Tab', 'Shift+Tab'];

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
	// raw || '': synthetic events (Chrome password-manager autofill) have key undefined
	const raw = event.key || '';
	// digits by code so Shift+1 stays "Shift+1" instead of layout characters like "!"
	const key = event.code?.startsWith('Digit')
		? event.code.slice(5)
		: raw.length === 1
			? raw.toUpperCase()
			: raw;
	return (
		(event.ctrlKey || event.metaKey ? 'Ctrl+' : '') +
		// Phase 5: Alt was previously unrepresentable, so no default uses it — every
		// existing combo is Alt-free and comes out byte-identical. It exists for
		// rebinding, where it roughly doubles the free space.
		(event.altKey ? 'Alt+' : '') +
		(event.shiftKey ? 'Shift+' : '') +
		key
	);
}

/** @param {KeyboardEvent} event */
function handleKeydown(event) {
	// Settings is recording this press as a binding — the registry must not also
	// ACT on it.
	if (capturing) return;
	/** @type {any} */
	const target = event.target;
	// never steal keys from text entry (chat, node widgets, property inputs)
	if (
		target &&
		(target.tagName === 'INPUT' ||
			target.tagName === 'TEXTAREA' ||
			target.tagName === 'SELECT' ||
			target.isContentEditable)
	)
		return;
	// play mode owns the keyboard (WASD)
	if (get(isLocked)) return;

	const combo = comboOf(event);
	// D3: while a mesh-edit session owns its hotkeys, bare mesh-edit keys never
	// match the registry — F would ALSO focus the object mid-edit. Delete
	// self-guards; 1/2/3 intentionally stay (gizmo mode on the proxy).
	if (
		MESH_EDIT_KEYS.includes(combo) &&
		(get(editingObject) || get(faceEditObject)) &&
		get(meshEditHotkeys)
	)
		return;
	// `external` rows are somebody else's key (an editor's own capture handler runs
	// them) and are skipped EXPLICITLY, not merely by having no action: they share
	// combos with global rows on purpose — G is Move here and Arm Move in two editors
	// — and a bare `find` on `keys` could return one of them and shadow the real
	// command depending on where it happened to sit in the array.
	const shortcut = shortcuts.find((s) => s.keys === combo && !s.external);
	if (!shortcut || !shortcut.action) return;
	// 15-B6: app modals are non-modal <dialog>s, so the page behind them is NOT
	// inert and these window handlers still fire — every modal now mutes them
	// (was Settings only, which is also why panel toggles couldn't fight the
	// hidePanels snapshot). The help list stays live — by ID since Phase 5, so
	// the exemption follows the command when a user rebinds it.
	if (get(anyModalOpen) && shortcut.id !== 'help.shortcuts') return;
	// A binding may decline the key (85: Escape only means "leave isolation" WHILE
	// something is isolated). Checked BEFORE preventDefault, so a declined key is
	// left completely untouched for whoever else handles it — registering Escape
	// would otherwise swallow the browser default on every press in the app.
	if (shortcut.when && !shortcut.when()) return;

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
	window.addEventListener('keydown', handleKeydown);
}
