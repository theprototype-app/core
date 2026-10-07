import { writable, get } from 'svelte/store';
import { tick } from 'svelte';
import { safeStorage } from './safeStorage';
import {
	pickLayoutStorage,
	layoutWrites,
	parseLayouts,
	upsertLayout,
	removeLayout,
	renameLayout,
	cleanName,
	runLayoutReloaders,
	MAX_LAYOUTS
} from './uiLayoutsCore';
import { snapshotWorkspace, applyWorkspace, closeWorkspace } from './workspace';
import { hudEditorClose, profilerClose, chatHidden, settingsOpen } from '../stores/appStore';

// 37 R14 — NAMED WORKSPACE LAYOUTS, the live half (the rules are in uiLayoutsCore).
//
// A layout = which panels are open + the stored geometry of every window (dock sides and
// widths, the bottom dock's height and tab order, each panel's docked-or-floating mode and
// floating size, tab groups, the object list's rect). LOCAL to this browser — a fact about
// this screen, like the dock order — so nothing here replicates, saves into a scene or
// undoes. The workspace rule stands: a reload is still a clean slate; a layout comes back
// only when you pick it.
//
// APPLYING IS FOUR STEPS, and the order is the design:
//   1. close every panel, so each floating window UNMOUNTS (it re-reads its rect on mount);
//   2. write the layout's keys into storage and drop the layout keys it does not name
//      (their owners fall back to defaults — what "Reset window layout" relies on too);
//   3. tell the owners that stay mounted to re-read (`onLayoutRestore`): docking, the
//      bottom dock, the tab groups, every dock-family panel's mode + size, the object list
//      and any class-hidden dragWindow;
//   4. reopen what the layout had open, with its dock tab in front.
// No page reload — that would drop the peer session.

const STORE_KEY = 'uiLayouts';
const ACTIVE_KEY = 'uiLayouts:active';

/** the saved layouts, oldest first @type {import('svelte/store').Writable<any[]>} */
export const uiLayouts = writable(parseLayouts(safeStorage.getItem(STORE_KEY)));
/** the id of the layout applied (or saved) last — the list marks it @type {import('svelte/store').Writable<string|null>} */
export const activeLayoutId = writable(safeStorage.getItem(ACTIVE_KEY));

/** @param {any[]} list */
function persist(list) {
	uiLayouts.set(list);
	safeStorage.setItem(STORE_KEY, JSON.stringify(list));
}
/** @param {string|null} id */
function setActive(id) {
	activeLayoutId.set(id);
	if (id) safeStorage.setItem(ACTIVE_KEY, id);
	else safeStorage.removeItem(ACTIVE_KEY);
}

function newId() {
	try {
		return 'lay-' + crypto.randomUUID().slice(0, 8);
	} catch {
		return 'lay-' + Math.random().toString(36).slice(2, 10);
	}
}

/** The live UI as a layout record (not stored). @param {string} name */
export function captureLayout(name) {
	const ws = snapshotWorkspace({ always: true });
	return {
		v: 1,
		id: newId(),
		name: cleanName(name),
		savedAt: Date.now(),
		viewport: typeof window !== 'undefined' ? { w: window.innerWidth, h: window.innerHeight } : null,
		open: {
			...ws.open,
			hud: !get(hudEditorClose),
			profiler: !get(profilerClose),
			chat: get(chatHidden) === ''
		},
		dockTab: ws.dockTab,
		inspector: ws.inspector,
		storage: pickLayoutStorage(safeStorage.keys(), (key) => safeStorage.getItem(key))
	};
}

/**
 * Save the live UI under a name. The same name (any case) overwrites that layout in place.
 * @param {string} name
 * @returns {{ok: true, layout: any, updated: boolean} | {ok: false, reason: string}}
 */
export function saveLayout(name) {
	const clean = cleanName(name);
	if (!clean) return { ok: false, reason: 'Give the layout a name' };
	const list = get(uiLayouts);
	const updated = list.some((l) => l.name.toLowerCase() === clean.toLowerCase());
	const next = upsertLayout(list, captureLayout(clean));
	if (!next) return { ok: false, reason: `You can keep up to ${MAX_LAYOUTS} layouts — delete one first` };
	persist(next);
	const layout = next.find((l) => l.name.toLowerCase() === clean.toLowerCase());
	setActive(layout.id);
	return { ok: true, layout, updated };
}

/** @param {string} id */
export function deleteLayout(id) {
	persist(removeLayout(get(uiLayouts), id));
	if (get(activeLayoutId) === id) setActive(null);
}

/** @param {string} id @param {string} name @returns {boolean} */
export function renameLayoutTo(id, name) {
	const next = renameLayout(get(uiLayouts), id, name);
	if (!next) return false;
	persist(next);
	return true;
}

/** the panels a layout opens beyond the workspace record's own table */
const EXTRA = [
	{ name: 'hud', open: () => hudEditorClose.set(false), close: () => hudEditorClose.set(true) },
	{ name: 'profiler', open: () => profilerClose.set(false), close: () => profilerClose.set(true) },
	{ name: 'chat', open: () => chatHidden.set(''), close: () => chatHidden.set('hidden') }
];

let applying = false;

/**
 * Put a saved layout back. Resolves false for an unknown id (or one already applying).
 * @param {string} id
 */
export async function applyLayout(id) {
	const layout = get(uiLayouts).find((l) => l.id === id);
	if (!layout || applying) return false;
	applying = true;
	try {
		// Settings snapshots the panels when it opens and RESTORES them when it closes, which
		// would undo the layout the moment the dialog went away — close it first.
		if (get(settingsOpen)) {
			settingsOpen.set(false);
			await tick();
		}
		closeWorkspace();
		for (const extra of EXTRA) extra.close();
		await tick();

		const { set, remove } = layoutWrites(layout.storage, safeStorage.keys());
		for (const key of remove) safeStorage.removeItem(key);
		for (const [key, value] of set) safeStorage.setItem(key, value);
		runLayoutReloaders();
		await tick();

		applyWorkspace({ open: layout.open, dockTab: layout.dockTab, inspector: layout.inspector });
		for (const extra of EXTRA) if (layout.open?.[extra.name] === true) extra.open();
		await tick();
		setActive(id);
		return true;
	} finally {
		applying = false;
	}
}

/** the burger menu's Layouts popover */
export const layoutsMenuOpen = writable(false);
