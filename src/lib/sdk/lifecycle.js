// Module lifecycle — contract T2 (34 R6): ONE registry of everything a module left behind.
//
// Every SDK registration a module makes (a handler, a node type, a menu row, a timer, a
// listener, music, an input claim, a spawn override, a levels list, an object it owns, …)
// records its UNDO here, keyed by the module id. `unloadModule(id)` (moduleSDK.js) replays
// them newest-first, so a module can be unloaded live and registered again with fresh code.
// This grew out of 17-A2's per-module teardown journal (`onDispose`, 33's
// `deactivateModule`); what it adds is the contract around it:
//
// - one registry for EVERY path — the SDK slices (sdk/*.js) and the core subsystems that
//   act for a module outside the api object (kit entities, loaded models, …) go through
//   `track(moduleId, kind, undo)` here, never a private list of their own;
// - an entry is RELEASED when the module undoes it early (`off()`), so a module that
//   subscribes and unsubscribes all session does not grow its journal;
// - a `key` makes a re-callable registration REPLACE its entry (api.game.levels called on
//   every unlock keeps one entry, not one per call);
// - every api method declares what it does in its slice's SURFACE table (sdk/index.js), and
//   tests/unit/moduleLifecycle.test.js calls each 'registers' method, checks it journaled,
//   unloads, and checks core's registry is back where it was. A new SDK surface without a
//   teardown path fails that test.
//
// A LEAF apart from diagnostics: node vitest imports it directly.

import { log } from '../diagnostics';

/**
 * @typedef {object} Registration
 * @property {string} kind what was registered ('frameTask', 'music', 'kit.entity', …) — a
 *   free string, `<area>` or `<area>.<thing>`; it names the entry in the debug view and the
 *   teardown warning
 * @property {() => void} undo
 * @property {string} [key] a re-registration under the same key replaces this entry
 */

/** moduleId -> its live registrations, in registration order @type {Map<string, Set<Registration>>} */
const registry = new Map();

/**
 * Record a registration's undo for a module. Returns `release()`, which forgets the entry
 * WITHOUT running it — call it when the registration is undone early (the module's own
 * `off()`), so the journal holds only what is still live.
 * @param {string} moduleId @param {string} kind @param {() => void} undo
 * @param {{key?: string}} [opts] `key`: replace this module's live entry with the same key
 *   (its undo is dropped, not run — the new registration supersedes it)
 * @returns {() => void} release
 */
export function track(moduleId, kind, undo, opts) {
	let entries = registry.get(moduleId);
	if (!entries) registry.set(moduleId, (entries = new Set()));
	const key = opts?.key;
	if (key) {
		for (const entry of entries) {
			if (entry.key === key) {
				entries.delete(entry);
				break;
			}
		}
	}
	/** @type {Registration} */
	const entry = key ? { kind, undo, key } : { kind, undo };
	entries.add(entry);
	const owner = entries;
	return () => {
		owner.delete(entry);
	};
}

/**
 * Track a registration that hands the module an `off()`: returns an `off` that undoes it AND
 * releases the entry, so an early off leaves nothing in the journal. Idempotent.
 * @param {string} moduleId @param {string} kind @param {() => void} off @param {{key?: string}} [opts]
 * @returns {() => void}
 */
export function trackOff(moduleId, kind, off, opts) {
	const release = track(moduleId, kind, off, opts);
	let done = false;
	return () => {
		if (done) return;
		done = true;
		release();
		off();
	};
}

/**
 * Run every live registration of a module, newest first, and forget them. A failing undo is
 * logged and skipped — one broken teardown step never keeps the rest alive. An undo that
 * registers something AGAIN (it should not) is swept too, up to three passes.
 * @param {string} moduleId @returns {Record<string, number>} what ran, by kind
 */
export function disposeRegistrations(moduleId) {
	/** @type {Record<string, number>} */
	const ran = {};
	for (let pass = 0; pass < 3; pass++) {
		const entries = registry.get(moduleId);
		registry.delete(moduleId);
		if (!entries || entries.size === 0) break;
		const list = [...entries].reverse();
		for (const entry of list) {
			ran[entry.kind] = (ran[entry.kind] ?? 0) + 1;
			try {
				entry.undo();
			} catch (error) {
				log('warn', 'module', moduleId + ' teardown step failed (' + entry.kind + ')', String(error));
			}
		}
	}
	return ran;
}

/** A module's live registrations, counted by kind (the debug view, the tests).
 * @param {string} moduleId @returns {Record<string, number>} */
export function registrationsOf(moduleId) {
	/** @type {Record<string, number>} */
	const counts = {};
	for (const entry of registry.get(moduleId) ?? []) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
	return counts;
}

/** How many live registrations a module holds. @param {string} moduleId */
export function registrationCount(moduleId) {
	return registry.get(moduleId)?.size ?? 0;
}

/** Every module's live registrations by kind — `{moduleId: {kind: n}}`. */
export function allRegistrations() {
	/** @type {Record<string, Record<string, number>>} */
	const out = {};
	for (const id of registry.keys()) {
		const counts = registrationsOf(id);
		if (Object.keys(counts).length) out[id] = counts;
	}
	return out;
}
