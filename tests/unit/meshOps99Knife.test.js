// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K4 family 3 — THE PARITY GATE for the knife: the kernel knifeCut against the frozen soup
// knifeCutCore (tests/unit/fixtures/soupOps99.js) on the fixture set (MESHOPS_BIG=1 adds the 67k scan), under a
// perspective and an orthographic camera, for a straight cut, a cut ending inside the mesh and a polyline.
// Same triangles in the same order (the knife splits IN PLACE), positions <= eps (<= the key cell where the
// weld snaps), same uvs and slots, same cut / corner counts. The partition is derived by the commit (as before),
// so equal triangles in equal order give equal partitions.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readTriangles, trisToPositions, trisToGroups, trisToUVs } from '$lib/faceEdit.js';
import * as ops from '$lib/meshOps/index.js';
import * as soup from './fixtures/soupOps99.js';
import { fixtureSet } from './fixtures/meshOps99Fixtures.js';
import {
	EPS,
	SNAP,
	snappedCorners,
	editorPartition,
	opMeshOf,
	maxDiff
} from './fixtures/meshOps99Harness.js';

/** an oblique camera: rotate (y 30 deg, x 25 deg), then perspective from z = 6 or orthographic */
function camera(kind) {
	const m = new THREE.Matrix4()
		.makeRotationX(0.44)
		.multiply(new THREE.Matrix4().makeRotationY(0.52));
	const e = m.elements;
	return (x, y, z) => {
		const rx = e[0] * x + e[4] * y + e[8] * z;
		const ry = e[1] * x + e[5] * y + e[9] * z;
		const rz = e[2] * x + e[6] * y + e[10] * z;
		if (kind === 'ortho') return { px: [400 + rx * 150, 300 - ry * 150], w: 1 };
		const w = Math.max(6 - rz, 1e-6);
		return { px: [400 + (rx / w) * 900, 300 - (ry / w) * 900], w };
	};
}

/** cut lines over a region: its screen box, a straight cut across, one ending inside, a 3-point polyline */
function cutsFor(tris, region, cam) {
	let x0 = Infinity,
		y0 = Infinity,
		x1 = -Infinity,
		y1 = -Infinity;
	for (const t of region)
		for (const v of tris[t]) {
			const s = cam(v.x, v.y, v.z).px;
			x0 = Math.min(x0, s[0]);
			y0 = Math.min(y0, s[1]);
			x1 = Math.max(x1, s[0]);
			y1 = Math.max(y1, s[1]);
		}
	const cx = (x0 + x1) / 2,
		cy = (y0 + y1) / 2,
		w = x1 - x0,
		h = y1 - y0;
	return {
		across: [
			[x0 - 5, cy - 0.13 * h],
			[x1 + 5, cy + 0.11 * h]
		],
		endsInside: [
			[x0 - 5, cy + 0.07 * h],
			[cx + 0.09 * w, cy - 0.03 * h]
		],
		polyline: [
			[cx - 0.31 * w, cy - 0.27 * h],
			[cx + 0.04 * w, cy + 0.06 * h],
			[cx + 0.29 * w, cy - 0.22 * h]
		]
	};
}

export function bothKnife(geometry, points, cam) {
	const tris = readTriangles(geometry);
	const r = soup.knifeCutCore(tris, points, (v) => cam(v.x, v.y, v.z));
	const om = ops.beginOp(opMeshOf(geometry, editorPartition(geometry, tris)));
	const k = ops.knifeCut(om, points, (p) => cam(p[0], p[1], p[2]));
	if (!r) return { old: null, neu: k };
	const out = ops.opOutput(om, { order: 'appearance' });
	return {
		old: {
			positions: Float32Array.from(trisToPositions(r.tris)),
			uvs: trisToUVs(r.tris) ? Float32Array.from(trisToUVs(r.tris)) : null,
			groups: trisToGroups(r.tris),
			cut: r.cut,
			corners: r.corners
		},
		neu: { ...out, cut: k?.cut, corners: k?.corners }
	};
}

describe('99 K4 family 3: kernel knife = the soup knife', () => {
	for (const fx of fixtureSet({ big: !!process.env.MESHOPS_BIG })) {
		const geometry = fx.make();
		const tris = readTriangles(geometry);
		const snapped = snappedCorners(tris);
		for (const [region, picked] of Object.entries(fx.regions(geometry))) {
			if (!picked.length) continue;
			for (const kind of ['persp', 'ortho']) {
				const cam = camera(kind);
				for (const [name, points] of Object.entries(cutsFor(tris, picked, cam)))
					it(`${fx.name} / ${region} / ${kind} / ${name}`, () => {
						const { old, neu } = bothKnife(geometry, points, cam);
						if (!old) {
							expect(neu).toBe(null);
							return;
						}
						expect(neu.cut).toBe(old.cut);
						expect(neu.corners).toBe(old.corners);
						expect(neu.positions.length).toBe(old.positions.length);
						expect(maxDiff(neu.positions, old.positions)).toBeLessThanOrEqual(
							snapped.size ? SNAP : EPS
						);
						expect(!!neu.uvs).toBe(!!old.uvs);
						if (old.uvs)
							expect(maxDiff(neu.uvs, old.uvs)).toBeLessThanOrEqual(snapped.size ? 1e-3 : EPS);
						expect(neu.groups).toEqual(old.groups);
					}, 300000);
			}
		}
	}
	it('premise: a cube cut across the top really cuts, with inserted corners', () => {
		const fx = fixtureSet({ big: false }).find((f) => f.name === 'cube');
		const g = fx.make();
		const cam = camera('persp');
		const { old } = bothKnife(g, cutsFor(readTriangles(g), fx.regions(g).top, cam).polyline, cam);
		expect(old.cut).toBeGreaterThan(0);
		expect(old.corners).toBeGreaterThan(0);
	});
});
