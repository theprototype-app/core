// 102b-papercuts (scout row 18): cube-map skies are converted to an equirectangular .hdr on upload
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import {
	FACES, cubeLayoutOf, isEquirectShape, faceCells, splitCubeImage, cubeLookup, cubeToEquirect,
	encodeRGBE, faceOfFileName, facesFromFiles, fitEquirect, equirectWidthFor
} from '../../src/lib/hdri/cubeToEquirect.js';

/** the lookup direction through a face pixel centre (the inverse of cubeLookup) */
function faceDir(/** @type {string} */ face, /** @type {number} */ s, /** @type {number} */ t) {
	const sc = s * 2 - 1;
	const tc = t * 2 - 1;
	/** @type {Record<string, number[]>} */
	const d = {
		px: [1, -tc, -sc], nx: [-1, -tc, sc], py: [sc, 1, tc], ny: [sc, -1, -tc], pz: [sc, -tc, 1], nz: [-sc, -tc, -1]
	};
	const v = d[face];
	const l = Math.hypot(v[0], v[1], v[2]);
	return v.map((x) => x / l);
}
/** six faces painted with their own lookup direction (rgb = dir + 1) */
function paintedFaces(size = 16) {
	/** @type {any} */ const faces = {};
	for (const f of FACES) {
		const data = new Float32Array(size * size * 4);
		for (let y = 0; y < size; y++)
			for (let x = 0; x < size; x++) {
				const dir = faceDir(f, (x + 0.5) / size, (y + 0.5) / size);
				data.set([dir[0] + 1, dir[1] + 1, dir[2] + 1, 1], (y * size + x) * 4);
			}
		faces[f] = { data, width: size, height: size };
	}
	return faces;
}
/** pack faces into a layout image */
function packed(/** @type {any} */ faces, /** @type {any} */ layout) {
	const size = faces.px.width;
	const [cw, ch] = { hcross: [4, 3], vcross: [3, 4], hstrip: [6, 1], vstrip: [1, 6] }[/** @type {'hcross'} */ (layout)];
	const W = cw * size;
	const data = new Float32Array(W * ch * size * 4);
	const cells = faceCells(layout);
	for (const f of FACES) {
		const { cx, cy, turned } = /** @type {any} */ (cells)[f];
		for (let y = 0; y < size; y++)
			for (let x = 0; x < size; x++) {
				const sx = turned ? size - 1 - x : x;
				const sy = turned ? size - 1 - y : y;
				const si = (sy * size + sx) * 4;
				data.set(faces[f].data.subarray(si, si + 4), ((cy * size + y) * W + cx * size + x) * 4);
			}
	}
	return { data, width: W, height: ch * size };
}

describe('cube layouts', () => {
	it('recognises cross and strip shapes, and nothing else', () => {
		expect(cubeLayoutOf(4096, 3072)).toBe('hcross');
		expect(cubeLayoutOf(3072, 4096)).toBe('vcross');
		expect(cubeLayoutOf(6144, 1024)).toBe('hstrip');
		expect(cubeLayoutOf(1024, 6144)).toBe('vstrip');
		expect(cubeLayoutOf(2048, 1024)).toBe(null);
		expect(isEquirectShape(2048, 1024)).toBe(true);
		expect(isEquirectShape(4096, 3072)).toBe(false);
	});
	it('every layout splits back into the same six faces', () => {
		const faces = paintedFaces(8);
		for (const layout of ['hcross', 'vcross', 'hstrip', 'vstrip']) {
			const split = /** @type {any} */ (splitCubeImage(packed(faces, layout)));
			for (const f of FACES) expect(Array.from(split[f].data)).toEqual(Array.from(faces[f].data));
		}
	});
	it('the major-axis lookup lands in the middle of each face', () => {
		expect(cubeLookup(1, 0, 0)).toEqual({ face: 'px', s: 0.5, t: 0.5 });
		expect(cubeLookup(0, -1, 0).face).toBe('ny');
		expect(cubeLookup(0, 0, -1).face).toBe('nz');
		// +Y's bottom row meets +Z's top row (the cross is continuous)
		expect(cubeLookup(0, 1, 0.999).t).toBeGreaterThan(0.99);
		expect(cubeLookup(0, 0.999, 1).face).toBe('pz');
		expect(cubeLookup(0, 0.999, 1).t).toBeLessThan(0.01);
	});
});

describe('cubeToEquirect', () => {
	it('each equirect pixel holds the cube texel three would show in that direction (x flipped)', () => {
		const eq = cubeToEquirect(paintedFaces(32), 128);
		expect([eq.width, eq.height]).toEqual([128, 64]);
		let worst = 0;
		for (let r = 0; r < eq.height; r++)
			for (let c = 0; c < eq.width; c++) {
				const lat = (0.5 - (r + 0.5) / 64) * Math.PI;
				const phi = ((c + 0.5) / 128 - 0.5) * 2 * Math.PI;
				const want = [-Math.cos(phi) * Math.cos(lat), Math.sin(lat), Math.sin(phi) * Math.cos(lat)];
				const i = (r * 128 + c) * 4;
				for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(eq.data[i + k] - 1 - want[k]));
			}
		expect(worst).toBeLessThan(0.06);
	});
	it('the cross centre (+Z) is in front of the default camera direction after the flip rule: three looks down -Z, so +Z is behind it and the up face is up', () => {
		const eq = cubeToEquirect(paintedFaces(8), 64);
		// top row = straight up: +Y face (green channel ~2)
		expect(eq.data[(0 * 64 + 10) * 4 + 1]).toBeGreaterThan(1.9);
	});
	it('the width follows the face size and is capped', () => {
		expect(equirectWidthFor(256)).toBe(1024);
		expect(equirectWidthFor(2048)).toBe(2048);
		const big = { data: new Float32Array(4096 * 2048 * 4).fill(0.5), width: 4096, height: 2048 };
		const fit = fitEquirect(big);
		expect([fit.width, fit.height]).toEqual([2048, 1024]);
		expect(fit.data[100]).toBeCloseTo(0.5);
	});
});

describe('encodeRGBE', () => {
	it('three\'s HDRLoader reads it back (values within RGBE precision)', () => {
		const W = 16;
		const H = 8;
		const data = new Float32Array(W * H * 4);
		for (let i = 0; i < W * H; i++) data.set([i / 10, 1, 0.01 * i, 1], i * 4);
		const bytes = encodeRGBE({ data, width: W, height: H });
		const t = /** @type {any} */ (new HDRLoader().setDataType(THREE.FloatType).parse(/** @type {ArrayBuffer} */ (bytes.buffer)));
		expect([t.width, t.height]).toEqual([W, H]);
		for (let i = 0; i < W * H; i++)
			for (let k = 0; k < 3; k++) {
				const want = data[i * 4 + k];
				// RGBE shares one exponent per pixel: the error scales with the pixel's brightest channel
				const peak = Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
				expect(Math.abs(t.data[i * 4 + k] - want)).toBeLessThanOrEqual(peak / 200);
			}
	});
});

describe('separate face files', () => {
	it('names say which face', () => {
		expect(faceOfFileName('sky_px.hdr')).toBe('px');
		expect(faceOfFileName('Bridge2/negz.jpg')).toBe('nz');
		expect(faceOfFileName('skybox_right.png')).toBe('px');
		expect(faceOfFileName('cloudy-Back.jpg')).toBe('nz');
		expect(faceOfFileName('city_dn.png')).toBe('ny');
		expect(faceOfFileName('photo.jpg')).toBe(null);
		expect(faceOfFileName('sky_-x.png')).toBe('nx');
		expect(faceOfFileName('sky_+x.png')).toBe('px');
		expect(faceOfFileName('posy.hdr')).toBe('py');
		expect(faceOfFileName('desktop.png')).toBe(null);
	});
	it('six square, same-size, distinct faces or the reason', () => {
		const f = paintedFaces(4);
		const files = FACES.map((face) => ({ name: 'a_' + face + '.png', image: f[face] }));
		expect('faces' in facesFromFiles(files)).toBe(true);
		expect(facesFromFiles(files.slice(0, 5))).toHaveProperty('error');
		expect(facesFromFiles([...files.slice(0, 5), { ...files[5], name: 'a_px.png' }])).toHaveProperty('error');
		expect(facesFromFiles([...files.slice(0, 5), { name: 'a_nz.png', image: paintedFaces(8).nz }])).toHaveProperty('error');
	});
});
