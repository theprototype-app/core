// Module lifecycle — the safety net for INSTALLED modules (zip / URL), contract T2 (34 R6).
//
// A module from the modules repo is plain browser code: it calls `setTimeout`,
// `setInterval` and `window.addEventListener` directly, and nothing in the api ever sees
// those. Measured before this file: Waves left three capture-phase pointer listeners on
// `window`, fps-player a mousemove + a pointerlockchange, and every manager toolbox's 500 ms
// refresh interval kept running for a module that was gone. So each import gets a SCOPE:
//
// - TIMERS: the entry file is evaluated with a one-line prologue (on its first line, so
//   every line number in a stack trace is unchanged) that binds the bare names
//   `setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`/`requestAnimationFrame`/
//   `cancelAnimationFrame` to tracked ones (sdk/own.js makeModuleTimers). A module that
//   declares one of those names itself is a SyntaxError with the prologue, so the loader
//   retries WITHOUT it (userModules.importModuleObject) and the module simply runs untracked.
// - LISTENERS on `window` and `document`: the two targets that outlive everything. Their
//   add/removeEventListener are wrapped once, and an add whose call stack runs through a
//   scope's blob URL is recorded against that scope. Only while a scope exists does the
//   wrapper look at a stack at all.
//
// The scope is ADOPTED into the module's lifecycle registry when initModules registers the
// module (moduleSDK.js), as ONE entry; an import that is discarded (a parse error, an id
// mismatch) disposes its scope at once. Adopting at registration, not at import, matters:
// a live update evaluates the NEW entry before it unloads the OLD one, and the old one's
// teardown must not take the new one's timers with it.

import { makeModuleTimers } from './own.js';

/** module object -> the scope its entry was evaluated in (initModules adopts it) @type {WeakMap<object, any>} */
const scopeByModule = new WeakMap();
/** @param {object} mod @param {ModuleScope} scope */
export function attachModuleScope(mod, scope) {
	scopeByModule.set(mod, scope);
}
/** @param {any} mod @returns {ModuleScope | null} */
export function moduleScopeOf(mod) {
	return (mod && scopeByModule.get(mod)) ?? null;
}

/**
 * @typedef {object} ModuleScope
 * @property {string} id
 * @property {string} nonce the key the prologue reads the timers under
 * @property {ReturnType<typeof makeModuleTimers>} timers
 * @property {(url: string) => void} setUrl the blob URL the entry was evaluated from
 * @property {(track: (kind: string, undo: () => void) => void) => void} adopt
 * @property {() => void} dispose
 * @property {() => {timeouts: number, intervals: number, frames: number, listeners: number}} counts
 * @property {(target: any, type: string, fn: any, options: any) => void} noteListener
 * @property {(target: any, type: string, fn: any, options: any) => void} forgetListener
 */

/** blob URL -> its scope (only for scopes alive right now) @type {Map<string, ModuleScope>} */
const scopesByUrl = new Map();
/** nonce -> timers, read once by the prologue while the entry evaluates @type {Record<string, any>} */
const prologueTimers = {};
/** id -> the scopes adopted for it (the debug view) @type {Map<string, ModuleScope>} */
const liveScopes = new Map();

let seq = 0;

/** The line put IN FRONT of the entry's first line. @param {string} nonce */
export function modulePrologue(nonce) {
	return (
		'const {setTimeout,clearTimeout,setInterval,clearInterval,requestAnimationFrame,cancelAnimationFrame}=' +
		'globalThis.__tpModuleTimers[' +
		JSON.stringify(nonce) +
		'];'
	);
}

/** @param {string} id @returns {ModuleScope} */
export function createModuleScope(id) {
	installGlobalHooks();
	const nonce = 'm' + ++seq + '-' + String(id).replace(/[^\w-]/g, '_');
	/** the timers' undo (they journal lazily, on first use) — run by dispose() whether the
	 * module was adopted yet or not @type {(() => void) | null} */
	let timersUndo = null;
	/** @type {string | null} */
	let url = null;
	/** listeners recorded on window/document @type {Set<{target: any, type: string, fn: any, options: any}>} */
	const listeners = new Set();
	/** @param {() => void} fn @returns {() => void} */
	const holdUndo = (fn) => {
		timersUndo = fn;
		return () => {
			if (timersUndo === fn) timersUndo = null;
		};
	};
	const timers = makeModuleTimers(holdUndo, 'timers:scope');
	/** @type {ModuleScope} */
	const scope = {
		id,
		nonce,
		timers,
		setUrl(u) {
			url = u;
			scopesByUrl.set(u, scope);
		},
		adopt(track) {
			// a module unloaded and registered again re-arms its listener attribution
			if (url) scopesByUrl.set(url, scope);
			liveScopes.set(id, scope);
			track('moduleScope', () => scope.dispose());
		},
		dispose() {
			timersUndo?.();
			timersUndo = null;
			for (const l of listeners) {
				try {
					nativeRemove.get(l.target)?.call(l.target, l.type, l.fn, l.options);
				} catch {}
			}
			listeners.clear();
			if (url) scopesByUrl.delete(url);
			if (liveScopes.get(id) === scope) liveScopes.delete(id);
			delete prologueTimers[nonce];
		},
		counts() {
			return { ...timers.pending(), listeners: listeners.size };
		},
		noteListener(target, type, fn, options) {
			listeners.add({ target, type, fn, options });
		},
		forgetListener(target, type, fn, options) {
			const capture = captureOf(options);
			for (const l of listeners) {
				if (l.target === target && l.type === type && l.fn === fn && captureOf(l.options) === capture) {
					listeners.delete(l);
					break;
				}
			}
		}
	};
	prologueTimers[nonce] = timers;
	return scope;
}

/** The prologue has read its timers: drop the global handle. @param {ModuleScope} scope */
export function releasePrologue(scope) {
	delete prologueTimers[scope.nonce];
}

/** @param {any} options */
function captureOf(options) {
	return typeof options === 'boolean' ? options : !!options?.capture;
}

/** target -> its native removeEventListener @type {Map<any, Function>} */
const nativeRemove = new Map();
let hooked = false;

/** Which live scope's code is on the stack right now (null when none is). */
function scopeOnStack() {
	if (!scopesByUrl.size) return null;
	const limit = /** @type {any} */ (Error).stackTraceLimit;
	/** @type {any} */ (Error).stackTraceLimit = 60;
	const stack = String(new Error().stack ?? '');
	/** @type {any} */ (Error).stackTraceLimit = limit;
	for (const [u, scope] of scopesByUrl) if (stack.includes(u)) return scope;
	return null;
}

function installGlobalHooks() {
	if (hooked || typeof window === 'undefined') return;
	hooked = true;
	/** @type {any} */ (globalThis).__tpModuleTimers = prologueTimers;
	for (const target of [window, document]) {
		const add = target.addEventListener;
		const remove = target.removeEventListener;
		nativeRemove.set(target, remove);
		/** @type {any} */ (target).addEventListener = function (/** @type {string} */ type, /** @type {any} */ fn, /** @type {any} */ options) {
			add.call(this, type, fn, options);
			if (fn && scopesByUrl.size) scopeOnStack()?.noteListener(this, type, fn, options);
		};
		/** @type {any} */ (target).removeEventListener = function (/** @type {string} */ type, /** @type {any} */ fn, /** @type {any} */ options) {
			remove.call(this, type, fn, options);
			if (fn && scopesByUrl.size) for (const scope of scopesByUrl.values()) scope.forgetListener(this, type, fn, options);
		};
	}
}

/** Per adopted module: what its scope still holds (the leak test, the debug view). */
export function moduleScopeDebug() {
	/** @type {Record<string, any>} */
	const out = {};
	for (const [id, scope] of liveScopes) out[id] = scope.counts();
	return out;
}
