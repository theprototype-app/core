// 34 R2 (kit-entities) — THE KIT ENTITIES RUNTIME: kit.spawner v2 + kit.health + kit.mover over
// ONE entity store, driven through a HOST ADAPTER so the same code runs in the app and in the
// headless logic sim (B5).
//
// THE HOST (everything the runtime needs from the world, nothing more):
//   now()            seconds on the SESSION clock (sessionClock in the app, the fake clock in the sim)
//   isAuthority()    is THIS peer the one writer right now (kit/authority.js)
//   authorityId()    the peer id every peer believes is the authority (null = unknown yet)
//   send(msg)        broadcast a `kitentity` message to every peer
//   request?(piece, op, args)   non-authority -> authority (the `kitreq` wire, kit-core's)
//   resolveTarget?(ref)          a target that is not an entity id: an object uuid, 'player',
//                                'player:<peerId>', 'nearestPlayer' -> [x, y, z] | null
//   world?()         {obstacles, bounds, groundY} for the movers (moverCore's shape)
//
// THE SYNC MODEL (proposal §4.4): the AUTHORITY runs every rule — spawns, damage, death, the
// movers — and flushes the changes as one `kitentity` message per tick (poses throttled to
// FLUSH_HZ, spawns / deaths / despawns at once). Every other peer applies it and fires the SAME
// events from the diff, so local feel (a sound on death, a hit flash) runs everywhere while game
// state (score, the next wave) is written once: an event carries `authority: true` only on the
// peer that should act on it. A non-authority call that would mutate is FORWARDED as a request
// (damage from the peer who shot, a knock from the peer whose hand hit) and refused locally.
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
/** requests a single peer may make per second (damage spam is a griefing vector) */
export const REQUEST_RATE = 60;
/** the biggest single damage / heal / knock a request may carry */
export const MAX_REQUEST_AMOUNT = 10000;

/**
 * @param {{now: () => number, isAuthority: () => boolean, authorityId?: () => string | null, send: (msg: any) => void, request?: (piece: string, op: string, args: any[]) => void, resolveTarget?: (ref: any) => number[] | null, world?: () => any}} host
 * @param {{ceiling?: number}} [opts]
 */
export function createKitEntities(host, opts = {}) {
	const store = createEntityStore(opts);
	/** @type {Record<string, Set<Function>>} */
	const listeners = {};
	let wasAuthority = false;
	let lastFlushAt = -Infinity;
	/** authority-local: entity id -> the ref it follows (an entity id / player ref / object uuid) */
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
	}
	/** @param {string} name @param {Function} fn @returns {() => void} */
	function on(name, fn) {
		(listeners[name] ??= new Set()).add(fn);
		return () => listeners[name]?.delete(fn);
	}

	const authority = () => !!host.isAuthority();
	const now = () => Number(host.now()) || 0;

	/** @param {string} id */
	function view(id) {
		const e = store.ents.get(id);
		return e ? entityView(e, now()) : null;
	}

	// ---- authority mutations --------------------------------------------------------------

	/** @param {any} e @param {number} t */
	function onDied(e, t) {
		follow.delete(e.id);
		if (e.mover) {
			e.mover.vel[0] = 0;
			e.mover.vel[1] = 0;
		}
	}

	/** AUTHORITY: one spawn call -> the new ids @param {any} spec @returns {string[]} */
	function spawnLocal(spec) {
		const t = now();
		const count = Math.max(1, Math.min(KIT_MAX_PER_SPAWN, Math.round(Number(spec?.count) || 1)));
		const spread = Math.max(0, Math.min(20, Number(spec?.spread) || 0));
		const at = Array.isArray(spec?.at) ? spec.at : Array.isArray(spec?.pos) ? spec.pos : [0, 0, 0];
		/** @type {string[]} */
		const ids = [];
		for (let i = 0; i < count; i++) {
			// spread on a deterministic ring (no Math.random: the suites replay it), so `count > 1`
			// never stacks bodies in one spot
			const ang = (i / count) * Math.PI * 2;
			const rad = count > 1 ? spread * (0.5 + (0.5 * ((i * 7919) % 13)) / 13) : 0;
			const pos = [
				Number(at[0]) + Math.cos(ang) * rad,
				Number(at[1]) || 0,
				Number(at[2]) + Math.sin(ang) * rad
			];
			const e = spawnEntity(store, { ...spec, pos }, t);
			if (!e) {
				emit('limit', { refused: count - i, ceiling: store.ceiling, authority: true });
				break;
			}
			ids.push(e.id);
			emit('spawn', { entity: entityView(e, t), authority: true });
		}
		return ids;
	}

	/** @param {string} id */
	function despawnLocal(id) {
		const e = store.ents.get(id);
		if (!e) return false;
		despawnEntity(store, id);
		follow.delete(id);
		emit('despawn', { entity: entityView(e, now()), authority: true });
		return true;
	}

	/** @param {string} id @param {number} amount @param {string} by */
	function damageLocal(id, amount, by) {
		const e = store.ents.get(id);
		if (!e) return { applied: 0, died: false };
		const t = now();
		const r = hDamage(e.health, Math.min(MAX_REQUEST_AMOUNT, Number(amount)), t, by);
		if (r.applied > 0 || r.died) {
			e.dead = e.health.dead;
			store.moved.add(id);
			emit('damage', { entity: entityView(e, t), amount: r.applied, by, authority: true });
		}
		if (r.died) {
			onDied(e, t);
			emit('death', { entity: entityView(e, t), by, authority: true });
		}
		return r;
	}

	/** @param {string} id @param {number} amount */
	function healLocal(id, amount) {
		const e = store.ents.get(id);
		if (!e) return 0;
		const t = now();
		const got = hHeal(e.health, Math.min(MAX_REQUEST_AMOUNT, Number(amount)), t);
		if (got > 0) {
			store.moved.add(id);
			emit('heal', { entity: entityView(e, t), amount: got, authority: true });
		}
		return got;
	}

	/** @param {string} id @param {number} [hp] */
	function reviveLocal(id, hp) {
		const e = store.ents.get(id);
		if (!e || !e.dead) return false;
		const t = now();
		hRevive(e.health, t, hp);
		e.dead = false;
		store.moved.add(id);
		emit('revive', { entity: entityView(e, t), authority: true });
		return true;
	}

	/** @param {string} id @param {any} v */
	function knockLocal(id, v) {
		const e = store.ents.get(id);
		if (!e?.mover || e.dead) return false;
		mKnock(e.mover, v, now());
		return true;
	}

	// ---- requests (non-authority -> authority) ----------------------------------------------

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
	 * AUTHORITY: a peer asked. Only the ops a player legitimately causes are honoured; the
	 * spawner and the mover's orders are game logic and run on the authority only.
	 * @param {string} piece @param {string} op @param {any[]} args @param {string} from
	 * @returns {boolean} honoured
	 */
	function handleRequest(piece, op, args, from) {
		if (!authority() || !Array.isArray(args) || !allow(String(from))) return false;
		const id = typeof args[0] === 'string' ? args[0] : '';
		if (!store.ents.has(id)) return false;
		const amount = Number(args[1]);
		if (piece === 'health' && op === 'damage' && Number.isFinite(amount) && amount > 0) {
			damageLocal(id, amount, String(from).slice(0, 64));
			return true;
		}
		if (piece === 'health' && op === 'heal' && Number.isFinite(amount) && amount > 0) {
			healLocal(id, amount);
			return true;
		}
		if (piece === 'mover' && op === 'knock' && Array.isArray(args[1]))
			return knockLocal(id, args[1]);
		return false;
	}

	/** run on the authority, or forward @param {string} piece @param {string} op @param {any[]} args @param {() => any} local */
	function authorityOr(piece, op, args, local) {
		if (authority()) return local();
		host.request?.(piece, op, args);
		return undefined;
	}

	// ---- receive ---------------------------------------------------------------------------

	/** RECEIVER: a `kitentity` message from `from` @param {any} msg @param {string} from */
	function receive(msg, from) {
		if (authority()) return false; // the one writer never takes another's word
		const out = applyEntityMessage(store, msg, from, host.authorityId?.() ?? null);
		if (!out) return false;
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
	 * Advance the kit by `dt` seconds. On the authority: follow targets, step the movers,
	 * expire the dead, flush. Everywhere: notice an authority change.
	 * @param {number} dt
	 */
	function tick(dt) {
		const t = now();
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
			const p = targetPos(ref.target);
			if (p) setGoal(e.mover, p, ref.mode, t);
			else setGoal(e.mover, null, ref.mode, t);
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
		stepMovers(ents, dt, t, host.world?.() ?? {});
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
			if (e.dead && e.rm >= 0 && t >= e.health.diedAt + e.rm) despawnLocal(e.id);

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

	/** a late joiner asked: the whole set (authority only) */
	function snapshot() {
		return authority() ? snapshotMessage(store, now()) : null;
	}

	/** @param {any} [filter] */
	function listViews(filter = {}) {
		const t = now();
		/** @type {any[]} */
		const out = [];
		for (const e of store.ents.values()) {
			if (filter.kind && e.kind !== filter.kind) continue;
			if (filter.tag && !e.tags.includes(filter.tag)) continue;
			if (filter.own !== undefined && e.own !== filter.own) continue;
			if (filter.alive === true && e.dead) continue;
			if (filter.alive === false && !e.dead) continue;
			out.push(entityView(e, t));
		}
		return out;
	}

	// ---- the three pieces (impls the spec generator wraps) ------------------------------------

	const spawner = {
		/** @param {any} spec @returns {string[]} */
		spawn: (spec) => authorityOr('spawner', 'spawn', [spec], () => spawnLocal(spec ?? {})) ?? [],
		/** @param {string} id */
		despawn: (id) => authorityOr('spawner', 'despawn', [id], () => despawnLocal(id)) ?? false,
		/** @param {string} id */
		get: (id) => view(id),
		/** @param {any} [filter] */
		list: (filter) => listViews(filter),
		/** @param {any} [filter] */
		count: (filter) => listViews(filter).length,
		/** @param {string} [own] despawn every entity (of one owner) */
		clear: (own) =>
			authorityOr('spawner', 'clear', [own], () => {
				let n = 0;
				for (const e of [...store.ents.values()])
					if (own === undefined || e.own === own) n += despawnLocal(e.id) ? 1 : 0;
				return n;
			}) ?? 0,
		/** @param {string} id @param {string[]} tags */
		setTags: (id, tags) =>
			authorityOr('spawner', 'setTags', [id, tags], () => {
				const e = store.ents.get(id);
				if (!e) return false;
				e.tags = cleanTags(tags);
				store.dirty.add(id);
				return true;
			}) ?? false,
		/** @param {string} id @param {any} patch merged into data */
		setData: (id, patch) =>
			authorityOr('spawner', 'setData', [id, patch], () => {
				const e = store.ents.get(id);
				if (!e) return false;
				e.data = cleanData({ ...e.data, ...(patch && typeof patch === 'object' ? patch : {}) });
				store.dirty.add(id);
				return true;
			}) ?? false,
		/** @param {(p: any) => void} fn */
		onSpawn: (fn) => on('spawn', fn),
		/** @param {(p: any) => void} fn */
		onDespawn: (fn) => on('despawn', fn),
		/** @param {(p: any) => void} fn */
		onLimit: (fn) => on('limit', fn)
	};

	const health = {
		/** @param {string} id @param {number} amount @param {string} [by] */
		damage: (id, amount, by) =>
			authorityOr('health', 'damage', [id, amount], () => damageLocal(id, amount, by ?? '')) ??
			null,
		/** @param {string} id @param {number} amount */
		heal: (id, amount) =>
			authorityOr('health', 'heal', [id, amount], () => healLocal(id, amount)) ?? 0,
		/** @param {string} id @param {number} [hp] */
		revive: (id, hp) =>
			authorityOr('health', 'revive', [id, hp], () => reviveLocal(id, hp)) ?? false,
		/** @param {string} id */
		hp: (id) => {
			const e = store.ents.get(id);
			return e ? hpAt(e.health, now()) : 0;
		},
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
		},
		/** @param {(p: any) => void} fn */
		onDamage: (fn) => on('damage', fn),
		/** @param {(p: any) => void} fn */
		onHeal: (fn) => on('heal', fn),
		/** @param {(p: any) => void} fn */
		onDeath: (fn) => on('death', fn),
		/** @param {(p: any) => void} fn */
		onRevive: (fn) => on('revive', fn)
	};

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

	const mover = {
		/** chase: `target` = [x,y,z] | an entity id | a host ref ('player', an object uuid…)
		 * @param {string} id @param {any} target @param {{speed?: number, reach?: number}} [opts] */
		seek: (id, target, opts) =>
			authorityOr('mover', 'seek', [id, target, opts], () => orderGoal(id, target, 'seek', opts)) ??
			false,
		/** @param {string} id @param {any} target @param {{speed?: number, reach?: number}} [opts] */
		arrive: (id, target, opts) =>
			authorityOr('mover', 'arrive', [id, target, opts], () =>
				orderGoal(id, target, 'arrive', opts)
			) ?? false,
		/** @param {string} id @param {any[]} path @param {boolean} [loop] */
		patrol: (id, path, loop) =>
			authorityOr('mover', 'patrol', [id, path, loop], () => {
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
			}) ?? false,
		/** @param {string} id */
		stop: (id) =>
			authorityOr('mover', 'stop', [id], () => {
				const e = store.ents.get(id);
				if (!e?.mover) return false;
				follow.delete(id);
				setGoal(e.mover, null, 'seek', now());
				return true;
			}) ?? false,
		/** throw it: v = [vx, vz] or [vx, vy, vz] m/s @param {string} id @param {number[]} v */
		knock: (id, v) => authorityOr('mover', 'knock', [id, v], () => knockLocal(id, v)) ?? false,
		/** @param {string} id @param {number} speed */
		setSpeed: (id, speed) =>
			authorityOr('mover', 'setSpeed', [id, speed], () => {
				const e = moverOf(id);
				const s = Number(speed);
				if (!e || !Number.isFinite(s) || s < 0) return false;
				e.mover.speed = Math.min(50, s);
				e.mv = { ...e.mv, speed: e.mover.speed };
				store.dirty.add(id);
				return true;
			}) ?? false,
		/** @param {string} id */
		state: (id) => {
			const e = store.ents.get(id);
			return e?.mover ? moverDebug(e.mover) : null;
		},
		/** @param {(p: any) => void} fn */
		onStuck: (fn) => on('stuck', fn)
	};

	/** @param {string} id @param {any} target @param {'seek'|'arrive'} mode @param {any} [opts] */
	function orderGoal(id, target, mode, opts) {
		const e = moverOf(id);
		if (!e) return false;
		if (opts && Number.isFinite(Number(opts.speed)))
			e.mover.speed = Math.max(0, Math.min(50, Number(opts.speed)));
		if (opts && Number.isFinite(Number(opts.reach)))
			e.mover.reach = Math.max(0.05, Math.min(50, Number(opts.reach)));
		const mv = { ...e.mv, mode, speed: e.mover.speed, reach: e.mover.reach };
		if (JSON.stringify(mv) !== JSON.stringify(e.mv)) {
			e.mv = mv;
			store.dirty.add(id);
		}
		if (typeof target === 'string') {
			follow.set(id, { target, mode });
			const p = targetPos(target);
			setGoal(e.mover, p, mode, now());
			return true;
		}
		follow.delete(id);
		return !!toXZ(setGoal(e.mover, target, mode, now()).goal);
	}

	return {
		spawner,
		health,
		mover,
		tick,
		receive,
		snapshot,
		handleRequest,
		/** for the debug hook / suites */
		store,
		debug: () => ({
			authority: authority(),
			count: store.ents.size,
			ceiling: store.ceiling,
			refused: store.refused,
			seq: store.seq,
			follow: follow.size
		})
	};
}
