import { get } from 'svelte/store';
import { TControls, isLocked } from '../stores/sceneStore';
import {
	flowGraphClose,
	objectListClose,
	chatHidden,
	settingsOpen,
	settingsSection
} from '../stores/appStore';
import { focusObject, duplicateObject } from './objectActions';
import { undo, redo } from './history';
import { editingObject, enterEditMode, exitEditMode } from './meshEdit';
import { recallBookmark } from './cameraBookmarks';
import { selectedObject } from '../stores/sceneStore';

// Single source of truth for keyboard shortcuts: the same registry binds the keys
// and renders the list in Settings -> Shortcuts. Other modules push entries via
// registerShortcut() so their keys show up in the list automatically.

/** @typedef {{ keys: string, group: string, label: string, action?: () => void }} Shortcut */

/** @type {Shortcut[]} */
export const shortcuts = [
	// transform hotkeys live on 1/2/3 — W/E/R belong to fly navigation now
	{
		keys: '1',
		group: 'Transform',
		label: 'Move (translate)',
		action: () => get(TControls)?.setMode('translate')
	},
	{
		keys: '2',
		group: 'Transform',
		label: 'Rotate',
		action: () => get(TControls)?.setMode('rotate')
	},
	{
		keys: '3',
		group: 'Transform',
		label: 'Scale',
		action: () => get(TControls)?.setMode('scale')
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
		label: 'Duplicate selected object',
		action: () => duplicateObject()
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
		keys: 'V (hold)',
		group: 'Voice',
		label: 'Push to talk while the mic toggle is off'
		// handled by voiceChat.js (needs keyup); listed here for discoverability
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

/** @param {KeyboardEvent} event */
function comboOf(event) {
	// digits by code so Shift+1 stays "Shift+1" instead of layout characters like "!"
	const key = event.code?.startsWith('Digit')
		? event.code.slice(5)
		: event.key.length === 1
			? event.key.toUpperCase()
			: event.key;
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
	const shortcut = shortcuts.find((s) => s.keys === combo);
	if (!shortcut || !shortcut.action) return;
	// while the settings modal is open only the help shortcut stays active,
	// so panel toggles can't fight the hidePanels snapshot
	if (get(settingsOpen) && shortcut.keys !== 'Ctrl+/') return;

	event.preventDefault();
	shortcut.action();
}

let started = false;

export function startShortcuts() {
	if (started || typeof window === 'undefined') return;
	started = true;
	window.addEventListener('keydown', handleKeydown);
}
