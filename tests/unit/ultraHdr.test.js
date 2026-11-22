// @ts-nocheck — plain fixtures; the module under test is typed
// 72 LK2 — the UltraHDR reader against files the encoder writes, the recovery maths against the
// source numbers, and what the sky's quality resolves to on each kind of device.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { parseUltraHdr, recoverChannel } from '../../src/lib/hdri/ultraHdrCore.js';
import { hdriOf, mergeHdriPatch, resolveSkyQuality, skyFileTier } from '../../src/lib/hdri/hdriCore.js';
import { BUNDLED_HDRIS, skyTiers, skyTierFile } from '../../src/lib/hdri/catalog.js';
import { CORE_SETTINGS } from '../../src/lib/gameSettings.js';

const require = createRequire(import.meta.url);
const { assemble } = require('../../scripts/hdri-uhdr.cjs');

const jpegStub = (fill, n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xda]), Buffer.alloc(n, fill), Buffer.from([0xff, 0xd9])]);
const META = { min: -1.5, max: 12.25, gamma: 0.5 };
const toArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);

describe('parseUltraHdr', () => {
	it('finds both pictures and the numbers in what the encoder writes', () => {
		const file = assemble(jpegStub(0x11, 500), jpegStub(0x22, 300), META);
		const got = parseUltraHdr(toArrayBuffer(file));
		expect(got).not.toBeNull();
		expect(got.primary[0]).toBe(0xff);
		expect(got.primary[1]).toBe(0xd8);
		expect(got.gain[0]).toBe(0xff);
		expect(got.gain[1]).toBe(0xd8);
		expect(got.primary.length + got.gain.length).toBe(file.length);
		expect(got.gain[got.gain.length - 2]).toBe(0xff);
		expect(got.gain[got.gain.length - 1]).toBe(0xd9);
		expect(got.meta).toMatchObject({ gainMapMin: -1.5, gainMapMax: 12.25, gamma: 0.5, offsetSDR: 1 / 64, offsetHDR: 1 / 64 });
	});

	it('refuses anything else, so the caller falls back', () => {
		expect(parseUltraHdr(new ArrayBuffer(0))).toBeNull();
		expect(parseUltraHdr(new TextEncoder().encode('#?RADIANCE\n').buffer)).toBeNull();
		expect(parseUltraHdr(toArrayBuffer(jpegStub(0x11, 64)))).toBeNull(); // a plain JPEG
		const file = assemble(jpegStub(0x11, 500), jpegStub(0x22, 300), META);
		expect(parseUltraHdr(toArrayBuffer(file.subarray(0, file.length - 40)))).toBeNull(); // truncated
	});

	it('recovers the source value', () => {
		const m = { gainMapMin: 0, gainMapMax: 10, gamma: 0.5, offsetSDR: 1 / 64, offsetHDR: 1 / 64 };
		// stored gain g means log2 gain = 10 * g^2: g = 0.5 -> 2.5 stops
		const want = (0.2 + 1 / 64) * 2 ** 2.5 - 1 / 64;
		expect(recoverChannel(0.2, 0.5, m)).toBeCloseTo(want, 6);
		expect(recoverChannel(0, 0, m)).toBeCloseTo(0, 6);
	});
});

describe('hdri payload', () => {
	it('quality reads through hdriOf, travels only when set', () => {
		expect(hdriOf({ hdri: { src: 'bundled:meadow' } })).toMatchObject({ quality: 'auto', minQuality: 'standard' });
		expect(hdriOf({ hdri: { src: 'bundled:meadow', quality: 'ultra', minQuality: 7 } })).toMatchObject({ quality: 'auto', minQuality: 'standard' });
		expect(mergeHdriPatch({ src: 'bundled:meadow' }, { quality: 'auto' })).toEqual({ src: 'bundled:meadow' });
		expect(mergeHdriPatch({ src: 'bundled:meadow' }, { quality: 'max', minQuality: 'high' })).toEqual({ src: 'bundled:meadow', quality: 'max', minQuality: 'high' });
	});
});

describe('resolveSkyQuality', () => {
	const desk = {};
	it('Auto: High on a desktop, Standard where memory or data is short, never Max', () => {
		expect(resolveSkyQuality(desk)).toBe('high');
		for (const k of ['headset', 'presenting', 'phone', 'postOff', 'slowNet']) expect(resolveSkyQuality({ [k]: true })).toBe('standard');
	});
	it('a player overrides Auto, this game first; a scene that names one keeps it', () => {
		expect(resolveSkyQuality({ gamePref: 'max' })).toBe('max');
		expect(resolveSkyQuality({ gamePref: 'standard', devicePref: 'max' })).toBe('standard');
		expect(resolveSkyQuality({ gamePref: 'auto', devicePref: 'max' })).toBe('max');
		expect(resolveSkyQuality({ phone: true, gamePref: 'high' })).toBe('high');
		expect(resolveSkyQuality({ scene: 'standard', gamePref: 'max' })).toBe('standard');
		expect(resolveSkyQuality({ scene: 'max', phone: true })).toBe('max');
	});
	it('the minimum raises Auto and a player, not a device pinned Low, and a headset stays at High', () => {
		expect(resolveSkyQuality({ phone: true, minimum: 'high' })).toBe('high');
		expect(resolveSkyQuality({ gamePref: 'standard', minimum: 'max' })).toBe('max');
		expect(resolveSkyQuality({ devicePref: 'low', scene: 'max', minimum: 'max' })).toBe('standard');
		expect(resolveSkyQuality({ presenting: true, scene: 'max' })).toBe('high');
		expect(resolveSkyQuality({ headset: true, minimum: 'max' })).toBe('high');
	});
});

describe('skyFileTier', () => {
	const all = ['1k', '2k', '4k', '8k'];
	const three = ['1k', '2k', '4k'];
	it('maps the names, and 8K only where it exists and the machine can take it', () => {
		expect(skyFileTier('standard', all)).toBe('1k');
		expect(skyFileTier('high', all)).toBe('2k');
		expect(skyFileTier('max', all)).toBe('4k');
		expect(skyFileTier('max', all, { memoryGB: 8 })).toBe('8k');
		expect(skyFileTier('max', three, { memoryGB: 8 })).toBe('4k');
		expect(skyFileTier('max', all, { memoryGB: 8, phone: true })).toBe('4k');
	});
	it('steps down to what the GPU holds', () => {
		expect(skyFileTier('max', all, { memoryGB: 8, maxTexture: 4096 })).toBe('4k');
		expect(skyFileTier('max', all, { maxTexture: 2048 })).toBe('2k');
		expect(skyFileTier('max', all, { maxCube: 512 })).toBe('2k');
		expect(skyFileTier('high', all, { maxTexture: 1024 })).toBe('1k');
	});
});

describe('catalog + options', () => {
	it('every sky offers 1K to 4K as .jpg beside its .hdr; one showcase has 8K', () => {
		for (const row of Object.values(BUNDLED_HDRIS)) {
			expect(skyTiers(row)).toEqual(expect.arrayContaining(['1k', '2k', '4k']));
			expect(skyTierFile(row, '4k')).toBe(row.file.replace('_1k.hdr', '_4k.jpg'));
		}
		expect(Object.values(BUNDLED_HDRIS).filter((r) => skyTiers(r).includes('8k')).map((r) => r.label)).toEqual(['Meadow']);
	});
	it("the game's options have the row", () => {
		const row = CORE_SETTINGS.find((r) => r.id === 'skyQuality');
		expect(row?.options).toEqual(['auto', 'standard', 'high', 'max']);
		expect(row?.default).toBe('auto');
	});
});
