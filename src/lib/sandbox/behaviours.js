// 69 T1 — BEHAVIOUR FILES IN THE GUEST. `compileBehaviourInGuest(source)` keeps the contract of
// behaviours/source.js `compileBehaviour` — it resolves to `{def, scope}` with `scope.bind(kit)`,
// `scope.scope.resetGuard` and `scope.dispose()` — so behaviours/app.js and behaviours/core.js (the
// wire, the documents, the timers, the authority rule) are unchanged. What moved is the file: it is
// evaluated as an ES module in its OWN guest context, with the same one-line prologue and loop
// guard (wrapSource), and `def` on the host is the definition's DATA (name, params, state, inputs,
// outputs) with every function replaced by a host stub that calls into the guest.
//
// THE GUEST `this`. A handler runs with a guest object mirroring the host context (core.js
// makeContext): `id`, `params`, `state`, `object` are copies refreshed on every entry; `kit` and
// every function member call the host's. STATE is the one thing written on both sides, so it is
// synced at the boundaries: host -> guest on every entry, guest -> host on every exit (a throw
// included — core.js compares it either way), and around every host call that may re-enter the
// guest (a kit call can fire a kit event a listener of this file hears; a method call is a
// dispatch) — the host answers with its state only when the re-entry changed it, so a handler
// holding a nested state object across an ordinary kit call keeps writing into the live one.

import { loadSandbox, Guest, fromGuestJson } from './engine.js';
import { wrapSource } from '../behaviours/source.js';
import { behaviour as markBehaviour } from '../behaviours/define.js';

/** context members that only READ (no state sync around them) */
const PURE = new Set(['rand', 'randInt', 'pick', 'now', 'log', 'isAuthority', 'me', 'find', 'findAll', 'cancel']);
/** context members that are data, refreshed on entry */
const DATA = new Set(['id', 'params', 'state', 'object', 'kit']);

let seq = 0;

/** replace the contents of `target` with `next`, keeping the object (core.js holds it) @param {any} target @param {any} next */
function adoptInto(target, next) {
	if (!target || typeof target !== 'object') return;
	for (const k of Object.keys(target)) delete target[k];
	if (next && typeof next === 'object' && !Array.isArray(next)) Object.assign(target, next);
}

/** a host-side copy that is plain JSON (what the guest may be handed) @param {any} v */
const json = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

/**
 * The host half of one behaviour's guest. `hostCtx` is the core.js context of the instance, learnt
 * from the `this` of the first stub call (core.js always calls handlers with it).
 */
class BehaviourGuest extends Guest {
	/** @param {any} rt */
	constructor(rt) {
		/** @type {any} */
		let self = null;
		super(
			rt,
			{
				// a context member (`this.<name>(…)`), with or without the state sync
				ctx: (/** @type {string} */ name, /** @type {any[]} */ args, /** @type {any} */ guestState) => self.ctxCall(name, args, guestState),
				// `this.kit.<piece>.<call>(…)` and the free `kit`
				kit: (/** @type {string} */ piece, /** @type {string} */ name, /** @type {any[]} */ args, /** @type {any} */ guestState) => self.kitCall(piece, name, args, guestState),
				kitShape: () => self.kitShape()
			},
			[BEHAVIOUR_PRELUDE]
		);
		self = this;
		/** @type {any} */ this.hostCtx = null;
		/** @type {any} */ this.boundKit = null;
	}

	/** @param {any} guestState */
	takeGuestState(guestState) {
		const state = this.hostCtx?.state;
		if (state && guestState && typeof guestState === 'object') adoptInto(state, guestState);
		return state ? JSON.stringify(state) : '';
	}

	/** run `fn` around the state sync; the answer carries the host state when a re-entry moved it
	 * @param {any} guestState @param {() => any} fn */
	synced(guestState, fn) {
		const sent = this.takeGuestState(guestState);
		const v = fn();
		const state = this.hostCtx?.state;
		const now = state ? JSON.stringify(state) : '';
		return now !== sent ? { v, s: json(state) } : { v };
	}

	/** @param {string} name @param {any[]} args @param {any} guestState */
	ctxCall(name, args, guestState) {
		const ctx = this.hostCtx;
		if (!ctx) throw new Error('this.' + name + ' is available inside handlers and methods');
		if (DATA.has(name)) throw new TypeError('this.' + name + ' is not a function');
		const fn = ctx[name];
		if (typeof fn !== 'function') throw new TypeError('this.' + name + ' is not a function');
		const list = Array.isArray(args) ? args : [];
		if (PURE.has(name)) return { v: fn.apply(ctx, list) };
		return this.synced(guestState, () => fn.apply(ctx, list));
	}

	/** @param {string} piece @param {string} name @param {any[]} args @param {any} guestState */
	kitCall(piece, name, args, guestState) {
		const face = this.boundKit ?? this.hostCtx?.kit;
		if (!face) throw new Error('kit is available inside handlers and methods (not at the top of the file)');
		const api = face[piece];
		const fn = api?.[name];
		if (typeof fn !== 'function') throw new TypeError('kit.' + piece + '.' + name + ' is not a function');
		return this.synced(guestState, () => fn(...(Array.isArray(args) ? args : [])));
	}

	/** the kit face's shape: `{piece: {name: 'fn' | value}}` */
	kitShape() {
		const face = this.boundKit ?? this.hostCtx?.kit;
		if (!face) return null;
		/** @type {Record<string, any>} */
		const shape = {};
		for (const [piece, api] of Object.entries(face)) {
			if (!api || typeof api !== 'object') {
				shape[piece] = { __value: json(api) };
				continue;
			}
			/** @type {Record<string, any>} */
			const members = {};
			for (const [name, v] of Object.entries(api)) members[name] = typeof v === 'function' ? 'fn' : { __value: json(v) };
			shape[piece] = members;
		}
		return shape;
	}

	/** what the guest `this` is refreshed from on every entry */
	entryData() {
		const ctx = this.hostCtx;
		if (!ctx) return null;
		/** @type {Record<string, string>} */
		const members = {};
		for (const key of Object.keys(ctx)) if (!DATA.has(key)) members[key] = PURE.has(key) ? 'pure' : 'sync';
		return { id: ctx.id, params: json(ctx.params), state: json(ctx.state), object: json(ctx.object), members };
	}

	/** the host stub of guest function `id`: an entry with the state sync @param {number} id */
	stubOf(id) {
		const guest = this;
		const stub = function (/** @type {any[]} */ ...args) {
			// @ts-ignore core.js calls every handler, method and closure with the instance context
			if (this && typeof this === 'object' && 'state' in this) guest.hostCtx = this;
			const out = guest.callEntry('__enter', id, guest.entryData(), args);
			if (out && typeof out === 'object' && 's' in out) guest.takeGuestState(out.s);
			if (out?.e) {
				const e = new Error(String(out.e.message ?? out.e));
				e.name = String(out.e.name ?? 'Error');
				if (out.e.stack) e.stack = e.name + ': ' + e.message + '\n' + String(out.e.stack);
				throw e;
			}
			return out?.r;
		};
		this.released.register(stub, id);
		return stub;
	}
}

/**
 * Evaluate a behaviour file in a fresh guest context. Same contract as `compileBehaviour`.
 * @param {string} source
 * @returns {Promise<{def: any, scope: {token: string, scope: any, bind: (kit: any) => void, dispose: () => void}}>}
 */
export async function compileBehaviourInGuest(source) {
	const rt = await loadSandbox();
	const guest = new BehaviourGuest(rt);
	const token = 'g' + ++seq;
	const scope = {
		token,
		scope: {
			resetGuard: () => {
				if (!guest.disposed) guest.callEntry('__resetGuard');
			}
		},
		/** @param {any} face */
		bind: (face) => {
			guest.boundKit = face;
			guest.callEntry('__bind', guest.kitShape());
		},
		dispose: () => guest.dispose()
	};
	try {
		const wrapped = wrapSource(source, token);
		if ('error' in wrapped) throw new Error(wrapped.error);
		const described = guest.evalModule(wrapped.code, 'behaviour.js', '__describe');
		const def = described?.def;
		if (!def || typeof def !== 'object') throw new Error('the file must `export default behaviour({...})`');
		// define.js's own check + mark, on the host copy (the guest's `behaviour()` only marks)
		return { def: markBehaviour(def), scope };
	} catch (error) {
		guest.dispose();
		throw error;
	}
}

/** parse helper re-exported for tests @param {string} text */
export const parseGuestJson = (text) => fromGuestJson(text);

// ---- guest side ------------------------------------------------------------------------------
// The scope the prologue destructures lives at globalThis.__tpBehaviourScope[token] (source.js's
// SCOPE_GLOBAL) — the guest's own global, one file per context, so any token resolves to it.
const BEHAVIOUR_PRELUDE = String.raw`
(function () {
	'use strict';
	const B = __bridge;
	// source.js's helpers, verbatim in behaviour
	const toVec = (p) => {
		if (!p) return null;
		if (Array.isArray(p)) return p.length >= 3 ? [Number(p[0]), Number(p[1]), Number(p[2])] : null;
		if (typeof p === 'object') {
			if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) return [p.x, p.y, p.z];
			return toVec(p.pos ?? p.point ?? p.position ?? null);
		}
		return null;
	};
	const dist = (a, b) => {
		const p = toVec(a), q = toVec(b);
		if (!p || !q) return NaN;
		return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
	};
	const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
	const lerp = (a, b, t) => a + (b - a) * t;
	const behaviour = (def) => def;

	// ---- the instance context (this) ----
	const ctx = {};
	const state = {};
	let params = {};
	let object = null;
	let id = '';
	const adopt = (target, next) => {
		for (const k of Object.keys(target)) delete target[k];
		if (next && typeof next === 'object' && !Array.isArray(next)) Object.assign(target, next);
	};
	const stateCopy = () => JSON.parse(JSON.stringify(state));
	/** a host call that may re-enter: our state goes out, a changed one comes back */
	const synced = (op, ...args) => {
		const out = B.call(op, ...args, stateCopy());
		if (out && Object.prototype.hasOwnProperty.call(out, 's')) adopt(state, out.s);
		return out ? out.v : undefined;
	};
	Object.defineProperties(ctx, {
		id: { get: () => id, enumerable: true },
		params: { get: () => params, enumerable: true },
		state: { get: () => state, enumerable: true },
		object: { get: () => object, enumerable: true },
		kit: { get: () => kit, enumerable: true }
	});
	const members = new Set();
	const syncMembers = (list) => {
		for (const [name, how] of Object.entries(list || {})) {
			if (members.has(name)) continue;
			members.add(name);
			ctx[name] = how === 'pure' ? (...a) => B.call('ctx', name, a, null).v : (...a) => synced('ctx', name, a);
		}
	};

	// ---- the kit: bound when the behaviour starts ----
	let bound = null;
	const pieces = new Map();
	const pieceOf = (piece) => {
		let p = pieces.get(piece);
		if (p) return p;
		const shape = bound[piece];
		if (!shape) return undefined;
		if (Object.prototype.hasOwnProperty.call(shape, '__value')) return shape.__value;
		p = {};
		for (const [name, how] of Object.entries(shape)) {
			p[name] = how === 'fn' ? (...a) => synced('kit', piece, name, a) : how.__value;
		}
		pieces.set(piece, Object.freeze(p));
		return pieces.get(piece);
	};
	const kit = new Proxy({}, {
		get(_t, key) {
			if (!bound) throw new Error('kit is available inside handlers and methods (not at the top of the file)');
			return typeof key === 'string' ? pieceOf(key) : undefined;
		},
		has: (_t, key) => !!bound && typeof key === 'string' && key in bound,
		ownKeys: () => (bound ? Object.keys(bound) : []),
		getOwnPropertyDescriptor: (_t, key) => (bound && typeof key === 'string' && key in bound ? { enumerable: true, configurable: true, value: pieceOf(key) } : undefined)
	});

	const scope = { behaviour, kit, dist, clamp, lerp, resetGuard: null };
	const tokens = new Proxy({}, { get: () => scope });
	Object.defineProperty(globalThis, '__tpBehaviourScope', { value: tokens });

	const def = (name, fn) => Object.defineProperty(globalThis, name, { value: (json) => B.encode(fn(...B.decode(json))) });
	Object.defineProperty(globalThis, '__describe', {
		value: (ns) => B.encode({ def: ns && ns.default })
	});
	def('__bind', (shape) => {
		bound = shape || {};
		pieces.clear();
		return true;
	});
	def('__resetGuard', () => {
		if (typeof scope.resetGuard === 'function') scope.resetGuard();
		return true;
	});
	// the host calls a function of this file (a handler, a method, a closure, a listener)
	def('__enter', (fnId, data, args) => {
		if (data) {
			id = data.id;
			params = data.params || {};
			object = data.object;
			adopt(state, data.state);
			syncMembers(data.members);
		}
		const fn = B.fn(fnId);
		try {
			const r = fn.apply(ctx, Array.isArray(args) ? args : []);
			return { r, s: stateCopy() };
		} catch (error) {
			const e = error && typeof error === 'object' ? { name: error.name, message: String(error.message), stack: error.stack } : { message: String(error) };
			return { e, s: stateCopy() };
		}
	});
})();
`;
