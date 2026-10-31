// 70 W2-W5 — THE POP-OUT LAYOUT MODEL, pure data (no DOM, no stores): which panels live in which
// pop-out window, in which tab order, which tab is in front. $lib/windows/panelPlaces holds one of
// these in a store; $lib/windows/panelHost opens and closes the real windows to match it.
//
// A window is { id, kind, panels, active, origin, rect }:
//   kind 'panel'  popped out panel by panel (W2) — ONE panel shows no tab strip (W3)
//   kind 'dock'   a whole dock popped out at once (W3) — ALWAYS tabbed, whatever its count
//   origin        the dock a 'dock' window came from ('bottom' | 'left' | 'right'), else null
//   rect          where it was last seen on screen (W5), null until then
//
// THE RULES (owner, roadmap 70 W3/W4), each one function below:
//   one panel, one place  a key is in at most ONE window; adding it anywhere moves it (`addTab`)
//   collapse              a window whose last tab leaves is gone (`removeTab`, `addTab`)
//   strip                 shown for a dock window, for two or more tabs, or when the setting says
//                         "always" (`showsStrip`); back to one tab, a panel window's strip goes
//   front tab             the tab added or moved in comes to the front; the front tab leaving
//                         hands the front to its right neighbour, else its left one
// Every operation returns a NEW layout and leaves its input untouched.

/** @typedef {'panel'|'dock'} WindowKind */
/** @typedef {'bottom'|'left'|'right'} DockOrigin */
/** @typedef {{left: number, top: number, width: number, height: number}} WinRect */
/** @typedef {{id: string, kind: WindowKind, panels: string[], active: string|null, origin: DockOrigin|null, rect: WinRect|null}} LayoutWindow */
/** @typedef {{windows: LayoutWindow[], next: number}} Layout */

/** @returns {Layout} */
export function emptyLayout() {
	return { windows: [], next: 1 };
}

/** the window a panel lives in, or null (the main window) @param {Layout} layout @param {string} key */
export function windowOf(layout, key) {
	return layout.windows.find((w) => w.panels.includes(key)) ?? null;
}

/** @param {Layout} layout @param {string} id */
export function windowById(layout, id) {
	return layout.windows.find((w) => w.id === id) ?? null;
}

/** every key in a pop-out window @param {Layout} layout */
export function poppedKeys(layout) {
	return layout.windows.flatMap((w) => w.panels);
}

/** the front tab after `key` leaves a window's `panels` @param {string[]} panels @param {string|null} active @param {string} key */
function frontAfter(panels, active, key) {
	if (active !== key) return active;
	const i = panels.indexOf(key);
	const rest = panels.filter((k) => k !== key);
	return rest[i] ?? rest[i - 1] ?? null;
}

/** take `key` out of every window, dropping a window it leaves empty @param {Layout} layout @param {string} key @returns {Layout} */
function without(layout, key) {
	if (!windowOf(layout, key)) return layout;
	const windows = [];
	for (const w of layout.windows) {
		if (!w.panels.includes(key)) {
			windows.push(w);
			continue;
		}
		const panels = w.panels.filter((k) => k !== key);
		if (!panels.length) continue; // collapse: a window with no tab is no window
		windows.push({ ...w, panels, active: frontAfter(w.panels, w.active, key) });
	}
	return { ...layout, windows };
}

/**
 * Pop `key` out into a NEW panel window of its own (W2). Already alone in a window of its own: no
 * change. Elsewhere (another window): it moves (one place).
 * @param {Layout} layout @param {string} key @param {{rect?: WinRect|null, id?: string}=} opts
 * @returns {{layout: Layout, id: string}}
 */
export function popOut(layout, key, opts = {}) {
	const home = windowOf(layout, key);
	if (home && home.panels.length === 1 && home.kind === 'panel') return { layout, id: home.id };
	const base = without(layout, key);
	const id = opts.id ?? 'w' + base.next;
	/** @type {LayoutWindow} */
	const win = { id, kind: 'panel', panels: [key], active: key, origin: null, rect: opts.rect ?? null };
	return { layout: { windows: [...base.windows, win], next: base.next + 1 }, id };
}

/**
 * Pop a whole dock out as ONE tabbed window (W3). The keys keep their dock order; each leaves any
 * window it was in first.
 * @param {Layout} layout @param {string[]} keys @param {{origin?: DockOrigin|null, active?: string|null, rect?: WinRect|null, id?: string}=} opts
 * @returns {{layout: Layout, id: string|null}}
 */
export function popOutDock(layout, keys, opts = {}) {
	const list = [...new Set(keys)];
	if (!list.length) return { layout, id: null };
	let base = layout;
	for (const k of list) base = without(base, k);
	const id = opts.id ?? 'w' + base.next;
	const active = opts.active && list.includes(opts.active) ? opts.active : list[0];
	/** @type {LayoutWindow} */
	const win = { id, kind: 'dock', panels: list, active, origin: opts.origin ?? null, rect: opts.rect ?? null };
	return { layout: { windows: [...base.windows, win], next: base.next + 1 }, id };
}

/**
 * Add `key` as a tab of window `id` at `index` (the end by default) and bring it to the front —
 * from wherever it is: the main window, or another pop-out (it MOVES; a window it empties is gone).
 * Inside its own window this is a reorder.
 * @param {Layout} layout @param {string} id @param {string} key @param {number=} index
 * @returns {Layout}
 */
export function addTab(layout, id, key, index) {
	if (!windowById(layout, id)) return layout;
	const home = windowOf(layout, key);
	// moving a window's ONLY tab into itself, or its only tab elsewhere, is still one place
	const base = home && home.id === id ? { ...layout, windows: layout.windows.map((w) => (w.id === id ? { ...w, panels: w.panels.filter((k) => k !== key) } : w)) } : without(layout, key);
	const target = windowById(base, id);
	if (!target) return layout; // the target was the window the key emptied — nothing to add to
	const panels = [...target.panels];
	const at = index == null ? panels.length : Math.max(0, Math.min(index, panels.length));
	panels.splice(at, 0, key);
	return { ...base, windows: base.windows.map((w) => (w.id === id ? { ...w, panels, active: key } : w)) };
}

/**
 * `key` leaves its pop-out window (docked back, moved to a main dock, or closed). The front tab
 * passes to its neighbour; a window left empty is gone (collapse).
 * @param {Layout} layout @param {string} key @returns {Layout}
 */
export function removeTab(layout, key) {
	return without(layout, key);
}

/** every panel of window `id` leaves (Dock back on the window, the window closed) @param {Layout} layout @param {string} id */
export function closeWindow(layout, id) {
	const win = windowById(layout, id);
	if (!win) return { layout, keys: /** @type {string[]} */ ([]) };
	return { layout: { ...layout, windows: layout.windows.filter((w) => w.id !== id) }, keys: [...win.panels] };
}

/** bring a tab to the front of its window @param {Layout} layout @param {string} key */
export function activate(layout, key) {
	const home = windowOf(layout, key);
	if (!home || home.active === key) return layout;
	return { ...layout, windows: layout.windows.map((w) => (w.id === home.id ? { ...w, active: key } : w)) };
}

/** move every tab of window `from` into window `to` (in order, after its own) @param {Layout} layout @param {string} from @param {string} to */
export function mergeWindows(layout, from, to) {
	const a = windowById(layout, from);
	const b = windowById(layout, to);
	if (!a || !b || a.id === b.id) return layout;
	const panels = [...b.panels, ...a.panels.filter((k) => !b.panels.includes(k))];
	return { ...layout, windows: layout.windows.filter((w) => w.id !== from).map((w) => (w.id === to ? { ...w, panels, active: a.active ?? w.active } : w)) };
}

/** remember where a window is on screen @param {Layout} layout @param {string} id @param {WinRect} rect */
export function setRect(layout, id, rect) {
	if (!windowById(layout, id)) return layout;
	return { ...layout, windows: layout.windows.map((w) => (w.id === id ? { ...w, rect: { ...rect } } : w)) };
}

/**
 * W3 — does this window show a tab strip? A popped DOCK always does; a panel window does from its
 * second tab on; the "Always show tab strip in windows" setting shows it for one tab too.
 * @param {LayoutWindow|null|undefined} win @param {boolean=} always
 */
export function showsStrip(win, always = false) {
	if (!win) return false;
	return win.kind === 'dock' || win.panels.length > 1 || !!always;
}

/**
 * The window's title: its front tab's name (a single-panel window's header IS that name).
 * @param {LayoutWindow|null|undefined} win @param {(key: string) => string} titleOf
 */
export function windowTitle(win, titleOf) {
	const key = win?.active ?? win?.panels[0];
	return key ? titleOf(key) : '';
}

/**
 * Read a persisted layout back: unknown keys dropped (a panel this build no longer has), a key
 * named twice kept in its first window, empty windows gone, ids renumbered from 1.
 * @param {any} raw @param {(key: string) => boolean} known @returns {Layout}
 */
export function sanitize(raw, known) {
	const seen = new Set();
	/** @type {LayoutWindow[]} */
	const windows = [];
	for (const w of Array.isArray(raw?.windows) ? raw.windows : []) {
		const panels = (Array.isArray(w?.panels) ? w.panels : []).filter((/** @type {any} */ k) => typeof k === 'string' && known(k) && !seen.has(k) && seen.add(k));
		if (!panels.length) continue;
		const kind = w.kind === 'dock' ? 'dock' : 'panel';
		const origin = w.origin === 'bottom' || w.origin === 'left' || w.origin === 'right' ? w.origin : null;
		const r = w.rect;
		const rect = r && [r.left, r.top, r.width, r.height].every((n) => Number.isFinite(n)) && r.width > 200 && r.height > 150 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
		windows.push({ id: 'w' + (windows.length + 1), kind, panels, active: panels.includes(w.active) ? w.active : panels[0], origin, rect });
	}
	return { windows, next: windows.length + 1 };
}

/** the persisted form (ids are not kept: they are renumbered on read) @param {Layout} layout */
export function serialize(layout) {
	return { windows: layout.windows.map(({ kind, panels, active, origin, rect }) => ({ kind, panels, active, origin, rect })) };
}

/**
 * W5 — the key a layout is remembered under: the screen setup. With the Window Management API's
 * permission (`getScreenDetails`, Chromium, opt-in) every screen counts, sorted by position;
 * without it the one screen the page can see, and whether the desktop extends past it.
 * @param {{screens?: {width: number, height: number, left?: number, top?: number, devicePixelRatio?: number}[], screen?: {width: number, height: number, isExtended?: boolean}, dpr?: number}} info
 */
export function setupKey(info) {
	if (info.screens?.length) {
		const parts = [...info.screens]
			.sort((a, b) => (a.left ?? 0) - (b.left ?? 0) || (a.top ?? 0) - (b.top ?? 0))
			.map((s) => `${s.width}x${s.height}@${Math.round((s.devicePixelRatio ?? 1) * 100) / 100}+${s.left ?? 0}+${s.top ?? 0}`);
		return 'screens:' + parts.join('|');
	}
	const s = info.screen ?? { width: 0, height: 0 };
	return `screen:${s.width}x${s.height}@${Math.round((info.dpr ?? 1) * 100) / 100}${s.isExtended ? '+ext' : ''}`;
}
