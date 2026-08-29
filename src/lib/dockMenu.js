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
import { activateDock, armDockMode, dockOccupants, DOCK_TITLES } from './bottomDock';

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

/**
 * W8b: the views this menu can open, as PLAIN DATA — no labels, no actions, no
 * filtering. It was a literal inside `dockAddItems` until the toolbar grew a roster
 * offering the same views as optional BUTTONS and a "Swap with" submenu offering them
 * as REPLACEMENTS: three consumers, and a list written out three times is a list that
 * disagrees with itself on the next view added. All three build their own rows from
 * THIS, so a view added here reaches every surface at once.
 *
 * The TITLE is deliberately not here: `DOCK_TITLES` in bottomDock.js has been the name
 * of a dock view since the tab strip was written, and a second copy would be one more
 * thing to drift. This carries only what that map cannot — the one-line description.
 *
 * The Node editor stays absent, exactly as before: this list is also the FLOATING Node
 * editor's own "+", where offering to open a second copy of itself is nonsense. (The
 * toolbar roster names it separately — there it is a first-class button, not an
 * "add a view" row.)
 * @type {{key: string, tooltip: string}[]}
 */
export const DOCK_VIEWS = [
	{ key: 'flowcode', tooltip: 'Edit the graph as JSON' },
	{ key: 'animation', tooltip: 'Animate the selected object' },
	{ key: 'uv', tooltip: 'Edit the selected mesh’s UV map and textures' },
	{ key: 'shader', tooltip: 'Drive this material from a node graph' },
	{ key: 'hud', tooltip: 'Lay out the on-screen HUD its nodes drive' },
	{ key: 'explorer', tooltip: 'Browse the asset library' }
];

/** what the "+" row itself does: open the panel DOCKED and show it. Kept beside the
 *  list rather than in it, because the toolbar's consumers do not want this — a roster
 *  button goes through `togglePanel`, which can also hide the panel again.
 *  @type {Record<string, () => void>} */
const OPENERS = {
	flowcode: () => { flowCodeClose.set(false); activateDock('flowcode'); },
	animation: () => { animationClose.set(false); activateDock('animation'); },
	uv: () => { uvEditorClose.set(false); activateDock('uv'); },
	shader: () => { shaderEditorClose.set(false); activateDock('shader'); },
	hud: () => { hudEditorClose.set(false); activateDock('hud'); },
	explorer: () => { explorerClose.set(false); activateDock('explorer'); }
};

/** @returns {{label: string, tooltip: string, action?: () => void, disabled?: boolean}[]} */
export function dockAddItems() {
	const occupied = get(dockOccupants);
	const free = DOCK_VIEWS.filter((view) => !occupied[view.key]?.present).map((view) => ({
		key: view.key,
		label: `＋ ${DOCK_TITLES[view.key] ?? view.key}`,
		tooltip: view.tooltip,
		action: OPENERS[view.key]
	}));
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
 * @param {string} key
 * @returns {{label: string, tooltip: string, action: () => void, danger?: boolean}[]}
 */
export function dockTabItems(key) {
	const title = DOCK_TITLES[key] ?? 'this view';
	/** @type {{label: string, tooltip: string, action: () => void, danger?: boolean}[]} */
	const items = [];
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
