import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup, selectedObject, globalCamera, globalScene } from '../stores/sceneStore';
import { peers, username, showToast } from '../stores/appStore';
import { registerAnnotationsPersistence } from './autosave';
import { flyTo } from './objectActions';

// Synced note pins on objects. Offsets are object-local so pins follow their
// object; one note per pin. Replication mirrors the flow-graph pattern:
// live CRUD messages + a full-state reply on the connection handshake.

/** @type {import('svelte/store').Writable<{id: string, objectUuid: string, offset: number[], text: string, author: string, ts: number}[]>} */
export const annotations = writable([]);
/** popover state: { id } for an existing note, { draft: {...} } for a new one, or null */
/** @type {import('svelte/store').Writable<any>} */
export const activeAnnotation = writable(null);
/** the THREE group holding pin meshes, registered by AnnotationPins.svelte */
/** @type {import('svelte/store').Writable<any>} */
export const pinsGroup = writable(null);

const tempVector = new THREE.Vector3();

/** @param {string} uuid */
function objectOf(uuid) {
	// system/environment objects live at the scene root (annotatable per 87)
	return (
		get(objectsGroup)?.getObjectByProperty('uuid', uuid) ??
		get(globalScene)?.getObjectByProperty('uuid', uuid)
	);
}

/** @param {any} data */
function broadcast(data) {
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send(data);
}

/** Create/update locally and replicate @param {any} annotation */
export function setAnnotation(annotation) {
	annotations.update((list) => {
		const index = list.findIndex((a) => a.id === annotation.id);
		if (index >= 0) {
			const next = [...list];
			next[index] = annotation;
			return next;
		}
		return [...list, annotation];
	});
	broadcast({ type: 'annotation', op: 'set', annotation });
}

/** @param {string} id */
export function deleteAnnotation(id) {
	annotations.update((list) => list.filter((a) => a.id !== id));
	broadcast({ type: 'annotation', op: 'delete', annotation: { id } });
	activeAnnotation.update((active) => (active?.id === id ? null : active));
}

/** Remote CRUD @param {any} data */
export function applyAnnotation(data) {
	if (data.op === 'delete') {
		annotations.update((list) => list.filter((a) => a.id !== data.annotation.id));
		activeAnnotation.update((active) => (active?.id === data.annotation.id ? null : active));
	} else {
		annotations.update((list) => {
			const index = list.findIndex((a) => a.id === data.annotation.id);
			if (index >= 0) {
				const next = [...list];
				next[index] = data.annotation;
				return next;
			}
			return [...list, data.annotation];
		});
	}
}

/** Apply the full set from a peer (merge by id) @param {any[]} list */
export function applyAnnotationsSnapshot(list) {
	if (!Array.isArray(list)) return;
	list.forEach((annotation) => applyAnnotation({ op: 'set', annotation }));
}

/** Full-state reply on handshake, retrying until our connection back is open @param {string} peerId */
export function sendAnnotations(peerId, attempt = 0) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	const list = get(annotations);
	if (list.length === 0) return;
	const conn = peer.connections[peerId];
	if (!conn || !conn.open) {
		if (attempt < 20) setTimeout(() => sendAnnotations(peerId, attempt + 1), 500);
		return;
	}
	conn.send({ type: 'annotations', annotations: list });
}

/**
 * Start a new note on an object. Anchored at the EXACT pointed spot when a
 * world point is given (87), otherwise at the bounding-box top.
 * @param {string=} uuid - defaults to the selected object
 * @param {number[] | null=} worldPoint - raycast hit to pin at
 */
export function addAnnotation(uuid, worldPoint = null) {
	const targetUuid = uuid ?? get(selectedObject)?.uuid;
	const object = targetUuid ? objectOf(targetUuid) : null;
	if (!object) {
		showToast('Select an object to annotate');
		return;
	}
	let worldAnchor;
	if (worldPoint) {
		worldAnchor = new THREE.Vector3().fromArray(worldPoint);
	} else {
		const box = new THREE.Box3().setFromObject(object);
		worldAnchor = box.getCenter(tempVector.clone());
		worldAnchor.y = box.max.y + 0.25;
	}
	object.updateMatrixWorld(true);
	const offset = object.worldToLocal(worldAnchor.clone()).toArray();
	/** @type {any} */
	const peer = get(peers);
	activeAnnotation.set({
		draft: {
			id: crypto.randomUUID(),
			objectUuid: object.uuid,
			offset,
			text: '',
			author: get(username) || peer?.peer?.id || 'me',
			ts: Date.now()
		}
	});
}

/** Focus the camera on a pin and open its note @param {string} id */
export function openAnnotation(id) {
	const annotation = get(annotations).find((a) => a.id === id);
	if (!annotation) return;
	activeAnnotation.set({ id });
	const object = objectOf(annotation.objectUuid);
	/** @type {any} */
	const camera = get(globalCamera);
	if (object) {
		const world = object.localToWorld(new THREE.Vector3().fromArray(annotation.offset));
		// approach along the current view direction, stopping ~4m from the pin
		const direction = camera
			? camera.position.clone().sub(world).normalize()
			: new THREE.Vector3(0.5, 0.4, 0.5).normalize();
		flyTo(world.clone().add(direction.multiplyScalar(4)), world);
	}
}

/** World position of a pin right now (for the popover projection) @param {string} id */
export function annotationWorldPosition(id) {
	const annotation = get(annotations).find((a) => a.id === id);
	if (!annotation) return null;
	const object = objectOf(annotation.objectUuid);
	if (!object) return null;
	return object.localToWorld(new THREE.Vector3().fromArray(annotation.offset));
}

// pins die with their object (deletion replicates, so every peer prunes the same)
let pruneTimer = /** @type {any} */ (null);
objectsGroup.subscribe(() => {
	clearTimeout(pruneTimer);
	pruneTimer = setTimeout(() => {
		if (!get(objectsGroup)) return;
		annotations.update((list) => {
			// objectOf also sees scene-root system objects (env rig, module content)
			const kept = list.filter((a) => objectOf(a.objectUuid));
			return kept.length === list.length ? list : kept;
		});
	}, 500);
});

// persist with the autosave snapshot
registerAnnotationsPersistence(
	() => get(annotations),
	(list) => annotations.set(list)
);
