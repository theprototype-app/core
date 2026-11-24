// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K4 families 4-6 (lane 99-ops-b) — THE PARITY GATE: every ported operator against the pre-port
// soup code (tests/unit/fixtures/soupOps99b.js, frozen) on the fixture set. Same positions (<= eps), same
// face partition (and the same stored order), same uvs and material groups, the same refusals.
import { describe, it, expect } from 'vitest';
import { readTriangles, componentsOfTris } from '$lib/faceEdit.js';
import { composeFaces, appendOrigin } from '$lib/meshTopology.js';
import * as ops from '$lib/meshOps/index.js';
import * as soup from './fixtures/soupOps99b.js';
import * as fx from './fixtures/meshOps99bFixtures.js';
import { snappedCorners, editorPartition, opMeshOf, stateOf, expectSame } from './fixtures/meshOps99bHarness.js';

const BIG = !!process.env.MESHOPS_BIG;

/** faceEdit's solidifyFaces (private): originals keep theirs, back copies mirror their source's face, rim pairs */
function solidifyFaces(priorFaces, origLen, r) {
	const authored = [];
	for (const group of priorFaces ?? []) {
		const members = group.filter((ti) => r.copyOf.has(ti)).map((ti) => r.copyOf.get(ti));
		if (members.length) authored.push(members);
	}
	for (let i = r.rimFrom; i + 1 < r.tris.length; i += 2) authored.push([i, i + 1]);
	return composeFaces(priorFaces, appendOrigin(origLen, r.tris.length), authored);
}

/** run one family-4 op both ways @returns {{ old: any, neu: any }} */
export function both4(geometry, op, arg, opts) {
	const tris = readTriangles(geometry);
	const partition = editorPartition(geometry, tris);
	const om = ops.beginOp(opMeshOf(geometry, partition));
	let r;
	let k;
	if (op === 'bridge') {
		const parts = componentsOfTris(tris, arg);
		if (parts.length !== 2) throw new Error('fixture: bridge region is not two pieces');
		r = soup.bridgeFacesCore(tris, parts[0], parts[1], opts);
		k = ops.bridgeRegions(om, parts[0], parts[1], opts);
		if (!r.error) r.faces = composeFaces(partition, r.origin, r.authored);
	} else if (op === 'fill') {
		r = soup.fillHoleCore(tris, arg);
		k = ops.fillHole(om, ops.edgesOfKeys(om, arg));
		if (!r.error) r.faces = composeFaces(partition, appendOrigin(tris.length, r.tris.length), [r.cap]);
	} else if (op === 'solidify') {
		r = soup.solidifyCore(tris, arg, opts);
		k = ops.solidifyRegion(om, arg, opts);
		if (!r.error) r.faces = solidifyFaces(partition, tris.length, r);
	}
	if (r.error) return { error: r.error, kernelError: k.error ?? null, r, k };
	return { old: stateOf(r.tris, r.faces), neu: ops.opOutput(om, { order: 'appearance' }), r, k, snapped: snappedCorners(tris) };
}

/** fixture -> named cases { op, arg, opts } */
function cases() {
	const out = [];
	const add = (name, make, list) => out.push({ name, make, list });
	const BR = [undefined, { cuts: 2 }, { twist: 1 }, { invert: true }, { cuts: 1, twist: -2, invert: true }];
	const bridgeCases = (pick) => (g) => BR.map((o) => ({ op: 'bridge', arg: pick(g), opts: o ?? {} }));
	add('cube top+bottom (one shell)', fx.cube, bridgeCases((g) => [...fx.facing(g, [0, 1, 0]), ...fx.facing(g, [0, -1, 0])]));
	add('ngon caps (one shell)', fx.ngonPrism, bridgeCases((g) => [...fx.facing(g, [0, 1, 0]), ...fx.facing(g, [0, -1, 0])]));
	add('two cubes facing sides', fx.twoCubes, bridgeCases((g) => [...fx.facing(g, [1, 0, 0]).filter((t) => readTriangles(g)[t][0].x < 1), ...fx.facing(g, [-1, 0, 0]).filter((t) => readTriangles(g)[t][0].x > 1)]));
	add('two prisms caps', fx.twoPrisms, bridgeCases((g) => [...fx.facing(g, [0, 1, 0]).filter((t) => readTriangles(g)[t][0].y < 1), ...fx.facing(g, [0, -1, 0]).filter((t) => readTriangles(g)[t][0].y > 1)]));
	add('split-normals uv: front + back', fx.splitNormalsUv, bridgeCases((g) => [...fx.facing(g, [0, 0, 1]), ...fx.facing(g, [0, 0, -1])]));
	add('skinned: half quads (one tri each side)', fx.skinned, bridgeCases((g) => [fx.facing(g, [0, 0, 1])[0], fx.facing(g, [0, 0, -1])[0]]));
	add('cube: mismatched loops (refusal)', fx.cube, (g) => [{ op: 'bridge', arg: [...fx.facing(g, [0, 1, 0]), fx.facing(g, [0, -1, 0])[0]], opts: {} }]);
	const fill = (g) => {
		const rim = fx.borderKeys(g);
		return [
			{ op: 'fill', arg: [rim[0]] },
			{ op: 'fill', arg: rim },
			{ op: 'fill', arg: [...rim].reverse() },
			{ op: 'fill', arg: rim.slice(0, 2) }
		];
	};
	add('open box', fx.openBox, fill);
	add('open prism (hexagon n-gon)', fx.openPrism, fill);
	add('L hole (non-convex)', fx.lHole, (g) => {
		const rim = fx.borderKeys(g);
		// the outer square (16 sides, collinear corners) and the L
		const inner = rim.filter((k) => k.split('|').every((p) => p.split(',').slice(0, 2).every((c) => Math.abs(+c) < 9000)));
		return [{ op: 'fill', arg: [inner[0]] }, { op: 'fill', arg: inner }, { op: 'fill', arg: [rim.find((k) => !inner.includes(k))] }];
	});
	add('open split-normals uv', fx.openSplit, fill);
	add('open skinned', fx.openSkinned, fill);
	add('closed cube: interior edge (refusal)', fx.cube, (g) => [{ op: 'fill', arg: [fx.edgeKey(...readTriangles(g)[0].slice(0, 2).map(fx.keyOf))] }]);
	const SO = [{ thickness: 0.25 }, { thickness: -0.1 }, { thickness: 0 }];
	const sol = (pick) => (g) => SO.map((o) => ({ op: 'solidify', arg: pick(g), opts: o }));
	add('grid plane whole', () => fx.grid(3), sol((g) => readTriangles(g).map((_, i) => i)));
	add('grid plane: two cells + a half', () => fx.grid(3), sol(() => [0, 1, 2, 3, 9]));
	add('open box whole', fx.openBox, sol((g) => readTriangles(g).map((_, i) => i)));
	add('closed cube whole (hollow shell)', fx.cube, sol((g) => readTriangles(g).map((_, i) => i)));
	add('open split-normals whole', fx.openSplit, sol((g) => readTriangles(g).map((_, i) => i)));
	add('open skinned whole', fx.openSkinned, sol((g) => readTriangles(g).map((_, i) => i)));
	add('cube top (refusal: shared border)', fx.cube, sol((g) => fx.facing(g, [0, 1, 0])));
	if (BIG) {
		add('scan67k open: fill the rim', fx.openScan, () => [{ op: 'fill', arg: [fx.scanHoleRim()[0]] }, { op: 'fill', arg: fx.scanHoleRim() }]);
		add('scan67k open: solidify whole', fx.openScan, (g) => [{ op: 'solidify', arg: readTriangles(g).map((_, i) => i), opts: { thickness: 0.05 } }]);
		add('scan67k: bridge two patches', fx.scan67k, (g) => [{ op: 'bridge', arg: [...fx.near(g, [0, 1, 0], 0.12), ...fx.near(g, [0, -1, 0], 0.12)], opts: {} }]);
	}
	return out;
}

describe('99 K4 family 4: bridge / fill / solidify on the kernel = the soup operators', () => {
	for (const { name, make, list } of cases()) {
		const g = make();
		list(g).forEach((c, i) => {
			it(`${name} / ${c.op} #${i} ${JSON.stringify(c.opts ?? {})}`, () => {
				const run = both4(g, c.op, c.arg, c.opts);
				if (run.error) {
					expect(run.kernelError).toBe(run.error);
					// the 67k cases are there to do work, not to agree on a refusal
					expect(name.startsWith('scan67k')).toBe(false);
					return;
				}
				expect(run.k.error).toBeUndefined();
				expectSame(run);
			});
		});
	}
});
