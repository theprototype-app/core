import {
	flowGraphClose,
	flowCodeClose,
	animationClose,
	uvEditorClose,
	shaderEditorClose,
	hudEditorClose,
	explorerClose
} from '../stores/appStore';
import { get } from 'svelte/store';
import { activateDock, armDockMode, dockOccupants, dockTabs, moveDockTab, DOCK_TITLES } from './bottomDock';

// The dock's "+" add-a-view menu, in ONE place. The docked tab strip
// (DockTabs.svelte) and the FLOATING Node editor's header "+" (Flow.svelte) each
// kept their own copy of the same list, so a view added to one silently went
// missing from the other. Every entry opens its panel — they all start docked —
// and makes it the visible tab; the Explorer is one of them now that it is an
// ordinary dock tab rather than the dock's separate occupant.
//
// W5: a view already IN the dock is dropped from the list — offering "＋ Explorer"
// while the Explorer is a tab beside the "+" is a row that can only re-activate what
// you are looking at. The occupancy is read HERE, at build time, and the menu is built
// per open (DockTabs rebuilds `addItems` in its opener), so it cannot go stale. When
// everything is docked the list would be EMPTY, which is a menu with nothing in it and
// no explanation, so it degrades to one disabled row that says why.
//
// The Node editor is deliberately NOT in the base list, exactly as before: this menu
// is also the FLOATING Node editor's own "+", where offering to open a second copy of
// itself is nonsense. N / the toolbar button is its way back.

/** @returns {{label: string, tooltip: string, action?: () => void, disabled?: boolean}[]} */
export function dockAddItems() {
	const occupied = get(dockOccupants);
	const all = [
		{ key: 'flowcode', label: '＋ Flow Code', tooltip: 'Edit the graph as JSON', action: () => { flowCodeClose.set(false); activateDock('flowcode'); } },
		{ key: 'animation', label: '＋ Animation', tooltip: 'Animate the selected object', action: () => { animationClose.set(false); activateDock('animation'); } },
		{ key: 'uv', label: '＋ UV editor', tooltip: 'Edit the selected mesh’s UV map and textures', action: () => { uvEditorClose.set(false); activateDock('uv'); } },
		{ key: 'shader', label: '＋ Shader editor', tooltip: 'Drive this material from a node graph', action: () => { shaderEditorClose.set(false); activateDock('shader'); } },
		{ key: 'hud', label: '＋ HUD editor', tooltip: 'Lay out the on-screen HUD its nodes drive', action: () => { hudEditorClose.set(false); activateDock('hud'); } },
		{ key: 'explorer', label: '＋ Explorer', tooltip: 'Browse the asset library', action: () => { explorerClose.set(false); activateDock('explorer'); } }
	];
	const free = all.filter((item) => !occupied[item.key]?.present);
	if (!free.length)
		return [{ label: 'All views are docked', tooltip: 'Every view this menu can open is already a tab', disabled: true }];
	return free;
}

/**
 * W5: the menu a TAB itself offers, on right-click (a long press on Android fires
 * `contextmenu` natively, so touch gets it for free).
 *
 * Two rows, and both act on the tab that was CLICKED rather than on whichever panel is
 * showing — which is the whole point of putting them here: the strip's own ✕ can only
 * ever reach the visible tab, and a hidden tab had no affordance at all.
 *
 * Undocking asks through `armDockMode` because the panel owns its own mode (see the
 * note on that store). The ShaderEditor has NO floating mode — it is the one dock tab
 * with no `docked` flag or window chrome — so it is offered Close alone rather than a
 * row that would silently do nothing.
 * W7 puts MOVE at the top of the same menu: the drag in the strip is the fast way and
 * these two rows are the discoverable one, and they are the only way to reorder a tab
 * on a device with no pointer to drag with. They read the PRESENT tabs, so they step
 * over a closed view rather than into a gap, and each disables itself at its end of the
 * strip — a row that can only no-op is worse than a row that says it cannot.
 * @param {string} key
 * @returns {{label: string, tooltip: string, action: () => void, danger?: boolean, disabled?: boolean}[]}
 */
export function dockTabItems(key) {
	const title = DOCK_TITLES[key] ?? 'this view';
	/** @type {{label: string, tooltip: string, action: () => void, danger?: boolean, disabled?: boolean}[]} */
	const items = [];
	const present = get(dockTabs).map((t) => t.key);
	const at = present.indexOf(key);
	items.push({
		label: 'Move left',
		tooltip: `Move ${title} one tab towards the start of the strip`,
		disabled: at <= 0,
		action: () => moveDockTab(key, 'left')
	});
	items.push({
		label: 'Move right',
		tooltip: `Move ${title} one tab towards the end of the strip`,
		disabled: at < 0 || at >= present.length - 1,
		action: () => moveDockTab(key, 'right')
	});
	if (key !== 'shader')
		items.push({
			label: 'Undock into a floating window',
			tooltip: `Take ${title} out of the dock`,
			action: () => armDockMode(key, false)
		});
	items.push({
		label: 'Close',
		tooltip: `Close ${title} (it leaves the dock; nothing else is touched)`,
		action: () => closeStoreFor(key)?.set(true)
	});
	return items;
}

/**
 * W2: the dock key -> the store that CLOSES that panel (every one of these is inverted
 * app-wide: true = closed). It lives here beside the add list, and not in bottomDock.js,
 * for the reason stated at the top of that module — dock bookkeeping imports no app
 * stores. The tab strip's ✕ is its only caller today; putting the mapping in one place
 * is what stops a future closer disagreeing with the "+" entry that opened it.
 * @type {Record<string, import('svelte/store').Writable<boolean>>}
 */
export const DOCK_CLOSERS = {
	flow: flowGraphClose,
	flowcode: flowCodeClose,
	animation: animationClose,
	uv: uvEditorClose,
	shader: shaderEditorClose,
	hud: hudEditorClose,
	explorer: explorerClose
};

/** @param {string} key @returns {import('svelte/store').Writable<boolean>|null} */
export function closeStoreFor(key) {
	return DOCK_CLOSERS[key] ?? null;
}
