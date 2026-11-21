// 102b-play row 2: info points — the visitor flag and the one picture on a note, and the pure
// helpers the play app lists them with. No browser.
import { describe, it, expect } from 'vitest';
import { normalizePicture, visitorNotes, infoTitle, applyInfoPointFields, MAX_PICTURE_CHARS } from '../../src/lib/infoPoints.js';
// annotationsHandler needs a browser; its normalizer ends in applyInfoPointFields(out, raw)
const normalizeAnnotation = (/** @type {any} */ a) => applyInfoPointFields({ ...a }, a);

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('normalizePicture', () => {
	it('keeps a base64 PNG / JPEG / WebP data URL', () => {
		expect(normalizePicture(PNG)).toBe(PNG);
		expect(normalizePicture('data:image/jpeg;base64,/9j/4AAQ')).toBe('data:image/jpeg;base64,/9j/4AAQ');
		expect(normalizePicture('data:image/webp;base64,UklGRg==')).toBe('data:image/webp;base64,UklGRg==');
	});
	it('refuses addresses, SVG, other types and anything over the cap', () => {
		expect(normalizePicture('https://example.com/a.png')).toBeNull();
		expect(normalizePicture('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
		expect(normalizePicture('data:text/html;base64,PGI+')).toBeNull();
		expect(normalizePicture('data:image/png;base64,abc"onerror=x')).toBeNull();
		expect(normalizePicture('data:image/png;base64,' + 'A'.repeat(MAX_PICTURE_CHARS))).toBeNull();
		expect(normalizePicture(42)).toBeNull();
	});
});

describe('note fields', () => {
	it('a note without them is unchanged (no visitors / picture keys)', () => {
		const n = normalizeAnnotation({ id: 'a', text: 'hi' });
		expect('visitors' in n).toBe(false);
		expect('picture' in n).toBe(false);
	});
	it('keeps visitors: true and a valid picture, drops the rest', () => {
		const n = normalizeAnnotation({ id: 'a', visitors: true, picture: PNG });
		expect(n.visitors).toBe(true);
		expect(n.picture).toBe(PNG);
		const bad = normalizeAnnotation({ id: 'b', visitors: 'yes', picture: 'javascript:alert(1)' });
		expect('visitors' in bad).toBe(false);
		expect('picture' in bad).toBe(false);
	});
});

describe('the visitor list', () => {
	const list = [
		{ id: '1', name: 'Engine', text: 'x', visitors: true },
		{ id: '2', name: 'Review: fix this', text: '' },
		{ id: '3', name: '', text: 'First line\nsecond', visitors: true },
		{ id: '4', name: '', text: '', visitors: true }
	];
	it('only notes shown to visitors, in order', () => {
		expect(visitorNotes(list).map((n) => n.id)).toEqual(['1', '3', '4']);
		expect(visitorNotes(/** @type {any} */ (null))).toEqual([]);
	});
	it('titles: the name, else the first line, else a number', () => {
		expect(infoTitle(list[0], 0)).toBe('Engine');
		expect(infoTitle(list[2], 1)).toBe('First line');
		expect(infoTitle(list[3], 2)).toBe('Info point 3');
	});
});
