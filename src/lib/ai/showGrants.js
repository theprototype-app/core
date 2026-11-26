// Roadmap 107 (lane 107-ui-state, PERMISSIONS) — WHAT THE PERSON HAS LET EACH ASSISTANT DO ON THEIR SCREEN, as one list
// they can see and take back. A LEAF (svelte/store, safeStorage, the pure core): showTool.js keeps its answers here,
// Settings ▸ Privacy ▸ Assistant on your screen renders the list with Revoke, and ui_state reads it for the agent.
//
// The grants are show's three first-use kinds (panel / camera / code) and nothing else: the refused surfaces (sign-in,
// account, settings, consent, publishing, connected apps, payment) are not a kind, so no answer can ever grant them.
// Permissions are kept per app: every grant is (app, kind). Always = stored on THIS device (`show:grants`, app -> kinds);
// This time and No = this page, until it reloads. The in-app assistant is an app of its own ("The assistant"). Only the
// person's own buttons write a grant; no tool can.

import { writable } from 'svelte/store';
import { safeStorage } from '../safeStorage';
import { grantsList } from './uiStateCore.js';

/** show's first-use kinds (showCore.SHOW_KINDS; a unit test keeps the two equal, this leaf imports neither) */
export const GRANT_KINDS = /** @type {const} */ (['panel', 'camera', 'code']);

/** the device's Always grants: {app: kind[]} */
export const GRANTS_KEY = 'show:grants';
/** the per-kind keys older builds wrote (`show:allow:<kind>`), read once into GRANTS_KEY as Claude's */
const OLD_KEY = (/** @type {string} */ kind) => 'show:allow:' + kind;
/** the app those grants were given to */
export const OLD_GRANTS_APP = 'Claude';
/** most apps one device remembers */
const MAX_APPS = 20;

/** bumps on every change, so a list on screen re-reads */
export const grantsVersion = writable(0);
const bump = () => grantsVersion.update((n) => n + 1);

/** an app name as a key: what the line says, trimmed @param {unknown} app */
const appKey = (app) =>
	String(app ?? '')
		.trim()
		.slice(0, 40);

/** @returns {Record<string, string[]>} */
function readStore() {
	/** @type {Record<string, string[]>} */
	let store = {};
	try {
		const raw = safeStorage.getItem(GRANTS_KEY);
		const v = raw ? JSON.parse(raw) : {};
		if (v && typeof v === 'object' && !Array.isArray(v))
			for (const [app, kinds] of Object.entries(v)) {
				const k = Array.isArray(kinds)
					? kinds.filter((x) => GRANT_KINDS.includes(/** @type {any} */ (x)))
					: [];
				if (appKey(app) && k.length) store[appKey(app)] = [...new Set(k)];
			}
	} catch {
		store = {};
	}
	// the old per-kind keys: each Always becomes Claude's, and the key goes
	let moved = false;
	for (const kind of GRANT_KINDS) {
		let old = null;
		try {
			old = safeStorage.getItem(OLD_KEY(kind));
		} catch {}
		if (old === null || old === undefined) continue;
		if (old === 'always')
			store[OLD_GRANTS_APP] = [...new Set([...(store[OLD_GRANTS_APP] ?? []), kind])];
		try {
			safeStorage.removeItem(OLD_KEY(kind));
		} catch {}
		moved = true;
	}
	if (moved) writeStore(store);
	return store;
}

/** @param {Record<string, string[]>} store */
function writeStore(store) {
	const kept = Object.fromEntries(
		Object.entries(store)
			.filter(([, k]) => k.length)
			.slice(-MAX_APPS)
	);
	try {
		if (Object.keys(kept).length) safeStorage.setItem(GRANTS_KEY, JSON.stringify(kept));
		else safeStorage.removeItem(GRANTS_KEY);
	} catch {}
}

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

/** is this kind stored as Always for this app on this device @param {string} kind @param {string} app */
export function alwaysAllowed(kind, app) {
	const k = appKey(app);
	return !!k && (readStore()[k] ?? []).includes(kind);
}

/** @param {string} kind @param {boolean} on @param {string} app */
export function setAlways(kind, on, app) {
	const k = appKey(app);
	if (!k || !GRANT_KINDS.includes(/** @type {any} */ (kind))) return;
	const store = readStore();
	const had = store[k] ?? [];
	store[k] = on ? [...new Set([...had, kind])] : had.filter((x) => x !== kind);
	if (!store[k].length) delete store[k];
	writeStore(store);
	bump();
}

/** the list, for the person's Settings rows and the agent's ui_state */
export function showGrants() {
	return grantsList([...GRANT_KINDS], readStore(), sessionAnswers.entries());
}

/**
 * Take a grant back: this app's Always and This time for the kind (every app's when `app` is left out). A No stays a No.
 * @param {string} kind @param {string} [app]
 */
export function revokeGrant(kind, app) {
	const store = readStore();
	for (const a of Object.keys(store)) if (!app || a === appKey(app)) setAlways(kind, false, a);
	for (const [key, value] of [...sessionAnswers]) {
		const [k, a] = key.split('\n');
		if (k === kind && value === 'session' && (!app || a === appKey(app)))
			sessionAnswers.delete(key);
	}
	bump();
}

/** take every grant back */
export function revokeAllGrants() {
	for (const kind of GRANT_KINDS) revokeGrant(kind);
}
