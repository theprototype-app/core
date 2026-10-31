// 50-window (C1) — the code workspace in its OWN browser window, for a second monitor.
// 70 W2: one client of the general pop-out host ($lib/windows/panelHost), which grew out of this
// module: the same SAME-ORIGIN `about:blank` popup sharing this JS realm (every store, the Yjs
// document, the flow runtime and the save path), the mirrored styles / theme / event delegation,
// the blocked-popup toast with Try again, the main tab taking its windows with it. What stays
// Code's own: the window's name ('tp-code-popout'), its rect record ('code:popoutRect') and title
// ("Code — ThePrototype") when Code is alone in it — the host keeps those for the 'code' panel.
//
// While Code is in a pop-out window the main window's workspace is unmounted (one panel, one
// place); "Dock back" / closing the window brings it back docked or floating, as it last was.
// Desktop only — `popOutSupported` is false on a phone shell, a coarse pointer and in VR.

import { derived, get } from 'svelte/store';
import { panelAway, popOutPanel, dockPanelBack, focusPanelWindow } from './windows/panelPlaces.js';
import { popupWindow } from './windows/panelHost.js';

import { popOutSupported } from './windows/popOutSupport.js';

export { popOutSupported };

/** true while the workspace lives in a pop-out window */
export const codePoppedOut = derived(panelAway, ($away) => !!$away.code);

/**
 * Open (or focus) the code window. MUST be called from a user gesture.
 * @returns {Promise<'open' | 'focused' | 'blocked' | 'unsupported'>}
 */
export async function popOutCode() {
	if (get(codePoppedOut)) {
		focusPanelWindow('code');
		return 'focused';
	}
	if (!get(popOutSupported)) return 'unsupported';
	return popOutPanel('code') ? 'open' : get(codePoppedOut) ? 'focused' : 'blocked';
}

/** "Dock back": Code leaves its window and comes home */
export function dockCodeBack() {
	dockPanelBack('code');
}

/** raise the code window (openCode while popped, the main window's Code entry) */
export function focusCodePopout() {
	focusPanelWindow('code');
}

/** for tests / the debug hook: the live popup window Code is in, if any */
export function codePopoutWindow() {
	return popupWindow('code');
}
