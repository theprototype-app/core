// 94 SP1 — the runtime half of the debug hook, as a LEAF (imports nothing). Modules publish an
// object on `window.__stores` with `registerDebugHook(name, obj)` from HERE, so importing the seam
// never drags debugHooks.js's table (~300 lazy loaders, each with its preload list) into a page's
// boot: the play entry loads that table only when `debugStores` asks for it.

/** hooks published at runtime through registerDebugHook @type {Record<string, any>} */
export const registeredDebugHooks = {};

/** Publish `obj` on the debug hook as `__stores[name]` — now if the hook is installed, else when
 * it is. @param {string} name @param {any} obj */
export function registerDebugHook(name, obj) {
	registeredDebugHooks[name] = obj;
	/** @type {any} */
	const w = typeof window !== 'undefined' ? window : null;
	if (w?.__stores) w.__stores[name] = obj;
}
