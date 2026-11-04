import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore - opentype.js ships no types
import opentype from 'opentype.js';
import {
	pathToContours,
	signedArea,
	contoursToShapes,
	styleShapes,
	layoutBlock,
	anchorParts,
	blockAlign,
	layoutInPlace,
	sniffFont,
	embeddingForbidden,
	fontLicence,
	licenceLabel,
	cleanFamilyName,
	googleCssUrl,
	pickGoogleFontUrl
} from '../../src/lib/text3dCore.js';
import { normalizeTextPath, textCapCheck, textCharCap, TEXT_FONTS, SOLID_FONTS_PATH, TEXT_CAPS, TEXT_PATH_VERSION, isBlockText, isNewerTextRecord } from '../../src/lib/textPathCore.js';

// 64-text: the pure half of the ONE text object's extruded mode, block layout and font import.

const ROOT = path.resolve(__dirname, '../..');
/** @param {string} rel */
function loadFont(rel) {
	const b = fs.readFileSync(path.join(ROOT, 'static', rel));
	return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}
const sans = loadFont(SOLID_FONTS_PATH + '/' + TEXT_FONTS[0].solid);

/** a tiny font written by opentype.js itself (a square "O" with a square hole), with a licence
 * and an fsType — what a user's upload carries in its name and OS/2 tables @param {number} fsType */
function syntheticFont(fsType) {
	const p = new opentype.Path();
	p.moveTo(0, 0);
	p.lineTo(600, 0);
	p.lineTo(600, 700);
	p.lineTo(0, 700);
	p.close();
	p.moveTo(150, 150);
	p.lineTo(150, 550);
	p.lineTo(450, 550);
	p.lineTo(450, 150);
	p.close();
	const font = new opentype.Font({
		familyName: 'Tp Test',
		styleName: 'Regular',
		unitsPerEm: 1000,
		ascender: 800,
		descender: -200,
		license: 'This Font Software is licensed under the SIL Open Font License, Version 1.1.',
		licenseURL: 'https://openfontlicense.org',
		glyphs: [
			new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: 650, path: new opentype.Path() }),
			new opentype.Glyph({ name: 'O', unicode: 79, advanceWidth: 650, path: p })
		]
	});
	font.tables.os2 = { fsType };
	return new Uint8Array(font.toArrayBuffer());
}

/** shapes of one character of a real font @param {any} font @param {string} ch */
function shapesOf(font, ch) {
	return contoursToShapes(pathToContours(font.charToGlyph(ch).path.commands, 6, { scale: 1 / font.unitsPerEm }));
}

describe('glyph outline -> shapes (holes by nesting)', () => {
	it('"O" is one outline with one hole', () => {
		const s = shapesOf(sans, 'O');
		expect(s.length).toBe(1);
		expect(s[0].holes.length).toBe(1);
		expect(signedArea(s[0].outer)).toBeGreaterThan(0); // CCW
		expect(signedArea(s[0].holes[0])).toBeLessThan(0); // CW
	});
	it('"B" has two holes, "i" two outlines, "8" two holes, "l" none', () => {
		expect(shapesOf(sans, 'B').map((x) => x.holes.length)).toEqual([2]);
		const i = shapesOf(sans, 'i');
		expect(i.length).toBe(2);
		expect(i.every((x) => x.holes.length === 0)).toBe(true);
		expect(shapesOf(sans, '8')[0].holes.length).toBe(2);
		expect(shapesOf(sans, 'l')).toEqual([expect.objectContaining({ holes: [] })]);
	});
	it('every bundled font reads and makes an "O" with a hole', () => {
		for (const f of TEXT_FONTS) {
			const font = loadFont(SOLID_FONTS_PATH + '/' + f.solid);
			const s = shapesOf(font, 'O');
			// the pixel font draws its O from squares, still exactly one hole
			expect(s.reduce((n, x) => n + x.holes.length, 0), f.id).toBe(1);
		}
	});
	it('winding does not matter: a reversed font outline still sorts', () => {
		const outer = [[0, 0], [10, 0], [10, 10], [0, 10]];
		const hole = [[3, 3], [7, 3], [7, 7], [3, 7]];
		const island = [[4, 4], [6, 4], [6, 6], [4, 6]];
		for (const loops of [[outer, hole, island], [outer.slice().reverse(), hole.slice().reverse(), island]]) {
			const s = contoursToShapes(loops);
			expect(s.length).toBe(2); // the outline (with the hole) and the island inside the hole
			expect(s.map((x) => x.holes.length).sort()).toEqual([0, 1]);
			for (const x of s) expect(signedArea(x.outer)).toBeGreaterThan(0);
		}
	});
	it('curves flatten by the quality, closing points and zero-area loops dropped', () => {
		const cmds = [{ type: 'M', x: 0, y: 0 }, { type: 'Q', x1: 5, y1: 10, x: 10, y: 0 }, { type: 'L', x: 0, y: 0 }, { type: 'Z' }, { type: 'M', x: 0, y: 0 }, { type: 'L', x: 1, y: 0 }, { type: 'Z' }];
		expect(pathToContours(cmds, 4)[0].length).toBe(5);
		expect(pathToContours(cmds, 12)[0].length).toBe(13);
		expect(pathToContours(cmds, 4).length).toBe(1);
	});
	it('a letter style scales and turns its loops about the pivot', () => {
		const sq = [{ outer: [[0, 0], [1, 0], [1, 1], [0, 1]], holes: [] }];
		const r = styleShapes(sq, { size: 2, rot: 90, dx: 1, dy: 0 }, [0, 0], 0.5);
		expect(r[0].outer[1][0]).toBeCloseTo(0.5);
		expect(r[0].outer[1][1]).toBeCloseTo(2);
		expect(styleShapes(sq, { size: 1, rot: 0, dx: 0, dy: 0 }, [0, 0], 1)).toBe(sq);
	});
});

/** a monospace fake font: every char 0.5 em, ascender 0.8, descender -0.2 */
const mono = { advance: () => 0.5, ascender: 0.8, descender: -0.2 };
const P = { size: 1, spacing: 0, lineHeight: 1.2, maxWidth: 0, align: 'start', anchor: 'top-left' };

describe('block layout', () => {
	it('places letters along the baseline, top-left anchored', () => {
		const r = layoutBlock(Array.from('abc'), mono, P);
		expect(Array.from(r.x)).toEqual([0, 0.5, 1]);
		expect(r.y[0]).toBeCloseTo(-0.8);
		expect(r.width).toBeCloseTo(1.5);
		expect(r.lines).toBe(1);
	});
	it('wraps at spaces with maxWidth, keeps a long word whole, breaks on \\n', () => {
		const r = layoutBlock(Array.from('aa bb cc'), mono, { ...P, maxWidth: 2.6 });
		expect(r.lines).toBe(2); // "aa bb " | "cc"
		expect(r.line[6]).toBe(1);
		expect(r.x[6]).toBeCloseTo(0);
		const long = layoutBlock(Array.from('aaaaaaaa'), mono, { ...P, maxWidth: 1 });
		expect(long.lines).toBe(1);
		const nl = layoutBlock(Array.from('a\nb'), mono, P);
		expect(nl.lines).toBe(2);
		expect(nl.y[2] - nl.y[0]).toBeCloseTo(-1.2);
	});
	it('align centre / end / fit and the 9-grid anchor', () => {
		const c = layoutBlock(Array.from('aaaa\nbb'), mono, { ...P, align: 'center' });
		expect(c.x[5]).toBeCloseTo(0.5); // a 1 m line centred in a 2 m block
		const e = layoutBlock(Array.from('aaaa\nbb'), mono, { ...P, align: 'end' });
		expect(e.x[5]).toBeCloseTo(1);
		const j = layoutBlock(Array.from('a a aaaa aaaa'), mono, { ...P, align: 'fit', maxWidth: 4 });
		expect(j.lines).toBe(2);
		const mid = layoutBlock(Array.from('ab'), mono, { ...P, anchor: 'middle-center' });
		expect(mid.x[0]).toBeCloseTo(-0.5);
		// block from +0.8 to -0.2 around its first baseline -> centred: baseline at -0.3
		expect(mid.y[0]).toBeCloseTo(-0.3);
		const bot = layoutBlock(Array.from('ab'), mono, { ...P, anchor: 'bottom-right' });
		expect(bot.x[1]).toBeCloseTo(-0.5);
		expect(bot.y[0]).toBeCloseTo(0.2);
		expect(anchorParts('garbage')).toEqual({ x: 'center', y: 'middle' });
		expect(blockAlign('fit')).toBe('justify');
	});
	it('letter spacing and kerning move the pen; size scales everything', () => {
		const r = layoutBlock(Array.from('ab'), { ...mono, kern: () => -0.1 }, { ...P, spacing: 0.2, size: 2 });
		expect(r.x[1]).toBeCloseTo((0.5 + 0.2) * 2 - 0.2);
	});
	it('a real font lays out "HELLO" with kerning-free advances matching the font', () => {
		const k = 1 / sans.unitsPerEm;
		const m = {
			advance: (/** @type {string} */ ch) => sans.charToGlyph(ch).advanceWidth * k,
			ascender: sans.ascender * k,
			descender: sans.descender * k
		};
		const r = layoutBlock(Array.from('HELLO'), m, { ...P, size: 0.5 });
		expect(r.x[1]).toBeCloseTo(sans.charToGlyph('H').advanceWidth * k * 0.5, 5);
	});
});

describe('flat block per-letter rows', () => {
	it('an unstyled glyph keeps its place (identity), a styled one turns about its caret', () => {
		const info = { glyphBounds: [0, 0, 1, 1, 1, 0, 2, 1], glyphChars: [0, 1], caretPositions: [0, 1, 0, 1, 1, 2, 0, 1], fontSize: 1 };
		const { rows } = layoutInPlace(info, [{ size: 1, dx: 0, dy: 0, rot: 0 }, { size: 2, dx: 0, dy: 0, rot: 0 }], 4);
		expect(Array.from(rows.subarray(0, 12))).toEqual([1, -0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
		// glyph 2 doubled about (1.5, 0): x' = 2x - 1.5
		expect(rows[12]).toBe(2);
		expect(rows[15]).toBeCloseTo(-1.5);
	});
});

describe('records, modes and caps', () => {
	it('extruded mode, bevel, anchor and materials normalise', () => {
		const r = normalizeTextPath({ mode: 'extruded', depth: -1, bevel: { size: 9, segments: 99 }, anchor: 'nope', sideColor: '#ABCDEF', emissive: 9, fontAsset: 'abc' });
		expect(r.mode).toBe('extruded');
		expect(r.depth).toBe(0.001);
		expect(r.bevel).toEqual({ size: 1, thickness: 0.01, segments: 8 });
		expect(r.anchor).toBe('middle-center');
		expect(r.sideColor).toBe('#abcdef');
		expect(r.emissive).toBe(4);
		expect(r.fontAsset).toBe(null); // too short to be a content hash
		expect(normalizeTextPath({ fontAsset: 'a'.repeat(64), fontName: 'Lobster\u0007' })).toMatchObject({ fontAsset: 'a'.repeat(64), fontName: 'Lobster' });
	});
	it('extruded text on a path stays flat (out of scope)', () => {
		expect(normalizeTextPath({ mode: 'extruded', path: { kind: 'arc' } }).mode).toBe('flat');
		expect(normalizeTextPath({ mode: 'extruded', path: { kind: 'none' } }).mode).toBe('extruded');
	});
	it('char caps: extruded lower than flat, low devices lower still', () => {
		expect(textCharCap('extruded', 'desktop')).toBeLessThan(textCharCap('flat', 'desktop'));
		expect(textCharCap('extruded', 'low')).toBeLessThan(textCharCap('extruded', 'desktop'));
		const long = normalizeTextPath({ mode: 'extruded', text: 'x'.repeat(TEXT_CAPS.low.extruded + 1) });
		expect(textCapCheck(long, 'desktop').ok).toBe(true);
		const refused = textCapCheck(long, 'low');
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.message).toMatch(/too long.*on this device/);
		// code points, not UTF-16 units
		expect(textCapCheck(normalizeTextPath({ mode: 'extruded', text: '😀'.repeat(TEXT_CAPS.low.extruded) }), 'low').ok).toBe(true);
	});
});

describe('fonts the user adds', () => {
	it('sniffs the four formats by magic', () => {
		const b = (/** @type {string} */ s) => Array.from(s).map((c) => c.charCodeAt(0));
		expect(sniffFont(b('wOFF'))).toBe('woff');
		expect(sniffFont(b('wOF2'))).toBe('woff2');
		expect(sniffFont(b('OTTO'))).toBe('otf');
		expect(sniffFont([0, 1, 0, 0])).toBe('ttf');
		expect(sniffFont(b('true'))).toBe('ttf');
		expect(sniffFont(b('<svg'))).toBe(null);
		expect(sniffFont([])).toBe(null);
	});
	it('fsType: restricted (0x2) and bitmap-only (0x200) forbid embedding', () => {
		expect(embeddingForbidden(0)).toBe(false);
		expect(embeddingForbidden(0x0002)).toBe(true);
		expect(embeddingForbidden(0x0004)).toBe(false);
		expect(embeddingForbidden(0x0008)).toBe(false);
		expect(embeddingForbidden(0x0208)).toBe(true);
		expect(embeddingForbidden(undefined)).toBe(false);
	});
	it('reads the name table licence + URL and the fsType from a parsed font', () => {
		const bytes = syntheticFont(0x0002);
		const back = opentype.parse(bytes.buffer);
		const info = fontLicence(back);
		expect(info.family).toBe('Tp Test');
		expect(info.url).toBe('https://openfontlicense.org');
		expect(info.fsType).toBe(2);
		expect(info.noEmbed).toBe(true);
		expect(licenceLabel(info.licence, info.url)).toBe('SIL Open Font License');
		expect(fontLicence({ names: { licenseURL: { en: 'javascript:alert(1)' } } }).url).toBe('');
		expect(fontLicence(opentype.parse(syntheticFont(0).buffer)).noEmbed).toBe(false);
	});
	it('WOFF2 decodes to sfnt bytes the font reader takes', async () => {
		// @ts-ignore - CJS, no types
		const { default: compress } = await import('wawoff2/compress.js');
		// @ts-ignore - CJS, no types
		const { default: decompress } = await import('wawoff2/decompress.js');
		const woff2 = await compress(syntheticFont(0));
		expect(sniffFont(woff2)).toBe('woff2');
		const back = await decompress(woff2);
		expect(sniffFont(back)).toBe('otf');
		const font = opentype.parse(back.buffer.slice(back.byteOffset, back.byteOffset + back.length));
		expect(contoursToShapes(pathToContours(font.charToGlyph('O').path.commands, 4))[0].holes.length).toBe(1);
	}, 30000);
	it('Google Fonts: family names, the CSS URL and the latin file in its answer', () => {
		expect(cleanFamilyName('  Lobster   Two ')).toBe('Lobster Two');
		expect(cleanFamilyName('../etc')).toBe(null);
		expect(cleanFamilyName('a'.repeat(61))).toBe(null);
		expect(googleCssUrl('Lobster Two', { bold: true })).toBe('https://fonts.googleapis.com/css2?family=Lobster+Two:wght@700&display=swap');
		expect(googleCssUrl('Lobster', { italic: true })).toContain(':ital,wght@1,400');
		const css = `/* cyrillic */\n@font-face { font-family: 'Lobster'; src: url(https://fonts.gstatic.com/s/lobster/v30/cyr.woff2) format('woff2'); }\n/* latin */\n@font-face { font-family: 'Lobster'; src: url(https://fonts.gstatic.com/s/lobster/v30/latin.woff2) format('woff2'); }`;
		expect(pickGoogleFontUrl(css)).toBe('https://fonts.gstatic.com/s/lobster/v30/latin.woff2');
		expect(pickGoogleFontUrl(`@font-face { src: url(https://fonts.gstatic.com/s/x/one.ttf) }`)).toBe('https://fonts.gstatic.com/s/x/one.ttf');
		expect(pickGoogleFontUrl(`@font-face { src: url(https://evil.example/x.woff2) }`)).toBe(null);
	});
});

describe('TX4 old and newer records', () => {
	it('a v1 record (64 D2, text on a path) keeps its curve, text and look; it reads as flat', () => {
		const v1 = { v: 1, text: 'Welcome', font: 'serif', size: 0.3, color: '#ff0000', path: { kind: 'arc', radius: 2, angle: 120 }, offset: 0.1, align: 'center' };
		const r = normalizeTextPath(v1);
		expect(r).toMatchObject({ v: TEXT_PATH_VERSION, text: 'Welcome', font: 'serif', size: 0.3, color: '#ff0000', mode: 'flat', path: { kind: 'arc' }, offset: 0.1 });
		expect(isBlockText(r)).toBe(false);
	});
	it('a newer record keeps its unknown fields and its version through our normalize; ours never grow them', () => {
		const newer = { v: TEXT_PATH_VERSION + 1, text: 'Hi', mode: 'extruded', path: { kind: 'none' }, gradient: { from: '#000000', to: '#ffffff' } };
		expect(isNewerTextRecord(newer)).toBe(true);
		const r = normalizeTextPath(newer);
		expect(r).toMatchObject({ v: TEXT_PATH_VERSION + 1, text: 'Hi', mode: 'extruded', gradient: { from: '#000000', to: '#ffffff' } });
		// an edit merges over it and the field survives a second normalize
		expect(/** @type {any} */ (normalizeTextPath({ ...r, text: 'Hello' })).gradient).toEqual({ from: '#000000', to: '#ffffff' });
		// a record of ours never carries strangers
		const ours = normalizeTextPath({ v: TEXT_PATH_VERSION, text: 'x', gradient: 1 });
		expect('gradient' in ours).toBe(false);
		expect(isNewerTextRecord(ours)).toBe(false);
		// a huge or junk newer payload is dropped, not copied
		expect('blob' in normalizeTextPath({ v: 99, blob: 'x'.repeat(5000) })).toBe(false);
		expect(isNewerTextRecord({ v: 1e9 })).toBe(false);
	});
});
