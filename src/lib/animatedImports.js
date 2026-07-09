import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { objectsGroup } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { registerHistoryKind, recordEntry } from './history';
import { runtimeNow } from './moduleSDK';

// Animated GLTF imports. Rigs cannot survive the per-node GLTF sync (bones
// are children and the exporter round-trip is lossy), so animated imports
// keep their ORIGINAL file bytes and replicate as one `objectfile` message —
// receivers and late joiners parse the exact same file. Mixers tick on the
// synced clock, so every peer shows the same pose.

/** @type {import('svelte/store').Writable<Record<string, {clips: string[], clip: string, playing: boolean, speed: number}>>} */
export const animatedObjects = writable({});

/** @type {Map<string, ArrayBuffer>} rootUuid -> original glb bytes */
const fileBytes = new Map();
/** @type {Map<string, {mixer: any, actions: Record<string, any>, durations: Record<string, number>}>} */
const mixers = new Map();

/** GLTFLoader with draco + meshopt decoders wired */
export function createGltfLoader() {
	const loader = new GLTFLoader();
	const draco = new DRACOLoader();
	draco.setDecoderPath('/draco/');
	loader.setDRACOLoader(draco);
	loader.setMeshoptDecoder(MeshoptDecoder);
	return loader;
}

/** @param {string} uuid */
export function hasAnimatedImport(uuid) {
	return fileBytes.has(uuid);
}

/** @param {string} uuid */
export function animatedImportPayload(uuid) {
	return fileBytes.get(uuid) ?? null;
}

/**
 * Track an imported animated root: keep bytes, build the mixer, autoplay.
 * @param {any} root @param {any[]} animations @param {ArrayBuffer} bytes
 */
export function registerAnimatedImport(root, animations, bytes) {
	fileBytes.set(root.uuid, bytes);
	const mixer = new THREE.AnimationMixer(root);
	/** @type {Record<string, any>} */
	const actions = {};
	/** @type {Record<string, number>} */
	const durations = {};
	animations.forEach((clip) => {
		actions[clip.name] = mixer.clipAction(clip);
		durations[clip.name] = clip.duration;
	});
	mixers.set(root.uuid, { mixer, actions, durations });
	root.userData.animatedClips = animations.map((c) => c.name);
	const first = animations[0]?.name;
	animatedObjects.update((map) => ({
		...map,
		[root.uuid]: { clips: animations.map((c) => c.name), clip: first, playing: true, speed: 1 }
	}));
	if (first) actions[first].play();
}

/** Per-frame from the scene loop: pose = pure function of the synced clock */
export function tickAnimatedMixers() {
	const states = get(animatedObjects);
	const time = runtimeNow();
	mixers.forEach(({ mixer, durations }, uuid) => {
		const state = states[uuid];
		if (!state || !state.playing || !state.clip) return;
		const duration = durations[state.clip] || 1;
		mixer.setTime((time * state.speed) % duration);
	});
}

/**
 * Apply clip/playing/speed (local UI and remote objectParameters both land here).
 * @param {string} uuid @param {{clip?: string, playing?: boolean, speed?: number}} next @param {boolean} replicate
 */
export function setAnimationState(uuid, next, replicate = true) {
	const entry = get(animatedObjects)[uuid];
	const record = mixers.get(uuid);
	if (!entry || !record) return;
	const state = { ...entry, ...next };
	animatedObjects.update((map) => ({ ...map, [uuid]: state }));
	if (next.clip && next.clip !== entry.clip) {
		Object.values(record.actions).forEach((action) => action.stop());
		record.actions[state.clip]?.play();
	}
	if (!state.playing && next.playing === false) record.mixer.setTime(0);
	if (replicate) {
		/** @type {any} */
		const peer = get(peers);
		if (peer)
			peer.send({
				type: 'objectParameters',
				parameter: 'animation',
				uuid: uuid,
				clip: state.clip,
				playing: state.playing,
				speed: state.speed
			});
	}
}

/** Receive side of the raw-bytes sync @param {any} data */
export async function applyObjectFile(data) {
	const group = get(objectsGroup);
	if (!group || group.getObjectByProperty('uuid', data.uuid)) return;
	try {
		const bytes = data.buffer instanceof ArrayBuffer ? data.buffer : data.buffer?.buffer ?? data.buffer;
		const gltf = await new Promise((resolve, reject) =>
			createGltfLoader().parse(bytes, '', resolve, reject)
		);
		const root = gltf.scene;
		root.uuid = data.uuid;
		root.name = data.name ?? 'Animated import';
		if (data.pos) root.position.fromArray(data.pos);
		if (data.rot) root.rotation.set(data.rot[0], data.rot[1], data.rot[2]);
		if (data.scale) root.scale.fromArray(data.scale);
		group.add(root);
		objectsGroup.update((value) => value);
		registerAnimatedImport(root, gltf.animations ?? [], bytes);
		if (data.anim) setAnimationState(data.uuid, data.anim, false);
	} catch (error) {
		console.log('objectfile parse failed', error);
		showToast('Could not load an animated model from a peer');
	}
}

/** Broadcast one animated root to a connection (or everyone) @param {any} conn @param {any} root */
export function sendAnimatedImport(conn, root) {
	const state = get(animatedObjects)[root.uuid];
	conn.send({
		type: 'objectfile',
		uuid: root.uuid,
		name: root.name,
		buffer: fileBytes.get(root.uuid),
		pos: root.position.toArray(),
		rot: [root.rotation.x, root.rotation.y, root.rotation.z],
		scale: root.scale.toArray(),
		anim: state ? { clip: state.clip, playing: state.playing, speed: state.speed } : null
	});
}

/** Cleanup when the object is removed @param {string} uuid */
export function dropAnimatedImport(uuid) {
	fileBytes.delete(uuid);
	mixers.delete(uuid);
	animatedObjects.update((map) => {
		const next = { ...map };
		delete next[uuid];
		return next;
	});
}

// undo/redo: presence kind backed by the raw bytes (the ObjectLoader snapshot
// path in history.js cannot round-trip rigs)
registerHistoryKind('animimport', (entry, state) => {
	const group = get(objectsGroup);
	/** @type {any} */
	const peer = get(peers);
	if (!group) return false;
	const existing = group.getObjectByProperty('uuid', entry.uuid);
	if (state.present) {
		if (existing) return true;
		applyObjectFile({ uuid: entry.uuid, name: entry.name, buffer: entry.buffer, pos: entry.pos }).then(() => {
			const root = get(objectsGroup)?.getObjectByProperty('uuid', entry.uuid);
			if (root && peer) sendAnimatedImport(peer, root); // peer.send broadcasts
		});
		return true;
	}
	if (!existing) {
		showToast('Cannot undo/redo: the object no longer exists');
		return false;
	}
	existing.parent?.remove(existing);
	objectsGroup.update((value) => value);
	if (peer) peer.send({ type: 'delete', uuid: entry.uuid, peerId: peer.peer.id });
	return true;
});

/** Record the creation of an animated import @param {any} root */
export function recordAnimatedImport(root) {
	recordEntry({
		kind: 'animimport',
		uuid: root.uuid,
		name: root.name,
		buffer: fileBytes.get(root.uuid),
		pos: root.position.toArray(),
		before: { present: false },
		after: { present: true }
	});
}
