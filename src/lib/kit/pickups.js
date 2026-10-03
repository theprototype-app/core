// 34 R2 — kit.pickups: COLLECT ONCE, COME BACK LATER, GRANT SOMETHING — what the collectible
// module (1099 LOC, localStorage x4) and every "gem" chain of Latch + Once + Delay + Set Variable
// built per object.
//
//   taken / respawn   the kit DOCUMENT: the authority takes a pickup once (a second take before it
//                     is back is refused), and its return is DERIVED from the stamp (`at` +
//                     respawn seconds) — the authority's tick turns a due return into `respawned`
//   grants            `score` -> kit.score (the shared total + the taker's row, in the SAME change),
//                     `time` -> kit.round.extend; any other grant (health, ammo…) rides the
//                     `collected` event's payload for the game (or 34-kit-entities' health) to apply
//   who took it       the requesting peer (a perPlayer On Click / touch is asked only by its
//                     player), unless named
//   touch             `touchCheck(playerPos, positionOf)` — the app calls it ~10x a second with
//                     THIS player's position, so a player walking into a pickup takes it; every
//                     peer only ever asks for itself
//   a new round       puts every pickup back (authority tick on the kit round number)
//
// Pickups are registered in code (`register({id, score?, respawn?, radius?, grants?})`, the same
// on every peer) or come from a node's own args (an unregistered id taken by a Collect node uses
// the node's score/respawn) — so a graph author needs no code at all.

import { bodyDistance } from '../playReach.js';
import spec from './pickups.spec.js';

const initial = () => ({ taken: {}, round: 0, autoReset: true });

/** @param {any} v @param {number} d */
const num = (v, d) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : d;
};

/** is a pickup there to take at `now`? @param {any} entry the taken row @param {number} now */
export function availableAt(entry, now) {
	if (!entry) return true;
	if (!entry.respawn) return false;
	return now >= entry.at + entry.respawn * 1000;
}

export default {
	spec,
	initial,
	/** @param {any} raw */
	normalize(raw) {
		/** @type {Record<string, any>} */
		const taken = {};
		for (const [id, row] of Object.entries(raw?.taken && typeof raw.taken === 'object' ? raw.taken : {}))
			taken[String(id).slice(0, 64)] = { by: String(/** @type {any} */ (row)?.by ?? ''), at: num(/** @type {any} */ (row)?.at, 0), respawn: Math.max(0, num(/** @type {any} */ (row)?.respawn, 0)) };
		return { taken, round: num(raw?.round, 0), autoReset: raw?.autoReset !== false };
	},
	ops: {
		/** @param {any} s @param {any[]} args @param {any} ctx */
		collect(s, [pickup, score, respawn, player], ctx) {
			const id = String(pickup ?? '').slice(0, 64);
			if (!id) return { result: { ok: false, reason: 'no pickup named' } };
			const now = ctx.now();
			// a take in the new round's first frame meets the new round's pickups
			const round = ctx.read('round')?.round ?? 0;
			if (s.autoReset && round && round !== s.round) s = { ...s, taken: {}, round };
			if (!availableAt(s.taken[id], now)) return { result: { ok: false, reason: 'already taken' } };
			const reg = ctx.local.registry?.get(id);
			const grants = { ...(reg?.grants ?? {}) };
			const points = num(reg ? reg.score : score, 0);
			if (points) grants.score = points;
			const back = Math.max(0, num(reg ? reg.respawn : respawn, 0));
			const by = String(player || ctx.from || '').slice(0, 64);
			const taken = { ...s.taken, [id]: { by, at: now, respawn: back } };
			/** @type {[string, string, any[]][]} */
			const also = [];
			if (grants.score) also.push(['score', 'add', [grants.score, by]]);
			if (num(grants.time, 0) > 0) also.push(['round', 'extend', [num(grants.time, 0)]]);
			/** @type {[string, any][]} */
			const events = [['collected', { id, by, grants }]];
			const registered = [...(ctx.local.registry?.keys() ?? [])];
			if (registered.length && registered.every((k) => !availableAt(taken[k], now))) events.push(['allCollected', { count: registered.length }]);
			return { slice: { ...s, taken }, events, also, result: { ok: true, grants } };
		},
		/** @param {any} s @param {any[]} args */
		respawn(s, [id]) {
			if (!s.taken[id]) return undefined;
			const taken = { ...s.taken };
			delete taken[id];
			return { slice: { ...s, taken }, events: [['respawned', { id }]] };
		},
		/** @param {any} s @param {any[]} args */
		configureReset(s, [autoReset]) {
			const a = autoReset !== false;
			return a === s.autoReset ? { result: { ok: true } } : { slice: { ...s, autoReset: a } };
		},
		/** @param {any} s @param {any[]} args */
		resetPickups(s, [round]) {
			const r = round == null ? s.round : num(round, s.round);
			if (!Object.keys(s.taken).length && r === s.round) return { result: { ok: true } };
			return { slice: { ...s, taken: {}, round: r } };
		}
	},
	/** due returns and a new round, on the authority @param {any} s @param {any} ctx */
	tick(s, ctx) {
		const round = ctx.read('round')?.round ?? 0;
		if (s.autoReset && round && round !== s.round) return [['resetPickups', [round]]];
		const now = ctx.now();
		/** @type {[string, any[]][]} */
		const ops = [];
		for (const [id, entry] of Object.entries(s.taken)) if (entry.respawn && availableAt(entry, now)) ops.push(['respawn', [id]]);
		return ops.length ? ops : null;
	},
	/** @param {any} ctx */
	make(ctx) {
		/** id -> {score, respawn, radius, grants} (LOCAL: code) @type {Map<string, any>} */
		const registry = (ctx.local.registry ??= new Map());
		const s = () => ctx.slice() ?? initial();
		/** ids this peer already asked for and has not heard back about (touch must not spam) */
		/** @type {Map<string, number>} */
		const asked = (ctx.local.asked ??= new Map());
		const collect = (/** @type {any} */ pickup, score = 1, respawn = 0, player = '') => ctx.request('collect', [pickup, score, respawn, player]);
		return {
			collect,
			resetPickups: () => ctx.request('resetPickups', []),
			/** @param {string} pickup */
			available: (pickup) => availableAt(s().taken[String(pickup ?? '')], ctx.now()),
			taken: () => Object.values(s().taken).filter((e) => !availableAt(e, ctx.now())).length,
			left: () => [...registry.keys()].filter((id) => availableAt(s().taken[id], ctx.now())).length,
			on: ctx.on,
			tracked: { register: 1 },
			extra: {
				/**
				 * A pickup (code, the same on every peer): `{id, score?: 1, respawn?: 0 (s, 0 =
				 * never), radius?: 0.6 (m, for touch), grants?: {time?, health?, …}}`. Returns off.
				 * @param {any} def
				 */
				register(def) {
					const id = String(def?.id ?? '').slice(0, 64);
					if (!id) return () => {};
					const entry = {
						score: num(def.score, 1),
						respawn: Math.max(0, num(def.respawn, 0)),
						radius: Math.max(0.05, num(def.radius, 0.6)),
						grants: def.grants && typeof def.grants === 'object' ? { ...def.grants } : {}
					};
					registry.set(id, entry);
					return () => {
						if (registry.get(id) === entry) registry.delete(id);
					};
				},
				/** who took it, or '' @param {string} id */
				takenBy: (id) => {
					const e = s().taken[String(id)];
					return e && !availableAt(e, ctx.now()) ? e.by : '';
				},
				/** registered ids */
				ids: () => [...registry.keys()],
				/**
				 * THIS player touches: every registered pickup within its radius of the player's BODY
				 * (the feet..eye segment, the reach rule — a gem on the floor is touched by walking
				 * over it) that is there to take is asked for (once until the answer lands).
				 * `positionOf(id)` -> [x, y, z] | null (the app reads the scene). Returns the ids asked.
				 * @param {number[]} eye @param {(id: string) => number[] | null} positionOf
				 * @param {number} [feetY] default: 1.6 m under the eye
				 */
				touchCheck(eye, positionOf, feetY) {
					const now = ctx.now();
					/** @type {string[]} */
					const out = [];
					for (const [id, reg] of registry) {
						if (!availableAt(s().taken[id], now)) {
							asked.delete(id);
							continue;
						}
						if ((asked.get(id) ?? 0) > now - 1500) continue;
						const p = positionOf(id);
						if (!p) continue;
						const d = bodyDistance({ x: p[0], y: p[1], z: p[2] }, { x: eye[0], y: eye[1], z: eye[2] }, feetY ?? eye[1] - 1.6);
						if (d > reg.radius) continue;
						asked.set(id, now);
						collect(id);
						out.push(id);
					}
					return out;
				},
				/** `{autoReset: false}`: pickups stay taken across rounds @param {any} opts */
				configure: (opts) => ctx.request('configureReset', [opts?.autoReset])
			}
		};
	}
};
