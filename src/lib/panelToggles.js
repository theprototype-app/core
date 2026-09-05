import { tick } from 'svelte';
import { get } from 'svelte/store';
import {
	flowGraphClose,
	flowCodeClose,
	animationClose,
	uvEditorClose,
	shaderEditorClose,
	hudEditorClose,
	explorerClose,
	objectListClose
} from '../stores/appStore';
import {
	activateDock,
	armDockMode,
	bottomDockActive,
	dockOccupants,
	visibleDockKey,
	dockMinimized
} from './bottomDock';
import { raiseWindow, isTopVisibleWindow } from './windowFocus';
import { groupOfKey, activateTab } from './windowTabs';
import { revealWindow } from './dragWindow';

// ONE decision tree for the Controls panel buttons AND their keyboard shortcuts
// (O / N). Before this module the Object list button had taskbar semantics
// (open -> raise -> close) while the Node editor and Explorer buttons plain-toggled,
// and the O/N keys bypassed the buttons entirely with a bare store flip — three
// behaviours for one gesture. The tree, in order:
//
//   1. CLOSED            -> open in its last mode (docked tab / floating window).
//   2. OPEN, tab group   -> not the active tab? activate it and raise.
//   3. OPEN, floating    -> already the top VISIBLE window? close it. Otherwise
//                           raise it: a buried window is "called", not dismissed.
//   4. OPEN, docked      -> the visible dock TAB? close that tab. Otherwise make it
//                           the visible dock tab.
//
// Only step 3's raise-before-close is new; everything else is the behaviour the
// three old handlers already had, moved here so the keys inherit it.
//
// ONE KEY, ONE TAB. Step 4 used to be a per-panel exception for the Node editor: N
// owned the whole docked FLOW FAMILY, so `isVisibleInDock('flow')` answered yes when
// any of Flow Code / Animation / UV / Shader / HUD was showing and the hide closed
// every one of them (snapshotted, to be restored by the next N). Reported as "N should
// not close other tabs — for some reason only the Explorer stays", which is exactly
// what a flow-family sweep leaves behind. The group gesture was written when the dock
// held ONE panel at a time and a family member could only be reached by hiding its
// siblings; the dock has been a tab strip since #183, and T is the gesture for the
// strip as a whole. So the family case, its snapshot and the restore are gone: every
// key answers for its OWN tab and nothing else, which is also what makes this a tree
// with no per-panel branches left in it.
//
// Steps 2 and 4 can never both apply: a bottom-docked panel renders a DIFFERENT
// markup branch with no floating window at all, so its `tabbable` action is
// destroyed and `removeFromGroup` has already run (Flow.svelte / Explorer.svelte).

/** @typedef {{ key: string, openStore: any, dragKey: string | null, dockedLs: string | null }} PanelConfig */

/**
 * EVERY panel a toolbar button or a shortcut can ask for. `openStore` is inverted
 * (true = closed) throughout the app. `dragKey` is the dragWindow key of the FLOATING
 * window (null when there is no floating window to reveal). `dockedLs` is the
 * localStorage flag remembering the panel's last mode.
 *
 * W8b widened this map from three entries to all eight. The tree below was ALREADY the
 * whole decision — closed / tab group / floating / docked — it just had nothing but the
 * Node editor, the Explorer and the object list wired into it, so the five other dock
 * views could only be reached through the "+" list, which always opens them docked and
 * can never hide one again. ONE tree for every panel, whatever opens it, is the point:
 * a roster button for the Animation tab now behaves exactly as the Node editor button
 * does, including the raise-a-buried-window rule and the mode memory.
 *
 * TWO SHAPES:
 *   dockedLs set   remembers a mode, can be either (flow, flowcode, animation, uv,
 *                  shader, hud, explorer)
 *   dockedLs null  floating-only — there is no dock tab at all (objects)
 *
 * There was a THIRD, `dockOnly`, for the Shader editor alone: it was the one view with
 * no `docked` flag, no dragWindow and no window chrome, so it registered its dock
 * occupancy unconditionally and the tree had to be told it could never float. It has
 * both modes now, so the shape is gone from here and the matching "Undock" exception is
 * gone from `dockMenu.dockTabItems`.
 * @type {Record<string, PanelConfig>}
 */
const PANELS = {
	flow: { key: 'flow', openStore: flowGraphClose, dragKey: 'flowWin', dockedLs: 'flowDocked' },
	flowcode: { key: 'flowcode', openStore: flowCodeClose, dragKey: 'flowCode', dockedLs: 'flowCodeDocked' },
	animation: { key: 'animation', openStore: animationClose, dragKey: 'animation', dockedLs: 'animationDocked' },
	uv: { key: 'uv', openStore: uvEditorClose, dragKey: 'uv', dockedLs: 'uvDocked' },
	shader: { key: 'shader', openStore: shaderEditorClose, dragKey: 'shader', dockedLs: 'shaderDocked' },
	hud: { key: 'hud', openStore: hudEditorClose, dragKey: 'hud', dockedLs: 'hudDocked' },
	explorer: { key: 'explorer', openStore: explorerClose, dragKey: 'explorerWin', dockedLs: 'explorerDocked' },
	objects: { key: 'objects', openStore: objectListClose, dragKey: null, dockedLs: null }
};

/** every key `togglePanel` understands, so a caller building a list of buttons cannot
 *  offer one for a panel this tree has no entry for */
export const TOGGLEABLE = Object.keys(PANELS);

/** docked AND open (that is what dockOccupants.present means) @param {string} key */
function isDockedPresent(key) {
	return !!get(dockOccupants)[key]?.present;
}

/** Would opening this panel put it in the dock? @param {PanelConfig} cfg */
function opensDocked(cfg) {
	if (!cfg.dockedLs) return false; // floating-only panel
	return typeof localStorage === 'undefined' || localStorage.getItem(cfg.dockedLs) !== 'false';
}

/** Is this panel the one the dock is actually SHOWING? @param {PanelConfig} cfg */
function isVisibleInDock(cfg) {
	// W2: a MINIMIZED dock is showing nothing, whatever `visibleDockKey` names. Without
	// this line step 4 would read "already on screen" and CLOSE the tab the user was
	// asking to see — the button/key would dismiss a panel they cannot even find. Saying
	// no here sends them to `activateDock`, which un-minimizes, so O / N / the toolbar
	// buttons are the restore affordance a minimized dock has no strip to offer.
	if (get(dockMinimized)) return false;
	return get(visibleDockKey) === cfg.key;
}

/** Step 1: open a closed panel in the mode it was last in. @param {PanelConfig} cfg */
function openInLastMode(cfg) {
	cfg.openStore.set(false);
	if (opensDocked(cfg)) {
		activateDock(cfg.key); // docked -> show as the dock tab
		return;
	}
	// floating: the window only mounts once the store says open, so both the
	// reveal (pull it fully back on screen) and the raise wait for that flush
	tick().then(() => {
		if (cfg.dragKey) revealWindow(cfg.dragKey);
		raiseWindow(cfg.key);
	});
}

/**
 * The Controls toolbar button / keyboard shortcut for one panel.
 * @param {string} key 'flow' | 'explorer' | 'objects'
 */
export function togglePanel(key) {
	const cfg = PANELS[key];
	if (!cfg) return;

	// 1. closed -> open in its last mode
	if (get(cfg.openStore)) {
		openInLastMode(cfg);
		return;
	}

	if (!isDockedPresent(key)) {
		// 2. open + a member of a tab group that is showing a SIBLING tab
		const group = groupOfKey(key);
		if (group && group.active !== key) {
			activateTab(group.id, key);
			raiseWindow(key);
			return;
		}
		// 3. open + floating: close it only when it is already on top; a buried
		// window is raised instead (closing what the user cannot see is a trap)
		if (isTopVisibleWindow(key)) cfg.openStore.set(true);
		else raiseWindow(key);
		return;
	}

	// 4. open + docked. Closing this ONE tab; every other tab in the strip stays open
	// and `visibleDockKey`'s fallback promotes whichever is next, so the dock only goes
	// away when this was its last tab.
	if (!isVisibleInDock(cfg)) {
		activateDock(key); // docked but hidden (another tab covering) -> bring it back
		return;
	}
	cfg.openStore.set(true);
}

/**
 * THE DOCK ITSELF, as one key (T). `togglePanel` answers for a NAMED view; this one
 * answers for the strip that holds them, which had no keyboard affordance at all.
 *
 * Three states, and the third is the reason it is not a one-line `dockMinimized`
 * flip:
 *
 *   showing        -> minimize. Every tab stays open and the viewport clears.
 *   minimized      -> bring it back. `dockMinimized` is deliberately NOT persisted and
 *                     a minimized dock draws no strip, so this key (and the toolbar
 *                     buttons) are the ONLY way back — it must work from every state.
 *   nothing docked -> open the last-active view DOCKED, so the key still does
 *                     something from a clean state instead of reading as broken.
 *
 * The empty case asks through `armDockMode` rather than writing the panel's
 * localStorage flag: a panel's `docked` is component-local `$state` read ONCE at mount,
 * so an outside write is measurably inert at a live panel (the note on that store).
 * That also means T genuinely DOCKS a view whose remembered mode is floating, which is
 * what "show the dock" has to mean when the dock is empty because everything floated
 * out of it.
 */
export function toggleDock() {
	const showing = get(visibleDockKey);
	if (get(dockMinimized)) {
		// A minimized dock with nothing left in it would come back EMPTY — indis-
		// tinguishable from the key doing nothing — so that falls through to the open
		// path below (`activateDock` clears the minimize on its way).
		if (showing) {
			dockMinimized.set(false);
			return;
		}
	} else if (showing) {
		dockMinimized.set(true);
		return;
	}
	openDockView(lastDockView());
}

/** The view T brings back when the dock is empty: whichever tab was last active, and
 * the Node editor when that names a view this tree has never heard of (a key written by
 * an older or newer release, or one that has since left DOCK_FAMILY). */
function lastDockView() {
	const key = get(bottomDockActive);
	return PANELS[key] && key !== 'objects' ? key : 'flow';
}

/** Open one view AS A DOCK TAB, whatever mode it last remembered. @param {string} key */
function openDockView(key) {
	const cfg = PANELS[key];
	if (!cfg) return;
	armDockMode(key, true); // the panel owns its own mode — ask, never write the flag
	cfg.openStore.set(false);
	activateDock(key);
}
