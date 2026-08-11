import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { objectsGroup } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { registerHistoryKind, recordEntry } from './history';
import { runtimeNow } from './moduleSDK';

// Animated imports (GLTF/GLB and, since 17-D2, FBX). Rigs cannot survive the
// per-node GLTF sync (bones are children and the exporter round-trip is lossy),
// so animated imports keep their ORIGINAL file bytes and replicate as one
// `objectfile` message — receivers and late joiners parse the exact same file.
// Mixers tick on the synced clock, so every peer shows the same pose.
//
// 17-D2: the message gained a `kind` ('gltf' | 'fbx') so the receiver picks the
// right parser. It is OPTIONAL on the wire and absent means 'gltf', which is
// exactly what every pre-D2 peer sent — so old sessions/.tpscene files and a
// peer on the previous build keep working unchanged.

/** @type {import('svelte/store').Writable<Record<string, {clips: string[], clip: string, playing: boolean, speed: number}>>} */
export const animatedObjects = writable({});

/** @type {Map<string, ArrayBuffer>} rootUuid -> original file bytes */
const fileBytes = new Map();
/** @type {Map<string, 'gltf'|'fbx'>} rootUuid -> which parser those bytes need */
const fileKinds = new Map();
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

/**
 * Parse animated-import bytes with the parser that file format needs.
 * Returns the SAME shape for both formats: FBXLoader hands back a Group that
 * carries its own `.animations`, GLTFLoader a `{scene, animations}` pair.
 * @param {ArrayBuffer} bytes @param {'gltf'|'fbx'} [kind]
 * @returns {Promise<{root: any, animations: any[]}>}
 */
async function parseAnimatedBytes(bytes, kind) {
	if (kind === 'fbx') {
		const root = new FBXLoader().parse(bytes, '');
		return { root, animations: root.animations ?? [] };
	}
	/** @type {any} */
	const gltf = await new Promise((resolve, reject) =>
		createGltfLoader().parse(bytes, '', resolve, reject)
	);
	return { root: gltf.scene, animations: gltf.animations ?? [] };
}

/** @param {string} uuid */
export function hasAnimatedImport(uuid) {
	return fileBytes.has(uuid);
}

/** This model's clip transport, for a caller that must not import the store
 * (17-E: the Play Animation node reaches this module through a primed dynamic
 * import, so it reads state through accessors). @param {string} uuid */
export function animationState(uuid) {
	return get(animatedObjects)[uuid] ?? null;
}

/** which parser this import's bytes need @param {string} uuid */
export function animatedImportKind(uuid) {
	return fileKinds.get(uuid) ?? 'gltf';
}

/** The clips a model shipped with, for a UI list: [{name, duration}]. The
 * durations only ever lived inside this module's mixer record. @param {string} uuid */
export function clipInfo(uuid) {
	const record = mixers.get(uuid);
	if (!record) return [];
	return Object.keys(record.actions).map((name) => ({
		name,
		duration: record.durations[name] ?? 0
	}));
}

/** @param {string} uuid */
export function animatedImportPayload(uuid) {
	return fileBytes.get(uuid) ?? null;
}

/**
 * Track an imported animated root: keep bytes, build the mixer, autoplay.
 * @param {any} root @param {any[]} animations @param {ArrayBuffer} bytes
 * @param {'gltf'|'fbx'} [kind] which parser those bytes need (default gltf)
 */
export function registerAnimatedImport(root, animations, bytes, kind = 'gltf') {
	fileBytes.set(root.uuid, bytes);
	fileKinds.set(root.uuid, kind);
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
		// absent kind = 'gltf' (every pre-17-D2 sender)
		const { root, animations } = await parseAnimatedBytes(bytes, data.kind);
		root.uuid = data.uuid;
		root.name = data.name ?? 'Animated import';
		if (data.pos) root.position.fromArray(data.pos);
		if (data.rot) root.rotation.set(data.rot[0], data.rot[1], data.rot[2]);
		if (data.scale) root.scale.fromArray(data.scale);
		group.add(root);
		objectsGroup.update((value) => value);
		registerAnimatedImport(root, animations, bytes, data.kind === 'fbx' ? 'fbx' : 'gltf');
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
		kind: animatedImportKind(root.uuid),
		buffer: fileBytes.get(root.uuid),
		pos: root.position.toArray(),
		rot: [root.rotation.x, root.rotation.y, root.rotation.z],
		scale: root.scale.toArray(),
		anim: state ? { clip: state.clip, playing: state.playing, speed: state.speed } : null
	});
}

// ---- saving: rigs travel as their ORIGINAL BYTES here too --------------------
// A save used to serialize an animated import like any other object — toJSON for
// a session, the GLTF exporter for an autosave. Neither can carry an
// AnimationClip (clips live beside the scene, not on the object) and the
// exporter mangles rigs anyway, so the model came back as a static, dead mesh:
// "save then load kills object animations". Saves now carry the same file bytes
// the `objectfile` wire message does, base64 so they ride JSON (idb, session.json
// and .tpscene all serialize the payload as JSON).

const MAX_SAVED_BYTES = 12 * 1024 * 1024; // per model; the save formats cap totals

/** @param {ArrayBuffer} buffer */
function bytesToBase64(buffer) {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	// 32k at a time: String.fromCharCode(...wholeArray) overflows the call stack
	// on real models — the same trap that silently ate big binarypack payloads
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK)
		binary += String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(i, i + CHUNK)));
	return btoa(binary);
}

/** @param {string} base64 */
function base64ToBytes(base64) {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

/** uuids in `group` whose bytes a save carries — the caller must NOT serialize
 * these the normal way. @param {any} group */
export function animatedImportUuids(group) {
	return (group?.children ?? [])
		.filter((/** @type {any} */ child) => fileBytes.has(child.uuid))
		.map((/** @type {any} */ child) => child.uuid);
}

/**
 * Snapshot every animated import for a save file.
 * @param {any} group @returns {any[]} entries for the payload's `animated` array
 */
export function animatedImportsSnapshot(group) {
	/** @type {any[]} */
	const out = [];
	const states = get(animatedObjects);
	for (const child of group?.children ?? []) {
		const bytes = fileBytes.get(child.uuid);
		if (!bytes) continue;
		if (bytes.byteLength > MAX_SAVED_BYTES) {
			showToast('"' + (child.name || 'Model') + '" is too large to save with its animation');
			continue;
		}
		const state = states[child.uuid];
		out.push({
			uuid: child.uuid,
			name: child.name,
			kind: animatedImportKind(child.uuid),
			pos: child.position.toArray(),
			rot: [child.rotation.x, child.rotation.y, child.rotation.z],
			scale: child.scale.toArray(),
			anim: state ? { clip: state.clip, playing: state.playing, speed: state.speed } : null,
			bytes: bytesToBase64(bytes)
		});
	}
	return out;
}

/**
 * Restore saved animated imports: re-parse the original bytes, rebuild the mixer
 * and push each one to peers. Any static twin a save format wrote anyway (the
 * autosave GLTF cannot exclude it) is removed first, since applyObjectFile
 * declines a uuid that already exists.
 * @param {any[]} entries
 */
export async function animatedImportsRestore(entries) {
	if (!entries?.length) return 0;
	const group = get(objectsGroup);
	/** @type {any} */
	const peer = get(peers);
	let restored = 0;
	for (const entry of entries ?? []) {
		if (!entry?.bytes) continue;
		const stale = group?.getObjectByProperty('uuid', entry.uuid);
		if (stale) stale.parent?.remove(stale);
		try {
			await applyObjectFile({
				uuid: entry.uuid,
				name: entry.name,
				kind: entry.kind,
				buffer: base64ToBytes(entry.bytes),
				pos: entry.pos,
				rot: entry.rot,
				scale: entry.scale,
				anim: entry.anim
			});
			const root = get(objectsGroup)?.getObjectByProperty('uuid', entry.uuid);
			if (root && peer) sendAnimatedImport(peer, root); // peers reparse the same file
			if (root) restored++;
		} catch (error) {
			console.log('animated import restore failed', error);
		}
	}
	if (restored) objectsGroup.update((value) => value);
	return restored;
}

/** Cleanup when the object is removed @param {string} uuid */
export function dropAnimatedImport(uuid) {
	fileBytes.delete(uuid);
	fileKinds.delete(uuid);
	mixers.delete(uuid);
	animatedObjects.update((map) => {
		const next = { ...map };
		delete next[uuid];
		return next;
	});
}

/** Scene was wiped — forget every registry entry */
export function dropAllAnimatedImports() {
	fileBytes.clear();
	fileKinds.clear();
	mixers.clear();
	animatedObjects.set({});
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
		applyObjectFile({
			uuid: entry.uuid,
			name: entry.name,
			// 17-D2: an undone FBX must come back through FBXLoader. The entry's own
			// `kind` is the HISTORY kind ('animimport'), so the parser lives on
			// `fileKind` — reusing `kind` would break the registry dispatch.
			kind: entry.fileKind,
			buffer: entry.buffer,
			pos: entry.pos
		}).then(() => {
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
		fileKind: animatedImportKind(root.uuid),
		buffer: fileBytes.get(root.uuid),
		pos: root.position.toArray(),
		before: { present: false },
		after: { present: true }
	});
}
