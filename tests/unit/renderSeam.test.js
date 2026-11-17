// 101 F3: the renderer seam — the factory tracks what it made, disposeRenderer() releases all of
// it, readbacks resolve with the buffer read AT THE CALL, the shared thumbnail renderer is made once,
// reset to a fresh renderer's state per borrow and disposed after idle.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

/** a stand-in WebGLRenderer: node has no GL, and the seam only needs the calls it makes */
class FakeRenderer {
	static made = 0;
	/** @param {any} [opts] */
	constructor(opts = {}) {
		FakeRenderer.made++;
		this.opts = opts;
		this.domElement = { width: 300, height: 150, isFake: true };
		this.pixelRatio = 1;
		this.disposed = false;
		this.lost = false;
		this.toneMapping = 4;
		this.toneMappingExposure = 2;
		this.outputColorSpace = 'x';
		this.autoClear = false;
		this.shadowMap = { enabled: true };
		this.localClippingEnabled = true;
		this.info = { memory: { geometries: 1, textures: 2 }, programs: [1, 2] };
		this.renderLists = { dispose: vi.fn() };
		/** @type {any[]} */
		this.calls = [];
	}
	setRenderTarget(/** @type {any} */ t) { this.calls.push(['target', t]); }
	getPixelRatio() { return this.pixelRatio; }
	setPixelRatio(/** @type {number} */ v) { this.pixelRatio = v; this.calls.push(['ratio', v]); }
	setSize(/** @type {number} */ w, /** @type {number} */ h) { this.domElement.width = Math.floor(w * this.pixelRatio); this.domElement.height = Math.floor(h * this.pixelRatio); this.calls.push(['size', w, h]); }
	setViewport(/** @type {number[]} */ ...v) { this.calls.push(['viewport', ...v]); }
	setClearColor() {}
	setAnimationLoop() {}
	dispose() { this.disposed = true; }
	forceContextLoss() { this.lost = true; }
	readRenderTargetPixels(/** @type {any} */ _t, /** @type {number} */ _x, /** @type {number} */ _y, /** @type {number} */ w, /** @type {number} */ h, /** @type {any} */ buf) { buf.fill(7, 0, w * h * 4); }
}

vi.mock('three', async (orig) => ({ ...(/** @type {any} */ (await orig())), WebGLRenderer: FakeRenderer }));

/** @type {any} */ let seam;
beforeEach(async () => {
	vi.useFakeTimers();
	vi.resetModules();
	FakeRenderer.made = 0;
	seam = await import('../../src/lib/render/index.js');
});
afterEach(() => vi.useRealTimers());

describe('render targets (101 F3)', () => {
	test('the factory makes a real target and tracks it until it is disposed', () => {
		const t = seam.createRenderTarget(4, 2, { depthBuffer: false });
		expect(t.isWebGLRenderTarget).toBe(true);
		expect([t.width, t.height, t.depthBuffer]).toEqual([4, 2, false]);
		expect(seam.liveRenderTargets()).toBe(1);
		t.dispose();
		expect(seam.liveRenderTargets()).toBe(0);
	});
	test('readPixels reads at the call and resolves with the buffer', async () => {
		const r = new FakeRenderer();
		const buf = new Uint8Array(16);
		const p = seam.readPixels(r, {}, 0, 0, 2, 2, buf);
		expect(buf[0]).toBe(7); // read already happened, before any await
		expect(await p).toBe(buf);
		expect(seam.readPixelsSync(r, {}, 0, 0, 1, 1, new Uint8Array(4))[3]).toBe(7);
	});
	test('readPixels {async: true} uses the fenced read where it exists', async () => {
		const r = /** @type {any} */ (new FakeRenderer());
		r.readRenderTargetPixelsAsync = vi.fn(async (_t, _x, _y, _w, _h, buf) => buf.fill(9));
		const buf = await seam.readPixels(r, {}, 0, 0, 1, 1, new Uint8Array(4), { async: true });
		expect(r.readRenderTargetPixelsAsync).toHaveBeenCalledOnce();
		expect(buf[0]).toBe(9);
	});
});

describe('the shared off-screen renderer (101 F3)', () => {
	test('one renderer for every thumbnail, in a fresh renderer state, same options as before', () => {
		const a = seam.renderOffscreen(128, 128, (/** @type {any} */ r) => r);
		const b = seam.renderOffscreen(256, 160, (/** @type {any} */ r) => r);
		expect(a).toBe(b);
		expect(FakeRenderer.made).toBe(1);
		expect(a.opts).toEqual({ antialias: true, alpha: true });
		expect([a.toneMapping, a.toneMappingExposure, a.outputColorSpace, a.autoClear, a.shadowMap.enabled, a.localClippingEnabled]).toEqual([0, 1, 'srgb', true, false, false]);
		expect([a.domElement.width, a.domElement.height]).toEqual([256, 160]);
	});
	test('a one-shot job frees its throw-away scene from the GPU (what losing the context did before)', async () => {
		const THREE = await import('three');
		const tex = new THREE.Texture();
		const mat = new THREE.MeshBasicMaterial({ map: tex });
		const geo = new THREE.BoxGeometry();
		const scene = new THREE.Scene();
		scene.add(new THREE.Mesh(geo, mat), new THREE.Mesh(geo, mat));
		const freed = [];
		for (const x of [tex, mat, geo]) x.addEventListener('dispose', () => freed.push(x.type ?? 'texture'));
		const url = seam.renderOffscreen(16, 16, () => 'data:x', { release: scene });
		expect(url).toBe('data:x');
		expect(freed.length).toBe(3); // each once, though two meshes share them
	});
	test('disposed after idle with nobody holding it, kept while a preview holds it', () => {
		const lease = seam.acquireOffscreen();
		const r = lease.renderer;
		vi.advanceTimersByTime(seam.OFFSCREEN_IDLE_MS * 2);
		expect(r.disposed).toBe(false);
		lease.release();
		lease.release(); // twice is once
		expect(seam.offscreenState().holders).toBe(0);
		vi.advanceTimersByTime(seam.OFFSCREEN_IDLE_MS + 1);
		expect(r.disposed).toBe(true);
		expect(seam.offscreenState().alive).toBe(false);
	});
	test('blit: viewport = round(size x ratio), picture = floor(size x ratio), the buffer only grows', () => {
		const lease = seam.acquireOffscreen();
		const ctx = { drawImage: vi.fn(), globalCompositeOperation: '' };
		const target = /** @type {any} */ ({ width: 0, height: 0, getContext: () => ctx });
		const draw = vi.fn();
		seam.blitOffscreen(lease, target, 201, 101, 1.5, draw);
		const r = lease.renderer;
		expect(draw).toHaveBeenCalledWith(r);
		expect(r.calls.find((/** @type {any} */ c) => c[0] === 'viewport')).toEqual(['viewport', 0, 0, 302, 152]);
		expect([target.width, target.height]).toEqual([301, 151]);
		expect(ctx.drawImage).toHaveBeenCalledWith(r.domElement, 0, r.domElement.height - 151, 301, 151, 0, 0, 301, 151);
		const sizes = r.calls.filter((/** @type {any} */ c) => c[0] === 'size').length;
		seam.blitOffscreen(lease, target, 100, 50, 1, draw);
		expect(r.calls.filter((/** @type {any} */ c) => c[0] === 'size').length).toBe(sizes); // smaller: no resize
		expect(r.calls.filter((/** @type {any} */ c) => c[0] === 'ratio').length).toBe(0); // ratio 1 never re-set
		lease.release();
	});
	test('a preview survives disposeRenderer(): its next frame gets a new renderer', () => {
		const lease = seam.acquireOffscreen();
		const first = lease.renderer;
		seam.disposeRenderer();
		expect(first.disposed).toBe(true);
		expect(lease.renderer).not.toBe(first);
		expect(FakeRenderer.made).toBe(2);
		lease.release();
	});
});

describe('the main renderer + disposeRenderer (101 F3)', () => {
	test('createMainRenderer = threlte 8.6.1 defaults on the given canvas', () => {
		const canvas = /** @type {any} */ ({});
		const r = /** @type {any} */ (seam.createMainRenderer(canvas));
		expect(r.opts).toEqual({ canvas, powerPreference: 'high-performance', antialias: true, alpha: true });
		expect(seam.mainRenderer()).toBe(r);
	});
	test('disposeRenderer releases targets + the thumbnail renderer; {main: true} also the main one', () => {
		const main = /** @type {any} */ (seam.createMainRenderer(/** @type {any} */ ({})));
		seam.createRenderTarget(2, 2);
		seam.createRenderTarget(2, 2);
		const thumb = seam.renderOffscreen(8, 8, (/** @type {any} */ r) => r);
		const out = seam.disposeRenderer();
		expect(out).toEqual({ targets: 2, offscreen: true, main: false });
		expect(thumb.disposed).toBe(true);
		expect(main.renderLists.dispose).toHaveBeenCalled();
		expect(main.disposed).toBe(false);
		expect(seam.disposeRenderer({ main: true }).main).toBe(true);
		expect(main.disposed).toBe(true);
		expect(seam.mainRenderer()).toBe(null);
		expect(seam.seamState()).toMatchObject({ main: false, targets: 0, offscreen: { alive: false } });
	});
	test('the hooks write what they are given', () => {
		const r = /** @type {any} */ ({});
		seam.setToneMapping(r, 3);
		seam.setExposure(r, 1.25);
		expect([r.toneMapping, r.toneMappingExposure]).toEqual([3, 1.25]);
	});
});
