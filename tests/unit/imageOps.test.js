// 40-image (F13): the Image editor's pixel maths, with no canvas.
import { describe, it, expect } from 'vitest';
import {
	makeRaster,
	clampRect,
	aspectRect,
	cropRaster,
	rotateRaster,
	flipRaster,
	resizeRaster,
	adjustRaster,
	isIdentityAdjust,
	fitSize,
	nearestPow2,
	encodingFor,
	MAX_SIDE
} from '../../src/lib/image/imageOps.js';

/** a W x H raster whose pixel (x, y) is [x, y, x + y, 255] — every pixel distinct and readable */
/** @param {number} W @param {number} H */
function grid(W, H) {
	const img = makeRaster(W, H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) img.data.set([x, y, x + y, 255], (y * W + x) * 4);
	return img;
}
/** @param {import('../../src/lib/image/imageOps.js').Raster} img @param {number} x @param {number} y */
const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

describe('clampRect / aspectRect', () => {
	it('normalises a backwards drag and keeps the rect inside', () => {
		expect(clampRect({ x: 10, y: 8, w: -6, h: -4 }, 20, 20)).toEqual({ x: 4, y: 4, w: 6, h: 4 });
		expect(clampRect({ x: -5, y: -5, w: 100, h: 100 }, 20, 10)).toEqual({ x: 0, y: 0, w: 20, h: 10 });
		expect(clampRect({ x: 3, y: 3, w: 0, h: 0 }, 20, 10)).toEqual({ x: 3, y: 3, w: 1, h: 1 });
	});
	it('fits the largest centred box of a ratio', () => {
		expect(aspectRect(200, 100, 1)).toEqual({ x: 50, y: 0, w: 100, h: 100 });
		expect(aspectRect(100, 200, 16 / 9)).toEqual({ x: 0, y: 72, w: 100, h: 56 });
		expect(aspectRect(30, 20, 0)).toEqual({ x: 0, y: 0, w: 30, h: 20 });
	});
});

describe('crop / rotate / flip', () => {
	const img = grid(4, 3);
	it('crops to exactly the rect', () => {
		const out = cropRaster(img, { x: 1, y: 1, w: 2, h: 2 });
		expect([out.width, out.height]).toEqual([2, 2]);
		expect(px(out, 0, 0)).toEqual([1, 1, 2, 255]);
		expect(px(out, 1, 1)).toEqual([2, 2, 4, 255]);
	});
	it('rotates clockwise: the top-left corner lands top-right', () => {
		const cw = rotateRaster(img, 1);
		expect([cw.width, cw.height]).toEqual([3, 4]);
		expect(px(cw, 2, 0)).toEqual(px(img, 0, 0));
		expect(px(cw, 0, 0)).toEqual(px(img, 0, 2)); // bottom-left comes to the top-left
		const ccw = rotateRaster(img, -1);
		expect(px(ccw, 0, 3)).toEqual(px(img, 0, 0)); // counter-clockwise: to the bottom-left
	});
	it('four quarter turns and two flips are the identity', () => {
		let r = img;
		for (let i = 0; i < 4; i++) r = rotateRaster(r, 1);
		expect(Array.from(r.data)).toEqual(Array.from(img.data));
		expect(Array.from(flipRaster(flipRaster(img, 'h'), 'h').data)).toEqual(Array.from(img.data));
		expect(Array.from(rotateRaster(img, 2).data)).toEqual(Array.from(flipRaster(flipRaster(img, 'h'), 'v').data));
	});
	it('flips about the right axis', () => {
		expect(px(flipRaster(img, 'h'), 0, 0)).toEqual(px(img, 3, 0));
		expect(px(flipRaster(img, 'v'), 0, 0)).toEqual(px(img, 0, 2));
	});
	it('never mutates its input', () => {
		const before = Array.from(img.data);
		cropRaster(img, { x: 0, y: 0, w: 2, h: 2 });
		rotateRaster(img, 1);
		flipRaster(img, 'v');
		resizeRaster(img, 9, 9);
		adjustRaster(img, { brightness: 50 });
		expect(Array.from(img.data)).toEqual(before);
	});
});

describe('resize', () => {
	it('an area shrink of a flat image keeps its colour', () => {
		const flat = makeRaster(64, 64);
		for (let i = 0; i < flat.data.length; i += 4) flat.data.set([200, 100, 50, 255], i);
		const out = resizeRaster(flat, 7, 5);
		expect([out.width, out.height]).toEqual([7, 5]);
		for (let i = 0; i < out.data.length; i += 4) expect(Array.from(out.data.subarray(i, i + 4))).toEqual([200, 100, 50, 255]);
	});
	it('a 2x shrink of a checkerboard averages it (no aliasing)', () => {
		const ck = makeRaster(8, 8);
		for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) ck.data.set((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * 8 + x) * 4);
		const out = resizeRaster(ck, 4, 4);
		for (let i = 0; i < out.data.length; i += 4) expect(Math.abs(out.data[i] - 128)).toBeLessThanOrEqual(1);
	});
	it('a transparent neighbour does not darken an opaque edge', () => {
		const img = makeRaster(2, 1);
		img.data.set([255, 255, 255, 255, 0, 0, 0, 0]); // white | transparent black
		const out = resizeRaster(img, 1, 1);
		expect(out.data[0]).toBe(255);
		expect(out.data[3]).toBe(128);
	});
	it('clamps to MAX_SIDE and at least one pixel', () => {
		const out = resizeRaster(makeRaster(2, 2), 0, MAX_SIDE * 2);
		expect([out.width, out.height]).toEqual([1, MAX_SIDE]);
	});
	it('a grow interpolates between neighbours', () => {
		const img = makeRaster(2, 1);
		img.data.set([0, 0, 0, 255, 200, 200, 200, 255]);
		const out = resizeRaster(img, 4, 1);
		const reds = [0, 1, 2, 3].map((x) => out.data[x * 4]);
		expect(reds[0]).toBe(0);
		expect(reds[3]).toBe(200);
		expect(reds[1]).toBeGreaterThan(0);
		expect(reds[2]).toBeLessThan(200);
	});
});

describe('adjust', () => {
	const mid = makeRaster(1, 1);
	mid.data.set([100, 150, 200, 77]);
	it('zero is the identity and alpha is never touched', () => {
		expect(isIdentityAdjust({ brightness: 0, contrast: 0, saturation: 0 })).toBe(true);
		expect(Array.from(adjustRaster(mid, {}).data)).toEqual([100, 150, 200, 77]);
		expect(adjustRaster(mid, { brightness: 40, contrast: 30, saturation: -50 }).data[3]).toBe(77);
	});
	it('brightness lifts every channel', () => {
		const out = adjustRaster(mid, { brightness: 20 });
		expect(Array.from(out.data.subarray(0, 3))).toEqual([151, 201, 251]);
	});
	it('contrast pushes away from mid-grey', () => {
		const out = adjustRaster(mid, { contrast: 50 });
		expect(out.data[0]).toBeLessThan(100);
		expect(out.data[2]).toBeGreaterThan(200);
	});
	it('saturation -100 is grey at the pixel luma', () => {
		const out = adjustRaster(mid, { saturation: -100 });
		expect(out.data[0]).toBe(out.data[1]);
		expect(out.data[1]).toBe(out.data[2]);
		expect(Math.abs(out.data[0] - Math.round(0.2126 * 100 + 0.7152 * 150 + 0.0722 * 200))).toBeLessThanOrEqual(1);
	});
});

describe('sizes and encodings', () => {
	it('fits without enlarging', () => {
		expect(fitSize(4000, 2000, 1000, 1000)).toEqual({ width: 1000, height: 500, scale: 0.25 });
		expect(fitSize(100, 50, 1000, 1000).scale).toBe(1);
	});
	it('rounds to the nearest power of two', () => {
		expect(nearestPow2(700)).toBe(512);
		expect(nearestPow2(800)).toBe(1024);
		expect(nearestPow2(768)).toBe(1024);
	});
	it('keeps a writable format and turns the rest into PNG', () => {
		expect(encodingFor('a.JPG').type).toBe('image/jpeg');
		expect(encodingFor('a.webp').type).toBe('image/webp');
		expect(encodingFor('a.png')).toEqual({ type: 'image/png', name: 'a.png' });
		expect(encodingFor('anim.gif')).toEqual({ type: 'image/png', name: 'anim.png' });
	});
});
