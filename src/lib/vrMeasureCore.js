// 52 V1: the VR measure tool's arithmetic. A LEAF — imports nothing — so the laser's snap cone,
// the grid rounding, the point pick-up, the double-tap keep and the label sizing are unit-tested
// without a headset, and vrMeasure.js / VRMeasureLabels.svelte read the same numbers.
//
// The laser snaps the way the desktop cursor does, through the SAME snap-engine search: a virtual
// camera stands at the controller looking down the ray, so the ray is the centre of its view and
// the engine's screen-pixel radius becomes an ANGULAR cone around the laser. A cone (not a
// distance) is what a pointing hand can hold steady: a corner 1° off reads as close at 1 m and at
// 10 m alike.

/** half-angle (degrees) of the cone around the laser a corner / edge / face snaps from */
export const VR_SNAP_CONE_DEG = 3;
/** the engine's radius (screen px of the virtual camera) the cone is expressed in */
export const VR_SNAP_RADIUS_PX = 40;
/** how far (degrees) from the laser an edit trigger may land to pick a kept point up */
export const VR_PICK_CONE_DEG = 3;
/** a second trigger this soon, on (nearly) the same spot, keeps the chain — the desktop double click */
export const VR_DOUBLE_TAP_MS = 450;
/** the label's height as an ANGLE (radians): a label scales with its distance, so it reads the same
 * size near and far (~1.7°, comfortably above a Quest 3's ~0.04°/px) */
export const VR_LABEL_ANGLE = 0.03;
export const VR_LABEL_MIN_M = 0.008;
export const VR_LABEL_MAX_M = 1.5;

/**
 * The desktop measure bias (px, for an 18 px mouse radius) laid onto the laser's cone: a bias is a pull
 * RELATIVE to the reach, so it scales with the radius. Unscaled, a corner 1.2° off (16 px of a 40 px cone)
 * spent the whole -16 px vertex bias on its distance and an edge 1 cm off the ray won — measured on IWER.
 * @param {Record<string, number>} bias @param {number} mouseRadiusPx @param {number} [radiusPx]
 * @returns {Record<string, number>}
 */
export function coneBias(bias, mouseRadiusPx, radiusPx = VR_SNAP_RADIUS_PX) {
	const k = radiusPx / mouseRadiusPx;
	return Object.fromEntries(Object.entries(bias).map(([type, b]) => [type, b * k]));
}

/**
 * The vertical field of view (degrees) of the virtual ray camera, chosen so `radiusPx` from the
 * centre of a `rectHeight`-px view spans `coneDeg`.
 * @param {number} rectHeight @param {number} [radiusPx] @param {number} [coneDeg]
 */
export function rayCameraFov(rectHeight, radiusPx = VR_SNAP_RADIUS_PX, coneDeg = VR_SNAP_CONE_DEG) {
	const h = rectHeight > 0 ? rectHeight : 720;
	const tanHalf = (Math.tan((coneDeg * Math.PI) / 180) * (h / 2)) / radiusPx;
	return (2 * Math.atan(tanHalf) * 180) / Math.PI;
}

/**
 * Grid snapping for a RAW point (no corner / edge / face won): x and z land on the grid; y too on
 * the ground plane (a raw surface hit keeps its height — rounding it would lift the point off the
 * surface it sits on). Step <= 0 = no grid.
 * @param {number[]} point @param {number} step @param {string} snap '' (surface) | 'ground'
 * @returns {{point: number[], snap: string}}
 */
export function snapToGrid(point, step, snap) {
	if (!(step > 0)) return { point: [point[0], point[1], point[2]], snap };
	const r = (/** @type {number} */ v) => Math.round(v / step) * step;
	return { point: [r(point[0]), snap === 'ground' ? r(point[1]) : point[1], r(point[2])], snap: 'grid' };
}

/**
 * The index of the point nearest the ray by ANGLE, within `maxDeg`, or -1 (points behind the
 * controller are never picked).
 * @param {number[]} origin @param {number[]} dir unit @param {number[][]} points @param {number} [maxDeg]
 */
export function angularPick(origin, dir, points, maxDeg = VR_PICK_CONE_DEG) {
	let best = -1;
	let bestAngle = (maxDeg * Math.PI) / 180;
	points.forEach((p, i) => {
		const v = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
		const len = Math.hypot(v[0], v[1], v[2]);
		if (len < 1e-6) return;
		const cos = (v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2]) / len;
		if (cos <= 0) return;
		const angle = Math.acos(Math.min(1, cos));
		if (angle <= bestAngle) (best = i), (bestAngle = angle);
	});
	return best;
}

/**
 * Is this trigger the second half of a double tap: soon after the last point, on (nearly) the same
 * spot — within 3 cm or 2 % of the distance from the hand, whichever is larger.
 * @param {{at: number, point: number[] | null}} last @param {number} now @param {number[]} point
 * @param {number} handDistance metres from the controller to the point
 */
export function isDoubleTap(last, now, point, handDistance) {
	if (!last.point || now - last.at > VR_DOUBLE_TAP_MS) return false;
	const d = Math.hypot(point[0] - last.point[0], point[1] - last.point[1], point[2] - last.point[2]);
	return d <= Math.max(0.03, handDistance * 0.02);
}

/** a label's world height at `distance` metres from the eye: constant ANGULAR size, clamped
 * @param {number} distance */
export function labelWorldHeight(distance) {
	return Math.min(VR_LABEL_MAX_M, Math.max(VR_LABEL_MIN_M, distance * VR_LABEL_ANGLE));
}

/**
 * The px metrics `measureCore.layoutLabels` needs for VR labels seen through a camera whose view is
 * `viewHeightPx` tall over `fovDeg`: every label is the same ANGLE tall, so it is the same number of
 * pixels tall wherever it stands — which is what lets the desktop's screen-space layout keep VR
 * labels apart too.
 * @param {number} viewHeightPx @param {number} fovDeg
 * @returns {{h: number, charW: number, padX: number, gap: number}}
 */
export function labelPxMetrics(viewHeightPx, fovDeg) {
	const h = (VR_LABEL_ANGLE / ((fovDeg * Math.PI) / 180)) * viewHeightPx * 1.25; // a line + its outline
	return { h, charW: h * 0.5, padX: h * 0.5, gap: Math.max(1, h * 0.1) };
}
