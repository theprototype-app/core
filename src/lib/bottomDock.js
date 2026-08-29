import { writable, derived } from 'svelte/store';

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
}

/** the Flow-family panels currently open+docked (the Node editor button owns this
 * group, and the flow-dock suites read it — it is NOT the tab strip) */
export const flowTabs = derived(dockOccupants, ($o) =>
	FLOW_FAMILY.filter((k) => $o[k]?.present).map((k) => ({ key: k, title: DOCK_TITLES[k] }))
);

/** every panel currently open+docked, as the dock's tabs (what DockTabs renders) */
export const dockTabs = derived(dockOccupants, ($o) =>
	DOCK_FAMILY.filter((k) => $o[k]?.present).map((k) => ({ key: k, title: DOCK_TITLES[k] }))
);

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
