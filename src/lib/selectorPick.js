// 102b-flows — ONE FLOW, MANY OBJECTS: the BOOT half of the many-target Object Selector (what the
// runtime, the wire handler and the card test on every selector). Tiny on purpose: the resolver
// (tag / group / name walks, glob matching, the wording) is selectorCore.js, a lazy chunk loaded the
// first time a graph holds a many-target selector — until then a set resolves to nothing (`null`
// from resolveTargets), and the one-object path never needs it.
//
// An Object Selector has always named ONE object (`data.selected`, a uuid). It may now name a SET:
//   pick: 'tag'   match: a tag            -> every object carrying that tag (userData.tags)
//   pick: 'group' match: a group's uuid   -> every object directly inside that group
//   pick: 'name'  match: a name pattern   -> every object whose name matches (glob, see nameMatcher)
// `pick` absent (every selector saved before this) or 'object' is the old single target, byte for
// byte. Additive in the save file: an older build reads `selected` only.

import { writable } from 'svelte/store';

/** the selector's pick, normalised ('object' for anything unknown or absent) @param {any} data */
export function pickOf(data) {
	const p = data?.pick;
	return p === 'tag' || p === 'group' || p === 'name' ? p : 'object';
}

/** is this selector's data a MANY-target one (tag / group / name)? @param {any} data */
export function isManySelector(data) {
	return pickOf(data) !== 'object';
}

/** the selector's match text, trimmed ('' = not set yet) @param {any} data */
export function matchOf(data) {
	const m = data?.match;
	return typeof m === 'string' ? m.trim().slice(0, 120) : '';
}

/** a key two selectors with the same question share (the runtime's per-tick memo) @param {any} data */
export function selectorKey(data) {
	return pickOf(data) + '\u0000' + matchOf(data).toLowerCase();
}

/** bumped when the lazy resolver arrives (a card / the lint re-read their sets) */
export const selectorCoreVersion = writable(0);
/** @type {any} */
let core = null;
/** @type {Promise<any> | null} */
let loading = null;

/** load the resolver chunk once (idempotent) @returns {Promise<any>} */
export function loadSelectorCore() {
	loading ??= import('./selectorCore.js').then((m) => {
		core = m;
		selectorCoreVersion.update((n) => n + 1);
		return m;
	});
	return loading;
}

/** the resolver module if it has arrived, else null */
export function selectorCoreNow() {
	return core;
}

/**
 * What a selector names, synchronously: a plain selector its one object ([] for none); a set its
 * members once the resolver has loaded — `null` before that (the load is started).
 * @param {any} data @param {any} root @returns {string[] | null}
 */
export function resolveTargets(data, root) {
	if (!isManySelector(data)) {
		const s = data?.selected;
		return typeof s === 'string' && s && s !== '-None-' ? [s] : [];
	}
	if (!core) {
		void loadSelectorCore();
		return null;
	}
	return core.resolveSelector(data, root);
}
