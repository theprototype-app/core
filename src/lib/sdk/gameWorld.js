// Module SDK — 61-nav (roadmap 61 G1/G5/G7/G10): what a navigation module needs from the live scene
// and the editor chrome, as small additive reads + two registries. One slice of the api object
// makeApi() assembles (sdk/index.js, the ONE table). Logged in the modules repo's devx/ requests.
//
//   paths.of(uuid) / paths.list()   78's Path object, through its ONE read api (path/pathRuntime.js
//                                   pathOf, F9): a Patrol node never keeps a fourth list of points.
//   paths.create({points, closed})  a new Path through 78's own createPath (one replicated undo step).
//   colliderGeometry(opts)          the STATIC colliders + terrain as world triangles (a navmesh bake's
//                                   input), plus the MOVING solids (dynamic bodies, flow-animated
//                                   objects) a bake must treat as temporary obstacles, and a cheap
//                                   signature so a module can rebake on edit (debounced) only.
//   players()                       every player's place: this peer's camera + every open peer's
//                                   avatar (the kit's nearestPlayer rule, kit/entityApp.js).
//   isAuthority()                   the kit authority (physics initiator, else the lowest peer id) —
//                                   the one peer that steps a shared simulation (kit/runtime.js).
//   isExport()                      an exported game (debug views must never draw there).
//   registerViewToggle(spec)        a row in the viewport menu's View submenu (LOCAL state).
//   registerObjectAction(spec)      a row in the object menu + a UI-less `apply` for the agent tools.

import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, globalScene, globalCamera } from '../../stores/sceneStore';
import { peers } from '../../stores/appStore';
import { pathOf, pathObjectsIn } from '../path/pathRuntime.js';
import { isPathObject } from '../path/pathCore.js';
import { kitIsAuthority } from '../kit/runtime.js';
import { exportMode } from '../export/exportBoot.js';
import { addViewToggle, addObjectAction } from '../moduleWorldItems.js';

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
async function colliderGeometry(opts = {}) {
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

/** every player's place in WORLD space: this peer's camera + each open peer's avatar
 * @returns {{id: string, pos: number[], me: boolean}[]} */
function players() {
	/** @type {{id: string, pos: number[], me: boolean}[]} */
	const out = [];
	const p = /** @type {any} */ (get(peers));
	const myId = p?.peer?.id ?? '';
	const cam = /** @type {any} */ (get(globalCamera));
	if (cam?.getWorldPosition)
		out.push({
			id: myId || 'me',
			pos: cam.getWorldPosition(new THREE.Vector3()).toArray(),
			me: true
		});
	const scene = /** @type {any} */ (get(globalScene));
	for (const id of p?.openedPeers ?? []) {
		const avatar = scene?.getObjectByName(String(id));
		if (avatar?.getWorldPosition)
			out.push({
				id: String(id),
				pos: avatar.getWorldPosition(new THREE.Vector3()).toArray(),
				me: false
			});
	}
	return out;
}

/** @param {import('./context.js').SdkContext} ctx */
export function sdkGameWorld(ctx) {
	const { moduleId, onDispose } = ctx;
	return {
		/** 61-nav: 78's Path objects, read through pathOf (F9) — `{uuid, name, points: [{pos (WORLD), …extras}], closed, mode,
		 * speed, length, period, poseAt(t, {start, offset}), eventsBetween(a, b, o)}` or null. */
		paths: Object.freeze({
			/** @param {string} uuid */
			of: (uuid) => pathOf(get(objectsGroup), String(uuid ?? '')),
			/** every Path object: `[{uuid, name}]` (a sheet's picker) */
			list: () =>
				pathObjectsIn(get(objectsGroup)).map((o) => ({ uuid: o.uuid, name: o.name || 'Path' })),
			/**
			 * A new Path object through 78's own `createPath` (the replicated `/create Path` + one spline
			 * edit, ONE undo step): `points` are WORLD `[x, y, z]` (2..200).
			 * @param {{points: number[][], closed?: boolean, name?: string}} spec
			 * @returns {Promise<string | null>} the new path's uuid
			 */
			async create(spec) {
				const { createPath } = await import('../path/pathActions.js');
				const points = (Array.isArray(spec?.points) ? spec.points : [])
					.slice(0, 200)
					.map((p) => [+p?.[0] || 0, +p?.[1] || 0, +p?.[2] || 0]);
				if (points.length < 2) return null;
				const r = /** @type {any} */ (
					createPath({
						points,
						closed: !!spec?.closed,
						name: spec?.name ? String(spec.name).slice(0, 60) : undefined
					})
				);
				return r?.object?.uuid ?? null;
			}
		}),
		colliderGeometry,
		players,
		/** is THIS peer the kit authority (physics initiator, else the lowest peer id; alone = yes)? */
		isAuthority() {
			return kitIsAuthority();
		},
		/** an exported game (the play-only runtime)? Debug views never draw there. */
		isExport() {
			return !!exportMode;
		},
		/**
		 * A row in the viewport menu's View submenu. LOCAL: `get()` says whether it is on for this
		 * viewer, `set(on)` changes it; core never stores it. Re-registering the same id replaces it.
		 * @param {{id: string, label: string, tooltip?: string, get: () => boolean, set: (on: boolean) => void}} spec
		 * @returns {string} the namespaced key
		 */
		registerViewToggle(spec) {
			const id = String(spec?.id ?? 'toggle');
			const key = 'mod-' + moduleId + '-' + id;
			const off = addViewToggle({
				key,
				moduleId,
				id,
				label: String(spec?.label ?? id).slice(0, 60),
				tooltip: spec?.tooltip ? String(spec.tooltip).slice(0, 200) : '',
				get: () => {
					try {
						return !!spec.get();
					} catch {
						return false;
					}
				},
				set: (on) => spec.set(!!on)
			});
			onDispose(off, 'viewToggle', { key: 'viewToggle:' + key });
			return key;
		},
		/**
		 * A row in the object menu ("Make this an enemy…"): `open(uuid)` is the person's door (your
		 * sheet), `apply(uuid, spec)` the same recipe without UI (the agent tools call it), `when(uuid)`
		 * hides the row for objects it does not fit. The key is `<moduleId>:<id>`.
		 * @param {{id: string, label: string, icon?: string, tooltip?: string, when?: (uuid: string) => boolean,
		 *   open: (uuid: string) => void, apply?: (uuid: string, spec: any) => any}} spec
		 * @returns {string}
		 */
		registerObjectAction(spec) {
			const id = String(spec?.id ?? 'action');
			const key = moduleId + ':' + id;
			const off = addObjectAction({
				key,
				moduleId,
				id,
				label: String(spec?.label ?? id).slice(0, 60),
				icon: spec?.icon ? String(spec.icon) : 'box',
				tooltip: spec?.tooltip ? String(spec.tooltip).slice(0, 200) : '',
				when: typeof spec?.when === 'function' ? spec.when : undefined,
				open: spec.open,
				apply: typeof spec?.apply === 'function' ? spec.apply : undefined
			});
			onDispose(off, 'objectAction', { key: 'objectAction:' + key });
			return key;
		}
	};
}

/** 34 R6 (T2): what each member does to the module's lifecycle (sdk/lifecycle.js SURFACE_KINDS). */
sdkGameWorld.surface = {
	'paths.of': 'read',
	'paths.list': 'read',
	'paths.create': 'content',
	colliderGeometry: 'read',
	players: 'read',
	isAuthority: 'read',
	isExport: 'read',
	registerViewToggle: 'registers',
	registerObjectAction: 'registers'
};
