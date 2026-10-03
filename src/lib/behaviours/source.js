// 34 R3 (D1) — A BEHAVIOUR FILE BECOMES A DEFINITION: the scope prologue, the loop guard, and the
// import. A LEAF (the loop guard and siblings only): the app evaluates through the module loader's
// blob import (behaviours/app.js), the logic sim through a `data:` URL — the SAME text either way.
//
// The file is an ES module: `export default behaviour({...})`. In front of its first line (ON line
// 1, so every line number in an error is the file's own) goes ONE statement binding the names a
// behaviour may use without importing anything:
//
//   behaviour   the authoring call (define.js)
//   kit         the game kit, as the behaviour's own module sees it (api.kit — its listeners are
//               tracked and die with the behaviour, T2); bound when the behaviour starts, so a
//               top-level `kit.…` (outside a handler) throws a clear error
//   dist, clamp, lerp   small maths helpers (dist takes [x,y,z], {x,y,z}, or anything with pos/point)
//
// THE LOOP GUARD (27-D loopGuard.js) instruments every loop; its counter is reset before every
// dispatch (`__S.resetGuard`, set by a line APPENDED after the file), so the budget is per event,
// not per session.

import { instrument, GUARD_VAR } from '../loopGuard.js';
import { behaviour } from './define.js';

/** the global the prologue reads its scope from */
export const SCOPE_GLOBAL = '__tpBehaviourScope';

/** @param {any} p @returns {number[] | null} */
export function toVec(p) {
	if (!p) return null;
	if (Array.isArray(p)) return p.length >= 3 ? [Number(p[0]), Number(p[1]), Number(p[2])] : null;
	if (typeof p === 'object') {
		if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) return [p.x, p.y, p.z];
		return toVec(p.pos ?? p.point ?? p.position ?? null);
	}
	return null;
}

/** the distance between two places (NaN when either is not one) @param {any} a @param {any} b */
export function dist(a, b) {
	const p = toVec(a);
	const q = toVec(b);
	if (!p || !q) return NaN;
	return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** @param {number} v @param {number} lo @param {number} hi */
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** @param {number} a @param {number} b @param {number} t */
export const lerp = (a, b, t) => a + (b - a) * t;

let seq = 0;

/**
 * A fresh scope for one evaluation. `bind(kitFace)` once the behaviour's module api exists.
 * @returns {{token: string, scope: any, bind: (kit: any) => void, dispose: () => void}}
 */
export function createScope() {
	const token = 'b' + ++seq;
	/** @type {any} */
	let bound = null;
	const kit = new Proxy(
		{},
		{
			get(_t, key) {
				if (!bound) throw new Error('kit is available inside handlers and methods (not at the top of the file)');
				return bound[/** @type {any} */ (key)];
			},
			has: (_t, key) => !!bound && key in bound,
			ownKeys: () => (bound ? Reflect.ownKeys(bound) : []),
			getOwnPropertyDescriptor: (_t, key) => (bound && key in bound ? { enumerable: true, configurable: true, value: bound[/** @type {any} */ (key)] } : undefined)
		}
	);
	const scope = { behaviour, kit, dist, clamp, lerp, resetGuard: /** @type {null | (() => void)} */ (null) };
	const g = /** @type {any} */ (globalThis);
	(g[SCOPE_GLOBAL] ??= {})[token] = scope;
	return {
		token,
		scope,
		bind: (face) => {
			bound = face;
		},
		dispose: () => {
			delete g[SCOPE_GLOBAL]?.[token];
		}
	};
}

/**
 * The text that is evaluated: prologue (line 1) + the guarded file + the guard-reset epilogue.
 * `extraPrologue` is put in front (the module loader's timer prologue, also one line).
 * @param {string} source @param {string} token @param {string} [extraPrologue]
 * @returns {{code: string} | {error: string}}
 */
export function wrapSource(source, token, extraPrologue = '') {
	const guarded = instrument(String(source ?? ''));
	if ('error' in guarded) return { error: 'loop guard: ' + guarded.error };
	// instrument() puts its counter declaration on a line of its own; it moves into the prologue
	const decl = 'let ' + GUARD_VAR + '=0;\n';
	const body = guarded.code.startsWith(decl) ? guarded.code.slice(decl.length) : guarded.code;
	const prologue =
		extraPrologue +
		'const __S=globalThis[' +
		JSON.stringify(SCOPE_GLOBAL) +
		'][' +
		JSON.stringify(token) +
		'];const {behaviour,kit,dist,clamp,lerp}=__S;let ' +
		GUARD_VAR +
		'=0;';
	return { code: prologue + body + '\n;__S.resetGuard=()=>{' + GUARD_VAR + '=0};\n' };
}

/**
 * Evaluate a behaviour file. `importer(code)` evaluates ES module text and resolves to its
 * namespace (the module loader's blob import in the app; a data: URL in node).
 * @param {string} source @param {(code: string) => Promise<any>} importer @param {{extraPrologue?: string}} [opts]
 * @returns {Promise<{def: any, scope: ReturnType<typeof createScope>}>}
 */
export async function compileBehaviour(source, importer, opts = {}) {
	const s = createScope();
	try {
		const wrapped = wrapSource(source, s.token, opts.extraPrologue ?? '');
		if ('error' in wrapped) throw new Error(wrapped.error);
		const ns = await importer(wrapped.code);
		const def = ns?.default;
		if (!def || typeof def !== 'object') throw new Error('the file must `export default behaviour({...})`');
		return { def, scope: s };
	} catch (error) {
		s.dispose();
		throw error;
	}
}

/** node / tests: evaluate module text from a data: URL @param {string} code */
export function dataUrlImporter(code) {
	const b64 =
		typeof Buffer !== 'undefined'
			? /** @type {any} */ (globalThis).Buffer.from(code, 'utf8').toString('base64')
			: btoa(unescape(encodeURIComponent(code)));
	return import(/* @vite-ignore */ 'data:text/javascript;base64,' + b64);
}
