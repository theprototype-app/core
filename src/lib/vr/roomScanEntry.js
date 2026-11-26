// 104 D1 — Scan my room: the BOOT half (the menu rows and when they show). Everything else is in the lazy
// roomScan.js. Shown only on a headset browser that has immersive-ar: room setup data (planes with labels)
// exists on Quest; a phone has no room setup to read (corner tapping on Android is a card), and the phone
// bar never shows the row.
import { get } from 'svelte/store';
import { arTableEntry } from '../arTable.js';
import { choosePlayAs, requestPlay } from '../playMode';
import { globalRenderer } from '../../stores/sceneStore';

/** @param {string} ua */
export const headsetUA = (ua) => /OculusBrowser|Quest|Pico|Wolvic/i.test(String(ua ?? ''));

/** is the action offered here? */
export function roomScanAvailable() {
	return typeof navigator !== 'undefined' && headsetUA(navigator.userAgent) && get(arTableEntry) === 'ready';
}

export const ROOM_SCAN_TIP = 'Turns your headset’s room setup into boxes under “My room”. No camera image is used or stored.';

/** Inside a session: scan now. Outside: enter passthrough in THIS gesture (requestPlay stays synchronous), then scan. */
export function startRoomScan() {
	/** @type {any} */
	const renderer = get(globalRenderer);
	if (renderer?.xr?.getSession?.()) {
		void import('./roomScan.js').then((m) => m.scanMyRoom());
		return;
	}
	choosePlayAs('ar');
	requestPlay();
	void import('./roomScan.js').then((m) => m.scanWhenSessionStarts());
}

/** the Play button menu's row (beside the AR table rows) */
export function roomScanPlayItems() {
	if (!roomScanAvailable()) return [];
	return [{ label: 'Scan my room (passthrough)', tooltip: ROOM_SCAN_TIP, action: () => startRoomScan() }];
}
