import { writable, get } from 'svelte/store';
import { tick } from 'svelte';
import { safeStorage } from './safeStorage';
import { migrateChatKeys } from './chat/chatKeys.js'; // uir-chat
import {
	pickLayoutStorage,
	layoutWrites,
	parseLayouts,
	upsertLayout,
	removeLayout,
	renameLayout,
	cleanName,
	runLayoutReloaders,
	MAX_LAYOUTS,
	LAYOUT_VERSION,
	pickChrome,
	chromeWrites
} from './uiLayoutsCore';
import { snapshotWorkspace, applyWorkspace, closeWorkspace } from './workspace';
import { chatTab, settingsOpen, floatingToolbar, toolbarAlwaysOnTop, hudStackLift, showRoomsButton, touchTools } from '../stores/appStore';
import { phoneShell } from './ui/phoneShell';
import { layoutPerScene, readSceneLayouts, writeSceneLayouts, upsertSceneLayout, sceneLayoutOf } from './windowPrefs.js';

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

/** 42 I8: which chrome profile this screen is — the folded phone shell is `phone`, everything
 *  else (desktop, the unfolded phone, a tablet) draws the desktop toolbar and is `desktop`
 *  @returns {import('./uiLayoutsCore').ChromeProfile} */
export function currentChromeProfile() {
	return get(phoneShell) ? 'phone' : 'desktop';
}

/** The live UI as a layout record (not stored). @param {string} name */
export function captureLayout(name) {
	const ws = snapshotWorkspace({ always: true });
	const profile = currentChromeProfile();
	return {
		v: LAYOUT_VERSION,
		id: newId(),
		name: cleanName(name),
		savedAt: Date.now(),
		viewport: typeof window !== 'undefined' ? { w: window.innerWidth, h: window.innerHeight } : null,
		// 78 PL3: the HUD editor, Timeline, Profiler and Chat are in the workspace table now (with Statistics,
		// Free assets and the AI assistant), so one record says what is open
		open: { ...ws.open },
		dockTab: ws.dockTab,
		inspector: ws.inspector,
		storage: pickLayoutStorage(safeStorage.keys(), (key) => safeStorage.getItem(key)),
		// 42 I8: the toolbar + corners + top-right group + touch tools (desktop), or the phone bar —
		// ONLY the profile of the shell you are in; a save of the same name from the other shell
		// keeps this one (upsertLayout merges the two)
		chrome: { [profile]: pickChrome(profile, (key) => safeStorage.getItem(key)) }
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

let applying = false;

/**
 * Put a saved layout back. Resolves false for an unknown id (or one already applying).
 * @param {string} id
 */
export async function applyLayout(id) {
	const layout = get(uiLayouts).find((l) => l.id === id);
	if (!layout) return false;
	return applyLayoutRecord(layout, id);
}

/**
 * Put a layout RECORD back (a saved one, or a scene's remembered one). `activeId` marks a saved layout as the
 * active one; a remembered scene layout passes null and leaves the Layouts menu's mark alone.
 * @param {any} layout @param {string | null} [activeId]
 */
export async function applyLayoutRecord(layout, activeId = null) {
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
		await tick();

		const { set, remove } = layoutWrites(layout.storage, safeStorage.keys());
		for (const key of remove) safeStorage.removeItem(key);
		for (const [key, value] of set) safeStorage.setItem(key, value);
		// 42 I8: every chrome profile the record carries (both, so an unfolded apply brings the
		// folded bar back too); a v1 record carries none and leaves the chrome alone
		for (const profile of /** @type {const} */ (['desktop', 'phone'])) {
			const chrome = layout.chrome?.[profile];
			if (!chrome) continue;
			const writes = chromeWrites(profile, chrome);
			for (const key of writes.remove) safeStorage.removeItem(key);
			for (const [key, value] of writes.set) safeStorage.setItem(key, value);
			if (profile === 'desktop') reloadDesktopChromePrefs();
		}
		// uir-chat: the tab the layout's Chat window showed; a layout saved before Chat and the AI assistant
		// became one window names the assistant's own window ('aiAssistant') — read it as the one window,
		// on its Assistant tab
		const savedTab = safeStorage.getItem('chat:tab');
		if (savedTab === 'session' || savedTab === 'assistant') chatTab.set(savedTab);
		if (migrateChatKeys((k) => safeStorage.getItem(k), (k, v) => safeStorage.setItem(k, v), (k) => safeStorage.removeItem(k)).assistant) chatTab.set('assistant');
		runLayoutReloaders();
		await tick();

		applyWorkspace({ open: layout.open, dockTab: layout.dockTab, inspector: layout.inspector });
		await tick();
		if (activeId) setActive(activeId);
		return true;
	} finally {
		applying = false;
	}
}

/**
 * showhide-v8 §6: Windows ▸ "Remember layout per scene". While the switch is on, leaving a NAMED scene stores the
 * window layout it was left with, and opening a scene that has one puts it back. Unnamed scenes are not remembered
 * (there is no name to file them under). The store is passed in, so this module never imports the level machinery.
 * @param {import('svelte/store').Readable<{name?: string} | null>} levelStore @returns {() => void}
 */
export function startSceneLayouts(levelStore) {
	/** @type {string | null} */
	let current = null;
	const remember = () => {
		if (current && get(layoutPerScene)) writeSceneLayouts(upsertSceneLayout(readSceneLayouts(), current, captureLayout(current)));
	};
	const unsub = levelStore.subscribe((level) => {
		const name = level?.name || null;
		if (name === current) return;
		remember();
		current = name;
		if (!name || !get(layoutPerScene)) return;
		const stored = sceneLayoutOf(readSceneLayouts(), name);
		if (stored) void applyLayoutRecord(stored);
	});
	// a reload or a closed tab keeps what the scene was left with too
	const onHide = () => remember();
	if (typeof window !== 'undefined') window.addEventListener('pagehide', onHide);
	return () => {
		unsub();
		if (typeof window !== 'undefined') window.removeEventListener('pagehide', onHide);
	};
}

/** 42 I8: the toolbar prefs that live in appStore stores, re-read from the keys a layout just
 *  wrote (each store's own reading rule — absent = its default). The record itself
 *  (`controlsLayout`) and the phone bar re-read through `onLayoutRestore`, from their owners. */
function reloadDesktopChromePrefs() {
	floatingToolbar.set(safeStorage.getItem('floatingToolbar') !== 'false');
	toolbarAlwaysOnTop.set(safeStorage.getItem('toolbarOnTop') === 'true');
	hudStackLift.set(safeStorage.getItem('hudStackLift') === 'true');
	showRoomsButton.set(safeStorage.getItem('showRoomsButton') !== 'false');
	// 43 J12: absent (a layout saved before it was carried) leaves the device's own choice alone
	const tt = safeStorage.getItem('touchTools');
	if (tt !== null) touchTools.set(tt === 'true');
}

/** the burger menu's Layouts popover */
export const layoutsMenuOpen = writable(false);
