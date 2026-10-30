// 57 M6 — RIG FIX-UPS, the session: what the Skeleton view does to a model. LAZY (the view imports
// it; a player of an exported game never downloads it).
//
// Every edit is ONE operation on the model's FILE (rigOps.js), sent once when it ends: the new
// bytes replace the old on every peer (animatedImports.replaceAnimatedBytes, undoable as one step),
// and a provenance step records it ({tool: 'rig-fix', model: <op>}). A brush STROKE paints the live
// mesh locally while the pointer moves (no shared live painting) and is written when it lifts.
// The helpers drawn while the view is open (the skeleton lines, the picked bone) live at the scene
// ROOT under a fixed name — local, never replicated (CLAUDE.md rule 5).

import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import { objectsGroup, globalScene, pokeScene } from '../../stores/sceneStore';
import { showToast } from '../../stores/appStore';
import {
	animatedImportPayload,
	animatedImportKind,
	restRowsOf,
	replaceAnimatedBytes,
	setAnimationState,
	animatedObjects
} from '../animatedImports';
import { isGlb } from '../download/glbEdit.js';
import * as ops from './rigOps.js';
import { normalizeWeights, brushWeights } from './weightsCore.js';
import { addProvenance } from '../provenance.js';
import { APP_VERSION } from '../version';

const HELPER_NAME = 'rig-fix-helpers';

/** the picked bone of the open view ('' = none) */
export const pickedBone = writable('');
/** an operation is running (the view greys its buttons) */
export const rigBusy = writable(false);

/** @param {string} uuid */
function rootOf(uuid) {
	return /** @type {any} */ (get(objectsGroup))?.getObjectByProperty('uuid', uuid) ?? null;
}

/**
 * The view's model: the bone tree (from the rest rows), whether the file can be edited here.
 * @param {string} uuid
 */
export function rigInfo(uuid) {
	const rows = restRowsOf(uuid);
	const bytes = animatedImportPayload(uuid);
	const depth = rows.map((r) => {
		let d = 0;
		for (let p = r.parent; p >= 0; p = rows[p].parent) d++;
		return d;
	});
	return {
		uuid,
		kind: animatedImportKind(uuid),
		editable: !!bytes && isGlb(bytes),
		bones: rows.map((r, i) => ({
			name: r.name,
			parent: r.parent >= 0 ? rows[r.parent].name : '',
			depth: depth[i],
			bone: r.bone,
			t: r.t
		}))
	};
}

/**
 * Run one file edit and send it.
 * @param {string} uuid @param {string} label @param {(bytes: ArrayBuffer) => Uint8Array | Promise<Uint8Array>} fn
 */
async function runOp(uuid, label, fn) {
	const root = rootOf(uuid);
	const bytes = animatedImportPayload(uuid);
	if (!root || !bytes) return false;
	if (!isGlb(bytes)) {
		showToast('Rig fix-ups edit GLB / VRM files — download this one as GLB and import that.');
		return false;
	}
	rigBusy.set(true);
	try {
		const next = await fn(bytes);
		addProvenance(root.userData, {
			tool: 'rig-fix',
			model: label,
			version: APP_VERSION,
			source: root.name
		});
		const { forgetHumanoid } = await import('../humanoid/humanoidRig.js');
		forgetHumanoid(uuid);
		const ab = /** @type {ArrayBuffer} */ (
			next.buffer.slice(next.byteOffset, next.byteOffset + next.byteLength)
		);
		const ok = await replaceAnimatedBytes(uuid, ab, { label });
		refreshHelpers(uuid);
		pokeScene();
		return ok;
	} catch (error) {
		showToast(label + ' failed: ' + String(/** @type {any} */ (error)?.message ?? error));
		return false;
	} finally {
		rigBusy.set(false);
	}
}

/** rename a bone; a humanoid map fix naming it follows @param {string} uuid @param {string} bone @param {string} name */
export async function renameBone(uuid, bone, name) {
	const ok = await runOp(uuid, 'rename bone', (b) => ops.renameBone(b, bone, name));
	if (ok) {
		const { configOf, applyHumanoidConfig } = await import('../humanoid/humanoidRig.js');
		const cfg = configOf(uuid);
		if (cfg.map && Object.values(cfg.map).includes(bone)) {
			const map = Object.fromEntries(
				Object.entries(cfg.map).map(([k, v]) => [k, v === bone ? name : v])
			);
			applyHumanoidConfig(uuid, { ...cfg, map }, { history: false });
		}
		pickedBone.set(name);
	}
	return ok;
}

/** @param {string} uuid @param {string} bone @param {number[]} t */
export const moveBone = (uuid, bone, t) =>
	runOp(uuid, 'move bone', (b) => ops.moveBoneRest(b, bone, t));
/** @param {string} uuid @param {string} parent @param {string} name @param {number[]} [offset] */
export const addBone = (uuid, parent, name, offset) =>
	runOp(uuid, 'add bone', (b) => ops.addBone(b, parent, name, offset));
/** @param {string} uuid @param {string} bone */
export const deleteBone = (uuid, bone) =>
	runOp(uuid, 'delete bone', (b) => ops.deleteBone(b, bone));
/** @param {string} uuid @param {'left'|'right'} from */
export const mirrorBones = (uuid, from) =>
	runOp(uuid, 'mirror ' + from + ' to ' + (from === 'left' ? 'right' : 'left'), (b) => {
		const r = ops.mirrorBones(b, from);
		if (!r.pairs.length) throw new Error('no left / right bone pairs found by name');
		return r.bytes;
	});

// ---- weights ---------------------------------------------------------------------------------

/** the model's skinned meshes that map to a glTF primitive @param {string} uuid @returns {any[]} */
function skinnedMeshes(uuid) {
	/** @type {any[]} */
	const out = [];
	rootOf(uuid)?.traverse(
		(/** @type {any} */ o) =>
			o.isSkinnedMesh && Array.isArray(o.userData.gltfPrimitive) && out.push(o)
	);
	return out;
}

/** bind-space vertex positions + triangles of a skinned mesh @param {any} mesh */
function bindGeometry(mesh) {
	const pos = mesh.geometry.attributes.position;
	const out = new Float32Array(pos.count * 3);
	const v = new THREE.Vector3();
	for (let i = 0; i < pos.count; i++) {
		v.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix);
		out[i * 3] = v.x;
		out[i * 3 + 1] = v.y;
		out[i * 3 + 2] = v.z;
	}
	const index = mesh.geometry.index ? new Uint32Array(mesh.geometry.index.array) : null;
	return { positions: out, index };
}

/** helpers that must not deform the mesh @param {string} name */
const NOT_DEFORMING = /(^root$|ik|control|slot|pole|target|roll|_end$|end$)/i;

/** bone segments in bind space (head = the joint, tail = its children's mean, or one bone-length on) @param {any} mesh */
function boneSegments(mesh) {
	const bones = mesh.skeleton.bones;
	const heads = mesh.skeleton.boneInverses.map((/** @type {THREE.Matrix4} */ inv) =>
		new THREE.Vector3().setFromMatrixPosition(inv.clone().invert())
	);
	return bones.map((/** @type {any} */ b, /** @type {number} */ i) => {
		if (NOT_DEFORMING.test(b.name)) return null;
		const kids = bones
			.map((/** @type {any} */ c, /** @type {number} */ j) => (c.parent === b ? j : -1))
			.filter((/** @type {number} */ j) => j >= 0);
		const head = heads[i];
		let tail;
		if (kids.length)
			tail = kids
				.reduce(
					(/** @type {THREE.Vector3} */ s, /** @type {number} */ j) => s.add(heads[j]),
					new THREE.Vector3()
				)
				.multiplyScalar(1 / kids.length);
		else {
			const p = bones.indexOf(b.parent);
			tail =
				p >= 0
					? head.clone().add(head.clone().sub(heads[p]).multiplyScalar(0.5))
					: head.clone().add(new THREE.Vector3(0, 0.05, 0));
		}
		return { head: head.toArray(), tail: tail.toArray() };
	});
}

/** @type {Worker | null} */
let worker = null;
let nextId = 1;
/** a worker job @param {any} msg @param {Transferable[]} transfer @returns {Promise<{joints: Uint16Array, weights: Float32Array}>} */
function work(msg, transfer) {
	if (!worker)
		worker = new Worker(new URL('./weightsWorker.js', import.meta.url), { type: 'module' });
	const w = worker;
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const onMessage = (/** @type {MessageEvent} */ e) => {
			if (e.data?.id !== id) return;
			w.removeEventListener('message', onMessage);
			if (e.data.error) reject(new Error(e.data.error));
			else resolve(e.data);
		};
		w.addEventListener('message', onMessage);
		w.postMessage({ ...msg, id }, transfer);
	});
}

/** write per-mesh weights into the file @param {ArrayBuffer} bytes @param {{mesh: any, joints: Uint16Array, weights: Float32Array}[]} rows */
function writeWeights(bytes, rows) {
	/** @type {Uint8Array | ArrayBuffer} */
	let b = bytes;
	for (const { mesh, joints, weights } of rows) {
		const [m, p] = mesh.userData.gltfPrimitive;
		b = ops.setPrimitiveWeights(b, m, p, joints, weights);
	}
	return /** @type {Uint8Array} */ (b);
}

/** Automatic weights (heat diffusion, in a worker) for every skinned mesh @param {string} uuid */
export function autoWeights(uuid) {
	return runOp(uuid, 'automatic weights', async (bytes) => {
		const meshes = skinnedMeshes(uuid);
		if (!meshes.length) throw new Error('no skinned mesh to weight');
		const rows = [];
		for (const mesh of meshes) {
			const g = bindGeometry(mesh);
			const out = await work(
				{ op: 'heat', positions: g.positions, index: g.index, bones: boneSegments(mesh) },
				[g.positions.buffer, ...(g.index ? [g.index.buffer] : [])]
			);
			rows.push({ mesh, ...out });
		}
		return writeWeights(bytes, rows);
	});
}

/** current skin attributes of a mesh as vec4 arrays @param {any} mesh */
function currentWeights(mesh) {
	const si = mesh.geometry.attributes.skinIndex;
	const sw = mesh.geometry.attributes.skinWeight;
	return { joints: new Uint16Array(si.array), weights: new Float32Array(sw.array) };
}

/** Smooth every mesh's weights @param {string} uuid */
export function smoothAll(uuid) {
	return runOp(uuid, 'smooth weights', async (bytes) => {
		const rows = [];
		for (const mesh of skinnedMeshes(uuid)) {
			const g = bindGeometry(mesh);
			const cur = currentWeights(mesh);
			const out = await work(
				{
					op: 'smooth',
					positions: g.positions,
					index: g.index,
					joints: cur.joints,
					weights: cur.weights,
					steps: 3
				},
				[g.positions.buffer, cur.joints.buffer, cur.weights.buffer]
			);
			rows.push({ mesh, ...out });
		}
		return writeWeights(bytes, rows);
	});
}

/** Normalize every mesh's weights @param {string} uuid */
export function normalizeAll(uuid) {
	return runOp(uuid, 'normalize weights', (bytes) =>
		writeWeights(
			bytes,
			skinnedMeshes(uuid).map((mesh) => {
				const cur = currentWeights(mesh);
				return { mesh, ...normalizeWeights(cur.joints, cur.weights) };
			})
		)
	);
}

// ---- the brush -------------------------------------------------------------------------------

/** @type {{uuid: string, bone: string, meshes: {mesh: any, positions: Float32Array}[], dirty: boolean} | null} */
let stroke = null;

/**
 * Start a stroke (the model stops its clip: the brush paints the REST pose).
 * @param {string} uuid @param {string} bone
 */
export function beginStroke(uuid, bone) {
	const state = get(animatedObjects)[uuid];
	if (state?.playing) setAnimationState(uuid, { playing: false });
	stroke = {
		uuid,
		bone,
		meshes: skinnedMeshes(uuid).map((mesh) => ({ mesh, positions: bindGeometry(mesh).positions })),
		dirty: false
	};
}

/**
 * Paint at a world point. LOCAL (the live attributes); the file is written on endStroke.
 * @param {number[]} world @param {number} radius world units @param {number} strength -1..1
 */
export function strokeAt(world, radius, strength) {
	if (!stroke) return 0;
	let touched = 0;
	for (const { mesh, positions } of stroke.meshes) {
		const k = mesh.skeleton.bones.findIndex((/** @type {any} */ b) => b.name === stroke?.bone);
		if (k < 0) continue;
		const local = mesh.worldToLocal(new THREE.Vector3(...world)).applyMatrix4(mesh.bindMatrix);
		const si = mesh.geometry.attributes.skinIndex;
		const sw = mesh.geometry.attributes.skinWeight;
		const J = new Uint16Array(si.array);
		const W = new Float32Array(sw.array);
		const n = brushWeights(positions, J, W, local.toArray(), radius, k, strength);
		if (!n) continue;
		si.array.set(J);
		sw.array.set(W);
		si.needsUpdate = true;
		sw.needsUpdate = true;
		touched += n;
		stroke.dirty = true;
	}
	return touched;
}

/** End the stroke: write the painted weights into the file and send it (one undo step) */
export async function endStroke() {
	const s = stroke;
	stroke = null;
	if (!s?.dirty) return false;
	return runOp(s.uuid, 'paint weights', (bytes) =>
		writeWeights(
			bytes,
			s.meshes.map(({ mesh }) => ({ mesh, ...currentWeights(mesh) }))
		)
	);
}

// ---- the test pose + helpers -----------------------------------------------------------------

/** @type {Map<any, THREE.Quaternion>} bone -> its quaternion before the test pose */
const posed = new Map();

/**
 * Bend a bone for a look (LOCAL, never sent; cleared when the view closes or an edit lands).
 * @param {string} uuid @param {string} bone @param {number} degrees about its local X
 */
export function testPose(uuid, bone, degrees) {
	const b = rootOf(uuid)?.getObjectByName(bone);
	if (!b) return;
	const state = get(animatedObjects)[uuid];
	if (state?.playing) setAnimationState(uuid, { playing: false });
	if (!posed.has(b)) posed.set(b, b.quaternion.clone());
	const base = /** @type {THREE.Quaternion} */ (posed.get(b));
	b.quaternion
		.copy(base)
		.multiply(
			new THREE.Quaternion().setFromAxisAngle(
				new THREE.Vector3(1, 0, 0),
				THREE.MathUtils.degToRad(degrees)
			)
		);
	pokeScene();
}

export function clearTestPose() {
	for (const [b, q] of posed) b.quaternion.copy(q);
	posed.clear();
}

/** draw the skeleton (+ the picked bone) at the scene root @param {string} uuid */
export function refreshHelpers(uuid) {
	clearHelpers();
	const root = rootOf(uuid);
	const scene = /** @type {any} */ (get(globalScene));
	if (!root || !scene) return;
	const group = new THREE.Group();
	group.name = HELPER_NAME;
	const helper = new THREE.SkeletonHelper(root);
	/** @type {any} */ (helper.material).depthTest = false;
	helper.renderOrder = 999;
	group.add(helper);
	const picked = get(pickedBone);
	const bone = picked ? root.getObjectByName(picked) : null;
	if (bone) {
		const marker = new THREE.Mesh(
			new THREE.SphereGeometry(0.03, 12, 8),
			new THREE.MeshBasicMaterial({ color: 0xffaa00, depthTest: false })
		);
		marker.name = 'rig-fix-picked';
		marker.renderOrder = 1000;
		marker.onBeforeRender = () => {
			bone.getWorldPosition(marker.position);
		};
		group.add(marker);
	}
	scene.add(group);
	pokeScene();
}

export function clearHelpers() {
	const scene = /** @type {any} */ (get(globalScene));
	const old = scene?.getObjectByName(HELPER_NAME);
	if (!old) return;
	scene.remove(old);
	old.traverse((/** @type {any} */ o) => {
		o.geometry?.dispose?.();
		o.material?.dispose?.();
	});
}

/** the view closed @param {string} uuid */
export function closeSession(uuid) {
	void uuid;
	clearTestPose();
	clearHelpers();
	pickedBone.set('');
	stroke = null;
}
