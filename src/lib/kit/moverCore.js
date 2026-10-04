// 34 R2 (kit-entities) — kit.mover, THE PURE HALF: steering agents on the ground plane.
//
// WHY THIS EXISTS. Waves' robots never steered: `enemyPosition` is a closed-form function of
// time (a straight line from the portal to the goal), so a robot had no idea a pillar or a
// friend stood in its way, and the W1 class ("robots stuck … stop walking") could only be
// fixed for the clock bug, never for a blocked lane. A mover is an agent with a GOAL and the
// five things a game asks of it: seek / arrive / patrol, keep apart from its neighbours
// (separation), notice it is not getting anywhere (STUCK) and get out of it (sidestep, then a
// re-path around the obstacles), and come back to rest after a hit throws it about (knock-back RE-SEAT).
//
// ONE WRITER. Only the authority peer steps movers (kit/entities.js); every other peer is told
// where an entity is by the `kitentity` wire. So this file needs to be deterministic only for
// the suites — it is, anyway: no Math.random, no Date.now, iteration in the caller's order.
//
// A ZERO-IMPORT LEAF (the vitest unit-layer rule) — positions are plain [x, y, z] arrays, the
// world is plain data ({obstacles, bounds, groundY}). Hot path: `stepMovers` allocates nothing
// per entity per frame beyond what a mode change needs.
//
// Units: metres, seconds. The plane is XZ; y is the ground height (re-seated after a knock).

/** what a fresh mover asks for — every key can be overridden per entity */
export const MOVER_DEFAULTS = Object.freeze({
	/** cruise speed, m/s */
	speed: 2,
	/** how fast the velocity turns toward the desired one, m/s² */
	accel: 12,
	/** body radius — separation and obstacle push-out use it */
	radius: 0.4,
	/** "in reach": closer than this to the goal counts as arrived (stops, never STUCK) */
	reach: 0.6,
	/** arrive mode starts slowing this far out */
	slow: 1.5,
	/** weight of the separation push relative to the cruise speed */
	separation: 1.2,
	/** seconds without `progress` metres of headway toward the goal → STUCK */
	stuckAfter: 0.8,
	/** headway that counts as getting somewhere */
	progress: 0.2,
	/** seconds one recovery sidestep lasts */
	sidestep: 0.7,
	/** sidesteps tried before the mover RE-PATHS (a route around the static obstacles) */
	maxSidesteps: 2,
	/** how far out the fallback detour waypoint is placed when no route exists, m */
	detour: 2.5,
	/** a route waypoint not reached in this many seconds drops the route */
	detourTimeout: 3,
	/** weight of the look-ahead steer away from a static obstacle in front */
	avoid: 0.8
});

/** a mover's MODE */
export const MOVER_MODES = ['idle', 'seek', 'arrive', 'patrol'];

/** grid re-plans one step may run: a crowd that jams at once queues its plans over the next
 * frames instead of spiking one (measured: 200 movers piling onto a wall, 8 ms -> see suite) */
export const MAX_PLANS_PER_STEP = 2;

/** knock velocity below this (m/s) has ended: re-seat */
const KNOCK_END = 0.15;
/** knock-back decays as exp(-KNOCK_DAMP · t) */
const KNOCK_DAMP = 5;
/** the longest a knock may last before it is forced to re-seat (a knock into a corner) */
const KNOCK_MAX = 1.5;

/**
 * A fresh mover state. Plain data, so it can ride an entity record (the wire only carries
 * position — the mover itself never leaves the authority, and a NEW authority rebuilds it
 * from the entity's goal fields, see `reviveMover`).
 * @param {Partial<typeof MOVER_DEFAULTS> & {mode?: string, goal?: number[] | null, path?: number[][], loop?: boolean}} [opts]
 */
export function createMover(opts = {}) {
	/** @type {any} */
	const m = { ...MOVER_DEFAULTS };
	for (const k of Object.keys(MOVER_DEFAULTS)) {
		const v = Number(/** @type {any} */ (opts)[k]);
		if (/** @type {any} */ (opts)[k] !== undefined && Number.isFinite(v) && v >= 0) m[k] = v;
	}
	m.mode = MOVER_MODES.includes(String(opts.mode))
		? String(opts.mode)
		: opts.goal || opts.path
			? 'seek'
			: 'idle';
	if (opts.path && opts.mode === undefined) m.mode = 'patrol';
	m.goal = toXZ(opts.goal);
	m.path = Array.isArray(opts.path) ? opts.path.map(toXZ).filter(Boolean) : [];
	m.loop = opts.loop !== false;
	m.wp = 0;
	m.dirWp = 1;
	m.vel = [0, 0];
	m.arrived = false;
	/** queued behind a body that has arrived (or is itself queued): waiting, not stuck */
	m.waiting = false;
	// stuck tracking
	m.best = Infinity;
	m.since = -1;
	m.recUntil = -1;
	m.side = 0;
	m.tries = 0;
	/** the distance to the target when the current stuck episode began (tries reset only on
	 * headway past THIS — a sidestep that happens to shorten the distance is not an escape) */
	m.stuckBest = Infinity;
	/** @type {number[][]} waypoints of a re-path (route[0] = the next one) */
	m.route = [];
	m.routeUntil = -1;
	m.losAt = 0;
	m.noPlanUntil = 0;
	m.repaths = 0;
	m.stuckCount = 0;
	// knock-back
	m.knock = [0, 0];
	m.knockSince = -1;
	m.reseats = 0;
	return m;
}

/** [x, z] from [x, y, z] / [x, z] / {x, z}, or null @param {any} v @returns {number[] | null} */
export function toXZ(v) {
	if (Array.isArray(v)) {
		const x = Number(v[0]);
		const z = Number(v.length >= 3 ? v[2] : v[1]);
		return Number.isFinite(x) && Number.isFinite(z) ? [x, z] : null;
	}
	if (v && typeof v === 'object') {
		const x = Number(v.x);
		const z = Number(v.z);
		return Number.isFinite(x) && Number.isFinite(z) ? [x, z] : null;
	}
	return null;
}

/** set a new goal (seek / arrive); resets the stuck tracker so a fresh order is not "stuck"
 * @param {any} m @param {any} goal @param {'seek'|'arrive'} [mode] @param {number} [t] */
export function setGoal(m, goal, mode = 'seek', t = -1) {
	const g = toXZ(goal);
	if (!g) {
		m.mode = 'idle';
		m.goal = null;
		return m;
	}
	const moved = !m.goal || Math.hypot(m.goal[0] - g[0], m.goal[1] - g[1]) > m.reach;
	m.goal = g;
	m.mode = mode === 'arrive' ? 'arrive' : 'seek';
	// a goal that slides along with a chased player must NOT reset the tracker every frame —
	// that would make a robot pinned behind a pillar look busy forever. Only a jump does.
	if (moved && m.mode !== 'patrol') resetStuck(m, t);
	return m;
}

/** patrol along a path of points @param {any} m @param {any[]} path @param {boolean} [loop] @param {number} [t] */
export function setPath(m, path, loop = true, t = -1) {
	m.path = (Array.isArray(path) ? path : []).map(toXZ).filter(Boolean);
	m.loop = loop !== false;
	m.wp = 0;
	m.dirWp = 1;
	m.mode = m.path.length ? 'patrol' : 'idle';
	resetStuck(m, t);
	return m;
}

/** @param {any} m @param {number} t */
function resetStuck(m, t) {
	m.best = Infinity;
	m.since = t;
	m.tries = 0;
	m.stuckBest = Infinity;
	m.recUntil = -1;
	m.route = [];
	m.routeUntil = -1;
}

/**
 * Throw the mover: `v` = [vx, vz] m/s (the hit's impulse over its mass). Steering stops until
 * the knock has decayed, then the mover RE-SEATS (ground height, inside bounds, out of
 * obstacles) and its stuck tracker starts over — a knock is not "no progress".
 * @param {any} m @param {number[]} v @param {number} t
 */
export function knock(m, v, t) {
	const x = Number(v?.[0]);
	const z = Number(v?.[v.length >= 3 ? 2 : 1]);
	if (!Number.isFinite(x) || !Number.isFinite(z)) return m;
	// bounded: a hostile or broken caller cannot launch an entity out of the level
	const s = Math.hypot(x, z);
	const k = s > 30 ? 30 / s : 1;
	m.knock[0] += x * k;
	m.knock[1] += z * k;
	m.knockSince = t;
	return m;
}

/** the point the mover is heading for right now, or null @param {any} m @returns {number[] | null} */
export function currentTarget(m) {
	if (m.route.length) return m.route[0];
	if (m.mode === 'patrol') return m.path[m.wp] ?? null;
	if (m.mode === 'seek' || m.mode === 'arrive') return m.goal;
	return null;
}

/**
 * Push a point out of every obstacle (circles and boxes on XZ), inside the bounds, by the
 * body radius. Mutates `p` ([x, y, z]). Returns true when it moved anything.
 * @param {number[]} p @param {number} r @param {any} world
 */
export function pushOut(p, r, world) {
	let moved = false;
	const obs = world?.obstacles ?? [];
	for (let i = 0; i < obs.length; i++) {
		const o = obs[i];
		if (o.r !== undefined) {
			// circle {x, z, r}
			const dx = p[0] - o.x;
			const dz = p[2] - o.z;
			const min = o.r + r;
			const d2 = dx * dx + dz * dz;
			if (d2 >= min * min) continue;
			const d = Math.sqrt(d2);
			if (d < 1e-6) {
				p[0] = o.x + min; // dead centre: a fixed direction, deterministic
			} else {
				p[0] = o.x + (dx / d) * min;
				p[2] = o.z + (dz / d) * min;
			}
			moved = true;
		} else {
			// box {minX, minZ, maxX, maxZ}, inflated by the radius; leave by the nearest face
			const x0 = o.minX - r;
			const x1 = o.maxX + r;
			const z0 = o.minZ - r;
			const z1 = o.maxZ + r;
			if (p[0] <= x0 || p[0] >= x1 || p[2] <= z0 || p[2] >= z1) continue;
			const dl = p[0] - x0;
			const dr = x1 - p[0];
			const dn = p[2] - z0;
			const df = z1 - p[2];
			const m = Math.min(dl, dr, dn, df);
			if (m === dl) p[0] = x0;
			else if (m === dr) p[0] = x1;
			else if (m === dn) p[2] = z0;
			else p[2] = z1;
			moved = true;
		}
	}
	const b = world?.bounds;
	if (b) {
		const cx = Math.min(b.maxX - r, Math.max(b.minX + r, p[0]));
		const cz = Math.min(b.maxZ - r, Math.max(b.minZ + r, p[2]));
		if (cx !== p[0] || cz !== p[2]) moved = true;
		p[0] = cx;
		p[2] = cz;
	}
	return moved;
}

/** ground height under (x, z) @param {any} world @param {number} x @param {number} z @param {number} fallback */
function groundAt(world, x, z, fallback) {
	const g = world?.groundY;
	if (typeof g === 'function') {
		const y = Number(g(x, z));
		return Number.isFinite(y) ? y : fallback;
	}
	return typeof g === 'number' && Number.isFinite(g) ? g : fallback;
}

/**
 * The nearest thing in front of the mover (an obstacle or another entity) — the BLOCKER the
 * recovery steps around. Returns the side (+1 left / -1 right of the heading) it sits on, or 0.
 * @param {any} e @param {number} dx @param {number} dz unit heading @param {any[]} ents @param {any} world
 */
function blockerSide(e, dx, dz, ents, world) {
	const px = e.pos[0];
	const pz = e.pos[2];
	const look = e.mover.radius * 4 + 0.5;
	let best = Infinity;
	let side = 0;
	/** @param {number} cx @param {number} cz @param {number} cr */
	const consider = (cx, cz, cr) => {
		const rx = cx - px;
		const rz = cz - pz;
		const ahead = rx * dx + rz * dz;
		if (ahead <= 0 || ahead > look + cr) return;
		const lateral = rx * -dz + rz * dx; // + = left of heading
		if (Math.abs(lateral) > cr + e.mover.radius * 1.5) return;
		if (ahead < best) {
			best = ahead;
			side = lateral >= 0 ? 1 : -1;
		}
	};
	for (const o of world?.obstacles ?? []) {
		if (o.r !== undefined) consider(o.x, o.z, o.r);
		else
			consider(
				(o.minX + o.maxX) / 2,
				(o.minZ + o.maxZ) / 2,
				Math.hypot(o.maxX - o.minX, o.maxZ - o.minZ) / 2
			);
	}
	for (const o of ents)
		if (o !== e && o.mover !== undefined && !o.dead)
			consider(o.pos[0], o.pos[2], o.mover?.radius ?? 0.4);
	return side;
}

/** a stable ±1 from an id, so two movers stuck nose to nose pick DIFFERENT first sides
 * @param {string} id */
export function idSide(id) {
	let h = 0;
	const s = String(id);
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return h & 1 ? 1 : -1;
}

/**
 * Step every mover by `dt` seconds at time `t`. `ents` = [{id, pos: [x,y,z], yaw?, dead?,
 * mover}] — entities without a mover (or dead) are still obstacles to the others' separation
 * when alive. Mutates pos / yaw / mover; returns the number of entities that moved.
 *
 * The order per mover: knock (no steering while thrown) → target (route / waypoint / goal)
 * → desired velocity (seek full speed, arrive slows, both stop in reach) → recovery
 * sidestep overrides → separation → accel-limited velocity → integrate → push out of
 * obstacles + bounds → hard overlap resolve → stuck bookkeeping.
 * @param {any[]} ents @param {number} dt @param {number} t @param {any} [world]
 * @returns {number}
 */
export function stepMovers(ents, dt, t, world = {}) {
	if (!(dt > 0)) return 0;
	dt = Math.min(dt, 0.1); // a stalled frame must not teleport through a wall
	let movedCount = 0;
	let plans = 0;
	for (let i = 0; i < ents.length; i++) {
		const e = ents[i];
		const m = e.mover;
		if (!m || e.dead) continue;
		const px0 = e.pos[0];
		const pz0 = e.pos[2];

		// ---- knock-back: thrown, not steering -----------------------------------------
		const kx = m.knock[0];
		const kz = m.knock[1];
		if (kx !== 0 || kz !== 0) {
			e.pos[0] += kx * dt;
			e.pos[2] += kz * dt;
			const f = Math.exp(-KNOCK_DAMP * dt);
			m.knock[0] = kx * f;
			m.knock[1] = kz * f;
			pushOut(e.pos, m.radius, world);
			if (Math.hypot(m.knock[0], m.knock[1]) < KNOCK_END || t - m.knockSince > KNOCK_MAX) {
				// RE-SEAT: on the ground, inside the level, out of anything solid; the stuck
				// tracker starts over (a knock is not "no progress"), velocity is the throw's end
				m.knock[0] = 0;
				m.knock[1] = 0;
				m.vel[0] = 0;
				m.vel[1] = 0;
				pushOut(e.pos, m.radius, world);
				e.pos[1] = groundAt(world, e.pos[0], e.pos[2], e.pos[1]);
				m.reseats++;
				resetStuck(m, t);
			}
			movedCount++;
			continue;
		}

		// ---- target ---------------------------------------------------------------------
		let target = currentTarget(m);
		if (m.route.length) {
			const g = m.mode === 'patrol' ? m.path[m.wp] : m.goal;
			// a route is only for getting ROUND something: once the straight line to the real goal
			// is clear (checked a few times a second), drop it and go direct
			if (g && t >= m.losAt) {
				m.losAt = t + 0.25;
				if (segmentClear(e.pos[0], e.pos[2], g[0], g[1], m.radius, world)) {
					m.route = [];
					target = currentTarget(m);
				}
			}
		}
		if (m.route.length) {
			if (t > m.routeUntil) {
				m.route = []; // a waypoint not reached in time: the route is stale, go direct
				target = currentTarget(m);
			} else if (dist2(e.pos, m.route[0]) <= wpReach(m) * wpReach(m)) {
				m.route.shift();
				m.routeUntil = t + legTime(m, e.pos, m.route[0]);
				m.best = Infinity;
				m.since = t;
				target = currentTarget(m);
			}
		}
		if (m.mode === 'patrol' && target && dist2(e.pos, target) <= wpReach(m) * wpReach(m)) {
			advanceWaypoint(m);
			resetStuck(m, t);
			target = currentTarget(m);
		}

		let dvx = 0;
		let dvz = 0;
		let dist = 0;
		let hx = 0;
		let hz = 0;
		// arrival has HYSTERESIS: in at `reach`, out only past reach + a body radius, so a body
		// shoved a few cm by the crowd does not flip back to seeking (and jostle the ring)
		const wasArrived = m.arrived;
		m.arrived = false;
		if (target) {
			const tx = target[0] - e.pos[0];
			const tz = target[1] - e.pos[2];
			dist = Math.hypot(tx, tz);
			if (dist > 1e-6) {
				hx = tx / dist;
				hz = tz / dist;
			}
			const routing = m.route.length > 0;
			if (!routing && (dist <= m.reach || (wasArrived && dist <= m.reach + m.radius))) {
				m.arrived = true;
			} else {
				let s = m.speed;
				if (m.mode === 'arrive' && !routing && dist < m.slow)
					s *= Math.max(0.15, (dist - m.reach) / Math.max(1e-3, m.slow - m.reach));
				dvx = hx * s;
				dvz = hz * s;
				// look-ahead AVOIDANCE: a static obstacle in front bends the heading away from it
				// before contact, which is what keeps a head-on pillar from being a dead stop
				const av = obstacleAhead(e.pos, hx, hz, m.radius, Math.min(dist, m.radius * 4 + 1), world);
				if (av) {
					const w = m.avoid * av.weight * s;
					dvx += -hz * -av.side * w;
					dvz += hx * -av.side * w;
				}
			}
		}

		// ---- recovery sidestep overrides the heading -------------------------------------
		if (t < m.recUntil && target) {
			const side = m.side || 1;
			// perpendicular (left of heading = (-hz, hx)) plus a little forward
			dvx = (-hz * side * 0.9 + hx * 0.3) * m.speed;
			dvz = (hx * side * 0.9 + hz * 0.3) * m.speed;
		}

		// ---- separation -------------------------------------------------------------------
		let sx = 0;
		let sz = 0;
		for (let j = 0; j < ents.length; j++) {
			if (j === i) continue;
			const o = ents[j];
			if (o.dead) continue;
			const or = o.mover?.radius ?? m.radius;
			const range = (m.radius + or) * 1.6;
			const ox = e.pos[0] - o.pos[0];
			const oz = e.pos[2] - o.pos[2];
			const d2 = ox * ox + oz * oz;
			if (d2 >= range * range) continue;
			const d = Math.sqrt(d2);
			const w = 1 - d / range;
			if (d < 1e-6) {
				// exactly on top of each other: split along a direction both derive from the ids
				const a =
					idSide(e.id) > idSide(o.id) ||
					(idSide(e.id) === idSide(o.id) && String(e.id) < String(o.id))
						? 1
						: -1;
				sx += a * w;
			} else {
				sx += (ox / d) * w;
				sz += (oz / d) * w;
			}
		}
		const sw = m.separation * m.speed;
		dvx += sx * sw;
		dvz += sz * sw;
		// an arrived mover holds its ground against a light shove (a ring around the player
		// stays a ring) but still yields to a crowd
		if (m.arrived) {
			dvx *= 0.5;
			dvz *= 0.5;
		}
		// never faster than cruise
		const ds = Math.hypot(dvx, dvz);
		if (ds > m.speed && ds > 0) {
			dvx *= m.speed / ds;
			dvz *= m.speed / ds;
		}

		// ---- accel-limited velocity + integrate -------------------------------------------
		let ax = dvx - m.vel[0];
		let az = dvz - m.vel[1];
		const amax = m.accel * dt;
		const am = Math.hypot(ax, az);
		if (am > amax) {
			ax *= amax / am;
			az *= amax / am;
		}
		m.vel[0] += ax;
		m.vel[1] += az;
		e.pos[0] += m.vel[0] * dt;
		e.pos[2] += m.vel[1] * dt;

		// ---- collisions: obstacles + bounds, then other bodies -----------------------------
		pushOut(e.pos, m.radius, world);
		for (let j = 0; j < ents.length; j++) {
			if (j === i) continue;
			const o = ents[j];
			if (o.dead) continue;
			const min = m.radius + (o.mover?.radius ?? m.radius);
			const ox = e.pos[0] - o.pos[0];
			const oz = e.pos[2] - o.pos[2];
			const d2 = ox * ox + oz * oz;
			if (d2 >= min * min || d2 < 1e-12) continue;
			const d = Math.sqrt(d2);
			// move ourselves out by the overlap (the other mover does the same on its turn)
			const push = (min - d) * 0.5;
			e.pos[0] += (ox / d) * push;
			e.pos[2] += (oz / d) * push;
		}
		pushOut(e.pos, m.radius, world);

		const mvx = e.pos[0] - px0;
		const mvz = e.pos[2] - pz0;
		if (mvx * mvx + mvz * mvz > 1e-10) {
			movedCount++;
			if (m.vel[0] * m.vel[0] + m.vel[1] * m.vel[1] > 0.01) e.yaw = Math.atan2(m.vel[0], m.vel[1]);
		}

		// ---- STUCK: no headway toward the target for stuckAfter seconds -------------------
		const q = !m.route.length && target ? queuedBehind(e, ents, target) : 0;
		m.waiting = q === 2;
		if (!target || m.arrived) {
			resetStuck(m, t);
			continue;
		}
		if (m.since < 0) m.since = t;
		if (t < m.recUntil) continue; // a sidestep in progress is not measured
		const d = Math.hypot(target[0] - e.pos[0], target[1] - e.pos[2]);
		if (d < m.best - m.progress) {
			m.best = d;
			m.since = t;
			if (d < m.stuckBest - Math.max(1, m.progress * 4)) {
				m.tries = 0;
				m.stuckBest = Infinity;
			}
			continue;
		}
		if (m.best === Infinity) {
			m.best = d;
			m.since = t;
			continue;
		}
		if (t - m.since < m.stuckAfter) continue;
		// QUEUED behind movers already in reach of the same goal (or queued themselves): a crowd
		// at the goal, not a jam — wait for room, indefinitely. JAMMED behind a body that is merely
		// slow: wait longer than usual, then go round.
		if (q === 2) {
			m.since = t;
			continue;
		}
		if (q === 1 && t - m.since < m.stuckAfter * 4) continue;

		m.stuckCount++;
		if (m.tries === 0) m.stuckBest = d;
		m.tries++;
		m.since = t;
		m.best = d;
		// a WALL in front (not a body): sidestepping along it is a guess, re-path straight away
		const wall = obstacleAhead(e.pos, hx, hz, m.radius, m.radius * 3 + 0.3, world);
		// over this step's plan budget: a sidestep now, the plan on its next stuck
		const planNow = plans < MAX_PLANS_PER_STEP && t >= m.noPlanUntil;
		if ((m.tries <= m.maxSidesteps && !wall) || !planNow) {
			// sidestep AWAY from the blocker; first try uses the blocker's side, later tries
			// alternate so a mover in a pocket does not keep stepping into the same wall
			const bs = blockerSide(e, hx, hz, ents, world);
			const first = bs ? -bs : idSide(e.id);
			m.side = m.tries === 1 ? first : -m.side;
			m.recUntil = t + m.sidestep;
		} else {
			// sidesteps did not do it: RE-PATH around the static obstacles (a concave pocket, a
			// wall between the mover and its goal). No route (the goal is walled in) -> a detour
			// waypoint out to the side and back, alternating per attempt.
			const goal = m.mode === 'patrol' ? m.path[m.wp] : m.goal;
			plans++;
			const route = goal ? planPath([e.pos[0], e.pos[2]], goal, world, m.radius) : null;
			m.repaths++;
			if (route && route.length) {
				m.route = route;
			} else {
				// no way through: do not search again for a while (the detour below instead)
				m.noPlanUntil = t + 2;
				m.side = m.side ? -m.side : idSide(e.id);
				const out = m.detour;
				const p = [
					e.pos[0] + -hz * m.side * out - hx * out * 0.6,
					e.pos[1],
					e.pos[2] + hx * m.side * out - hz * out * 0.6
				];
				pushOut(p, m.radius, world);
				m.route = [[p[0], p[2]]];
			}
			m.routeUntil = t + legTime(m, e.pos, m.route[0]);
			m.best = Infinity;
			m.tries = 0;
		}
	}
	return movedCount;
}

/**
 * Is the straight segment (ax, az) -> (bx, bz) clear of every static obstacle for a body of
 * radius r (sampled every quarter metre)? @param {number} ax @param {number} az @param {number} bx
 * @param {number} bz @param {number} r @param {any} world
 */
export function segmentClear(ax, az, bx, bz, r, world) {
	const obs = world?.obstacles;
	if (!obs || !obs.length) return true;
	const d = Math.hypot(bx - ax, bz - az);
	const n = Math.max(1, Math.ceil(d / 0.25));
	for (let k = 1; k <= n; k++) {
		const x = ax + ((bx - ax) * k) / n;
		const z = az + ((bz - az) * k) / n;
		for (let i = 0; i < obs.length; i++) {
			const o = obs[i];
			if (o.r !== undefined) {
				const dx = x - o.x;
				const dz = z - o.z;
				if (dx * dx + dz * dz < (o.r + r) * (o.r + r)) return false;
			} else if (x > o.minX - r && x < o.maxX + r && z > o.minZ - r && z < o.maxZ + r) return false;
		}
	}
	return true;
}

/** how close counts as AT a waypoint (a route corner, a patrol point) — deliberately not the
 * goal `reach`, which is an attack range: a 1.2 m reach would "arrive" at a corner 1.2 m early and
 * cut it straight back into the wall it was routing round @param {any} m */
function wpReach(m) {
	return Math.min(m.reach, m.radius + 0.25);
}

/** how long a route leg may take before the route is dropped: twice the cruise time, plus slack
 * @param {any} m @param {number[]} pos @param {number[] | undefined} wp */
function legTime(m, pos, wp) {
	if (!wp) return m.detourTimeout;
	return (
		m.detourTimeout + (2 * Math.hypot(wp[0] - pos[0], wp[1] - pos[2])) / Math.max(0.1, m.speed)
	);
}

/** squared XZ distance from a [x,y,z] to a [x,z] @param {number[]} p @param {number[]} q */
function dist2(p, q) {
	const dx = p[0] - q[0];
	const dz = p[2] - q[1];
	return dx * dx + dz * dz;
}

/** @param {any} m */
function advanceWaypoint(m) {
	const n = m.path.length;
	if (n <= 1) return;
	if (m.loop) {
		m.wp = (m.wp + 1) % n;
		return;
	}
	// ping-pong
	if (m.wp + m.dirWp >= n || m.wp + m.dirWp < 0) m.dirWp = -m.dirWp;
	m.wp += m.dirWp;
}

/**
 * Is `e` behind a touching body that is NEARER the same target?
 *  2 = QUEUED: that body has arrived there or is itself queued (last step's flag, so a queue
 *      propagates back one body per step) — a crowd at the goal: keep the place, never thrash;
 *  1 = JAMMED: that body is merely slow (not making headway either) — wait, then go round;
 *  0 = neither.
 * @param {any} e @param {any[]} ents @param {number[]} target @returns {0|1|2}
 */
function queuedBehind(e, ents, target) {
	const r = e.mover.radius;
	const myD = Math.hypot(target[0] - e.pos[0], target[1] - e.pos[2]);
	/** @type {0|1|2} */
	let verdict = 0;
	for (const o of ents) {
		if (o === e || o.dead) continue;
		const om = o.mover;
		const or = om?.radius ?? r;
		const dx = o.pos[0] - e.pos[0];
		const dz = o.pos[2] - e.pos[2];
		const touch = (r + or) * 1.35;
		if (dx * dx + dz * dz > touch * touch) continue;
		const oD = Math.hypot(target[0] - o.pos[0], target[1] - o.pos[2]);
		const sameGoal =
			!!om &&
			om.mode !== 'patrol' &&
			!!om.goal &&
			Math.hypot(om.goal[0] - target[0], om.goal[1] - target[1]) <= 1;
		// a neighbour on the SAME ring that has arrived also holds us (the ring is full here)
		if (sameGoal && om.arrived && oD < myD + r) return 2;
		if (oD >= myD) continue;
		if (sameGoal && om.waiting) return 2;
		const slow = !om || Math.hypot(om.vel[0], om.vel[1]) < 0.3 * Math.max(0.1, om.speed);
		if (slow) verdict = 1;
	}
	return verdict;
}

/** a small view of a mover for debug hooks / suites @param {any} m */
export function moverDebug(m) {
	return {
		mode: m.mode,
		arrived: m.arrived,
		waiting: m.waiting,
		recovering: m.recUntil,
		route: m.route.map((/** @type {number[]} */ p) => [p[0], p[1]]),
		repaths: m.repaths,
		stuckCount: m.stuckCount,
		reseats: m.reseats,
		knocked: m.knock[0] !== 0 || m.knock[1] !== 0
	};
}

/**
 * The nearest STATIC obstacle in front of a body heading (hx, hz), within `look` metres, and
 * which side of the heading it sits on (+1 left / -1 right) with a 0..1 urgency. Entities are
 * not considered — separation handles bodies.
 * @param {number[]} pos @param {number} hx @param {number} hz @param {number} r @param {number} look @param {any} world
 * @returns {{side: number, weight: number} | null}
 */
export function obstacleAhead(pos, hx, hz, r, look, world) {
	const obs = world?.obstacles;
	if (!obs || !obs.length) return null;
	let best = Infinity;
	let side = 0;
	for (let i = 0; i < obs.length; i++) {
		const o = obs[i];
		let cx, cz, cr;
		if (o.r !== undefined) {
			cx = o.x;
			cz = o.z;
			cr = o.r;
		} else {
			// a box: test against its nearest point to the ray's sample (cheap and good enough)
			const ax = Math.max(o.minX, Math.min(o.maxX, pos[0] + hx * Math.min(look, 1)));
			const az = Math.max(o.minZ, Math.min(o.maxZ, pos[2] + hz * Math.min(look, 1)));
			cx = ax;
			cz = az;
			cr = 0;
		}
		const rx = cx - pos[0];
		const rz = cz - pos[2];
		const ahead = rx * hx + rz * hz;
		if (ahead <= 0 || ahead > look + cr) continue;
		const lateral = rx * -hz + rz * hx;
		if (Math.abs(lateral) > cr + r * 1.2) continue;
		if (ahead < best) {
			best = ahead;
			// dead ahead (lateral ~ 0): pick a side from the position so a stream of movers does not
			// all choose the same one
			side =
				Math.abs(lateral) < 1e-3
					? Math.floor(pos[0] * 7 + pos[2] * 13) & 1
						? 1
						: -1
					: lateral > 0
						? 1
						: -1;
		}
	}
	if (best === Infinity) return null;
	return { side, weight: Math.max(0, Math.min(1, 1 - best / Math.max(look, 1e-3))) };
}

/** most grid cells one plan may span per axis */
const PLAN_MAX_CELLS = 128;
/** most cells one plan may EXPAND before it gives up (a walled-in goal would otherwise search
 * the whole grid: measured 2.8 ms per call on the Deck, vs 0.3 ms for an ordinary plan) */
const PLAN_MAX_EXPAND = 5000;

/**
 * RE-PATH: a route from `from` to `goal` ([x, z] each) around the static obstacles, on a coarse
 * grid (A*, 8-connected, obstacles inflated by the body radius), string-pulled to the fewest
 * waypoints with a clear line between them. Returns the waypoints AFTER the start, ending at the
 * goal (or the nearest free cell to it), or null when there is no way through. Movers are not in
 * the grid: they move, and separation + sidesteps handle them.
 * @param {number[]} from @param {number[]} goal @param {any} world @param {number} radius
 * @returns {number[][] | null}
 */
export function planPath(from, goal, world, radius) {
	const obs = world?.obstacles ?? [];
	const pad = 12;
	let minX = Math.min(from[0], goal[0]) - pad;
	let maxX = Math.max(from[0], goal[0]) + pad;
	let minZ = Math.min(from[1], goal[1]) - pad;
	let maxZ = Math.max(from[1], goal[1]) + pad;
	const b = world?.bounds;
	if (b) {
		minX = Math.max(minX, b.minX);
		maxX = Math.min(maxX, b.maxX);
		minZ = Math.max(minZ, b.minZ);
		maxZ = Math.min(maxZ, b.maxZ);
	}
	const cell = Math.max(
		radius * 0.9,
		(maxX - minX) / PLAN_MAX_CELLS,
		(maxZ - minZ) / PLAN_MAX_CELLS,
		0.2
	);
	const W = Math.max(1, Math.ceil((maxX - minX) / cell));
	const H = Math.max(1, Math.ceil((maxZ - minZ) / cell));
	const N = W * H;
	const inflate = radius * 1.05;
	/** -1 unknown, 0 free, 1 blocked */
	const blocked = new Int8Array(N).fill(-1);
	/** @param {number} x @param {number} z */
	const solidAt = (x, z) => {
		if (
			b &&
			(x < b.minX + radius || x > b.maxX - radius || z < b.minZ + radius || z > b.maxZ - radius)
		)
			return true;
		for (let i = 0; i < obs.length; i++) {
			const o = obs[i];
			if (o.r !== undefined) {
				const dx = x - o.x;
				const dz = z - o.z;
				const rr = o.r + inflate;
				if (dx * dx + dz * dz < rr * rr) return true;
			} else if (
				x > o.minX - inflate &&
				x < o.maxX + inflate &&
				z > o.minZ - inflate &&
				z < o.maxZ + inflate
			)
				return true;
		}
		return false;
	};
	/** @param {number} c */
	const isBlocked = (c) => {
		if (blocked[c] === -1)
			blocked[c] = solidAt(minX + ((c % W) + 0.5) * cell, minZ + (Math.floor(c / W) + 0.5) * cell)
				? 1
				: 0;
		return blocked[c] === 1;
	};
	/** @param {number} x @param {number} z */
	const cellOf = (x, z) => {
		const cx = Math.max(0, Math.min(W - 1, Math.floor((x - minX) / cell)));
		const cz = Math.max(0, Math.min(H - 1, Math.floor((z - minZ) / cell)));
		return cz * W + cx;
	};
	/** the nearest free cell to c within a few rings, or -1 @param {number} c */
	const freeNear = (c) => {
		if (!isBlocked(c)) return c;
		const cx = c % W;
		const cz = Math.floor(c / W);
		for (let ring = 1; ring <= 6; ring++) {
			let bestC = -1;
			let bestD = Infinity;
			for (let dz = -ring; dz <= ring; dz++) {
				for (let dx = -ring; dx <= ring; dx++) {
					if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
					const x = cx + dx;
					const z = cz + dz;
					if (x < 0 || z < 0 || x >= W || z >= H) continue;
					const n = z * W + x;
					if (isBlocked(n)) continue;
					const d = dx * dx + dz * dz;
					if (d < bestD) {
						bestD = d;
						bestC = n;
					}
				}
			}
			if (bestC >= 0) return bestC;
		}
		return -1;
	};
	const start = freeNear(cellOf(from[0], from[1]));
	const end = freeNear(cellOf(goal[0], goal[1]));
	if (start < 0 || end < 0) return null;
	const goalFree = end === cellOf(goal[0], goal[1]);

	// A* with a binary heap on f
	const g = new Float64Array(N).fill(Infinity);
	const came = new Int32Array(N).fill(-1);
	const closed = new Uint8Array(N);
	/** @type {number[]} */ const heap = [];
	/** @type {number[]} */ const fh = [];
	const ex = end % W;
	const ez = Math.floor(end / W);
	/** octile heuristic @param {number} c */
	const hOf = (c) => {
		const dx = Math.abs((c % W) - ex);
		const dz = Math.abs(Math.floor(c / W) - ez);
		return Math.max(dx, dz) + 0.41421356 * Math.min(dx, dz);
	};
	/** @param {number} c @param {number} f */
	const push = (c, f) => {
		heap.push(c);
		fh.push(f);
		let i = heap.length - 1;
		while (i > 0) {
			const pi = (i - 1) >> 1;
			if (fh[pi] <= fh[i]) break;
			[heap[pi], heap[i]] = [heap[i], heap[pi]];
			[fh[pi], fh[i]] = [fh[i], fh[pi]];
			i = pi;
		}
	};
	const pop = () => {
		const top = heap[0];
		const lastC = heap.pop();
		const lastF = fh.pop();
		if (heap.length && lastC !== undefined && lastF !== undefined) {
			heap[0] = lastC;
			fh[0] = lastF;
			let i = 0;
			for (;;) {
				const l = i * 2 + 1;
				const r = l + 1;
				let m = i;
				if (l < heap.length && fh[l] < fh[m]) m = l;
				if (r < heap.length && fh[r] < fh[m]) m = r;
				if (m === i) break;
				[heap[m], heap[i]] = [heap[i], heap[m]];
				[fh[m], fh[i]] = [fh[i], fh[m]];
				i = m;
			}
		}
		return top;
	};
	g[start] = 0;
	push(start, hOf(start));
	let found = false;
	let expanded = 0;
	while (heap.length) {
		const c = pop();
		if (closed[c]) continue;
		closed[c] = 1;
		if (c === end) {
			found = true;
			break;
		}
		if (++expanded > Math.min(N, PLAN_MAX_EXPAND)) break;
		const cx = c % W;
		const cz = Math.floor(c / W);
		for (let dz = -1; dz <= 1; dz++) {
			for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dz) continue;
				const x = cx + dx;
				const z = cz + dz;
				if (x < 0 || z < 0 || x >= W || z >= H) continue;
				const n = z * W + x;
				if (closed[n] || isBlocked(n)) continue;
				// no corner cutting: a diagonal needs both orthogonal neighbours free
				if (dx && dz && (isBlocked(cz * W + x) || isBlocked(z * W + cx))) continue;
				const ng = g[c] + (dx && dz ? 1.41421356 : 1);
				if (ng < g[n]) {
					g[n] = ng;
					came[n] = c;
					push(n, ng + hOf(n));
				}
			}
		}
	}
	if (!found) return null;
	/** @type {number[][]} */
	const cells = [];
	for (let c = end; c !== -1 && c !== start; c = came[c])
		cells.push([minX + ((c % W) + 0.5) * cell, minZ + (Math.floor(c / W) + 0.5) * cell]);
	cells.reverse();
	if (goalFree) cells[cells.length - 1] = [goal[0], goal[1]];
	if (!cells.length) return [[goal[0], goal[1]]];
	// string-pull: from each kept point, skip ahead to the farthest point with a clear line
	/** @param {number[]} a @param {number[]} q */
	const clear = (a, q) => {
		const d = Math.hypot(q[0] - a[0], q[1] - a[1]);
		const n = Math.max(1, Math.ceil(d / (cell * 0.5)));
		for (let k = 1; k < n; k++)
			if (solidAt(a[0] + ((q[0] - a[0]) * k) / n, a[1] + ((q[1] - a[1]) * k) / n)) return false;
		return true;
	};
	/** @type {number[][]} */
	const out = [];
	let at = [from[0], from[1]];
	let i = 0;
	while (i < cells.length) {
		let j = cells.length - 1;
		while (j > i && !clear(at, cells[j])) j--;
		out.push(cells[j]);
		at = cells[j];
		i = j + 1;
	}
	return out;
}
