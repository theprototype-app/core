// Module SDK — the per-module context every api slice is built from (one per makeApi call).

import { track, trackOff } from './lifecycle.js';

/**
 * @typedef {object} SdkContext
 * @property {string} moduleId
 * @property {string} moduleName the DISPLAY name (see makeApi)
 * @property {(fn: () => void, kind?: string, opts?: {key?: string}) => () => void} onDispose
 *   record an undo thunk unloadModule runs at teardown (T2, sdk/lifecycle.js); returns
 *   `release()` — forget it without running it (the registration was undone early)
 * @property {(kind: string, off: () => void, opts?: {key?: string}) => () => void} owned
 *   journal a registration whose `off()` the module gets back: returns an `off` that undoes
 *   it AND drops the journal entry, so subscribe/unsubscribe all session leaves nothing
 * @property {Set<'keys'|'locomotion'|'sticks'>} claimedScopes input scopes this module still holds — released at teardown
 * @property {Set<() => void>} scheduledCancels 23-A5: transport events, cancelled at teardown
 * @property {boolean} possessing whether this module holds a possess (released at teardown)
 */

/** @param {string} moduleId @param {string} moduleName @returns {SdkContext} */
export function makeModuleContext(moduleId, moduleName) {
	/** @param {() => void} fn @param {string} [kind] @param {{key?: string}} [opts] */
	const onDispose = (fn, kind = 'other', opts) => track(moduleId, kind, fn, opts);
	/** @param {string} kind @param {() => void} off @param {{key?: string}} [opts] */
	const owned = (kind, off, opts) => trackOff(moduleId, kind, off, opts);
	/** input scopes this module still holds — released at teardown
	 * @type {Set<'keys'|'locomotion'|'sticks'>} */
	const claimedScopes = new Set();
	/** 23-A5: events this module scheduled on the transport, cancelled at teardown so a
	 * disabled drum machine stops drumming @type {Set<() => void>} */
	const scheduledCancels = new Set();
	/** @type {SdkContext} */
	const ctx = { moduleId, moduleName, onDispose, owned, claimedScopes, scheduledCancels, possessing: false };
	return ctx;
}
