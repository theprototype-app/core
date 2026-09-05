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
// missing from the other. Every entry puts its panel IN THE DOCK and makes it the
// visible tab — opening it when it is closed, and DOCKING it when it is already open
// as a floating window (see `dockView`); the Explorer is one of them now that it is an
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

/**
 * What a "+" row does: put that view IN THE DOCK and show it. Kept beside the list
 * rather than in it, because the toolbar's consumers do not want this — a roster button
 * goes through `togglePanel`, which can also hide the panel again.
 *
 * It ARMS the dock mode first, and that is the whole of the "+ docks a floating window"
 * fix. The rows used to be `close.set(false); activateDock(key)`, which says nothing
 * about MODE — so for a view already open as a floating window the close store was
 * already false (nothing happened) and `activateDock` named a key that is not a dock
 * occupant, leaving `visibleDockKey`'s fallback to show some other tab. The row read as
 * a dead button while its window sat there floating. `armDockMode` is the seam every
 * panel already consumes (the tab strip's Undock row, a tab dragged out of the strip,
 * a window dropped on the bottom band all go through it), so this is the SAME float ->
 * dock transition the window's own "⇩ Dock" button makes, not a second one.
 *
 * The close store still has to be set for the panel that is CLOSED: it has no component
 * mounted to consume the arm until it opens (the arm is write-once and survives until
 * something reads it, so the order is unimportant).
 * @param {string} key
 */
function dockView(key) {
	armDockMode(key, true);
	closeStoreFor(key)?.set(false);
	activateDock(key);
}

/** @returns {{label: string, tooltip: string, action?: () => void, disabled?: boolean}[]} */
export function dockAddItems() {
	const occupied = get(dockOccupants);
	const free = DOCK_VIEWS.filter((view) => !occupied[view.key]?.present).map((view) => {
		const title = DOCK_TITLES[view.key] ?? view.key;
		// not docked, but OPEN = it is a floating window, so this row moves it rather
		// than opening anything. Saying "＋" there would promise a second copy.
		const closer = closeStoreFor(view.key);
		const floating = !!closer && get(closer) === false;
		return {
			key: view.key,
			label: floating ? `Dock ${title}` : `＋ ${title}`,
			tooltip: floating ? `Bring the floating ${title} window into the dock` : view.tooltip,
			action: () => dockView(view.key)
		};
	});
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
 * note on that store). It is offered for EVERY tab now: the Shader editor was the one
 * view with no floating mode — no `docked` flag, no window chrome and nothing to consume
 * the arm — so this row was withheld for it rather than shipping a button that could
 * only do nothing. It has both modes since the controls rework, so the exception went
 * with it.
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
