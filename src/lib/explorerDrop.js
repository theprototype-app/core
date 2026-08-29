// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalCamera, selectedObject } from '../stores/sceneStore';
import { peers, showToast, toastStore, stackOnDrop } from '../stores/appStore';
import { explorerItems, itemBlob } from './explorer';
import { prefabs, instantiatePrefab } from './prefabs';
import { importFile } from './fileHandler.svelte';
import { setObjectTexture } from './materialsHandler';
import { topLevelObjectOf } from './objectActions';
import { sceneHits, hitWorldNormal } from './scenePick';
import { snapTargets } from './snapping';
import { ndcFromClient } from './canvasRect';

// Explorer -> scene drops (96): place objects/prefabs at the pointed spot,
// texture the mesh under the cursor with a dropped image. Everything goes
// through the EXISTING replicated paths (instantiatePrefab, importFile,
// setObjectTexture) — the library itself stays local.

const raycaster = new THREE.Raycaster();

/**
 * Raycast the drop coordinates: `{point, object, normal}` — object is null over
 * empty ground; point is null when aiming at the sky. `normal` is the world
 * normal of the surface hit (19-B P1, for align-to-normal placement): the hit's
 * face normal on a mesh, `[0, 1, 0]` on the ground plane, null when aiming at
 * the sky or when the hit carries no face data.
 * @param {number} clientX @param {number} clientY
 * @returns {{point: number[] | null, object: any, normal: number[] | null}}
 */
export function dropTarget(clientX, clientY) {
	/** @type {any} */
	const camera = get(globalCamera);
	if (!camera) return { point: null, object: null, normal: null };
	// W9: against the CANVAS, not the window — with the bottom dock open the two differ
	// by the dock's height, and a drop would land that far below the cursor. Correct in
	// both modes: an un-inset canvas measures exactly the window.
	const point = ndcFromClient(clientX, clientY);
	raycaster.setFromCamera(new THREE.Vector2(point.x, point.y), camera);
	const hits = sceneHits(raycaster);
	if (hits[0])
		return {
			point: hits[0].point.toArray(),
			object: topLevelObjectOf(hits[0].object),
			normal: hitWorldNormal(hits[0])?.toArray() ?? null
		};
	const planePoint = new THREE.Vector3();
	const onGround = raycaster.ray.intersectPlane(
		new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
		planePoint
	);
	if (!onGround) return { point: null, object: null, normal: null };
	return { point: planePoint.toArray(), object: null, normal: [0, 1, 0] };
}

const _dropUp = new THREE.Vector3(0, 1, 0);
const _dropNormal = new THREE.Vector3();
const _dropQuat = new THREE.Quaternion();

/**
 * @param {any} object @param {number[]} point
 * @param {number[]|null} [normal] 19-B P4: the surface normal under the drop.
 *   With `snapTargets.alignNormal` on, the object's +Y is turned onto it BEFORE
 *   the move broadcast (which already carries rot, so nothing new goes on the
 *   wire). A +Y normal — the ground plane, i.e. every flat drop — is skipped, so
 *   the default path stays byte-identical.
 */
function placeAt(object, point, normal = null) {
	object.position.set(point[0], point[1], point[2]);
	if (normal && get(snapTargets).alignNormal) {
		_dropNormal.fromArray(normal);
		if (_dropNormal.lengthSq() > 1e-12) {
			_dropNormal.normalize();
			if (_dropNormal.distanceTo(_dropUp) > 1e-6) {
				_dropQuat.setFromUnitVectors(_dropUp, _dropNormal);
				object.quaternion.premultiply(_dropQuat);
				object.updateMatrixWorld(true);
			}
		}
	}
	/** @type {any} */
	const peer = get(peers);
	if (peer)
		peer.send({
			type: 'move',
			uuid: object.uuid,
			pos: object.position.toArray(),
			rot: object.rotation.toArray(),
			scale: object.scale.toArray()
		});
}

/**
 * Apply an Explorer image item as the texture of an object (Inspector drop
 * target + viewport mesh drop share this). Replicates via setObjectTexture.
 * @param {string} uuid @param {any} payload
 * @param {number} [slot] UV2: which material slot to texture (omitted = 0, the
 *   only slot a single-material object has — so both existing callers are
 *   unchanged)
 * @returns {Promise<boolean>}
 */
export async function applyExplorerImage(uuid, payload, slot = 0) {
	const item = get(explorerItems).find((entry) => entry.id === payload.id);
	if (!item || item.kind !== 'image') return false;
	const blob = await itemBlob(item.id);
	if (!blob) return false;
	await setObjectTexture(uuid, new File([blob], item.name, { type: blob.type || 'image/png' }), slot);
	return true;
}

/**
 * Hold a dismissible "Loading …" toast while a slow CDN pack fetch runs (with
 * NOTHING on screen otherwise). Uses the raw store so it can be removed by
 * reference — `showToast` has no handle and would also push a notification;
 * the 15s object-toast timeout in Toasts.svelte is the failsafe. Shared by the
 * viewport DROP path and the Explorer's double-click / Enter place (15-B3).
 * @param {string} name @returns {() => void} dismiss
 */
export function holdLoadingToast(name) {
	/** @type {any} */
	const loadingToast = { text: `Loading "${name}"…`, actions: [] };
	toastStore.update((list) => [...list, loadingToast]);
	return () => toastStore.update((list) => list.filter((t) => t !== loadingToast));
}

/**
 * 21-H3: how far apart N cards land when ONE drag carries a whole selection.
 * A constant rather than a measured bounding box: the objects a drop creates do not
 * exist yet (a prefab is instantiated here, a model is parsed asynchronously by
 * `importFile`), so there is nothing to measure at the moment the layout is decided.
 */
const SPREAD_STEP = 1.5;

/**
 * The i-th slot of a small SQUARE grid centred on the drop point, in world XZ.
 * Deterministic and order-stable, so the same drag always lays out the same way.
 * @param {number[]} point @param {number} i @param {number} count
 * @returns {number[]}
 */
function spreadPoint(point, i, count) {
	const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
	const rows = Math.max(1, Math.ceil(count / cols));
	const col = i % cols;
	const row = Math.floor(i / cols);
	return [
		point[0] + (col - (cols - 1) / 2) * SPREAD_STEP,
		point[1],
		point[2] + (row - (rows - 1) / 2) * SPREAD_STEP
	];
}

/**
 * Handle a viewport drop of an Explorer card.
 *
 * 21-H3: the payload may carry an `items` ARRAY — the whole Explorer selection behind
 * the card that was actually dragged. A SINGLE drag keeps exactly its old top-level
 * shape, so this is the only consumer that had to learn anything. The raycast happens
 * ONCE and every item is placed relative to that one point: raycasting per item would
 * ask the scene where to put an object while the previous ones were still arriving.
 * @param {{id?: string, kind: string, name: string, prefabId?: string | null, url?: string | null, items?: any[]}} payload
 * @param {number} clientX @param {number} clientY
 */
export async function dropExplorerItem(payload, clientX, clientY) {
	const target = dropTarget(clientX, clientY);
	const many = Array.isArray(payload?.items) && payload.items.length > 1 ? payload.items : null;
	if (!many) return placeExplorerPayload(payload, target);
	const stack = get(stackOnDrop);
	for (let i = 0; i < many.length; i++) {
		const point =
			stack || !target.point ? target.point : spreadPoint(target.point, i, many.length);
		await placeExplorerPayload(many[i], { ...target, point });
	}
}

/**
 * Place ONE payload at an already-resolved drop target (21-H3 split this out of
 * `dropExplorerItem` unchanged so the multi path could reuse the single one verbatim).
 * @param {any} payload
 * @param {{point: number[] | null, object: any, normal: number[] | null}} target
 */
async function placeExplorerPayload(payload, target) {
	if (payload.prefabId) {
		const prefab = get(prefabs).find((entry) => entry.id === payload.prefabId);
		if (!prefab) return;
		const object = instantiatePrefab(prefab);
		if (object && target.point) placeAt(object, target.point, target.normal);
		return;
	}
	// N6: a default-pack item carries a `url` (not a stored library item) — fetch
	// its glb and place it at the drop point. The placed object replicates normally.
	if (payload.url) {
		const name = String(payload.name || 'model').replace(/\.\w+$/, '');
		const dismiss = holdLoadingToast(name);
		try {
			const res = await fetch(payload.url);
			if (!res.ok) {
				dismiss();
				return showToast('Could not fetch the pack item');
			}
			importFile(new File([await res.blob()], name + '.glb'), name, undefined, target.point ?? undefined);
			dismiss();
		} catch {
			dismiss();
			showToast('Could not load the pack item (network / CORS)');
		}
		return;
	}
	const item = get(explorerItems).find((entry) => entry.id === payload.id);
	if (!item) return;
	if (item.kind === 'object') {
		const blob = await itemBlob(item.id);
		if (!blob) return;
		importFile(
			new File([blob], item.name),
			item.name.replace(/\.\w+$/, ''),
			undefined,
			target.point ?? undefined
		);
	} else if (item.kind === 'image') {
		if (!target.object) {
			showToast('Drop the image ON an object to texture it');
			return;
		}
		await applyExplorerImage(target.object.uuid, { id: item.id });
	} else {
		showToast('Audio/text items are used where they plug in (sound nodes, scripts)');
	}
}
