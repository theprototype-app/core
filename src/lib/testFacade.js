// 101 F5 — THE TEST FACADE: `window.__tp.test.v1`, a small versioned name space the e2e suites
// talk to instead of `window.__stores` (a LEAF: imports nothing).
//
// WHY: 1,062 suites reached the app's internals 16,000 times through `__stores.<hook>.<export>`,
// so renaming one export or splitting one god file meant editing suites. v1 FREEZES THE NAMES the
// suites use today: it forwards every read to the live hook table (`__stores`, built from
// debugHooks.js's DEBUG_HOOKS rows + debugHookRegistry.js's runtime registrations), and when an
// internal name changes, ONE row below keeps the old v1 name answering. Zero suite edits.
//
// THE RULES
// - READ-ONLY. A write, a define or a delete through the facade throws: a suite that wants to stub
//   something does it on the module (`t.someHook.setForTest(...)`), never by replacing a name.
// - LIVE. A hook registered after the install (registerDebugHook from a component that mounts
//   later) is visible at once through the same facade object, exactly as on `__stores`; a module's
//   live `export let` bindings stay live (the module namespace itself is returned when no rename
//   row names it, so the common case is byte-for-byte the object `__stores` hands out).
// - SPREADABLE. `{...t}`, `Object.keys(t)` and `name in t` see what `__stores` has, plus the
//   v1 alias names.
// - `__stores` stays as an alias for one release (the int's call), then goes.
//
// ADDING A ROW: when you rename `foo` to `bar` inside hook `baz`, add `baz: { foo: 'bar' }` to
// TEST_V1_RENAMED_EXPORTS. When a whole hook moves (`oldHook` now lives under `newHook`, or a
// spread `*` export moves into a module), add `oldHook: (s) => s.newHook` to TEST_V1_MOVED.

/** Hook-level renames: `{ hook: { v1ExportName: 'currentExportName' } }`.
 * @type {Record<string, Record<string, string>>} */
export const TEST_V1_RENAMED_EXPORTS = {
	// 101 F5 proof: backStack.js renamed its debug view; phone-back still calls backStackState()
	backStack: { backStackState: 'backStackSnapshot' }
};

/** Top-level names that moved: `{ v1Name: (stores) => value }`.
 * @type {Record<string, (stores: Record<string, any>) => any>} */
export const TEST_V1_MOVED = {};

const readOnly = (/** @type {string} */ what) => {
	throw new TypeError(`__tp.test.v1 is read-only (${what}): change the module, not the facade`);
};

/**
 * A read-only view of `mod` that also answers the v1 names in `renames`.
 * Target is an EXTENSIBLE empty object, so the proxy may report any key list (a module namespace
 * is non-extensible and would pin `ownKeys` to its own exports).
 * @param {any} mod @param {Record<string, string>} renames
 */
function renamedView(mod, renames) {
	const alias = (/** @type {PropertyKey} */ k) => (typeof k === 'string' && Object.hasOwn(renames, k) ? renames[k] : k);
	return new Proxy(
		{},
		{
			get: (_t, k) => mod[alias(k)],
			has: (_t, k) => alias(k) in mod,
			ownKeys: () => [...new Set([...Reflect.ownKeys(mod), ...Object.keys(renames).filter((k) => renames[k] in mod)])],
			getOwnPropertyDescriptor: (_t, k) =>
				alias(k) in mod ? { value: mod[alias(k)], writable: false, enumerable: true, configurable: true } : undefined,
			set: () => readOnly('set'),
			defineProperty: () => readOnly('defineProperty'),
			deleteProperty: () => readOnly('delete')
		}
	);
}

/**
 * Build the v1 facade over a LIVE hook table (`window.__stores`).
 * @param {Record<string, any>} stores
 * @param {{ renamed?: Record<string, Record<string, string>>, moved?: Record<string, (s: Record<string, any>) => any> }} [tables] for the unit test
 * @returns {Record<string, any>}
 */
export function makeTestFacadeV1(stores, tables = {}) {
	const renamed = tables.renamed ?? TEST_V1_RENAMED_EXPORTS;
	const moved = tables.moved ?? TEST_V1_MOVED;
	/** one wrapper per (hook, module) pair, so `t.x === t.x` holds like on __stores */
	const views = new Map();
	const read = (/** @type {PropertyKey} */ k) => {
		if (typeof k !== 'string') return stores[/** @type {any} */ (k)];
		const value = Object.hasOwn(moved, k) && !(k in stores) ? moved[k](stores) : stores[k];
		const renames = Object.hasOwn(renamed, k) ? renamed[k] : null;
		if (!renames || value == null || (typeof value !== 'object' && typeof value !== 'function')) return value;
		const cached = views.get(k);
		if (cached?.mod === value) return cached.view;
		const view = renamedView(value, renames);
		views.set(k, { mod: value, view });
		return view;
	};
	const has = (/** @type {PropertyKey} */ k) => k in stores || (typeof k === 'string' && Object.hasOwn(moved, k));
	return new Proxy(
		{},
		{
			get: (_t, k) => read(k),
			has: (_t, k) => has(k),
			ownKeys: () => [...new Set([...Reflect.ownKeys(stores), ...Object.keys(moved).filter((k) => has(k))])],
			getOwnPropertyDescriptor: (_t, k) => (has(k) ? { value: read(k), writable: false, enumerable: true, configurable: true } : undefined),
			set: () => readOnly('set'),
			defineProperty: () => readOnly('defineProperty'),
			deleteProperty: () => readOnly('delete'),
			setPrototypeOf: () => readOnly('setPrototypeOf'),
			preventExtensions: () => readOnly('preventExtensions')
		}
	);
}

/** The facade versions this build answers (a suite can assert the one it was written for). */
export const TEST_FACADE_VERSIONS = Object.freeze(['v1']);

/**
 * Publish `window.__tp.test.v1` over `stores` (called by installDebugHooks, after `__stores`).
 * `__tp` and `__tp.test` are frozen objects: the facade is the only thing a suite reaches there.
 * @param {Record<string, any>} stores
 */
export function installTestFacade(stores) {
	/** @type {any} */
	const w = typeof window !== 'undefined' ? window : null;
	if (!w) return null;
	const v1 = makeTestFacadeV1(stores);
	const test = Object.freeze({ v1, versions: TEST_FACADE_VERSIONS });
	const prev = w.__tp && typeof w.__tp === 'object' ? w.__tp : {};
	w.__tp = Object.freeze({ ...prev, test });
	return v1;
}
