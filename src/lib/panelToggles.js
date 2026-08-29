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
import { activateDock, dockOccupants, visibleDockKey, dockMinimized, FLOW_FAMILY } from './bottomDock';
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
//   4. OPEN, docked      -> the visible dock panel? hide it. Otherwise make it
//                           the visible dock tab.
//
// Only step 3's raise-before-close is new; everything else is the behaviour the
// three old handlers already had, moved here so the keys inherit it.
//
// Steps 2 and 4 can never both apply: a bottom-docked panel renders a DIFFERENT
// markup branch with no floating window at all, so its `tabbable` action is
// destroyed and `removeFromGroup` has already run (Flow.svelte / Explorer.svelte).

/** @typedef {{ key: string, openStore: any, dragKey: string | null, dockedLs: string | null, dockOnly?: boolean }} PanelConfig */

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
 * THREE SHAPES, not two:
 *   dockedLs set   remembers a mode, can be either (flow, flowcode, animation, uv,
 *                  hud, explorer)
 *   dockedLs null  floating-only — there is no dock tab at all (objects)
 *   dockOnly       DOCK-only. The ShaderEditor is the one view with no `docked` flag,
 *                  no dragWindow and no window chrome; it registers its dock occupancy
 *                  unconditionally. Saying so HERE is what stops the tree pretending it
 *                  can float: without the flag it reads as floating-only, tries to
 *                  raise a window that does not exist, and the button does nothing.
 *                  `dockMenu.dockTabItems` already withholds "Undock" for the same
 *                  reason — this is that fact, stated once more where the opening
 *                  decision is made.
 * @type {Record<string, PanelConfig>}
 */
const PANELS = {
	flow: { key: 'flow', openStore: flowGraphClose, dragKey: 'flowWin', dockedLs: 'flowDocked' },
	flowcode: { key: 'flowcode', openStore: flowCodeClose, dragKey: 'flowCode', dockedLs: 'flowCodeDocked' },
	animation: { key: 'animation', openStore: animationClose, dragKey: 'animation', dockedLs: 'animationDocked' },
	uv: { key: 'uv', openStore: uvEditorClose, dragKey: 'uv', dockedLs: 'uvDocked' },
	shader: { key: 'shader', openStore: shaderEditorClose, dragKey: null, dockedLs: null, dockOnly: true },
	hud: { key: 'hud', openStore: hudEditorClose, dragKey: 'hud', dockedLs: 'hudDocked' },
	explorer: { key: 'explorer', openStore: explorerClose, dragKey: 'explorerWin', dockedLs: 'explorerDocked' },
	objects: { key: 'objects', openStore: objectListClose, dragKey: null, dockedLs: null }
};

/** every key `togglePanel` understands, so a caller building a list of buttons cannot
 *  offer one for a panel this tree has no entry for */
export const TOGGLEABLE = Object.keys(PANELS);

// remembers which flow-family views were open when the docked group was hidden
/** @type {any} */
let flowDockSnapshot = null;

/** docked AND open (that is what dockOccupants.present means) @param {string} key */
function isDockedPresent(key) {
	return !!get(dockOccupants)[key]?.present;
}

/** Would opening this panel put it in the dock? @param {PanelConfig} cfg */
function opensDocked(cfg) {
	if (cfg.dockOnly) return true; // the dock is the ONLY place it can be
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
	const visible = get(visibleDockKey) ?? '';
	// the Node editor button owns the whole docked flow GROUP, so any flow-family
	// tab being visible counts as "the Node editor's dock is on screen"
	return cfg.key === 'flow' ? FLOW_FAMILY.includes(visible) : visible === cfg.key;
}

/** Step 1 for the Node editor: bring back the docked group we hid. @returns {boolean} did it restore */
function restoreFlowSnapshot() {
	const snap = flowDockSnapshot;
	if (!snap || !(snap.flow || snap.flowcode || snap.animation || snap.uv || snap.shader || snap.hud)) return false;
	if (snap.flow) flowGraphClose.set(false);
	if (snap.flowcode) flowCodeClose.set(false);
	if (snap.animation) animationClose.set(false);
	if (snap.uv) uvEditorClose.set(false);
	if (snap.shader) shaderEditorClose.set(false);
	if (snap.hud) hudEditorClose.set(false);
	flowDockSnapshot = null;
	activateDock('flow');
	return true;
}

/** Step 4 for the Node editor: hide only the tabs that are actually DOCKED
 * (leave undocked/floating Flow Code / Animation windows open). */
function hideDockedFlowFamily() {
	const occupants = get(dockOccupants);
	flowDockSnapshot = {
		flow: true,
		flowcode: !!occupants.flowcode?.present,
		animation: !!occupants.animation?.present,
		uv: !!occupants.uv?.present,
		shader: !!occupants.shader?.present,
		// A4: without this line the HUD tab never comes back after play mode
		hud: !!occupants.hud?.present
	};
	flowGraphClose.set(true);
	if (flowDockSnapshot.flowcode) flowCodeClose.set(true);
	if (flowDockSnapshot.animation) animationClose.set(true);
	if (flowDockSnapshot.uv) uvEditorClose.set(true);
	if (flowDockSnapshot.shader) shaderEditorClose.set(true);
	if (flowDockSnapshot.hud) hudEditorClose.set(true);
}

/** Step 1: open a closed panel in the mode it was last in. @param {PanelConfig} cfg */
function openInLastMode(cfg) {
	if (cfg.key === 'flow' && restoreFlowSnapshot()) return;
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

	// A DOCK-ONLY panel has exactly two live states — the visible tab, or a tab behind
	// another — so it skips steps 2 and 3 entirely. Reaching them would raise a window
	// that does not exist and the press would silently do nothing. Checked BEFORE the
	// occupancy test, because occupancy is registered by the panel's own $effect and is
	// therefore one flush behind a store that has just opened it.
	if (cfg.dockOnly) {
		if (!isVisibleInDock(cfg)) activateDock(key);
		else cfg.openStore.set(true);
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

	// 4. open + docked
	if (!isVisibleInDock(cfg)) {
		activateDock(key); // docked but hidden (another tab covering) -> bring it back
		return;
	}
	if (cfg.key === 'flow') hideDockedFlowFamily();
	else cfg.openStore.set(true);
}
