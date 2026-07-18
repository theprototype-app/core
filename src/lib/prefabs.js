import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordObjectPresence } from './history';
import { selectObject } from './objectActions';
import { idbGet, idbPut } from './idb';

// Personal prefab library: save any object/group as a reusable asset
// (ObjectLoader snapshot + rendered thumbnail) in IndexedDB. The library is
// LOCAL by design — instantiated copies replicate like any other object.

/** @type {import('svelte/store').Writable<any[]>} [{id, name, createdAt, thumbnail, element}] */
export const prefabs = writable([]);

const KEY = 'prefabs-v1';
let loaded = false;

export async function loadPrefabs() {
	if (loaded || typeof indexedDB === 'undefined') return;
	loaded = true;
	try {
		prefabs.set((await idbGet(KEY)) ?? []);
	} catch (error) {
		console.log('prefabs load failed', error);
	}
}

async function persist() {
	try {
		await idbPut(KEY, get(prefabs));
	} catch (error) {
		console.log('prefabs persist failed', error);
		showToast('Could not save the prefab library');
	}
}

/** Small offscreen render of the snapshot @param {any} element */
function renderThumbnail(element) {
	try {
		const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
		renderer.setSize(128, 128);
		const scene = new THREE.Scene();
		scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 2.5));
		const clone = new THREE.ObjectLoader().parse(element);
		clone.position.set(0, 0, 0);
		scene.add(clone);
		const box = new THREE.Box3().setFromObject(clone);
		const size = Math.max(box.getSize(new THREE.Vector3()).length(), 0.5);
		const center = box.getCenter(new THREE.Vector3());
		const camera = new THREE.PerspectiveCamera(40, 1, size / 100, size * 10);
		camera.position.copy(center).add(new THREE.Vector3(size * 0.7, size * 0.55, size * 0.9));
		camera.lookAt(center);
		renderer.render(scene, camera);
		const url = renderer.domElement.toDataURL('image/webp', 0.7);
		renderer.dispose();
		renderer.forceContextLoss?.();
		return url;
	} catch (error) {
		console.log('prefab thumbnail failed', error);
		return null;
	}
}

/** Save an object (by uuid) into the prefab library @param {string} uuid @param {string=} name */
export async function savePrefab(uuid, name) {
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object) return null;
	const element = object.toJSON();
	if (JSON.stringify(element).length > 5_000_000) {
		showToast('Object is too large for a prefab (>5 MB)');
		return null;
	}
	const entry = {
		id: crypto.randomUUID(),
		name: name || object.name || object.type,
		createdAt: Date.now(),
		thumbnail: renderThumbnail(element),
		element
	};
	prefabs.update((list) => [...list, entry]);
	await persist();
	showToast('Prefab saved to your library');
	return entry;
}

/** Add a prefab instance to the scene (fresh uuids), replicated + undoable.
 * @param {any} prefab @param {any=} position optional spawn point (group-local) */
export function instantiatePrefab(prefab, position) {
	const group = get(objectsGroup);
	if (!group) return null;
	let object;
	try {
		object = new THREE.ObjectLoader().parse(prefab.element);
	} catch (error) {
		console.log('prefab parse failed', error);
		showToast('This prefab could not be loaded');
		return null;
	}
	object.traverse((node) => (node.uuid = crypto.randomUUID()));
	object.name = prefab.name;
	if (position) object.position.copy(position);
	group.add(object);
	objectsGroup.update((value) => value);
	recordObjectPresence('create', object);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'object', element: object.toJSON() });
	selectObject(object.uuid, true);
	return object;
}

/** @param {string} id */
export async function removePrefab(id) {
	prefabs.update((list) => list.filter((p) => p.id !== id));
	await persist();
}

/** @param {string} id @param {string} name */
export async function renamePrefab(id, name) {
	if (!name) return;
	prefabs.update((list) => list.map((p) => (p.id === id ? { ...p, name } : p)));
	await persist();
}

/** JSON string for sharing a prefab as a file @param {any} prefab */
export function exportPrefab(prefab) {
	return JSON.stringify({ name: prefab.name, element: prefab.element });
}

/** Import a previously exported prefab @param {string} json */
export async function importPrefab(json) {
	try {
		const parsed = JSON.parse(json);
		if (!parsed?.element) throw new Error('not a prefab file');
		const entry = {
			id: crypto.randomUUID(),
			name: parsed.name || 'Imported prefab',
			createdAt: Date.now(),
			thumbnail: renderThumbnail(parsed.element),
			element: parsed.element
		};
		prefabs.update((list) => [...list, entry]);
		await persist();
		return entry;
	} catch (error) {
		console.log('prefab import failed', error);
		showToast('Not a valid prefab file');
		return null;
	}
}
