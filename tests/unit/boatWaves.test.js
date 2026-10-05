// @ts-nocheck — plain fixtures (rapier + a W1 stand-in ocean)
// 36-fb-water F15: a boat on Island ocean's sea (the ocean preset, six choppy Gerstner components,
// amplitude 0.35 m, wavelength 14 m — the real W1 query, waves and all, on a real rapier body).
// A hull AVERAGES the waves shorter than itself (W1 `span`): without that the point-sampled hull
// resonated with the short components at its roll period and capsized; with it a rowing boat
// rides the swell upright. The counterfactual is measured in the same file.
import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { bodySamples, applyBuoyancy, buoyancyOut, normalizeFloats } from '../../src/lib/sim/buoyancy.js';
import { waterVolumes, normalizeWater } from '../../src/lib/water/volumes.js';
import { ensureWaterRoot, beginWaterFrame, queryWater, resetWaterQuery } from '../../src/lib/sim/waterQuery.js';
import { waterPreset } from '../../src/lib/water/presets.js';

beforeAll(async () => {
	const w = console.warn;
	console.warn = () => {};
	await RAPIER.init();
	console.warn = w;
});

function ocean() {
	const blob = waterPreset('ocean', { shape: 'plane' });
	blob.waves = { ...blob.waves, amplitude: 0.35, wavelength: 14 };
	const o = { uuid: 'ocean', userData: { water: normalizeWater(blob) }, matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -3, 0, 1] }, geometry: { boundingBox: { min: { x: -110, y: -3, z: -110 }, max: { x: 110, y: 3, z: 110 } } }, children: [] };
	return { children: [o], userData: {} };
}
/** @param {{he: any, mass?: number, density?: number, filter?: boolean}} o */
function sail(o) {
	resetWaterQuery();
	let t = 0;
	waterVolumes.setClock(() => t);
	ensureWaterRoot(ocean());
	const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
	world.timestep = 1 / 60;
	const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setCanSleep(false).setTranslation(10.5, 0.1, 9.5).setRotation({ x: 0, y: Math.sin(0.2), z: 0, w: Math.cos(0.2) }));
	world.createCollider(RAPIER.ColliderDesc.cuboid(o.he.x, o.he.y, o.he.z).setMass(o.mass ?? 160), body);
	const samples = bodySamples([{ kind: 'hull', he: o.he, t: [0, 0, 0], q: [0, 0, 0, 1] }]);
	if (o.filter === false) samples.span = 0; // the counterfactual: every ripple at full height
	const floats = normalizeFloats({ density: o.density ?? 320 });
	const out = buoyancyOut();
	let minUp = 1;
	/** @type {number[]} */ const gaps = [];
	for (let i = 0; i < 20 * 60; i++) {
		t = i / 60;
		beginWaterFrame();
		applyBuoyancy(body, samples, queryWater, floats, -9.81, 1 / 60, out);
		world.step();
		if (i < 240) continue;
		const r = body.rotation();
		minUp = Math.min(minUp, 1 - 2 * (r.x * r.x + r.z * r.z));
		const p = body.translation();
		gaps.push(p.y - waterVolumes.surfaceY(waterVolumes.list()[0], p.x, p.z));
	}
	return { minUp, meanGap: gaps.reduce((a, b) => a + b, 0) / gaps.length, minGap: Math.min(...gaps) };
}
const BOAT = { x: 0.9, y: 0.3, z: 2.1 }; // Island ocean's hull (1.8 x 0.6 x 4.2)
const DINGHY = { x: 0.65, y: 0.275, z: 1.7 }; // the first try

describe('a boat on a choppy sea (F15)', () => {
	it('the island boat floats upright on the swell', () => {
		const r = sail({ he: BOAT });
		expect(r.minUp).toBeGreaterThan(0.85); // never heels past ~32 degrees
		expect(r.meanGap).toBeGreaterThan(-0.05); // floats (its centre stays near the surface)
		expect(r.meanGap).toBeLessThan(0.35);
		expect(r.minGap).toBeGreaterThan(-0.4); // never swamped
	});
	it('COUNTERFACTUAL: without the hull averaging the same sea capsizes a dinghy', () => {
		expect(sail({ he: DINGHY, mass: 120, filter: false }).minUp).toBeLessThan(0);
		expect(sail({ he: DINGHY, mass: 120 }).minUp).toBeGreaterThan(0); // the filter alone keeps it the right way up
	});
	it('a duck-sized body still feels the short waves (the filter scales with size)', () => {
		const duck = bodySamples([{ kind: 'sphere', he: { x: 0.15, y: 0.15, z: 0.15 }, t: [0, 0, 0], q: [0, 0, 0, 1] }]);
		expect(duck.span).toBeLessThan(0.5);
	});
});
