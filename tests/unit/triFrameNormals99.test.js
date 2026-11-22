// @ts-nocheck — fixture geometry built ad hoc (the checkJs rule for test fixtures)
// Roadmap 99 K5 (lane 99-live, row 2): the live-edit normals policy. On a flat or a smooth-shaded mesh the touched
// corners come out exactly as a full recompute would give them; on authored normals every untouched corner stays
// byte-identical and the touched ones keep their smoothing (split edges stay split).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { smoothWeldedNormals } from '$lib/faceEdit.js';
import { frameOfGeometry, normalPlan, applyNormalPlan, changedCorners, weld } from '$lib/triFrame.js';

/** move every corner within r of `at` by `d` (welded corners move together) */
function moveNear(g, at, r, d) {
	const p = g.attributes.position.array;
	/** @type {number[]} */
	const moved = [];
	for (let i = 0; i < p.length / 3; i++) {
		const dx = p[i * 3] - at[0], dy = p[i * 3 + 1] - at[1], dz = p[i * 3 + 2] - at[2];
		if (dx * dx + dy * dy + dz * dz < r * r) moved.push(i);
	}
	return {
		moved,
		apply() {
			for (const i of moved) {
				p[i * 3] += d[0];
				p[i * 3 + 1] += d[1];
				p[i * 3 + 2] += d[2];
			}
		}
	};
}

function runPlan(g, at, r, d, options) {
	const f = frameOfGeometry(g);
	const normals = g.attributes.normal.array;
	const before = Float32Array.from(normals);
	const m = moveNear(g, at, r, d);
	const plan = normalPlan(f, normals, m.moved, options);
	m.apply();
	applyNormalPlan(f, normals, plan);
	return { f, before, normals, plan, moved: m.moved };
}

describe('99 K5 normals on a live edit', () => {
	it('flat (a committed geometry): the touched corners = computeVertexNormals, the rest untouched', () => {
		const g = new THREE.SphereGeometry(1, 40, 20).toNonIndexed();
		g.computeVertexNormals();
		const { normals, before, plan } = runPlan(g, [0, 1, 0], 0.3, [0.05, 0.2, 0]);
		const full = g.clone();
		full.computeVertexNormals();
		expect([...normals]).toEqual([...full.attributes.normal.array]);
		const touched = new Set(plan.corners);
		for (let i = 0; i < normals.length / 3; i++)
			if (!touched.has(i)) expect([normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]]).toEqual([before[i * 3], before[i * 3 + 1], before[i * 3 + 2]]);
	});

	it('smooth-shaded (shading smooth / terrain): = computeVertexNormals + smoothWeldedNormals', () => {
		const g = new THREE.SphereGeometry(1, 40, 20).toNonIndexed();
		g.computeVertexNormals();
		smoothWeldedNormals(g);
		const { normals } = runPlan(g, [1, 0, 0], 0.35, [0.1, 0.05, 0], { smooth: true });
		const full = g.clone();
		full.computeVertexNormals();
		smoothWeldedNormals(full);
		const want = full.attributes.normal.array;
		let worst = 0;
		for (let i = 0; i < want.length; i++) worst = Math.max(worst, Math.abs(normals[i] - want[i]));
		expect(worst).toBeLessThan(1e-6);
	});

	it('authored normals: untouched corners byte-identical, a split (hard) edge stays split', () => {
		// a box: every corner's normal is its side's (authored, split at the edges); a cylinder side: smooth authored
		const g = new THREE.CylinderGeometry(1, 1, 2, 24, 4).toNonIndexed();
		const { f, normals, before, plan } = runPlan(g, [1, 0, 0], 0.3, [0.15, 0, 0]);
		const touched = new Set(plan.corners);
		let same = 0;
		for (let i = 0; i < normals.length / 3; i++) {
			if (touched.has(i)) continue;
			expect(normals[i * 3]).toBe(before[i * 3]);
			expect(normals[i * 3 + 1]).toBe(before[i * 3 + 1]);
			expect(normals[i * 3 + 2]).toBe(before[i * 3 + 2]);
			same++;
		}
		expect(same).toBeGreaterThan(0);
		// smooth side corners at one vertex still share one normal after the move
		const V = weld(f);
		/** @type {Map<number, string[]>} */
		const at = new Map();
		for (const k of plan.corners) {
			const o = k * 3;
			const wasSide = Math.abs(before[o + 1]) < 0.5; // a side corner (not a cap)
			if (!wasSide) continue;
			const key = [normals[o], normals[o + 1], normals[o + 2]].join(',');
			if (!at.has(V[k])) at.set(V[k], []);
			at.get(V[k]).push(key);
		}
		for (const keys of at.values()) expect(new Set(keys).size).toBe(1);
		// cap corners at the rim stay flat (the cap/side edge is a hard edge)
		for (const k of plan.corners) {
			const o = k * 3;
			if (Math.abs(before[o + 1]) > 0.99) expect(Math.abs(normals[o + 1])).toBeGreaterThan(0.9);
		}
	});

	it('changedCorners finds exactly the moved corners', () => {
		const a = new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]);
		const b = Float32Array.from(a);
		b[4] = 5;
		expect([...changedCorners(a, b)]).toEqual([1]);
	});

	it('no normal attribute: no plan (the caller recomputes in full)', () => {
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
		expect(normalPlan(frameOfGeometry(g), null, [0])).toBe(null);
	});
});
