// 37-hdri — the LOCAL HDRI quality preference (a fact about this device, never sent or saved
// into a scene): 'auto' follows the headset / XR / quality governor, 'full' and 'low' pin.
import { writable } from 'svelte/store';
import { safeStorage } from '../safeStorage';

export const HDRI_QUALITIES = ['auto', 'full', 'low'];
const KEY = 'hdri:quality';

function initial() {
	try {
		const v = safeStorage.getItem(KEY) ?? '';
		return HDRI_QUALITIES.includes(v) ? v : 'auto';
	} catch {
		return 'auto';
	}
}

/** @type {import('svelte/store').Writable<string>} */
export const hdriQuality = writable(/** @type {string} */ (initial()));
hdriQuality.subscribe((v) => {
	try {
		safeStorage.setItem(KEY, v);
	} catch {}
});
