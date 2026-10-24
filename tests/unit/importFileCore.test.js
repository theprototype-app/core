// 66 S4b — import_file's pure half: the type comes from the BYTES, the caps hold before anything is
// stored, image metadata goes, chunked uploads assemble (and refuse a bad split), viewers are refused.
// Fixtures: a real Pixling 0.3.1 sheet + spec (tests/e2e/fixtures/pixling) and 56's GLB.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	sniffFile,
	sizeRefusal,
	cleanBytes,
	imageSize,
	fileName,
	stemOf,
	generatorTag,
	specBytes,
	folderPath,
	frameWindow,
	cardSize,
	filterFor,
	facingOf,
	importRefusal,
	addChunk,
	parseJsonBytes,
	MAX_IMAGE_BYTES,
	MAX_JSON_BYTES,
	MAX_CHUNKS,
	CHUNK_TTL_MS,
	DEFAULT_FOLDER
} from '../../src/lib/ai/importFileCore.js';
import { metadataOf, toBase64 } from '../../src/lib/chat/attachCore.js';
import { createAgentCore, viewerRefusal } from '../../src/lib/agent/agentCore.js';

const fx = (/** @type {string} */ p) => new Uint8Array(readFileSync(fileURLToPath(new URL('../e2e/fixtures/' + p, import.meta.url))));
const sheet = fx('pixling/knight_walk.png');
const spec = JSON.parse(new TextDecoder().decode(fx('pixling/knight.pixling.json')));
const glb = fx('campfire-named.glb');

/** a PNG chunk (CRC zero: the strip and the sniff never check it) @param {string} type @param {Uint8Array} body */
function pngChunk(type, body) {
	const out = new Uint8Array(12 + body.length);
	new DataView(out.buffer).setUint32(0, body.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(body, 8);
	return out;
}
/** the sheet with metadata chunks inserted after IHDR (33 = 8 sig + 25 IHDR) */
function taggedSheet() {
	const enc = new TextEncoder();
	const exif = pngChunk('eXIf', enc.encode('MM\0*GPSLatitude 52.37 GPSLongitude 4.89'));
	const text = pngChunk('tEXt', enc.encode('Author\0someone@their-machine'));
	const parts = [sheet.subarray(0, 33), exif, text, sheet.subarray(33)];
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) (out.set(p, at), (at += p.length));
	return out;
}
/** a minimal WebP header (VP8X 64×32) + an EXIF chunk — enough for sniff / size / strip */
function webpWithExif() {
	const enc = new TextEncoder();
	const vp8x = new Uint8Array(18);
	vp8x.set(enc.encode('VP8X'), 0);
	vp8x[4] = 10;
	vp8x[8] = 0x08; // EXIF flag
	vp8x[12] = 63; // width - 1
	vp8x[15] = 31; // height - 1
	const exifBody = enc.encode('GPS!');
	const exif = new Uint8Array(8 + exifBody.length);
	exif.set(enc.encode('EXIF'), 0);
	exif[4] = exifBody.length;
	exif.set(exifBody, 8);
	const out = new Uint8Array(12 + vp8x.length + exif.length);
	out.set(enc.encode('RIFF'), 0);
	out.set(enc.encode('WEBP'), 8);
	out.set(vp8x, 12);
	out.set(exif, 12 + vp8x.length);
	new DataView(out.buffer).setUint32(4, out.length - 8, true);
	return out;
}
/** 56's GLB with its JSON chunk edited @param {(json: any) => void} edit */
function glbWith(edit) {
	const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
	const jsonLen = dv.getUint32(12, true);
	const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
	edit(json);
	let text = JSON.stringify(json);
	while (text.length % 4) text += ' ';
	const jsonBytes = new TextEncoder().encode(text);
	const rest = glb.subarray(20 + jsonLen);
	const out = new Uint8Array(20 + jsonBytes.length + rest.length);
	out.set(glb.subarray(0, 12));
	const odv = new DataView(out.buffer);
	odv.setUint32(8, out.length, true);
	odv.setUint32(12, jsonBytes.length, true);
	odv.setUint32(16, 0x4e4f534a, true);
	out.set(jsonBytes, 20);
	out.set(rest, 20 + jsonBytes.length);
	return out;
}

describe('sniffFile: the type is the BYTES', () => {
	it('a real Pixling sheet is a PNG, its size read from the header', () => {
		expect(sniffFile(sheet)).toMatchObject({ kind: 'png', mime: 'image/png', ext: '.png', max: MAX_IMAGE_BYTES });
		expect(imageSize(sheet)).toEqual({ w: 1024, h: 192 });
	});
	it('a WebP is a WebP (VP8X size)', () => {
		const w = webpWithExif();
		expect(sniffFile(w)).toMatchObject({ kind: 'webp', ext: '.webp' });
		expect(imageSize(w)).toEqual({ w: 64, h: 32 });
	});
	it('a Pixling spec is JSON (object), a BOM is fine; a bare number or broken JSON is not', () => {
		const bytes = new TextEncoder().encode(JSON.stringify(spec));
		expect(sniffFile(bytes)).toMatchObject({ kind: 'json', max: MAX_JSON_BYTES });
		expect(sniffFile(new TextEncoder().encode('﻿[1,2]'))).toMatchObject({ kind: 'json' });
		expect(sniffFile(new TextEncoder().encode('42'))).toHaveProperty('error');
		expect(sniffFile(new TextEncoder().encode('{"a": 1,'))).toMatchObject({ error: expect.stringMatching(/does not parse/) });
		expect(parseJsonBytes(new Uint8Array([0x7b, 0xff, 0x7d])).ok).toBe(false); // not UTF-8
	});
	it('a GLB with .tpanim extras (or a VRM Animation) is a clip; a plain GLB is a model → import_model', () => {
		expect(sniffFile(glbWith((j) => (j.extras = { theprototype: { format: 1, kind: 'clip' } })))).toMatchObject({ kind: 'tpanim', ext: '.tpanim' });
		expect(sniffFile(glbWith((j) => ((j.extensionsUsed = ['VRMC_vrm_animation']), (j.animations = [{ channels: [], samplers: [] }]))))).toMatchObject({ kind: 'tpanim' });
		expect(sniffFile(glb)).toMatchObject({ error: expect.stringMatching(/import_model/) });
	});
	it('COUNTERFACTUAL: the name plays no part — a JPEG is refused whatever it is called, a GIF too', () => {
		const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0]);
		expect(sniffFile(jpeg)).toMatchObject({ error: expect.stringMatching(/JPEG.*PNG/) });
		expect(sniffFile(new TextEncoder().encode('GIF89a\x01\x00\x01\x00\x00\x00\x00'))).toMatchObject({ error: expect.stringMatching(/GIF/) });
		expect(sniffFile(new Uint8Array(0))).toMatchObject({ error: 'the file is empty' });
		expect(sniffFile(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]))).toHaveProperty('error');
	});
});

describe('caps', () => {
	it('16 MB per image, 2 MB per JSON — refused with the numbers', () => {
		const png = /** @type {any} */ (sniffFile(sheet));
		expect(sizeRefusal(png, MAX_IMAGE_BYTES)).toBeNull();
		expect(sizeRefusal(png, MAX_IMAGE_BYTES + 1)).toMatch(/limit for an image is 16\.0 MB/);
		const json = /** @type {any} */ (sniffFile(new TextEncoder().encode('{}')));
		expect(sizeRefusal(json, MAX_JSON_BYTES + 1)).toMatch(/limit for a JSON file is 2\.0 MB/);
	});
	it('a spec over 2 MB is refused; a spec string is parsed; a non-object refused', () => {
		expect(specBytes(null)).toBeNull();
		expect(specBytes(spec)).toMatchObject({ ok: true });
		expect(specBytes(JSON.stringify(spec))).toMatchObject({ ok: true, value: { name: 'knight' } });
		expect(specBytes('nope')).toMatchObject({ ok: false });
		expect(specBytes(7)).toMatchObject({ ok: false });
		expect(specBytes({ blob: 'x'.repeat(MAX_JSON_BYTES) })).toMatchObject({ ok: false, error: expect.stringMatching(/limit is 2/) });
	});
});

describe('metadata strip (the 56 chat-image rule)', () => {
	it('COUNTERFACTUAL: a GPS-tagged PNG loses eXIf + tEXt; the pixels (every other chunk) are kept byte-for-byte', () => {
		const tagged = taggedSheet();
		expect(metadataOf(tagged)).toMatchObject({ exif: true, gps: true, text: true });
		const { bytes, stripped } = cleanBytes(tagged, /** @type {any} */ (sniffFile(tagged)));
		expect(stripped).toEqual(expect.arrayContaining(['gps', 'exif', 'text']));
		expect(metadataOf(bytes)).toEqual({ exif: false, gps: false, xmp: false, text: false });
		expect(Buffer.from(bytes).equals(Buffer.from(sheet))).toBe(true);
	});
	it('a clean Pixling sheet passes through unchanged (so its hash is the file\'s hash)', () => {
		const { bytes, stripped } = cleanBytes(sheet, /** @type {any} */ (sniffFile(sheet)));
		expect(stripped).toEqual([]);
		expect(bytes).toBe(sheet);
	});
	it('a WebP loses its EXIF chunk and the VP8X flag', () => {
		const w = webpWithExif();
		const { bytes, stripped } = cleanBytes(w, /** @type {any} */ (sniffFile(w)));
		expect(stripped.length).toBeGreaterThan(0);
		expect(metadataOf(bytes).exif).toBe(false);
		expect(bytes[20] & 0x08).toBe(0);
	});
	it('JSON and clips are stored as sent', () => {
		const j = new TextEncoder().encode('{"a":1}');
		expect(cleanBytes(j, /** @type {any} */ (sniffFile(j))).bytes).toBe(j);
	});
});

describe('names, folders, the spec beside the sheet (F2)', () => {
	it('the extension comes from the bytes; paths and control characters go', () => {
		expect(fileName('knight.jpg', '.png')).toBe('knight.png');
		expect(fileName('../../etc/knight_walk.png', '.png')).toBe('knight_walk.png');
		expect(fileName('a<b>:c\u0007', '.json')).toBe('a b c.json');
		expect(fileName('', '.webp')).toBe('generated.webp');
		expect(fileName('clip.tpanim.glb', '.tpanim')).toBe('clip.tpanim');
		expect(fileName('knight_walk.frames', '.json')).toBe('knight_walk.frames.json'); // not a file type: the name's own
		expect(fileName('v1.2 hero.PNG', '.png')).toBe('v1.2 hero.png');
	});
	it('<stem>.<generator>.json pairs with the sheet', () => {
		expect(stemOf('knight_walk.png') + '.' + generatorTag(undefined) + '.json').toBe('knight_walk.pixling.json');
		expect(generatorTag('ImageMagick 7!')).toBe('imagemagick7');
	});
	it('folder default "Generated"; "A/B" nests, at most 4 levels', () => {
		expect(folderPath(undefined)).toEqual([DEFAULT_FOLDER]);
		expect(folderPath('Sprites/Knights')).toEqual(['Sprites', 'Knights']);
		expect(folderPath('/a//b/c/d/e/')).toEqual(['a', 'b', 'c', 'd']);
	});
});

describe('the card', () => {
	it('frame 0,0 of the knight sheet = the top-left 64×48 (flipY: row 0 is the top strip)', () => {
		const w = /** @type {any} */ (frameWindow({ w: 64, h: 48 }, { w: 1024, h: 192 }));
		expect(w.repeat).toEqual([0.0625, 0.25]);
		expect(w.offset).toEqual([0, 0.75]);
		const e = /** @type {any} */ (frameWindow({ w: 64, h: 48, col: 3, row: 1 }, { w: 1024, h: 192 }));
		expect(e.offset).toEqual([0.1875, 0.5]);
		expect(frameWindow({ w: 64, h: 48, col: 16 }, { w: 1024, h: 192 })).toMatchObject({ error: expect.stringMatching(/does not fit/) });
		expect(frameWindow({ w: 0, h: 48 }, { w: 1024, h: 192 })).toHaveProperty('error');
		expect(frameWindow(null, { w: 1, h: 1 })).toBeNull();
	});
	it('size: 1 m tall by default, width from the aspect; width alone works', () => {
		expect(cardSize({ w: 64, h: 48 })).toEqual({ width: 64 / 48, height: 1 });
		expect(cardSize({ w: 64, h: 48 }, { width: 2 })).toEqual({ width: 2, height: 1.5 });
		expect(cardSize({ w: 64, h: 48 }, { height: 3 })).toEqual({ width: 4, height: 3 });
	});
	it('filter: nearest for pixel art (a spec rides along, or a small image), else linear; explicit wins', () => {
		expect(filterFor(undefined, { hasSpec: true, size: { w: 4096, h: 4096 } })).toBe('nearest');
		expect(filterFor('auto', { hasSpec: false, size: { w: 64, h: 64 } })).toBe('nearest');
		expect(filterFor(undefined, { hasSpec: false, size: { w: 2048, h: 1024 } })).toBe('linear');
		expect(filterFor('linear', { hasSpec: true, size: null })).toBe('linear');
		expect(filterFor('pixel', { hasSpec: false, size: null })).toBe('nearest');
	});
	it('facing', () => {
		expect(facingOf('camera')).toBe('camera');
		expect(facingOf(true)).toBe('camera');
		expect(facingOf('camera-y')).toBe('camera-y');
		expect(facingOf('none')).toBeNull();
		expect(facingOf(undefined)).toBeNull();
	});
});

describe('chunked uploads', () => {
	const b64 = toBase64(sheet);
	it('parts in any order assemble to the exact file; non-final calls say how far', () => {
		const store = new Map();
		const cut = 4 * 1024; // a multiple of 4 base64 chars
		const parts = [];
		for (let i = 0; i < b64.length; i += cut) parts.push(b64.slice(i, i + cut));
		const total = parts.length;
		/** @type {any} */
		let last = null;
		for (const i of [...parts.keys()].reverse()) last = addChunk(store, { id: 'k', index: i, total }, parts[i], 1000);
		expect(last).toEqual({ done: true, data: b64 });
		expect(store.size).toBe(0);
		expect(addChunk(store, { id: 'k2', index: 0, total: 2 }, parts[0], 1000)).toEqual({ done: false, received: 1, total: 2 });
	});
	it('refuses a split that is not on a base64 block, a bad header, too many parts, an over-cap upload', () => {
		const store = new Map();
		addChunk(store, { id: 'x', index: 0, total: 2 }, b64.slice(0, 5), 0);
		expect(addChunk(store, { id: 'x', index: 1, total: 2 }, b64.slice(5), 0)).toMatchObject({ error: expect.stringMatching(/multiple of 4/) });
		expect(addChunk(store, { id: '', index: 0, total: 1 }, 'AAAA', 0)).toHaveProperty('error');
		expect(addChunk(store, { id: 'y', index: 2, total: 2 }, 'AAAA', 0)).toHaveProperty('error');
		expect(addChunk(store, { id: 'y', index: 0, total: MAX_CHUNKS + 1 }, 'AAAA', 0)).toMatchObject({ error: expect.stringMatching(/at most/) });
		addChunk(store, { id: 'z', index: 0, total: 3 }, 'AAAA', 0);
		expect(addChunk(store, { id: 'z', index: 1, total: 4 }, 'AAAA', 0)).toMatchObject({ error: expect.stringMatching(/started with total 3/) });
		const big = 'A'.repeat(18 * 1024 * 1024);
		addChunk(store, { id: 'big', index: 0, total: 3 }, big, 0);
		expect(addChunk(store, { id: 'big', index: 1, total: 3 }, big, 0)).toMatchObject({ error: expect.stringMatching(/passed/) });
		expect(store.has('big')).toBe(false);
	});
	it('an abandoned upload is dropped after the TTL', () => {
		const store = new Map();
		addChunk(store, { id: 'old', index: 0, total: 2 }, 'AAAA', 0);
		addChunk(store, { id: 'new', index: 0, total: 2 }, 'AAAA', CHUNK_TTL_MS + 1);
		expect([...store.keys()]).toEqual(['new']);
	});
});

describe('roles: only editors\' agents import', () => {
	it('the tool refuses a viewer with words to relay; editors / admins / no roles plugin pass', () => {
		expect(importRefusal('viewer')).toMatch(/viewer/);
		for (const role of ['editor', 'admin', null, undefined]) expect(importRefusal(role)).toBeNull();
	});
	it('COUNTERFACTUAL: tpAgent.exec("import_file") on a viewer page is refused before the tool runs', async () => {
		/** @type {any[]} */
		const ran = [];
		const deps = /** @type {any} */ ({
			getTools: () => [],
			resolveName: (/** @type {string} */ n) => ({ name: n }),
			runTool: async (/** @type {string} */ n) => (ran.push(n), { file: {} }),
			beginBatch: () => {},
			endBatch: () => {},
			peerId: () => 'v1ewr',
			role: () => 'viewer',
			host: () => null,
			waiting: () => false,
			openPeers: () => [],
			inVR: () => false,
			missingTools: () => [],
			missingModules: () => [],
			onSceneChange: () => () => {}
		});
		const { agent } = createAgentCore(deps);
		const res = await agent.exec('import_file', { data: toBase64(sheet), spec });
		expect(res).toMatchObject({ refused: true, role: 'viewer', error: viewerRefusal('v1ewr') });
		expect(ran).toEqual([]);
		deps.role = () => 'editor';
		await agent.exec('import_file', { data: 'AAAA' });
		expect(ran).toEqual(['import_file']);
	});
});
