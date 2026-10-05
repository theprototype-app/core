// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { allNodes, allEdges, SCENE_GRAPH, flowGraphs } from '../../stores/flowStore';
import {
	normalizeJiggle,
	jiggleState,
	stepJiggle,
	wobbleOf,
	boneMatcher,
	JIGGLE_VERTEX,
	JIGGLE_UNIFORMS_DECL
} from './jiggleCore.js';

// 36-sim U2b: the JIGGLE runtime — every peer, every frame, LOCAL.
//
// Source of truth: `jiggle` nodes (palette Effects ▸ Jiggle). A node wired into an Object
// Selector jiggles that object; one in an object's own graph with nothing wired jiggles
// its owner (the H1 implicit rule every effect follows). The node data replicates like
// any node; the motion is each peer's own spring over the pose it sees (jiggleCore).
//
// HOW IT DRAWS — never through the object's transform. The transform belongs to the
// editor, physics and the network, and jiggle has to work exactly when one of those is
// moving it (a crate splashing into the pool, a VR grab). So:
//   · MESHES get a vertex-shader displacement (spring lag + squash/stretch, weighted by
//     distance from the pivot). Uniforms must be PER OBJECT, and three only re-uploads
//     material uniforms when the material changes between draws, so each jiggling mesh
//     gets its OWN material clone (the original is put back when the jiggle goes — the
//     clone's later edits are copied onto it, so an Inspector colour change survives).
//   · SKINNED models (bones matching the node's globs, or the chain ends) get a spring
//     per bone: the bone's tip lags and the bone turns toward it, applied on top of
//     whatever posed it this frame (a mixer, or the rest pose).
// Serializers must not bake either: `parkJiggle()` restores bones (materials need
// nothing — GLTF/toJSON never see onBeforeCompile, and the clone carries the same
// parameters).

/** @typedef {{uuid: string, nodeId: string, params: ReturnType<typeof normalizeJiggle>}} JiggleTarget */
/** @typedef {{state: import('./jiggleCore.js').JiggleState, params: ReturnType<typeof normalizeJiggle>,
 *   meshes: {mesh: any, original: any, clone: any, uniforms: any}[],
 *   bones: {bone: any, rest: THREE.Quaternion, written: THREE.Quaternion, tip: THREE.Vector3 | null,
 *     vel: THREE.Vector3, len: number, dir: THREE.Vector3}[],
 *   pivotLocal: THREE.Vector3, radius: number, object: any, lastKick: number[] | null}} JiggleEntry */

/** @type {Map<string, JiggleEntry>} object uuid -> live jiggle */
const live = new Map();
/** @type {JiggleTarget[]} */
let targets = [];
// the node scan runs when a graph changed, not per frame (allNodes walks every graph)
let targetsDirty = true;
flowGraphs.subscribe(() => {
	targetsDirty = true;
});

/**
 * Resolve the jiggle nodes to their target objects (same rules as the effect runtime:
 * an Object Selector edge wins, else the graph owner). Cheap enough per frame for the
 * handful of jiggle nodes a scene has; the caller throttles anyway.
 * @returns {JiggleTarget[]}
 */
export function jiggleTargets() {
	const nodes = allNodes();
	/** @type {any[]} */
	const jiggles = nodes.filter((n) => n.type === 'jiggle');
	if (!jiggles.length) return [];
	const edges = allEdges();
	/** @type {Map<string, any>} */
	const byId = new Map(nodes.map((n) => [n.id, n]));
	/** @type {JiggleTarget[]} */
	const out = [];
	for (const node of jiggles) {
		const params = normalizeJiggle(node.data);
		let wired = false;
		for (const e of edges) {
			if (e.source !== node.id) continue;
			const sel = byId.get(e.target);
			if (sel?.type !== 'objectselector') continue;
			wired = true;
			const uuid = sel.data?.selected;
			if (uuid && uuid !== '-None-') out.push({ uuid, nodeId: node.id, params });
		}
		const graph = node.__graph;
		if (!wired && graph && graph !== SCENE_GRAPH) out.push({ uuid: graph, nodeId: node.id, params });
	}
	return out;
}

const box = new THREE.Box3();
const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const q1 = new THREE.Quaternion();
const q2 = new THREE.Quaternion();
const m1 = new THREE.Matrix4();

/** the jiggle pivot + radius in the OBJECT's local frame @param {any} object @param {string} pivot */
function pivotOf(object, pivot) {
	object.updateWorldMatrix(true, true);
	box.makeEmpty();
	m1.copy(object.matrixWorld).invert();
	object.traverse((/** @type {any} */ o) => {
		if (!o.isMesh || !o.geometry) return;
		if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
		const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld).applyMatrix4(m1);
		box.union(b);
	});
	if (box.isEmpty()) box.set(v1.set(-0.5, -0.5, -0.5), v2.set(0.5, 0.5, 0.5));
	const center = box.getCenter(new THREE.Vector3());
	const size = box.getSize(new THREE.Vector3());
	const at = center.clone();
	if (pivot === 'bottom') at.y = box.min.y;
	else if (pivot === 'top') at.y = box.max.y;
	// the radius: the farthest corner from the pivot, so the far end weighs 1
	let radius = 0;
	for (let i = 0; i < 8; i++) {
		v1.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
		radius = Math.max(radius, v1.distanceTo(at));
	}
	return { pivotLocal: at, radius: Math.max(radius, 1e-3), size };
}

/** @param {any} mesh @param {any} object @param {THREE.Vector3} pivotLocal @param {number} radius */
function attachMesh(mesh, object, pivotLocal, radius) {
	const original = mesh.material;
	if (!original || Array.isArray(original)) return null; // multi-material: bones/skip (documented)
	const clone = original.clone();
	clone.userData = { ...(original.userData ?? {}), __jiggleClone: true };
	// pivot in the MESH's local frame (the shader works in mesh space)
	mesh.updateWorldMatrix(true, false);
	const toMesh = new THREE.Matrix4().copy(mesh.matrixWorld).invert().multiply(object.matrixWorld);
	const pivotMesh = pivotLocal.clone().applyMatrix4(toMesh);
	const scaleMesh = new THREE.Vector3().setFromMatrixScale(toMesh);
	const uniforms = {
		jOffset: { value: new THREE.Vector3() },
		jPivot: { value: pivotMesh },
		jRadius: { value: radius * Math.max(scaleMesh.x, scaleMesh.y, scaleMesh.z) },
		jFalloff: { value: 1.5 },
		jWobble: { value: 0 }
	};
	const previous = original.onBeforeCompile;
	clone.onBeforeCompile = (/** @type {any} */ shader, /** @type {any} */ renderer) => {
		if (typeof previous === 'function' && previous !== THREE.Material.prototype.onBeforeCompile) previous(shader, renderer);
		Object.assign(shader.uniforms, uniforms);
		shader.vertexShader = JIGGLE_UNIFORMS_DECL + shader.vertexShader.replace('#include <begin_vertex>', JIGGLE_VERTEX);
	};
	const baseKey = original.customProgramCacheKey?.() ?? '';
	clone.customProgramCacheKey = () => baseKey + '|jiggle1';
	mesh.material = clone;
	return { mesh, original, clone, uniforms };
}

/** @param {{mesh: any, original: any, clone: any}} m */
function detachMesh(m) {
	if (m.mesh.material !== m.clone) return; // something else replaced it since; leave it
	// carry what was edited on the clone back onto the original (a colour change made
	// while it jiggled), minus the shader hook
	const { onBeforeCompile, customProgramCacheKey } = m.original;
	m.original.copy(m.clone);
	m.original.onBeforeCompile = onBeforeCompile;
	m.original.customProgramCacheKey = customProgramCacheKey;
	m.original.userData = { ...(m.clone.userData ?? {}) };
	delete m.original.userData.__jiggleClone;
	m.original.needsUpdate = true;
	m.mesh.material = m.original;
	m.clone.dispose();
}

/** bones to spring: the globs, else every bone within two links of a chain end
 * @param {any} object @param {string} spec */
function pickBones(object, spec) {
	const match = boneMatcher(spec);
	/** @type {Set<any>} */
	const bones = new Set();
	object.traverse((/** @type {any} */ o) => {
		if (!o.isSkinnedMesh || !o.skeleton) return;
		for (const bone of o.skeleton.bones) {
			if (!bone.parent?.isBone) continue; // a root never swings
			if (match) {
				if (match(bone.name)) bones.add(bone);
				continue;
			}
			const kids = bone.children.filter((/** @type {any} */ c) => c.isBone);
			if (kids.length) continue;
			// a chain end, plus its parent (the tail and the link before it)
			bones.add(bone);
			if (bone.parent?.parent?.isBone) bones.add(bone.parent);
		}
	});
	return [...bones];
}

/** @param {any} object @param {ReturnType<typeof normalizeJiggle>} params @returns {JiggleEntry} */
function attach(object, params) {
	const { pivotLocal, radius } = pivotOf(object, params.pivot);
	/** @type {JiggleEntry['meshes']} */
	const meshes = [];
	object.traverse((/** @type {any} */ o) => {
		if (!o.isMesh || o.isSkinnedMesh || o.userData?.__waterVisual || o.userData?.__fluidVisual) return;
		const m = attachMesh(o, object, pivotLocal, radius);
		if (m) meshes.push(m);
	});
	const bones = pickBones(object, params.bones).map((bone) => {
		const child = bone.children.find((/** @type {any} */ c) => c.isBone);
		// the bone's own direction: toward its child, else continue the parent->bone line
		const dir = child ? child.position.clone() : bone.position.clone();
		const len = Math.max(dir.length(), 0.02);
		return {
			bone,
			rest: bone.quaternion.clone(),
			written: bone.quaternion.clone(),
			tip: /** @type {THREE.Vector3 | null} */ (null),
			vel: new THREE.Vector3(),
			len,
			dir: dir.lengthSq() > 1e-10 ? dir.normalize() : new THREE.Vector3(0, 1, 0)
		};
	});
	return { state: jiggleState(), params, meshes, bones, pivotLocal, radius, object, lastKick: null };
}

/** @param {JiggleEntry} entry */
function detach(entry) {
	entry.meshes.forEach(detachMesh);
	for (const b of entry.bones) if (b.bone.quaternion.equals(b.written)) b.bone.quaternion.copy(b.rest);
}

/**
 * A grab yank or an impact the caller knows about (VR grab start, an On Impact): adds a
 * velocity kick so the jiggle reacts even when the pose change itself was small.
 * @param {string} uuid @param {number[]} kick m/s
 */
export function kickJiggle(uuid, kick) {
	const entry = live.get(uuid);
	if (entry) entry.lastKick = kick;
}

const anchorWorld = new THREE.Vector3();
const anchorArr = [0, 0, 0];
const offWorld = new THREE.Vector3();
const objQuatInv = new THREE.Quaternion();
const objScale = new THREE.Vector3();
const tipTarget = new THREE.Vector3();
const bonePos = new THREE.Vector3();
const boneQuat = new THREE.Quaternion();
const parentQuat = new THREE.Quaternion();
const fromDir = new THREE.Vector3();
const toDir = new THREE.Vector3();
let lastTime = 0;

/**
 * The per-frame tick (Scene's useTask through tickSim). `root` = the scene objects group.
 * @param {any} root @param {number} now ms
 */
export function tickJiggle(root, now) {
	const dt = lastTime ? Math.min((now - lastTime) / 1000, 0.1) : 1 / 60;
	lastTime = now;
	if (!root) targets = [];
	else if (targetsDirty) {
		targetsDirty = false;
		targets = jiggleTargets();
	}
	if (!targets.length && !live.size) return;
	/** @type {Set<string>} */
	const want = new Set();
	for (const t of targets) {
		if (want.has(t.uuid)) continue; // two nodes on one object: the first wins
		want.add(t.uuid);
		const object = root.getObjectByProperty('uuid', t.uuid);
		if (!object) continue;
		let entry = live.get(t.uuid);
		// pivot/bones changed, or the object was swapped under us (a model reload)
		if (entry && (entry.object !== object || entry.params.pivot !== t.params.pivot || entry.params.bones !== t.params.bones)) {
			detach(entry);
			live.delete(t.uuid);
			entry = undefined;
		}
		if (!entry) {
			entry = attach(object, t.params);
			live.set(t.uuid, entry);
		}
		entry.params = t.params;
		tickEntry(entry, dt, now / 1000);
	}
	for (const [uuid, entry] of live)
		if (!want.has(uuid)) {
			detach(entry);
			live.delete(uuid);
		}
}

/** @param {JiggleEntry} entry @param {number} dt @param {number} time */
function tickEntry(entry, dt, time) {
	const { object, params, state } = entry;
	object.updateWorldMatrix(true, false);
	anchorWorld.copy(entry.pivotLocal).applyMatrix4(object.matrixWorld);
	anchorArr[0] = anchorWorld.x;
	anchorArr[1] = anchorWorld.y;
	anchorArr[2] = anchorWorld.z;
	stepJiggle(state, anchorArr, params, dt, time, entry.lastKick ?? undefined);
	entry.lastKick = null;
	// world offset -> object local (rotation + scale out)
	object.matrixWorld.decompose(v1, objQuatInv, objScale);
	objQuatInv.invert();
	offWorld.set(state.d[0], state.d[1], state.d[2]).applyQuaternion(objQuatInv);
	offWorld.set(offWorld.x / (objScale.x || 1), offWorld.y / (objScale.y || 1), offWorld.z / (objScale.z || 1));
	const wobble = wobbleOf(state, params);
	for (const m of entry.meshes) {
		m.uniforms.jOffset.value.copy(offWorld);
		m.uniforms.jFalloff.value = params.falloff;
		m.uniforms.jWobble.value = wobble;
	}
	if (entry.bones.length) tickBones(entry, dt);
}

/** a spring per bone tip; the bone turns toward its lagging tip @param {JiggleEntry} entry @param {number} dt */
function tickBones(entry, dt) {
	const { params } = entry;
	const k = params.stiffness;
	const c = 2 * params.damping * Math.sqrt(k);
	const gy = -9.81 * params.gravity;
	for (const b of entry.bones) {
		const bone = b.bone;
		// whoever posed the bone this frame (a mixer) owns its base; else back to rest
		if (!bone.quaternion.equals(b.written)) b.rest.copy(bone.quaternion);
		else bone.quaternion.copy(b.rest);
		bone.updateWorldMatrix(true, false);
		bone.matrixWorld.decompose(bonePos, boneQuat, v1);
		tipTarget.copy(b.dir).multiplyScalar(b.len * v1.x).applyQuaternion(boneQuat).add(bonePos);
		if (!b.tip || b.tip.distanceToSquared(tipTarget) > 9) {
			b.tip = tipTarget.clone();
			b.vel.set(0, 0, 0);
		}
		// spring the tip toward where the pose puts it
		v2.copy(tipTarget).sub(b.tip).multiplyScalar(k);
		v2.addScaledVector(b.vel, -c);
		v2.y += gy;
		b.vel.addScaledVector(v2, dt);
		b.tip.addScaledVector(b.vel, dt);
		// keep the bone's length; limit the swing by maxOffset
		toDir.copy(b.tip).sub(bonePos);
		const lenW = b.len * v1.x;
		if (toDir.lengthSq() < 1e-12) continue;
		toDir.setLength(lenW);
		const off = v2.copy(bonePos).add(toDir).sub(tipTarget);
		if (off.length() > params.maxOffset) {
			off.setLength(params.maxOffset);
			toDir.copy(tipTarget).add(off).sub(bonePos).setLength(lenW);
		}
		b.tip.copy(bonePos).add(toDir);
		// world rotation from the posed direction to the lagging one, folded into local
		fromDir.copy(tipTarget).sub(bonePos).normalize();
		q1.setFromUnitVectors(fromDir, toDir.normalize());
		bone.parent.getWorldQuaternion(parentQuat);
		q2.copy(parentQuat).invert().multiply(q1).multiply(parentQuat);
		bone.quaternion.premultiply(q2);
		b.written.copy(bone.quaternion);
	}
}

/**
 * Serializers (peer sync, GLTF save, autosave, sessions) must not bake a swung bone as
 * the model's rest pose. Returns an idempotent restore (the parkAnimatedAtBase shape).
 */
export function parkJiggle() {
	/** @type {{bone: any, q: THREE.Quaternion}[]} */
	const parked = [];
	for (const entry of live.values())
		for (const b of entry.bones) {
			parked.push({ bone: b.bone, q: b.bone.quaternion.clone() });
			b.bone.quaternion.copy(b.rest);
			b.bone.updateMatrix();
		}
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		for (const p of parked) p.bone.quaternion.copy(p.q);
	};
}

/** TEST/DEBUG: what is jiggling, with its live numbers */
export function jiggleDebug() {
	return [...live.entries()].map(([uuid, e]) => ({
		uuid,
		offset: e.state.d.slice(),
		excite: e.state.excite,
		wobble: wobbleOf(e.state, e.params),
		meshes: e.meshes.length,
		bones: e.bones.length,
		cloned: e.meshes.every((m) => m.mesh.material === m.clone)
	}));
}

/** drop everything (scene switch / tests) */
export function resetJiggle() {
	for (const entry of live.values()) detach(entry);
	live.clear();
	lastTime = 0;
}
