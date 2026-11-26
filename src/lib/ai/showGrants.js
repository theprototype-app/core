// Roadmap 107 (lane 107-ui-state, PERMISSIONS) — WHAT THE PERSON HAS LET AN ASSISTANT DO ON THEIR SCREEN, as one list
// they can see and take back. A LEAF (svelte/store, safeStorage, the pure core): showTool.js keeps its page answers here,
// Settings ▸ Privacy ▸ Assistant on your screen renders the list with Revoke, and ui_state reads it for the agent.
//
// The grants are show's three first-use kinds (panel / camera / code) and nothing else: the refused surfaces (sign-in,
// account, settings, consent, publishing, connected apps, payment) are not a kind, so no answer can ever grant them.
// Lifetimes are the ones 104 shipped: Always = stored on THIS device (`show:allow:<kind>`, every trusted app);
// This time and No = this page, per app, until it reloads. Only the person's own buttons write a grant; no tool can.

import { writable } from 'svelte/store';
import { safeStorage } from '../safeStorage';
import { grantsList } from './uiStateCore.js';

/** show's first-use kinds (showCore.SHOW_KINDS; a unit test keeps the two equal, this leaf imports neither) */
export const GRANT_KINDS = /** @type {const} */ (['panel', 'camera', 'code']);

/** @param {string} kind */
export const allowKey = (kind) => 'show:allow:' + kind;

/** bumps on every change, so a list on screen re-reads */
export const grantsVersion = writable(0);
const bump = () => grantsVersion.update((n) => n + 1);

/** this page's answers, `kind\napp` -> 'session' (This time) | 'no' — a Map that tells the list when it changes */
class AnswerMap extends Map {
	/** @param {string} k @param {string} v */
	set(k, v) {
		super.set(k, v);
		bump();
		return this;
	}
	/** @param {string} k */
	delete(k) {
		const had = super.delete(k);
		if (had) bump();
		return had;
	}
	clear() {
		super.clear();
		bump();
	}
}

/** @type {Map<string, string>} */
export const sessionAnswers = new AnswerMap();

/** is this kind stored as Always on this device @param {string} kind */
export function alwaysAllowed(kind) {
	try {
		return safeStorage.getItem(allowKey(kind)) === 'always';
	} catch {
		return false;
	}
}

/** @param {string} kind @param {boolean} on */
export function setAlways(kind, on) {
	try {
		if (on) safeStorage.setItem(allowKey(kind), 'always');
		else safeStorage.removeItem(allowKey(kind));
	} catch {}
	bump();
}

/** the list, for the person's Settings rows and the agent's ui_state */
export function showGrants() {
	return grantsList([...GRANT_KINDS], alwaysAllowed, sessionAnswers.entries());
}

/**
 * Take a grant back: Always on this device and every This time for the kind (or only `app`'s). A No stays a No.
 * @param {string} kind @param {string} [app]
 */
export function revokeGrant(kind, app) {
	if (!app) setAlways(kind, false);
	for (const [key, value] of [...sessionAnswers]) {
		const [k, a] = key.split('\n');
		if (k === kind && value === 'session' && (!app || a === app)) sessionAnswers.delete(key);
	}
	bump();
}

/** take every grant back */
export function revokeAllGrants() {
	for (const kind of GRANT_KINDS) revokeGrant(kind);
}
