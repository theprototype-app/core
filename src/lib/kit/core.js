// 34 R2 (T3) — THE KIT RUNTIME: one replicated document, ONE writer, every peer reads.
//
// A pure LEAF (imports only its siblings): no svelte, no three, no peer. Everything the outside
// world provides comes in through a HOST adapter, which is what lets the same code run in the
// app (src/lib/kit/runtime.js binds it to the session clock, the peer mesh, safeStorage and the
// game singleton) and in the headless logic sim (tests/unit/sim/logicSim.js binds it to a fake
// clock and an in-memory wire with N fake peers).
//
// THE MODEL (proposal §4.4 / fork F2, the spawner's "the INITIATOR spawns and everybody else
// receives" rule extended to game logic):
//   · the shared kit state is ONE document `{rev, at, by, rids, slices: {piece: slice}}`;
//   · ONLY the authority peer (kit/authority.js) changes it: an action on any other peer is a
//     REQUEST (`kitreq`) the authority applies — so two peers pressing Start in the same
//     millisecond start ONE round, and a score is added once however many peers saw the pulse;
//   · the authority broadcasts the whole document after each change (`kit`, latest-wins on
//     (rev, at, by) — it is small: a few hundred bytes for a played round) plus the EVENTS that
//     change produced, which every peer's listeners hear (sounds, banners: local feel);
//   · a request carries an id (`rid`) the document remembers (`rids`, the last 64), so a request
//     re-sent after the authority LEFT is applied exactly once by the next one — the requester
//     keeps it pending until the id shows up in a document it receives;
//   · timers are DERIVED from document stamps (an intro that ends 3 s after `phaseAt`, a pickup
//     back 10 s after it was taken), and the authority's tick turns a due moment into an op.
//
// A PIECE is `{spec, initial(), normalize?(slice), ops: {name: reducer}, tick?(slice, ctx),
// make(ctx) -> impl}`. A reducer `(slice, args, ctx) -> {slice?, events?, also?, result?} |
// undefined` is PURE over its slice (it never touches another piece's slice — `also` queues an
// op on another piece inside the SAME change, e.g. a pickup granting score), runs only on the
// authority, and may refuse by returning `{result: {ok: false, reason}}` with no slice.

import { kitApi, kitNodeItems, parseKitNodeType, argsFromData } from './spec.js';

/** wire types (wireValidate carries their shapes) */
export const KIT_DOC = 'kit';
export const KIT_REQ = 'kitreq';
/** how many request ids a document remembers (the once-only window) */
export const RID_WINDOW = 64;
/** a pending request is sent again after this long without being acknowledged (ms) */
export const RESEND_MS = 1200;

/**
 * @typedef {{
 *   me: () => string | null,
 *   now?: () => number,
 *   clock?: {now: () => number},
 *   send: (msg: any) => void,
 *   isAuthority: () => boolean,
 *   authorityId?: () => string | null,
 *   nameOf?: (id: string) => string,
 *   storage?: {get: (key: string, fallback?: any) => any, set: (key: string, value: any) => any},
 *   game?: {get: () => any, set: (state: string, opts?: any) => any, restart?: (opts?: any) => any},
 *   emit?: (piece: string, event: string, payload: any, opts?: {local?: boolean}) => void,
 *   rules?: any
 * }} KitHost
 */

/**
 * Is document `a` newer than `b`? LATEST-WINS on the session-clock stamp `at` (the gameState
 * rule): every write stamps `max(now, previous + 1)`, so one writer's documents climb, a new
 * authority continues past the last one it saw, and a RESET (a scene clear) stamps fresh and
 * beats the stale document a peer that missed the clear would offer back. `rev` then `by`
 * break exact ties. @param {any} a @param {any} b
 */
export function newerDoc(a, b) {
	if (!b) return true;
	if ((a.at ?? 0) !== (b.at ?? 0)) return (a.at ?? 0) > (b.at ?? 0);
	if ((a.rev ?? 0) !== (b.rev ?? 0)) return (a.rev ?? 0) > (b.rev ?? 0);
	return String(a.by ?? '') > String(b.by ?? '');
}

let ridCounter = 0;
/** @param {string | null} me */
function makeRid(me) {
	ridCounter = (ridCounter + 1) % 1e9;
	return (me ?? 'local') + ':' + Date.now().toString(36) + ':' + ridCounter.toString(36);
}

/** a deep copy of plain JSON data (slices, args) @param {any} v */
function clone(v) {
	return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/**
 * Build a kit over a host. `pieces` is the KIT_PIECES table (index.js) or a test's own subset.
 * @param {KitHost} host @param {{name: string, piece: any}[]} pieces
 */
export function createKit(host, pieces) {
	const now = () => (host.clock ? host.clock.now() : host.now ? host.now() : Date.now());
	/** @type {Record<string, any>} */
	const defs = {};
	for (const row of pieces) defs[row.name] = row.piece;

	/** @returns {any} */
	const freshDoc = () => ({
		rev: 0,
		at: 0,
		by: '',
		rids: [],
		slices: Object.fromEntries(Object.entries(defs).map(([name, def]) => [name, def.initial()]))
	});
	let doc = freshDoc();
	/** rid -> the request, until a document acknowledges it @type {Map<string, any>} */
	const pending = new Map();
	/** `piece.event` -> listeners @type {Map<string, Set<(payload: any) => void>>} */
	const listeners = new Map();
	/** document listeners (any change) @type {Set<() => void>} */
	const changeListeners = new Set();
	/** per-piece LOCAL state a piece's make() may keep (registrations that are code, not data) */
	/** @type {Record<string, any>} */
	const locals = {};
	/** what the kit did, for tests and the debug hook */
	const stats = { applied: 0, refused: 0, requests: 0, resent: 0, received: 0, stale: 0, duplicate: 0 };

	/** @param {string} key @param {any} payload */
	const fire = (key, payload) => {
		for (const fn of [...(listeners.get(key) ?? [])]) {
			try {
				fn(payload);
			} catch (error) {
				// a game's listener throwing must not stop the kit (or the next listener)
				console.warn('kit: listener for ' + key + ' failed', error);
			}
		}
	};
	/** deliver a change's events: listeners everywhere, node pulses only where it happened
	 * @param {{piece: string, name: string, payload: any}[]} events @param {boolean} witnessed */
	const deliver = (events, witnessed) => {
		for (const ev of events) {
			fire(ev.piece + '.' + ev.name, ev.payload);
			if (witnessed) host.emit?.(ev.piece, ev.name, ev.payload);
		}
		for (const fn of [...changeListeners]) {
			try {
				fn();
			} catch (error) {
				console.warn('kit: change listener failed', error);
			}
		}
	};

	/** the ctx a piece's reducers / make() / tick() see @param {string} piece @param {string | null} [from] */
	const ctxFor = (piece, from = null) => ({
		piece,
		from: from ?? host.me(),
		now,
		me: () => host.me(),
		isAuthority: () => host.isAuthority(),
		/** a peer's display name (the roster's; the id when the host has none) @param {string} id */
		nameOf: (id) => host.nameOf?.(id) || id,
		/** the authority's id as this peer sees it (null when the host cannot say) */
		authorityId: () => host.authorityId?.() ?? null,
		slice: () => doc.slices[piece],
		/** another piece's slice (read-only) @param {string} other */
		read: (other) => doc.slices[other],
		storage: host.storage ?? null,
		game: host.game ?? null,
		rules: host.rules ?? null,
		local: (locals[piece] ??= {}),
		/** broadcast a piece's OWN wire message (34-kit-entities' `kitentity`) @param {any} msg */
		send: (msg) => host.send(msg),
		/** change shared state through the authority @param {string} op @param {any[]} [args] */
		request: (op, args = []) => request(piece, op, args),
		/** @param {string} name @param {(payload: any) => void} fn */
		on: (name, fn) => on(piece + '.' + name, fn),
		/** a LOCAL event (a spec call with `local: true`): this peer's listeners, and this peer's
		 * node pulse kept local (the per-player rule) — nothing goes on the wire
		 * @param {string} name @param {any} [payload] */
		emitLocal: (name, payload = null) => {
			fire(piece + '.' + name, payload);
			host.emit?.(piece, name, payload, { local: true });
		},
		onChange,
		kit: () => kit
	});

	/**
	 * THE ONE WRITE (authority only): run an op and everything it queues as ONE change.
	 * @param {string} piece @param {string} op @param {any[]} args @param {string | null} from @param {string | null} rid
	 */
	const apply = (piece, op, args, from, rid) => {
		/** @type {Record<string, any>} */
		const draft = { ...doc.slices };
		/** @type {{piece: string, name: string, payload: any}[]} */
		const events = [];
		/** @type {[string, string, any[]][]} */
		const queue = [[piece, op, args]];
		let changed = false;
		/** @type {any} */
		let result;
		let first = true;
		let guard = 0;
		while (queue.length && guard++ < 32) {
			const [p, o, a] = /** @type {[string, string, any[]]} */ (queue.shift());
			const reducer = defs[p]?.ops?.[o];
			if (typeof reducer !== 'function') {
				if (first) result = { ok: false, reason: 'unknown op ' + p + '.' + o };
				first = false;
				continue;
			}
			const ctx = { ...ctxFor(p, from), slice: () => draft[p], read: (/** @type {string} */ other) => draft[other] };
			let r;
			try {
				r = reducer(draft[p], clone(a) ?? [], ctx);
			} catch (error) {
				console.warn('kit: ' + p + '.' + o + ' failed', error);
				r = { result: { ok: false, reason: String(error) } };
			}
			if (first) result = r?.result ?? (r?.slice !== undefined ? { ok: true } : r?.result);
			first = false;
			if (r?.slice !== undefined && r.slice !== draft[p]) {
				draft[p] = r.slice;
				changed = true;
			}
			for (const [name, payload] of r?.events ?? []) events.push({ piece: p, name, payload: payload ?? null });
			for (const next of r?.also ?? []) queue.push([next[0], next[1], next[2] ?? []]);
		}
		if (result?.ok === false) stats.refused++;
		if (!changed && !events.length && !rid) return result;
		const rids = rid ? [...doc.rids, rid].slice(-RID_WINDOW) : doc.rids;
		doc = { rev: doc.rev + 1, at: Math.max(now(), (doc.at ?? 0) + 1), by: host.me() ?? '', rids, slices: draft };
		stats.applied++;
		host.send({ type: KIT_DOC, doc, ev: events });
		deliver(events, true);
		return result;
	};

	/** the request id a NODE action carries while it runs (see runNodeAction) @type {string | null} */
	let nodeRid = null;

	/** @param {string} piece @param {string} op @param {any[]} args */
	const request = (piece, op, args) => {
		stats.requests++;
		// a node action's id is derived from its trigger STAMP, so every peer that sees one
		// press asks with the SAME id and the authority applies it once
		const fixed = nodeRid;
		if (fixed && (doc.rids.includes(fixed) || pending.has(fixed))) {
			stats.duplicate++;
			return { ok: true, duplicate: true };
		}
		if (host.isAuthority()) return apply(piece, op, args, host.me(), fixed);
		const rid = fixed ?? makeRid(host.me());
		const req = { type: KIT_REQ, rid, piece, op, args: clone(args) ?? [], from: host.me() ?? '' };
		pending.set(rid, { req, sentAt: now() });
		host.send(req);
		return { ok: true, pending: true, rid };
	};

	/** @param {string} key @param {(payload: any) => void} fn */
	const on = (key, fn) => {
		if (!listeners.has(key)) listeners.set(key, new Set());
		listeners.get(key)?.add(fn);
		return () => listeners.get(key)?.delete(fn);
	};
	/** @param {() => void} fn */
	const onChange = (fn) => {
		changeListeners.add(fn);
		return () => changeListeners.delete(fn);
	};

	/** @param {any} incoming */
	const normalizeDoc = (incoming) => {
		/** @type {Record<string, any>} */
		const slices = {};
		for (const [name, def] of Object.entries(defs)) {
			const raw = incoming?.slices?.[name];
			slices[name] = raw === undefined ? def.initial() : def.normalize ? def.normalize(raw) : raw;
		}
		// a slice a NEWER peer's piece wrote is kept verbatim (the normalize-spreads rule)
		for (const [name, raw] of Object.entries(incoming?.slices ?? {})) if (!(name in slices)) slices[name] = raw;
		return {
			rev: Number(incoming?.rev) || 0,
			at: Number(incoming?.at) || 0,
			by: String(incoming?.by ?? ''),
			rids: Array.isArray(incoming?.rids) ? incoming.rids.slice(-RID_WINDOW).map(String) : [],
			slices
		};
	};

	/** an incoming kit message (already shape-checked by wireValidate). A type that is neither
	 * `kit` nor `kitreq` is OFFERED to the pieces (`def.receive(msg, from, ctx)` -> handled), with
	 * the sender's id for a piece that checks its single writer.
	 * @param {any} msg @param {string | null} [from] */
	const receive = (msg, from = null) => {
		if (!msg || typeof msg !== 'object') return false;
		if (msg.type !== KIT_DOC && msg.type !== KIT_REQ) {
			for (const [name, def] of Object.entries(defs)) if (def.receive?.(msg, from ?? null, ctxFor(name))) return true;
			return false;
		}
		if (msg.type === KIT_DOC) {
			stats.received++;
			if (!newerDoc(msg.doc, doc)) {
				stats.stale++;
				return false;
			}
			doc = normalizeDoc(msg.doc);
			for (const rid of doc.rids) pending.delete(rid);
			deliver(Array.isArray(msg.ev) ? msg.ev : [], false);
			return true;
		}
		if (msg.type === KIT_REQ) {
			if (!host.isAuthority()) return false; // the requester re-sends to whoever is next
			if (doc.rids.includes(msg.rid)) {
				stats.duplicate++;
				return false;
			}
			apply(String(msg.piece), String(msg.op), Array.isArray(msg.args) ? msg.args : [], String(msg.from ?? ''), String(msg.rid));
			return true;
		}
		return false;
	};

	/** per frame on EVERY peer: the authority turns due moments into ops and adopts orphaned
	 * requests; everyone else re-sends what was never acknowledged. */
	const tick = () => {
		if (host.isAuthority()) {
			// requests this peer made while somebody else was the authority: apply them now
			for (const [rid, entry] of [...pending]) {
				pending.delete(rid);
				if (doc.rids.includes(rid)) continue;
				apply(entry.req.piece, entry.req.op, entry.req.args, entry.req.from, rid);
			}
			for (const [name, def] of Object.entries(defs)) {
				if (typeof def.tick !== 'function') continue;
				let ops;
				try {
					ops = def.tick(doc.slices[name], ctxFor(name));
				} catch (error) {
					console.warn('kit: ' + name + ' tick failed', error);
					ops = null;
				}
				for (const [op, args] of ops ?? []) apply(name, op, args ?? [], host.me(), null);
			}
			return;
		}
		const t = now();
		for (const entry of pending.values()) {
			if (t - entry.sentAt < RESEND_MS) continue;
			entry.sentAt = t;
			stats.resent++;
			host.send(entry.req);
		}
	};

	/** the handshake payload for a joiner (no events: arriving history fires nothing) */
	const snapshot = () => ({ type: KIT_DOC, doc: clone(doc), ev: [] });
	/** every handshake message: the document, then each piece's own (`def.snapshot(ctx)`, null = none) */
	const snapshots = () => [
		snapshot(),
		...Object.entries(defs)
			.map(([name, def]) => (typeof def.snapshot === 'function' ? def.snapshot(ctxFor(name)) : null))
			.filter(Boolean)
	];

	/** forget everything (a scene clear: every peer clears too) — local, sends nothing */
	const reset = () => {
		// an authoritative LOCAL write: stamped fresh so it beats a stale document on arrival
		doc = { ...freshDoc(), at: Math.max(now(), (doc.at ?? 0) + 1), by: host.me() ?? '' };
		pending.clear();
		for (const [name, def] of Object.entries(defs)) {
			try {
				def.reset?.(ctxFor(name));
			} catch (error) {
				console.warn('kit: ' + name + ' reset failed', error);
			}
		}
		deliver([], false);
	};

	/** @type {Record<string, any>} */
	const impls = {};
	/** @type {Record<string, any>} */
	const kit = {
		receive,
		tick,
		snapshot,
		snapshots,
		reset,
		on,
		onChange,
		stats,
		pending,
		/** the current document (read-only by convention) */
		doc: () => doc,
		/** @param {string} piece */
		slice: (piece) => doc.slices[piece],
		/** the raw piece implementations (reads + actions + extras) */
		impls,
		/** the specs, in table order */
		specs: () => pieces.map((row) => row.piece.spec),
		/** build the SDK face of every piece for one module @param {{onDispose?: (fn: () => void) => any, moduleId?: string}} [ctx] */
		api: (ctx) => Object.fromEntries(pieces.map((row) => [row.name, kitApi(row.piece.spec, impls[row.name], ctx)])),
		/** every generated node item */
		nodeItems: () => pieces.flatMap((row) => kitNodeItems(row.piece.spec)),
		/** A NODE'S PATH INTO THE SAME FUNCTION THE API CALLS: an action node fired, with its
		 * resolved data. `opts.rid` = an id every peer derives the same way from the trigger
		 * (`node:<id>:<stamp>`), which is what makes a replicated press — seen by every peer —
		 * one change. Returns what the call returned (null for a non-action type).
		 * @param {string} type @param {Record<string, any>} data @param {{rid?: string}} [opts] */
		runNodeAction(type, data, opts = {}) {
			const parsed = parseKitNodeType(type);
			const call = parsed && defs[parsed.piece]?.spec.calls.find((/** @type {any} */ c) => c.name === parsed.call);
			if (!parsed || !call || call.kind !== 'action') return null;
			nodeRid = opts.rid ? String(opts.rid).slice(0, 128) : null;
			try {
				return impls[parsed.piece][call.name](...argsFromData(call, data));
			} finally {
				nodeRid = null;
			}
		},
		/** a value node's reading @param {string} type @param {Record<string, any>} data */
		evalNodeValue(type, data) {
			const parsed = parseKitNodeType(type);
			const call = parsed && defs[parsed.piece]?.spec.calls.find((/** @type {any} */ c) => c.name === parsed.call);
			if (!parsed || !call || call.kind !== 'value') return undefined;
			return impls[parsed.piece][call.name](...argsFromData(call, data));
		}
	};
	for (const row of pieces) impls[row.name] = row.piece.make(ctxFor(row.name));
	return kit;
}
