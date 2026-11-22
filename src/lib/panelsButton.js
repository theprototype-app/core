import { writable, derived, readable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';
import { phoneShell } from './ui/phoneShell.js';
import { SIDES, sidebarsWide, sidebarVisible, sidebarWanted, sidebarTabs, toggleSidebar } from './sidebars';
import { unfoldedPhone } from './deviceClass.js';
import { sidebarHandlesOn } from './sidebarHandles.js';
import { registerChromeButton } from './chromeButtons';
import { onLayoutRestore } from './uiLayoutsCore';

// dock-fixes item 8 (owner 2026-11-08) — THE PANELS BUTTON. "On a phone UNFOLDED / tablet the sidebars
// must always be reachable": Ctrl+B / Ctrl+Alt+B (44 M7) have no keyboard there. One round button in the
// top-right group, beside the profile.
//
// showhide-v8 (owner 2026-11-09): the button STAYS on the unfolded phone (the 1.64 "remove it" is cancelled), its
// press CYCLES the sides (left -> right -> none, an empty side skipped: `togglePanels`), and its "Auto" follows the
// owner's device table — shown on the unfolded phone only; a desktop and a tablet use the viewport sidebar handles
// ($lib/sidebarHandles) instead, and turning the handles on by hand hides it the same way. Customize / Settings ▸
// Interface ▸ Panels button can still add it anywhere ('on') or remove it ('off'). LOCAL (this device), persisted.

/** @typedef {'auto'|'on'|'off'} PanelsButtonMode */
const KEY = 'panelsButton';

/** @param {any} v @returns {PanelsButtonMode} */
const asMode = (v) => (v === 'on' || v === 'off' ? v : 'auto');

/** the person's choice (LOCAL, persisted): 'auto' = on for touch screens with sidebars */
export const panelsButtonMode = writable(/** @type {PanelsButtonMode} */ (asMode(typeof localStorage !== 'undefined' ? safeStorage.getItem(KEY) : null)));
panelsButtonMode.subscribe((v) => {
	if (typeof localStorage !== 'undefined') safeStorage.setItem(KEY, v);
});
// panel-gestures item 5: the mode rides the named workspace layouts (a hidden Panels button is a hidden chrome
// button, saved per layout like the rest); a layout just rewrote the key: re-read it
onLayoutRestore(() => panelsButtonMode.set(asMode(safeStorage.getItem(KEY))));

/**
 * showhide-v8 (owner 2026-11-09) — WHERE THE BUTTON IS DRAWN. "Auto" now follows the owner's device table
 * ($lib/deviceClass): shown on the UNFOLDED PHONE only; hidden on a desktop (Customize adds it) and on a tablet (the
 * viewport sidebar handles replace it). Turning the handles on by hand anywhere hides it the same way. 'on' (Customize
 * ▸ add it back, Settings ▸ On) draws it wherever sidebars exist; 'off' never.
 */
export const panelsButtonShown = derived([panelsButtonMode, unfoldedPhone, sidebarHandlesOn, sidebarsWide, phoneShell], ([$mode, $unfolded, $handles, $wide, $phone]) => {
	if ($phone || !$wide) return false;
	return $mode === 'on' || ($mode === 'auto' && $unfolded && !$handles);
});

/** is any sidebar column on screen (the button's pressed state) */
export const panelsOpen = derived(sidebarVisible, ($v) => !!($v.left || $v.right));

/**
 * showhide-v8 (owner 2026-11-09) — THE PRESS CYCLES THE SIDES: press 1 opens the LEFT side, press 2 closes it and
 * opens the RIGHT, press 3 hides all. A side with no tabs is skipped, so with only one side holding tabs the button
 * just opens and closes that side ("one sidebar by default on mobile" — drag a window to the other side and that
 * side joins the cycle). Both columns on screen (a shortcut, a wider screen): the press hides all. With no tabs
 * anywhere, the right column opens empty with its "+". Hiding keeps every tab open (44 M7 'hidden').
 */
export function togglePanels() {
	const vis = get(sidebarVisible);
	const want = get(sidebarWanted);
	const tabs = get(sidebarTabs);
	const cycle = SIDES.filter((s) => tabs[s].length > 0);
	/** @param {('left'|'right')[]} show */
	const showOnly = (show) => {
		for (const s of SIDES) if (!show.includes(s) && (vis[s] || want[s])) toggleSidebar(s, false);
		for (const s of show) if (!vis[s]) toggleSidebar(s, true);
	};
	if (!cycle.length) {
		// nothing docked anywhere: the right column, empty with its "+", or close whatever is open
		return showOnly(vis.left || vis.right ? [] : ['right']);
	}
	const showing = SIDES.filter((s) => vis[s]);
	if (!showing.length) return showOnly([cycle[0]]);
	if (showing.length > 1) return showOnly([]);
	const i = cycle.indexOf(showing[0]);
	const next = i >= 0 ? cycle[i + 1] : cycle[0];
	showOnly(next ? [next] : []);
}

/** the mode the button had before it was hidden, so Show brings back the same one @type {PanelsButtonMode|null} */
let beforeHide = null;

/** "Hide this button" (its menu) — Settings brings it back @returns {void} */
export function hidePanelsButton() {
	const m = get(panelsButtonMode);
	if (m !== 'off') beforeHide = m;
	panelsButtonMode.set('off');
}

/** "Show buttons ▸ Panels" / Customize buttons: back to the mode it had; with none known, 'auto' where auto draws it
 * (the unfolded phone with the handles off) and 'on' everywhere else (where auto would leave it hidden) */
function showPanelsButton() {
	if (get(panelsButtonMode) !== 'off') return;
	panelsButtonMode.set(beforeHide ?? (get(unfoldedPhone) && !get(sidebarHandlesOn) ? 'auto' : 'on'));
}

// panel-gestures item 5: the Panels button is one of the hideable chrome buttons. Its shown / hidden state is
// its own mode (Settings ▸ Interface ▸ Panels button keeps working), so it registers BOUND — the generic menu,
// Show buttons and Settings ▸ Customize buttons all switch that mode, and 'off' is what they read as hidden.
registerChromeButton({
	id: 'top.panels',
	kind: 'top',
	label: 'Panels',
	icon: 'columns-3',
	state: {
		hidden: derived(panelsButtonMode, ($m) => $m === 'off'),
		set: (hidden) => (hidden ? hidePanelsButton() : showPanelsButton())
	},
	menu: () => [
		{
			label: get(panelsOpen) ? 'Hide the sidebars' : 'Show the sidebars',
			icon: 'columns-3',
			tooltip: 'Show or hide both sidebars — their tabs stay open',
			action: () => togglePanels()
		}
	]
});
