// 80a-fix4-ui G4 (release check r1590-02): Phone tilt <-> Touch hand-overs with the phone lying flat rolled the Film
// view ~167 deg. The hand-over now carries the QUATERNION (touchLook about the carried orientation, handoverOffset =
// the yaw twist). Proof: Tilt -> Touch -> Tilt at pitch -88 / -90 / -60 (and past the pole) keeps the view within 1 deg.
import { describe, it, expect } from 'vitest';
import { quatAxisAngle, quatMul, quatConj, quatNorm, levelHorizon, recentreOffset, handoverOffset, touchLook } from '../../src/lib/film/filmCore.js';

const D = Math.PI / 180;
/** @param {number[]} a @param {number[]} b angle between two orientations, degrees */
const angle = (a, b) => {
	const d = quatMul(quatConj(a), b);
	return (2 * Math.acos(Math.min(1, Math.abs(d[3])))) / D;
};
/** a camera at yaw / pitch / roll (degrees): Ry · Rx · Rz @param {number} y @param {number} p @param {number} r */
const cam = (y, p, r = 0) => quatNorm(quatMul(quatMul(quatAxisAngle([0, 1, 0], y * D), quatAxisAngle([1, 0, 0], p * D)), quatAxisAngle([0, 0, 1], r * D)));

// pitch -88 / -90 / -60, upright and with the phone's tilt PAST the pole (pitch -92 seen as -88 with a 180 roll)
const CASES = [
	['-88', cam(30, -88)],
	['-90', cam(30, -90)],
	['-60', cam(30, -60)],
	['-88 past the pole', cam(30, -92)],
	['-88 with roll', cam(-140, -88, 25)]
];

describe('G4 Film hand-over carries the quaternion', () => {
	for (const [label, sensorQ] of CASES) {
		it(`Tilt -> Touch -> Tilt keeps the view at pitch ${label}`, () => {
			const offset = quatAxisAngle([0, 1, 0], 47 * D); // a recentre from earlier
			const tiltView = quatNorm(quatMul(offset, /** @type {number[]} */ (sensorQ)));
			// Tilt -> Touch: the drag base is the view as it is, no drag yet
			const touchView = touchLook(tiltView.slice(), 0, 0);
			expect(angle(tiltView, touchView)).toBeLessThan(1);
			// Touch -> Tilt, the phone where it was
			const back = handoverOffset(/** @type {number[]} */ (sensorQ), touchView);
			const tiltAgain = quatNorm(quatMul(back, /** @type {number[]} */ (sensorQ)));
			expect(angle(touchView, tiltAgain)).toBeLessThan(1);
		});
	}
	it('the counterfactual: the old forward-yaw hand-over rolls a phone lying past the pole by ~180 deg', () => {
		const flat = cam(30, -92);
		expect(angle(flat, levelHorizon(flat))).toBeGreaterThan(150);
		// and the old yaw-only offset back to Tilt, straight down: the forward's yaw is atan2(0, 0) there
		const sensor = cam(30, -90);
		const view = quatMul(quatAxisAngle([0, 1, 0], 47 * D), sensor);
		const old = quatMul(recentreOffset(sensor, view), sensor);
		expect(angle(view, old)).toBeGreaterThan(10); // measured ~30 deg off
		expect(angle(view, quatMul(handoverOffset(sensor, view), sensor))).toBeLessThan(1);
	});
	it('a heading-only match when pitch differs (gravity stays the truth)', () => {
		const sensor = cam(10, -20);
		const target = cam(70, -45);
		const q = quatMul(handoverOffset(sensor, target), sensor);
		const f = (/** @type {number[]} */ x) => {
			const v = [0, 0, -1];
			const [qx, qy, qz, qw] = x;
			const ix = qw * v[0] + qy * v[2] - qz * v[1], iy = qw * v[1] + qz * v[0] - qx * v[2], iz = qw * v[2] + qx * v[1] - qy * v[0], iw = -qx * v[0] - qy * v[1] - qz * v[2];
			return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx];
		};
		const h = (/** @type {number[]} */ x) => Math.atan2(-f(x)[0], -f(x)[2]) / D;
		expect(Math.abs(h(q) - h(target))).toBeLessThan(1);
		expect(Math.abs(f(q)[1] - f(sensor)[1])).toBeLessThan(1e-9); // the pitch is the phone's
	});
	it('touch drag from a level start is the old yaw + pitch look', () => {
		const q = touchLook(cam(20, 0), 0.3, -0.2);
		expect(angle(q, cam(20 + 0.3 / D, -0.2 / D))).toBeLessThan(0.01);
		const capped = touchLook(cam(0, 0), 0, -3);
		expect(angle(capped, cam(0, -1.5 / D))).toBeLessThan(0.01);
	});
});
