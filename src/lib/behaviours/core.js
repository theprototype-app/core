// 34 R3 (D1) — THE BEHAVIOUR RUNTIME: handlers on ONE authority peer, state replicated to all.
//
// A pure LEAF (siblings only): no svelte, no three, no peer. The outside world comes in through
// a HOST adapter (the kit/core.js shape), so the same runtime runs in the app (behaviours/app.js
// binds it to the session clock, the mesh and the kit's authority) and in the headless logic sim
// (tests/unit/sim/behaviourSim.js: fake clock, in-memory wire, N fake peers).
//
// THE MODEL (proposal §4.4, fork F2 — the kit's rule extended to game logic):
//   · an INSTANCE is one behaviour definition (define.js) running under a stable id (the flow
//     node that holds its source), the same id on every peer;
//   · its handlers run on the AUTHORITY only (`host.isAuthority()`, the kit's single writer), so a
//     wave starts once however many peers saw the round begin; LOCAL events (a grab request: it
//     happens on the grabbing peer) run where they happen and may only READ state;
//   · `this.state` is plain JSON. After every handler the authority compares it with what it last
//     sent and, if it moved, broadcasts the whole document (`bhv`, latest-wins on `at`, then `rev`,
//     then `by`) — small, and a joiner or a new authority takes it as is;
//   · `this.after(s, 'method', …args)` timers live IN that document (due at a session-clock
//     moment), so the next authority fires them when the host leaves mid-wave; `this.after(s, fn)`
//     with a closure is local to the peer that set it (documented: it does not survive a handover);
//   · `this.rand()` is seeded per dispatch from (id, handler, a sequence number in the document), so
//     a replay of the same events gives the same numbers, and no peer ever needs Math.random;
//   · a peer that has NOT yet heard the document never acts as authority for it (the kit-entities
//     joiner trap: under the smallest-id rule a fresh joiner may BE the authority the moment it
//     connects, and its initial state must not overwrite a game in progress) until it hears one,
//     is alone, or GRACE_MS have passed since its last connection opened (every peer pushes its
//     documents in the handshake, so a document that exists arrives well inside that window).
//
// TRACE: every peer keeps what the derived node view (D2) draws — the last time each handler
// fired (replicated in the document, so every peer's view glows), kit calls, state writes,
// method calls, errors.

import { paramsOf, initialState, methodsOf, problems, inputsOf, outputsOf, CONTEXT_MEMBERS } from './define.js';
import { resolveEvent, grabPayload, kitPayload } from './events.js';

/** the wire type */
export const BHV = 'bhv';
/** after a connection opens, a peer that has not heard a document waits this long before it
 * may act as the authority for it (ms) */
export const GRACE_MS = 2000;
/** the most method timers a document carries */
export const MAX_TIMERS = 64;
/** the most `fired` rows a document carries */
const MAX_FIRED = 64;
/** 36 (U10): a wired input that reaches a peer while it is not (yet) the authority is held this
 * long (ms) — Play starting a simulation moves the kit's authority, and a press landing in that
 * moment must not be lost; the document's `inputs` record keeps it from running twice */
export const INPUT_HOLD_MS = 3000;

/** FNV-1a, 32-bit @param {string} s */
export function hash32(s) {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** mulberry32 (the flow `random` node's generator) @param {number} seed */
export function mulberry32(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Is document `a` newer than `b`? (the kit's newerDoc order) @param {any} a @param {any} b */
export function newerBhv(a, b) {
	if (!b) return true;
	if ((a.at ?? 0) !== (b.at ?? 0)) return (a.at ?? 0) > (b.at ?? 0);
	if ((a.rev ?? 0) !== (b.rev ?? 0)) return (a.rev ?? 0) > (b.rev ?? 0);
	return String(a.by ?? '') > String(b.by ?? '');
}

/** @param {any} v */
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/**
 * @typedef {{
 *   me: () => string | null,
 *   now: () => number,
 *   isAuthority: () => boolean,
 *   send: (msg: any) => void,
 *   specs?: () => any[],
 *   peerCount?: () => number,
 *   lastPeerChange?: () => number,
 *   tagsOf?: (uuid: string) => string[],
 *   findObjects?: (pattern: string) => {uuid: string, name: string, pos: number[], tags: string[]}[],
 *   warn?: (msg: string, detail?: any) => void,
 *   emit?: (id: string, name: string, payload?: any) => void
 * }} BehaviourHost
 * `emit` (36 U10): `this.emit(name)` on the authority — the app pulses the node's event output
 * `name` (a replicated nodetrigger), so a flow wired to it acts on every peer.
 */

/** @param {BehaviourHost} host */
export function createBehaviourRuntime(host) {
	/** id -> instance @type {Map<string, any>} */
	const instances = new Map();
	/** id -> the newest document heard for an id with no running instance @type {Map<string, any>} */
	const parked = new Map();
	/** change listeners (the live view) @type {Set<() => void>} */
	const listeners = new Set();
	const stats = { dispatched: 0, refusedWrites: 0, sent: 0, received: 0, stale: 0, errors: 0, skippedNotAuthority: 0 };
	const warn = (/** @type {string} */ msg, /** @type {any} */ detail = undefined) => (host.warn ? host.warn(msg, detail) : console.warn('behaviour: ' + msg, detail ?? ''));
	const changed = () => {
		for (const fn of [...listeners]) {
			try {
				fn();
			} catch {}
		}
	};

	/** may this peer act for `inst` as the authority right now? @param {any} inst */
	const acts = (inst) => {
		if (!host.isAuthority()) return false;
		if (inst.synced) return true;
		const since = host.now() - (host.lastPeerChange?.() ?? inst.bornAt);
		if ((host.peerCount?.() ?? 0) === 0 || since >= GRACE_MS) {
			inst.synced = true;
			return true;
		}
		return false;
	};

	/** broadcast the document if the state (or its meta) moved since the last send @param {any} inst @param {boolean} [force] */
	const flush = (inst, force = false) => {
		const body = JSON.stringify({ s: inst.state, t: inst.doc.timers, st: inst.doc.started, q: inst.doc.seq, f: inst.doc.fired, i: inst.doc.inputs });
		if (!force && body === inst.lastSent) return false;
		inst.lastSent = body;
		const prev = inst.doc;
		inst.doc = { ...prev, rev: prev.rev + 1, at: Math.max(host.now(), (prev.at ?? 0) + 1), by: host.me() ?? '' };
		inst.synced = true;
		stats.sent++;
		host.send(messageOf(inst));
		return true;
	};

	/** @param {any} inst */
	const messageOf = (inst) => ({
		type: BHV,
		id: inst.id,
		rev: inst.doc.rev,
		at: inst.doc.at,
		by: inst.doc.by,
		state: clone(inst.state),
		started: !!inst.doc.started,
		seq: inst.doc.seq,
		timers: clone(inst.doc.timers),
		fired: clone(inst.doc.fired),
		inputs: clone(inst.doc.inputs ?? {})
	});

	/** take a received (or parked) document into an instance @param {any} inst @param {any} msg */
	const adopt = (inst, msg) => {
		const state = msg.state && typeof msg.state === 'object' && !Array.isArray(msg.state) ? clone(msg.state) : {};
		// a key the definition declares and the document lacks (a newer source) starts at its initial
		const init = initialState(inst.def);
		for (const k of Object.keys(init)) if (!(k in state)) state[k] = init[k];
		// keep the SAME object (a handler holding `this.state` across an await sees the update)
		for (const k of Object.keys(inst.state)) delete inst.state[k];
		Object.assign(inst.state, state);
		inst.doc = {
			rev: Number(msg.rev) || 0,
			at: Number(msg.at) || 0,
			by: String(msg.by ?? ''),
			started: !!msg.started,
			seq: Number(msg.seq) || 0,
			timers: Array.isArray(msg.timers) ? msg.timers.slice(0, MAX_TIMERS) : [],
			fired: msg.fired && typeof msg.fired === 'object' ? msg.fired : {},
			inputs: msg.inputs && typeof msg.inputs === 'object' && !Array.isArray(msg.inputs) ? { ...msg.inputs } : {}
		};
		inst.lastSent = JSON.stringify({ s: inst.state, t: inst.doc.timers, st: inst.doc.started, q: inst.doc.seq, f: inst.doc.fired, i: inst.doc.inputs });
		inst.synced = true;
		for (const [name, row] of Object.entries(inst.doc.fired)) {
			const local = inst.trace.fired[name];
			if (!local || local.at < row[0]) inst.trace.fired[name] = { at: row[0], n: row[1], err: local?.err ?? null };
		}
	};

	/**
	 * Run one handler / method on an instance. `local` = a local event (runs here, state read-only).
	 * @param {any} inst @param {string} label the trace name ('on.died', 'startWave', 'after')
	 * @param {Function} fn @param {any[]} args @param {{local?: boolean}} [opts]
	 */
	const dispatch = (inst, label, fn, args, opts = {}) => {
		if (!inst.alive) return undefined;
		const local = !!opts.local;
		if (!local && !acts(inst)) {
			stats.skippedNotAuthority++;
			return undefined;
		}
		const outer = inst.depth === 0;
		const before = outer ? JSON.stringify(inst.state) : null;
		if (outer) {
			// one seeded generator per outermost dispatch; the sequence is in the document
			const seq = local ? ++inst.localSeq : ++inst.doc.seq;
			inst.rng = mulberry32(hash32(inst.id + '|' + label + '|' + seq + (local ? '|' + (host.me() ?? '') : '')));
			inst.resetGuard?.();
		}
		inst.depth++;
		stats.dispatched++;
		const at = host.now();
		/** @type {any} */
		let result;
		let err = null;
		try {
			result = fn.apply(inst.ctx, args);
		} catch (error) {
			err = error;
			stats.errors++;
			inst.errors.push({ at, where: label, message: String(/** @type {any} */ (error)?.message ?? error), stack: String(/** @type {any} */ (error)?.stack ?? '') });
			if (inst.errors.length > 20) inst.errors.shift();
			warn(inst.name + ': ' + label + ' failed', error);
		} finally {
			inst.depth--;
		}
		const row = inst.trace.fired[label] ?? { at: 0, n: 0, err: null };
		inst.trace.fired[label] = { at, n: row.n + 1, err: err ? String(/** @type {any} */ (err)?.message ?? err) : null };
		if (outer) {
			const after = JSON.stringify(inst.state);
			if (after !== before) {
				if (local || !host.isAuthority()) {
					// a local handler may only READ state: put it back (the authority owns it)
					stats.refusedWrites++;
					adoptState(inst, /** @type {string} */ (before));
					warn(inst.name + ': ' + label + ' wrote state on a peer that does not own it (ignored)');
				} else {
					for (const [k, v] of Object.entries(inst.state)) {
						if (JSON.stringify(v) !== JSON.stringify(inst.prevState?.[k])) inst.trace.writes[k] = { at, n: (inst.trace.writes[k]?.n ?? 0) + 1 };
					}
				}
			}
			inst.prevState = JSON.parse(JSON.stringify(inst.state));
			if (!local && host.isAuthority()) {
				// glow on every peer: the handler's moment rides the document
				if (label.startsWith('on.') || label.startsWith('after:')) {
					inst.doc.fired = { ...inst.doc.fired, [label]: [at, inst.trace.fired[label].n] };
					const keys = Object.keys(inst.doc.fired);
					if (keys.length > MAX_FIRED) delete inst.doc.fired[keys[0]];
				}
				flush(inst);
			}
			// 36 (U10): the handler's emits, after its state went out
			for (const [name, payload] of inst.emits.splice(0)) host.emit?.(inst.id, name, payload);
			changed();
		}
		return result;
	};

	/** @param {any} inst @param {string} json */
	const adoptState = (inst, json) => {
		const prev = JSON.parse(json);
		for (const k of Object.keys(inst.state)) delete inst.state[k];
		Object.assign(inst.state, prev);
	};

	/** wrap a kit face so the view sees each call @param {any} inst @param {any} face */
	const traceKit = (inst, face) => {
		if (!face) return null;
		/** @type {Record<string, any>} */
		const out = {};
		for (const [piece, api] of Object.entries(face)) {
			if (!api || typeof api !== 'object') {
				out[piece] = api;
				continue;
			}
			/** @type {Record<string, any>} */
			const wrapped = {};
			for (const [name, fn] of Object.entries(api)) {
				if (typeof fn !== 'function') {
					wrapped[name] = fn;
					continue;
				}
				wrapped[name] = (/** @type {any[]} */ ...a) => {
					const key = piece + '.' + name;
					inst.trace.calls[key] = { at: host.now(), n: (inst.trace.calls[key]?.n ?? 0) + 1 };
					return fn(...a);
				};
			}
			out[piece] = wrapped;
		}
		return out;
	};

	/** the handler `this` of an instance @param {any} inst @param {any} opts */
	const makeContext = (inst, opts) => {
		/** @type {Record<string, any>} */
		const ctx = {
			id: inst.id,
			get params() {
				return inst.values;
			},
			get state() {
				return inst.state;
			},
			kit: traceKit(inst, opts.kit),
			object: opts.object ?? null,
			/**
			 * Run something `seconds` from now on the session clock (authority only). A METHOD NAME
			 * (`this.after(3, 'startWave', 2)`) is kept in the replicated document and survives the
			 * authority leaving; a closure stays on this peer. Returns a key for `cancel`.
			 * @param {number} seconds @param {string | Function} target @param {...any} args
			 */
			after(seconds, target, ...args) {
				if (!host.isAuthority()) {
					warn(inst.name + ': after() is for the authority (a local handler cannot schedule)');
					return null;
				}
				const at = host.now() + Math.max(0, Number(seconds) || 0) * 1000;
				const k = 't' + (++inst.timerSeq).toString(36) + '-' + (host.me() ?? 'local');
				if (typeof target === 'string') {
					if (typeof inst.def[target] !== 'function') throw new Error('after: no method "' + target + '"');
					if (inst.doc.timers.length >= MAX_TIMERS) throw new Error('after: more than ' + MAX_TIMERS + ' timers pending');
					inst.doc.timers = [...inst.doc.timers, { k, at, m: target, a: clone(args) ?? [] }];
				} else if (typeof target === 'function') inst.closures.push({ k, at, fn: target, args });
				else throw new Error('after: give a method name or a function');
				return k;
			},
			/** cancel an `after` @param {string | null} key */
			cancel(key) {
				if (!key) return false;
				const before = inst.doc.timers.length + inst.closures.length;
				inst.doc.timers = inst.doc.timers.filter((/** @type {any} */ t) => t.k !== key);
				inst.closures = inst.closures.filter((/** @type {any} */ t) => t.k !== key);
				return inst.doc.timers.length + inst.closures.length < before;
			},
			/** a number in [0, 1), seeded per event (never Math.random) */
			rand: () => (inst.rng ?? (inst.rng = mulberry32(hash32(inst.id))))(),
			/** a whole number in [a, b] @param {number} a @param {number} b */
			randInt: (a, b) => Math.floor(ctx.rand() * (Math.floor(b) - Math.ceil(a) + 1)) + Math.ceil(a),
			/** one element @param {any[]} list */
			pick: (list) => (Array.isArray(list) && list.length ? list[Math.floor(ctx.rand() * list.length)] : undefined),
			/** the session clock, seconds */
			now: () => host.now() / 1000,
			/** @param {...any} a */
			log: (...a) => console.log('[behaviour ' + inst.name + ']', ...a),
			isAuthority: () => host.isAuthority(),
			me: () => host.me(),
			/** scene objects whose NAME (or a tag) matches a glob: `[{uuid, name, pos, tags}]` @param {string} pattern */
			findAll: (pattern) => host.findObjects?.(String(pattern ?? '')) ?? [],
			/** the first of findAll, or null @param {string} pattern */
			find: (pattern) => ctx.findAll(pattern)[0] ?? null,
			/**
			 * 36 (U10): fire the node's EVENT output `name` (declared in `outputs`) — on the authority,
			 * where handlers run; the pulse replicates, so whatever is wired to it acts on every peer.
			 * @param {string} name @param {any} [payload]
			 */
			emit(name, payload) {
				const key = String(name ?? '');
				if (!host.isAuthority()) {
					warn(inst.name + ': emit("' + key + '") is for the authority (a local handler cannot fire outputs)');
					return false;
				}
				if (!outputsOf(inst.def).includes(key)) warn(inst.name + ': emit("' + key + '") — add it to outputs to wire it');
				inst.trace.calls['emit.' + key] = { at: host.now(), n: (inst.trace.calls['emit.' + key]?.n ?? 0) + 1 };
				// the pulse leaves AFTER the handler's state document (dispatch drains this once it
				// has flushed), so a peer's Announce wired to the event reads the state it produced
				if (inst.depth > 0) inst.emits.push([key, payload]);
				else host.emit?.(inst.id, key, payload);
				return true;
			}
		};
		for (const m of methodsOf(inst.def)) {
			ctx[m] = (/** @type {any[]} */ ...a) => {
				inst.trace.methods[m] = { at: host.now(), n: (inst.trace.methods[m]?.n ?? 0) + 1 };
				// a method called from outside a handler (a test, the console) is a dispatch of its own
				return inst.depth > 0 ? inst.def[m].apply(ctx, a) : dispatch(inst, m, inst.def[m], a);
			};
		}
		return ctx;
	};

	/**
	 * Start (or restart, with fresh code) a behaviour under `id`. A running instance under the same
	 * id is stopped first and its state carried over (a source edit keeps the game going).
	 * @param {string} id @param {any} def
	 * @param {{name?: string, kit?: any, object?: any, resetGuard?: () => void}} [opts]
	 *   `kit`: the SDK face the handlers call (`api.kit` of the behaviour's module: its listeners are
	 *   tracked for teardown, T2) · `object`: the graph's owner, `this.object` · `resetGuard`: the
	 *   loop guard's per-dispatch reset (source.js)
	 */
	const start = (id, def, opts = {}) => {
		const found = problems(def);
		if (found.length) throw new Error(found.join('; '));
		const carried = instances.get(id);
		if (carried) stop(id);
		const inst = {
			id,
			def,
			name: opts.name ?? id,
			alive: true,
			bornAt: host.now(),
			synced: false,
			params: paramsOf(def),
			/** @type {Record<string, any>} */ values: {},
			state: initialState(def),
			/** @type {any} */ prevState: null,
			doc: { rev: 0, at: 0, by: '', started: false, seq: 0, timers: /** @type {any[]} */ ([]), fired: /** @type {Record<string, [number, number]>} */ ({}), inputs: /** @type {Record<string, number>} */ ({}) },
			/** 36 (U10): wired inputs held while this peer cannot act @type {{name: string, stamp: number, payload: any, until: number}[]} */ pendingInputs: [],
			lastSent: '',
			depth: 0,
			localSeq: 0,
			timerSeq: 0,
			/** @type {any} */ rng: null,
			/** @type {any[]} */ closures: [],
			/** 36 (U10): `this.emit` calls waiting for the outer dispatch to flush @type {[string, any][]} */ emits: [],
			/** @type {(() => void)[]} */ offs: [],
			/** @type {any[]} */ errors: [],
			/** @type {string[]} */ problems: [],
			trace: { fired: /** @type {Record<string, any>} */ ({}), calls: /** @type {Record<string, any>} */ ({}), writes: /** @type {Record<string, any>} */ ({}), methods: /** @type {Record<string, any>} */ ({}) },
			resetGuard: opts.resetGuard ?? null,
			/** @type {any} */ ctx: null
		};
		for (const [k, p] of Object.entries(inst.params)) inst.values[k] = p.value;
		inst.ctx = makeContext(inst, opts);
		const kept = carried ? messageOf(carried) : parked.get(id);
		parked.delete(id);
		if (kept && (kept.rev > 0 || kept.started)) adopt(inst, kept);
		inst.prevState = clone(inst.state);
		instances.set(id, inst);
		// the events: each `on` key through the kit face
		const specs = host.specs?.() ?? [];
		const inputs = inputsOf(def);
		for (const [name, fn] of Object.entries(def.on ?? {})) {
			const ev = resolveEvent(name, specs, inputs);
			if (!ev) {
				inst.problems.push('on.' + name + ': no such event');
				continue;
			}
			if (ev.name === 'start' || ev.name === 'load') continue; // the runtime's own (tick / loaded())
			if (ev.input) continue; // 36 (U10): a wired input — `input()` dispatches it
			const label = 'on.' + name;
			if (ev.name === 'grabRequest') {
				const sub = opts.kit?.rules?.onGrabRequest;
				if (typeof sub !== 'function') {
					inst.problems.push(label + ': kit.rules is not available');
					continue;
				}
				inst.offs.push(sub((/** @type {any} */ req) => dispatch(inst, label, /** @type {Function} */ (fn), [grabPayload(req, host.tagsOf)], { local: true })));
				continue;
			}
			const method = 'on' + String(ev.event).charAt(0).toUpperCase() + String(ev.event).slice(1);
			const sub = ev.piece ? opts.kit?.[ev.piece]?.[method] : null;
			if (typeof sub !== 'function') {
				inst.problems.push(label + ': kit.' + ev.piece + ' is not available');
				continue;
			}
			inst.offs.push(
				sub((/** @type {any} */ payload) => {
					if (!ev.local) {
						// an entity event says where it was witnessed; anything else asks the host
						if (payload && typeof payload.authority === 'boolean' ? !payload.authority : !host.isAuthority()) return;
					}
					dispatch(inst, label, /** @type {Function} */ (fn), [kitPayload(payload)], { local: ev.local });
				})
			);
		}
		changed();
		return inst;
	};

	/** stop an instance (its listeners, its closures); the document is kept for a restart @param {string} id */
	const stop = (id) => {
		const inst = instances.get(id);
		if (!inst) return false;
		inst.alive = false;
		for (const off of inst.offs) {
			try {
				off?.();
			} catch {}
		}
		inst.offs = [];
		inst.closures = [];
		if (inst.doc.rev > 0 || inst.doc.started) parked.set(id, messageOf(inst));
		instances.delete(id);
		changed();
		return true;
	};

	/** forget an id entirely (its node was deleted) @param {string} id */
	const forget = (id) => {
		stop(id);
		parked.delete(id);
	};

	/**
	 * 36 (U10): run one wired input on the authority, once per stamp: the stamp goes into the
	 * replicated document (`inputs`), so the next authority — or this one, offered it again —
	 * knows it was handled. @param {any} inst @param {string} name @param {any} payload @param {number | undefined} stamp
	 */
	const runInput = (inst, name, payload, stamp) => {
		const fn = inst.def.on?.[name];
		if (typeof fn !== 'function') return;
		if (typeof stamp === 'number') inst.doc.inputs = { ...inst.doc.inputs, [name]: stamp };
		dispatch(inst, 'on.' + name, fn, [payload ?? {}]);
	};
	/** @param {any} inst @param {string} name @param {number | undefined} stamp */
	const handled = (inst, name, stamp) => typeof stamp === 'number' && Number(inst.doc.inputs?.[name] ?? -Infinity) >= stamp;

	/** per frame on every peer: the authority starts, fires due timers, flushes */
	const tick = () => {
		const now = host.now();
		for (const inst of [...instances.values()]) {
			// held inputs: dropped once handled (anywhere) or too old; run if we may act now
			if (inst.pendingInputs.length) {
				inst.pendingInputs = inst.pendingInputs.filter((/** @type {any} */ p) => p.until > now && !handled(inst, p.name, p.stamp));
				if (inst.alive && inst.pendingInputs.length && acts(inst)) {
					const due = inst.pendingInputs.sort((/** @type {any} */ a, /** @type {any} */ b) => a.stamp - b.stamp);
					inst.pendingInputs = [];
					for (const p of due) if (!handled(inst, p.name, p.stamp)) runInput(inst, p.name, p.payload, p.stamp);
				}
			}
			if (!inst.alive || !acts(inst)) continue;
			if (!inst.doc.started) {
				inst.doc.started = true;
				const fn = inst.def.on?.start;
				if (typeof fn === 'function') dispatch(inst, 'on.start', fn, [{}]);
				else flush(inst);
			}
			// method timers (replicated) — due ones in order, each its own dispatch
			for (let guard = 0; guard < MAX_TIMERS; guard++) {
				const due = inst.doc.timers.filter((/** @type {any} */ t) => t.at <= now).sort((/** @type {any} */ a, /** @type {any} */ b) => a.at - b.at)[0];
				if (!due) break;
				inst.doc.timers = inst.doc.timers.filter((/** @type {any} */ t) => t !== due);
				const method = inst.def[due.m];
				if (typeof method === 'function') dispatch(inst, 'after:' + due.m, method, due.a ?? []);
				else flush(inst);
			}
			for (let guard = 0; guard < MAX_TIMERS; guard++) {
				const due = inst.closures.filter((/** @type {any} */ t) => t.at <= now).sort((/** @type {any} */ a, /** @type {any} */ b) => a.at - b.at)[0];
				if (!due) break;
				inst.closures = inst.closures.filter((/** @type {any} */ t) => t !== due);
				dispatch(inst, 'after', due.fn, due.args ?? []);
			}
		}
	};

	/** a `bhv` message (already through wireValidate) @param {any} msg */
	const receive = (msg) => {
		if (!msg || msg.type !== BHV) return false;
		stats.received++;
		const inst = instances.get(String(msg.id));
		const current = inst ? inst.doc : parked.get(String(msg.id));
		if (!newerBhv(msg, current)) {
			stats.stale++;
			return false;
		}
		if (inst) {
			adopt(inst, msg);
			inst.prevState = clone(inst.state);
		} else parked.set(String(msg.id), clone(msg));
		changed();
		return true;
	};

	/** the handshake: every document this peer holds (a joiner takes the newer) */
	const snapshot = () => {
		const out = [];
		for (const inst of instances.values()) if (inst.doc.rev > 0) out.push(messageOf(inst));
		for (const [id, msg] of parked) if (!instances.has(id)) out.push(clone(msg));
		return out;
	};

	/**
	 * A knob being dragged: the value this peer's handlers read until the source is rewritten
	 * (analyze.js writes the literal; every peer reloads with it).
	 * @param {string} id @param {string} key @param {any} value
	 */
	const setParam = (id, key, value) => {
		const inst = instances.get(id);
		if (!inst || !(key in inst.params)) return false;
		const p = inst.params[key];
		if (p.type === 'number') {
			const n = Number(value);
			if (!Number.isFinite(n)) return false;
			inst.values[key] = n;
		} else if (p.type === 'boolean') inst.values[key] = !!value;
		else inst.values[key] = String(value);
		changed();
		return true;
	};

	/** what the derived view draws for an instance (null when not running) @param {string} id */
	const live = (id) => {
		const inst = instances.get(id);
		if (!inst) return null;
		return {
			id,
			name: inst.name,
			params: { ...inst.values },
			state: clone(inst.state),
			started: inst.doc.started,
			rev: inst.doc.rev,
			timers: inst.doc.timers.map((/** @type {any} */ t) => ({ method: t.m, at: t.at })),
			closures: inst.closures.length,
			fired: clone(inst.trace.fired),
			calls: clone(inst.trace.calls),
			writes: clone(inst.trace.writes),
			methods: clone(inst.trace.methods),
			errors: inst.errors.map((/** @type {any} */ e) => ({ ...e })),
			problems: [...inst.problems],
			authority: host.isAuthority(),
			synced: inst.synced
		};
	};

	return {
		start,
		stop,
		forget,
		tick,
		receive,
		snapshot,
		setParam,
		live,
		stats,
		instances,
		/** @param {() => void} fn */
		onChange(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		/**
		 * 36 (U10): a flow trigger reached the node's input `name` (flowRuntime, every peer, once per
		 * fresh stamp) — its `on.<name>` handler runs on the authority. @param {string} id
		 * @param {string} name @param {any} [payload] @returns {boolean} false = no such input
		 */
		input(id, name, payload = {}, stamp = undefined) {
			const inst = instances.get(id);
			if (!inst || !inputsOf(inst.def).includes(name)) return false;
			if (typeof inst.def.on?.[name] !== 'function') return false;
			if (handled(inst, name, stamp)) return true; // already run (here, or by a previous authority)
			if (!acts(inst)) {
				// not the authority right now: hold it a moment (the authority may be moving)
				if (typeof stamp === 'number') inst.pendingInputs.push({ name, stamp, payload, until: host.now() + INPUT_HOLD_MS });
				else stats.skippedNotAuthority++;
				return true;
			}
			runInput(inst, name, payload, stamp);
			return true;
		},
		/**
		 * 36 (U10): the host bound the behaviour's scope (its `kit` works now) — run `on.load` on THIS
		 * peer (every peer does; local, state read-only). @param {string} id
		 */
		loaded(id) {
			const inst = instances.get(id);
			const fn = inst?.def.on?.load;
			if (!inst || typeof fn !== 'function') return false;
			dispatch(inst, 'on.load', fn, [{}], { local: true });
			return true;
		},
		/** 36 (U10): the live state of an instance, by reference (flowRuntime's value outputs read it;
		 * never write it) @param {string} id */
		stateOf(id) {
			return instances.get(id)?.state ?? parked.get(id)?.state ?? null;
		},
		/** run a method by name from outside (tests, the console): one dispatch @param {string} id @param {string} method @param {...any} args */
		call(id, method, ...args) {
			const inst = instances.get(id);
			if (!inst || typeof inst.def[method] !== 'function') return undefined;
			return dispatch(inst, method, inst.def[method], args);
		}
	};
}

/** names the handler `this` reserves (for the lint) */
export { CONTEXT_MEMBERS };
