import { tick } from 'svelte';
import { get } from 'svelte/store';
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
	objectListClose
} from '../stores/appStore';
import {
	activateDock,
	armDockMode,
	bottomDockActive,
	dockOccupants,
	visibleDockKey,
	dockShownKeys,
	dockMinimized,
	dockEmptyOpen,
	setDockEmptyOpen
} from './bottomDock';
import { phoneShell } from './ui/phoneShell.js';
import { raiseWindow, isTopVisibleWindow } from './windowFocus';
import { groupOfKey, activateTab } from './windowTabs';
import { revealWindow } from './dragWindow';
import { safeStorage } from './safeStorage';
import { sidebarTabCovered, activateSidebarTab, sidebarSideOf, collapseSideIfLast } from './sidebars';
import { HOSTED, hostedDocked } from './dockHost';

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

/** @typedef {{ key: string, openStore: any, dragKey: string | null, dockedLs: string | null, floatsByDefault?: boolean }} PanelConfig */

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
 *   dockedLs null  floating-only — there is no dock tab at all (none since 42 I6: the
 *                  object list docks as a HOSTED tab, `$lib/dockHost`, and floats by default)
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
	timeline: { key: 'timeline', openStore: timelineClose, dragKey: 'timeline', dockedLs: 'timelineDocked' },
	explorer: { key: 'explorer', openStore: explorerClose, dragKey: 'explorerWin', dockedLs: 'explorerDocked' },
	profiler: { key: 'profiler', openStore: profilerClose, dragKey: 'profilerWin', dockedLs: 'profilerDocked' },
	code: { key: 'code', openStore: codeWorkspaceClose, dragKey: 'codeWin', dockedLs: 'codeDocked' },
	objects: { key: 'objects', openStore: objectListClose, dragKey: null, dockedLs: 'objectListDocked', floatsByDefault: true }
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
	if (typeof localStorage === 'undefined') return !cfg.floatsByDefault;
	const v = safeStorage.getItem(cfg.dockedLs);
	// a never-docked panel opens in its default mode: the editors docked, the object list floating
	if (v === null) return !cfg.floatsByDefault;
	return v !== 'false';
}

/** Is this panel the one the dock is actually SHOWING? @param {PanelConfig} cfg */
function isVisibleInDock(cfg) {
	// W2: a MINIMIZED dock is showing nothing, whatever `visibleDockKey` names. Without
	// this line step 4 would read "already on screen" and CLOSE the tab the user was
	// asking to see — the button/key would dismiss a panel they cannot even find. Saying
	// no here sends them to `activateDock`, which un-minimizes, so O / N / the toolbar
	// buttons are the restore affordance a minimized dock has no strip to offer.
	if (get(dockMinimized)) return false;
	// 44 M9: either half of a split on screen is SHOWING
	return get(dockShownKeys).includes(cfg.key);
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
		// 42 I3: open + docked to a SIDE but covered by another tab of that sidebar -> bring it forward
		if (sidebarTabCovered(key)) {
			activateSidebarTab(key);
			return;
		}
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
 * dock-fixes (owner 2026-11-08) — THE SAME TREE for the hosted windows' own buttons (the AI assistant,
 * Chat: `$lib/dockHost` HOSTED, whose open stores are not the inverted booleans `PANELS` holds). The
 * report: "click AI assistant -> dock it to a sidebar -> click the AI assistant button again: the window
 * hides but its sidebar tab stays and the sidebar does not collapse when it was the only tab". The tab
 * staying was docking.js's presence test (fixed there); this is what the button does with each state:
 *
 *   closed                          -> open (it returns where it was: floating, its sidebar tab, its dock tab)
 *   a sidebar tab, covered          -> bring that tab to the front
 *   a bottom-dock tab, not showing  -> bring that tab to the front (un-minimizes the dock)
 *   otherwise                       -> close it — and a sidebar it was the LAST tab of collapses with it
 *
 * A floating window keeps the plain toggle its button always had.
 * @param {string} key a HOSTED key ('aiAssistant', 'chat', …)
 */
export function toggleHostedWindow(key) {
	const h = HOSTED[key];
	if (!h) return;
	if (!h.isOpen(get(h.store))) {
		h.open();
		return;
	}
	if (sidebarSideOf(key)) {
		if (sidebarTabCovered(key)) {
			activateSidebarTab(key);
			return;
		}
		collapseSideIfLast(key);
		h.close();
		return;
	}
	if (!get(phoneShell) && get(hostedDocked)[key] && (get(dockMinimized) || !get(dockShownKeys).includes(key))) {
		activateDock(key);
		return;
	}
	h.close();
}

/**
 * THE DOCK ITSELF, as one key (T). `togglePanel` answers for a NAMED view; this one
 * answers for the strip that holds them, which had no keyboard affordance at all.
 *
 *   showing        -> minimize. Every tab stays open and the viewport clears.
 *   minimized      -> bring it back. `dockMinimized` is deliberately NOT persisted and
 *                     a minimized dock draws no strip, so this key (and the toolbar
 *                     buttons) are the ONLY way back — it must work from every state.
 *   nothing docked -> 44 M5: open the dock EMPTY — its frame and its strip with only the
 *                     "+" (the user: "'T' only should show empty docked window view with
 *                     '+' in tab"). It used to open the last-active view docked, which read
 *                     as the dock refusing to let go of a window you had just dragged out.
 *                     Pressed again, the empty dock closes.
 *
 * The phone keeps the old empty case (open the last view docked): its "+" is the Windows
 * sheet, not a strip, so an empty frame there would hold nothing to press.
 */
export function toggleDock() {
	const showing = get(visibleDockKey);
	if (showing) {
		dockMinimized.set(!get(dockMinimized));
		return;
	}
	if (get(phoneShell)) {
		openDockView(lastDockView());
		return;
	}
	setDockEmptyOpen(!(get(dockEmptyOpen) && !get(dockMinimized)));
}

/** The view T brings back on a phone when the dock is empty: whichever tab was last active,
 * and the Node editor when that names a view this tree has never heard of. */
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
