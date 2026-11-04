// mcp-shapes — create_objects {from, count, offset, randomRot, randomScale, seed}: where each copy goes (imports
// nothing). Copy i (1-based) sits at the source's position + i x offset, in the space the source lives in; the
// random turn and size are seeded, so the same call makes the same row on every run and every peer.

export const DUPLICATE_MAX = 100;

/** mulberry32: a small seeded generator, [0, 1) @param {number} seed */
export function seededRandom(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** @param {any} v */
const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));

/**
 * @param {any} args {count, offset, randomRot, randomScale, seed}
 * @param {{position: number[], rotation: number[], scale: number[]}} base the source's local pose
 * @returns {{poses: {position: number[], rotation: number[], scale: number[]}[]} | {error: string}}
 */
export function duplicatePlan(args, base) {
	const count = args?.count === undefined ? 1 : args.count;
	if (!Number.isInteger(count) || count < 1 || count > DUPLICATE_MAX) return { error: 'count: a whole number of copies, 1-' + DUPLICATE_MAX };
	const offset = args.offset === undefined ? [0, 0, 0] : args.offset;
	if (!vec3(offset)) return { error: 'offset: [x, y, z] metres between one copy and the next' };
	/** @type {number[]} max turn per axis (radians, ±) */
	let turn = [0, 0, 0];
	const rr = args.randomRot;
	if (rr === true) turn = [0, Math.PI, 0];
	else if (typeof rr === 'number' && Number.isFinite(rr) && rr >= 0) turn = [0, rr, 0];
	else if (vec3(rr) && rr.every((/** @type {number} */ n) => n >= 0)) turn = [...rr];
	else if (rr !== undefined && rr !== false) return { error: 'randomRot: true (any turn about Y), a number (± radians about Y) or [x, y, z] (± radians per axis)' };
	/** @type {[number, number]} size factor range */
	let size = [1, 1];
	const rs = args.randomScale;
	if (typeof rs === 'number' && Number.isFinite(rs) && rs >= 0 && rs < 1) size = [1 - rs, 1 + rs];
	else if (Array.isArray(rs) && rs.length === 2 && rs.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0) && rs[0] <= rs[1]) size = [rs[0], rs[1]];
	else if (rs !== undefined && rs !== false) return { error: 'randomScale: a fraction like 0.2 (sizes 0.8-1.2) or [min, max] factors' };
	const seed = args.seed === undefined ? 1 : args.seed;
	if (!Number.isInteger(seed)) return { error: 'seed: a whole number (the same seed makes the same copies)' };
	const rand = seededRandom(seed);
	const r6 = (/** @type {number} */ n) => Math.round(n * 1e6) / 1e6;
	/** @type {{position: number[], rotation: number[], scale: number[]}[]} */
	const poses = [];
	for (let i = 1; i <= count; i++) {
		const rotation = base.rotation.map((r, k) => r6(r + (turn[k] ? (rand() * 2 - 1) * turn[k] : 0)));
		const f = size[0] === size[1] ? size[0] : size[0] + rand() * (size[1] - size[0]);
		poses.push({
			position: base.position.map((p, k) => r6(p + offset[k] * i)),
			rotation,
			scale: base.scale.map((s) => r6(s * f))
		});
	}
	return { poses };
}
