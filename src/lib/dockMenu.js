import {
	flowGraphClose,
	flowCodeClose,
	animationClose,
	uvEditorClose,
	shaderEditorClose,
	hudEditorClose,
	timelineClose,
	explorerClose,
	profilerClose,
	codeWorkspaceClose,
	inspectorClose,
	inspectorKind
} from '../stores/appStore';
import { imageEditorClose } from './image/imageEditorState';
import { get, writable } from 'svelte/store';
import { activateDock, armDockMode, armDockModes, dockOccupants, dockTabs, dockStripTabs, moveDockTab, visibleDockKey, undockButtonMode, placeDockTabs, canDockFloating, splitOf, splitDock, nextSplitPartner, unsplitDock, swapSplitSides, setSplitPane, dissolveSplitOf, DOCK_KEYS, DOCK_TITLES, DOCK_ICONS, PHONE_DOCK_TABS, HOSTED_DOCK_TABS } from './bottomDock';
import { phoneShell } from './ui/phoneShell.js';
import { queueMerge, groupOfKey, activateTab, nodeOf } from './windowTabs';
import { maximizeDockTab } from './focusMode';
import { sidebarTabs, activateSidebarTab, inspectorSide } from './sidebars';
import { raiseWindow, raiseWindowNode } from './windowFocus';
import { revealWindow } from './dragWindow';
import { isAway, releasePanel, focusPanelWindow, popOutItems, popOutDockPanels, canPopOut } from './windows/panelPlaces.js';

// The dock's "+" add-a-view menu, in ONE place. The docked tab strip
// (DockTabs.svelte) and the FLOATING Node editor's header "+" (Flow.svelte) each
// kept their own copy of the same list, so a view added to one silently went
// missing from the other. Every entry puts its panel IN THE DOCK and makes it the
// visible tab — opening it when it is closed, and DOCKING it when it is already open
// as a floating window (see `dockView`); the Explorer is one of them now that it is an
// ordinary dock tab rather than the dock's separate occupant.
//
// 41 G22 replaced W5's "drop what is already docked" and the "Node editor deliberately not
// in the list" rules: the "+" ADDS AND REMOVES windows, one row per `DOCK_WINDOWS` entry (the
// registry the phone sheet reads too), docked rows marked. The floating Node editor's own "+"
// passes `exclude: ['flow']`. The occupancy is read at build time and both openers build the
// list per open, so it cannot go stale.

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
	{ key: 'timeline', tooltip: 'Sequence cutscenes: camera shots, clips, audio and events' },
	{ key: 'explorer', tooltip: 'Browse the asset library' },
	{ key: 'profiler', tooltip: 'Record frame time and draw calls, and find what draws most' },
	{ key: 'code', tooltip: 'Scripts, behaviours and graph JSON in tabs (Ctrl+S saves)' }
];

/**
 * 41 G24 — views the dock "+" menu and the phone sheet offer that are NOT toolbar roster
 * buttons (Controls builds its roster from `DOCK_VIEWS`): the Image editor works on an
 * Explorer image, so a toolbar button for it would open an empty editor.
 * @type {{key: string, tooltip: string}[]}
 */
export const DOCK_EXTRA_VIEWS = [{ key: 'imageEditor', tooltip: 'Crop, rotate, resize and adjust an Explorer image' }];

/**
 * 41 G22 — THE WINDOW REGISTRY: every window that can live in the dock, in menu order. Both
 * "+" surfaces read it — the phone's Windows sheet (`dockSheetRows`) and the desktop strip's
 * menu (`dockAddItems`) — so they can no longer disagree. They did: the sheet listed the
 * Node editor and the desktop "+" never did ("'+' missing node editor, currently it only can
 * be clicked as button"), because the desktop list was DOCK_VIEWS and the sheet prepended
 * the Node editor by hand.
 * @type {{key: string, tooltip: string}[]}
 */
export const DOCK_WINDOWS = [{ key: 'flow', tooltip: 'Wire the scene’s behaviour as nodes' }, ...DOCK_VIEWS, ...DOCK_EXTRA_VIEWS];

/**
 * 41b H1 — the PHONE's content tabs, in the same registry: rows both "+" surfaces offer only
 * while the phone posture is on (`phone: true`), because everywhere else these panels have a
 * home of their own (a side drawer, a floating window, a dialog) and are not dock views at all.
 * `$lib/phoneDock` registers how each one opens and closes (`registerDockOpener` /
 * `registerDockCloser`), since none of them has a close store a dock row could flip.
 * @type {{key: string, tooltip: string, phone: true}[]}
 */
export const PHONE_DOCK_WINDOWS = [
	{ key: 'properties', tooltip: 'The selection’s properties (what Inspect opens)', phone: true },
	{ key: 'objects', tooltip: 'Every object in the scene, as a tree', phone: true },
	{ key: 'notes', tooltip: 'The scene’s notes, grouped by label', phone: true },
	{ key: 'layouts', tooltip: 'Save and switch named workspace layouts', phone: true },
	{ key: 'scene', tooltip: 'Sky, light, physics, grid and the rest of the scene’s settings', phone: true },
	{ key: 'stats', tooltip: 'Scene budget: draw calls, triangles, textures and memory', phone: true }
];
/**
 * 42 I6 — the floating windows the dock HOSTS on a wider screen ($lib/dockHost): the "+" offers
 * them there (on a phone the Objects list is already a phone row above, the others float).
 * @type {{key: string, tooltip: string}[]}
 */
export const HOSTED_DOCK_WINDOWS = [
	{ key: 'objects', tooltip: 'Every object in the scene, as a tree' },
	{ key: 'stats', tooltip: 'Scene budget: draw calls, triangles, textures and memory' },
	{ key: 'profilerLive', tooltip: 'Frame time as it happens, this peer or one you watch' },
	{ key: 'chat', tooltip: 'Talk to the people in this session' },
	{ key: 'aiAssistant', tooltip: 'Ask the AI assistant to build or change the scene' },
	{ key: 'assets', tooltip: 'Free CC0 models, skies and materials from Poly Haven and ambientCG' }
];
/** the registry rows for the posture we are in @returns {{key: string, tooltip: string}[]} */
function windowsHere() {
	return get(phoneShell) ? [...DOCK_WINDOWS, ...PHONE_DOCK_WINDOWS] : [...DOCK_WINDOWS, ...HOSTED_DOCK_WINDOWS];
}

/**
 * 42 I6 — is a view OPEN when no close store can say (the hosted windows: their open state is
 * a `''|'hidden'` class, a positive flag, …)? $lib/dockHost registers each.
 * @type {Record<string, () => boolean>}
 */
const dockOpenStates = {};
/** @param {string} key @param {() => boolean} fn @returns {() => void} unregister */
export function registerDockOpenState(key, fn) {
	dockOpenStates[key] = fn;
	return () => {
		if (dockOpenStates[key] === fn) delete dockOpenStates[key];
	};
}
/** open as a floating window or a tab — whatever its close store or open-state says @param {string} key */
function viewOpen(key) {
	const closer = closeStoreFor(key);
	if (closer) return get(closer) === false;
	return !!dockOpenStates[key]?.();
}

/**
 * 42 I6 — can this FLOATING window become a dock tab here? Every view with a docked branch,
 * and a hosted window on a wider screen (on a phone the dock hosts only its own content tabs,
 * so the hosted windows keep floating there). The one predicate 41 G7's drop code asks.
 * @param {string} key
 */
export function canDockHere(key) {
	if (!canDockFloating(key)) return false;
	return !(HOSTED_DOCK_TABS.includes(key) && get(phoneShell));
}

/**
 * 42 I6 — can this dock TAB be taken out into a floating window? Every view with a floating
 * mode can; a phone content tab cannot (its wider-screen home is a drawer or a dialog) —
 * except a hosted window (the Objects list) on a wider screen, which is a floating window there.
 * @param {string} key
 */
export function canUndockTab(key) {
	if (!PHONE_DOCK_TABS.includes(key)) return true;
	return HOSTED_DOCK_TABS.includes(key) && !get(phoneShell);
}

/**
 * 41b H1 — how a dock key OPENS when its close store cannot say (the phone content tabs). The
 * opener puts the panel in the dock and shows it; `dockView` calls it instead of arming a mode.
 * @type {Record<string, () => void>}
 */
const dockOpeners = {};
/** @param {string} key @param {() => void} fn @returns {() => void} unregister */
export function registerDockOpener(key, fn) {
	dockOpeners[key] = fn;
	return () => {
		if (dockOpeners[key] === fn) delete dockOpeners[key];
	};
}

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
	// 70 W4: one panel, one place — a panel in a pop-out window comes home to be docked here
	releasePanel(key);
	if (dockOpeners[key]) {
		dockOpeners[key]();
		return;
	}
	armDockMode(key, true);
	closeStoreFor(key)?.set(false);
	activateDock(key);
}

/**
 * 44 M5 — WHERE IS THIS WINDOW OPEN? The one question every "+" menu asks before it acts:
 * 'dock' (a bottom-dock tab), 'left' / 'right' (a sidebar tab), 'floating' (its own window, or a
 * floating tab group's member), or null (closed). A sidebar tab is asked first, because a window
 * docked to a side is ALSO open by its close store and would otherwise read as floating — which
 * is how "+" ▸ Statistics put a second Statistics in the dock while the first sat in a sidebar.
 * 70 W2: 'window' — it is in a pop-out window.
 * @param {string} key @returns {'dock'|'left'|'right'|'floating'|'window'|null}
 */
export function windowWhere(key) {
	if (isAway(key)) return 'window';
	const tabs = get(sidebarTabs);
	if (tabs.left.includes(key)) return 'left';
	if (tabs.right.includes(key)) return 'right';
	if (get(dockOccupants)[key]?.present) return 'dock';
	return viewOpen(key) ? 'floating' : null;
}

/** where a floating editor window remembers its rect (dragWindow's key), for the reveal */
const FLOAT_DRAG_KEYS = /** @type {Record<string, string>} */ ({
	flow: 'flowWin',
	flowcode: 'flowCode',
	animation: 'animation',
	uv: 'uv',
	shader: 'shader',
	hud: 'hud',
	timeline: 'timeline',
	explorer: 'explorerWin',
	profiler: 'profilerWin',
	code: 'codeWin'
});

/**
 * 44 M5 — bring an OPEN window to the front WHERE IT IS: its dock tab, its sidebar tab, or its
 * floating window (its group's tab first, then raised and pulled fully back on screen). Nothing
 * moves and nothing is opened twice. False when it is not open anywhere.
 * @param {string} key
 */
export function focusWindow(key) {
	const where = windowWhere(key);
	if (!where) return false;
	if (where === 'window') return focusPanelWindow(key);
	if (where === 'dock') activateDock(key);
	else if (where === 'left' || where === 'right') activateSidebarTab(key);
	else {
		const group = groupOfKey(key);
		if (group && group.active !== key) activateTab(group.id, key);
		if (FLOAT_DRAG_KEYS[key]) revealWindow(FLOAT_DRAG_KEYS[key]);
		if (!raiseWindow(key)) raiseWindowNode(nodeOf(key));
	}
	return true;
}

/** the words for where a window is, in a row's hint @param {'dock'|'left'|'right'|'floating'|'window'} where */
function whereHint(where) {
	return where === 'dock' ? 'In dock' : where === 'floating' ? 'Floating' : where === 'window' ? 'In a window' : where === 'left' ? 'Left sidebar' : 'Right sidebar';
}

/**
 * 44 M7 — open a CLOSED window as a tab of a sidebar column (the sidebar's own "+"). Its side is
 * written first (docking.js remembers it for a window that is not mounted yet), then it opens in
 * its floating mode, which is the mode a side column takes. Where the side column cannot take it
 * (a touch screen keeps windows out of the columns today), it simply opens as it would anywhere.
 * @param {string} key @param {'left'|'right'} side
 */
function openInSide(key, side) {
	releasePanel(key); // 70 W4: out of its pop-out window, into this column
	const sided = moveToSidebar(key, side);
	if (floatOpeners[key]) floatOpeners[key]();
	else {
		armDockMode(key, false);
		closeStoreFor(key)?.set(false);
	}
	if (!sided) return;
	// the window reports itself a member as it mounts; bring it to the front once it has
	queueMicrotask(() => activateSidebarTab(key));
}

/**
 * 44 M7 — how a window with no close store of its own opens FLOATING (a hosted window: Objects,
 * Statistics, …): $lib/dockHost registers each, since this module may not import it.
 * @type {Record<string, () => void>}
 */
const floatOpeners = {};
/** @param {string} key @param {() => void} fn @returns {() => void} unregister */
export function registerFloatOpener(key, fn) {
	floatOpeners[key] = fn;
	return () => {
		if (floatOpeners[key] === fn) delete floatOpeners[key];
	};
}

/**
 * 44 M7 — the Configure Scene row a sidebar "+" offers: the Inspector lives only in the sidebars.
 * Open (as Configure Scene) it is focused where it is; open as Properties it swaps to the scene in
 * place (one panel, two kinds); closed it opens on THIS side.
 * @param {'left'|'right'} side
 */
function sceneRow(side) {
	const open = !get(inspectorClose);
	const isScene = open && get(inspectorKind) === 'scene';
	const tabs = get(sidebarTabs);
	const at = tabs.left.includes('inspector') ? 'left' : tabs.right.includes('inspector') ? 'right' : null;
	const title = 'Configure Scene';
	const icon = 'sun';
	if (isScene && at)
		return { key: 'scene', label: title, icon, hint: whereHint(at), checked: true, multiPick: true, tooltip: `${title} is open in the ${at} sidebar — click to show it there`, action: () => activateSidebarTab('inspector') };
	return {
		key: 'scene',
		label: title,
		icon,
		hint: open ? 'Show' : 'Open',
		checked: false,
		multiPick: true,
		tooltip: 'Sky, light, physics, grid and the rest of the scene’s settings',
		action: () => {
			if (!open) inspectorSide.set(side);
			inspectorKind.set('scene');
			inspectorClose.set(false);
			queueMicrotask(() => activateSidebarTab('inspector'));
		}
	};
}

/**
 * 41 G22 + 44 M5/M7 — THE "+" MENU, every one of them: the dock strip's, a sidebar's, the
 * floating Node editor's header. One row per registry window (`DOCK_WINDOWS` + the hosted ones),
 * and ONE RULE for a row (44 M5, the user: "'+' ▸ Statistics while Statistics lives in a sidebar
 * must focus that sidebar tab, not open a second copy"): a window that is OPEN ANYWHERE — the
 * dock, a sidebar, floating — is checked, its hint says where, and its row brings it to the front
 * THERE (`focusWindow`). Only a CLOSED window opens, and it opens into the "+" that was pressed:
 * the dock for the dock's, that side's column for a sidebar's.
 *
 * Every row is `multiPick` (44 M8): Ctrl-click (Cmd on a Mac) or Shift-click runs it and keeps
 * the menu up for the next pick (ContextMenu); a plain click picks one and closes.
 * @param {{target?: 'dock'|'left'|'right', exclude?: string[]}} [options]
 * @returns {{key: string, label: string, tooltip: string, icon: string, hint: string, checked: boolean, multiPick: true, action: () => void}[]}
 */
export function addWindowItems({ target = 'dock', exclude = [] } = {}) {
	const side = target === 'left' || target === 'right' ? target : null;
	/** @type {any[]} */
	const rows = [];
	if (side && !exclude.includes('scene')) rows.push(sceneRow(side));
	for (const view of windowsHere()) {
		if (exclude.includes(view.key)) continue;
		const title = DOCK_TITLES[view.key] ?? view.key;
		const icon = DOCK_ICONS[view.key] ?? 'app-window';
		const where = windowWhere(view.key);
		const open = side && canDockFloating(view.key) ? () => openInSide(view.key, side) : () => dockView(view.key);
		// 70 W4: one panel, one place — a "+" here brings a panel out of its pop-out window, here
		if (where === 'window') {
			rows.push({ key: view.key, label: title, icon, hint: whereHint(where), checked: true, multiPick: true, tooltip: `${title} is in a pop-out window — click to bring it here`, action: open });
			continue;
		}
		if (where) {
			const place = where === 'dock' ? 'the dock' : where === 'floating' ? 'a floating window' : `the ${where} sidebar`;
			rows.push({ key: view.key, label: title, icon, hint: whereHint(where), checked: true, multiPick: true, tooltip: `${title} is open in ${place} — click to show it there`, action: () => focusWindow(view.key) });
			continue;
		}
		rows.push({ key: view.key, label: title, icon, hint: 'Open', checked: false, multiPick: true, tooltip: view.tooltip, action: open });
	}
	return rows;
}

/**
 * 44 M8 — WHERE THE DOCK'S "+" MENU IS OPEN (null = closed). Every docked panel draws its own strip
 * (DockTabs), and the empty dock's strip unmounts the moment a window docks — so a menu owned by the
 * strip died on the first Ctrl-pick there. The strips only SET this; one always-mounted renderer
 * (PhoneDockHost) draws the menu, so it outlives whichever strip opened it.
 * 44 M9: `pane` names a split pair (its left key) whose EMPTY right pane opened the menu — a pick
 * there fills that pane.
 * @type {import('svelte/store').Writable<{x: number, y: number, pane?: string}|null>}
 */
export const dockAddMenuAt = writable(/** @type {{x: number, y: number, pane?: string}|null} */ (null));

/**
 * 44 M8 — rebuild a "+" menu's rows after a multi-pick: now, and once more when the picked window
 * has settled (a window opened into a sidebar joins its column as it MOUNTS, a frame or two later —
 * read at once its row would still say "Floating").
 * @param {() => void} rebuild
 */
export function rebuildAfterPick(rebuild) {
	rebuild();
	setTimeout(rebuild, 450);
}

/** the bottom dock's "+" (and the floating Node editor's, which passes `exclude: ['flow']`)
 * 44 M9: `pane` = a split's left key whose EMPTY right pane asked — a window that opens into the
 * dock, or is already a dock tab, fills that pane (one open elsewhere is still focused there, M5).
 * @param {{exclude?: string[], pane?: string}} [options] */
export function dockAddItems({ exclude = [], pane } = {}) {
	const rows = addWindowItems({ target: 'dock', exclude });
	if (!pane) return rows;
	return rows.map((row) => {
		const where = windowWhere(row.key);
		if (!DOCK_KEYS.includes(row.key) || (where && where !== 'dock') || row.key === pane) return row;
		const run = row.action;
		return {
			...row,
			action: () => {
				const pair = splitOf(pane);
				if (pair && !pair.b) setSplitPane(pane, 'b', row.key);
				run();
				if (where === 'dock') activateDock(row.key);
			}
		};
	});
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
 * @returns {{label: string, tooltip: string, action?: () => void, danger?: boolean, disabled?: boolean, children?: any[]}[]}
 */
export function dockTabItems(key) {
	const title = DOCK_TITLES[key] ?? 'this view';
	/** @type {{label: string, tooltip: string, action?: () => void, danger?: boolean, disabled?: boolean, children?: any[]}[]} */
	const items = [];
	// 44 M9 — the split rows (decision: Split right / Unsplit / Swap sides); wider screens only
	if (!get(phoneShell)) {
		const pair = splitOf(key);
		if (pair) {
			const names = `${DOCK_TITLES[pair.a] ?? pair.a} / ${pair.b ? (DOCK_TITLES[pair.b] ?? pair.b) : 'the empty pane'}`;
			items.push({ label: 'Swap sides', tooltip: `Swap the two halves of ${names}`, disabled: !pair.b, action: () => swapSplitSides(key) });
			items.push({ label: 'Unsplit', tooltip: `Show ${names} as two tabs again`, action: () => unsplitDock(key) });
		} else {
			const next = nextSplitPartner(key);
			items.push({
				label: 'Split right',
				tooltip: next ? `Show ${title} and ${DOCK_TITLES[next]} side by side` : `Show ${title} beside an empty pane (pick its window with "+")`,
				action: () => splitDock(key, next)
			});
			const others = get(dockStripTabs).filter((t) => !t.pair && t.key !== key);
			if (others.length > 1)
				items.push({
					label: 'Split with',
					tooltip: `Pick the view to show beside ${title}`,
					children: others.map((t) => ({ label: t.title, icon: t.icon, tooltip: `${title} on the left, ${t.title} on the right`, action: () => splitDock(key, t.key) }))
				});
		}
	}
	// the strip's ENTRIES (a split pair is one entry and moves as one)
	const present = get(dockStripTabs).map((t) => t.key);
	const pairOf = splitOf(key);
	const at = present.indexOf(key) >= 0 ? present.indexOf(key) : pairOf ? present.indexOf(pairOf.a) : -1;
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
	// 41b H1: a phone content tab has no floating window to undock into (it is a tab only on
	// the phone, and its wider-screen home is a side drawer or a dialog) — 42 I6: a hosted
	// window docked on a wider screen does (`canUndockTab`)
	if (canUndockTab(key))
		items.push({
			label: 'Undock into a floating window',
			tooltip: `Take ${title} out of the dock`,
			action: () => armDockMode(key, false)
		});
	// 43 J4: any dock tab can move into a sidebar column on a wider screen (the phone has none). 44 M2:
	// a touch screen wider than a phone (the unfolded N6) too — docking.js no longer stands down there
	if (!get(phoneShell) && canDockFloating(key) && sideMover)
		for (const side of /** @type {const} */ (['left', 'right']))
			items.push({
				label: `Move to the ${side} sidebar`,
				tooltip: `Dock ${title} in the ${side} sidebar, as one of its tabs`,
				action: () => moveToSidebar(key, side)
			});
	// 70 W2/W3: into a browser window of its own (desktop) — this tab, or the whole dock as one tabbed window
	items.push(...popOutItems(key));
	if (canPopOut(key)) {
		const all = get(dockTabs).map((t) => t.key).filter((k) => canPopOut(k));
		if (all.length > 1)
			items.push({
				label: 'Pop out the whole dock',
				tooltip: `Every tab of the bottom dock in ONE browser window, as its tabs`,
				action: () => popOutDockPanels(all, 'bottom', key)
			});
	}
	// 42 I14: focus mode's touch/pointer way in for a docked window — the tab fills the window
	items.push({
		label: 'Maximize (focus mode)',
		tooltip: `Show ${title} alone, filling the window — Esc, Ctrl+Space or "Exit focus" restores`,
		action: () => maximizeDockTab(key)
	});
	items.push({
		label: 'Close',
		tooltip: `Close ${title} (it leaves the dock; nothing else is touched)`,
		action: () => closeDockView(key)
	});
	return items;
}

/**
 * 43 J4 — how a dock tab moves to a SIDEBAR column: docking.js registers `dockToSide` (it reaches
 * this module through bottomDockDrop, so the seam runs this way round).
 * @type {((key: string, side: 'left'|'right') => boolean) | null}
 */
let sideMover = null;
/** @param {((key: string, side: 'left'|'right') => boolean) | null} fn */
export function registerSideMover(fn) {
	sideMover = fn;
}
/** is the sidebar seam wired? (docking.js registers it at load) */
export function canMoveToSidebar() {
	return !!sideMover;
}
/** move a window into a sidebar column (false: it cannot live there) @param {string} key @param {'left'|'right'} side */
export function moveToSidebar(key, side) {
	releasePanel(key); // 70 W4: out of its pop-out window first
	return !!sideMover?.(key, side);
}

/**
 * 40 F8 — closing a DOCKED view is its tab's ✕ (or the tab menu's Close) now; the docked
 * header carries no ✕ of its own. A view whose close must ASK first (the code workspace
 * with unsaved tabs) registers its own closer here, so the tab ✕ takes the same path its
 * header ✕ used to.
 * @type {Record<string, () => void>}
 */
const dockClosers = {};
/** @param {string} key @param {() => void} fn @returns {() => void} unregister */
export function registerDockCloser(key, fn) {
	dockClosers[key] = fn;
	return () => {
		if (dockClosers[key] === fn) delete dockClosers[key];
	};
}
/** @param {string} key */
export function closeDockView(key) {
	// 44 M9: closing a split member from the strip / tab menu ends its split
	dissolveSplitOf(key);
	if (dockClosers[key]) dockClosers[key]();
	else closeStoreFor(key)?.set(true);
}

/**
 * 40 F8 — the dock's undock button (left of "minimize the dock"). By default it takes the
 * ACTIVE tab out into a floating window; with Settings ▸ Interface ▸ Windows & chrome ▸
 * "Undock button: all as one tabbed group" it takes every docked tab out as ONE floating
 * window with a tab per view (the first tab is the window the others join).
 * @param {'active'|'group'=} mode defaults to the setting
 */
export function undockFromDock(mode) {
	const how = mode ?? get(undockButtonMode);
	if (how === 'group') {
		const keys = get(dockTabs).map((t) => t.key).filter((k) => canUndockTab(k));
		if (!keys.length) return;
		armDockModes(keys, false);
		for (const key of keys.slice(1)) queueMerge(keys[0], key);
		return;
	}
	const key = get(visibleDockKey);
	if (key && canUndockTab(key)) armDockMode(key, false);
}

/**
 * 40 F8 — a floating tab group's dock button (left of "close all tabs") docks ALL of its
 * tabs. 42 I6: Objects, Chat and the AI window dock too now (hosted); a window with no dock
 * tab at all (a file preview) stays floating.
 * @param {string[]} members @param {string=} active the tab to show once docked
 * @returns {number} how many were docked
 */
export function dockAllOf(members, active) {
	const keys = members.filter((k) => canDockHere(k));
	if (!keys.length) return 0;
	armDockModes(keys, true);
	activateDock(active && keys.includes(active) ? active : keys[0]);
	return keys.length;
}

/**
 * 41 G6 — "Dock this tab" (a floating group tab's long-press / right-click menu): that ONE
 * view goes to the bottom dock and is shown; the rest of its group stays floating (the
 * member leaves the group as its floating node unmounts — a hosted window leaves it
 * explicitly, $lib/dockHost). False for a window with no dock tab (a file preview).
 * @param {string} key
 */
export function dockTab(key) {
	if (!canDockHere(key)) return false;
	dockView(key);
	return true;
}

/**
 * 48 F5 — a floating window dropped onto a PANE of the split on screen docks and shows IN that pane — the
 * rule a tab dragged onto a pane already follows (setSplitPane: the view it replaces stays docked as a tab).
 * @param {string} key @param {{pair: string, pane: 'a'|'b'}} pane
 * @returns {boolean} whether it docked
 */
export function dockIntoPane(key, pane) {
	if (!canDockHere(key)) return false;
	dockView(key);
	setSplitPane(pane.pair, pane.pane, key);
	activateDock(key);
	return true;
}

/**
 * 41 G7 — floating window(s) dropped on the docked tab strip: they dock at the caret
 * (before `before`, or at the end of the present tabs), the first one shown. Views with
 * no docked mode are skipped (they stay floating).
 * @param {string[]} keys @param {string|null} before
 * @returns {number} how many were docked
 */
export function dockAtStrip(keys, before) {
	const docking = keys.filter((k) => canDockHere(k));
	if (!docking.length) return 0;
	placeDockTabs(docking, before);
	if (docking.length === 1) armDockMode(docking[0], true);
	else armDockModes(docking, true);
	activateDock(docking[0]);
	return docking.length;
}

/**
 * 40 F10 — a docked tab dropped onto/into a floating window joins it as a TAB.
 * @param {string} key the docked view @param {string} targetKey the floating window
 */
export function undockInto(key, targetKey) {
	armDockMode(key, false);
	queueMerge(targetKey, key);
}

/**
 * 40 F9 — the phone's "+" sheet: EVERY window (the Node editor too), with whether it is
 * open. Toggling one on opens it in the dock and shows it; off closes it.
 * @returns {{key: string, title: string, tooltip: string, open: boolean}[]}
 */
export function dockSheetRows() {
	const occupied = get(dockOccupants);
	return windowsHere().map((view) => {
		return {
			key: view.key,
			title: DOCK_TITLES[view.key] ?? view.key,
			tooltip: view.tooltip,
			open: !!occupied[view.key]?.present || viewOpen(view.key)
		};
	});
}
/** @param {string} key @param {boolean} on */
export function setDockViewShown(key, on) {
	if (on) dockView(key);
	else closeDockView(key);
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
	timeline: timelineClose,
	explorer: explorerClose,
	profiler: profilerClose,
	code: codeWorkspaceClose,
	imageEditor: /** @type {any} */ (imageEditorClose)
};

/** @param {string} key @returns {import('svelte/store').Writable<boolean>|null} */
export function closeStoreFor(key) {
	return DOCK_CLOSERS[key] ?? null;
}
