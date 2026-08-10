import { get } from 'svelte/store';
import { TControls, isLocked } from '../stores/sceneStore';
import {
	flowGraphClose,
	objectListClose,
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
import { focusObject, duplicateSelection, requestDeleteSelection, setTransformMode } from './objectActions';
import { undo, redo } from './history';
import { editingObject, enterEditMode, exitEditMode } from './meshEdit';
import { faceEditObject, meshEditHotkeys } from './faceEdit';
import { recallBookmark } from './cameraBookmarks';
import { selectedObject } from '../stores/sceneStore';

// Single source of truth for keyboard shortcuts: the same registry binds the keys
// and renders the list in Settings -> Shortcuts. Other modules push entries via
// registerShortcut() so their keys show up in the list automatically.

/** @typedef {{ keys: string, group: string, label: string, action?: () => void }} Shortcut */

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
		keys: '1',
		group: 'Transform',
		label: 'Move (translate)',
		action: () => setTransformMode('translate')
	},
	{
		keys: '2',
		group: 'Transform',
		label: 'Rotate',
		action: () => setTransformMode('rotate')
	},
	{
		keys: '3',
		group: 'Transform',
		label: 'Scale',
		action: () => setTransformMode('scale')
	},
	{ keys: 'W A S D', group: 'Movement', label: 'Fly the camera (horizontal)' },
	{ keys: 'Q / E', group: 'Movement', label: 'Fly down / up' },
	{ keys: 'Shift (hold)', group: 'Movement', label: 'Fly 3x faster' },
	{
		keys: 'F',
		group: 'Camera',
		label: 'Focus selected object',
		action: () => focusObject()
	},
	{
		keys: 'Ctrl+D',
		group: 'Objects',
		label: 'Duplicate selection (whole set)',
		action: () => duplicateSelection()
	},
	{
		keys: 'Delete',
		group: 'Objects',
		label: 'Delete selection (a group asks first)',
		action: () => deleteFromViewport()
	},
	{
		keys: 'Backspace',
		group: 'Objects',
		label: 'Delete selection (Backspace)',
		action: () => deleteFromViewport()
	},
	{
		keys: 'Tab',
		group: 'Objects',
		label: 'Toggle mesh edit mode (Esc also exits)',
		action: () => {
			if (get(editingObject)) exitEditMode();
			else if (get(selectedObject)?.uuid) enterEditMode(get(selectedObject).uuid);
		}
	},
	{
		keys: 'O',
		group: 'Panels',
		label: 'Toggle object list',
		action: () => objectListClose.update((value) => !value)
	},
	{
		keys: 'N',
		group: 'Panels',
		label: 'Toggle node editor',
		action: () => flowGraphClose.update((value) => !value)
	},
	{
		keys: 'C',
		group: 'Panels',
		label: 'Toggle chat',
		action: () => chatHidden.update((value) => (value === 'hidden' ? '' : 'hidden'))
	},
	{
		keys: '`',
		group: 'Panels',
		label: 'Toggle AI prompt bar',
		action: () => toggleAiPrompt()
	},
	{
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
		keys: 'Ctrl+S',
		group: 'Scene',
		label: 'Save session',
		action: () =>
			import('./sessions').then(({ saveSession }) =>
				saveSession('Session ' + new Date().toLocaleString())
			)
	},
	{
		keys: 'Ctrl+Z',
		group: 'History',
		label: 'Undo',
		action: () => undo()
	},
	{
		keys: 'Ctrl+Y',
		group: 'History',
		label: 'Redo',
		action: () => redo()
	},
	{
		keys: 'Ctrl+Shift+Z',
		group: 'History',
		label: 'Redo (alternative)',
		action: () => redo()
	},
	...[1, 2, 3, 4, 5].map((slot) => ({
		keys: `Shift+${slot}`,
		group: 'Camera',
		label: `Recall camera bookmark ${slot}`,
		action: () => recallBookmark(slot - 1)
	})),
	{
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
		keys: 'V (hold)',
		group: 'Voice',
		label: 'Push to talk while the mic toggle is off'
		// handled by voiceChat.js (needs keyup); listed here for discoverability
	},
	{
		keys: 'E I G S B F X / W',
		group: 'Mesh edit',
		label: 'Mesh edit ops, only in Edit Mesh (toggle on the toolbar)'
		// handled by MeshEditPopup's local keydown; ONE bundled display row —
		// registerShortcut dedupes exact `keys`, so a bare 'F' row would collide
	},
	{
		keys: 'L / Ctrl+ +- / Ctrl+A / Ctrl+I',
		group: 'Mesh edit',
		label: 'M2/M3: loop select · loop cut (C) · grow/shrink · select all/invert (faces)'
		// same local handler, same bundling reason as the row above
	},
	{
		keys: 'Ctrl+/',
		group: 'Help',
		label: 'Show this shortcut list',
		action: () => {
			settingsSection.set('shortcuts');
			settingsOpen.set(true);
		}
	}
];

/** @param {Shortcut} shortcut */
export function registerShortcut(shortcut) {
	if (!shortcuts.some((s) => s.keys === shortcut.keys)) shortcuts.push(shortcut);
}

/** A2: drop every registered shortcut of one group (module-binding teardown
 * for the dev-mode reload — a re-register lists them fresh). @param {string} group */
export function unregisterShortcutGroup(group) {
	for (let i = shortcuts.length - 1; i >= 0; i--) {
		if (shortcuts[i].group === group) shortcuts.splice(i, 1);
	}
}

/** D3: the bare keys MeshEditPopup's local keydown consumes while a session is
 * active and its hotkeys pref is on (faces E/I/G/S/B/F/X, M2 loop select L ·
 * vertices W) */
const MESH_EDIT_KEYS = ['E', 'I', 'G', 'S', 'B', 'F', 'X', 'W', 'L', 'C', '1', '2', '3'];

/** @param {KeyboardEvent} event */
function comboOf(event) {
	// raw || '': synthetic events (Chrome password-manager autofill) have key undefined
	const raw = event.key || '';
	// digits by code so Shift+1 stays "Shift+1" instead of layout characters like "!"
	const key = event.code?.startsWith('Digit')
		? event.code.slice(5)
		: raw.length === 1
			? raw.toUpperCase()
			: raw;
	return (event.ctrlKey || event.metaKey ? 'Ctrl+' : '') + (event.shiftKey ? 'Shift+' : '') + key;
}

/** @param {KeyboardEvent} event */
function handleKeydown(event) {
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
	const shortcut = shortcuts.find((s) => s.keys === combo);
	if (!shortcut || !shortcut.action) return;
	// 15-B6: app modals are non-modal <dialog>s, so the page behind them is NOT
	// inert and these window handlers still fire — every modal now mutes them
	// (was Settings only, which is also why panel toggles couldn't fight the
	// hidePanels snapshot). Ctrl+/ (help) stays live.
	if (get(anyModalOpen) && shortcut.keys !== 'Ctrl+/') return;

	event.preventDefault();
	shortcut.action();
}

let started = false;

export function startShortcuts() {
	if (started || typeof window === 'undefined') return;
	started = true;
	window.addEventListener('keydown', handleKeydown);
}
