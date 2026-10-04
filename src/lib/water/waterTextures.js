// 36-water — the one tiling detail texture every water surface scrolls: RGB = a tangent
// normal (x/y in R/G, from a periodic fBm height field), A = a separate periodic fBm the
// foam is broken up with. Built once, deterministically (no RNG), at first use.
import * as THREE from 'three';

const SIZE = 256;

/** integer hash → [0, 1) @param {number} x @param {number} y @param {number} s */
function hash(x, y, s) {
	let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** periodic value noise: lattice of `period` cells over [0,1) @param {number} u @param {number} v @param {number} period @param {number} seed */
function vnoise(u, v, period, seed) {
	const x = u * period;
	const y = v * period;
	const xi = Math.floor(x);
	const yi = Math.floor(y);
	const fx = x - xi;
	const fy = y - yi;
	const sx = fx * fx * (3 - 2 * fx);
	const sy = fy * fy * (3 - 2 * fy);
	const p = (/** @type {number} */ i) => ((i % period) + period) % period;
	const a = hash(p(xi), p(yi), seed);
	const b = hash(p(xi + 1), p(yi), seed);
	const c = hash(p(xi), p(yi + 1), seed);
	const d = hash(p(xi + 1), p(yi + 1), seed);
	return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** @param {number} u @param {number} v @param {number} base @param {number} seed */
function fbm(u, v, base, seed) {
	let sum = 0;
	let amp = 0.5;
	let norm = 0;
	for (let o = 0; o < 4; o++) {
		sum += vnoise(u, v, base << o, seed + o * 17) * amp;
		norm += amp;
		amp *= 0.5;
	}
	return sum / norm;
}

/** @type {any} */
let cached = null;

/** The shared detail texture (RepeatWrapping, mipmapped). */
export function waterDetailTexture() {
	if (cached) return cached;
	const height = new Float32Array(SIZE * SIZE);
	for (let y = 0; y < SIZE; y++)
		for (let x = 0; x < SIZE; x++) height[y * SIZE + x] = fbm(x / SIZE, y / SIZE, 6, 3);
	const data = new Uint8Array(SIZE * SIZE * 4);
	const k = 3.2; // bump strength
	for (let y = 0; y < SIZE; y++) {
		for (let x = 0; x < SIZE; x++) {
			const xl = height[y * SIZE + ((x + SIZE - 1) % SIZE)];
			const xr = height[y * SIZE + ((x + 1) % SIZE)];
			const yd = height[((y + SIZE - 1) % SIZE) * SIZE + x];
			const yu = height[((y + 1) % SIZE) * SIZE + x];
			let nx = (xl - xr) * k;
			let ny = (yd - yu) * k;
			const nz = 1;
			const len = Math.hypot(nx, ny, nz);
			nx /= len;
			ny /= len;
			const i = (y * SIZE + x) * 4;
			data[i] = Math.round((nx * 0.5 + 0.5) * 255);
			data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
			data[i + 2] = Math.round((nz / len) * 255);
			data[i + 3] = Math.round(fbm(x / SIZE, y / SIZE, 8, 41) * 255);
		}
	}
	const tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
	tex.wrapS = THREE.RepeatWrapping;
	tex.wrapT = THREE.RepeatWrapping;
	tex.magFilter = THREE.LinearFilter;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.generateMipmaps = true;
	tex.colorSpace = THREE.NoColorSpace;
	tex.needsUpdate = true;
	cached = tex;
	return tex;
}
