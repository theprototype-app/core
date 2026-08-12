import { writable, derived, get } from 'svelte/store';
import { explorerClose } from '../stores/appStore';

// Bottom dock (roadmap #9 tail rework): the dock shows exactly ONE panel at a time.
// The Flow-family — Node editor (flow) / Flow Code (flowcode) / Animation (animation)
// — are notebook TABS in the dock (DockTabs.svelte); the Explorer is a SEPARATE panel
// that is MUTUALLY EXCLUSIVE with them: activating any Flow tab closes the Explorer,
// and the Explorer itself shows no tabs. Each panel reports present(docked+open)+height
// via setDockOccupant; only the visible one renders (the rest hide). The visible
// panel's height publishes as --bottom-inset so drawers/edge-docked windows sit above it.

export const FLOW_FAMILY = ['flow', 'flowcode', 'animation', 'uv'];
/** @type {Record<string, string>} */
export const DOCK_TITLES = { flow: 'Node editor', flowcode: 'Flow Code', animation: 'Animation', uv: 'UV editor', explorer: 'Explorer' };

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
/** shared height of the Flow-family dock (the Explorer keeps its own height) */
export const dockHeight = writable(clampH(parseInt(ls?.getItem('flowDockHeight') ?? '320')));
dockHeight.subscribe((value) => {
	try {
		ls?.setItem('flowDockHeight', String(value));
	} catch {}
});

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

/** the Flow-family panels currently open+docked, as tabs (Node editor first) */
export const flowTabs = derived(dockOccupants, ($o) =>
	FLOW_FAMILY.filter((k) => $o[k]?.present).map((k) => ({ key: k, title: DOCK_TITLES[k] }))
);

/** the single panel that is actually VISIBLE in the dock (null if the dock is empty) */
export const visibleDockKey = derived([dockOccupants, bottomDockActive], ([$o, $a]) => {
	if ($o[$a]?.present) return $a;
	// active isn't docked (undocked/closed) — fall back to any present panel so the
	// dock never goes blank while a tab is still open
	return Object.keys($o).find((k) => $o[k]?.present) ?? null;
});

/** height of the visible docked panel (0 when nothing is docked) */
export const bottomInset = derived([dockOccupants, visibleDockKey], ([$o, $key]) =>
	$key && $o[$key]?.present ? $o[$key].height : 0
);

/**
 * Make `key` the visible dock panel. The Flow-family and the Explorer are mutually
 * exclusive ONLY in the dock — the actual closing of the Explorer happens reactively
 * (see below) when a Flow-family panel becomes the VISIBLE dock panel, so a FLOATING
 * Node editor / Flow Code never closes a docked Explorer.
 * @param {string} key
 */
export function activateDock(key) {
	bottomDockActive.set(key);
}

// Exclusivity: the dock has ONE slot. Close the Explorer only when a DOCKED Flow-family
// panel actually becomes the visible dock panel — a floating Node editor never makes a
// Flow-family key the visible key, so a docked Explorer is left alone (they collide only
// when BOTH are docked).
visibleDockKey.subscribe((key) => {
	if (key && FLOW_FAMILY.includes(key) && get(dockOccupants).explorer?.present) explorerClose.set(true);
});

// publish the visible dock height as a CSS var so drawers/docked windows adjust (105)
if (typeof document !== 'undefined') {
	bottomInset.subscribe((inset) => {
		document.documentElement.style.setProperty('--bottom-inset', inset + 'px');
	});
}
