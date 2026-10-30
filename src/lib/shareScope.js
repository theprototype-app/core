// Roadmap 56 C13 — THE HOST'S SHARE SCOPE, a leaf (svelte/store + safeStorage + the pure core) so the
// Connect drawer can show it without pulling the session-volume runtime into the boot graph.
// What a guest's "<HOST>'s session" volume shows: Current scene's files (the DEFAULT — never the
// whole library by default, roadmap 69) · Project · Whole library · None. Remembered on this device.
import { writable } from 'svelte/store';
import { safeStorage } from './safeStorage';
import { normalizeShareScope } from './sessionVolumeCore';

export const SHARE_SCOPE_KEY = 'session:shareScope';

/** @type {import('svelte/store').Writable<'scene'|'project'|'library'|'none'>} */
export const shareScope = writable(
	normalizeShareScope(typeof localStorage !== 'undefined' ? safeStorage.getItem(SHARE_SCOPE_KEY) : null)
);

/** @param {string} scope */
export function setShareScope(scope) {
	const next = normalizeShareScope(scope);
	shareScope.set(next);
	safeStorage.setItem(SHARE_SCOPE_KEY, next);
}
