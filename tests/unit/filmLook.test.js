// @ts-nocheck — plain fixture objects
// 77 L1: the film-look leaves — lens normalising, the focus pull, the letterbox matte, and the
// look properties in 68's registry shape (camera lens fields + live look overrides).
import { describe, it, expect, beforeEach } from 'vitest';
import { dofFromLens, lensOf, easeFocus, matteBars, framingAspect, LETTERBOX_PRESETS } from '../../src/lib/filmLookCore.js';
import {
	LOOK_PROPS,
	LIVE_LOOK,
	lookPath,
	registerLookProps,
	setLookResolver,
	liveLookValue,
	liveLookActive,
	clearLiveLook
} from '../../src/lib/lookProps.js';

const camera = (fields = {}) => ({ uuid: 'cam-1', userData: { camera: { kind: 'perspective', fov: 50, ...fields } } });

describe('lensOf', () => {
	it('keeps NaN for a lens the camera does not carry (68 source: camera falls back)', () => {
		const lens = lensOf({ fov: 40 });
		expect(Number.isNaN(lens.focus)).toBe(true);
		expect(Number.isNaN(lens.aperture)).toBe(true);
		expect(lens.focusTarget).toBe('');
		expect(lens.focusPoint).toBe(null);
		expect(lens.focusPull).toBe(0);
	});
	it('reads focus / aperture / target / point / pull and clamps the pull', () => {
		const lens = lensOf({ focus: 3, aperture: '1.4', focusTarget: 'obj', focusPoint: [0, 1, 2, 9], focusPull: 99 });
		expect(lens).toEqual({ focus: 3, aperture: 1.4, focusTarget: 'obj', focusPoint: [0, 1, 2], focusPull: 10 });
	});
	it('ignores a malformed point and an empty string focus', () => {
		const lens = lensOf({ focus: '', focusPoint: [0, 'x', 1] });
		expect(Number.isNaN(lens.focus)).toBe(true);
		expect(lens.focusPoint).toBe(null);
	});
});

describe('dofFromLens', () => {
	it('is 68 V8 maths: a wider aperture = more bokeh and a thinner sharp zone', () => {
		const wide = dofFromLens(5, 1.4);
		const narrow = dofFromLens(5, 16);
		expect(wide.focusDistance).toBe(5);
		expect(wide.bokehScale).toBeGreaterThan(narrow.bokehScale);
		expect(wide.focusRange).toBeLessThan(narrow.focusRange);
		expect(dofFromLens(5, 2.8).bokehScale).toBeCloseTo(4, 6);
	});
});

describe('easeFocus (the focus pull)', () => {
	it('a cut (pull 0) and a first frame snap', () => {
		expect(easeFocus(2, 8, 1 / 60, 0)).toBe(8);
		expect(easeFocus(NaN, 8, 1 / 60, 2)).toBe(8);
	});
	it('lands within 1% (in diopters) after `pull` seconds, whatever the frame rate', () => {
		for (const fps of [24, 60, 144]) {
			let f = 1;
			for (let i = 0; i < 2 * fps; i++) f = easeFocus(f, 10, 1 / fps, 2);
			const err = Math.abs(1 / f - 1 / 10) / Math.abs(1 / 1 - 1 / 10);
			expect(err).toBeLessThan(0.0101);
		}
	});
	it('moves monotonically and never overshoots', () => {
		let f = 10;
		let prev = f;
		for (let i = 0; i < 300; i++) {
			f = easeFocus(f, 1, 1 / 60, 1.5);
			expect(f).toBeLessThanOrEqual(prev + 1e-12);
			expect(f).toBeGreaterThanOrEqual(1);
			prev = f;
		}
		expect(f).toBe(1); // settled exactly
	});
	it('half a pull covers most of the way in diopters, not in metres', () => {
		let f = 2;
		for (let i = 0; i < 30; i++) f = easeFocus(f, 1000, 1 / 60, 1);
		// diopters 0.5 -> 0.001: at t = pull/2 we are ~90% of the way, i.e. past 10 m already
		expect(f).toBeGreaterThan(10);
	});
});

describe('matteBars', () => {
	it('a 2.39 matte on a 16:9 camera in a 16:9 canvas = top and bottom bars', () => {
		const bars = matteBars(16 / 9, 16 / 9, 2.39);
		expect(bars.x).toBe(0);
		expect(bars.y).toBeCloseTo((1 - 16 / 9 / 2.39) / 2, 9);
	});
	it('a 4:3 matte on a 16:9 camera = pillar bars', () => {
		const bars = matteBars(16 / 9, 16 / 9, 4 / 3);
		expect(bars.y).toBe(0);
		expect(bars.x).toBeCloseTo(0.125, 9);
	});
	it('is cut from the camera FRAMING when the canvas has another shape (1280x800 vs 16:9)', () => {
		const bars = matteBars(1.6, 16 / 9, 2.39);
		// the 16:9 frame is 90% of the canvas height; the matte keeps 16:9 / 2.39 of that
		expect(bars.y).toBeCloseTo((1 - 0.9 * (16 / 9 / 2.39)) / 2, 9);
		expect(bars.x).toBe(0);
		// a free camera follows the canvas
		expect(matteBars(1.6, 0, 2.39).y).toBeCloseTo((1 - 1.6 / 2.39) / 2, 9);
	});
	it('a matte equal to the framing leaves only the frame edges', () => {
		expect(matteBars(16 / 9, 16 / 9, 16 / 9)).toEqual({ x: 0, y: 0 });
		const pillarbox = matteBars(2, 16 / 9, 16 / 9);
		expect(pillarbox.y).toBe(0);
		expect(pillarbox.x).toBeCloseTo((1 - 16 / 9 / 2) / 2, 9);
	});
	it('off / garbage = no bars', () => {
		expect(matteBars(16 / 9, 16 / 9, 0)).toEqual({ x: 0, y: 0 });
		expect(matteBars(NaN, 0, 2)).toEqual({ x: 0, y: 0 });
	});
	it('framing presets match cameraObjects.aspectRatio; Off comes first', () => {
		expect(framingAspect('16:9')).toBeCloseTo(16 / 9, 12);
		expect(framingAspect('2.39:1')).toBe(2.39);
		expect(framingAspect('free')).toBe(0);
		expect(LETTERBOX_PRESETS[0].value).toBe(0);
	});
});

describe('LOOK_PROPS (68 registry shape)', () => {
	beforeEach(() => clearLiveLook());

	it('every def has the PropDef members', () => {
		for (const [path, def] of Object.entries(LOOK_PROPS)) {
			expect(def.type, path).toBe('number');
			expect(typeof def.label, path).toBe('string');
			for (const fn of ['get', 'set', 'applies']) expect(typeof def[fn], path + '.' + fn).toBe('function');
			expect(def.min, path).toBeLessThan(def.max);
		}
		expect(Object.keys(LOOK_PROPS)).toContain('look.letterbox.aspect');
		expect(Object.keys(LOOK_PROPS)).toContain('look.vignette.darkness');
	});

	it('camera lens paths read the default, write clamped onto userData.camera', () => {
		const cam = camera();
		const focus = LOOK_PROPS['camera.focus'];
		expect(focus.applies(cam)).toBe(true);
		expect(focus.applies({ userData: {} })).toBe(false);
		expect(focus.get(cam)).toBe(10);
		focus.set(cam, 0.001);
		expect(cam.userData.camera.focus).toBe(0.05);
		LOOK_PROPS['camera.aperture'].set(cam, 2);
		expect(cam.userData.camera.aperture).toBe(2);
		LOOK_PROPS['camera.focusPull'].set(cam, 30);
		expect(cam.userData.camera.focusPull).toBe(10);
	});

	it('a look path applies only when the camera look has that effect; posing is a LOCAL override', () => {
		const authoredLook = { 'cam-1': { vignette: { darkness: 0.5, offset: 0.4 } } };
		const stop = setLookResolver((uuid, kind, param) => authoredLook[uuid]?.[kind]?.[param] ?? null);
		const cam = camera();
		const dark = LOOK_PROPS[lookPath('vignette', 'darkness')];
		expect(dark.applies(cam)).toBe(true);
		expect(LOOK_PROPS[lookPath('bloom', 'intensity')].applies(cam)).toBe(false);
		// base capture (what 68's propPlayback does on its first write) = the authored value
		const base = dark.get(cam);
		expect(base).toBe(0.5);
		dark.set(cam, 0.9);
		expect(liveLookValue('cam-1', 'vignette', 'darkness')).toBe(0.9);
		expect(dark.get(cam)).toBe(0.9);
		expect(cam.userData.camera.look).toBeUndefined(); // nothing on the object to save
		dark.set(cam, 7); // clamped
		expect(liveLookValue('cam-1', 'vignette', 'darkness')).toBe(1);
		// release = write the base back -> the override disappears
		dark.set(cam, base);
		expect(liveLookValue('cam-1', 'vignette', 'darkness')).toBeUndefined();
		expect(liveLookActive()).toBe(false);
		stop();
		expect(dark.applies(cam)).toBe(false); // no resolver = nothing authored to drive
	});

	it('an authored edit after a release shows through (no stale override)', () => {
		const authoredLook = { 'cam-1': { letterbox: { aspect: 2.39, opacity: 1 } } };
		const stop = setLookResolver((uuid, kind, param) => authoredLook[uuid]?.[kind]?.[param] ?? null);
		const cam = camera();
		const aspect = LOOK_PROPS[lookPath('letterbox', 'aspect')];
		aspect.set(cam, 1.85);
		aspect.set(cam, 2.39);
		authoredLook['cam-1'].letterbox.aspect = 2;
		expect(aspect.get(cam)).toBe(2);
		stop();
	});

	it('registerLookProps merges into a registry and reports the new paths', () => {
		const registry = { position: {}, 'camera.focus': { stale: true } };
		const added = registerLookProps(registry);
		expect(added).not.toContain('camera.focus');
		expect(added).toContain('camera.focusPull');
		expect(registry['camera.focus']).toBe(LOOK_PROPS['camera.focus']);
		expect(Object.keys(registry).length).toBe(1 + Object.keys(LOOK_PROPS).length);
		expect(Object.keys(LIVE_LOOK).length).toBeGreaterThan(5);
	});
});
