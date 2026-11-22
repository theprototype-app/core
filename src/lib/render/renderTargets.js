// 101 F3 — ONE FACTORY FOR RENDER TARGETS, ONE PATH FOR READBACKS (a leaf: three only).
//
// Every off-screen target the app makes goes through `createRenderTarget` (same arguments as
// `new THREE.WebGLRenderTarget`, same object back), so `disposeRenderer()` can release the ones
// still alive and roadmap 100 can hand out its own renderer's kind from here. A target leaves the
// registry when its owner disposes it.
//
// READBACKS return a Promise (`readPixels`): WebGPU can only read back asynchronously, so every
// caller is async now. Today the read itself still happens SYNCHRONOUSLY at the call (the GPU
// state the caller set up is the state that is read — no frame can run in between), and the
// promise only hands the buffer back; `{ async: true }` uses three's fenced
// `readRenderTargetPixelsAsync` where it exists (the photo mode's final read, as before).
// `readPixelsSync` is for the callers that truly cannot wait (listed in the 101-seam STATUS):
// photoRender's `cubeUvToEquirect`, which swaps the LIVE scene's environment around the read.
import * as THREE from 'three';

/** live targets made through the factory @type {Set<THREE.WebGLRenderTarget>} */
const live = new Set();

/**
 * `new THREE.WebGLRenderTarget(width, height, options)`, registered with the seam.
 * @param {number} [width] @param {number} [height] @param {THREE.RenderTargetOptions} [options]
 * @returns {THREE.WebGLRenderTarget}
 */
export function createRenderTarget(width, height, options) {
	const target = new THREE.WebGLRenderTarget(width, height, options);
	live.add(target);
	// `__keep`: the app's own listener, never pruned with a renderer generation (./generations.js)
	const gone = Object.assign(() => live.delete(target), { __keep: 1 });
	target.addEventListener('dispose', gone);
	return target;
}

/** how many factory targets are alive (unit + e2e probe) */
export function liveRenderTargets() {
	return live.size;
}

/** the live factory targets (100 C1: the generation sweep) */
export function renderTargetList() {
	return [...live];
}

/** dispose every factory target still alive (disposeRenderer's half); returns how many */
export function disposeRenderTargets() {
	const n = live.size;
	for (const target of [...live]) target.dispose();
	live.clear();
	return n;
}

/**
 * Read `w`×`h` pixels at (`x`, `y`) of `target` into `buffer`, now. Returns the buffer.
 * @template {ArrayBufferView} B
 * @param {any} renderer @param {any} target @param {number} x @param {number} y @param {number} w @param {number} h @param {B} buffer
 * @returns {B}
 */
export function readPixelsSync(renderer, target, x, y, w, h, buffer) {
	renderer.readRenderTargetPixels(target, x, y, w, h, buffer);
	return buffer;
}

/**
 * Read `w`×`h` pixels at (`x`, `y`) of `target` into `buffer`; resolves with the buffer.
 * @template {ArrayBufferView} B
 * @param {any} renderer @param {any} target @param {number} x @param {number} y @param {number} w @param {number} h @param {B} buffer
 * @param {{ async?: boolean }} [opts] `async: true` = three's fenced read where the renderer has it
 * @returns {Promise<B>}
 */
export async function readPixels(renderer, target, x, y, w, h, buffer, opts = {}) {
	if (opts.async && renderer.readRenderTargetPixelsAsync) {
		await renderer.readRenderTargetPixelsAsync(target, x, y, w, h, buffer);
		return buffer;
	}
	return readPixelsSync(renderer, target, x, y, w, h, buffer);
}
