// 70 W2-W5 — THE POP-OUT WINDOW HOST. Generalises 1.42's code window ($lib/codePopout, now one
// client of this): any registered panel ($lib/windows/panelRegistry), or a whole dock, in its own
// SAME-ORIGIN `about:blank` popup. The popup shares this JS realm — every store, the Yjs document,
// the flow runtime and the save path are the main window's own objects — but not its globals
// (see $lib/windows/winEnv). One svelte root per popup: PanelWindow.svelte, mounted on the popup's
// <body> (svelte delegates events to the mount target), renders the window's header / tab strip
// and one PoppedPanel per tab, each mounting the panel's component with `popped: true`.
//
// The live layout is $lib/windows/panelPlaces' store; this module opens and closes real windows
// to match it:
//   - a window is OPENED only from a user gesture (`popOut` / `popOutDock` / a restore click):
//     `window.open` runs before any await, while the click's activation still holds;
//   - a window whose id leaves the layout (its last tab moved away, Dock back, Bring all back) is
//     CLOSED here;
//   - a popup closed by its own ✕ / the OS (pagehide, or the 800 ms `closed` poll) docks every
//     panel it held back into the main window;
//   - closing / reloading the MAIN tab closes every popup (the realm they run on is going away),
//     WITHOUT forgetting the layout — W5 restores it on the next visit.
//
// Three things a popup does not inherit and this module therefore owns: the STYLES (every
// <style>/<link rel=stylesheet> of the main <head>, kept in step), the THEME (the <html>/<body>
// attributes the tokens hang off) and EVENT DELEGATION (the mount target is the popup's body).
//
// W5: the layout is remembered per screen setup (`setupKey`) under `windows:layouts`, and
// `startPanelHost` brings it back on boot: windows open by themselves where the site may open
// pop-ups, else RestoreWindowsBar offers them one click per window.
import { get, writable } from 'svelte/store';
import { safeStorage } from '../safeStorage';
import { showToast } from '../../stores/appStore';
import { popOutSupported } from './popOutSupport.js';
import { trackFocus, lastFocusedWindow, mainWin } from './winEnv.js';
import { panelLayout, registerPanelHost, alwaysShowTabStrip } from './panelPlaces.js';
import { PANELS, isPoppable, panelTitle, panelTitles } from './panelRegistry.js';
import * as model from './panelLayout.js';

/** @typedef {import('./panelLayout.js').Layout} Layout */
/** @typedef {import('./panelLayout.js').LayoutWindow} LayoutWindow */
/** @typedef {import('./panelLayout.js').WinRect} WinRect */

const LAYOUTS_KEY = 'windows:layouts';
/** the Code window keeps 1.42's name, rect record and title (tests and muscle memory know them) */
const CODE_NAME = 'tp-code-popout';
const CODE_RECT = 'code:popoutRect';
const APP = 'ThePrototype';

/**
 * One open popup.
 * @typedef {{id: string, w: Window, instance: any, teardown: (() => void)[], gone: boolean, seen: boolean}} Popup
 */
/** @type {Map<string, Popup>} */
const popups = new Map();
let unloading = false;
let seq = 0;

/** @param {string} key */
const rectKeyOf = (key) => (key === 'code' ? CODE_RECT : 'win:pop:' + key);
/** where a window remembers its rect: its first panel's record, a dock window its dock's @param {LayoutWindow} lw */
const rectKeyFor = (lw) => (lw.kind === 'dock' ? 'win:pop:dock:' + (lw.origin ?? 'bottom') : rectKeyOf(lw.panels[0]));

/** @param {string} key @returns {WinRect|{width: number, height: number}} */
function storedRect(key) {
	try {
		const r = JSON.parse(safeStorage.getItem(key) ?? 'null');
		if (r && r.width > 200 && r.height > 150) return r;
	} catch {
		/* a bad record reads as none */
	}
	return key === CODE_RECT ? { width: 900, height: 640 } : { width: 820, height: 600 };
}

/** @param {Window} w @returns {WinRect|null} */
function rectOf(w) {
	try {
		return { left: w.screenX, top: w.screenY, width: w.outerWidth, height: w.outerHeight };
	} catch {
		return null; // a closed window can refuse the read
	}
}

/** mirror the main <head>'s stylesheets into `doc`, live @param {Document} doc */
export function mirrorStyles(doc) {
	/** source node -> its clone in the popup @type {Map<Element, HTMLElement>} */
	const clones = new Map();
	const sync = () => {
		const sources = [...document.head.querySelectorAll('style, link[rel="stylesheet"]')];
		const live = new Set(sources);
		for (const [src, clone] of clones) {
			if (live.has(src)) continue;
			clone.remove();
			clones.delete(src);
		}
		for (const src of sources) {
			const held = clones.get(src);
			if (!held) {
				const clone = /** @type {HTMLElement} */ (doc.importNode(src, true));
				clone.setAttribute('data-tp-mirror', '');
				doc.head.appendChild(clone);
				clones.set(src, clone);
			} else if (src.nodeName === 'STYLE' && held.textContent !== src.textContent) held.textContent = src.textContent;
			else if (src.nodeName === 'LINK' && held.getAttribute('href') !== src.getAttribute('href')) held.setAttribute('href', src.getAttribute('href') ?? '');
		}
	};
	sync();
	const mo = new MutationObserver(sync);
	mo.observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['href', 'media', 'disabled'] });
	return () => mo.disconnect();
}

/** keep `to`'s attributes equal to `from`'s (the theme + UI-scale hooks) @param {Element} from @param {Element} to */
export function mirrorAttributes(from, to) {
	const sync = () => {
		for (const a of [...to.attributes]) if (!from.hasAttribute(a.name)) to.removeAttribute(a.name);
		for (const a of [...from.attributes]) if (to.getAttribute(a.name) !== a.value) to.setAttribute(a.name, a.value);
	};
	sync();
	const mo = new MutationObserver(sync);
	mo.observe(from, { attributes: true });
	return () => mo.disconnect();
}

/** a window's title bar text @param {LayoutWindow|null|undefined} lw */
function docTitle(lw) {
	return `${model.windowTitle(lw, panelTitle) || 'Window'} — ${APP}`;
}

/** an unused window name (a name that is still open would be REUSED — and wiped — by window.open) @param {LayoutWindow} lw */
function nameFor(lw) {
	const live = new Set([...popups.values()].map((p) => (p.gone ? '' : safeName(p.w))));
	if (lw.kind === 'panel' && lw.panels.length === 1 && lw.panels[0] === 'code' && !live.has(CODE_NAME)) return CODE_NAME;
	return `tp-window-${Date.now().toString(36)}-${++seq}`;
}
/** @param {Window} w */
function safeName(w) {
	try {
		return w.name;
	} catch {
		return '';
	}
}

/**
 * Open the real window for `lw` — SYNCHRONOUSLY up to `window.open`, so it must be reached from
 * a user gesture. Mounting the window's content follows asynchronously.
 * @param {LayoutWindow} lw @param {{via?: Window|null}=} opts
 * @returns {boolean} false when the browser blocked it
 */
function openPopup(lw, opts = {}) {
	const r = /** @type {any} */ (lw.rect ?? storedRect(rectKeyFor(lw)));
	const place = 'left' in r && r.left != null && r.top != null ? `,left=${Math.round(r.left)},top=${Math.round(r.top)}` : '';
	// a drag that started in a popup carries that popup's activation, not the main window's
	const opener = opts.via && !opts.via.closed ? opts.via : window;
	/** @type {Window|null} */
	let w = null;
	try {
		w = opener.open('', nameFor(lw), `popup,width=${Math.round(r.width)},height=${Math.round(r.height)}${place}`);
	} catch {
		w = null;
	}
	if (!w) return false;
	// a fresh STANDARDS-mode document (the initial about:blank has no doctype = quirks mode),
	// which also wipes whatever an earlier session of a named window held
	const doc = w.document;
	doc.open();
	doc.write(`<!doctype html><html><head><meta charset="utf-8"><title></title><style>html,body{margin:0;height:100%;overflow:hidden}</style></head><body></body></html>`);
	doc.close();
	doc.title = docTitle(lw);
	/** @type {Popup} */
	const pop = { id: lw.id, w, instance: null, teardown: [], gone: false, seen: false };
	popups.set(lw.id, pop);
	pop.teardown.push(mirrorStyles(doc), mirrorAttributes(document.documentElement, doc.documentElement), mirrorAttributes(document.body, doc.body));
	pop.teardown.push(trackFocus(w));
	// the popup closing (its ✕, the OS) docks its panels back
	const onGone = () => popupGone(pop);
	w.addEventListener('pagehide', onGone);
	// belt and braces: some window managers close a popup without a pagehide; the same tick keeps
	// the window's on-screen rect for the layout (W5)
	const poll = setInterval(() => {
		if (w.closed) popupGone(pop);
		else noteRect(pop);
	}, 800);
	pop.teardown.push(() => clearInterval(poll));
	pop.teardown.push(forwardUndo(w));
	void mountContent(pop, doc);
	return true;
}

/** @param {Popup} pop @param {Document} doc */
async function mountContent(pop, doc) {
	try {
		const [{ mount, unmount }, { default: PanelWindow }] = await Promise.all([import('svelte'), import('../../components/windows/PanelWindow.svelte')]);
		if (pop.gone) return;
		pop.instance = mount(PanelWindow, { target: doc.body, props: { winId: pop.id, api: windowApi } });
		pop.teardown.push(() => {
			try {
				unmount(pop.instance);
			} catch {
				/* the document may already be gone */
			}
			pop.instance = null;
		});
		pop.w.focus();
	} catch (err) {
		console.warn('[panelHost] could not fill the window', err);
		showToast('Could not open the window — the panel stays here.');
		closeWindowById(pop.id);
	}
}

/**
 * W2 — undo / redo pressed in a popped panel reach the main window's shortcut handler (the popup
 * has its own `window`, so the app-wide keys never hear it). Only those two, and only when nothing
 * in the popup handled the key and the focus is not in a text field (the field's own undo wins).
 * @param {Window} w
 */
function forwardUndo(w) {
	/** @param {KeyboardEvent} e */
	const on = (e) => {
		if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey) return;
		const k = e.key.toLowerCase();
		if (k !== 'z' && k !== 'y') return;
		const t = /** @type {any} */ (e.target);
		if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName ?? ''))) return;
		e.preventDefault();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, bubbles: true, cancelable: true }));
	};
	w.addEventListener('keydown', on);
	return () => w.removeEventListener('keydown', on);
}

/** remember where a popup sits on screen (W5) @param {Popup} pop */
function noteRect(pop) {
	const r = rectOf(pop.w);
	if (!r || r.width < 200 || r.height < 150) return;
	const lw = model.windowById(get(panelLayout), pop.id);
	if (!lw) return;
	const old = lw.rect;
	if (old && old.left === r.left && old.top === r.top && old.width === r.width && old.height === r.height) return;
	panelLayout.update((l) => model.setRect(l, pop.id, r));
}

/** tear one popup down (its content unmounted, its watchers gone) — the window itself stays as it is @param {Popup} pop */
function teardownPopup(pop) {
	if (pop.gone) return;
	pop.gone = true;
	const lw = model.windowById(get(panelLayout), pop.id);
	const r = rectOf(pop.w);
	if (lw && r && r.width > 200 && r.height > 150) safeStorage.setItem(rectKeyFor(lw), JSON.stringify(r));
	const steps = pop.teardown;
	pop.teardown = [];
	for (const fn of steps.reverse()) fn();
	popups.delete(pop.id);
}

/** the popup went away by itself (its ✕, the OS, a reload of the popup) @param {Popup} pop */
function popupGone(pop) {
	if (pop.gone) return;
	teardownPopup(pop);
	try {
		if (!pop.w.closed) pop.w.close(); // a reloaded popup is an empty about:blank now
	} catch {
		/* already closed */
	}
	const lw = model.windowById(get(panelLayout), pop.id);
	if (!lw) return;
	// its panels come home (the main tab unloading keeps the layout for the next visit: W5)
	panelLayout.update((l) => model.closeWindow(l, pop.id).layout);
	if (!unloading) cameBack(lw.panels);
}

/** close the real window `id` (its panels have already left the layout, or are leaving) @param {string} id */
function closeWindowById(id) {
	const pop = popups.get(id);
	if (!pop) return;
	teardownPopup(pop);
	try {
		pop.w.close();
	} catch {
		/* already closed */
	}
}

/** after panels return to the main window: show the first one where it lands @param {string[]} keys */
function cameBack(keys) {
	if (!keys.length) return;
	const first = keys[0];
	// the main instance remounts on the next flush; then its dock tab / window is brought forward
	setTimeout(() => {
		import('../dockMenu').then((m) => m.focusWindow(first)).catch(() => {});
	}, 60);
}

/** follow the layout: a window that left it closes; titles follow the front tab @param {Layout} l */
function syncWindows(l) {
	for (const [id, pop] of [...popups]) {
		const lw = model.windowById(l, id);
		// a window just opened is in the layout a moment AFTER window.open (a store write in between
		// must not close it): only a window the layout has held can leave it
		if (!lw) {
			if (pop.seen) closeWindowById(id);
		} else {
			pop.seen = true;
			try {
				pop.w.document.title = docTitle(lw);
			} catch {
				/* closing */
			}
		}
	}
}

/** @param {string} what the window's name, for the notice */
function blocked(what) {
	showToast(`Your browser blocked the ${what} window. Allow pop-ups for this site, or try again.`, [
		{
			label: 'Try again',
			action: () => {
				const p = pendingRetry;
				pendingRetry = null;
				p?.();
			}
		}
	]);
}
/** what "Try again" re-runs (a toast action is a user gesture, so it may open a window) @type {(() => void)|null} */
let pendingRetry = null;

/** the panel opens (anywhere) — a popped panel is always an OPEN panel @param {string} key */
function ensureOpen(key) {
	const e = PANELS[key];
	if (e && !get(e.isOpen)) e.open();
}

/** @param {string} key */
function canPop(key) {
	return isPoppable(key) && get(popOutSupported);
}

/**
 * W2 — pop `key` out into a NEW window of its own (from the main window, or from another pop-out
 * — it moves). Alone in a window already: that window comes to the front. MUST run in a gesture.
 * @param {string} key @param {{via?: Window|null, rect?: WinRect|null}=} opts
 */
function popOut(key, opts = {}) {
	if (!canPop(key)) return false;
	const l = get(panelLayout);
	const home = model.windowOf(l, key);
	if (home && home.kind === 'panel' && home.panels.length === 1 && popups.has(home.id)) {
		popups.get(home.id)?.w.focus();
		return true;
	}
	const id = 'w' + l.next;
	// a tear-off names only the place; the size is the panel's remembered one
	const rect = opts.rect ? { ...storedRect(rectKeyOf(key)), ...opts.rect } : null;
	const next = model.popOut(l, key, { id, rect: /** @type {any} */ (rect) });
	const lw = model.windowById(next.layout, id);
	if (!lw || !openPopup(lw, opts)) {
		pendingRetry = () => void popOut(key, { rect: opts.rect });
		blocked(panelTitle(key));
		return false;
	}
	ensureOpen(key);
	panelLayout.set(next.layout);
	return true;
}

/**
 * W3 — pop a whole dock out as ONE tabbed window (a dock window always shows its tabs).
 * @param {string[]} keys @param {'bottom'|'left'|'right'} origin @param {string|null=} active
 */
function popOutDock(keys, origin, active) {
	const list = keys.filter((k) => canPop(k));
	if (!list.length) return false;
	const l = get(panelLayout);
	const id = 'w' + l.next;
	const next = model.popOutDock(l, list, { id, origin, active: active ?? null });
	const lw = model.windowById(next.layout, id);
	if (!lw || !openPopup(lw)) {
		pendingRetry = () => void popOutDock(list, origin, active);
		blocked('dock');
		return false;
	}
	for (const k of list) ensureOpen(k);
	panelLayout.set(next.layout);
	return true;
}

/** W4 — add `key` as a tab of the open window `winId` (it moves there: one place) @param {string} key @param {string} winId @param {number=} index */
function moveTo(key, winId, index) {
	if (!canPop(key) || !popups.has(winId)) return;
	ensureOpen(key);
	panelLayout.update((l) => model.addTab(l, winId, key, index));
	popups.get(winId)?.w.focus();
}

/** "Dock back": `key` returns to the main window, where it was @param {string} key */
function dockBack(key) {
	if (!model.windowOf(get(panelLayout), key)) return;
	panelLayout.update((l) => model.removeTab(l, key));
	cameBack([key]);
}

/** every panel of window `winId` returns to the main window @param {string} winId */
function dockWindowBack(winId) {
	const { layout, keys } = model.closeWindow(get(panelLayout), winId);
	if (!keys.length) return;
	panelLayout.set(layout);
	cameBack(keys);
}

/** W5 — "Bring all windows back" */
function bringAllBack() {
	const keys = model.poppedKeys(get(panelLayout));
	restoreQueue.set(null);
	if (!keys.length) return;
	panelLayout.set(model.emptyLayout());
	cameBack(keys);
}

/** raise the window `key` lives in @param {string} key */
function focus(key) {
	const lw = model.windowOf(get(panelLayout), key);
	const pop = lw && popups.get(lw.id);
	if (!pop) return false;
	panelLayout.update((l) => model.activate(l, key));
	pop.w.focus();
	return true;
}

/** the open windows, for "Move to window ▸" rows */
function windows() {
	return get(panelLayout).windows.filter((w) => popups.has(w.id)).map((w) => ({ id: w.id, title: model.windowTitle(w, panelTitle) + (w.panels.length > 1 ? ` (+${w.panels.length - 1})` : '') }));
}

/** the main window's menus ask through panelPlaces */
registerPanelHost({ popOut, popOutDock, moveTo, dockBack, bringAllBack, focus, canPop, titleOf: panelTitle, windows });

/**
 * What a PanelWindow (inside a popup) can ask of the host. Passed as a prop: the component lives
 * in the same realm and could import this module, but a prop keeps the dependency one-way.
 */
export const windowApi = {
	layout: panelLayout,
	alwaysStrip: alwaysShowTabStrip,
	titleOf: panelTitle,
	iconOf: (/** @type {string} */ key) => PANELS[key]?.icon ?? 'app-window',
	entryOf: (/** @type {string} */ key) => PANELS[key] ?? null,
	popOut,
	moveTo,
	dockBack,
	dockWindowBack,
	windows,
	activate: (/** @type {string} */ key) => panelLayout.update((l) => model.activate(l, key)),
	/** the panel's component closed it while popped: it leaves the window, closed @param {string} key */
	closed: (/** @type {string} */ key) => panelLayout.update((l) => model.removeTab(l, key)),
	/** every poppable panel not already in window `winId` (the header's "+") @param {string} winId */
	addable: (/** @type {string} */ winId) => Object.keys(PANELS).filter((k) => canPop(k) && model.windowOf(get(panelLayout), k)?.id !== winId),
	/** the main window takes a dropped tab: 'bottom' / 'left' / 'right' put it there, null where it was @param {string} key @param {'bottom'|'left'|'right'|null} where */
	dropToMain: (/** @type {string} */ key, /** @type {'bottom'|'left'|'right'|null} */ where) => {
		if (!model.windowOf(get(panelLayout), key)) return;
		panelLayout.update((l) => model.removeTab(l, key));
		if (!where) {
			cameBack([key]);
			return;
		}
		// the main instance remounts on the next flush and consumes the arm / side placement
		Promise.all([import('../dockMenu'), import('../bottomDock'), import('../sidebars')]).then(([m, b, sb]) => {
			if (where === 'bottom') {
				if (!m.dockTab(key)) cameBack([key]);
			} else if (key === 'inspector') {
				sb.inspectorSide.set(where);
				cameBack([key]);
			} else if (m.moveToSidebar(key, where)) b.armDockMode(key, false); // a column member floats
			else cameBack([key]);
		});
	}
};

// ---------------------------------------------------------------------------------------------
// W5 — layouts per screen setup

/** the screen-setup key the layout is remembered under (the opt-in screen details, else the one screen) */
export const screenDetailsOptIn = writable(safeStorage.getItem('windows:screenDetails') === 'true');
screenDetailsOptIn.subscribe((v) => safeStorage.setItem('windows:screenDetails', String(v)));

/** @type {any[]|null} the screens getScreenDetails reported (permission granted) */
let detailScreens = null;

/** the key for the screen setup right now */
export function currentSetupKey() {
	if (detailScreens?.length) return model.setupKey({ screens: detailScreens });
	const s = /** @type {any} */ (typeof screen !== 'undefined' ? screen : { width: 0, height: 0 });
	return model.setupKey({ screen: { width: s.width, height: s.height, isExtended: !!s.isExtended }, dpr: typeof devicePixelRatio === 'number' ? devicePixelRatio : 1 });
}

/** ask for every screen (Window Management API, Chromium) — the opt-in; true when granted */
export async function requestScreenDetails() {
	const w = /** @type {any} */ (window);
	if (typeof w.getScreenDetails !== 'function') return false;
	try {
		const details = await w.getScreenDetails();
		detailScreens = details.screens.map((/** @type {any} */ s) => ({ width: s.width, height: s.height, left: s.left, top: s.top, devicePixelRatio: s.devicePixelRatio }));
		return true;
	} catch {
		detailScreens = null;
		return false;
	}
}

/** @returns {Record<string, any>} */
function readLayouts() {
	try {
		const all = JSON.parse(safeStorage.getItem(LAYOUTS_KEY) ?? '{}');
		return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
	} catch {
		return {};
	}
}

/** the saved layout for this screen setup (sanitized; empty when none) */
export function savedLayout() {
	return model.sanitize(readLayouts()[currentSetupKey()], isPoppable);
}

/** @param {Layout} l */
function persist(l) {
	if (unloading) return;
	// windows still waiting in the restore bar stay remembered until they open or are dismissed
	const queued = get(restoreQueue)?.windows ?? [];
	const all = readLayouts();
	const key = currentSetupKey();
	if (l.windows.length || queued.length) all[key] = model.serialize({ windows: [...l.windows, ...queued], next: 0 });
	else delete all[key];
	safeStorage.setItem(LAYOUTS_KEY, JSON.stringify(all));
}

/**
 * The windows still to reopen (RestoreWindowsBar): their saved form, and how many there were.
 * null = nothing to restore.
 */
export const restoreQueue = writable(/** @type {{windows: LayoutWindow[], total: number}|null} */ (null));

/**
 * Open the next saved window(s): as many as the browser lets this call open — all of them where
 * the site may open pop-ups, one per click where it may not. Run from the restore bar's click (or
 * once at boot, where only an allowed site opens anything).
 * @returns {number} how many opened
 */
export function restoreNext() {
	const q = get(restoreQueue);
	if (!q) return 0;
	let opened = 0;
	const rest = [...q.windows];
	while (rest.length) {
		const saved = rest[0];
		// a panel already popped out since (by hand) is not taken from where it is now
		const keys = saved.panels.filter((k) => canPop(k) && !model.windowOf(get(panelLayout), k));
		if (!keys.length) {
			rest.shift();
			continue;
		}
		const l = get(panelLayout);
		const id = 'w' + l.next;
		const next = model.popOutDock(l, keys, { id, origin: saved.origin, active: saved.active, rect: saved.rect });
		// popOutDock builds the tabs in their order; a PANEL window keeps its kind (and its W3 strip rule)
		const layout = { ...next.layout, windows: next.layout.windows.map((w) => (w.id === id ? { ...w, kind: saved.kind } : w)) };
		const lw = model.windowById(layout, id);
		if (!lw || !openPopup(lw)) break;
		for (const k of keys) ensureOpen(k);
		panelLayout.set(layout);
		rest.shift();
		opened++;
	}
	restoreQueue.set(rest.length ? { windows: rest, total: q.total } : null);
	persist(get(panelLayout));
	return opened;
}

/** forget the saved layout for this setup (the restore bar's ✕) */
export function dismissRestore() {
	restoreQueue.set(null);
	const all = readLayouts();
	delete all[currentSetupKey()];
	safeStorage.setItem(LAYOUTS_KEY, JSON.stringify(all));
}

let started = false;
/**
 * Boot (App.svelte): wire the layout to the real windows, close every popup with the main tab,
 * and bring the saved layout back (W5). Desktop only (W6).
 */
export async function startPanelHost() {
	if (started || typeof window === 'undefined') return;
	started = true;
	window.addEventListener('pagehide', () => {
		unloading = true;
		for (const id of [...popups.keys()]) closeWindowById(id);
	});
	// read the saved layout BEFORE following the store (its first, empty value would forget it)
	const supported = get(popOutSupported);
	if (supported && get(screenDetailsOptIn)) await requestScreenDetails();
	const saved = supported ? savedLayout() : model.emptyLayout();
	if (saved.windows.length) restoreQueue.set({ windows: saved.windows, total: saved.windows.length });
	panelLayout.subscribe((l) => {
		syncWindows(l);
		persist(l);
	});
	panelTitles.subscribe(() => syncWindows(get(panelLayout)));
	// a site allowed to open pop-ups gets its windows back by itself; elsewhere this opens
	// nothing and the restore bar asks for a click per window
	if (saved.windows.length) restoreNext();
}

/** for tests / the debug hook: the live popup of window `id` (or of the window `key` is in) @param {string} idOrKey */
export function popupWindow(idOrKey) {
	const id = popups.has(idOrKey) ? idOrKey : model.windowOf(get(panelLayout), idOrKey)?.id;
	const pop = id ? popups.get(id) : null;
	return pop && !pop.gone && !pop.w.closed ? pop.w : null;
}

/** the window the user last focused, when it is one of ours */
export function focusedPopup() {
	const w = get(lastFocusedWindow);
	return w && w !== mainWin ? w : null;
}
