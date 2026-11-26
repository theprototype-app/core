// 104 B3 (lane 104-world) — HOW AN OBJECT SITS IN WATER, in numbers a person and an agent read the same way:
// set_physics answers it and the Inspector's Floats hint shows it. It uses buoyancy.js's own model (density
// ratio, the collider's sampled volume), so the waterline it predicts is the one the simulation settles at.
// Imports three + two leaves; nothing here runs in the physics step.
import * as THREE from 'three';
import { normalizeFloats, shapeSamples, expectedDraft, WATER_DENSITY } from './buoyancy.js';
import { inferredColliderKind } from '../colliderSpec.js';

const r2 = (/** @type {number} */ v) => Math.round(v * 100) / 100 + 0;
const r3 = (/** @type {number} */ v) => Math.round(v * 1000) / 1000 + 0;
const box = new THREE.Box3();
const size = new THREE.Vector3();

/** the collider kind buoyancy samples (hull / trimesh / custom pieces sample as a hull) @param {any} object */
function sampleKind(object) {
	const k = object.userData?.physics?.collider ?? inferredColliderKind(object) ?? 'box';
	if (k === 'trimesh' || k === 'custom' || k === 'object') return 'hull';
	return ['box', 'sphere', 'capsule', 'cylinder', 'cone', 'hull'].includes(k) ? k : 'box';
}

/**
 * The object's unrotated size (the collider measure: rotation stripped, scale kept).
 * @param {any} object @returns {{x: number, y: number, z: number} | null} half extents
 */
function halfExtents(object) {
	const q = object.quaternion.clone();
	object.quaternion.set(0, 0, 0, 1);
	object.updateMatrixWorld(true);
	box.setFromObject(object);
	object.quaternion.copy(q);
	object.updateMatrixWorld(true);
	if (box.isEmpty() || !Number.isFinite(box.min.x)) return null;
	box.getSize(size).multiplyScalar(0.5);
	return { x: Math.max(size.x, 0.02), y: Math.max(size.y, 0.02), z: Math.max(size.z, 0.02) };
}

/**
 * How `object` floats: its density (kg/m³), the share of it under the surface at rest, the draft (metres under
 * the waterline, upright), or that it sinks. Null for something with no size (a light, an empty group).
 * @param {any} object
 * @returns {{density: number, densityFrom: 'setting' | 'mass', under: number | null, draft: number | null,
 *   height: number, sinks: boolean, off: boolean, buoyancy: number, drag: number, volume: number, upright?: false} | null}
 */
export function floatSummary(object) {
	if (!object) return null;
	const he = halfExtents(object);
	if (!he) return null;
	const f = normalizeFloats(object.userData?.physics?.floats);
	const volume = shapeSamples(sampleKind(object), he).volume;
	const mass = Number.isFinite(object.userData?.physics?.mass) ? object.userData.physics.mass : 1;
	const density = f.density === 'mass' ? Math.max(10, mass / Math.max(volume, 1e-6)) : f.density;
	const height = he.y * 2;
	const draft = f.off ? null : expectedDraft(height, density, WATER_DENSITY, f.multiplier);
	const ratio = density / (WATER_DENSITY * Math.max(f.multiplier, 1e-6));
	// a BOX floats flat only when it is stable that way (metacentre above the centre of mass: d/2 + b²/12d > h/2,
	// b = its narrower side). A cube between ~21 % and ~79 % of water's density is not: it tips edge- or corner-up,
	// as a real one does, and its lowest point sits deeper than the upright draft says (measured: 0.7 → bottom 1 m down)
	const kind = sampleKind(object);
	const b = 2 * Math.min(he.x, he.z);
	const tips = kind === 'box' && draft !== null && draft > 0 && draft / 2 + (b * b) / (12 * draft) <= height / 2;
	return {
		density: Math.round(density),
		densityFrom: f.density === 'mass' ? 'mass' : 'setting',
		under: f.off || ratio >= 1 ? null : r2(ratio),
		draft: draft === null ? null : r3(draft),
		height: r3(height),
		sinks: !f.off && ratio >= 1,
		off: f.off,
		buoyancy: f.multiplier,
		drag: f.drag,
		volume: r3(volume),
		...(tips ? { upright: /** @type {false} */ (false) } : {})
	};
}

/** the Inspector's one line for a summary @param {ReturnType<typeof floatSummary>} s */
export function floatWords(s) {
	if (!s) return '';
	if (s.off) return 'Ignores water.';
	if (s.sinks) return 'Sinks in water (' + s.density + ' kg/m³; water is 1000).';
	const words = 'Floats about ' + Math.round((s.under ?? 0) * 100) + '% under: ' + s.draft + ' m of its ' + s.height + ' m height (' + s.density + ' kg/m³; water is 1000).';
	return s.upright === false ? words + ' At this density it tips over and floats on an edge.' : words;
}
