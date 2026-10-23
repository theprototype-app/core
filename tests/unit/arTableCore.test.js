import { describe, it, expect } from 'vitest';
import {
	contentAnchor,
	tableScale,
	rigPose,
	placedPoint,
	pinchTwist,
	touchPair,
	wrapAngle,
	isTap,
	isFlat,
	arEntryState,
	scaleLabel,
	TABLE_SIZE,
	MIN_SCALE,
	MAX_SCALE,
	AR_UNSUPPORTED_NOTE
} from '../../src/lib/arTableCore.js';

/** @param {number} a @param {number} b @param {number} [eps] */
const close = (a, b, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('arTableCore — the anchor and the default size', () => {
	it('anchors at the middle of the footprint, at its lowest point', () => {
		expect(contentAnchor({ min: [-4, -1, 2], max: [6, 3, 10] })).toEqual([1, -1, 6]);
	});
	it('an empty scene anchors at the origin', () => {
		expect(contentAnchor(null)).toEqual([0, 0, 0]);
		expect(contentAnchor({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] })).toEqual([0, 0, 0]);
	});
	it('fits the longer side of the footprint to a table', () => {
		close(tableScale({ min: [-25, 0, -10], max: [25, 5, 10] }), TABLE_SIZE / 50);
		close(tableScale({ min: [0, 0, 0], max: [3, 40, 12] }), TABLE_SIZE / 12); // height does not count
	});
	it('never blows a tiny scene up and never goes below the floor', () => {
		expect(tableScale(null)).toBe(Math.min(MAX_SCALE, TABLE_SIZE / 1));
		expect(tableScale({ min: [0, 0, 0], max: [0.1, 0.1, 0.1] })).toBe(TABLE_SIZE);
		expect(tableScale({ min: [-1e6, 0, 0], max: [1e6, 0, 0] })).toBe(MIN_SCALE);
	});
});

describe('arTableCore — the rig pose', () => {
	const p = { hit: [0.3, 0.75, -0.5], yaw: 0.7, scale: 0.02, anchor: [10, -2, -6] };
	it('stands the anchor exactly on the hit point', () => {
		const at = placedPoint(p.anchor, p);
		at.forEach((v, i) => close(v, p.hit[i], 1e-12));
	});
	it('scales distances and keeps up up', () => {
		const a = placedPoint([0, 0, 0], p);
		const b = placedPoint([0, 10, 0], p);
		close(b[1] - a[1], 0.2, 1e-12);
		close(Math.hypot(b[0] - a[0], b[2] - a[2]), 0, 1e-12);
		const c = placedPoint([10, 0, 0], p);
		close(Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]), 0.2, 1e-12);
	});
	it('turns about +Y by the yaw (three convention: +x goes to -z for +90°)', () => {
		const q = { hit: [0, 0, 0], yaw: Math.PI / 2, scale: 1, anchor: [0, 0, 0] };
		const x = placedPoint([1, 0, 0], q);
		close(x[0], 0, 1e-12);
		close(x[2], -1, 1e-12);
		const pose = rigPose(q);
		close(pose.quaternion[1], Math.SQRT1_2, 1e-12);
		close(pose.quaternion[3], Math.SQRT1_2, 1e-12);
	});
});

describe('arTableCore — the two-finger gesture', () => {
	it('pinch scales by the spread ratio', () => {
		const from = touchPair([{ x: 100, y: 300 }, { x: 200, y: 300 }]);
		const to = touchPair([{ x: 50, y: 300 }, { x: 250, y: 300 }]);
		const r = pinchTwist({ scale: 0.02, yaw: 0 }, from, to);
		close(r.scale, 0.04);
		close(r.yaw, 0);
	});
	it('a clockwise twist on screen turns the scene clockwise from above (negative yaw)', () => {
		const from = touchPair([{ x: 100, y: 300 }, { x: 200, y: 300 }]);
		// the second finger swings DOWN the screen = clockwise (y is down)
		const to = touchPair([{ x: 100, y: 300 }, { x: 100 + 100 * Math.cos(0.5), y: 300 + 100 * Math.sin(0.5) }]);
		const r = pinchTwist({ scale: 0.02, yaw: 0.2 }, from, to);
		close(r.scale, 0.02, 1e-9);
		close(r.yaw, -0.3, 1e-9);
	});
	it('scale is clamped and yaw wraps', () => {
		const from = touchPair([{ x: 0, y: 0 }, { x: 10, y: 0 }]);
		const to = touchPair([{ x: 0, y: 0 }, { x: 1e6, y: 0 }]);
		expect(pinchTwist({ scale: 0.5, yaw: 0 }, from, to).scale).toBe(MAX_SCALE);
		close(wrapAngle(3 * Math.PI), Math.PI);
		close(wrapAngle(-3 * Math.PI / 2), Math.PI / 2);
	});
	it('a zero spread start leaves the scale alone', () => {
		const from = { distance: 0, angle: 0 };
		expect(pinchTwist({ scale: 0.1, yaw: 0 }, from, { distance: 50, angle: 0 }).scale).toBe(0.1);
	});
});

describe('arTableCore — taps, surfaces, support, labels', () => {
	it('a tap is short and still', () => {
		expect(isTap({ dx: 3, dy: 4, ms: 120 })).toBe(true);
		expect(isTap({ dx: 30, dy: 0, ms: 120 })).toBe(false);
		expect(isTap({ dx: 0, dy: 0, ms: 900 })).toBe(false);
	});
	it('a table is flat; a wall is not', () => {
		expect(isFlat([0, 1, 0])).toBe(true);
		expect(isFlat([0, 0, 1])).toBe(false);
	});
	it('no WebXR (iPhone) or no immersive-ar (desktop) is the note, never a button', () => {
		expect(arEntryState({ hasXR: false, arSupported: null })).toBe('unsupported');
		expect(arEntryState({ hasXR: true, arSupported: false })).toBe('unsupported');
		expect(arEntryState({ hasXR: true, arSupported: null })).toBe('checking');
		expect(arEntryState({ hasXR: true, arSupported: true })).toBe('ready');
		expect(AR_UNSUPPORTED_NOTE).toBe('AR needs Android Chrome');
	});
	it('labels the scale as a ratio', () => {
		expect(scaleLabel(0.025)).toBe('1:40');
		expect(scaleLabel(1)).toBe('1:1');
		expect(scaleLabel(0.004)).toBe('1:250');
		expect(scaleLabel(0)).toBe('');
	});
});
