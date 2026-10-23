import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { createGltfLoader } from './gltfLoader';
import { parseGltfSceneSafe } from './ktx2Twins';
import { objectsGroup, pokeScene } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { registerHistoryKind, recordEntry } from './history';
import { runtimeNow } from './moduleSDK';
import { normalizeBehavior } from './behaviorCore';

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
/** @type {Map<string, 'gltf'|'fbx'|'vrm'>} rootUuid -> which parser those bytes need */
const fileKinds = new Map();
/** @type {Map<string, {mixer: any, actions: Record<string, any>, durations: Record<string, number>}>} */
const mixers = new Map();

// ---- 57 M2: a rig's REST POSE, and clips computed on this peer ---------------------------
// Retargeting needs each rig's rest pose; the live tree stops being one the moment a clip plays,
// so the rest is captured at registration (a fresh parse) as plain rows — every bone and its
// ancestors below the root, parent-first. RUNTIME clips are clips this peer COMPUTED for a model
// (a retargeted humanoid clip, 57 M1's assigned .tpanim): added to its mixer, never to its bytes,
// so the model replicates and saves exactly as before and each peer rebuilds them from the config.
/** @typedef {{name: string, parent: number, t: number[], q: number[], s: number[], bone: boolean}} RestRow */
/** @type {Map<string, RestRow[]>} rootUuid -> rest rows */
const restRows = new Map();
/** @type {Map<string, Set<string>>} rootUuid -> names of the clips added at run time */
const runtimeClips = new Map();
/** @type {Set<(uuid: string) => void>} */
const registeredListeners = new Set();

/** Called with the root uuid after every registration (a late source for a pending retarget).
 * @param {(uuid: string) => void} fn @returns {() => void} unsubscribe */
export function onAnimatedRegistered(fn) {
	registeredListeners.add(fn);
	return () => registeredListeners.delete(fn);
}

/** @param {any} root @returns {RestRow[]} */
function captureRestRows(root) {
	/** @type {any[]} */
	const keep = [];
	const seen = new Set();
	root.traverse((/** @type {any} */ o) => {
		if (!o.isBone) return;
		/** @type {any[]} */
		const chain = [];
		for (let n = o; n && n !== root; n = n.parent) chain.unshift(n);
		for (const n of chain) {
			if (seen.has(n)) continue;
			seen.add(n);
			keep.push(n);
		}
	});
	const at = new Map(keep.map((n, i) => [n, i]));
	return keep.map((n) => ({
		name: n.name,
		parent: at.has(n.parent) ? /** @type {number} */ (at.get(n.parent)) : -1,
		t: n.position.toArray(),
		q: n.quaternion.toArray(),
		s: n.scale.toArray(),
		bone: !!n.isBone
	}));
}

/** the rig's rest pose as captured at registration (empty for a model without bones) @param {string} uuid */
export function restRowsOf(uuid) {
	return restRows.get(uuid) ?? [];
}

/** the clip object a model plays under `name` (embedded or run time) @param {string} uuid @param {string} name */
export function clipOf(uuid, name) {
	return mixers.get(uuid)?.actions[name]?.getClip?.() ?? null;
}

/** names of the clips this peer added at run time @param {string} uuid */
export function runtimeClipNames(uuid) {
	return [...(runtimeClips.get(uuid) ?? [])];
}

/**
 * Replace the run-time clips of a model (LOCAL: every peer computes the same set from the
 * replicated config). The transport keeps playing what it played when that clip still exists.
 * @param {string} uuid @param {any[]} clips THREE.AnimationClip[]
 */
export function setRuntimeClips(uuid, clips) {
	const record = mixers.get(uuid);
	if (!record) return false;
	const old = runtimeClips.get(uuid) ?? new Set();
	for (const name of old) {
		const action = record.actions[name];
		if (action) {
			action.stop();
			record.mixer.uncacheAction(action.getClip());
		}
		delete record.actions[name];
		delete record.durations[name];
	}
	/** @type {Set<string>} */
	const names = new Set();
	for (const clip of clips) {
		if (!clip?.name || (record.actions[clip.name] && !old.has(clip.name))) continue; // an embedded clip keeps its name
		record.actions[clip.name] = record.mixer.clipAction(clip);
		record.durations[clip.name] = clip.duration;
		names.add(clip.name);
	}
	runtimeClips.set(uuid, names);
	const entry = get(animatedObjects)[uuid];
	if (entry) {
		const list = Object.keys(record.actions);
		const clip = entry.clip && record.actions[entry.clip] ? entry.clip : list[0];
		animatedObjects.update((map) => ({ ...map, [uuid]: { ...entry, clips: list, clip } }));
		// a late clip the transport already names (a joiner's state arrived before the retarget)
		if (entry.playing && clip && !record.actions[clip].isScheduled()) {
			Object.values(record.actions).forEach((a) => a.stop());
			record.actions[clip].play();
		}
	}
	return true;
}

// ---- 33 P2: animated FUNCTIONAL items (a door, a chest, a lever, a fan) ---------------
// An import whose root carries a `behavior` (stamped from the pack item's row, or from the
// GLB's own scene extras) is driven by packBehavior.js, never by the transport below: the
// transport is a looping clip on the synced clock, which is exactly what a door must NOT do.
// The spec travels WITH the bytes (objectfile / save entry / undo entry) because it lives
// in the pack row, not in the file. packBehavior reaches in through the two hooks.
/** @type {Map<string, import('./behaviorCore').BehaviorSpec>} rootUuid -> spec */
const behaviors = new Map();
/** @type {{state: ((uuid: string) => any) | null, apply: ((uuid: string, state: any) => void) | null, preview: ((uuid: string, clip?: string) => void) | null, registered: ((uuid: string) => void) | null}} */
const behaviorHooks = { state: null, apply: null, preview: null, registered: null };

/** packBehavior plugs in here (it imports this module, so the edge cannot run the other way)
 * @param {Partial<typeof behaviorHooks>} hooks */
export function setBehaviorHooks(hooks) {
	Object.assign(behaviorHooks, hooks);
}

/** @param {string} uuid @returns {import('./behaviorCore').BehaviorSpec | null} */
export function behaviorOf(uuid) {
	return behaviors.get(uuid) ?? null;
}

/** every root driven by a behavior @returns {string[]} */
export function behaviorUuids() {
	return [...behaviors.keys()];
}

/** the live registry, for the per-frame tick (iterate, never mutate — no copy per frame)
 * @returns {ReadonlyMap<string, import('./behaviorCore').BehaviorSpec>} */
export function behaviorRegistry() {
	return behaviors;
}

/** the live mixer record (packBehavior poses through it) @param {string} uuid */
export function animatedRecordOf(uuid) {
	return mixers.get(uuid) ?? null;
}

/** the spec + live state a message/save carries for this root (both absent = none) @param {string} uuid */
function behaviorFields(uuid) {
	const spec = behaviors.get(uuid);
	if (!spec) return {};
	const state = behaviorHooks.state?.(uuid) ?? null;
	return { behavior: spec, ...(state ? { behaviorState: state } : {}) };
}

/**
 * 33 (for 33-lod-editor): the root's LOD group (`userData.lod`, plain JSON validated by
 * lodGroupCore on the reading side) travels beside the bytes for the same reason the
 * behavior spec does — the peer RE-PARSES the file, so anything stamped on the root after
 * the parse is otherwise lost on peers, after a reload and across an undo. Absent = none,
 * so every message without one is byte-identical.
 * @param {any} root @returns {{lod?: any}}
 */
function rootDataFields(root) {
	/** @type {Record<string, any>} */
	const out = {};
	// 57 M2 / M7: the humanoid config (map fixes + applied clips) and the provenance record ride
	// the bytes for the same reason (absent = none, byte-identical messages for everything else)
	for (const key of ['lod', 'humanoid', 'provenance', 'vrmExpressions']) {
		const v = root?.userData?.[key];
		if (!v || typeof v !== 'object') continue;
		try {
			out[key] = JSON.parse(JSON.stringify(v));
		} catch {
			/* not plain data: leave it out */
		}
	}
	return out;
}

/** 57: put the riding fields back on a freshly parsed (or healed) root @param {any} root @param {any} data */
function applyRootData(root, data) {
	if (data.humanoid && typeof data.humanoid === 'object') root.userData.humanoid = data.humanoid;
	if (Array.isArray(data.provenance)) root.userData.provenance = data.provenance;
	if (data.vrmExpressions && typeof data.vrmExpressions === 'object') root.userData.vrmExpressions = data.vrmExpressions;
}

/** GLTFLoader with draco + meshopt decoders wired — 34 R7: the app's one (gltfLoader.js) */
export { createGltfLoader };

/**
 * Parse animated-import bytes with the parser that file format needs.
 * Returns the SAME shape for both formats: FBXLoader hands back a Group that
 * carries its own `.animations`, GLTFLoader a `{scene, animations}` pair.
 * @param {ArrayBuffer} bytes @param {'gltf'|'fbx'|'vrm'} [kind]
 * @returns {Promise<{root: any, animations: any[]}>}
 */
async function parseAnimatedBytes(bytes, kind) {
	// 57 M4: a VRM parses through three-vrm (a lazy chunk, loaded only for a scene that has one)
	if (kind === 'vrm') {
		const { parseVrmBytes } = await import('./vrm/vrmRuntime.js');
		const { root, animations } = await parseVrmBytes(bytes);
		return { root, animations };
	}
	if (kind === 'fbx') {
		const root = new FBXLoader().parse(bytes, '');
		return { root, animations: root.animations ?? [] };
	}
	// 46: KTX2-aware, scene-safe (a KTX2 texture becomes an ordinary one + its twin)
	/** @type {any} */
	const gltf = await parseGltfSceneSafe(bytes);
	return { root: gltf.scene, animations: gltf.animations ?? [] };
}

/** 57 M9: a fresh parse of an import's bytes (a download re-exports the PRISTINE tree, never the
 * posed live one) @param {ArrayBuffer} bytes @param {'gltf'|'fbx'|'vrm'} [kind] */
export function parseImportBytes(bytes, kind) {
	return parseAnimatedBytes(bytes, kind);
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

// ---- 57 M4: VRM roots ---------------------------------------------------------------------
/** the VRM runtime once a VRM was parsed (null = never loaded) @type {any} */
let vrmMod = null;

/** @param {any} root */
async function adoptVrmRoot(root) {
	try {
		const m = await import('./vrm/vrmRuntime.js');
		vrmMod = m;
		const map = m.adoptVrm(root);
		if (map) (await import('./humanoid/humanoidRig.js')).setFileHumanoid(root.uuid, map);
	} catch (error) {
		console.log('vrm adopt failed', error);
	}
}

/** is this root a VRM (its runtime adopted it)? @param {string} uuid */
export function isVrmImport(uuid) {
	return !!vrmMod?.isVrm(uuid);
}

/** a VRM's runtime facts for the suites (null = the runtime never loaded) @param {string} uuid */
export function vrmDebug(uuid) {
	return vrmMod ? { vrm: vrmMod.isVrm(uuid), joints: vrmMod.springJointCount(uuid), expressions: vrmMod.expressionNames(uuid), value: (/** @type {string} */ n) => vrmMod.expressionValue(uuid, n) } : null;
}

/** the expressions a VRM offers ([] for anything else) @param {string} uuid @returns {string[]} */
export function vrmExpressionNames(uuid) {
	return vrmMod?.expressionNames(uuid) ?? [];
}

/**
 * Set a VRM expression (0..1). The weights live on the root (`userData.vrmExpressions`, riding
 * the bytes for joiners / saves); `replicate` sends them (an Inspector edit). The Set Expression
 * node passes false: its trigger stamp already reached every peer, which each run it themselves.
 * @param {string} uuid @param {string} name @param {number} weight @param {boolean} [replicate]
 */
export function setVrmExpression(uuid, name, weight, replicate = true) {
	const root = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (!root || !vrmMod?.setExpression(uuid, name, weight)) return false;
	const w = Math.max(0, Math.min(1, Number(weight) || 0));
	root.userData.vrmExpressions = { ...(root.userData.vrmExpressions ?? {}), [name]: w };
	pokeScene();
	if (replicate) {
		/** @type {any} */
		const peer = get(peers);
		peer?.send({ type: 'objectParameters', parameter: 'expression', uuid, name, weight: w });
	}
	return true;
}

/** @param {string} uuid */
export function animatedImportPayload(uuid) {
	return fileBytes.get(uuid) ?? null;
}

/**
 * Track an imported animated root: keep bytes, build the mixer. 33 P2: NOTHING AUTOPLAYS
 * any more — placing an animated GLB used to start (and loop) its FIRST clip at once, which
 * is how a door swung forever the moment it landed. The clip is selected, not playing; the
 * Animation panel's play button (or a Play Animation node) starts it. A root carrying a
 * `behavior` is handed to packBehavior instead (see the block above).
 * @param {any} root @param {any[]} animations @param {ArrayBuffer} bytes
 * @param {'gltf'|'fbx'|'vrm'} [kind] which parser those bytes need (default gltf; 57 M4 vrm)
 */
export function registerAnimatedImport(root, animations, bytes, kind = 'gltf') {
	fileBytes.set(root.uuid, bytes);
	fileKinds.set(root.uuid, kind);
	restRows.set(root.uuid, captureRestRows(root));
	runtimeClips.delete(root.uuid);
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
	const spec = normalizeBehavior(root.userData.behavior);
	if (spec && !actions[spec.clip]) {
		// a behavior naming a clip the file does not have drives nothing — say so once
		console.log('behavior clip "' + spec.clip + '" not in', root.name, Object.keys(actions));
	}
	if (spec && actions[spec.clip]) {
		root.userData.behavior = spec;
		behaviors.set(root.uuid, spec);
	} else delete root.userData.behavior;
	const first = spec && actions[spec.clip] ? spec.clip : animations[0]?.name;
	animatedObjects.update((map) => ({
		...map,
		[root.uuid]: { clips: animations.map((c) => c.name), clip: first, playing: false, speed: 1 }
	}));
	if (behaviors.has(root.uuid)) behaviorHooks.registered?.(root.uuid);
	// 57 M4: a VRM's runtime (spring bones, expressions) and its own humanoid map come first
	const vrmReady = kind === 'vrm' ? adoptVrmRoot(root) : Promise.resolve();
	// 57 M2: a humanoid config (clips applied from another rig) is rebuilt on THIS peer; the code
	// for it loads only for a model that has one
	if (root.userData?.humanoid?.clips?.length)
		void vrmReady.then(() => import('./humanoid/humanoidRig.js')).then((m) => m.rebuildHumanoidClips(root.uuid));
	for (const fn of registeredListeners) {
		try {
			fn(root.uuid);
		} catch (error) {
			console.log('animated registration listener failed', error);
		}
	}
}

/**
 * 37 R3: a PROCEDURAL functional item — a parametric door or casement window whose moving
 * parts are BUILT from its params (arch/archParts.js), not parsed from a file. It joins the 33
 * behaviour runtime exactly like a pack door (packBehavior poses it, the `behavior` message
 * carries its state, the frame collider is cut round its opening) but it has NO bytes, so it is
 * never sent, saved or undone as an animated import: every peer rebuilds the parts from the
 * replicated params. Registering again (a param edit rebuilt the parts) replaces the mixer.
 * @param {any} root @param {any[]} animations @param {any} rawSpec
 * @returns {boolean} registered
 */
export function registerProceduralBehavior(root, animations, rawSpec) {
	if (fileBytes.has(root.uuid)) return false; // a real import keeps its own registration
	const old = mixers.get(root.uuid);
	if (old) {
		old.mixer.stopAllAction();
		old.mixer.uncacheRoot(old.mixer.getRoot());
	}
	const spec = normalizeBehavior(rawSpec);
	const mixer = new THREE.AnimationMixer(root);
	/** @type {Record<string, any>} */
	const actions = {};
	/** @type {Record<string, number>} */
	const durations = {};
	for (const clip of animations) {
		actions[clip.name] = mixer.clipAction(clip);
		durations[clip.name] = clip.duration;
	}
	if (!spec || !actions[spec.clip]) {
		dropProceduralBehavior(root.uuid);
		return false;
	}
	mixers.set(root.uuid, { mixer, actions, durations });
	behaviors.set(root.uuid, spec);
	animatedObjects.update((map) => ({
		...map,
		[root.uuid]: { clips: animations.map((c) => c.name), clip: spec.clip, playing: false, speed: 1 }
	}));
	behaviorHooks.registered?.(root.uuid);
	return true;
}

/** forget a procedural item (deleted, or no longer moves); a file-backed import is left alone @param {string} uuid */
export function dropProceduralBehavior(uuid) {
	if (fileBytes.has(uuid)) return;
	const record = mixers.get(uuid);
	if (record) record.mixer.stopAllAction();
	dropAnimatedImport(uuid);
}

/** Per-frame from the scene loop: pose = pure function of the synced clock */
export function tickAnimatedMixers() {
	const states = get(animatedObjects);
	const time = runtimeNow();
	mixers.forEach(({ mixer, durations }, uuid) => {
		if (behaviors.has(uuid)) return; // 33 P2: packBehavior poses these
		const state = states[uuid];
		if (!state || !state.playing || !state.clip) return;
		const duration = durations[state.clip] || 1;
		mixer.setTime((time * state.speed) % duration);
	});
	// 57 M4: spring bones + expressions, after the mixers posed the bones
	vrmMod?.tickVrms();
}

/**
 * Apply clip/playing/speed (local UI and remote objectParameters both land here).
 * @param {string} uuid @param {{clip?: string, playing?: boolean, speed?: number}} next @param {boolean} replicate
 */
export function setAnimationState(uuid, next, replicate = true) {
	const entry = get(animatedObjects)[uuid];
	const record = mixers.get(uuid);
	if (!entry || !record) return;
	// 33 P2: a functional item has no transport. Pressing play on one in the Animation panel
	// or the Inspector is a LOCAL PREVIEW — never sent, never saved, back to rest at the end
	// (the user's rule: previewing a door in Edit must not leave it open in the file)
	if (behaviors.has(uuid)) {
		if (replicate && (next.playing || next.clip)) behaviorHooks.preview?.(uuid, next.clip ?? entry.clip);
		return;
	}
	const state = { ...entry, ...next };
	animatedObjects.update((map) => ({ ...map, [uuid]: state }));
	if (next.clip && next.clip !== entry.clip) {
		Object.values(record.actions).forEach((action) => action.stop());
		record.actions[state.clip]?.play();
	}
	// 33 P2: nothing autoplays at registration any more, so the FIRST play is what schedules
	// the action — without this a press (or a restored `playing: true`) changed the state and
	// moved nothing
	if (state.playing && state.clip && !record.actions[state.clip]?.isScheduled()) {
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

/** Receive side of the raw-bytes sync (a local restore may pass `live`, see
 * animatedImportsRestore) @param {any} data */
export async function applyObjectFile(data) {
	const group = get(objectsGroup);
	if (!group) return;
	const held = group.getObjectByProperty('uuid', data.uuid);
	if (held) {
		// R22 round 32 — AN ARRIVAL HEAL, and deliberately NOT a re-parse. A rig's
		// geometry is not scene-editable (it travels as its original file bytes precisely
		// because nothing in the app can rewrite it), so the only thing that can have
		// diverged is what an editor CAN touch: where it stands, what it is called, and
		// which clip it is playing. Re-parsing would rebuild the mixer and restart the
		// animation on every walk-in for no gain.
		if (!data.override) return;
		if (data.name) held.name = data.name;
		if (data.lod && typeof data.lod === 'object') held.userData.lod = data.lod;
		applyRootData(held, data);
		if (data.humanoid) void import('./humanoid/humanoidRig.js').then((m) => m.rebuildHumanoidClips(data.uuid));
		if (data.pos) held.position.fromArray(data.pos);
		if (data.rot) held.rotation.set(data.rot[0], data.rot[1], data.rot[2]);
		if (data.scale) held.scale.fromArray(data.scale);
		pokeScene();
		if (data.behaviorState && behaviors.has(data.uuid)) behaviorHooks.apply?.(data.uuid, data.behaviorState);
		else if (data.anim) setAnimationState(data.uuid, data.anim, false);
		return;
	}
	try {
		const bytes = data.buffer instanceof ArrayBuffer ? data.buffer : data.buffer?.buffer ?? data.buffer;
		// absent kind = 'gltf' (every pre-17-D2 sender)
		const { root, animations } = await parseAnimatedBytes(bytes, data.kind);
		// 36 F20: a scene load restoring this rig was superseded while it parsed
		if (data.live && !data.live()) return;
		root.uuid = data.uuid;
		root.name = data.name ?? 'Animated import';
		// 33 P2: the spec rides the message (it lives in the pack row, not the file); absent =
		// whatever the file's own extras say, or nothing
		const spec = normalizeBehavior(data.behavior);
		if (spec) root.userData.behavior = spec;
		if (data.lod && typeof data.lod === 'object') root.userData.lod = data.lod;
		applyRootData(root, data);
		// 33-scenes: the pack file these bytes are, so this copy SAVES as a reference too
		const ref = animRefOf({ userData: { animRef: data.animRef } });
		if (ref) root.userData.animRef = ref;
		if (data.pos) root.position.fromArray(data.pos);
		if (data.rot) root.rotation.set(data.rot[0], data.rot[1], data.rot[2]);
		if (data.scale) root.scale.fromArray(data.scale);
		group.add(root);
		pokeScene();
		registerAnimatedImport(root, animations, bytes, data.kind === 'fbx' ? 'fbx' : data.kind === 'vrm' ? 'vrm' : 'gltf');
		if (behaviors.has(data.uuid)) {
			if (data.behaviorState) behaviorHooks.apply?.(data.uuid, data.behaviorState);
		} else if (data.anim) setAnimationState(data.uuid, data.anim, false);
	} catch (error) {
		console.log('objectfile parse failed', error);
		showToast('Could not load an animated model from a peer');
	}
}

/**
 * Broadcast one animated root to a connection (or everyone)
 * @param {any} conn @param {any} root
 * @param {{override?: boolean}} [opts] R22 round 32 — an ARRIVAL HEAL (see sendObject);
 *   absent for every other caller, and then the message is byte-identical to before.
 */
export function sendAnimatedImport(conn, root, opts = {}) {
	const state = get(animatedObjects)[root.uuid];
	conn.send({
		type: 'objectfile',
		...(opts.override ? { override: true } : {}),
		uuid: root.uuid,
		name: root.name,
		kind: animatedImportKind(root.uuid),
		buffer: fileBytes.get(root.uuid),
		pos: root.position.toArray(),
		rot: [root.rotation.x, root.rotation.y, root.rotation.z],
		scale: root.scale.toArray(),
		anim: state ? { clip: state.clip, playing: state.playing, speed: state.speed } : null,
		// 33 P2: additive — absent for every import without a behavior / a LOD group
		...behaviorFields(root.uuid),
		...rootDataFields(root),
		// 33-scenes: additive — absent for every import that is not a pack piece
		...(animRefOf(root) ? { animRef: animRefOf(root) } : {})
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
		const ref = animRefOf(child);
		if (!ref && bytes.byteLength > MAX_SAVED_BYTES) {
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
			// 33 P2: the SPEC is saved (it is not in the bytes); the open/shut state is runtime
			// and never is — a scene saved with its door open reopens shut
			...(behaviors.has(child.uuid) ? { behavior: behaviors.get(child.uuid) } : {}),
			...rootDataFields(child),
			// 33-scenes: a pack piece names its file (fetched back on restore, once per url);
			// anything else carries its bytes, as always
			...(ref ? { animRef: ref } : { bytes: bytesToBase64(bytes) })
		});
	}
	return out;
}

// ---- 33-scenes: ANIMATED PACK REFERENCES ----------------------------------------------
// A door from the interactive kit is an animated import (its mixer binds the parsed tree,
// so it cannot be packRefs' hollow stub), and a save used to carry its whole GLB — 0.5 to
// 1.4 MB of base64 per door, in every .tpscene and every autosave. Its bytes ARE the pack's
// file, byte for byte (an animated import always saves its ORIGINAL bytes, whatever was
// edited on the live tree), so the entry names the file instead: `animRef = {pack, item,
// path}`, path relative to PACKS_BASE exactly like a kit stub's. The restore fetches it
// (once per url, shared by every copy) and parses it as before. The wire is unchanged —
// a peer still receives the bytes — and an entry with bytes restores as it always did.
// Offline with the pack uncached, the piece cannot come back; that is said once per file,
// the kit stubs' rule.

/** the reference an animated pack piece saves as, or null @param {any} root */
function animRefOf(root) {
	const ref = root?.userData?.animRef;
	return ref && typeof ref.path === 'string' && ref.path ? { pack: String(ref.pack ?? ''), item: String(ref.item ?? ''), path: ref.path } : null;
}

/** url -> the file's bytes (a failure is forgotten so a retry can win) @type {Map<string, Promise<ArrayBuffer>>} */
const refFiles = new Map();
/** paths already reported as unreachable (one toast per file, not per copy) */
const refFailures = new Set();

/** The pack file an `animRef` names, fetched once per url. @param {{pack: string, item: string, path: string}} ref */
async function fetchAnimRef(ref) {
	const { packRefUrl } = await import('./packRefs');
	const url = packRefUrl(ref);
	let job = refFiles.get(url);
	if (!job) {
		job = fetch(url).then((res) => {
			if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
			return res.arrayBuffer();
		});
		refFiles.set(url, job);
		job.catch(() => refFiles.delete(url));
	}
	return job;
}

/**
 * Restore saved animated imports: re-parse the original bytes, rebuild the mixer
 * and push each one to peers. Any static twin a save format wrote anyway (the
 * autosave GLTF cannot exclude it) is removed first, since applyObjectFile
 * declines a uuid that already exists.
 * 21-F4: `replicate` false restores locally with nothing sent — level travel runs the
 * restore on EVERY peer at once, so pushing would broadcast the same raw bytes N ways.
 * 36 F20: `live` — false once the scene load running this restore was superseded; the
 * loop stops and a rig still parsing is not added (it would land in the newer scene).
 * @param {any[]} entries @param {boolean} [replicate] @param {() => boolean} [live]
 */
export async function animatedImportsRestore(entries, replicate = true, live = () => true) {
	if (!entries?.length) return 0;
	const group = get(objectsGroup);
	/** @type {any} */
	const peer = get(peers);
	let restored = 0;
	for (const entry of entries ?? []) {
		if (!live()) break;
		if (!entry?.bytes && !entry?.animRef?.path) continue;
		const stale = group?.getObjectByProperty('uuid', entry.uuid);
		if (stale) stale.parent?.remove(stale);
		try {
			/** @type {ArrayBuffer} */
			let buffer;
			if (entry.bytes) buffer = base64ToBytes(entry.bytes);
			else {
				try {
					buffer = await fetchAnimRef(entry.animRef);
				} catch (error) {
					if (!refFailures.has(entry.animRef.path)) {
						refFailures.add(entry.animRef.path);
						showToast('Could not load "' + (entry.animRef.item || entry.name || 'a pack piece') + '" — its pack is unreachable.');
					}
					throw error;
				}
			}
			await applyObjectFile({
				uuid: entry.uuid,
				name: entry.name,
				kind: entry.kind,
				buffer,
				animRef: entry.animRef,
				pos: entry.pos,
				rot: entry.rot,
				scale: entry.scale,
				anim: entry.anim,
				behavior: entry.behavior,
				lod: entry.lod,
				humanoid: entry.humanoid,
				provenance: entry.provenance,
				vrmExpressions: entry.vrmExpressions,
				live
			});
			if (!live()) break;
			const root = get(objectsGroup)?.getObjectByProperty('uuid', entry.uuid);
			if (root && replicate && peer) sendAnimatedImport(peer, root); // peers reparse the same file
			if (root) restored++;
		} catch (error) {
			console.log('animated import restore failed', error);
		}
	}
	if (restored) pokeScene();
	return restored;
}

/** Cleanup when the object is removed @param {string} uuid */
export function dropAnimatedImport(uuid) {
	vrmMod?.dropVrm(uuid);
	behaviors.delete(uuid);
	restRows.delete(uuid);
	runtimeClips.delete(uuid);
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
	vrmMod?.dropAllVrms();
	behaviors.clear();
	restRows.clear();
	runtimeClips.clear();
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
			pos: entry.pos,
			behavior: entry.behavior,
			lod: entry.lod,
			humanoid: entry.humanoid,
			provenance: entry.provenance,
			vrmExpressions: entry.vrmExpressions,
			animRef: entry.animRef
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
	pokeScene();
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
		...(behaviors.has(root.uuid) ? { behavior: behaviors.get(root.uuid) } : {}),
		...rootDataFields(root),
		...(animRefOf(root) ? { animRef: animRefOf(root) } : {}),
		before: { present: false },
		after: { present: true }
	});
}
