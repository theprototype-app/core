// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalCamera, selectedObject } from '../stores/sceneStore';
import { peers, showToast, toastStore } from '../stores/appStore';
import { explorerItems, itemBlob } from './explorer';
import { prefabs, instantiatePrefab } from './prefabs';
import { importFile } from './fileHandler.svelte';
import { setObjectTexture } from './materialsHandler';
import { topLevelObjectOf } from './objectActions';
import { sceneHits, hitWorldNormal } from './scenePick';

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
	const ndc = new THREE.Vector2(
		(clientX / window.innerWidth) * 2 - 1,
		-(clientY / window.innerHeight) * 2 + 1
	);
	raycaster.setFromCamera(ndc, camera);
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

/** @param {any} object @param {number[]} point */
function placeAt(object, point) {
	object.position.set(point[0], point[1], point[2]);
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
 * Handle a viewport drop of an Explorer card.
 * @param {{id?: string, kind: string, name: string, prefabId?: string | null, url?: string | null}} payload
 * @param {number} clientX @param {number} clientY
 */
export async function dropExplorerItem(payload, clientX, clientY) {
	const target = dropTarget(clientX, clientY);
	if (payload.prefabId) {
		const prefab = get(prefabs).find((entry) => entry.id === payload.prefabId);
		if (!prefab) return;
		const object = instantiatePrefab(prefab);
		if (object && target.point) placeAt(object, target.point);
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
