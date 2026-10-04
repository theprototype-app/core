// 34 R2 (kit-entities) — kit.spawner v2, THE PURE HALF: entities with per-copy state and the
// ONE wire type that replicates them (`kitentity`).
//
// WHY ENTITIES. Core's spawner (spawner.js, 21-B B7) makes a TRANSIENT CLONE — a physics copy
// with no nodes and no state of its own ("a spawned copy is a transient clone with no nodes",
// waves README:79-83). So Waves PRE-PLACED its robots, each with a hand-wired health chain, and
// Towers pre-placed its crates after the sensor-conveyor spawner cascaded. A kit entity is a
// record — id, kind, position, heading, hp, tags, a little data — that a template object is
// drawn FOR, and every peer agrees on it because exactly one peer writes it.
//
// ONE WRITER = THE AUTHORITY PEER (proposal §4.4 / F2: the session host, else the sim
// initiator, else the smallest peer id — kit/authority.js decides). The authority mutates the
// store, `flushMessage` turns the changes since the last flush into ONE message, every other peer
// `applyEntityMessage`s it and REFUSES a message from anyone else. No peer derives an entity: a
// mover is not deterministic across peers (it reads a live player position), so positions travel.
//
// THE MESSAGE: `{type: 'kitentity', seq, at, put?, upd?, del?, snap?}`
//  - put: full records (spawned, or a field other than pose/hp changed: tags, data, kind…)
//  - upd: compact rows `[id, x, y, z, yaw, hp, flags]` (flags bit0 = dead) for the per-tick pose
//  - del: ids that left
//  - snap: true = this is the WHOLE set (a late joiner's reply, or a new authority's first word):
//          anything the receiver holds that the snapshot does not name is gone
// `seq` increases per SENDER; a receiver refuses a non-snapshot seq <= the last one it took from
// that sender (a DataConnection is ordered, so this only ever bites a stale duplicate).
//
// BOUNDED by the spawner's own ceiling: `KIT_ENTITY_CEILING` = 200 = spawner.js's
// SPAWN_HARD_CEILING (a unit test pins the two equal — this leaf may import nothing).
//
// A PURE LEAF: it imports only its two sibling zero-import leaves (healthCore, moverCore), so it
// runs in the vitest unit layer with no browser, no peer and no scene.

import { createHealth, hpAt } from './healthCore.js';
import { createMover } from './moverCore.js';

/** live entities across every module — the spawner's global ceiling */
export const KIT_ENTITY_CEILING = 200;
/** most entities ONE spawn call may make (spawner.js SPAWN_MAX_PER_FIRE) */
export const KIT_MAX_PER_SPAWN = 20;
/** tags per entity / tag length */
export const KIT_MAX_TAGS = 8;
/** bytes of JSON `data` an entity may carry */
export const KIT_MAX_DATA = 1024;

/**
 * @typedef {object} KitEntity
 * @property {string} id
 * @property {string} kind
 * @property {string} tpl template object uuid the renderer clones ('' = none)
 * @property {string} own owning module id ('' = core / a graph)
 * @property {number[]} pos [x, y, z]
 * @property {number} yaw
 * @property {string[]} tags
 * @property {Record<string, any>} data
 * @property {number} born
 * @property {any} health healthCore block
 * @property {any} [mover] moverCore state (authority only)
 * @property {any} [mv] the mover's static params, replicated so a NEW authority can rebuild it
 * @property {number} rm seconds after death the entity is removed (-1 = never) — replicated, so a
 *   new authority still clears the dead the old one would have
 * @property {boolean} dead
 * @property {number[]} [prev] receiver: previous pose for interpolation
 * @property {number} [prevAt]
 * @property {number} [at] receiver: when `pos` was stamped
 */

/** @param {{ceiling?: number}} [opts] */
export function createEntityStore(opts = {}) {
	return {
		ceiling: Math.max(
			1,
			Math.min(KIT_ENTITY_CEILING, Math.round(Number(opts.ceiling) || KIT_ENTITY_CEILING))
		),
		/** @type {Map<string, KitEntity>} insertion order = spawn order (deterministic iteration) */
		ents: new Map(),
		nextId: 1,
		seq: 0,
		/** ids needing a full `put` on the next flush */
		dirty: new Set(),
		/** ids needing an `upd` row */
		moved: new Set(),
		/** ids removed since the last flush */
		removed: new Set(),
		/** sender -> last seq taken */
		lastSeq: new Map(),
		/** ceiling refusals (for the debug view / a toast) */
		refused: 0
	};
}

/** @param {any} v @param {number} n */
function str(v, n) {
	return typeof v === 'string' ? v.slice(0, n) : '';
}

/** @param {any} v */
function vec3(v) {
	if (Array.isArray(v) && v.length >= 3) {
		const a = [Number(v[0]), Number(v[1]), Number(v[2])];
		if (a.every(Number.isFinite)) return a;
	} else if (v && typeof v === 'object') {
		const a = [Number(v.x), Number(v.y), Number(v.z)];
		if (a.every(Number.isFinite)) return a;
	}
	return null;
}

/** bounded tags @param {any} tags @returns {string[]} */
export function cleanTags(tags) {
	if (!Array.isArray(tags)) return [];
	/** @type {string[]} */
	const out = [];
	for (const t of tags) {
		if (typeof t !== 'string' || !t) continue;
		const s = t.slice(0, 32);
		if (!out.includes(s)) out.push(s);
		if (out.length >= KIT_MAX_TAGS) break;
	}
	return out;
}

/** bounded plain-JSON data, or {} @param {any} data */
export function cleanData(data) {
	if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
	try {
		const s = JSON.stringify(data);
		if (!s || s.length > KIT_MAX_DATA) return {};
		return JSON.parse(s);
	} catch {
		return {};
	}
}

/** the static mover params that travel (so a new authority can rebuild the mover) @param {any} m */
function moverParams(m) {
	return {
		speed: m.speed,
		radius: m.radius,
		reach: m.reach,
		mode: m.mode === 'patrol' ? 'patrol' : m.mode === 'idle' ? 'idle' : m.mode,
		path: m.mode === 'patrol' ? m.path.map((/** @type {number[]} */ p) => [p[0], p[1]]) : undefined,
		loop: m.loop
	};
}

/**
 * AUTHORITY: make one entity. Returns it, or null at the ceiling.
 * @param {ReturnType<typeof createEntityStore>} store
 * @param {{kind?: string, tpl?: string, own?: string, pos?: any, yaw?: number, tags?: string[], data?: any, hp?: number, max?: number, regen?: number, armor?: number, mover?: any, removeAfter?: number}} spec
 * @param {number} t
 * @returns {KitEntity | null}
 */
export function spawnEntity(store, spec, t) {
	if (store.ents.size >= store.ceiling) {
		store.refused++;
		return null;
	}
	const id = 'k' + (store.nextId++).toString(36);
	const health = createHealth({
		max: spec.max ?? spec.hp ?? 100,
		hp: spec.hp,
		regen: spec.regen,
		armor: spec.armor
	});
	health.at = t;
	/** @type {KitEntity} */
	const e = {
		id,
		kind: str(spec.kind, 64) || 'entity',
		tpl: str(spec.tpl, 64),
		own: str(spec.own, 64),
		pos: vec3(spec.pos) ?? [0, 0, 0],
		yaw: Number.isFinite(Number(spec.yaw)) ? Number(spec.yaw) : 0,
		tags: cleanTags(spec.tags),
		data: cleanData(spec.data),
		born: t,
		health,
		dead: false,
		rm:
			Number.isFinite(Number(spec.removeAfter)) && spec.removeAfter !== null
				? Math.max(0, Number(spec.removeAfter))
				: -1
	};
	if (spec.mover) {
		e.mover = createMover(spec.mover === true ? {} : spec.mover);
		e.mv = moverParams(e.mover);
	}
	store.ents.set(id, e);
	store.dirty.add(id);
	store.removed.delete(id);
	return e;
}

/** AUTHORITY: remove one entity @param {ReturnType<typeof createEntityStore>} store @param {string} id */
export function despawnEntity(store, id) {
	if (!store.ents.delete(id)) return false;
	store.dirty.delete(id);
	store.moved.delete(id);
	store.removed.add(id);
	return true;
}

/** the full wire record of an entity. `hp` is the value AT `t` (regen folded in), so a receiver
 * that re-bases at the message stamp reads the same number as the authority from then on.
 * @param {KitEntity} e @param {number} [t] */
export function entityRecord(e, t) {
	/** @type {any} */
	const r = {
		id: e.id,
		kind: e.kind,
		tpl: e.tpl,
		own: e.own,
		pos: [e.pos[0], e.pos[1], e.pos[2]],
		yaw: e.yaw,
		hp: t === undefined ? e.health.hp : hpAt(e.health, t),
		max: e.health.max,
		dead: !!e.dead,
		regen: e.health.regen,
		tags: [...e.tags],
		data: e.data,
		born: e.born
	};
	if (e.mv) r.mv = e.mv;
	if (e.rm >= 0) r.rm = e.rm;
	return r;
}

/** @param {KitEntity} e @param {number} t @returns {any[]} */
function updRow(e, t) {
	return [e.id, e.pos[0], e.pos[1], e.pos[2], e.yaw, hpAt(e.health, t), e.dead ? 1 : 0];
}

/**
 * AUTHORITY: the changes since the last flush as ONE message, or null when nothing changed.
 * @param {ReturnType<typeof createEntityStore>} store @param {number} t
 */
export function flushMessage(store, t) {
	if (!store.dirty.size && !store.moved.size && !store.removed.size) return null;
	/** @type {any} */
	const msg = { type: 'kitentity', seq: ++store.seq, at: t };
	if (store.dirty.size) {
		msg.put = [];
		for (const id of store.dirty) {
			const e = store.ents.get(id);
			if (e) msg.put.push(entityRecord(e, t));
		}
	}
	const upd = [];
	for (const id of store.moved) {
		if (store.dirty.has(id)) continue; // the put carries the pose already
		const e = store.ents.get(id);
		if (e) upd.push(updRow(e, t));
	}
	if (upd.length) msg.upd = upd;
	if (store.removed.size) msg.del = [...store.removed];
	store.dirty.clear();
	store.moved.clear();
	store.removed.clear();
	return msg;
}

/** AUTHORITY: the whole set (a late joiner's reply; a new authority's first word)
 * @param {ReturnType<typeof createEntityStore>} store @param {number} t */
export function snapshotMessage(store, t) {
	return {
		type: 'kitentity',
		seq: ++store.seq,
		at: t,
		snap: true,
		put: [...store.ents.values()].map((e) => entityRecord(e, t))
	};
}

/**
 * RECEIVER: apply a `kitentity` message. Refused (null) when it is not from the authority (when
 * one is known) or is a stale non-snapshot. Returns what changed so the caller can fire the same
 * events the authority fired (local feel on every peer from the replicated state).
 * @param {ReturnType<typeof createEntityStore>} store
 * @param {any} msg a message wireValidate already accepted
 * @param {string} from sender peer id
 * @param {string | null} authority the peer this side believes is the authority
 */
export function applyEntityMessage(store, msg, from, authority) {
	if (authority && from !== authority) return null;
	const last = store.lastSeq.get(from) ?? -1;
	if (!msg.snap && msg.seq <= last) return null;
	store.lastSeq.set(from, msg.seq);
	const t = Number(msg.at) || 0;
	/** @type {{spawned: KitEntity[], removed: KitEntity[], damaged: {e: KitEntity, amount: number}[], healed: {e: KitEntity, amount: number}[], died: KitEntity[], revived: KitEntity[], changed: KitEntity[]}} */
	const out = {
		spawned: [],
		removed: [],
		damaged: [],
		healed: [],
		died: [],
		revived: [],
		changed: []
	};
	const seen = msg.snap ? new Set() : null;

	/** hp / dead transitions → events @param {KitEntity} e @param {number} hp @param {boolean} dead */
	const setVitals = (e, hp, dead) => {
		const before = hpAt(e.health, t);
		const wasDead = e.dead;
		e.health.hp = hp;
		e.health.at = t;
		e.health.dead = dead;
		e.dead = dead;
		if (hp < before - 1e-9) out.damaged.push({ e, amount: before - hp });
		else if (hp > before + 1e-9 && !(wasDead && !dead)) out.healed.push({ e, amount: hp - before });
		if (dead && !wasDead) {
			e.health.diedAt = t;
			out.died.push(e);
		} else if (!dead && wasDead) out.revived.push(e);
	};
	/** @param {KitEntity} e @param {number[]} pos @param {number} yaw */
	const setPose = (e, pos, yaw) => {
		e.prev = e.pos;
		e.prevAt = e.at ?? t;
		e.pos = pos;
		e.yaw = yaw;
		e.at = t;
	};

	for (const r of msg.put ?? []) {
		seen?.add(r.id);
		bumpNextId(store, r.id);
		let e = store.ents.get(r.id);
		if (!e) {
			const health = createHealth({ max: r.max, hp: r.hp, regen: r.regen });
			health.at = t;
			e = {
				id: r.id,
				kind: str(r.kind, 64) || 'entity',
				tpl: str(r.tpl, 64),
				own: str(r.own, 64),
				pos: [r.pos[0], r.pos[1], r.pos[2]],
				yaw: r.yaw,
				tags: cleanTags(r.tags),
				data: cleanData(r.data),
				born: Number(r.born) || t,
				health,
				dead: !!r.dead,
				rm: Number.isFinite(r.rm) ? Math.max(0, r.rm) : -1,
				at: t
			};
			e.health.dead = e.dead;
			if (e.dead) e.health.diedAt = t; // arrived already dead (a snapshot): count from now
			if (r.mv) e.mv = r.mv;
			store.ents.set(r.id, e);
			out.spawned.push(e);
			continue;
		}
		setPose(e, [r.pos[0], r.pos[1], r.pos[2]], r.yaw);
		e.kind = str(r.kind, 64) || e.kind;
		e.tpl = str(r.tpl, 64);
		e.tags = cleanTags(r.tags);
		e.data = cleanData(r.data);
		e.health.max = Math.max(1, Number(r.max) || e.health.max);
		if (Number.isFinite(r.regen)) e.health.regen = Math.max(0, r.regen);
		if (r.mv) e.mv = r.mv;
		setVitals(e, r.hp, !!r.dead);
		out.changed.push(e);
	}
	for (const row of msg.upd ?? []) {
		const e = store.ents.get(row[0]);
		if (!e) continue; // a pose for something we never got: the next put / snapshot fixes it
		seen?.add(row[0]);
		setPose(e, [row[1], row[2], row[3]], row[4]);
		setVitals(e, row[5], (row[6] & 1) === 1);
	}
	for (const id of msg.del ?? []) {
		const e = store.ents.get(id);
		if (e && store.ents.delete(id)) out.removed.push(e);
	}
	if (seen) {
		for (const [id, e] of [...store.ents]) {
			if (!seen.has(id)) {
				store.ents.delete(id);
				out.removed.push(e);
			}
		}
	}
	return out;
}

/** keep our own id counter past every id we have seen, so a peer that BECOMES the authority
 * never mints an id that already exists @param {ReturnType<typeof createEntityStore>} store @param {string} id */
function bumpNextId(store, id) {
	if (typeof id !== 'string' || id[0] !== 'k') return;
	const n = parseInt(id.slice(1), 36);
	if (Number.isFinite(n) && n >= store.nextId) store.nextId = n + 1;
}

/**
 * A NEW AUTHORITY: rebuild a mover for every entity that had one, from the replicated static
 * params (goals are game state the game re-issues; a patrol resumes its path at the nearest
 * waypoint). @param {ReturnType<typeof createEntityStore>} store @param {number} t
 */
export function adoptAuthority(store, t) {
	for (const e of store.ents.values()) {
		e.health.at = t;
		if (!e.mv || e.mover) continue;
		e.mover = createMover({ ...e.mv, path: e.mv.path });
		if (e.mover.mode === 'patrol' && e.mover.path.length) {
			let best = 0;
			let bd = Infinity;
			e.mover.path.forEach((/** @type {number[]} */ p, /** @type {number} */ i) => {
				const d = Math.hypot(p[0] - e.pos[0], p[1] - e.pos[2]);
				if (d < bd) {
					bd = d;
					best = i;
				}
			});
			e.mover.wp = best;
		} else if (e.mover.mode !== 'patrol') e.mover.mode = 'idle';
		e.mover.since = t;
	}
}

/**
 * RECEIVER: where to DRAW an entity at time `now` — eased from its previous pose to the stamped
 * one over the measured gap (moveSmoothing's rule, golden rule 11: smooth on the receiver, never
 * by sending faster). A jump over 3 m snaps.
 * @param {KitEntity} e @param {number} now @param {number[]} [out]
 */
export function renderPos(e, now, out = [0, 0, 0]) {
	const p = e.pos;
	const q = e.prev;
	if (!q || e.at === undefined || e.prevAt === undefined) {
		out[0] = p[0];
		out[1] = p[1];
		out[2] = p[2];
		return out;
	}
	const gap = Math.max(0.03, Math.min(0.5, e.at - e.prevAt));
	const k = Math.min(1, Math.max(0, (now - e.at) / gap));
	const jump = Math.hypot(p[0] - q[0], p[2] - q[2]) > 3;
	const f = jump ? 1 : k;
	out[0] = q[0] + (p[0] - q[0]) * f;
	out[1] = q[1] + (p[1] - q[1]) * f;
	out[2] = q[2] + (p[2] - q[2]) * f;
	return out;
}

/** a JSON-safe view of an entity for events / the api (never the live record)
 * @param {KitEntity} e @param {number} [t] */
export function entityView(e, t) {
	return {
		id: e.id,
		kind: e.kind,
		tpl: e.tpl,
		own: e.own,
		pos: [e.pos[0], e.pos[1], e.pos[2]],
		yaw: e.yaw,
		hp: e.health.hp,
		max: e.health.max,
		dead: e.dead,
		tags: [...e.tags],
		data: e.data,
		born: e.born,
		age: t === undefined ? undefined : t - e.born
	};
}
