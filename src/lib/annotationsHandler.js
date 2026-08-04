import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup, selectedObject, globalCamera, globalScene } from '../stores/sceneStore';
import { peers, username, showToast } from '../stores/appStore';
import { registerAnnotationsPersistence } from './autosave';
import { flyTo } from './objectActions';

// Synced note pins on objects. Offsets are object-local so pins follow their
// object; one note per pin. Replication mirrors the flow-graph pattern:
// live CRUD messages + a full-state reply on the connection handshake.

/** @type {import('svelte/store').Writable<{id: string, objectUuid: string, offset: number[], text: string, author: string, ts: number, name: string, color: string, label: string}[]>} */
export const annotations = writable([]);
/** popover state: { id, mode:'view'|'edit' } for an existing note, { draft: {...} } for a new one, or null */
/** @type {import('svelte/store').Writable<any>} */
export const activeAnnotation = writable(null);
/** the THREE group holding pin meshes, registered by AnnotationPins.svelte */
/** @type {import('svelte/store').Writable<any>} */
export const pinsGroup = writable(null);

/** H3: LOCAL pref — pins visible in the viewport (not replicated) */
export const showNotePins = writable(
	typeof localStorage === 'undefined' || localStorage.getItem('showNotePins') !== 'false'
);
if (typeof localStorage !== 'undefined')
	showNotePins.subscribe((value) => localStorage.setItem('showNotePins', String(value)));

/** H1/H4: the fixed pin palette (amber first = the historical pin color) */
export const NOTE_COLORS = [
	'#f59e0b',
	'#ef4444',
	'#ec4899',
	'#a855f7',
	'#3b82f6',
	'#22d3ee',
	'#22c55e',
	'#a3e635'
];
export const DEFAULT_NOTE_COLOR = NOTE_COLORS[0];

const tempVector = new THREE.Vector3();

/**
 * H1: ONE boundary normalizer. `text` stays the description (replication,
 * autosave, sessions and the e2e suites all carry it); v2 adds optional
 * name/color/label, so payloads from old autosaves, .tpscene sessions and
 * old-version peers load with defaults for free.
 * @param {any} a
 */
export function normalizeAnnotation(a) {
	return {
		...a,
		text: typeof a?.text === 'string' ? a.text : '',
		name: typeof a?.name === 'string' ? a.name : '',
		color: typeof a?.color === 'string' && a.color ? a.color : DEFAULT_NOTE_COLOR,
		label: typeof a?.label === 'string' ? a.label : ''
	};
}

/** 1-based GLOBAL index — MUST match the in-scene pin numbering @param {string} id */
export function noteNumber(id) {
	return get(annotations).findIndex((a) => a.id === id) + 1;
}

/** Row/card title: explicit name, else a trimmed description, else "Note n" @param {any} a */
export function displayName(a) {
	if (!a) return '';
	const name = (a.name || '').trim();
	if (name) return name;
	const text = (a.text || '').trim().replace(/\s+/g, ' ');
	if (text) return text.length > 40 ? text.slice(0, 40) + '…' : text;
	const n = noteNumber(a.id);
	return 'Note ' + (n > 0 ? n : '');
}

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
	const normalized = normalizeAnnotation(annotation);
	annotations.update((list) => {
		const index = list.findIndex((a) => a.id === normalized.id);
		if (index >= 0) {
			const next = [...list];
			next[index] = normalized;
			return next;
		}
		return [...list, normalized];
	});
	broadcast({ type: 'annotation', op: 'set', annotation: normalized });
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
		const normalized = normalizeAnnotation(data.annotation);
		annotations.update((list) => {
			const index = list.findIndex((a) => a.id === normalized.id);
			if (index >= 0) {
				const next = [...list];
				next[index] = normalized;
				return next;
			}
			return [...list, normalized];
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
		draft: normalizeAnnotation({
			id: crypto.randomUUID(),
			objectUuid: object.uuid,
			offset,
			text: '',
			author: get(username) || peer?.peer?.id || 'me',
			ts: Date.now()
		})
	});
}

/**
 * Focus the camera on a pin and open its note. `mode` picks the popover face
 * (a bare `{id}` keeps meaning view, for back-compat).
 * NOTE: `flyTo` bails in VR/spectator and the popover is DOM (invisible
 * in-headset), so this degrades to a no-visible-change there.
 * @param {string} id @param {'view'|'edit'=} mode
 */
export function openAnnotation(id, mode = 'view') {
	const annotation = get(annotations).find((a) => a.id === id);
	if (!annotation) return;
	activeAnnotation.set({ id, mode });
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

/**
 * World position of a pin right now (drives the popover's projection loop).
 * Accepts a stored note id OR a draft-shaped object (`{objectUuid, offset}`),
 * so a not-yet-saved note anchors at the clicked point too.
 * @param {string | any} idOrAnnotation
 */
export function annotationWorldPosition(idOrAnnotation) {
	const annotation =
		typeof idOrAnnotation === 'string'
			? get(annotations).find((a) => a.id === idOrAnnotation)
			: idOrAnnotation;
	if (!annotation?.objectUuid || !Array.isArray(annotation.offset)) return null;
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
	(list) => annotations.set((Array.isArray(list) ? list : []).map(normalizeAnnotation))
);
