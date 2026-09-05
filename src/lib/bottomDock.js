import { writable, derived, get } from 'svelte/store';
import { viewPrefs } from './viewPrefs';

// Bottom dock: the dock shows exactly ONE panel at a time, and every panel that is
// docked+open is a notebook TAB in it — the Flow family (Node editor / Flow Code /
// Animation / UV editor / Shader editor / HUD editor) AND the Explorer alike, one
// strip rendered by whichever panel is showing (DockTabs.svelte). Nothing here
// force-closes anything: switching tabs changes only WHICH panel renders, so an
// Explorer covered by the Node editor stays open as a hidden tab (it used to be
// closed outright — the dock's two systems collapsed into one in the controls
// rework). Each panel reports present(docked+open)+height via setDockOccupant; only
// the visible one renders (the rest hide) and its height publishes as --bottom-inset
// so drawers/edge-docked windows sit above it.
// This module imports NO app stores — it is dock bookkeeping and nothing else.

export const FLOW_FAMILY = ['flow', 'flowcode', 'animation', 'uv', 'shader', 'hud'];
/** every panel that can be a dock tab, in strip order (Node editor first) */
export const DOCK_FAMILY = [...FLOW_FAMILY, 'explorer'];
/** @type {Record<string, string>} */
export const DOCK_TITLES = { flow: 'Node editor', flowcode: 'Flow Code', animation: 'Animation', uv: 'UV editor', shader: 'Shader editor', hud: 'HUD editor', explorer: 'Explorer' };

const ls = typeof localStorage !== 'undefined' ? localStorage : null;

/** which panel owns the dock right now */
export const bottomDockActive = writable(ls?.getItem('bottomDockActive') ?? 'flow');
bottomDockActive.subscribe((value) => {
	try {
		ls?.setItem('bottomDockActive', value);
	} catch {}
});

/** @param {number} h */
function clampH(h) {
	const max = typeof window !== 'undefined' ? Math.round(window.innerHeight * 0.8) : 800;
	return Math.min(Math.max(h || 320, 160), max);
}
/** shared height of the dock — ONE value for every tab, Explorer included */
export const dockHeight = writable(clampH(parseInt(ls?.getItem('flowDockHeight') ?? '320')));
dockHeight.subscribe((value) => {
	try {
		ls?.setItem('flowDockHeight', String(value));
	} catch {}
});

/**
 * W2: the dock is MINIMIZED — every tab stays open, nothing renders, and the dock
 * reserves no space (`bottomInset` reads 0), so the viewport is clear without closing
 * anybody's work. DELIBERATELY NOT PERSISTED: a minimized dock leaves no trace on
 * screen (the tab strip lives INSIDE the visible panel, so there is none), and the only
 * restore affordance is the toolbar's own buttons — a reload therefore brings the dock
 * back rather than handing someone a lost panel with no visible way to it.
 * `activateDock` clears it, so every path that asks for a tab (toolbar button, O/N key,
 * the "+" menu, a panel opening itself) restores the dock as a side effect.
 */
export const dockMinimized = writable(false);

/**
 * W5: ASK a panel to become a dock tab / a floating window.
 *
 * Every panel's `docked` flag is component-local `$state`, read from localStorage
 * exactly ONCE at mount — so writing that key from outside is MEASURABLY inert at a
 * live panel and the caller's row reads as a dead button. The panel's own `setDocked`
 * owns the mode (the flag, the render branch and the dock occupancy move together),
 * so an outside caller asks and the owner acts. That seam already existed for the
 * Explorer alone (`explorerDockArm` in appStore); this is the same shape GENERALISED
 * to every DOCK_FAMILY member, which is what lets the tab strip's own context menu
 * undock whichever tab was right-clicked — including one that is not currently the
 * visible panel, since a hidden tab hides with a class and stays mounted.
 *
 * Write-once: a consumer clears it as it acts, and the `token` makes two identical
 * asks in a row two distinct events.
 *
 * It lives HERE and not in appStore because it is dock bookkeeping and holds no app
 * state (see the no-app-stores note at the top of this module).
 * @type {import('svelte/store').Writable<{token: number, key: string, docked: boolean}|null>}
 */
export const dockModeArm = writable(null);
let dockArmToken = 0;
/** @param {string} key @param {boolean} docked */
export function armDockMode(key, docked) {
	dockModeArm.set({ token: ++dockArmToken, key, docked: !!docked });
}

/** {key: {present, height}} — docked AND open */
export const dockOccupants = writable(
	/** @type {Record<string, {present: boolean, height: number}>} */ ({})
);

/** @param {string} key @param {boolean} present @param {number=} height */
export function setDockOccupant(key, present, height = 0) {
	dockOccupants.update((state) => {
		const entry = state[key];
		if (entry && entry.present === present && entry.height === height) return state;
		return { ...state, [key]: { present, height } };
	});
	// a view REPORTING ITSELF DOCKED is what "added" means — see `noteDockOrder`. It is
	// safe to call on every report: a key already in the order is left exactly where it is.
	if (present) noteDockOrder(key);
}

/** the Flow-family panels currently open+docked (the Node editor button owns this
 * group, and the flow-dock suites read it — it is NOT the tab strip) */
export const flowTabs = derived(dockOccupants, ($o) =>
	FLOW_FAMILY.filter((k) => $o[k]?.present).map((k) => ({ key: k, title: DOCK_TITLES[k] }))
);

/**
 * W7 — THE TAB ORDER IS USER DATA, and since the follow-up round it is DOCKING ORDER:
 * a view takes its place in the strip when it is docked, at the END, and keeps it until
 * it is dragged elsewhere. `DOCK_FAMILY` is only the order the module DECLARES its views
 * in; it is not what the strip sorts by. Reported as "tabs should add in the order I add
 * them" — before this the list was seeded with the whole family, so every key was
 * already placed and adding the Explorer then the Animation tab showed them the other
 * way round, which reads as the strip ignoring you.
 *
 * LOCAL and persisted, exactly like `bottomDockActive`: where a tab sits in the strip is
 * a fact about this screen, never about the scene, so it neither replicates nor saves.
 * Persisted is also what makes the order survive a reload — a panel re-reporting itself
 * docked at boot is already IN the list, so `noteDockOrder` leaves it alone.
 *
 * WHAT LEAVES THE LIST is the other half of the rule, and the two cases are not the same:
 *   UNDOCK  -> `forgetDockTab`, so re-docking is a fresh add at the end (the convention
 *              a tab strip has everywhere else).
 *   CLOSE   -> the slot is KEPT. A close is not a rearrangement, and the app closes
 *              panels on its own — `hidePanels()` shuts the Node editor whenever Settings
 *              or the Modules manager opens — so treating it as one would silently walk a
 *              hand-made arrangement apart every time somebody opened a dialog.
 * @type {import('svelte/store').Writable<string[]>}
 */
export const dockTabOrder = writable(readTabOrder());

function readTabOrder() {
	try {
		const raw = JSON.parse(ls?.getItem('dockTabOrder') ?? 'null');
		if (!Array.isArray(raw)) return [];
		const out = resolveOrder(raw);
		// MIGRATION: the old model wrote the whole shipped family out on the first
		// subscribe whether anybody had arranged anything or not, so a list that IS the
		// shipped order carries no information — and keeping it would leave every
		// existing install with all seven keys placed, i.e. with the reported bug intact.
		// Any OTHER order was arranged by hand and is kept verbatim.
		return out.join(',') === DOCK_FAMILY.join(',') ? [] : out;
	} catch {
		return [];
	}
}
dockTabOrder.subscribe((value) => {
	try {
		ls?.setItem('dockTabOrder', JSON.stringify(value));
	} catch {}
});

/**
 * A stored (possibly stale, possibly hand-edited) order -> a usable one: unknown keys
 * dropped, duplicates collapsed, nothing added. A key the list has never heard of — a
 * view from a LATER release, or one just docked — is not this function's business: it
 * joins the strip at the END, through `noteDockOrder`.
 * @param {string[]} stored @returns {string[]}
 */
export function resolveOrder(stored) {
	return [...new Set((stored ?? []).filter((k) => DOCK_FAMILY.includes(k)))];
}

/** the keys currently docked+open */
function presentKeys() {
	const o = get(dockOccupants);
	return DOCK_FAMILY.filter((k) => o[k]?.present);
}

/**
 * `keys` in the strip's order. Anything the order list has never placed goes at the END
 * in family order — the safety net for a tab that somehow reached the dock without a
 * `noteDockOrder` (an order list hand-edited in localStorage, a future caller): a strip
 * that silently DROPPED such a tab would be a panel with no way back.
 * @param {string[]} keys @param {string[]} order
 */
function inOrder(keys, order) {
	const placed = resolveOrder(order);
	return [...placed.filter((k) => keys.includes(k)), ...keys.filter((k) => !placed.includes(k))];
}

/** every panel currently open+docked, as the dock's tabs (what DockTabs renders),
 * in the user's own order */
export const dockTabs = derived([dockOccupants, dockTabOrder], ([$o, $order]) =>
	inOrder(
		DOCK_FAMILY.filter((k) => $o[k]?.present),
		$order
	).map((k) => ({ key: k, title: DOCK_TITLES[k] }))
);

/**
 * Give `key` a place in the strip — at the END, which is what "added in the order I add
 * them" means. Called from `setDockOccupant`, so EVERY route into the dock earns its
 * slot the same way: the "+" menu, a toolbar button, a panel's own Dock button, a window
 * dropped on the bottom band, or a panel opening itself at boot.
 * A key already placed is left where it is — that is what makes a reload, a tab switch
 * and a panel re-mounting after Settings closes all no-ops.
 * @param {string} key
 */
export function noteDockOrder(key) {
	if (!DOCK_FAMILY.includes(key)) return;
	const cur = resolveOrder(get(dockTabOrder));
	if (cur.includes(key)) return;
	dockTabOrder.set([...cur, key]);
}

/**
 * Drop `key`'s slot, so the next time it docks it joins the strip as a fresh add at the
 * end. Called by each panel's own `setDocked(false)` — the ONE thing every undock route
 * passes through (the tab menu's Undock row and a tab dragged out of the strip both ask
 * through `dockModeArm`, which the panel answers by calling it).
 * Deliberately NOT called when a view merely CLOSES: see the note on `dockTabOrder`.
 * @param {string} key
 */
export function forgetDockTab(key) {
	const cur = resolveOrder(get(dockTabOrder));
	if (!cur.includes(key)) return;
	dockTabOrder.set(cur.filter((k) => k !== key));
}

/**
 * Commit a new order for the tabs that are PRESENT. The absent ones keep their own
 * slots: the present keys re-fill the positions they already occupied, in the order
 * given. That is what makes a drag mean "put this tab there" rather than "rewrite the
 * whole list" — a closed Animation tab does not silently migrate because somebody
 * dragged the Explorer past the UV editor.
 * @param {string[]} keys the present tabs, in their new order
 */
export function reorderDockTabs(keys) {
	// the arrangement list PLUS anything present it has not placed, so the slot map below
	// can always find every key it was asked about (`inOrder`'s safety net, committed)
	const placed = resolveOrder(get(dockTabOrder));
	const full = [...placed, ...presentKeys().filter((k) => !placed.includes(k))];
	const slots = full.map((k, i) => (keys.includes(k) ? i : -1)).filter((i) => i >= 0);
	if (slots.length !== keys.length) return false; // asked about a tab that isn't present
	const next = [...full];
	slots.forEach((slot, n) => (next[slot] = keys[n]));
	dockTabOrder.set(next);
	return true;
}

/**
 * Move a tab one place left/right among the tabs that are PRESENT — moving past a tab
 * that is closed is meaningless, so the neighbour is the next VISIBLE one.
 * @param {string} key @param {'left'|'right'} dir @returns {boolean} did it move
 */
export function moveDockTab(key, dir) {
	const present = get(dockTabs).map((t) => t.key);
	const i = present.indexOf(key);
	const j = i + (dir === 'left' ? -1 : 1);
	if (i < 0 || j < 0 || j >= present.length) return false;
	const next = [...present];
	next[i] = present[j];
	next[j] = key;
	return reorderDockTabs(next);
}

/** the single panel that is actually VISIBLE in the dock (null if the dock is empty) */
export const visibleDockKey = derived([dockOccupants, bottomDockActive], ([$o, $a]) => {
	if ($o[$a]?.present) return $a;
	// active isn't docked (undocked/closed) — fall back to any present panel so the
	// dock never goes blank while a tab is still open
	return Object.keys($o).find((k) => $o[k]?.present) ?? null;
});

/** height of the visible docked panel (0 when nothing is docked, and 0 while the dock
 * is minimized — a minimized dock draws nothing, so it may not reserve any space) */
export const bottomInset = derived(
	[dockOccupants, visibleDockKey, dockMinimized],
	([$o, $key, $min]) => ($min ? 0 : $key && $o[$key]?.present ? $o[$key].height : 0)
);

/**
 * W9 — the height the VIEWPORT gives up to the dock: `bottomInset` when the dock
 * RESIZES the viewport (the default) and 0 when it merely overlays a full-window
 * canvas. The store twin of App.svelte's `.viewport-inset` rule, so the canvas and the
 * chrome measured against it (the framing guide's letterbox, the camera PiP's rect)
 * cannot end up disagreeing about where the viewport ends.
 *
 * The `viewPrefs` import is the one exception to the no-app-stores note at the top: it
 * is a pure localStorage leaf (svelte/store only), and one shared derived beats the
 * same two-line rule copied into each consumer.
 */
export const viewportInset = derived([bottomInset, viewPrefs], ([$inset, $prefs]) =>
	$prefs?.dockPushesViewport ? $inset : 0
);

/**
 * Make `key` the visible dock panel. Purely a selection: the tab that was showing
 * stays open and simply stops rendering, so no panel is ever closed by another one
 * arriving. Asking for a tab also UN-MINIMIZES the dock: every restore path in the app
 * (toolbar buttons, the O/N keys through panelToggles, the "+" menu, a panel opening
 * itself) already funnels through here, so the clear lives in one place.
 * @param {string} key
 */
export function activateDock(key) {
	bottomDockActive.set(key);
	dockMinimized.set(false);
}

// publish the visible dock height as a CSS var so drawers/docked windows adjust (105)
if (typeof document !== 'undefined') {
	bottomInset.subscribe((inset) => {
		document.documentElement.style.setProperty('--bottom-inset', inset + 'px');
	});
}
