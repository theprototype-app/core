// 38 R8 (NOTES-38 #14) — WHAT THE COMMAND PALETTE OFFERS. One list, built fresh each time the
// palette opens, from things that already exist — nothing here invents a command:
//   tools + shortcuts  every registry row with an action (shortcuts.js), run exactly as its key
//                      would (its `when` decides whether it is offered now)
//   windows            every panel togglePanel knows + chat, the AI assistant, notes, notifications
//   menu               the logo menu's modals (Settings, Modules, Sessions, Templates, Checkpoints…)
//   settings           every Settings row (settingsIndex.js); a pick opens Settings with the row's
//                      name in Settings' own search, which then decides what shows
// The ranking is commandRank.js (a pure leaf). The palette itself is CommandPalette.svelte; the
// Ctrl+K row lives in the registry (help.palette) and only sets `commandPaletteOpen`, so this
// module is never imported by shortcuts.js (no cycle).
import { get } from 'svelte/store';
import {
	settingsOpen,
	settingsSection,
	settingsSearchSeed,
	modulesOpen,
	sessionsOpen,
	checkpointsOpen,
	checkpointSaveOpen,
	templatesModalOpen,
	characterModalOpen,
	chatHidden,
	aiAssistantHidden,
	notesDrawerOpen,
	notificationCenterOpen
} from '../stores/appStore';
import { shortcuts } from './shortcuts';
import { togglePanel, TOGGLEABLE } from './panelToggles';
import { DOCK_TITLES } from './bottomDock';
import { publishExportOpen } from './export/exportStores';
import { SETTINGS_ROWS, SETTINGS_SECTION_IDS } from './settingsIndex';

/** @typedef {import('./commandRank').Command} Command */

/** @param {import('svelte/store').Writable<string>} store */
const flipHidden = (store) => store.set(get(store) === 'hidden' ? '' : 'hidden');

/** @returns {Command[]} */
function toolCommands() {
	return shortcuts
		.filter((s) => s.id !== 'help.palette' && !s.external && !s.fixed && typeof s.action === 'function' && (!s.when || s.when()))
		.map((s) => ({
			id: 'shortcut:' + s.id,
			kind: 'tool',
			label: s.label,
			detail: s.group,
			keys: s.keys,
			run: () => s.action?.()
		}));
}

/** @returns {Command[]} */
function windowCommands() {
	/** @type {Record<string, string>} */
	const titles = { ...DOCK_TITLES, objects: 'Object list' };
	/** @type {Command[]} */
	const list = TOGGLEABLE.map((key) => ({
		id: 'window:' + key,
		kind: 'window',
		label: titles[key] ?? key,
		detail: 'Window — show or hide',
		run: () => togglePanel(key)
	}));
	list.push(
		{ id: 'window:chat', kind: 'window', label: 'Chat', detail: 'Window — show or hide', run: () => flipHidden(chatHidden) },
		{ id: 'window:ai', kind: 'window', label: 'AI assistant', detail: 'Window — show or hide', words: 'chat llm', run: () => flipHidden(aiAssistantHidden) },
		{ id: 'window:notes', kind: 'window', label: 'Scene notes', detail: 'Window — show or hide', words: 'annotations', run: () => notesDrawerOpen.update((v) => !v) },
		{ id: 'window:notifications', kind: 'window', label: 'Notifications', detail: 'Window — show or hide', words: 'history bell', run: () => notificationCenterOpen.update((v) => !v) }
	);
	return list;
}

/** @returns {Command[]} */
function menuCommands() {
	/** @param {string} id @param {string} label @param {() => void} run @param {string} [words] @returns {Command} */
	const m = (id, label, run, words) => ({ id: 'menu:' + id, kind: 'menu', label, detail: 'Menu', words, run });
	return [
		m('settings', 'Settings', () => settingsOpen.set(true), 'preferences options'),
		m('modules', 'Modules', () => modulesOpen.set(true), 'plugins install'),
		m('sessions', 'Sessions', () => sessionsOpen.set(true), 'projects saved open load'),
		m('templates', 'Templates', () => templatesModalOpen.set(true), 'new scene games levels'),
		m('checkpoints', 'Checkpoints', () => checkpointsOpen.set(true), 'history versions'),
		m('checkpoint-save', 'Save checkpoint…', () => checkpointSaveOpen.set(true), 'snapshot'),
		m('character', 'Customize character', () => characterModalOpen.set(true), 'avatar head hat'),
		m('publish', 'Publish / export…', () => publishExportOpen.set(true), 'itch html share')
	];
}

/** @returns {Command[]} */
function settingsCommands() {
	return SETTINGS_ROWS.map(([section, name, desc]) => ({
		id: 'setting:' + section + ':' + name,
		kind: 'setting',
		label: name,
		detail: 'Settings ▸ ' + section,
		words: desc,
		run: () => {
			settingsSection.set(/** @type {any} */ (SETTINGS_SECTION_IDS)[section] ?? null);
			settingsSearchSeed.set(name);
			settingsOpen.set(true);
		}
	}));
}

/** Every command, in the order a fresh (empty-query) palette lists them. @returns {Command[]} */
export function buildCommands() {
	return [...toolCommands(), ...windowCommands(), ...menuCommands(), ...settingsCommands()];
}
