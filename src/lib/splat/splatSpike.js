// 102-splats P0 SPIKE — not wired into the app, not shipped. A suite imports it by URL on a dev
// server (`import('/src/lib/splat/splatSpike.js')`) to answer the spike's questions against the
// live render path: does Spark draw with post on (AO, TRAA, bloom), what does N splats cost, does
// a Photo still show it. Removed (or replaced by the real module) before the lane's PR.
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene, globalRenderer, globalCamera } from '../../stores/sceneStore';

/** @type {any} */
let spark = null;
/** @type {any} */
let mesh = null;
/** @type {any} */
let sparkRenderer = null;

/** A deterministic PRNG so every run draws the same cloud. */
function rng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Put a procedural splat cloud of `count` splats in front of the camera: a ground disc plus a
 * shell, coloured by position (no scan data). Returns timings.
 * @param {{count?: number, radius?: number, at?: number[], lod?: boolean}} [o]
 */
export async function addCloud(o = {}) {
	const count = o.count ?? 1_000_000;
	const t0 = performance.now();
	if (!spark) spark = await import('@sparkjsdev/spark');
	const tImport = performance.now() - t0;
	const scene = /** @type {any} */ (get(globalScene));
	const renderer = /** @type {any} */ (get(globalRenderer));
	if (!sparkRenderer) {
		sparkRenderer = new spark.SparkRenderer({ renderer });
		sparkRenderer.name = 'spike-spark-renderer';
		scene.add(sparkRenderer);
	}
	removeCloud(true);
	const R = o.radius ?? 3;
	const rand = rng(102);
	const c = new THREE.Vector3();
	const s = new THREE.Vector3();
	const q = new THREE.Quaternion();
	const col = new THREE.Color();
	const t1 = performance.now();
	mesh = new spark.SplatMesh({
		maxSplats: count,
		lod: o.lod ?? false,
		constructSplats: (/** @type {any} */ splats) => {
			for (let i = 0; i < count; i++) {
				if (i % 2) {
					// ground disc
					const r = R * 1.6 * Math.sqrt(rand());
					const a = rand() * Math.PI * 2;
					c.set(Math.cos(a) * r, 0, Math.sin(a) * r);
					s.set(0.02, 0.004, 0.02);
				} else {
					const u = rand() * 2 - 1;
					const a = rand() * Math.PI * 2;
					const k = Math.sqrt(1 - u * u);
					c.set(k * Math.cos(a) * R * 0.5, R * 0.5 + u * R * 0.5, k * Math.sin(a) * R * 0.5);
					s.set(0.012, 0.012, 0.012);
				}
				q.setFromEuler(new THREE.Euler(rand() * 6.28, rand() * 6.28, 0));
				col.setRGB(0.5 + c.x / (R * 3.2), 0.4 + c.y / (R * 2), 0.5 + c.z / (R * 3.2));
				splats.pushSplat(c, s, q, 0.6 + rand() * 0.4, col);
			}
		}
	});
	mesh.name = 'spike-splats';
	const at = o.at ?? [0, 0, -4];
	mesh.position.set(at[0], at[1], at[2]);
	scene.add(mesh);
	await mesh.initialized;
	return { importMs: Math.round(tImport), buildMs: Math.round(performance.now() - t1), splats: mesh.packedSplats?.numSplats ?? count };
}

/** @param {boolean} [keepRenderer] */
export function removeCloud(keepRenderer = false) {
	if (mesh) {
		mesh.parent?.remove(mesh);
		mesh.dispose?.();
		mesh = null;
	}
	if (!keepRenderer && sparkRenderer) {
		sparkRenderer.parent?.remove(sparkRenderer);
		sparkRenderer.dispose?.();
		sparkRenderer = null;
	}
}

/** Point the editor camera at the cloud. */
export function lookAtCloud() {
	const cam = /** @type {any} */ (get(globalCamera));
	if (!cam || !mesh) return false;
	cam.position.set(mesh.position.x + 5, mesh.position.y + 3, mesh.position.z + 5);
	cam.lookAt(mesh.position.x, mesh.position.y + 1, mesh.position.z);
	return true;
}

/**
 * Frames per second over `ms`, plus frame-time percentiles and draw calls of the last frame.
 * @param {number} [ms]
 */
export function measure(ms = 4000) {
	const renderer = /** @type {any} */ (get(globalRenderer));
	return new Promise((resolve) => {
		/** @type {number[]} */
		const dts = [];
		let last = performance.now();
		const start = last;
		const step = () => {
			const now = performance.now();
			dts.push(now - last);
			last = now;
			if (now - start < ms) requestAnimationFrame(step);
			else {
				const sorted = [...dts].sort((a, b) => a - b);
				const pick = (/** @type {number} */ p) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 10) / 10;
				resolve({ fps: Math.round((dts.length / (now - start)) * 10000) / 10, p50: pick(0.5), p95: pick(0.95), calls: renderer?.info?.render?.calls ?? -1 });
			}
		};
		requestAnimationFrame(step);
	});
}

/**
 * Mean RGB of the canvas's centre region and how much of it differs from a flat colour
 * (read through a fresh render into the drawing buffer).
 */
export function centreStats() {
	const renderer = /** @type {any} */ (get(globalRenderer));
	const src = renderer.domElement;
	const w = 160;
	const h = Math.round((w * src.height) / src.width);
	const cv = document.createElement('canvas');
	cv.width = w;
	cv.height = h;
	const ctx = /** @type {CanvasRenderingContext2D} */ (cv.getContext('2d'));
	ctx.drawImage(src, 0, 0, w, h);
	const d = ctx.getImageData(w / 4, h / 4, w / 2, h / 2).data;
	let r = 0, g = 0, b = 0, n = 0;
	for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
	r /= n; g /= n; b /= n;
	let varSum = 0;
	for (let i = 0; i < d.length; i += 4) varSum += Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b);
	return { r: Math.round(r), g: Math.round(g), b: Math.round(b), spread: Math.round(varSum / n) };
}

export const spikeState = () => ({ hasSpark: !!spark, hasMesh: !!mesh, numSplats: mesh?.packedSplats?.numSplats ?? 0, version: spark ? 'loaded' : '' });
