// 21-E7.4 - MODULE-SUPPLIED HUD ELEMENT KINDS.
//
// `hudKinds.js` is the element REGISTRY and the palette AND the properties pane render
// from it, so "a module can add an element kind" is a matter of letting that registry see
// one more source. This is that source, kept in its OWN module for the reason
// `moduleToolboxes.js` and `moduleNodeIO.js` are: `moduleSDK` writes here and `hudKinds`
// reads here, and hudKinds is on the leaf side of the TDZ family around history.js. Both
// of those modules import nothing but `svelte/store`, and neither does this one.
//
// The shape is `registerToolbox`'s: a module hands over a `(el) => cleanup` MOUNT function
// (the cloudMount contract) and core hands it a DOM node inside the element's slot, so a
// module writes plain DOM and inherits the layer, the 9-grid placement, the anchoring, the
// document, replication, undo and all four save paths for nothing.
//
// KINDS ARE NAMESPACED `mod-<moduleId>-<kind>`, and that matters more here than anywhere
// else it is done: the kind name is written INTO a replicated, saved document. A peer
// without the module - or the same scene reopened after the module is gone - reaches an
// unknown kind, and `hudDocs.normalizeHudElement` already PRESERVES it verbatim and
// `HudElement` already skips it at render (the normalizeAnnotation rule). So the fallback
// story is the one the system already had, not a new one; installing the module makes the
// element appear, and removing it makes it invisible without destroying anyone's layout.

import { writable, get } from 'svelte/store';

/**
 * @typedef {{
 *   kind: string, label: string, group: string, icon?: string, summary?: string,
 *   moduleId: string, moduleName?: string,
 *   defaultSize?: {w: number, h: number},
 *   defaults?: Record<string, any>, styleDefaults?: Record<string, any>,
 *   fields?: any[], style?: any[],
 *   interactive?: boolean, valued?: boolean,
 *   mount: (el: HTMLElement, element: any, runtime: any) => (() => void) | void
 * }} ModuleHudKind
 */

/** every registered module kind, in registration order.
 * @type {import('svelte/store').Writable<ModuleHudKind[]>} */
export const moduleHudKinds = writable([]);

/** A plain mirror beside the store, because `kindDef` is called from the RENDER path and
 * from pure helpers that must not be `$derived`-aware. The store is what components watch;
 * this is what the registry reads. (`moduleNodeGroups`/`moduleNodeInputs` split the same
 * way, for the same reason.) @type {Record<string, ModuleHudKind>} */
const byKind = {};

/**
 * Register a kind. Returns the NAMESPACED kind name - the caller needs it to create
 * elements of it and never has to re-derive the spelling.
 * @param {string} moduleId @param {string} kind @param {any} def
 * @returns {string}
 */
export function registerModuleHudKind(moduleId, kind, def) {
	const full = 'mod-' + moduleId + '-' + kind;
	/** @type {ModuleHudKind} */
	const entry = {
		...(def ?? {}),
		kind: full,
		moduleId,
		label: def?.label || kind,
		// the palette groups module kinds under the MODULE, so a user reads "Physics
		// toys" rather than finding a stranger's element filed under Display
		group: def?.group || def?.moduleName || moduleId,
		icon: def?.icon || 'box',
		summary: def?.summary || 'An element supplied by the ' + (def?.moduleName || moduleId) + ' module.',
		defaultSize: def?.defaultSize ?? { w: 160, h: 48 },
		defaults: { ...(def?.defaults ?? {}) },
		styleDefaults: { ...(def?.styleDefaults ?? {}) },
		fields: Array.isArray(def?.fields) ? def.fields : [],
		style: Array.isArray(def?.style) ? def.style : [],
		mount: typeof def?.mount === 'function' ? def.mount : () => {}
	};
	byKind[full] = entry;
	moduleHudKinds.update((list) => [...list.filter((k) => k.kind !== full), entry]);
	return full;
}

/** Drop a kind. Elements already authored with it stay in the document and go back to
 * being preserved-and-skipped, which is exactly what a peer without the module sees.
 * @param {string} kindOrFull */
export function unregisterModuleHudKind(kindOrFull) {
	delete byKind[kindOrFull];
	moduleHudKinds.update((list) => list.filter((k) => k.kind !== kindOrFull));
}

/** @param {string} kind @returns {ModuleHudKind|null} */
export function moduleHudKindDef(kind) {
	return byKind[kind] ?? null;
}

/** @returns {ModuleHudKind[]} */
export function moduleHudKindList() {
	return get(moduleHudKinds);
}

/** test/debug view */
export function moduleHudKindsDebug() {
	return { kinds: Object.keys(byKind) };
}