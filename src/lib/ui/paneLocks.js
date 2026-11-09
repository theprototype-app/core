import { writable, get } from 'svelte/store';
import { safeStorage } from '../safeStorage';

// showhide-v8 (owner 2026-11-09, "allow locking sidebars", asked under Code; every window with sidebars) — a
// window's side panes can be LOCKED: their arrow handles stop hiding / showing them, a narrow window no longer folds
// them away, and their resize grips rest. The lock is per WINDOW (its key: 'code', 'explorer', 'shader', 'flow', …),
// LOCAL to this device, persisted; the handle's own menu (right-click, long-press) locks and unlocks it.

const KEY = 'paneLocks';

/** @returns {Record<string, boolean>} */
function read() {
	try {
		const v = JSON.parse((typeof localStorage !== 'undefined' && safeStorage.getItem(KEY)) || '{}');
		return v && typeof v === 'object' ? v : {};
	} catch {
		return {};
	}
}

/** window key -> locked */
export const paneLocks = writable(read());
paneLocks.subscribe((v) => {
	if (typeof localStorage !== 'undefined') safeStorage.setItem(KEY, JSON.stringify(v));
});

/** @param {string} key */
export function panesLocked(key) {
	return !!get(paneLocks)[key];
}
/** @param {string} key @param {boolean=} on */
export function togglePaneLock(key, on) {
	paneLocks.update((v) => {
		const next = { ...v };
		if (on ?? !v[key]) next[key] = true;
		else delete next[key];
		return next;
	});
}
