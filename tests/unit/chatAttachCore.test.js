// 56 C8 — pictures in the chat, the pure half: a phone photo's GPS never leaves the device
// (COUNTERFACTUAL: the committed fixture carries a real EXIF/GPS block, and the strip removes it while
// the image data survives byte-for-byte), plus the type sniff and the downscale/encode plan.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripMetadata, metadataOf, sniffType, fitSize, encodePlan, toBase64, fromBase64, attachName, MAX_EDGE, QUALITIES } from '../../src/lib/chat/attachCore.js';
import { gpsApp1, spliceApp1 } from '../fixtures/exif/exifBuilder.js';

const fixture = (/** @type {string} */ name) => new Uint8Array(readFileSync(fileURLToPath(new URL('../fixtures/exif/' + name, import.meta.url))));

/** index of the JPEG start-of-scan marker @param {Uint8Array} b */
const sos = (b) => {
	for (let i = 2; i + 1 < b.length; i++) if (b[i] === 0xff && b[i + 1] === 0xda) return i;
	return -1;
};

describe('EXIF / GPS strip (JPEG)', () => {
	const photo = fixture('gps-photo.jpg');
	it('the fixture really is a GPS-tagged phone photo (counterfactual)', () => {
		expect(sniffType(photo)).toBe('image/jpeg');
		expect(metadataOf(photo)).toMatchObject({ exif: true, gps: true });
		// the latitude's degree value (52) is in the file as a RATIONAL numerator
		expect(Buffer.from(photo).includes(Buffer.from([52, 0, 0, 0, 1, 0, 0, 0]))).toBe(true);
	});
	it('strips EXIF and GPS, keeps the image data byte-for-byte', () => {
		const clean = stripMetadata(photo);
		expect(metadataOf(clean)).toEqual({ exif: false, gps: false, xmp: false, text: false });
		expect(Buffer.from(clean).includes(Buffer.from('Exif'))).toBe(false);
		expect(Buffer.from(clean).includes(Buffer.from('OPPO'))).toBe(false);
		expect(Buffer.from(clean.subarray(sos(clean))).equals(Buffer.from(photo.subarray(sos(photo))))).toBe(true);
		expect(clean[0]).toBe(0xff);
		expect(clean[1]).toBe(0xd8);
	});
	it('the large fixture too (what the e2e attaches)', () => {
		const big = fixture('gps-photo-large.jpg');
		expect(metadataOf(big).gps).toBe(true);
		expect(metadataOf(stripMetadata(big)).gps).toBe(false);
	});
	it('drops COM and XMP, keeps APP0 and an ICC profile', () => {
		const base = stripMetadata(photo);
		const seg = (/** @type {number} */ m, /** @type {string} */ text) => {
			const body = [...Buffer.from(text)];
			const len = body.length + 2;
			return Uint8Array.from([0xff, m, len >> 8, len & 255, ...body]);
		};
		let b = spliceApp1(base, seg(0xfe, 'shot at home'));
		b = spliceApp1(b, seg(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>'));
		b = spliceApp1(b, seg(0xe2, 'ICC_PROFILE\0\x01\x01profile'));
		expect(metadataOf(b)).toMatchObject({ xmp: true, text: true });
		const clean = stripMetadata(b);
		expect(metadataOf(clean)).toMatchObject({ xmp: false, text: false });
		expect(Buffer.from(clean).includes(Buffer.from('ICC_PROFILE'))).toBe(true);
	});
	it('a second GPS block anywhere before the scan is found and removed', () => {
		const twice = spliceApp1(photo, gpsApp1(-33.86, 151.21));
		expect(metadataOf(stripMetadata(twice)).gps).toBe(false);
	});
});

/** @param {string} type @param {number[]} data */
function pngChunk(type, data) {
	const len = data.length;
	return [len >>> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255, ...Buffer.from(type), ...data, 0, 0, 0, 0];
}

describe('PNG and WebP', () => {
	it('PNG: eXIf / tEXt / iTXt / zTXt / tIME go, image chunks stay', () => {
		const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
		const png = Uint8Array.from([
			...sig,
			...pngChunk('IHDR', Array(13).fill(1)),
			...pngChunk('eXIf', [...Buffer.from('MM\0*GPS')]),
			...pngChunk('tEXt', [...Buffer.from('Comment\0home')]),
			...pngChunk('tIME', Array(7).fill(0)),
			...pngChunk('IDAT', [1, 2, 3]),
			...pngChunk('IEND', [])
		]);
		expect(sniffType(png)).toBe('image/png');
		expect(metadataOf(png)).toMatchObject({ exif: true, text: true });
		const clean = stripMetadata(png);
		expect(metadataOf(clean)).toMatchObject({ exif: false, text: false });
		const s = Buffer.from(clean).toString('latin1');
		expect(s.includes('IHDR') && s.includes('IDAT') && s.includes('IEND')).toBe(true);
		expect(s.includes('tIME')).toBe(false);
	});
	it('WebP: EXIF and XMP chunks go, the VP8X flags clear, the RIFF size is right', () => {
		const chunk = (/** @type {string} */ t, /** @type {number[]} */ d) => [...Buffer.from(t), d.length & 255, (d.length >> 8) & 255, 0, 0, ...d, ...(d.length & 1 ? [0] : [])];
		const body = [...Buffer.from('WEBP'), ...chunk('VP8X', [0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0]), ...chunk('VP8 ', [9, 9, 9, 9]), ...chunk('EXIF', [...Buffer.from('II*\0gps')]), ...chunk('XMP ', [1, 2, 3])];
		const size = body.length;
		const webp = Uint8Array.from([...Buffer.from('RIFF'), size & 255, (size >> 8) & 255, 0, 0, ...body]);
		expect(metadataOf(webp)).toMatchObject({ exif: true, xmp: true });
		const clean = stripMetadata(webp);
		expect(metadataOf(clean)).toMatchObject({ exif: false, xmp: false });
		expect(clean[12 + 8] & 0x0c).toBe(0); // the VP8X flags byte
		const riff = clean[4] | (clean[5] << 8) | (clean[6] << 16);
		expect(riff).toBe(clean.length - 8);
	});
});

describe('sizing', () => {
	it('long edge to 1568, never upscaled, aspect kept', () => {
		expect(fitSize(4000, 3000)).toEqual({ w: MAX_EDGE, h: 1176 });
		expect(fitSize(3000, 4000)).toEqual({ w: 1176, h: MAX_EDGE });
		expect(fitSize(800, 600)).toEqual({ w: 800, h: 600 });
		expect(fitSize(0, 10)).toEqual({ w: 1, h: 1 });
	});
	it('the plan walks the qualities, then shrinks', () => {
		const plan = encodePlan(4000, 3000);
		expect(plan[0]).toEqual({ w: 1568, h: 1176, quality: QUALITIES[0] });
		expect(plan[QUALITIES.length].w).toBe(Math.round(1568 * 0.8));
		expect(plan.every((p) => Math.max(p.w, p.h) <= MAX_EDGE)).toBe(true);
	});
	it('sniffs by content, not by name', () => {
		expect(sniffType(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]))).toBe('image/gif');
		expect(sniffType(Uint8Array.from([0, 0, 0, 24, ...Buffer.from('ftypheic'), 0, 0]))).toBe('image/heic');
		expect(sniffType(Uint8Array.from(Buffer.from('<svg xmlns=...>   ')))).toBe('');
	});
	it('base64 round trip and names', () => {
		const b = Uint8Array.from({ length: 70000 }, (_, i) => i & 255);
		expect(Buffer.from(fromBase64(toBase64(b))).equals(Buffer.from(b))).toBe(true);
		expect(attachName('IMG_2041.HEIC', 'image/webp')).toBe('IMG_2041.webp');
		expect(attachName('a/b:c.png', 'image/jpeg')).toBe('a b c.jpg');
	});
});
