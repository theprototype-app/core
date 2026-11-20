// 100 C1 — the Cinematic view's pure rules: where it is offered, the quality steps and their caps, the
// dynamic step down, what the stand-in chip names, and the shared-geometry disposal hold.
import { describe, it, expect } from 'vitest';
import {
	offerVerdict,
	asQuality,
	qualityChoices,
	effectiveQuality,
	createDropWatch,
	classifyMaterial,
	notShownText,
	HIGH_MAX_PIXELS,
	FRAME_BUDGET_MS
} from '../../src/lib/cinematic/cinematicCore.js';
import { setViewOwner, disposeSharedGeometry, flushHeldDisposals, frameCanvas, frameCount, viewOwnsFrame } from '../../src/lib/render/view.js';

const strong = { desktop: true, gpu: true, chromium: true, adapter: true };

describe('offerVerdict', () => {
	it('offers on a desktop Chromium with a hardware adapter', () => {
		expect(offerVerdict(strong)).toEqual({ offered: true, why: '' });
	});
	it('never offers on a phone, a headset, in XR, without WebGPU, off Chromium, on a software adapter', () => {
		expect(offerVerdict({ ...strong, desktop: false }).offered).toBe(false);
		expect(offerVerdict({ ...strong, quest: true }).offered).toBe(false);
		expect(offerVerdict({ ...strong, xr: true }).offered).toBe(false);
		expect(offerVerdict({ ...strong, gpu: false }).offered).toBe(false);
		expect(offerVerdict({ ...strong, chromium: false }).offered).toBe(false);
		expect(offerVerdict({ ...strong, adapter: false }).offered).toBe(false);
		expect(offerVerdict({ ...strong, fallbackAdapter: true }).offered).toBe(false);
	});
	it('a session disabled by a failure says why', () => {
		expect(offerVerdict({ ...strong, disabled: 'its lighting does not compile on this graphics path.' })).toEqual({ offered: false, why: 'its lighting does not compile on this graphics path.' });
	});
});

describe('quality', () => {
	it('reads unknown stored values as Standard', () => {
		expect(asQuality('ultra')).toBe('standard');
		expect(asQuality('high')).toBe('high');
	});
	it('hides High above 1440p-equivalent pixel counts', () => {
		expect(qualityChoices(HIGH_MAX_PIXELS)).toEqual(['basic', 'standard', 'high']);
		expect(qualityChoices(3840 * 2160)).toEqual(['basic', 'standard']);
		expect(effectiveQuality('high', 3840 * 2160)).toBe('standard');
		expect(effectiveQuality('high', 1920 * 1080)).toBe('high');
	});
	it('the drop lowers one step per drop and stops at Basic', () => {
		expect(effectiveQuality('high', 1920 * 1080, 1)).toBe('standard');
		expect(effectiveQuality('standard', 1920 * 1080, 1)).toBe('basic');
		expect(effectiveQuality('standard', 1920 * 1080, 5)).toBe('basic');
	});
});

describe('createDropWatch', () => {
	/** feed `ms` frames for `seconds` @param {any} w @param {number} ms @param {number} seconds @param {number} t0 */
	const run = (w, ms, seconds, t0 = 0) => {
		let t = t0;
		let dropped = 0;
		while (t < t0 + seconds * 1000) {
			t += ms;
			if (w.feed(ms, t)) dropped++;
		}
		return { dropped, t };
	};
	it('never drops at 60 fps', () => {
		expect(run(createDropWatch(), 16.7, 10).dropped).toBe(0);
	});
	it('drops once after the p95 stays over budget for 2 s, then waits another 2 s', () => {
		const w = createDropWatch();
		const slow = FRAME_BUDGET_MS + 10;
		// 1 s window to fill + 2 s over budget
		expect(run(w, slow, 2.5).dropped).toBe(0);
		const a = run(w, slow, 1.2, 2500);
		expect(a.dropped).toBe(1);
		// right after a drop the window starts over: no second drop within the next 2 s
		expect(run(w, slow, 2, a.t).dropped).toBe(0);
	});
	it('a short spike is not a drop (the p95 trails a 1 s window, so it stays over ~1 s past the spike)', () => {
		const w = createDropWatch();
		const a = run(w, 16.7, 2);
		const b = run(w, 60, 0.5, a.t);
		expect(b.dropped).toBe(0);
		expect(run(w, 16.7, 4, b.t).dropped).toBe(0);
	});
});

describe('classifyMaterial / notShownText', () => {
	const shader = { isShaderMaterial: true, uniforms: {} };
	it('a node material or a plain standard material is drawn as is', () => {
		expect(classifyMaterial({}, { isNodeMaterial: true })).toEqual({ swap: false, kind: null });
		expect(classifyMaterial({}, { isMeshStandardMaterial: true })).toEqual({ swap: false, kind: null });
	});
	it('GLSL materials get a stand-in, named by what they belong to', () => {
		expect(classifyMaterial({ name: 'water-surface' }, shader)).toEqual({ swap: true, kind: 'water' });
		expect(classifyMaterial({ name: 'x', parent: { userData: { particles: {} } } }, shader)).toEqual({ swap: true, kind: 'particles' });
		expect(classifyMaterial({ name: 'other' }, shader)).toEqual({ swap: true, kind: 'custom' });
	});
	it('a patched base material is drawn as its base; shader graphs, terrain and jiggle are named, the rest is quiet', () => {
		const patched = { isMeshStandardMaterial: true, onBeforeCompile() {} };
		expect(classifyMaterial({}, { ...patched, userData: { shaderUniforms: {} } })).toEqual({ swap: false, kind: 'shader' });
		expect(classifyMaterial({ userData: { terrainSplat: {} } }, patched)).toEqual({ swap: false, kind: 'terrain' });
		expect(classifyMaterial({}, patched, { deformed: () => true })).toEqual({ swap: false, kind: 'deform' });
		expect(classifyMaterial({}, { ...patched, userData: { avatarUniforms: {} } })).toEqual({ swap: false, kind: null });
	});
	it('troika text is named even on its derived base material', () => {
		expect(classifyMaterial({ isTroikaText: true }, { isMeshBasicMaterial: true })).toEqual({ swap: false, kind: 'text' });
	});
	it('the chip line lists each kind once, in a fixed order', () => {
		expect(notShownText([])).toBe('');
		expect(notShownText(['text', 'water', 'text'])).toBe('Not shown in Cinematic view: Water, 3D text');
	});
});

describe('render/view.js', () => {
	it('hands the frame to the view and back', () => {
		const gl = { domElement: { id: 'gl' }, info: { render: { frame: 7 } } };
		const canvas = /** @type {any} */ ({ id: 'gpu' });
		expect(viewOwnsFrame()).toBe(false);
		expect(frameCanvas(gl)).toBe(gl.domElement);
		expect(frameCount(gl)).toBe(7);
		setViewOwner({ draw: () => {}, canvas });
		expect(viewOwnsFrame()).toBe(true);
		expect(frameCanvas(gl)).toBe(canvas);
		expect(frameCount(gl)).not.toBe(7);
		setViewOwner(null);
		expect(frameCanvas(gl)).toBe(gl.domElement);
	});
	it('holds an interleaved geometry disposal while the view draws (W1), and runs it after', () => {
		let disposed = 0;
		const geo = { attributes: { position: { isInterleavedBufferAttribute: true } }, dispose: () => disposed++ };
		const plain = { attributes: { position: {} }, dispose: () => disposed++ };
		setViewOwner({ draw: () => {}, canvas: /** @type {any} */ ({}) });
		disposeSharedGeometry(geo);
		disposeSharedGeometry(plain);
		expect(disposed).toBe(1);
		setViewOwner(null);
		expect(flushHeldDisposals()).toBe(1);
		expect(disposed).toBe(2);
	});
});
