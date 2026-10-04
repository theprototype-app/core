// 36-water — the LOCAL water quality preference (a fact about this device, never sent or
// saved into a scene). 'auto' follows the headset / phone / quality governor; the others pin.
import { writable } from 'svelte/store';
import { safeStorage } from '../safeStorage';

export const WATER_QUALITIES = ['auto', 'high', 'medium', 'low'];
const KEY = 'water:quality';

function initial() {
	try {
		const v = safeStorage.getItem(KEY) ?? '';
		return WATER_QUALITIES.includes(v) ? v : 'auto';
	} catch {
		return 'auto';
	}
}

/** @type {import('svelte/store').Writable<string>} */
export const waterQuality = writable(/** @type {string} */ (initial()));
waterQuality.subscribe((v) => {
	try {
		safeStorage.setItem(KEY, v);
	} catch {}
});
