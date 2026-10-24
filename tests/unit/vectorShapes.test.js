// @ts-nocheck — a fixture test: records and results are asserted non-null by the checks themselves
// 64 D1/D3: the vector shapes' pure half — path math, strokes, booleans, offsets, the mesh
// builder and the SVG round trip. Areas are the property that matters (a boolean that is off by
// one ring is off by an area), so most checks measure one against the closed-form answer.
import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import {
	rectPath,
	ellipsePath,
	starPath,
	polygonPath,
	flattenSubpath,
	insertNodeAt,
	convertNode,
	moveHandle,
	nearestOnSubpath,
	deleteNode,
	ringsToPolygons,
	segmentControls,
	cubicAt,
	segmentPairs
} from '../../src/lib/vector/vectorPath.js';
import { strokePieces, dashPolyline, strokeAll } from '../../src/lib/vector/vectorStroke.js';
import { cleanVector, vectorDefaults, fillColourAt, MAX_NODES } from '../../src/lib/vector/vectorRecord.js';
import { buildVectorGeometry, vectorPolylines } from '../../src/lib/vector/vectorMesh.js';
import { vectorWireElement, rebuildVectorFromRecord, WIRE_FLOAT_CAP } from '../../src/lib/vector/vectorWire.js';
import { booleanShapes, outlineStroke, offsetShape, multiArea, recordArea, strokeArea, transformPolygons } from '../../src/lib/vector/vectorBoolean.js';
import { writeSvg, readOwnSvg, pathData, arcToCubics, subpathFromCurves, importSvg } from '../../src/lib/vector/vectorSvg.js';

const near = (a, b, tol) => Math.abs(a - b) <= tol;
const rect = (w, h, extra = {}) => cleanVector({ ...vectorDefaults('rect'), width: w, height: h, ...extra });

describe('primitives', () => {
	test('a sharp rect is four corners, a rounded one eight nodes with the right area', () => {
		expect(rectPath(2, 1, 0)[0].nodes.length).toBe(4);
		expect(rectPath(2, 1, 0.2)[0].nodes.length).toBe(8);
		const r = 0.2;
		const area = recordArea(rect(2, 1, { corner: r }));
		expect(near(area, 2 - (4 - Math.PI) * r * r, 0.002)).toBe(true);
	});
	test('corner radius clamps to half the short side (a pill, never a self-crossing shape)', () => {
		const pill = recordArea(rect(2, 1, { corner: 5 }));
		expect(near(pill, 2 - (4 - Math.PI) * 0.25, 0.004)).toBe(true);
	});
	test('an ellipse is four cubic quarters within 0.1% of pi a b', () => {
		const area = recordArea(cleanVector({ ...vectorDefaults('ellipse'), width: 3, height: 1 }));
		expect(Math.abs(area / (Math.PI * 1.5 * 0.5) - 1)).toBeLessThan(0.001);
	});
	test('star and polygon: vertex counts, a hexagon area, a rounded star still closes', () => {
		expect(starPath(5, 1, 0.5, 0)[0].nodes.length).toBe(10);
		expect(polygonPath(6, 1, 0)[0].nodes.length).toBe(6);
		const hex = recordArea(cleanVector({ ...vectorDefaults('polygon'), points: 6, radius: 1 }));
		expect(near(hex, (3 * Math.sqrt(3)) / 2, 1e-6)).toBe(true);
		const rounded = starPath(5, 1, 0.45, 0.08)[0];
		expect(rounded.nodes.length).toBe(20);
		expect(rounded.closed).toBe(true);
		// the first vertex points straight up
		expect(near(starPath(5, 1, 0.5, 0)[0].nodes[0].y, 1, 1e-9)).toBe(true);
	});
});

describe('pen editing', () => {
	const curve = { closed: false, nodes: [{ x: 0, y: 0, ix: 0, iy: 0, ox: 0.5, oy: 1, smooth: false }, { x: 2, y: 0, ix: -0.5, iy: 1, ox: 0, oy: 0, smooth: false }] };
	test('inserting a point keeps the curve EXACTLY (de Casteljau)', () => {
		const before = flattenSubpath(curve, 0.001);
		const split = insertNodeAt(curve, 0, 0.3);
		expect(split.nodes.length).toBe(3);
		expect(split.nodes[1].smooth).toBe(true);
		// every point of the split path lies on the original curve
		const c = segmentControls(curve.nodes[0], curve.nodes[1]);
		for (const [i, j] of segmentPairs(split)) {
			const cc = segmentControls(split.nodes[i], split.nodes[j]);
			for (const t of [0.25, 0.5, 0.75]) {
				const p = cubicAt(cc, t);
				let best = Infinity;
				for (let k = 0; k <= 2000; k++) {
					const q = cubicAt(c, k / 2000);
					best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
				}
				expect(best).toBeLessThan(2e-3);
			}
		}
		expect(before.length).toBeGreaterThan(4);
	});
	test('a line splits into two lines at the point', () => {
		const line = { closed: false, nodes: [{ x: 0, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 }, { x: 2, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 }] };
		const s = insertNodeAt(line, 0, 0.25);
		expect(s.nodes.map((n) => n.x)).toEqual([0, 0.5, 2]);
	});
	test('nearestOnSubpath finds the segment and t of a click on the curve', () => {
		const c = segmentControls(curve.nodes[0], curve.nodes[1]);
		const p = cubicAt(c, 0.62);
		const hit = nearestOnSubpath(curve, [p[0] + 0.001, p[1]]);
		expect(hit.seg).toBe(0);
		expect(near(hit.t, 0.62, 0.01)).toBe(true);
		expect(hit.dist).toBeLessThan(0.002);
	});
	test('convert: corner -> smooth gets collinear handles, smooth -> corner loses them', () => {
		const tri = { closed: true, nodes: [{ x: 0, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 }, { x: 1, y: 1, ix: 0, iy: 0, ox: 0, oy: 0 }, { x: 2, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 }] };
		const s = convertNode(tri, 1, true).nodes[1];
		expect(s.smooth).toBe(true);
		expect(near(s.ix * s.oy - s.iy * s.ox, 0, 1e-12)).toBe(true); // collinear
		expect(s.ix * s.ox + s.iy * s.oy).toBeLessThan(0); // opposite
		const back = convertNode(convertNode(tri, 1, true), 1, false).nodes[1];
		expect([back.ix, back.iy, back.ox, back.oy]).toEqual([0, 0, 0, 0]);
	});
	test('dragging one handle of a smooth node keeps the other collinear; mirror copies the length; Alt breaks it', () => {
		const sm = { closed: false, nodes: [{ x: 0, y: 0, ix: -1, iy: 0, ox: 2, oy: 0, smooth: true }, { x: 3, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 }] };
		const a = moveHandle(sm, 0, 'out', [0, 1]).nodes[0];
		expect([a.ix, a.iy].map((v) => +v.toFixed(9))).toEqual([0, -1]); // its own length 1, opposite direction
		const b = moveHandle(sm, 0, 'out', [0, 3], { mirror: true }).nodes[0];
		expect([b.ix, b.iy].map((v) => +v.toFixed(9))).toEqual([0, -3]);
		const c = moveHandle(sm, 0, 'out', [0, 3], { free: true }).nodes[0];
		expect([c.ix, c.iy, c.smooth]).toEqual([-1, 0, false]);
	});
	test('deleting keeps at least two nodes and opens a path that drops below three', () => {
		const tri = { closed: true, nodes: [{ x: 0, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 }, { x: 1, y: 1, ix: 0, iy: 0, ox: 0, oy: 0 }, { x: 2, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 }] };
		const d = deleteNode(tri, 1);
		expect(d.nodes.length).toBe(2);
		expect(d.closed).toBe(false);
		expect(deleteNode(d, 0).nodes.length).toBe(2);
	});
});

describe('fill rings', () => {
	test('a ring inside a ring is a hole; a ring inside the hole is an island', () => {
		const sq = (s) => [[-s, -s], [s, -s], [s, s], [-s, s]];
		const polys = ringsToPolygons([sq(3), sq(2), sq(1)]);
		expect(polys.length).toBe(2);
		expect(polys[0].length).toBe(2); // outer + hole
		expect(near(multiArea(polys), 36 - 16 + 4, 1e-9)).toBe(true);
	});
});

describe('strokes', () => {
	test('a butt-capped line covers length x width; square adds a half width each end; round adds a disc', () => {
		const line = cleanVector({ kind: 'path', paths: [{ closed: false, nodes: [{ x: 0, y: 0 }, { x: 2, y: 0 }] }], strokeWidth: 0.2, fillType: 'none' });
		expect(near(multiArea(strokeArea(line)), 0.4, 1e-6)).toBe(true);
		expect(near(multiArea(strokeArea({ ...line, cap: 'square' })), 0.44, 1e-6)).toBe(true);
		expect(near(multiArea(strokeArea({ ...line, cap: 'round' })), 0.4 + Math.PI * 0.01, 0.002)).toBe(true);
	});
	test('a closed square stroke: miter corners are exact, bevel cuts the four corners', () => {
		const sq = rect(2, 2, { strokeWidth: 0.2, fillType: 'none' });
		expect(near(multiArea(strokeArea(sq)), 2.2 * 2.2 - 1.8 * 1.8, 1e-6)).toBe(true);
		const bevel = multiArea(strokeArea({ ...sq, join: 'bevel' }));
		expect(near(bevel, 2.2 * 2.2 - 1.8 * 1.8 - 4 * 0.5 * 0.1 * 0.1, 1e-6)).toBe(true);
	});
	test('a sharp turn past the miter limit falls back to a bevel', () => {
		const pts = [[0, 0], [1, 0], [0, 0.05]];
		const miter = strokePieces(pts, false, { width: 0.1, join: 'miter', miterLimit: 4 });
		const tip = Math.max(...miter.flat().map((p) => p[0]));
		expect(tip).toBeLessThan(1.2); // no 20x spike
	});
	test('dashes split the line by arc length', () => {
		const dashes = dashPolyline([[0, 0], [1, 0]], false, 0.2, 0.1);
		expect(dashes.length).toBe(4); // 0-.2 .3-.5 .6-.8 .9-1
		expect(near(dashes[3][1][0] - dashes[3][0][0], 0.1, 1e-9)).toBe(true);
		const closed = dashPolyline([[0, 0], [1, 0], [1, 1], [0, 1]], true, 0.5, 0.5);
		expect(closed.length).toBe(4);
		expect(strokeAll([{ pts: [[0, 0], [1, 0]], closed: false }], { width: 0.1, dash: 0.2, gap: 0.1 }).length).toBe(4);
	});
});

describe('booleans (D3)', () => {
	// two unit squares, the second shifted half a unit right
	const a = rect(1, 1);
	const shifted = [1, 0, 0, 1, 0.5, 0];
	const run = (op) => booleanShapes(op, [{ params: a }, { params: a, matrix: shifted }]);
	test('union / subtract / intersect / exclude give 1.5 / 0.5 / 0.5 / 1.0', () => {
		expect(near(recordArea(run('union').params), 1.5, 1e-6)).toBe(true);
		expect(near(recordArea(run('subtract').params), 0.5, 1e-6)).toBe(true);
		expect(near(recordArea(run('intersect').params), 0.5, 1e-6)).toBe(true);
		expect(near(recordArea(run('exclude').params), 1.0, 1e-6)).toBe(true);
	});
	test('the result is a path styled like the first shape, re-centred with the offset returned', () => {
		const u = run('union');
		expect(u.params.kind).toBe('path');
		expect(u.params.fill).toBe(a.fill);
		expect(near(u.cx, 0.25, 1e-9)).toBe(true);
		expect(u.params.paths[0].nodes.length).toBe(4); // collinear points dropped
	});
	test('subtracting a smaller centred square leaves a hole (two rings, even-odd area)', () => {
		const small = rect(0.5, 0.5);
		const r = booleanShapes('subtract', [{ params: rect(1, 1) }, { params: small }]);
		expect(r.params.paths.length).toBe(2);
		expect(near(recordArea(r.params), 0.75, 1e-6)).toBe(true);
	});
	test('disjoint intersect is empty (null), curves come back flattened', () => {
		expect(booleanShapes('intersect', [{ params: a }, { params: a, matrix: [1, 0, 0, 1, 5, 0] }])).toBeNull();
		const circle = cleanVector({ ...vectorDefaults('ellipse'), width: 1, height: 1 });
		const r = booleanShapes('union', [{ params: circle }, { params: a, matrix: shifted }]);
		expect(r.params.paths[0].nodes.length).toBeGreaterThan(20);
	});
	test('transformPolygons applies the affine', () => {
		expect(transformPolygons([[[[1, 0]]]], [0, 1, -1, 0, 2, 0])[0][0][0]).toEqual([2, 1]); // 90 degrees + shift
	});
});

describe('outline and offset (D3)', () => {
	test('stroke-to-outline: the stroke becomes a filled shape of the stroke colour, with the hole', () => {
		const r = outlineStroke(rect(2, 2, { strokeWidth: 0.2, stroke: '#ff0000' }));
		expect(r.params.fill).toBe('#ff0000');
		expect(r.params.strokeWidth).toBe(0);
		expect(r.params.paths.length).toBe(2);
		expect(near(recordArea(r.params), 2.2 * 2.2 - 1.8 * 1.8, 1e-6)).toBe(true);
		expect(outlineStroke(rect(1, 1))).toBeNull();
	});
	test('outset by d with round joins = area + perimeter d + pi d^2; miter = (w+2d)^2', () => {
		const d = 0.1;
		const round = offsetShape(rect(1, 1, { join: 'round' }), d);
		expect(near(recordArea(round.params), 1 + 4 * d + Math.PI * d * d, 0.002)).toBe(true);
		const miter = offsetShape(rect(1, 1), d);
		expect(near(recordArea(miter.params), 1.2 * 1.2, 1e-6)).toBe(true);
	});
	test('inset shrinks, and an inset past the middle is empty', () => {
		expect(near(recordArea(offsetShape(rect(1, 1), -0.1).params), 0.64, 1e-6)).toBe(true);
		expect(offsetShape(rect(1, 1), -0.6)).toBeNull();
	});
});

describe('mesh builder', () => {
	test('flat: position + colour + uv, a solid fill is one colour, the stroke sits in front and behind', () => {
		const g = buildVectorGeometry(rect(1, 1, { strokeWidth: 0.05, fill: '#ff0000', stroke: '#0000ff' }));
		expect(g.attributes.position.count).toBeGreaterThan(6);
		expect(g.attributes.color.count).toBe(g.attributes.position.count);
		expect(g.attributes.uv).toBeDefined();
		g.computeBoundingBox();
		expect(g.boundingBox.max.z).toBeGreaterThan(0);
		expect(g.boundingBox.min.z).toBeLessThan(0);
		expect(near(g.boundingBox.max.x, 0.525, 1e-6)).toBe(true); // half the stroke outside
	});
	test('extruded: the solid spans z 0..depth', () => {
		const g = buildVectorGeometry(rect(1, 1, { depth: 0.3 }));
		g.computeBoundingBox();
		expect(near(g.boundingBox.min.z, 0, 1e-6)).toBe(true);
		expect(near(g.boundingBox.max.z, 0.3, 1e-6)).toBe(true);
	});
	test('gradients colour per vertex: linear left->right, radial centre->edge', () => {
		const lin = cleanVector({ ...rect(1, 1), fillType: 'linear', fill: '#000000', fill2: '#ffffff' });
		expect(fillColourAt(lin, 0, 0.5)[0]).toBeCloseTo(0, 6);
		expect(fillColourAt(lin, 1, 0.5)[0]).toBeCloseTo(1, 6);
		expect(fillColourAt({ ...lin, gradAngle: 90 }, 0.5, 1)[0]).toBeCloseTo(1, 6);
		const rad = { ...lin, fillType: 'radial' };
		expect(fillColourAt(rad, 0.5, 0.5)[0]).toBeCloseTo(0, 6);
		expect(fillColourAt(rad, 1, 0.5)[0]).toBeCloseTo(1, 6);
		const g = buildVectorGeometry(rad);
		const c = g.attributes.color;
		let lo = 1;
		let hi = 0;
		for (let i = 0; i < c.count; i++) {
			lo = Math.min(lo, c.getX(i));
			hi = Math.max(hi, c.getX(i));
		}
		expect(hi - lo).toBeGreaterThan(0.3);
		// refined: far more than the 2 triangles of a bare rect
		expect(g.attributes.position.count).toBeGreaterThan(100);
	});
	test('nothing to draw = an empty geometry, never null', () => {
		const g = buildVectorGeometry({ ...rect(1, 1), fillType: 'none', strokeWidth: 0 });
		expect(g).toBeInstanceOf(THREE.BufferGeometry);
		expect(g.attributes.position).toBeUndefined();
	});
	test('an open pen path is stroked, not filled, by default', () => {
		const pen = cleanVector({ kind: 'path', paths: [{ closed: false, nodes: [{ x: 0, y: 0 }, { x: 1, y: 0.5 }, { x: 2, y: 0 }] }] });
		expect(pen.fillType).toBe('none');
		expect(pen.strokeWidth).toBeGreaterThan(0);
		expect(buildVectorGeometry(pen).attributes.position.count).toBeGreaterThan(0);
	});
});

describe('the record boundary', () => {
	test('unknown kinds, bad colours, out-of-range numbers and junk keys are cleaned', () => {
		const c = cleanVector({ kind: 'blob', width: -5, fill: 'red', points: 999, evil: 1 });
		expect(c.kind).toBe('rect');
		expect(c.width).toBe(0.01);
		expect(c.fill).toBe('#4f8cff');
		expect(c.points).toBe(64);
		expect(c.evil).toBeUndefined();
	});
	test('a hostile path is capped at MAX_NODES', () => {
		const nodes = Array.from({ length: MAX_NODES + 500 }, (_, i) => ({ x: i * 0.001, y: 0 }));
		const c = cleanVector({ kind: 'path', paths: [{ closed: false, nodes }] });
		expect(c.paths[0].nodes.length).toBe(MAX_NODES);
	});
	test('cleaning is idempotent (what travels is what rebuilds)', () => {
		const once = cleanVector({ ...vectorDefaults('star'), corner: 0.1, fillType: 'radial' });
		expect(cleanVector(once)).toEqual(once);
	});
});

describe('SVG', () => {
	test('our own file round-trips every record and transform IDENTICALLY', () => {
		const items = [
			{ params: rect(2, 1, { corner: 0.2, strokeWidth: 0.05, dash: 0.1, gap: 0.05 }), matrix: [1, 0, 0, 1, 0, 0] },
			{ params: cleanVector({ ...vectorDefaults('star'), corner: 0.05, fillType: 'linear', gradAngle: 30 }), matrix: [0, 1, -1, 0, 3, -1] },
			{ params: cleanVector({ ...vectorDefaults('ellipse'), fillType: 'radial', gradX: 0.3 }), matrix: [2, 0, 0, 2, -2, 1] },
			{ params: cleanVector({ kind: 'path', paths: [{ closed: false, nodes: [{ x: 0, y: 0, ox: 0.3, oy: 0.4, smooth: true }, { x: 1, y: 0, ix: -0.2, iy: 0.4 }] }] }), matrix: [1, 0, 0, 1, 0, 2] }
		];
		const text = writeSvg(items);
		expect(text.startsWith('<svg')).toBe(true);
		expect(text).toContain('linearGradient');
		expect(text).toContain('radialGradient');
		expect(text).toContain('stroke-dasharray');
		const back = readOwnSvg(text);
		expect(back.length).toBe(4);
		back.forEach((b, i) => {
			expect(b.params).toEqual(items[i].params);
			b.matrix.forEach((v, k) => expect(near(v, items[i].matrix[k], 1e-4)).toBe(true));
		});
		// and the geometry built from it is the same, vertex for vertex
		const g0 = buildVectorGeometry(items[1].params);
		const g1 = buildVectorGeometry(back[1].params);
		expect(Array.from(g1.attributes.position.array)).toEqual(Array.from(g0.attributes.position.array));
		expect(importSvg(text).length).toBe(4);
	});
	test('path data: y flipped, metres x100, cubic C for curves, Z for closed', () => {
		expect(pathData(rect(2, 1))).toBe('M-100 50 L100 50 L100 -50 L-100 -50 Z');
		expect(pathData(cleanVector({ ...vectorDefaults('ellipse') }))).toMatch(/^M50 0 C/);
	});
	test('a file that is not ours is not read by the own-file fast path', () => {
		expect(readOwnSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>')).toBeNull();
	});
	test('arcs become <= 90 degree cubics on the ellipse (within 0.03% of the radius)', () => {
		const e = new THREE.EllipseCurve(1, 2, 3, 2, 0.2, 2.9, false, 0.3);
		const pieces = arcToCubics(e);
		expect(pieces.length).toBe(2);
		for (const p of pieces)
			for (const t of [0, 0.3, 0.5, 0.8, 1]) {
				const q = cubicAt(p, t);
				// back into the ellipse's unrotated frame: x^2/a^2 + y^2/b^2 should be 1
				const dx = q[0] - 1;
				const dy = q[1] - 2;
				const x = dx * Math.cos(-0.3) - dy * Math.sin(-0.3);
				const y = dx * Math.sin(-0.3) + dy * Math.cos(-0.3);
				expect(Math.abs(Math.sqrt((x * x) / 9 + (y * y) / 4) - 1)).toBeLessThan(3e-4);
			}
	});
	test("SVGLoader's curves (line, quadratic, cubic, closing) become our nodes", () => {
		const path = new THREE.Path();
		path.moveTo(0, 0);
		path.lineTo(10, 0);
		path.quadraticCurveTo(20, 0, 20, 10);
		path.bezierCurveTo(20, 20, 0, 20, 0, 0);
		const sub = subpathFromCurves(path);
		expect(sub.closed).toBe(true);
		expect(sub.nodes.length).toBe(3);
		// the quadratic is degree-elevated: its first handle is 2/3 of the way to the control point
		expect(sub.nodes[1].ox).toBeCloseTo(20 / 3, 9);
		// the closing cubic's in-handle folded onto the first node
		expect([sub.nodes[0].ix, sub.nodes[0].iy]).toEqual([0, 20]);
		expect(vectorPolylines(cleanVector({ kind: 'path', paths: [sub] }))[0].pts.length).toBeGreaterThan(8);
	});
});

describe('the geometry registry entry (D1 phase 2)', () => {
	test('Vector is a build-hook spec whose clean is the record boundary', async () => {
		const { geometrySpec } = await import('../../src/lib/geometryParams.js');
		const spec = geometrySpec('Vector');
		expect(spec?.build).toBeTypeOf('function');
		expect(spec.clean({ kind: 'star', points: 999, junk: 1 })).toEqual(cleanVector({ kind: 'star', points: 64 }));
		const g = spec.build(spec.clean({ ...vectorDefaults('star'), corner: 0.05 }));
		expect(g.getAttribute('position').count).toBeGreaterThan(0);
		expect(g.getAttribute('color').count).toBe(g.getAttribute('position').count);
		// every key a row edits is a record key, and `show` keeps the duplicate 'points' row to one kind
		const keys = Object.keys(vectorDefaults('rect'));
		for (const p of spec.params) expect(keys).toContain(p.key);
		for (const kind of ['rect', 'ellipse', 'star', 'polygon', 'path']) {
			const shown = spec.params.filter((p) => !p.show || p.show(vectorDefaults(kind))).map((p) => p.key);
			expect(new Set(shown).size).toBe(shown.length);
		}
	});
});

describe('the wire (vectorWire)', () => {
	/** @param {Record<string, any>} patch */
	const meshOf = (patch) => {
		const params = cleanVector({ ...vectorDefaults(patch.kind), ...patch });
		const mesh = new THREE.Mesh(buildVectorGeometry(params), new THREE.MeshStandardMaterial({ vertexColors: true }));
		mesh.userData.geometryParams = { gtype: 'Vector', params };
		return mesh;
	};

	test('a light shape sends its whole mesh (byte-identical to before)', () => {
		const mesh = meshOf({ kind: 'rect' });
		const element = vectorWireElement(mesh);
		expect(JSON.stringify(element)).toBe(JSON.stringify(mesh.toJSON()));
	});

	test('a heavy shape goes without triangles and the receiver rebuilds the same mesh', () => {
		// a radial-gradient ellipse: ~61k floats, over the binarypack-safe cap
		const mesh = meshOf({ kind: 'ellipse', width: 1.4, height: 0.7, fillType: 'radial', fill: '#ffffff', fill2: '#0044ff' });
		const count = mesh.geometry.attributes.position.count;
		expect(count * 3).toBeGreaterThan(WIRE_FLOAT_CAP / 3);
		const element = vectorWireElement(mesh);
		expect(JSON.stringify(element).length).toBeLessThan(20000);
		// the sender's own mesh keeps its triangles
		expect(mesh.geometry.attributes.position.count).toBe(count);
		const arrived = /** @type {any} */ (new THREE.ObjectLoader().parse(element));
		expect(arrived.geometry.attributes.position).toBeUndefined();
		expect(rebuildVectorFromRecord(arrived)).toBe(true);
		expect(arrived.uuid).toBe(mesh.uuid);
		expect(arrived.geometry.attributes.position.count).toBe(count);
		expect(Array.from(arrived.geometry.attributes.color.array.slice(0, 30))).toEqual(Array.from(mesh.geometry.attributes.color.array.slice(0, 30)));
		// a complete mesh is never rebuilt
		expect(rebuildVectorFromRecord(arrived)).toBe(false);
	});

	test('a shape edited by the mesh tools is not a record any more: it always sends its triangles', () => {
		const mesh = meshOf({ kind: 'ellipse', width: 1.4, height: 0.7, fillType: 'radial', fill: '#ffffff', fill2: '#0044ff' });
		mesh.userData.faceEdited = true;
		expect(vectorWireElement(mesh)).toBeNull();
	});
});
