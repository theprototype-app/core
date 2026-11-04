// 37-hdri — the LOCAL HDRI quality preference (a fact about this device, never sent or saved
// into a scene): 'auto' follows the headset / XR / quality governor, the others pin. 72 LK2: the pins
// grew with the sky sizes; 'full' was the old name of 'standard' (1K sky, full light).
import { writable } from 'svelte/store';
import { safeStorage } from '../safeStorage';

export const HDRI_QUALITIES = ['auto', 'low', 'standard', 'high', 'max'];
const KEY = 'hdri:quality';

function initial() {
	try {
		const raw = safeStorage.getItem(KEY) ?? '';
		const v = raw === 'full' ? 'standard' : raw;
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
