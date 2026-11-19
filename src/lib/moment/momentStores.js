// 95 SM1-SM3 — the moment buffer's state, as a LEAF (svelte/store + safeStorage), so the Play bar
// button, the settings row and the host component can read it without pulling the buffer (and its
// capture worker) into the boot graph. The buffer itself (momentBuffer.js) loads on the first Play.
import { writable, get } from 'svelte/store';
import { safeStorage } from '../safeStorage';

const SETTING_KEY = 'moment:record';

function readSetting() {
	try {
		return safeStorage.getItem(SETTING_KEY) !== '0';
	} catch {
		return true;
	}
}

/**
 * SM3: "Recording the last 10 s" — this device keeps a rolling 10 s of the game view while you
 * play (default ON; LOCAL, never replicated). Off = nothing is captured at all.
 * @type {import('svelte/store').Writable<boolean>}
 */
export const momentRecording = writable(readSetting());
momentRecording.subscribe((on) => {
	try {
		safeStorage.setItem(SETTING_KEY, on ? '1' : '0');
	} catch {
		/* the setting still works for this visit */
	}
});

/**
 * What the buffer is doing, published by momentBuffer.js (~2 Hz). `on` = capturing now; `reason`
 * = momentBlocker's word when it is not ('' when on); `seconds` = how much is kept.
 * @typedef {{on: boolean, reason: string, seconds: number, loaded: boolean}} MomentStatus
 * @type {import('svelte/store').Writable<MomentStatus>}
 */
export const momentStatus = writable({ on: false, reason: 'idle', seconds: 0, loaded: false });

/** the Share a moment preview is open (it freezes the buffer while it is) */
export const momentOpen = writable(false);

/** 95 SM4: the first-use hint was seen on this device */
const HINT_KEY = 'moment:hintSeen';
export function momentHintSeen() {
	try {
		return safeStorage.getItem(HINT_KEY) === '1';
	} catch {
		return true;
	}
}
export function markMomentHintSeen() {
	try {
		safeStorage.setItem(HINT_KEY, '1');
	} catch {
		/* shown again next visit — harmless */
	}
}

/** open the preview (the Play bar button, F8, a pad's Select/View button) — only while recording */
export function openMoment() {
	const s = get(momentStatus);
	if (!s.on && !get(momentOpen)) return false;
	momentOpen.set(true);
	markMomentHintSeen();
	return true;
}

/** the key and the pad button that open it (one place: the shortcut list, the tooltip, the docs) */
export const MOMENT_KEY = 'F8';
export const MOMENT_PAD_BUTTON = 'GamepadSelect';
