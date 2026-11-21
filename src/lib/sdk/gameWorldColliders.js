// 61-int — the navmesh bake input (`api.colliderGeometry`), split out of sdk/gameWorld.js so the editor and
// play boots do not carry it: gameWorld.js loads this file on the first call (the api was async already).

import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore';
import { isPathObject } from '../path/pathCore.js';

/** a bake input is capped: past this many triangles the caller is told (`truncated`), never stalled */
export const COLLIDER_TRIANGLE_CAP = 600000;
/** an instanced mesh (scatter) contributes one box per instance, up to this many per mesh */
const INSTANCE_CAP = 4096;

const vA = new THREE.Vector3();
const mA = new THREE.Matrix4();
const mB = new THREE.Matrix4();
const box = new THREE.Box3();

/** a top-level object is a moving solid: a dynamic body or a flow-animated (kinematic) one
 * @param {any} top @param {Set<string>} dynamic @param {(uuid: string) => boolean} animated */
function isMoving(top, dynamic, animated) {
	return dynamic.has(top.uuid) || animated(top.uuid);
}

/** visible all the way up to the objects root (an object hidden in the list is no wall) @param {any} o @param {any} root */
function visibleChain(o, root) {
	for (let n = o; n && n !== root; n = n.parent) if (n.visible === false) return false;
	return true;
}

/** the 12 triangles of an axis-aligned box, appended @param {number[]} pos @param {number[]} idx @param {THREE.Box3} b */
function pushBox(pos, idx, b) {
	const base = pos.length / 3;
	const { min: n, max: x } = b;
	pos.push(
		n.x,
		n.y,
		n.z,
		x.x,
		n.y,
		n.z,
		x.x,
		n.y,
		x.z,
		n.x,
		n.y,
		x.z,
		n.x,
		x.y,
		n.z,
		x.x,
		x.y,
		n.z,
		x.x,
		x.y,
		x.z,
		n.x,
		x.y,
		x.z
	);
	// faces wound outward (top first: the walkable side a bake reads)
	const f = [
		4, 7, 6, 4, 6, 5, 0, 1, 2, 0, 2, 3, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7,
		4, 3, 4, 0
	];
	for (const k of f) idx.push(base + k);
}

/**
 * The navmesh bake input. Pure READ of the live scene; nothing is written.
 * @param {{exclude?: string[], maxTriangles?: number, signatureOnly?: boolean}} [opts] `exclude` = object
 *   uuids whose whole subtree is left out (the NPCs themselves); `signatureOnly` = the cheap poll: the
 *   `signature` and the `moving` boxes, no triangles (a rebake watcher asks this once a second)
 * @returns {Promise<{positions: Float32Array, indices: Uint32Array, triangles: number, objects: number,
 *   truncated: boolean, moving: {uuid: string, name: string, min: number[], max: number[]}[], signature: string}>}
 */
export async function colliderGeometry(opts = {}) {
	const root = /** @type {any} */ (get(objectsGroup));
	const empty = {
		positions: new Float32Array(0),
		indices: new Uint32Array(0),
		triangles: 0,
		objects: 0,
		truncated: false,
		moving: [],
		signature: ''
	};
	if (!root) return empty;
	const cap = Math.max(
		1000,
		Math.min(Number(opts.maxTriangles) || COLLIDER_TRIANGLE_CAP, COLLIDER_TRIANGLE_CAP)
	);
	const exclude = new Set((opts.exclude ?? []).map(String));
	/** @type {Set<string>} */
	const dynamic = new Set();
	/** @type {(uuid: string) => boolean} */
	let animated = () => false;
	try {
		const physics = await import('../physics.js');
		for (const row of physics.listPhysicsObjects())
			if (row.mode === 'dynamic') dynamic.add(row.uuid);
		const flow = await import('../flowRuntime.js');
		animated = (uuid) => flow.isAnimatedTarget(uuid);
	} catch {
		/* a bare test env: everything is scenery */
	}
	root.updateWorldMatrix(true, true);
	/** @type {number[]} */
	const pos = [];
	/** @type {number[]} */
	const idx = [];
	/** @type {{uuid: string, name: string, min: number[], max: number[]}[]} */
	const moving = [];
	/** @type {(string | number)[]} */
	const sig = [];
	let objects = 0;
	let truncated = false;
	for (const top of root.children) {
		if (exclude.has(top.uuid) || top.visible === false) continue;
		if (isMoving(top, dynamic, animated)) {
			box.setFromObject(top);
			if (!box.isEmpty())
				moving.push({
					uuid: top.uuid,
					name: top.name || '',
					min: box.min.toArray(),
					max: box.max.toArray()
				});
			continue;
		}
		top.traverse((/** @type {any} */ o) => {
			if (truncated || !o.isMesh || !o.geometry?.attributes?.position) return;
			if (exclude.has(o.uuid) || !visibleChain(o, root)) return;
			const ud = o.userData ?? {};
			if (ud.physics?.sensor || ud.water || isPathObject(o) || ud.navIgnore) return;
			for (let n = o.parent; n && n !== root; n = n.parent)
				if (exclude.has(n.uuid) || isPathObject(n)) return;
			const g = o.geometry;
			const p = g.attributes.position;
			objects++;
			sig.push(
				o.uuid,
				g.uuid,
				p.version,
				o.matrixWorld.elements.map((/** @type {number} */ v) => v.toFixed(3)).join(',')
			);
			if (opts.signatureOnly) {
				if (o.isInstancedMesh) sig.push(o.count, o.instanceMatrix?.version ?? 0);
				return;
			}
			if (o.isInstancedMesh) {
				if (!g.boundingBox) g.computeBoundingBox();
				const n = Math.min(o.count, INSTANCE_CAP);
				for (let i = 0; i < n; i++) {
					o.getMatrixAt(i, mA);
					mB.multiplyMatrices(o.matrixWorld, mA);
					box.copy(g.boundingBox).applyMatrix4(mB);
					pushBox(pos, idx, box);
				}
				sig.push(o.count, o.instanceMatrix?.version ?? 0);
				return;
			}
			const tris = g.index ? g.index.count / 3 : p.count / 3;
			if (idx.length / 3 + tris > cap) {
				truncated = true;
				return;
			}
			const base = pos.length / 3;
			for (let i = 0; i < p.count; i++) {
				vA.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
				pos.push(vA.x, vA.y, vA.z);
			}
			// a mirrored object (negative scale) flips its winding: keep the walkable side up
			const flip = o.matrixWorld.determinant() < 0;
			if (g.index)
				for (let i = 0; i + 2 < g.index.count; i += 3) {
					const a = g.index.getX(i),
						b = g.index.getX(i + 1),
						c = g.index.getX(i + 2);
					if (flip) idx.push(base + a, base + c, base + b);
					else idx.push(base + a, base + b, base + c);
				}
			else
				for (let i = 0; i + 2 < p.count; i += 3) {
					if (flip) idx.push(base + i, base + i + 2, base + i + 1);
					else idx.push(base + i, base + i + 1, base + i + 2);
				}
		});
	}
	return {
		positions: new Float32Array(pos),
		indices: new Uint32Array(idx),
		triangles: idx.length / 3,
		objects,
		truncated,
		moving,
		signature: sig.join('|') + '#' + moving.map((m) => m.uuid).join(',')
	};
}
