import { get } from 'svelte/store';
import { sidebarTabs, moveSidebarTab, keepSideOpen, toggleSidebar } from './sidebars';
import { inspectorClose } from '../stores/appStore';
import { closeDockView, canDockHere, dockTab, dockAtStrip } from './dockMenu';
import { undock } from './docking';
import { canFloatPanel } from './sidebarDrop';
import { popOutItems, popOutDockPanels, canPopOut } from './windows/panelPlaces.js';

// 43 J4 — WHAT A SIDEBAR TAB CAN DO, in one place: its × (close), its menu (right-click, a long
// press on touch) and the drops of its drag all end here, so the three cannot disagree. The tab is
// the panel's header in a sidebar (J7), so every action its window header used to offer — close,
// float, dock — is reachable from the tab.
//
// The menu follows the bottom dock's tab menu (W5/W7): it acts on the tab that was pressed, and a
// row that cannot act on this panel stays, disabled, with the reason in its tooltip — the Inspector
// (Configure Scene / Properties) lives only in a sidebar, so "Undock" and "Move to the bottom dock"
// say so rather than vanish.

/** @typedef {'left'|'right'} Side */

/** close the panel behind a sidebar tab (it leaves the sidebar; its side is remembered) @param {string} key */
export function closeSidebarTab(key) {
	keepSideOpen(key); // 44 M7: an emptied sidebar stays open with its "+"
	if (key === 'inspector') inspectorClose.set(true);
	else closeDockView(key);
}

/** take a sidebar tab out into a floating window (at x, y when a drag dropped it there) @param {string} key @param {number=} x @param {number=} y */
export function floatSidebarTab(key, x, y) {
	if (!canFloatPanel(key)) return false;
	keepSideOpen(key);
	undock(key, x, y);
	return true;
}

/** move a sidebar tab into the bottom dock (before the tab `before`, else at the end) @param {string} key @param {string|null=} before */
export function sidebarTabToDock(key, before) {
	if (key === 'inspector' || !canDockHere(key)) return false;
	keepSideOpen(key);
	undock(key);
	if (before !== undefined) dockAtStrip([key], before);
	else dockTab(key);
	return true;
}

/**
 * The tab's menu rows.
 * @param {string} key @param {Side} side @param {string} title
 * @returns {{label: string, icon?: string, tooltip: string, action: () => void, disabled?: boolean}[]}
 */
export function sidebarTabItems(key, side, title) {
	const other = side === 'left' ? 'right' : 'left';
	const others = get(sidebarTabs)[side].filter((k) => k !== key);
	const float = canFloatPanel(key);
	const dock = key !== 'inspector' && canDockHere(key);
	return [
		{ label: 'Close', icon: 'x', tooltip: `Close ${title}`, action: () => closeSidebarTab(key) },
		{
			label: 'Close others',
			icon: 'x',
			tooltip: others.length ? `Close every other tab of the ${side} sidebar` : 'This is the only tab here',
			disabled: !others.length,
			action: () => others.forEach((k) => closeSidebarTab(k))
		},
		{
			label: 'Undock into a floating window',
			icon: 'app-window',
			tooltip: float ? `Take ${title} out of the sidebar` : `${title} lives in a sidebar — it has no floating window`,
			disabled: !float,
			action: () => floatSidebarTab(key)
		},
		{
			label: `Move to the ${other} side`,
			icon: other === 'left' ? 'panel-left' : 'panel-right',
			tooltip: `Dock ${title} in the ${other} sidebar`,
			action: () => moveSidebarTab(key, other)
		},
		{
			label: 'Move to the bottom dock',
			icon: 'panel-bottom',
			tooltip: dock ? `Make ${title} a tab of the bottom dock` : `${title} has no place in the bottom dock`,
			disabled: !dock,
			action: () => sidebarTabToDock(key)
		},
		// 70 W2/W3: into a browser window of its own — this tab, or the whole sidebar as one tabbed window
		...popOutItems(key),
		...(canPopOut(key) && others.some((k) => canPopOut(k))
			? [
					{
						label: 'Pop out this sidebar',
						icon: 'external-link',
						tooltip: `Every tab of the ${side} sidebar in ONE browser window, as its tabs`,
						action: () => popOutDockPanels(get(sidebarTabs)[side].filter((k) => canPopOut(k)), side, key)
					}
				]
			: []),
		// 44 M7: the column itself — every tab stays open (its shortcut, Ctrl+B / Ctrl+Alt+B, brings it back)
		{
			label: 'Hide this sidebar',
			icon: side === 'left' ? 'panel-left-close' : 'panel-right-close',
			tooltip: `Hide the ${side} sidebar — its tabs stay open, and its shortcut (Settings ▸ Shortcuts) brings it back`,
			action: () => toggleSidebar(side, false)
		}
	];
}
