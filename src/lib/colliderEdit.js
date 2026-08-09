// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { globalScene, selectedObject, objectsGroup } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordEntry } from './history';
import {
	enterFaceEdit,
	exitFaceEdit,
	faceEditObject,
	readTriangles,
	trisToPositions,
	shellsOfTris,
	registerEditProxy,
	applyMeshGeo
} from './faceEdit';
import { exitEditMode, enterEditMode, editingObject } from './meshEdit';
import { colliderSpecOf, CUSTOM_MAX_FLOATS } from './colliderSpec';
// 15-F: proxy sessions DISCARD their history (the proxy is disposed on exit,
// so its meshgeo entries can never replay)
import { markColliderHistorySession, sealEditHistorySession } from './editSession';

// CL-A A8: custom COMPOUND collider editing. Picking "Custom (edit…)" builds a
// PROXY mesh at the scene root (never in objectsGroup/GLTF sync) seeded from
// the stored collider or the current spec shape, then runs the EXISTING Edit
// Mesh tool on it (the faceEdit/meshEdit lookups accept a registered proxy;
// its uuid is unknown to peers, so replicated edit messages no-op there).
// Done splits the proxy into SHELLS (union-find over welded vertex keys) —
// each shell becomes one convex-hull piece on the same body (rapier compound).
// Concave shapes = decompose by hand, the Unity/UE practice.

/** @type {import('svelte/store').Writable<string|null>} REAL object uuid in a collider session */
export const colliderEditObject = writable(null);

/** @type {any} */ let proxy = null;
/** @type {string|null} */ let targetUuid = null;
/** @type {(() => void)[]} */ let watchUnsubs = [];

// The edit tools own Escape/Done themselves — if BOTH modes drop the proxy
// (Esc pressed, or an external exit) the session is over: tear down + cancel.
// Deferred a tick so the Vertices<->Faces mode switch (exit one, enter the
// other) never reads as an exit.
function watchEditModes() {
	const check = () => {
		setTimeout(() => {
			if (!proxy) return;
			if (get(faceEditObject) !== proxy.uuid && get(editingObject) !== proxy.uuid)
				exitColliderEdit(true);
		}, 0);
	};
	watchUnsubs = [faceEditObject.subscribe(check), editingObject.subscribe(check)];
}

/** @param {string} uuid */
function objectOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;
}

/** Seed geometry for a fresh session (no stored verts): the current spec
 * shape in OBJECT-LOCAL (unscaled) coords — the proxy carries the object's
 * scale so it lines up visually and stored verts stay unscaled.
 * @param {any} object @returns {any} non-indexed BufferGeometry */
function seedGeometry(object) {
	const spec = colliderSpecOf(object, object.userData?.physics?.collider);
	const s = object.scale;
	const sx = Math.max(Math.abs(s.x), 1e-6);
	const sy = Math.max(Math.abs(s.y), 1e-6);
	const sz = Math.max(Math.abs(s.z), 1e-6);
	if (spec?.pieces) {
		// stored custom verts or a hull-eligible mesh: verts are scale-baked in
		// the spec — unbake so the proxy (which carries the scale) matches
		/** @type {number[]} */
		const positions = [];
		for (const piece of spec.pieces)
			for (let i = 0; i < piece.verts.length; i += 3)
				positions.push(piece.verts[i] / sx, piece.verts[i + 1] / sy, piece.verts[i + 2] / sz);
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
		geometry.computeVertexNormals();
		geometry.computeBoundingSphere();
		return geometry;
	}
	const he = spec?.halfExtents ?? new THREE.Vector3(0.5, 0.5, 0.5);
	const local = new THREE.Vector3(he.x / sx, he.y / sy, he.z / sz);
	/** @type {any} */
	let geometry;
	const kind = spec?.kind ?? 'box';
	if (kind === 'sphere') geometry = new THREE.SphereGeometry(Math.max(local.x, local.y, local.z), 8, 6);
	else if (kind === 'capsule') {
		const radius = Math.max(local.x, local.z, 0.02);
		geometry = new THREE.CapsuleGeometry(radius, Math.max((local.y - radius) * 2, 0.02), 3, 8);
	} else if (kind === 'cylinder')
		geometry = new THREE.CylinderGeometry(Math.max(local.x, local.z, 0.02), Math.max(local.x, local.z, 0.02), local.y * 2, 12);
	else geometry = new THREE.BoxGeometry(local.x * 2, local.y * 2, local.z * 2);
	// seat the seed on the AABB center (object-local)
	const center = spec ? object.worldToLocal(spec.center.clone()) : new THREE.Vector3();
	geometry.translate(center.x, center.y, center.z);
	const soup = geometry.toNonIndexed();
	geometry.dispose();
	soup.computeVertexNormals();
	return soup;
}

/**
 * Start a custom-collider edit session on an object: build the proxy, then
 * enter the regular face-edit mode ON the proxy. @param {string} uuid @returns {boolean}
 */
export function enterColliderEdit(uuid) {
	const object = objectOf(uuid);
	const scene = get(globalScene);
	if (!object || !scene) return false;
	if (get(colliderEditObject)) exitColliderEdit(false);
	proxy = new THREE.Mesh(
		seedGeometry(object),
		new THREE.MeshStandardMaterial({
			color: 0x22c55e,
			transparent: true,
			opacity: 0.35,
			depthWrite: false,
			side: THREE.DoubleSide
		})
	);
	proxy.name = 'collider-edit-proxy';
	proxy.position.copy(object.position);
	proxy.quaternion.copy(object.quaternion);
	proxy.scale.copy(object.scale);
	scene.add(proxy);
	registerEditProxy(proxy);
	targetUuid = uuid;
	colliderEditObject.set(uuid);
	enterFaceEdit(proxy.uuid);
	if (get(faceEditObject) !== proxy.uuid) {
		// face edit refused (caps etc.) — abort the session
		exitColliderEdit(false);
		return false;
	}
	watchEditModes();
	markColliderHistorySession(); // 15-F: seal this session with 'discard'
	showToast('Editing the collider — each disconnected shell becomes one convex piece');
	return true;
}

/** Merge a primitive's geometry into the proxy as a NEW shell, seated just
 * OUTSIDE the current content's +X face — spawning at the origin buried the
 * piece inside the seed shell (invisible through the 0.35-opacity material),
 * which made the buttons read as dead (15-A2).
 * @param {'box'|'sphere'} kind */
export function addColliderPiece(kind) {
	if (!proxy) return false;
	const half = kind === 'sphere' ? 0.35 : 0.3;
	const piece =
		kind === 'sphere' ? new THREE.SphereGeometry(0.35, 6, 4) : new THREE.BoxGeometry(0.6, 0.6, 0.6);
	proxy.geometry.computeBoundingBox();
	const bbox = proxy.geometry.boundingBox;
	if (bbox && isFinite(bbox.max.x)) {
		piece.translate(
			bbox.max.x + half + 0.1,
			(bbox.min.y + bbox.max.y) / 2,
			(bbox.min.z + bbox.max.z) / 2
		);
	}
	const soup = piece.toNonIndexed();
	piece.dispose();
	const add = soup.attributes.position.array;
	const cur = proxy.geometry.attributes.position.array;
	const merged = new Float32Array(cur.length + add.length);
	merged.set(cur, 0);
	merged.set(add, cur.length);
	soup.dispose();
	// swap through the meshgeo applier: re-derives the live face-edit session's
	// tris/overlay (the proxy uuid no-ops on peers)
	applyMeshGeo(proxy.uuid, Array.from(merged));
	// vertices mode: applyMeshGeo only rebuilds FACE-mode state — refresh the
	// handle set the weld way (exit+enter is synchronous, so the deferred
	// watchEditModes check never reads it as a session end)
	if (get(editingObject) === proxy.uuid) {
		exitEditMode();
		enterEditMode(proxy.uuid);
	}
	showToast('Added a ' + kind + ' piece — ' + colliderShellCount() + ' shells now');
	return true;
}

/** current shell count of the proxy (toolbar display / tests) */
export function colliderShellCount() {
	if (!proxy) return 0;
	return shellsOfTris(readTriangles(proxy.geometry)).length;
}

/**
 * Commit: split shells, round verts, cap-check, write userData.physics
 * (replicates + records the props undo entry), dispose the proxy.
 * @returns {boolean} false when over the cap (session stays open)
 */
export function commitColliderEdit() {
	const uuid = targetUuid;
	const object = uuid ? objectOf(uuid) : null;
	if (!proxy || !uuid || !object) {
		exitColliderEdit(false);
		return false;
	}
	const tris = readTriangles(proxy.geometry);
	const shells = shellsOfTris(tris);
	/** @type {number[]} */
	const colliderVerts = [];
	/** @type {number[][]} */
	const colliderPieces = [];
	shells.forEach((triIndices) => {
		const start = colliderVerts.length;
		triIndices.forEach((ti) => {
			for (const v of tris[ti])
				colliderVerts.push(
					Math.round(v.x * 1000) / 1000,
					Math.round(v.y * 1000) / 1000,
					Math.round(v.z * 1000) / 1000
				);
		});
		colliderPieces.push([start, colliderVerts.length - start]);
	});
	if (colliderVerts.length > CUSTOM_MAX_FLOATS) {
		showToast(
			'Collider too detailed to store (' +
				colliderVerts.length / 3 +
				' of ' +
				CUSTOM_MAX_FLOATS / 3 +
				' verts) — delete some faces first'
		);
		return false;
	}
	const before = object.userData.physics ? { ...object.userData.physics } : null;
	const next = {
		mode: 'auto',
		...(object.userData.physics ?? {}),
		collider: 'custom',
		colliderVerts,
		colliderPieces
	};
	// 15-F ordering: tear down + SEAL (discard, synchronously — the deferred
	// watcher would run AFTER the recordEntry below, and the props entry would
	// land above the barrier and be discarded with the proxy's meshgeo entries)
	exitColliderEdit(false);
	sealEditHistorySession();
	object.userData.physics = next;
	recordEntry({ kind: 'props', uuid, before: { physics: before }, after: { physics: next } });
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'objectParameters', parameter: 'physics', uuid, physics: next });
	objectsGroup.update((v) => v);
	selectedObject.update((v) => v);
	import('./physics').then((m) => m.physicsShapeChanged(uuid)); // live rebuild mid-sim
	showToast('Custom collider saved — ' + colliderPieces.length + ' convex piece' + (colliderPieces.length === 1 ? '' : 's'));
	return true;
}

/** Cancel (or internal teardown): dispose the proxy, no write. @param {boolean=} toast */
export function exitColliderEdit(toast = true) {
	watchUnsubs.forEach((unsub) => unsub());
	watchUnsubs = [];
	if (get(editingObject) === proxy?.uuid) exitEditMode();
	if (get(faceEditObject) === proxy?.uuid) exitFaceEdit();
	if (proxy) {
		proxy.parent?.remove(proxy);
		proxy.geometry?.dispose?.();
		proxy.material?.dispose?.();
	}
	proxy = null;
	targetUuid = null;
	registerEditProxy(null);
	if (get(colliderEditObject)) colliderEditObject.set(null);
	if (toast) showToast('Collider edit cancelled');
}

/** test/debug view */
export function colliderEditDebug() {
	return { target: targetUuid, proxyUuid: proxy?.uuid ?? null, shells: proxy ? colliderShellCount() : 0 };
}
