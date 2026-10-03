// 34 R2 (kit-entities) — THE KIT ENTITIES RUNTIME: kit.spawner v2 + kit.health + kit.mover over
// ONE entity store, driven through a HOST ADAPTER so the same code runs in the app, in the kit's
// headless logic sim (B5) and in this lane's own harness.
//
// THE HOST (everything the runtime needs from the world, nothing more):
//   now()            SECONDS on the session clock (the kit core works in ms; the piece adapter divides)
//   isAuthority()    is THIS peer the one writer right now (kit/authority.js)
//   authorityId?()   the peer every peer believes is the authority (null = unknown: accept the sender)
//   me?()            this peer's id (a request from ourselves is not rate limited)
//   send(msg)        broadcast a `kitentity` message to every peer
//   call?(piece, op, args) -> {ok, value} | {pending}
//                    route a MUTATION through the kit's request path (kit/core.js): applied on the
//                    authority, a `kitreq` from anyone else, and ONCE per request id — which is what
//                    makes a node press seen by every peer spawn one wave, not one per peer
//   request?(piece, op, args)   (no kit: this lane's harness) forward a mutation to the authority
//   resolveTarget?(ref)          a target that is not an entity id: an object uuid, 'player',
//                                'player:<peerId>', 'nearestPlayer' -> [x, y, z] | null
//   world?()         {obstacles, bounds, groundY} for the movers (moverCore's shape)
//   pulse?(piece, event, payload)   an event THIS authority witnessed: pulse its flow node once
//
// THE SYNC MODEL (proposal §4.4): the AUTHORITY runs every rule — spawns, damage, death, the
// movers — and flushes the changes as one `kitentity` message per tick (poses throttled to
// FLUSH_HZ, spawns / deaths / despawns at once). Every other peer applies it and fires the SAME
// events from the diff, so local feel (a sound on death, a hit flash) runs everywhere while game
// state (score, the next wave) is written once: an event carries `authority: true` only on the
// peer that should act on it.
//
// HOST LEAVES MID-WAVE: when isAuthority() flips to true, the new authority rebuilds the movers
// from the replicated params (`adoptAuthority`) and speaks first with a SNAPSHOT, which also
// settles anything the old authority's last message left half-said.
//
// A PURE MODULE (siblings only) — the vitest unit layer runs it.

import {
	createEntityStore,
	spawnEntity,
	despawnEntity,
	flushMessage,
	snapshotMessage,
	applyEntityMessage,
	adoptAuthority,
	entityView,
	cleanTags,
	cleanData,
	KIT_MAX_PER_SPAWN
} from './entityCore.js';
import {
	damage as hDamage,
	heal as hHeal,
	revive as hRevive,
	hpAt,
	fraction as hFraction
} from './healthCore.js';
import {
	createMover,
	setGoal,
	setPath,
	knock as mKnock,
	stepMovers,
	moverDebug,
	toXZ
} from './moverCore.js';

/** pose flushes per second (a ~10-15 Hz stream, eased on receivers — golden rule 11) */
export const FLUSH_HZ = 15;
/** mutations one OTHER peer may ask for per second (damage spam is a griefing vector) */
export const REQUEST_RATE = 60;
/** the biggest single damage / heal a call may carry */
export const MAX_AMOUNT = 10000;
/** the widest area a damageArea may cover, m */
export const MAX_AREA = 50;

/** runtime event name -> [piece, spec event name] (the node / on<Name> face) */
export const EVENT_SPEC = {
	spawn: ['spawner', 'spawned'],
	despawn: ['spawner', 'despawned'],
	emptied: ['spawner', 'emptied'],
	damage: ['health', 'damaged'],
	heal: ['health', 'healed'],
	death: ['health', 'died'],
	revive: ['health', 'revived'],
	stuck: ['mover', 'stuck']
};

/**
 * @param {{now: () => number, isAuthority: () => boolean, authorityId?: () => string | null, me?: () => string | null, send: (msg: any) => void, call?: (piece: string, op: string, args: any[]) => any, request?: (piece: string, op: string, args: any[]) => void, resolveTarget?: (ref: any) => number[] | null, world?: () => any, pulse?: (piece: string, event: string, payload: any) => void}} host
 * @param {{ceiling?: number}} [opts]
 */
export function createKitEntities(host, opts = {}) {
	const store = createEntityStore(opts);
	/** @type {Record<string, Set<Function>>} */
	const listeners = {};
	let wasAuthority = false;
	let lastFlushAt = -Infinity;
	let lastTickAt = /** @type {number | null} */ (null);
	/** living entities after the last change (the `emptied` edge) */
	let livingBefore = 0;
	/** authority-local: entity id -> {target, mode} it follows (an entity id / player ref / uuid) */
	const follow = new Map();
	/** request rate: peer -> {t, n} */
	const rate = new Map();
	/** reused per tick (the hot path allocates nothing per entity) @type {any[]} */
	const ents = [];
	let scratch = new Float64Array(64);

	/** @param {string} name @param {any} payload */
	function emit(name, payload) {
		for (const fn of listeners[name] ?? []) {
			try {
				fn(payload);
			} catch (err) {
				// a throwing listener must not stop the others (nor the tick)
				console.warn('[kit] ' + name + ' listener threw', err);
			}
		}
		if (payload?.authority && host.pulse) {
			const spec = /** @type {Record<string, string[]>} */ (EVENT_SPEC)[name];
			if (spec) host.pulse(spec[0], spec[1], payload);
		}
	}
	/** @param {string} name @param {Function} fn @returns {() => void} */
	function on(name, fn) {
		(listeners[name] ??= new Set()).add(fn);
		return () => listeners[name]?.delete(fn);
	}

	const authority = () => !!host.isAuthority();
	const now = () => Number(host.now()) || 0;
	const living = () => {
		let n = 0;
		for (const e of store.ents.values()) if (!e.dead) n++;
		return n;
	};
	/** the `emptied` edge: the last living entity just died or left @param {boolean} auth */
	function checkEmptied(auth) {
		const n = living();
		if (livingBefore > 0 && n === 0) emit('emptied', { authority: auth });
		livingBefore = n;
	}

	/** @param {string} id */
	function view(id) {
		const e = store.ents.get(id);
		return e ? entityView(e, now()) : null;
	}

	// ---- THE OPS: authority-only mutations, one table ------------------------------------------

	/** @param {any} e */
	function onDied(e) {
		follow.delete(e.id);
		if (e.mover) {
			e.mover.vel[0] = 0;
			e.mover.vel[1] = 0;
		}
	}

	/** @param {string} id */
	function moverOf(id) {
		const e = store.ents.get(id);
		if (!e || e.dead) return null;
		if (!e.mover) {
			e.mover = createMover({});
			e.mv = {
				speed: e.mover.speed,
				radius: e.mover.radius,
				reach: e.mover.reach,
				mode: 'idle',
				loop: true
			};
			store.dirty.add(id);
		}
		return e;
	}

	/** @param {string} id @param {any} target @param {'seek'|'arrive'} mode @param {any} [o] */
	function orderGoal(id, target, mode, o) {
		const e = moverOf(id);
		if (!e) return false;
		if (o && Number.isFinite(Number(o.speed)))
			e.mover.speed = Math.max(0, Math.min(50, Number(o.speed)));
		if (o && Number.isFinite(Number(o.reach)))
			e.mover.reach = Math.max(0.05, Math.min(50, Number(o.reach)));
		const mv = { ...e.mv, mode, speed: e.mover.speed, reach: e.mover.reach };
		if (JSON.stringify(mv) !== JSON.stringify(e.mv)) {
			e.mv = mv;
			store.dirty.add(id);
		}
		if (typeof target === 'string' && target) {
			follow.set(id, { target, mode });
			setGoal(e.mover, targetPos(target), mode, now());
			return true;
		}
		follow.delete(id);
		return !!setGoal(e.mover, target, mode, now()).goal;
	}

	/** entities of a kind (empty = every kind), living only @param {any} kind */
	function ofKind(kind) {
		const k = typeof kind === 'string' ? kind : '';
		return [...store.ents.values()].filter((e) => !e.dead && (!k || e.kind === k));
	}

	/** spawn(spec) or spawn(kind, template, at, count, spread, hp, speed, removeAfter) — the code
	 * face takes one options object, the node face its positional args @param {any[]} args */
	function spawnSpec(args) {
		const a0 = args[0];
		if (a0 && typeof a0 === 'object' && !Array.isArray(a0)) return a0;
		const [kind, template, at, count, spread, hp, speed, removeAfter] = args;
		/** @type {any} */
		const spec = {
			kind,
			tpl: typeof template === 'string' ? template : '',
			at,
			count,
			spread,
			hp,
			removeAfter
		};
		if (Number(speed) > 0) spec.mover = { speed: Number(speed) };
		return spec;
	}

	/** @type {Record<string, Record<string, (args: any[], by: string) => any>>} */
	const OPS = {
		spawner: {
			spawn(args) {
				const spec = spawnSpec(args);
				const t = now();
				const count = Math.max(1, Math.min(KIT_MAX_PER_SPAWN, Math.round(Number(spec.count) || 1)));
				const spread = Math.max(0, Math.min(20, Number(spec.spread) || 0));
				const tplRef = spec.tpl ?? spec.template;
				// unplaced: where the template stands (a node with nothing wired into `at`)
				const at = Array.isArray(spec.at)
					? spec.at
					: Array.isArray(spec.pos)
						? spec.pos
						: ((typeof tplRef === 'string' && tplRef ? host.resolveTarget?.(tplRef) : null) ?? [
								0, 0, 0
							]);
				/** @type {string[]} */
				const ids = [];
				for (let i = 0; i < count; i++) {
					// spread on a deterministic ring (no Math.random: the suites replay it), so
					// `count > 1` never stacks bodies in one spot
					const ang = (i / count) * Math.PI * 2;
					const rad = count > 1 ? spread * (0.5 + (0.5 * ((i * 7919) % 13)) / 13) : 0;
					const pos = [
						(Number(at[0]) || 0) + Math.cos(ang) * rad,
						Number(at[1]) || 0,
						(Number(at[2]) || 0) + Math.sin(ang) * rad
					];
					const e = spawnEntity(store, { ...spec, tpl: tplRef, pos }, t);
					if (!e) {
						emit('limit', { refused: count - i, ceiling: store.ceiling, authority: true });
						break;
					}
					ids.push(e.id);
					emit('spawn', { entity: entityView(e, t), authority: true });
				}
				livingBefore = living();
				return ids;
			},
			despawn([id]) {
				const e = store.ents.get(id);
				if (!e) return false;
				despawnEntity(store, id);
				follow.delete(id);
				emit('despawn', { entity: entityView(e, now()), authority: true });
				checkEmptied(true);
				return true;
			},
			clear([kind]) {
				const k = typeof kind === 'string' ? kind : '';
				let n = 0;
				for (const e of [...store.ents.values()])
					if (!k || e.kind === k) n += OPS.spawner.despawn([e.id], '') ? 1 : 0;
				return n;
			},
			setTags([id, tags]) {
				const e = store.ents.get(id);
				if (!e) return false;
				e.tags = cleanTags(tags);
				store.dirty.add(id);
				return true;
			},
			setData([id, patch]) {
				const e = store.ents.get(id);
				if (!e) return false;
				e.data = cleanData({ ...e.data, ...(patch && typeof patch === 'object' ? patch : {}) });
				store.dirty.add(id);
				return true;
			}
		},
		health: {
			damage([id, amount], by) {
				const e = store.ents.get(id);
				if (!e) return { applied: 0, died: false };
				const t = now();
				const r = hDamage(e.health, Math.min(MAX_AMOUNT, Number(amount)), t, by);
				if (r.applied > 0 || r.died) {
					e.dead = e.health.dead;
					store.moved.add(id);
					emit('damage', { entity: entityView(e, t), amount: r.applied, by, authority: true });
				}
				if (r.died) {
					onDied(e);
					emit('death', { entity: entityView(e, t), by, authority: true });
					checkEmptied(true);
				}
				return r;
			},
			damageArea([at, radius, amount, kind], by) {
				const p = toXZ(at);
				const r = Math.max(0, Math.min(MAX_AREA, Number(radius) || 0));
				if (!p) return 0;
				let n = 0;
				for (const e of ofKind(kind)) {
					if (Math.hypot(e.pos[0] - p[0], e.pos[2] - p[1]) > r) continue;
					if (OPS.health.damage([e.id, amount], by).applied > 0) n++;
				}
				return n;
			},
			heal([id, amount]) {
				const e = store.ents.get(id);
				if (!e) return 0;
				const t = now();
				const got = hHeal(e.health, Math.min(MAX_AMOUNT, Number(amount)), t);
				if (got > 0) {
					store.moved.add(id);
					emit('heal', { entity: entityView(e, t), amount: got, authority: true });
				}
				return got;
			},
			revive([id, hp]) {
				const e = store.ents.get(id);
				if (!e || !e.dead) return false;
				const t = now();
				hRevive(e.health, t, hp);
				e.dead = false;
				store.moved.add(id);
				emit('revive', { entity: entityView(e, t), authority: true });
				livingBefore = living();
				return true;
			}
		},
		mover: {
			seek: ([id, target, o]) => orderGoal(id, target, 'seek', o),
			arrive: ([id, target, o]) => orderGoal(id, target, 'arrive', o),
			patrol([id, path, loop]) {
				const e = moverOf(id);
				if (!e) return false;
				follow.delete(id);
				setPath(e.mover, path, loop !== false, now());
				e.mv = {
					...e.mv,
					mode: 'patrol',
					path: e.mover.path.map((/** @type {number[]} */ p) => [p[0], p[1]]),
					loop: e.mover.loop
				};
				store.dirty.add(id);
				return e.mover.path.length > 0;
			},
			stop([id]) {
				const e = store.ents.get(id);
				if (!e?.mover) return false;
				follow.delete(id);
				setGoal(e.mover, null, 'seek', now());
				return true;
			},
			knock([id, v]) {
				const e = store.ents.get(id);
				if (!e?.mover || e.dead) return false;
				mKnock(e.mover, v, now());
				return true;
			},
			setSpeed([id, speed]) {
				const e = moverOf(id);
				const s = Number(speed);
				if (!e || !Number.isFinite(s) || s < 0) return false;
				e.mover.speed = Math.min(50, s);
				e.mv = { ...e.mv, speed: e.mover.speed };
				store.dirty.add(id);
				return true;
			},
			/** every living entity of a kind (empty = all) follows a target (a ref string; empty =
			 * the nearest player) @param {any[]} args */
			chase([kind, target]) {
				const ref =
					typeof target === 'string' && target && target !== '-None-' ? target : 'nearestPlayer';
				let n = 0;
				for (const e of ofKind(kind)) n += orderGoal(e.id, ref, 'seek') ? 1 : 0;
				return n;
			},
			halt([kind]) {
				let n = 0;
				for (const e of ofKind(kind)) n += OPS.mover.stop([e.id], '') ? 1 : 0;
				return n;
			}
		}
	};

	/** @param {string} from */
	function allow(from) {
		const t = now();
		const r = rate.get(from) ?? { t, n: 0 };
		if (t - r.t >= 1) {
			r.t = t;
			r.n = 0;
		}
		r.n++;
		rate.set(from, r);
		return r.n <= REQUEST_RATE;
	}

	/**
	 * AUTHORITY: run one op. `from` = the peer that asked (null / me = this peer's own call); a
	 * mutation another peer asked for is rate limited and its damage is attributed to the asker,
	 * never to a `by` it claims. Returns the op's value, or undefined when refused.
	 * @param {string} piece @param {string} op @param {any[]} args @param {string | null} [from]
	 */
	function applyOp(piece, op, args, from = null) {
		if (!authority()) return undefined;
		const fn = OPS[piece]?.[op];
		if (typeof fn !== 'function' || !Array.isArray(args)) return undefined;
		const self = !from || from === host.me?.();
		if (!self && !allow(String(from))) return undefined;
		const by = self
			? String(
					(piece === 'health' && typeof args[2] === 'string' && args[2]) || host.me?.() || ''
				).slice(0, 64)
			: String(from).slice(0, 64);
		return fn(args, by);
	}

	/** a mutation from wherever it was asked @param {string} piece @param {string} op @param {any[]} args */
	function call(piece, op, args) {
		if (host.call) {
			const r = host.call(piece, op, args);
			return r && typeof r === 'object' && 'value' in r ? r.value : undefined;
		}
		if (authority()) return applyOp(piece, op, args, null);
		host.request?.(piece, op, args);
		return undefined;
	}

	/** AUTHORITY (this lane's harness): a peer's forwarded request @param {string} piece @param {string} op @param {any[]} args @param {string} from */
	function handleRequest(piece, op, args, from) {
		return applyOp(piece, op, args, from) !== undefined;
	}

	// ---- receive ---------------------------------------------------------------------------

	/** RECEIVER: a `kitentity` message from `from` @param {any} msg @param {string | null} from */
	function receive(msg, from) {
		if (authority()) return false; // the one writer never takes another's word
		const out = applyEntityMessage(store, msg, String(from ?? ''), host.authorityId?.() ?? null);
		if (!out) return false;
		if (wasAuthority) {
			// somebody else writes now (a returning host): our movers are no longer the truth
			wasAuthority = false;
			for (const e of store.ents.values()) delete e.mover;
			follow.clear();
		}
		const t = now();
		for (const e of out.spawned) emit('spawn', { entity: entityView(e, t), authority: false });
		for (const { e, amount } of out.damaged)
			emit('damage', { entity: entityView(e, t), amount, by: e.health.by, authority: false });
		for (const { e, amount } of out.healed)
			emit('heal', { entity: entityView(e, t), amount, authority: false });
		for (const e of out.died)
			emit('death', { entity: entityView(e, t), by: e.health.by, authority: false });
		for (const e of out.revived) emit('revive', { entity: entityView(e, t), authority: false });
		for (const e of out.removed) emit('despawn', { entity: entityView(e, t), authority: false });
		checkEmptied(false);
		return true;
	}

	// ---- the tick -------------------------------------------------------------------------

	/** resolve a follow target to [x, z] @param {any} ref */
	function targetPos(ref) {
		if (typeof ref === 'string') {
			const e = store.ents.get(ref);
			if (e) return e.dead ? null : toXZ(e.pos);
			const p = host.resolveTarget?.(ref);
			return p ? toXZ(p) : null;
		}
		return toXZ(ref);
	}

	/**
	 * Advance the kit. On the authority: follow targets, step the movers, expire the dead,
	 * flush. Everywhere: notice becoming the authority. `dt` (seconds) defaults to the time since
	 * the last tick on the host clock.
	 * @param {number} [dt]
	 */
	function tick(dt) {
		const t = now();
		if (dt === undefined) dt = lastTickAt === null ? 0 : t - lastTickAt;
		lastTickAt = t;
		const isAuth = authority();
		if (isAuth && !wasAuthority) {
			// we just became the writer (session start, or the host left mid-wave)
			adoptAuthority(store, t);
			lastFlushAt = -Infinity;
			wasAuthority = true;
			host.send(snapshotMessage(store, t));
			emit('authority', { authority: true });
		} else if (!isAuth && wasAuthority) {
			wasAuthority = false;
			for (const e of store.ents.values()) delete e.mover;
			follow.clear();
			emit('authority', { authority: false });
		}
		if (!isAuth) return;

		// follow targets -> goals
		for (const [id, ref] of follow) {
			const e = store.ents.get(id);
			if (!e?.mover || e.dead) continue;
			setGoal(e.mover, targetPos(ref.target), ref.mode, t);
		}
		// step every living mover, mark the ones that moved
		ents.length = 0;
		for (const e of store.ents.values()) ents.push(e);
		if (scratch.length < ents.length * 5)
			scratch = new Float64Array(Math.max(64, ents.length * 10));
		for (let i = 0; i < ents.length; i++) {
			const e = ents[i];
			const o = i * 5;
			scratch[o] = e.pos[0];
			scratch[o + 1] = e.pos[1];
			scratch[o + 2] = e.pos[2];
			scratch[o + 3] = e.yaw;
			scratch[o + 4] = e.mover?.stuckCount ?? 0;
		}
		if (dt > 0) stepMovers(ents, dt, t, host.world?.() ?? {});
		for (let i = 0; i < ents.length; i++) {
			const e = ents[i];
			if (!e.mover) continue;
			const o = i * 5;
			if (
				e.pos[0] !== scratch[o] ||
				e.pos[1] !== scratch[o + 1] ||
				e.pos[2] !== scratch[o + 2] ||
				e.yaw !== scratch[o + 3]
			)
				store.moved.add(e.id);
			if (e.mover.stuckCount > scratch[o + 4])
				emit('stuck', {
					entity: entityView(e, t),
					recovery: e.mover.route.length ? 'repath' : 'sidestep',
					authority: true
				});
		}
		// the dead leave after their time (`rm` rides the record, so this holds across a hand-over)
		for (const e of ents)
			if (e.dead && e.rm >= 0 && t >= e.health.diedAt + e.rm) OPS.spawner.despawn([e.id], '');

		// flush: structure changes at once, poses at FLUSH_HZ
		const structural = store.dirty.size > 0 || store.removed.size > 0;
		if (structural || t - lastFlushAt >= 1 / FLUSH_HZ - 1e-6) {
			const msg = flushMessage(store, t);
			if (msg) {
				host.send(msg);
				lastFlushAt = t;
			}
		}
	}

	/** a late joiner asked: the whole set (authority only, null elsewhere) */
	function snapshot() {
		return authority() ? snapshotMessage(store, now()) : null;
	}

	/** forget everything (a scene clear — every peer clears; nothing is sent) */
	function reset() {
		store.ents.clear();
		store.dirty.clear();
		store.moved.clear();
		store.removed.clear();
		follow.clear();
		livingBefore = 0;
	}

	/** @param {any} [filter] */
	function listViews(filter = {}) {
		const t = now();
		/** @type {any[]} */
		const out = [];
		for (const e of store.ents.values()) {
			if (filter?.kind && e.kind !== filter.kind) continue;
			if (filter?.tag && !e.tags.includes(filter.tag)) continue;
			if (filter?.own !== undefined && e.own !== filter.own) continue;
			if (filter?.alive === true && e.dead) continue;
			if (filter?.alive === false && !e.dead) continue;
			out.push(entityView(e, t));
		}
		return out;
	}
	/** count, node style: a kind string (empty = all, living only) or a filter object @param {any} f */
	const countOf = (f) =>
		typeof f === 'string' || f === undefined || f === null
			? listViews({ kind: f || undefined, alive: true }).length
			: listViews(f).length;

	// ---- the three pieces' implementations (what the spec generator wraps) ---------------------

	/** @param {string} piece @param {string} op */
	const mut =
		(piece, op) =>
		(/** @type {any[]} */ ...args) =>
			call(piece, op, args);
	/** `on(specEventName, fn)` for kitApi: spec names -> runtime names @param {string} piece */
	const onFor = (piece) => (/** @type {string} */ specName, /** @type {Function} */ fn) => {
		const name = Object.entries(EVENT_SPEC).find(
			([, v]) => v[0] === piece && v[1] === specName
		)?.[0];
		return name ? on(name, fn) : () => {};
	};

	const spawner = {
		spawn: (/** @type {any[]} */ ...args) => call('spawner', 'spawn', args) ?? [],
		despawn: mut('spawner', 'despawn'),
		clear: mut('spawner', 'clear'),
		count: countOf,
		on: onFor('spawner'),
		extra: {
			setTags: mut('spawner', 'setTags'),
			setData: mut('spawner', 'setData'),
			/** @param {string} id */
			get: (id) => view(id),
			/** @param {any} [filter] {kind?, tag?, own?, alive?} */
			list: (filter) => listViews(filter),
			/** @param {Function} fn */
			onLimit: (fn) => on('limit', fn)
		}
	};

	const health = {
		damage: mut('health', 'damage'),
		damageArea: mut('health', 'damageArea'),
		heal: mut('health', 'heal'),
		revive: mut('health', 'revive'),
		/** @param {string} id */
		hp: (id) => {
			const e = store.ents.get(id);
			return e ? hpAt(e.health, now()) : 0;
		},
		on: onFor('health'),
		extra: {
			/** @param {string} id */
			max: (id) => store.ents.get(id)?.health.max ?? 0,
			/** @param {string} id */
			fraction: (id) => {
				const e = store.ents.get(id);
				return e ? hFraction(e.health, now()) : 0;
			},
			/** @param {string} id */
			alive: (id) => {
				const e = store.ents.get(id);
				return !!e && !e.dead;
			}
		}
	};

	const mover = {
		chase: mut('mover', 'chase'),
		halt: mut('mover', 'halt'),
		knock: mut('mover', 'knock'),
		on: onFor('mover'),
		extra: {
			seek: mut('mover', 'seek'),
			arrive: mut('mover', 'arrive'),
			patrol: mut('mover', 'patrol'),
			stop: mut('mover', 'stop'),
			setSpeed: mut('mover', 'setSpeed'),
			/** @param {string} id */
			state: (id) => {
				const e = store.ents.get(id);
				return e?.mover ? moverDebug(e.mover) : null;
			}
		}
	};

	return {
		spawner,
		health,
		mover,
		/** the flat code face this lane's harness and the debug hook use */
		api: {
			spawner: {
				...spawner.extra,
				spawn: spawner.spawn,
				despawn: spawner.despawn,
				clear: spawner.clear,
				count: spawner.count,
				onSpawn: (/** @type {Function} */ fn) => on('spawn', fn),
				onDespawn: (/** @type {Function} */ fn) => on('despawn', fn),
				onEmptied: (/** @type {Function} */ fn) => on('emptied', fn)
			},
			health: {
				...health.extra,
				damage: health.damage,
				damageArea: health.damageArea,
				heal: health.heal,
				revive: health.revive,
				hp: health.hp,
				onDamage: (/** @type {Function} */ fn) => on('damage', fn),
				onHeal: (/** @type {Function} */ fn) => on('heal', fn),
				onDeath: (/** @type {Function} */ fn) => on('death', fn),
				onRevive: (/** @type {Function} */ fn) => on('revive', fn)
			},
			mover: {
				...mover.extra,
				chase: mover.chase,
				halt: mover.halt,
				knock: mover.knock,
				onStuck: (/** @type {Function} */ fn) => on('stuck', fn)
			}
		},
		applyOp,
		tick,
		receive,
		snapshot,
		reset,
		handleRequest,
		/** for the renderer / debug hook / suites */
		store,
		debug: () => ({
			authority: authority(),
			count: store.ents.size,
			living: living(),
			ceiling: store.ceiling,
			refused: store.refused,
			seq: store.seq,
			follow: follow.size
		})
	};
}
