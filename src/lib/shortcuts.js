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

// Single source of truth for keyboard shortcuts: the same registry binds the keys
// and renders the list in Settings -> Shortcuts. Other modules push entries via
// registerShortcut() so their keys show up in the list automatically.

/** @typedef {{ keys: string, group: string, label: string, action?: () => void }} Shortcut */

/** @type {Shortcut[]} */
export const shortcuts = [
	{
		keys: 'W',
		group: 'Transform',
		label: 'Move (translate)',
		action: () => get(TControls)?.setMode('translate')
	},
	{
		keys: 'E',
		group: 'Transform',
		label: 'Rotate',
		action: () => get(TControls)?.setMode('rotate')
	},
	{
		keys: 'R',
		group: 'Transform',
		label: 'Scale',
		action: () => get(TControls)?.setMode('scale')
	},
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
	const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
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
