// @ts-nocheck — plain arrays stand in for geometry
import { describe, it, expect } from 'vitest';
import {
	CHANNELS,
	accumulate,
	pressureEffect,
	pressureModeOf,
	PRESSURE_MODES,
	channelOf,
	normalizeBrush,
	isDefaultBrush,
	brushWire,
	brushFromWire,
	paintStyle,
	grayHex,
	falloff,
	falloffStops,
	dabsAlong,
	triFrame,
	dabOnTri,
	planeToUv,
	planeToCanvas,
	uvToCanvas,
	padTri,
	texelDensity,
	buildTriGrid,
	trisNear,
	uvOverlap,
	paintTarget,
	vertexDab,
	blendVertexColors,
	mirrorX,
	onMirrorPlane,
	hashBytes
} from '../../src/lib/meshPaintCore.js';

// 102 M6: the pure half of painting on meshes.

describe('channels and brush', () => {
	it('names four channels, colour first', () => {
		expect(CHANNELS.map((c) => c.key)).toEqual(['color', 'roughness', 'metalness', 'emissive']);
		expect(channelOf('nope').key).toBe('color');
		expect(channelOf('roughness').map).toBe('roughnessMap');
	});
	it('clamps a hostile brush', () => {
		const b = normalizeBrush({ hardness: -3, opacity: 9, flow: 0, erase: 'yes', mirror: true, stamp: '<script>' });
		expect(b).toEqual({ hardness: 0, opacity: 1, flow: 0.01, erase: false, mirror: true, stamp: '' });
	});
	it('a default brush sends nothing and round-trips', () => {
		expect(brushWire({})).toEqual({});
		expect(isDefaultBrush({})).toBe(true);
		const b = { hardness: 0.25, opacity: 0.5, flow: 0.3, erase: true, mirror: true, stamp: 'abc123' };
		expect(isDefaultBrush(b)).toBe(false);
		expect(brushFromWire(brushWire(b))).toEqual(b);
	});
	it('the eraser paints the value that hides the map', () => {
		expect(paintStyle('color', '#FF0000', 0, false)).toBe('#ff0000');
		expect(paintStyle('color', '#ff0000', 0, true)).toBe('#ffffff');
		expect(paintStyle('roughness', '#ff0000', 0.5, false)).toBe(grayHex(0.5));
		expect(paintStyle('metalness', '#ff0000', 0, true)).toBe('#ffffff');
		expect(paintStyle('emissive', '#00ff00', 0, true)).toBe('#000000');
		expect(paintStyle('color', 'red', 0, false)).toBe('#ffffff');
	});
});

describe('falloff', () => {
	it('hardness 1 is the shipped hard edge', () => {
		expect(falloff(0, 1)).toBe(1);
		expect(falloff(0.999, 1)).toBe(1);
		expect(falloff(1.01, 1)).toBe(0);
		expect(falloffStops(1)).toEqual([[0, 1], [1, 1]]);
	});
	it('soft brushes fall smoothly to zero at the rim', () => {
		expect(falloff(0.2, 0.3)).toBe(1);
		expect(falloff(1, 0.3)).toBeCloseTo(0, 6);
		const mid = falloff(0.65, 0.3);
		expect(mid).toBeGreaterThan(0.3);
		expect(mid).toBeLessThan(0.7);
		const stops = falloffStops(0);
		for (let i = 1; i < stops.length; i++) expect(stops[i][1]).toBeLessThanOrEqual(stops[i - 1][1]);
	});
});

describe('dabsAlong', () => {
	it('spaces dabs evenly across many short segments', () => {
		const pts = [];
		for (let i = 0; i <= 20; i++) pts.push([i * 0.5, 0, 1]);
		let carry = 1; // step 1: the first point is a dab
		const all = [];
		for (let i = 1; i < pts.length; i++) {
			const r = dabsAlong(pts[i - 1], pts[i], 2, 1, carry);
			all.push(...r.dabs);
			carry = r.carry;
		}
		const xs = all.map((d) => Math.round(d[0] * 1000) / 1000);
		expect(xs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	});
	it('interpolates pressure and is deterministic', () => {
		const a = dabsAlong([0, 0, 0, 0], [0, 0, 4, 1], 3, 1, 1);
		expect(a.dabs.map((d) => d[3])).toEqual([0, 0.25, 0.5, 0.75, 1]);
		expect(dabsAlong([0, 0, 0, 0], [0, 0, 4, 1], 3, 1, 1)).toEqual(a);
	});
});

describe('the triangle frame', () => {
	// a right triangle in the XY plane, 2 x 2, laid out on the UV square's lower-left half
	const p = [[0, 0, 0], [2, 0, 0], [0, 2, 0]];
	const uv = [[0, 0], [1, 0], [0, 1]];
	const f = triFrame(p[0], p[1], p[2], uv[0], uv[1], uv[2]);
	it('maps every corner to its UV', () => {
		for (let i = 0; i < 3; i++) {
			const back = planeToUv(f, f.q[i]);
			expect(back[0]).toBeCloseTo(uv[i][0], 9);
			expect(back[1]).toBeCloseTo(uv[i][1], 9);
		}
	});
	it('cuts a dab sphere to the right circle', () => {
		const hit = dabOnTri(f, [0.5, 0.5, 0.3], 0.5);
		expect(hit.r).toBeCloseTo(0.4, 9);
		expect(planeToUv(f, hit.qc)[0]).toBeCloseTo(0.25, 9);
		expect(dabOnTri(f, [0.5, 0.5, 0.6], 0.5)).toBeNull(); // misses the plane
		expect(dabOnTri(f, [9, 9, 0], 0.5)).toBeNull(); // far from the triangle
	});
	it('the canvas transform agrees with uvToCanvas, both flips', () => {
		for (const flip of [true, false]) {
			const [a, b, c, d, e, g] = planeToCanvas(f, 512, 256, flip);
			const q = [1, 0.5];
			const viaT = [a * q[0] + c * q[1] + e, b * q[0] + d * q[1] + g];
			const direct = uvToCanvas(planeToUv(f, q), 512, 256, flip);
			expect(viaT[0]).toBeCloseTo(direct[0], 9);
			expect(viaT[1]).toBeCloseTo(direct[1], 9);
		}
	});
	it('reports texel density and refuses degenerate triangles', () => {
		expect(texelDensity(f, 1024, 1024)).toBeCloseTo(512, 6); // 2 units span 1024 px
		expect(triFrame([0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 0], [1, 0], [0, 1])).toBeNull();
		expect(triFrame(p[0], p[1], p[2], [0, 0], [0, 0], [0, 0])).toBeNull();
	});
	it('pads a triangle outward, and caps a sliver', () => {
		const t = [[0, 0], [10, 0], [0, 10]];
		const g = padTri(t, 2);
		expect(g[0][0]).toBeLessThan(0);
		expect(g[1][0]).toBeGreaterThan(10);
		const sliver = padTri([[0, 0], [100, 0], [50, 0.01]], 2);
		expect(Math.abs(sliver[1][0] - 50)).toBeLessThanOrEqual(50 * 4 + 1e-6);
	});
});

describe('the triangle grid', () => {
	it('finds the triangles near a point, in ascending order', () => {
		const soup = [];
		for (let i = 0; i < 10; i++) soup.push(i, 0, 0, i + 0.5, 0, 0, i, 0.5, 0);
		const grid = buildTriGrid(soup, 1);
		expect(trisNear(grid, [3.2, 0.1, 0], 0.4)).toEqual([2, 3]);
		expect(trisNear(grid, [50, 0, 0], 0.4)).toEqual([]);
	});
});

describe('uv overlap', () => {
	it('a clean layout is not overlapping, a stacked one is', () => {
		const clean = [0, 0, 0.5, 0, 0, 0.5, 0.5, 0.5, 1, 0.5, 0.5, 1];
		expect(uvOverlap(clean).ratio).toBe(0);
		const stacked = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
		expect(uvOverlap(stacked).ratio).toBe(1);
		expect(uvOverlap([0, 0, 0, 0, 0, 0]).empty).toBe(true);
	});
	it('says where a stroke goes and why', () => {
		expect(paintTarget({ hasUvs: false }).mode).toBe('vertex');
		expect(paintTarget({ hasUvs: true, overlap: { ratio: 0.5, empty: false } }).reason).toMatch(/share the same place/);
		expect(paintTarget({ hasUvs: true, overlap: { ratio: 0, empty: false } })).toEqual({ mode: 'map', reason: '' });
	});
});

describe('vertex colours', () => {
	const positions = new Float32Array([0, 0, 0, 0.5, 0, 0, 1, 0, 0, 3, 0, 0]);
	it('a dab raises the stroke layer with falloff, nothing past the radius', () => {
		const acc = new Float32Array(4);
		const touched = vertexDab(positions, [0, 0, 0], 1, 0, 1, acc);
		expect(touched).toEqual([0, 1]); // the vertex ON the rim gets zero
		expect(acc[0]).toBe(1);
		expect(acc[1]).toBeGreaterThan(0);
		expect(acc[1]).toBeLessThan(1);
		expect(acc[3]).toBe(0);
	});
	it('opacity caps the stroke however many dabs land', () => {
		const acc = new Float32Array(4);
		for (let i = 0; i < 50; i++) vertexDab(positions, [0, 0, 0], 1, 1, 0.3, acc);
		const base = new Float32Array(12).fill(1);
		const out = new Float32Array(base);
		blendVertexColors(base, [0, 0, 0], acc, 0.4, out, [0]);
		expect(out[0]).toBeCloseTo(0.6, 4);
	});
	it('a stroke replayed gives the same bytes', () => {
		const run = () => {
			const acc = new Float32Array(4);
			const out = new Float32Array(12).fill(1);
			for (const c of [[0, 0, 0], [0.3, 0, 0], [0.6, 0, 0]]) {
				const t = vertexDab(positions, c, 0.6, 0.5, 0.7, acc);
				blendVertexColors(new Float32Array(12).fill(1), [1, 0, 0], acc, 0.9, out, t);
			}
			return hashBytes(new Uint8Array(out.buffer));
		};
		expect(run()).toBe(run());
	});
	it('a dab between the corners of a low-poly face paints the nearest corners that face it', () => {
		// the +z face of a unit box (4 corners) plus the SAME corner positions of the +x face, which faces away
		const P = new Float32Array([-0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5]);
		const N = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0]);
		const acc = new Float32Array(6);
		// no corner within r: before the fallback this touched nothing. With no normals the +x copies count too
		expect(vertexDab(P, [0, 0, 0.5], 0.3, 1, 0.8, new Float32Array(6))).toEqual([0, 1, 2, 3, 4, 5]);
		expect(vertexDab(P, [0, 0, 0.5], 0.3, 1, 0.8, new Float32Array(6), { normals: N, n: [0, 0, 1] })).toEqual([0, 1, 2, 3]);
		const touched = vertexDab(P, [0.2, 0, 0.5], 0.3, 1, 0.8, acc, { normals: N, n: [0, 0, 1] });
		expect(touched).toEqual([1, 2]); // the two right corners of the +z face, not the +x face's copies
		expect(acc[1]).toBeCloseTo(0.8, 6);
		expect(acc[4]).toBe(0);
		// a dab that reaches a vertex keeps the ordinary falloff path
		expect(vertexDab(P, [0.45, 0.45, 0.5], 0.3, 1, 1, new Float32Array(6), { normals: N, n: [0, 0, 1] })).toEqual([2, 5]);
		// zero flow paints nothing at all
		expect(vertexDab(P, [0, 0, 0.5], 0.3, 1, 0, new Float32Array(6))).toEqual([]);
	});
	it('mirror X flips the point and knows the plane', () => {
		expect(mirrorX([1, 2, 3, 0.5])).toEqual([-1, 2, 3, 0.5]);
		expect(onMirrorPlane([0.001, 0, 0], 1)).toBe(true);
		expect(onMirrorPlane([0.3, 0, 0], 1)).toBe(false);
	});
});

import { CHANNEL_KEYS, validMeshPaint, quantizePoint, MAX_SEG_POINTS } from '../../src/lib/meshPaintWire.js';

describe('the live stroke wire', () => {
	const good = { type: 'meshpaint', id: 'p:m1', uuid: 'u-1', sp: 'obj', c: '#ff0000', r: 0.05, seg: [[0, 1, 2], [0.1, 1, 2, 0.5]] };
	it('the wire leaf names the same channels as the core', () => {
		expect([...CHANNEL_KEYS]).toEqual(CHANNELS.map((c) => c.key));
	});
	it('accepts a well-formed stroke and refuses bad ones', () => {
		expect(validMeshPaint(good)).toBe(true);
		expect(validMeshPaint({ ...good, sp: 'uv', seg: [[0.1, 0.2]] })).toBe(true);
		expect(validMeshPaint({ ...good, ch: 'metalness', b: { h: 0.5 }, n: [0, 1, 0], slot: 2 })).toBe(true);
		expect(validMeshPaint({ ...good, sp: 'uv' })).toBe(false); // 3D points on a UV stroke
		expect(validMeshPaint({ ...good, seg: [[NaN, 0, 0]] })).toBe(false);
		expect(validMeshPaint({ ...good, c: 'red' })).toBe(false);
		expect(validMeshPaint({ ...good, r: -1 })).toBe(false);
		expect(validMeshPaint({ ...good, ch: 'normal' })).toBe(false);
		expect(validMeshPaint({ ...good, seg: new Array(MAX_SEG_POINTS + 1).fill([0, 0, 0]) })).toBe(false);
		expect(validMeshPaint({ ...good, b: [1] })).toBe(false);
	});
	it('rounds points, drops full pressure', () => {
		expect(quantizePoint([0.1234567, 2, 3, 1], 3)).toEqual([0.12346, 2, 3]);
		expect(quantizePoint([0.5, 0.5, 0.33333], 2)).toEqual([0.5, 0.5, 0.333]);
	});
});

// 103 H1: pressure opacity is a CEILING per dab (max, not sum). The 102 rule multiplied the pressure into the flow,
// so twenty overlapping dabs at a light touch summed to nearly opaque — the owner's N6 report.
describe('103 H1: the stroke layer pixel rule', () => {
	it('q = 1 is the 102 source-over build-up exactly', () => {
		for (const [L, a] of [[0, 1], [0, 0.3], [0.4, 0.5], [0.99, 0.2], [1, 1]]) expect(accumulate(L, a)).toBeCloseTo(L + a * (1 - L), 12);
	});
	it('overlapping dabs of one pressure stop at that pressure', () => {
		let L = 0;
		for (let i = 0; i < 40; i++) L = accumulate(L, 1, 0.3);
		expect(L).toBeCloseTo(0.3, 12);
		let soft = 0;
		for (let i = 0; i < 400; i++) soft = accumulate(soft, 0.2, 0.3);
		expect(soft).toBeLessThanOrEqual(0.3 + 1e-12);
		expect(soft).toBeGreaterThan(0.29);
	});
	it('the counterfactual: the 102 rule (pressure inside the flow) stacks to opaque', () => {
		let old = 0;
		for (let i = 0; i < 20; i++) old = accumulate(old, 0.3); // a = flow * factor, q = 1
		expect(old).toBeGreaterThan(0.99);
	});
	it('a lighter dab over a darker spot adds nothing; a darker one raises it', () => {
		expect(accumulate(0.8, 1, 0.3)).toBe(0.8);
		expect(accumulate(0.3, 1, 0.8)).toBeCloseTo(0.8, 12);
	});
	it('pressure modes: size, opacity, both, off; unknown reads as size', () => {
		expect(pressureEffect('size', 0.4)).toEqual({ size: 0.4, ceil: 1 });
		expect(pressureEffect('opacity', 0.4)).toEqual({ size: 1, ceil: 0.4 });
		expect(pressureEffect('both', 0.4)).toEqual({ size: 0.4, ceil: 0.4 });
		expect(pressureEffect('off', 0.4)).toEqual({ size: 1, ceil: 1 });
		expect(pressureModeOf('curve')).toBe('size');
		expect(pressureModeOf(undefined)).toBe('size');
		expect(PRESSURE_MODES).toEqual(['size', 'opacity', 'both', 'off']);
	});
	it('vertex colours take the same ceiling', () => {
		const positions = new Float32Array([0, 0, 0, 3, 0, 0]);
		const acc = new Float32Array(2);
		for (let i = 0; i < 30; i++) vertexDab(positions, [0, 0, 0], 1, 1, 1, acc, undefined, 0.25);
		expect(acc[0]).toBeCloseTo(0.25, 12);
	});
});
