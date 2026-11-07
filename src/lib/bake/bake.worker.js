// 98 P1 — the BAKE WORKER. Every heavy step of a bake runs here, so the editor keeps its frames:
//   plan   — unwrap + atlas + one sample per covered texel (bakePlanCore), samples SHUFFLED so a
//            bake stopped by its time cap leaves scattered single texels the dilation fills,
//            never a missing object
//   trace  — AO + one bounce over a slice of samples, with progress, stopping at its deadline
//   finish — splat, denoise, dilate, encode, and the PNGs (full + the phone / Quest copy)
// Cancel is the runner terminating the worker: nothing here has to poll for it.
// No three.js in here (the cores are plain JS), which keeps this chunk small.

import { planBake } from './bakePlanCore.js';
import { buildBvh } from './bakeTraceCore.js';
import { hemisphereDirs, traceSamples, resolveTexels, encodeAtlas, downscaleAtlas, lightScaleOf } from './bakeKernelCore.js';
import { GUTTER, imageWidth } from './bakeAtlasCore.js';

/** @param {any} msg @param {Transferable[]} [transfer] */
function post(msg, transfer = []) {
	/** @type {any} */ (self).postMessage(msg, transfer);
}

/** a stride permutation (deterministic): neighbours in the list are far apart in the atlas @param {number} n */
function strideOrder(n) {
	const out = new Uint32Array(n);
	if (!n) return out;
	let stride = Math.max(1, Math.floor(n * 0.618034));
	/** @type {(a: number, b: number) => number} */
	const gcd = (a, b) => (b ? gcd(b, a % b) : a);
	while (gcd(stride, n) !== 1) stride++;
	for (let i = 0, j = 0; i < n; i++, j = (j + stride) % n) out[i] = j;
	return out;
}

/** @param {any} msg */
async function handle(msg) {
	const { op, id } = msg;
	if (op === 'plan') {
		const plan = planBake(msg.meshes, msg.budget);
		if ('error' in plan) return post({ op, id, error: plan.error });
		const n = plan.texelOf.length;
		const order = strideOrder(n);
		const samples = new Float32Array(n * 6);
		const texelOf = new Uint32Array(n);
		const aoOnly = new Uint8Array(n);
		for (let i = 0; i < n; i++) {
			const j = order[i];
			samples.set(plan.samples.subarray(j * 6, j * 6 + 6), i * 6);
			texelOf[i] = plan.texelOf[j];
			aoOnly[i] = plan.aoOnly[j];
		}
		return post(
			{ op, id, ...plan, samples, texelOf, aoOnly },
			[samples.buffer, texelOf.buffer, aoOnly.buffer, plan.tris.buffer, plan.albedo.buffer]
		);
	}
	if (op === 'trace') {
		const started = performance.now();
		const deadline = started + Math.max(0, msg.timeLeftMs);
		const bvh = buildBvh(msg.tris);
		const scene = {
			bvh,
			albedo: msg.albedo,
			lights: msg.lights,
			dirs: hemisphereDirs(msg.rays),
			aoDistance: msg.aoDistance,
			bias: msg.bias,
			far: msg.far,
			bounce: msg.bounce,
			aoOnly: msg.aoOnly
		};
		const count = msg.samples.length / 6;
		const ao = new Float32Array(count);
		const light = new Float32Array(count * 3);
		const CHUNK = 1024;
		let done = 0;
		let lastPost = 0;
		const now = () => performance.now();
		while (done < count) {
			const from = done;
			const to = Math.min(count, from + CHUNK);
			const got = traceSamples(scene, msg.samples, ao, light, from, to, deadline, now);
			done += got;
			if (got < to - from || now() > deadline) break; // the time cap
			if (now() - lastPost > 150) {
				lastPost = now();
				post({ op: 'progress', id, done, count });
			}
		}
		return post({ op, id, ao, light, done, count, ms: performance.now() - started }, [ao.buffer, light.buffer]);
	}
	if (op === 'finish') {
		const { side, count } = msg;
		const r = resolveTexels(msg.texelOf, msg.ao, msg.light, count, side);
		const lightScale = lightScaleOf(r.light, r.covered);
		const rgba = encodeAtlas(r.ao, r.light, side, lightScale, GUTTER);
		const full = await png(rgba, imageWidth(side), side);
		let lite = null;
		if (msg.liteSide && msg.liteSide < side) {
			const small = downscaleAtlas(rgba, side, Math.round(side / msg.liteSide), GUTTER);
			lite = { side: small.side, png: await png(small.rgba, imageWidth(small.side), small.side) };
		}
		let covered = 0;
		for (let t = 0; t < r.covered.length; t++) covered += r.covered[t];
		const transfer = [full];
		if (lite) transfer.push(lite.png);
		return post({ op, id, lightScale, covered, full: { side, png: full }, lite }, transfer);
	}
}

/** RGBA -> PNG bytes through an OffscreenCanvas @param {Uint8ClampedArray} rgba @param {number} w @param {number} h */
async function png(rgba, w, h) {
	const canvas = new OffscreenCanvas(w, h);
	const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
	ctx.putImageData(new ImageData(/** @type {any} */ (rgba), w, h), 0, 0);
	const blob = await canvas.convertToBlob({ type: 'image/png' });
	return blob.arrayBuffer();
}

self.onmessage = (event) => {
	handle(event.data).catch((error) => post({ op: event.data?.op, id: event.data?.id, error: String(error?.message ?? error) }));
};
