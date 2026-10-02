// Module SDK — the per-module context every api slice is built from (one per makeApi call).

import { moduleDisposals } from './registries.js';
import { possessRef } from './refs.js';

/**
 * @typedef {object} SdkContext
 * @property {string} moduleId
 * @property {string} moduleName the DISPLAY name (see makeApi)
 * @property {(fn: () => void) => number} onDispose record an undo thunk deactivateModule runs at teardown (A2)
 * @property {Set<'keys'|'locomotion'|'sticks'>} claimedScopes input scopes this module still holds — released at teardown
 * @property {Set<() => void>} scheduledCancels 23-A5: transport events, cancelled at teardown
 * @property {boolean} possessing whether this module holds a possess (released at teardown)
 */

/** @param {string} moduleId @param {string} moduleName @returns {SdkContext} */
export function makeModuleContext(moduleId, moduleName) {
	const disposals = (moduleDisposals[moduleId] ??= []);
	/** record an undo thunk deactivateModule runs at teardown (A2) @param {() => void} fn */
	const onDispose = (fn) => disposals.push(fn);
	/** input scopes this module still holds — released at teardown
	 * @type {Set<'keys'|'locomotion'|'sticks'>} */
	const claimedScopes = new Set();
	/** 23-A5: events this module scheduled on the transport, cancelled at teardown so a
	 * disabled drum machine stops drumming @type {Set<() => void>} */
	const scheduledCancels = new Set();
	/** @type {SdkContext} */
	const ctx = { moduleId, moduleName, onDispose, claimedScopes, scheduledCancels, possessing: false };
	onDispose(() => {
		scheduledCancels.forEach((cancel) => cancel());
		scheduledCancels.clear();
	});
	onDispose(() => {
		claimedScopes.forEach((scope) => import('../inputRuntime').then((m) => m.releaseInput(scope)));
		claimedScopes.clear();
		if (ctx.possessing) possessRef?.release();
		import('../inputRuntime').then((m) => m.unregisterBindings(moduleId));
	});
	return ctx;
}
