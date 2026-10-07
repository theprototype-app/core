// 37-fx: the vertex layouts behind the particle render modes (stretch / trails / ribbon).
// Pure — no three, no stores — so the index maths is unit-tested on its own. The shader
// (particleShader.js) computes every position; these only say WHICH slot each vertex
// samples, at which point of its path, on which side.
//
//  points   one vertex per slot (THREE.Points, the PFX-A path)
//  stretch  one quad per slot: head (now) + tail (`stretch` s ago), velocity-aligned
//  trails   `segs` quads per slot: the particle's own path over the last `trail` s
//  ribbon   one quad per slot PAIR (i, i+1): a band through the slots in birth order —
//           in world space that is the path the emitter took

export const RENDER_MODES = ['points', 'stretch', 'trails', 'ribbon'];
export const MAX_TRAIL_SEGMENTS = 16;

/**
 * The render mode an emitter config actually gets. A ribbon joins slots in birth order,
 * which only a CONTINUOUS emitter has (a burst is born all at once) — it falls back to
 * trails there.
 * @param {any} cfg @returns {'points'|'stretch'|'trails'|'ribbon'}
 */
export function renderModeOf(cfg) {
	const wanted = RENDER_MODES.includes(cfg?.render) ? cfg.render : 'points';
	if (wanted === 'ribbon' && (cfg?.mode ?? 'continuous') !== 'continuous') return 'trails';
	return /** @type {any} */ (wanted);
}

/** Segments per particle strip. @param {any} cfg @param {string} render */
export function segmentsOf(cfg, render) {
	if (render !== 'trails') return 1;
	const n = Math.round(Number(cfg?.trailSegments) || 8);
	return Math.min(Math.max(n, 2), MAX_TRAIL_SEGMENTS);
}

/**
 * Per-particle strips (stretch: segs = 1). Vertex v of slot i, segment k, side s sits at
 * i*(segs+1)*2 + k*2 + (s > 0 ? 1 : 0).
 * @param {number} count @param {number} segs
 */
export function stripLayout(count, segs) {
	const per = (segs + 1) * 2;
	const verts = count * per;
	const slotOf = new Int32Array(verts);
	const seg = new Float32Array(verts);
	const side = new Float32Array(verts);
	const index = verts > 65535 ? new Uint32Array(count * segs * 6) : new Uint16Array(count * segs * 6);
	let w = 0;
	for (let i = 0; i < count; i++) {
		const base = i * per;
		for (let k = 0; k <= segs; k++) {
			for (let s = 0; s < 2; s++) {
				const v = base + k * 2 + s;
				slotOf[v] = i;
				seg[v] = k;
				side[v] = s ? 1 : -1;
			}
			if (k < segs) {
				const a = base + k * 2;
				const b = a + 2;
				index[w++] = a;
				index[w++] = b;
				index[w++] = a + 1;
				index[w++] = a + 1;
				index[w++] = b;
				index[w++] = b + 1;
			}
		}
	}
	return { verts, slotOf, seg, side, index, indicesPerSlot: segs * 6 };
}

/**
 * One quad per slot i, joining i (the older end) to i+1 mod count (the younger). Each
 * vertex carries its OWN slot and the quad's OTHER one, so the shader can hide the seam.
 * @param {number} count
 */
export function ribbonLayout(count) {
	const verts = count * 4;
	const slotOf = new Int32Array(verts);
	const otherOf = new Int32Array(verts);
	const end = new Float32Array(verts);
	const side = new Float32Array(verts);
	const index = new Uint16Array(count * 6);
	for (let i = 0; i < count; i++) {
		const j = (i + 1) % count;
		const base = i * 4;
		for (let e = 0; e < 2; e++)
			for (let s = 0; s < 2; s++) {
				const v = base + e * 2 + s;
				slotOf[v] = e ? j : i;
				otherOf[v] = e ? i : j;
				end[v] = e;
				side[v] = s ? 1 : -1;
			}
		const w = i * 6;
		index[w] = base;
		index[w + 1] = base + 2;
		index[w + 2] = base + 1;
		index[w + 3] = base + 1;
		index[w + 4] = base + 2;
		index[w + 5] = base + 3;
	}
	return { verts, slotOf, otherOf, end, side, index, indicesPerSlot: 6 };
}

/**
 * Copy per-SLOT vec data into a per-VERTEX attribute array through a map.
 * @param {Float32Array} slots @param {number} size components per slot
 * @param {Int32Array} map vertex -> slot @param {Float32Array} out
 */
export function expandSlots(slots, size, map, out) {
	for (let v = 0; v < map.length; v++) {
		const from = map[v] * size;
		const to = v * size;
		for (let c = 0; c < size; c++) out[to + c] = slots[from + c];
	}
	return out;
}

export const MAX_EMITTER_SPEED = 60; // m/s — a teleport is not a velocity

/**
 * The emitter's velocity from two world positions `dt` seconds apart, smoothed into `vel`
 * (a frame-to-frame estimate jitters; half of each new sample is plenty to follow a turn).
 * No usable dt (first frame, a stall) leaves vel at zero rather than guessing; a jump
 * faster than MAX_EMITTER_SPEED (a teleport, a scene load) is dropped, not clamped.
 * @param {number[]} vel in/out [x, y, z] @param {number[] | null} prev @param {number[]} now
 * @param {number} dt seconds
 */
export function smoothEmitterVelocity(vel, prev, now, dt) {
	if (!prev || !(dt > 0) || dt > 0.5) {
		vel[0] = vel[1] = vel[2] = 0;
		return vel;
	}
	const vx = (now[0] - prev[0]) / dt;
	const vy = (now[1] - prev[1]) / dt;
	const vz = (now[2] - prev[2]) / dt;
	if (Math.hypot(vx, vy, vz) > MAX_EMITTER_SPEED) return vel;
	vel[0] += (vx - vel[0]) * 0.5;
	vel[1] += (vy - vel[1]) * 0.5;
	vel[2] += (vz - vel[2]) * 0.5;
	return vel;
}
