// @ts-nocheck — a decoder fixture over the encoder's own output (checkJs covers tests/unit)
// 78 PL37 — the local QR encoder. The decode proof (66 strings, levels L/M/Q/H, versions 1-40, read
// back by jsQR outside the repo) lives in the lane's evidence; this pins the structure and one matrix.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { encodeQr, qrSvgPath, dataCodewords, alignmentPositions } from '../../src/lib/qr/qrEncode.js';

const LINK = 'https://theprototype.app/#F0FD3&person&invite=abcdefghijklmnopqrstuv';

/** read the 15 format bits around the top-left finder and undo the mask pattern */
function formatOf(q) {
	let f = 0;
	const at = (x, y) => (q.dark(x, y) ? 1 : 0);
	const order = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
	order.forEach(([x, y], i) => (f |= at(x, y) << i));
	return (f ^ 0x5412) >>> 10;
}

describe('encodeQr', () => {
	it('picks the smallest version that holds the text', () => {
		expect(encodeQr('a', 'M').version).toBe(1);
		expect(encodeQr(LINK, 'M').version).toBe(5);
		expect(encodeQr('x'.repeat(dataCodewords(10, 1) - 3), 'M').version).toBe(10);
		expect(() => encodeQr('x'.repeat(3000), 'M')).toThrow();
	});
	it('draws three finder patterns and the timing lines', () => {
		const q = encodeQr(LINK, 'M');
		for (const [cx, cy] of [[3, 3], [q.size - 4, 3], [3, q.size - 4]]) {
			expect(q.dark(cx, cy)).toBe(true);
			expect(q.dark(cx - 2, cy)).toBe(false);
			expect(q.dark(cx - 3, cy)).toBe(true);
		}
		for (let i = 8; i < q.size - 8; i++) {
			expect(q.dark(6, i)).toBe(i % 2 === 0);
			expect(q.dark(i, 6)).toBe(i % 2 === 0);
		}
	});
	it('writes format bits naming its level and mask', () => {
		for (const [ecc, bits] of [['L', 1], ['M', 0], ['Q', 3], ['H', 2]]) {
			const q = encodeQr(LINK, ecc);
			expect(formatOf(q)).toBe((bits << 3) | q.mask);
		}
	});
	it('places alignment patterns where the standard does', () => {
		expect(alignmentPositions(1)).toEqual([]);
		expect(alignmentPositions(2)).toEqual([6, 18]);
		expect(alignmentPositions(7)).toEqual([6, 22, 38]);
		expect(alignmentPositions(32)).toEqual([6, 34, 60, 86, 112, 138]);
		expect(alignmentPositions(40)).toEqual([6, 30, 58, 86, 114, 142, 170]);
	});
	it('is deterministic (the matrix jsQR read back)', () => {
		const q = encodeQr(LINK, 'M');
		const rows = q.modules.map((r) => r.map((c) => (c ? 1 : 0)).join('')).join('\n');
		expect(createHash('sha256').update(rows).digest('hex')).toBe('40d663c7ae44c76c34adfe26c6f6316e969685c654a17be0e789b83933b2fde0');
	});
	it('draws one path inside the quiet zone', () => {
		const q = encodeQr('a', 'M');
		const d = qrSvgPath(q, 4);
		expect(d.startsWith('M4,4h1v1h-1z')).toBe(true);
		expect(d.match(/M/g)?.length).toBe(q.modules.flat().filter(Boolean).length);
	});
});
