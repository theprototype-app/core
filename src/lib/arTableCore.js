// 50 R1 — AR TABLE PLACEMENT, THE PURE HALF (imports nothing; tests/unit/arTableCore.test.js).
//
// A phone in an immersive-ar session finds a surface, and the scene is drawn ON it: the world rig
// (the group every replicated object lives under, the one a VR world-grab already moves) takes
//   rig = T(hit) · R_y(yaw) · S(scale) · T(-anchor)
// so the scene's ANCHOR — the middle of its footprint, at its lowest point — stands on the hit
// point, scaled to table size and turned by the twist. Everything else (physics, the wire, saves)
// keeps working in the content frame, untouched: the rig is local, like the VR world-grab's.

/** a table is about this wide (m): the default fit for the scene's footprint */
export const TABLE_SIZE = 0.6;
/** the smallest and largest the scene may be drawn (world units -> metres) */
export const MIN_SCALE = 0.001;
export const MAX_SCALE = 1;
/** a footprint never counts as smaller than this (m), so an empty or one-box scene is not blown up */
export const MIN_EXTENT = 1;
/** a hit counts as a TABLE when its surface normal is this close to up (cos of ~37°) */
export const FLAT_UP = 0.8;
/** a tap: under this travel (px) and this long (ms) */
export const TAP_SLOP = 12;
export const TAP_MS = 500;

/** the note an unsupported device shows instead of a button that cannot work */
export const AR_UNSUPPORTED_NOTE = 'AR needs Android Chrome';

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The scene's anchor in the content frame: the middle of the footprint at the lowest point.
 * An empty box (nothing in the scene) anchors at the origin.
 * @param {{min: number[], max: number[]} | null} box
 * @returns {number[]}
 */
export function contentAnchor(box) {
	if (!box || !box.min.every(Number.isFinite) || !box.max.every(Number.isFinite) || box.min[0] > box.max[0]) return [0, 0, 0];
	return [(box.min[0] + box.max[0]) / 2, box.min[1], (box.min[2] + box.max[2]) / 2];
}

/**
 * The default scale: the footprint's longer side fits a table.
 * @param {{min: number[], max: number[]} | null} box @param {number} [table]
 */
export function tableScale(box, table = TABLE_SIZE) {
	let extent = MIN_EXTENT;
	if (box && box.min.every(Number.isFinite) && box.max.every(Number.isFinite) && box.min[0] <= box.max[0]) {
		extent = Math.max(MIN_EXTENT, box.max[0] - box.min[0], box.max[2] - box.min[2]);
	}
	return clamp(table / extent, MIN_SCALE, MAX_SCALE);
}

/**
 * The rig's pose for a placement. `quaternion` is [x, y, z, w] (a turn about +Y).
 * @param {{hit: number[], yaw: number, scale: number, anchor: number[]}} p
 * @returns {{position: number[], quaternion: number[], scale: number}}
 */
export function rigPose({ hit, yaw, scale, anchor }) {
	const c = Math.cos(yaw);
	const s = Math.sin(yaw);
	const ax = anchor[0] * scale;
	const ay = anchor[1] * scale;
	const az = anchor[2] * scale;
	// R_y(yaw) · (scale · anchor): x' = c·x + s·z, z' = -s·x + c·z
	const rx = c * ax + s * az;
	const rz = -s * ax + c * az;
	return {
		position: [hit[0] - rx, hit[1] - ay, hit[2] - rz],
		quaternion: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
		scale
	};
}

/**
 * Where a content-frame point lands in the room under a placement (the inverse check the suites use).
 * @param {number[]} point @param {{hit: number[], yaw: number, scale: number, anchor: number[]}} p
 */
export function placedPoint(point, p) {
	const pose = rigPose(p);
	const c = Math.cos(p.yaw);
	const s = Math.sin(p.yaw);
	const x = point[0] * p.scale;
	const y = point[1] * p.scale;
	const z = point[2] * p.scale;
	return [pose.position[0] + c * x + s * z, pose.position[1] + y, pose.position[2] - s * x + c * z];
}

/** two touches as {distance, angle} (screen px, radians; y down) @param {{x: number, y: number}[]} pts */
export function touchPair(pts) {
	const [a, b] = pts;
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	return { distance: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) };
}

/** wrap an angle into (-π, π] @param {number} a */
export function wrapAngle(a) {
	let r = a % (2 * Math.PI);
	if (r <= -Math.PI) r += 2 * Math.PI;
	if (r > Math.PI) r -= 2 * Math.PI;
	return r;
}

/**
 * A two-finger gesture's result: PINCH scales by the spread ratio, TWIST turns by the change of
 * the fingers' angle. Fingers turning CLOCKWISE on the screen (the angle grows, y is down) turn the
 * scene clockwise as seen from above the table, i.e. a negative yaw about +Y.
 * @param {{scale: number, yaw: number}} start the placement when the second finger landed
 * @param {{distance: number, angle: number}} from the pair then
 * @param {{distance: number, angle: number}} to the pair now
 * @returns {{scale: number, yaw: number}}
 */
export function pinchTwist(start, from, to) {
	const ratio = from.distance > 1 ? to.distance / from.distance : 1;
	return {
		scale: clamp(start.scale * ratio, MIN_SCALE, MAX_SCALE),
		yaw: wrapAngle(start.yaw - wrapAngle(to.angle - from.angle))
	};
}

/** was this press a tap? @param {{dx: number, dy: number, ms: number}} p */
export function isTap({ dx, dy, ms }) {
	return Math.hypot(dx, dy) <= TAP_SLOP && ms <= TAP_MS;
}

/** a surface normal (unit, [x, y, z]) is a table top @param {number[]} up */
export function isFlat(up) {
	return up[1] >= FLAT_UP;
}

/**
 * What the phone shell's AR entry is: 'ready' (a button), 'checking' (the support probe has not
 * answered yet) or 'unsupported' (the note, never a dead button). iPhone Safari has no WebXR, a
 * desktop browser answers false for immersive-ar.
 * @param {{hasXR: boolean, arSupported: boolean | null}} s
 * @returns {'ready' | 'checking' | 'unsupported'}
 */
export function arEntryState({ hasXR, arSupported }) {
	if (!hasXR) return 'unsupported';
	if (arSupported === null) return 'checking';
	return arSupported ? 'ready' : 'unsupported';
}

/** "1:40" for a scale of 0.025 (what the overlay shows) @param {number} scale */
export function scaleLabel(scale) {
	if (!(scale > 0)) return '';
	if (scale >= 1) return '1:1';
	const n = 1 / scale;
	return `1:${n >= 100 ? Math.round(n / 10) * 10 : Math.round(n)}`;
}

/**
 * VH2: which room a phone joins. The room a headset in this session is ALREADY colocated in wins —
 * the phone is joining them, so it takes their key, whatever they typed or minted. With several
 * rooms the most-joined one, ties to the alphabetically first so every phone picks the same.
 * Nobody colocated yet: the key this phone already holds, else the session default (the same one a
 * headset in this session mints, so whoever calibrates first, the keys meet).
 * @param {Record<string, string>} peerKeys peerId -> roomKey (colocated peers only)
 * @param {string | null} current this device's key, if any
 * @param {string} fallback the session default
 * @returns {string}
 */
export function roomKeyToJoin(peerKeys, current, fallback) {
	/** @type {Map<string, number>} */
	const counts = new Map();
	for (const key of Object.values(peerKeys ?? {})) if (typeof key === 'string' && key) counts.set(key, (counts.get(key) ?? 0) + 1);
	let best = '';
	let bestN = 0;
	for (const [key, n] of counts) if (n > bestN || (n === bestN && key < best)) [best, bestN] = [key, n];
	if (best) return best;
	return typeof current === 'string' && current ? current : fallback;
}
