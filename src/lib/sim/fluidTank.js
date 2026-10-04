// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FLUID_DEFAULTS, TANK_WALL } from './fluidCore.js';

// 36-sim U2b: the "Fluid tank" create item — an open glass box (Create ▸ Simulation).
// A LEAF over three: geometries.svelte.js calls these from the replicated /create, so every
// peer builds the same tank with the same stamps (deterministic, no extra message).

/** the five slabs (floor + four walls) of an open tank, centred on the origin
 * @param {number} w @param {number} h @param {number} d @returns {{c: number[], s: number[]}[]} */
function slabs(w, h, d) {
	const t = TANK_WALL;
	return [
		{ c: [0, -h / 2 + t / 2, 0], s: [w, t, d] },
		{ c: [0, 0, d / 2 - t / 2], s: [w, h, t] },
		{ c: [0, 0, -d / 2 + t / 2], s: [w, h, t] },
		{ c: [w / 2 - t / 2, 0, 0], s: [t, h, d - 2 * t] },
		{ c: [-w / 2 + t / 2, 0, 0], s: [t, h, d - 2 * t] }
	];
}

/** @param {any=} a @param {number} d */
const dim = (a, d) => (typeof a === 'number' && Number.isFinite(a) && a > 0.1 ? Math.min(a, 20) : d);

/** `/create FluidTank w h d` @param {any=} a @param {any=} b @param {any=} c */
export function fluidTankGeometry(a, b, c) {
	const w = dim(a, 1.2), h = dim(b, 0.8), d = dim(c, 0.8);
	const parts = slabs(w, h, d).map(({ c: at, s }) => new THREE.BoxGeometry(s[0], s[1], s[2]).translate(at[0], at[1], at[2]));
	const merged = mergeGeometries(parts, false);
	parts.forEach((p) => p.dispose());
	return merged;
}

/**
 * Stamp a fresh tank: the fluid block, a glass look, and a COMPOUND collider (one hull per
 * slab) so a toy dropped in lands inside instead of on an invisible lid.
 * @param {any} object @param {any=} a @param {any=} b @param {any=} c
 */
export function stampFluidTank(object, a, b, c) {
	const w = dim(a, 1.2), h = dim(b, 0.8), d = dim(c, 0.8);
	object.name = 'Fluid tank';
	object.userData.fluid = JSON.parse(JSON.stringify(FLUID_DEFAULTS));
	const m = object.material;
	m.color.set('#d6ecff');
	m.roughness = 0.08;
	m.metalness = 0;
	m.transparent = true;
	m.opacity = 0.18;
	m.depthWrite = false; // the fluid behind the front glass must still draw
	object.castShadow = false;
	/** @type {number[]} */
	const verts = [];
	/** @type {number[][]} */
	const pieces = [];
	for (const { c: at, s } of slabs(w, h, d)) {
		const start = verts.length;
		for (let i = 0; i < 8; i++)
			verts.push(
				round(at[0] + (i & 1 ? s[0] : -s[0]) / 2),
				round(at[1] + (i & 2 ? s[1] : -s[1]) / 2),
				round(at[2] + (i & 4 ? s[2] : -s[2]) / 2)
			);
		pieces.push([start, 24]);
	}
	object.userData.physics = { mode: 'static', collider: 'custom', colliderVerts: verts, colliderPieces: pieces };
}

/** @param {number} v */
const round = (v) => Math.round(v * 1e5) / 1e5;
