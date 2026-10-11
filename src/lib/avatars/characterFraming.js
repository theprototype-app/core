// 41 G8: how the customise panel frames YOUR character, as pure arithmetic (the unit suite pins
// it; CharacterPanel applies it). A LEAF: no imports.
//
// The character must stay WHOLE and CENTRED in the part of the viewport the drawer leaves free
// — left of the side drawer on a wide screen, above the bottom sheet on a phone — through every
// layout change (a fold/unfold flips the drawer between those two shapes). Two pieces:
//   · a DISTANCE at which the body's envelope fits the free rect in BOTH directions (a folded
//     phone's free area can be narrower than it is tall);
//   · a projection VIEW OFFSET (three's `camera.setViewOffset`) that puts the orbit target —
//     the body's centre — at the free rect's centre. The camera itself looks straight at the
//     body, so orbiting turns the character in place like a turntable, which a screen-space
//     PAN of the camera (the 38 approach) could not: the pivot sat beside the body.

/** the body's envelope in metres, feet to the top of the name label, arms and a hat included */
export const BODY_HEIGHT = 2.9;
export const BODY_WIDTH = 1.5;
/** the share of the free rect the envelope may fill (the rest is breathing room) */
export const FILL = 0.86;
/** never closer than this (a wide free rect would otherwise put the lens inside the hat) */
export const MIN_DIST = 2.6;

/**
 * @typedef {{x: number, y: number, w: number, h: number}} Rect CSS px, relative to the canvas
 */

/**
 * The distance at which a `bodyH` x `bodyW` envelope fits `free` on a canvas `viewH` tall
 * seen through a vertical field of view of `fovDeg`.
 * @param {{viewH: number, free: Rect, fovDeg: number, bodyH?: number, bodyW?: number, fill?: number}} o
 */
export function fitDistance({ viewH, free, fovDeg, bodyH = BODY_HEIGHT, bodyW = BODY_WIDTH, fill = FILL }) {
	const H = Math.max(1, viewH);
	const t = Math.tan(((fovDeg || 40) * Math.PI) / 360);
	// world metres per css px at distance d is 2 d t / H, the same horizontally (square pixels)
	const byHeight = ((bodyH / fill) * H) / (2 * Math.max(1, free.h) * t);
	const byWidth = ((bodyW / fill) * H) / (2 * Math.max(1, free.w) * t);
	return Math.max(MIN_DIST, byHeight, byWidth);
}

/**
 * The view offset that shows the camera's centre of view at the free rect's centre: the args
 * of `camera.setViewOffset(fullWidth, fullHeight, x, y, width, height)`.
 * @param {number} viewW @param {number} viewH @param {Rect} free
 * @returns {[number, number, number, number, number, number]}
 */
export function centreOffset(viewW, viewH, free) {
	const cx = free.x + free.w / 2;
	const cy = free.y + free.h / 2;
	return [viewW, viewH, viewW / 2 - cx, viewH / 2 - cy, viewW, viewH];
}

/**
 * The free rect: the canvas minus the drawer (its left edge on a wide screen, its top on a
 * phone sheet) and a strip of top chrome, clamped so it never collapses.
 * @param {{left: number, top: number, width: number, height: number}} canvas the canvas's client rect
 * @param {{left: number, top: number, width: number, height: number} | null} panel the drawer's client rect
 * @param {boolean} sheet the drawer is a bottom sheet (phone) rather than a side drawer
 * @param {number} [topInset] css px of chrome over the top of the canvas
 * @returns {Rect}
 */
export function freeRect(canvas, panel, sheet, topInset = 64) {
	const W = Math.max(1, canvas.width);
	const H = Math.max(1, canvas.height);
	let right = W;
	let bottom = H;
	if (panel && panel.width > 0 && panel.height > 0) {
		if (sheet) bottom = Math.min(H, Math.max(0, panel.top - canvas.top));
		else right = Math.min(W, Math.max(0, panel.left - canvas.left));
	}
	const top = Math.min(topInset, H * 0.25);
	// a drawer wider than the screen leaves nothing: frame on the whole canvas then
	const w = right >= W * 0.25 ? right : W;
	const h = bottom - top >= H * 0.2 ? bottom - top : H - top;
	return { x: 0, y: top, w, h };
}

/**
 * Refine a distance against the body's REAL bounds: project the box corners through a scratch
 * copy of the camera (with the centring view offset) and scale the distance until the farthest
 * corner sits at `fill` of the free rect's half-size. A box seen 3/4 on, its near corners
 * magnified by perspective, projects wider than any envelope guess — the measured box is the
 * truth. Duck-typed on three's camera / Vector3, so this file stays import-free.
 * @param {{cam: any, corners: any[], target: number[], dir: number[], dist: number, viewW: number, viewH: number, free: Rect, fill?: number}} o
 * @returns {number}
 */
export function fitToCorners({ cam, corners, target, dir, dist, viewW, viewH, free, fill = FILL }) {
	cam.setViewOffset(...centreOffset(viewW, viewH, free));
	cam.aspect = viewW / Math.max(1, viewH);
	cam.updateProjectionMatrix();
	const cx = free.x + free.w / 2;
	const cy = free.y + free.h / 2;
	const hw = Math.max(1, (free.w * fill) / 2);
	const hh = Math.max(1, (free.h * fill) / 2);
	let d = dist;
	for (let i = 0; i < 6; i++) {
		cam.position.set(target[0] + dir[0] * d, target[1] + dir[1] * d, target[2] + dir[2] * d);
		cam.lookAt(target[0], target[1], target[2]);
		cam.updateMatrixWorld(true);
		let need = 0;
		for (const c of corners) {
			const v = c.clone().project(cam);
			if (v.z > 1) {
				need = Math.max(need, 2);
				continue;
			}
			const px = ((v.x + 1) / 2) * viewW;
			const py = ((1 - v.y) / 2) * viewH;
			need = Math.max(need, Math.abs(px - cx) / hw, Math.abs(py - cy) / hh);
		}
		if (!(need > 0)) break;
		const next = Math.max(MIN_DIST, d * need);
		if (Math.abs(next - d) < 0.005) break;
		d = next;
	}
	return d;
}
