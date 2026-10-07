// @ts-nocheck — plain fixtures; the module under test is typed
// 37-hdri — the payload field is read through hdriOf only (a malformed value reads as absent),
// edits merge compactly, the Quest tier is picked from local facts, and the downsample keeps
// the energy of the image (box filter = the mean is preserved).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
	hdriOf,
	mergeHdriPatch,
	resolveHdriTier,
	isHeadsetUA,
	downsampleRGBA,
	rotateAboutY,
	validSrc,
	isHdriFileName
} from '../../src/lib/hdri/hdriCore.js';
import { BUNDLED_HDRIS, bundledHdri } from '../../src/lib/hdri/catalog.js';
// environment.js reaches geometries.svelte.js (runes) — read its preset table as source text,
// the way scripts/scene-lint.cjs does
const ENV_SRC = fs.readFileSync('src/lib/environment.js', 'utf8');
const PRESET_BODY = ENV_SRC.slice(ENV_SRC.indexOf('export const ENVIRONMENT_PRESETS'), ENV_SRC.indexOf('\n};', ENV_SRC.indexOf('export const ENVIRONMENT_PRESETS')));
/** the preset block of `key` (up to the next top-level key) @param {string} key */
function presetBlock(key) {
	const start = PRESET_BODY.indexOf('\n\t' + key + ': {');
	if (start < 0) return '';
	const next = PRESET_BODY.slice(start + 1).search(/\n\t[a-z]+: \{/);
	return next < 0 ? PRESET_BODY.slice(start) : PRESET_BODY.slice(start, start + 1 + next);
}

describe('hdriOf', () => {
	it('reads absent / malformed as null', () => {
		expect(hdriOf(null)).toBe(null);
		expect(hdriOf({})).toBe(null);
		expect(hdriOf({ hdri: 'meadow' })).toBe(null);
		expect(hdriOf({ hdri: { src: 'http://evil.example/x.hdr' } })).toBe(null);
		expect(hdriOf({ hdri: { src: 'bundled:Meadow!' } })).toBe(null);
		expect(hdriOf({ hdri: { src: 'hash:xyz' } })).toBe(null);
	});
	it('fills defaults and clamps', () => {
		expect(hdriOf({ hdri: { src: 'bundled:meadow' } })).toEqual({
			src: 'bundled:meadow',
			name: '',
			rotation: 0,
			intensity: 1,
			background: true,
			blur: 0,
			toneMapping: 'aces'
		});
		const h = hdriOf({ hdri: { src: 'bundled:meadow', rotation: -90, intensity: 99, blur: -1, background: false, toneMapping: 'weird' } });
		expect(h.rotation).toBe(270);
		expect(h.intensity).toBe(4);
		expect(h.blur).toBe(0);
		expect(h.background).toBe(false);
		expect(h.toneMapping).toBe('aces');
	});
	it('accepts a content hash', () => {
		const hash = 'a'.repeat(64);
		expect(validSrc('hash:' + hash)).toBe(true);
		expect(hdriOf({ hdri: { src: 'hash:' + hash, name: 'x.hdr' } }).name).toBe('x.hdr');
	});
});

describe('mergeHdriPatch', () => {
	it('null removes, a patch merges and stays compact', () => {
		expect(mergeHdriPatch({ src: 'bundled:meadow' }, null)).toBe(null);
		expect(mergeHdriPatch({ src: 'bundled:meadow' }, { rotation: 45 })).toEqual({ src: 'bundled:meadow', rotation: 45 });
		// defaults never travel
		expect(mergeHdriPatch({ src: 'bundled:meadow', rotation: 45 }, { rotation: 0, intensity: 1 })).toEqual({ src: 'bundled:meadow' });
	});
	it('a new source keeps the knobs and drops a stale file name', () => {
		const next = mergeHdriPatch({ src: 'hash:' + 'b'.repeat(64), name: 'old.hdr', rotation: 90 }, { src: 'bundled:sunrise' });
		expect(next).toEqual({ src: 'bundled:sunrise', rotation: 90 });
	});
	it('an invalid source yields null (the payload drops the field)', () => {
		expect(mergeHdriPatch(undefined, { rotation: 10 })).toBe(null);
		expect(mergeHdriPatch(undefined, { src: 'nope' })).toBe(null);
	});
});

describe('tier', () => {
	it('headset, XR, the governor and the pin', () => {
		expect(resolveHdriTier({})).toBe('full');
		expect(resolveHdriTier({ presenting: true })).toBe('low');
		expect(resolveHdriTier({ headset: true })).toBe('low');
		expect(resolveHdriTier({ postOff: true })).toBe('low');
		expect(resolveHdriTier({ headset: true, pref: 'full' })).toBe('full');
		expect(resolveHdriTier({ pref: 'low' })).toBe('low');
	});
	it('knows a Quest browser', () => {
		expect(isHeadsetUA('Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/35.0 Chrome/128 VR Safari/537.36')).toBe(true);
		expect(isHeadsetUA('Mozilla/5.0 (X11; Linux x86_64) Chrome/128 Safari/537.36')).toBe(false);
	});
});

describe('downsampleRGBA', () => {
	it('is a box filter: halves until it fits, preserves the mean', () => {
		const w = 8;
		const h = 4;
		const data = new Float32Array(w * h * 4);
		let sum = 0;
		for (let i = 0; i < data.length; i++) {
			data[i] = (i * 7) % 13;
			if (i % 4 === 0) sum += data[i];
		}
		const out = downsampleRGBA(data, w, h, 2);
		expect(out.width).toBe(2);
		expect(out.height).toBe(1);
		let outSum = 0;
		for (let i = 0; i < out.data.length; i += 4) outSum += out.data[i];
		expect(outSum / (out.width * out.height)).toBeCloseTo(sum / (w * h), 5);
	});
	it('returns the input when it fits', () => {
		const data = new Float32Array(16);
		expect(downsampleRGBA(data, 2, 2, 4).data).toBe(data);
	});
});

describe('rotateAboutY', () => {
	it('turns +X towards -Z by +90 degrees (three right-handed, y up)', () => {
		const p = rotateAboutY([1, 2, 0], 90);
		expect(p[0]).toBeCloseTo(0, 6);
		expect(p[1]).toBe(2);
		expect(p[2]).toBeCloseTo(-1, 6);
		expect(rotateAboutY([1, 2, 3], 0)).toEqual([1, 2, 3]);
	});
});

describe('the bundled catalog', () => {
	it('every row has its file and card in static/, and a preset of the same key', () => {
		for (const [key, row] of Object.entries(BUNDLED_HDRIS)) {
			expect(fs.existsSync(path.join('static', row.file)), row.file).toBe(true);
			expect(fs.existsSync(path.join('static', row.card)), row.card).toBe(true);
			// ≤ 1k (the brief): a 1024x512 RGBE file is ~1.5 MB
			expect(fs.statSync(path.join('static', row.file)).size).toBeLessThan(2.5 * 1024 * 1024);
			const block = presetBlock(key);
			expect(block, key).toContain("hdri: { src: 'bundled:" + key + "'");
			expect(bundledHdri('bundled:' + key)).toBe(row);
			// the scene lint's preset-key regex (`^\t([a-z]+): \{`) must see it
			expect(key).toMatch(/^[a-z]+$/);
		}
	});
	it('file names are HDRIs', () => {
		expect(isHdriFileName('a.HDR')).toBe(true);
		expect(isHdriFileName('a.exr')).toBe(true);
		expect(isHdriFileName('a.png')).toBe(false);
	});
});
