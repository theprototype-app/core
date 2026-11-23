// 102-splats — the pure half of Gaussian splats: the record boundary, the PLY sniff (a mesh .ply is
// not a splat), the reduce-to-fit ladder under the 25 MB cap, decimation order and the device budget.
import { describe, it, expect } from 'vitest';
import {
	normalizeSplat,
	normalizeBox,
	readPlyHeader,
	plyKind,
	spzBytesFor,
	reducePlan,
	decimateOrder,
	splatBudget,
	withinBudget,
	splatCountText,
	SPLAT_CAP_BYTES,
	SPLAT_EXT
} from '../../src/lib/splat/splatCore.js';

const enc = (/** @type {string} */ s) => new TextEncoder().encode(s);

describe('normalizeSplat', () => {
	it('fills defaults and clamps', () => {
		const r = normalizeSplat({ opacity: 3, sh: 9, count: -4, crop: 'x' });
		expect(r.opacity).toBe(1);
		expect(r.sh).toBe(3);
		expect(r.count).toBe(0);
		expect(r.crop).toBe(null);
		expect(r.bounds).toEqual([-1, -1, -1, 1, 1, 1]);
	});
	it('keeps unknown fields (a newer peer)', () => {
		expect(normalizeSplat({ hash: 'h', future: 7 }).future).toBe(7);
	});
	it('orders a box min/max per axis', () => {
		expect(normalizeBox([1, 2, 3, 0, 0, 0])).toEqual([0, 0, 0, 1, 2, 3]);
		expect(normalizeBox([0, 0, 0, 1, 1])).toBe(null);
		expect(normalizeBox([0, 0, 0, 1, 1, NaN])).toBe(null);
	});
});

describe('PLY sniff', () => {
	const gs = 'ply\nformat binary_little_endian 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nproperty float f_dc_0\nproperty float opacity\nproperty float scale_0\nproperty float rot_0\nend_header\n';
	const mesh = 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n';
	const pc = 'ply\nformat binary_little_endian 1.0\nelement chunk 1\nproperty float min_x\nelement vertex 256\nproperty uint packed_position\nproperty uint packed_rotation\nend_header\n';
	it('a 3DGS ply is gaussian', () => expect(plyKind(readPlyHeader(enc(gs)))).toBe('gaussian'));
	it('a mesh ply is mesh (refused as a splat)', () => expect(plyKind(readPlyHeader(enc(mesh)))).toBe('mesh'));
	it('a PlayCanvas compressed ply is gaussian', () => expect(plyKind(readPlyHeader(enc(pc)))).toBe('gaussian'));
	it('not a ply at all', () => {
		expect(readPlyHeader(enc('glTF....'))).toBe(null);
		expect(plyKind(null)).toBe('unknown');
	});
	it('extensions', () => {
		expect(SPLAT_EXT.test('room.PLY')).toBe(true);
		expect(SPLAT_EXT.test('a.spz')).toBe(true);
		expect(SPLAT_EXT.test('a.splat')).toBe(true);
		expect(SPLAT_EXT.test('a.glb')).toBe(false);
	});
});

describe('reduce to fit', () => {
	it('a file under the cap is kept as it is', () => {
		expect(reducePlan({ bytes: 10e6, count: 300_000, sh: 3 })).toMatchObject({ step: 'none', fits: true });
	});
	it('a 3DGS .ply that fits as .spz with its bands converts only', () => {
		// 200 k splats sh3: ply ~ 50 MB, spz ~ 11.7 MB
		const p = reducePlan({ bytes: 50e6, count: 200_000, sh: 3 });
		expect(p.step).toBe('spz');
		expect(p.sh).toBe(3);
		expect(p.keep).toBe(1);
	});
	it('then drops the bands', () => {
		// 1 M splats sh3: spz ~ 58.5 MB with bands, ~18 MB without
		const p = reducePlan({ bytes: 248e6, count: 1_000_000, sh: 3 });
		expect(p).toMatchObject({ step: 'sh', sh: 0, keep: 1, fits: true });
		expect(p.estimate).toBeLessThan(SPLAT_CAP_BYTES);
	});
	it('then decimates, most opaque first', () => {
		const p = reducePlan({ bytes: 500e6, count: 2_000_000, sh: 3 });
		expect(p.step).toBe('decimate');
		expect(p.fits).toBe(true);
		expect(p.keep).toBeGreaterThan(0.5);
		expect(p.keep).toBeLessThan(1);
		expect(spzBytesFor(2_000_000 * p.keep, 0)).toBeLessThan(SPLAT_CAP_BYTES);
	});
	it('refuses when it would keep too little', () => {
		const p = reducePlan({ bytes: 900e6, count: 9_000_000, sh: 0 });
		expect(p.fits).toBe(false);
		expect(p.why).toMatch(/25 MB/);
	});
	it('decimateOrder keeps the most opaque, deterministic, ascending', () => {
		const kept = decimateOrder([0.1, 0.9, 0.5, 0.9, 0.2], 0.6);
		expect(Array.from(kept)).toEqual([1, 2, 3]);
		expect(decimateOrder([0.5, 0.5], 0.01).length).toBe(1);
	});
});

describe('device budget', () => {
	it('quest and phone have budgets, the PC none', () => {
		expect(splatBudget('quest')).toBe(1_000_000);
		expect(splatBudget('phone')).toBe(2_000_000);
		expect(splatBudget('pc')).toBe(Infinity);
	});
	it('whole objects stand down in scene order', () => {
		const r = withinBudget(
			[
				{ uuid: 'a', count: 600_000 },
				{ uuid: 'b', count: 600_000 },
				{ uuid: 'c', count: 300_000 }
			],
			1_000_000
		);
		expect([...r.shown]).toEqual(['a', 'c']);
		expect(r.hidden).toEqual(['b']);
		expect(r.total).toBe(900_000);
	});
	it('count text', () => {
		expect(splatCountText(1_234_567)).toBe('1.2 M splats');
		expect(splatCountText(840_000)).toBe('840 k splats');
		expect(splatCountText(1)).toBe('1 splat');
	});
});
