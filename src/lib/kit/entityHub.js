// 34 R2 (kit-entities) — THE THREE ENTITY PIECES' SHARED RUNTIME inside a kit (kit/core.js).
//
// kit.spawner, kit.health and kit.mover are three KIT_PIECES rows (three specs, three node
// groups, three `api.kit.*` namespaces) over ONE entity store: one `createKitEntities` per kit
// instance, found through the kit object (a WeakMap — the app has one kit, the logic sim one per
// fake peer). How each piece plugs into the kit core:
//
//   ops       every mutation is an op on its piece. The kit core runs it on the authority (a
//             `kitreq` from anyone else, applied ONCE per request id — so an action NODE seen by
//             every peer spawns one wave, not one per peer); the reducer touches no slice (the
//             entities live in their own store, replicated on their own wire) and hands back
//             `{result: {ok, value}}`
//   make      the piece's impl (what kitApi / the node generator wraps): mutations route through
//             `ctx.request` — the kit's once-only path — reads come straight off the store
//   tick      (spawner only, so the runtime steps once) the authority's frame: movers, deaths,
//             the 15 Hz `kitentity` flush; dt from the kit clock
//   receive   (spawner only) a `kitentity` message from its sender; `getkitentities` = a
//             joiner asking the authority for the whole set
//   snapshot  (spawner only) the handshake's whole set, authority only
//   reset     a scene clear drops every entity (every peer clears; nothing is sent)
//
// WORLD HOOKS the app adapter sets per kit (`setEntityHost`): resolveTarget (an object uuid /
// 'player' / 'nearestPlayer' -> a place), world (obstacles + bounds for the movers), pulse (an
// event the authority witnessed -> pulse its flow node). Absent = a bare world (the sim).
//
// A PURE MODULE (siblings only).

import { createKitEntities } from './entities.js';

/** kit -> the entities runtime @type {WeakMap<object, any>} */
const runtimes = new WeakMap();
/** kit -> the world hooks @type {WeakMap<object, any>} */
const hooks = new WeakMap();
/** kit -> each entity piece's ctx (its request path) @type {WeakMap<object, Record<string, any>>} */
const ctxs = new WeakMap();

/** the app adapter's per-kit world hooks @param {object} kit @param {{resolveTarget?: (ref: any, from?: number[]) => number[] | null, world?: () => any, pulse?: (piece: string, event: string, payload: any) => void, entityOf?: (object: any) => string | null}} h */
export function setEntityHost(kit, h) {
	hooks.set(kit, { ...(hooks.get(kit) ?? {}), ...h });
}

/** the entities runtime of a kit (created on first use) @param {any} ctx a piece ctx (kit/core.js ctxFor) */
export function entitiesFor(ctx) {
	const kit = ctx.kit();
	const map = ctxs.get(kit) ?? {};
	map[ctx.piece] = ctx;
	ctxs.set(kit, map);
	let rt = runtimes.get(kit);
	if (rt) return rt;
	rt = createKitEntities({
		// the kit clock is session MILLISECONDS; the entities runtime works in seconds
		now: () => Number(ctx.now()) / 1000,
		isAuthority: () => ctx.isAuthority(),
		authorityId: () => (typeof ctx.authorityId === 'function' ? ctx.authorityId() : null),
		me: () => ctx.me(),
		send: (msg) => ctx.send(msg),
		// mutations ride the kit's request path of THEIR piece (once per request id)
		call: (piece, op, args) => (ctxs.get(kit)?.[piece] ?? ctx).request(op, args),
		resolveTarget: (ref, from) => hooks.get(kit)?.resolveTarget?.(ref, from) ?? null,
		world: () => hooks.get(kit)?.world?.() ?? {},
		pulse: (piece, event, payload) => hooks.get(kit)?.pulse?.(piece, event, payload)
	});
	// the app's click path: a drawn copy (or any child of one) -> its entity id
	rt.spawner.extra.entityOf = (/** @type {any} */ object) =>
		hooks.get(kit)?.entityOf?.(object) ?? null;
	runtimes.set(kit, rt);
	return rt;
}

/** the entities runtime of a kit object, if any piece has made it (the app adapter, the debug hook) @param {object} kit */
export function entitiesOfKit(kit) {
	return runtimes.get(kit) ?? null;
}

/**
 * One entity piece row's `piece`. `opsList` = the piece's mutation ops (reducers that run the
 * runtime's applyOp on the authority); `primary` = the piece that ticks / receives / snapshots.
 * @param {any} spec @param {string[]} opsList @param {boolean} primary
 */
export function entityPiece(spec, opsList, primary) {
	const name = spec.piece;
	/** @type {Record<string, (slice: any, args: any[], ctx: any) => any>} */
	const ops = {};
	for (const op of opsList) {
		ops[op] = (_slice, args, ctx) => {
			const value = entitiesFor(ctx).applyOp(name, op, args, ctx.from);
			return {
				result: value === undefined ? { ok: false, reason: 'refused' } : { ok: true, value }
			};
		};
	}
	/** @type {any} */
	const piece = {
		spec,
		initial: () => ({}),
		ops,
		/** @param {any} ctx */
		make: (ctx) => entitiesFor(ctx)[name],
		/** a scene clear (kit/core.js reset -> def.reset(ctx)) @param {any} ctx */
		reset: (ctx) => entitiesFor(ctx).reset()
	};
	if (primary) {
		/** the authority's frame (kit/core.js calls tick on the authority only) */
		piece.tick = (/** @type {any} */ _slice, /** @type {any} */ ctx) => {
			entitiesFor(ctx).tick();
			return [];
		};
		piece.receive = (
			/** @type {any} */ msg,
			/** @type {string | null} */ from,
			/** @type {any} */ ctx
		) => {
			const rt = entitiesFor(ctx);
			if (msg?.type === 'kitentity') {
				rt.receive(msg, from);
				return true;
			}
			if (msg?.type === 'getkitentities') {
				const snap = rt.snapshot();
				if (snap) ctx.send(snap);
				return true;
			}
			return false;
		};
		piece.snapshot = (/** @type {any} */ ctx) => entitiesFor(ctx).snapshot();
	}
	return piece;
}
