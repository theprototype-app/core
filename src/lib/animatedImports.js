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

/** 57 M3: `at` (when the clip began, a synced stamp) and `from`/`fromSpeed`/`fade` (a crossfade) are optional
 * @type {import('svelte/store').Writable<Record<string, {clips: string[], clip: string, playing: boolean, speed: number, at?: number, from?: string, fromSpeed?: number, fade?: number, resume?: string}>>} */
export const animatedObjects = writable({});

/** @type {Map<string, ArrayBuffer>} rootUuid -> original file bytes */
const fileBytes = new Map();
/** @type {Map<string, 'gltf'|'fbx'>} rootUuid -> which parser those bytes need */
const fileKinds = new Map();
/** @type {Map<string, {mixer: any, actions: Record<string, any>, durations: Record<string, number>, rest?: Map<any, {p: number[], q: number[], s: number[]}>, assets?: Record<string, string>, clipSpeed?: Record<string, number>, clipOnce?: Record<string, boolean>, assetKeys?: Record<string, string>, embeddedOff?: boolean, embedded?: string[], stashed?: Record<string, any>, parts?: boolean, nodeCount?: number, born?: number}>} */
const mixers = new Map();

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
 * @param {any} root @returns {{lod?: any, clipRefs?: any[], clipsOff?: boolean, animGraph?: any}}
 */
function rootDataFields(root) {
	// 57 M1: the clip ASSETS assigned to this model ride beside the bytes for the same reason
	const refs = clipRefsOf(root);
	/** @type {any} */
	const clips = refs.length ? { clipRefs: refs } : {};
	// 57 M8: the model's EMBEDDED clips are switched off (Extract clips ▸ use the files instead)
	if (root?.userData?.clipsOff) clips.clipsOff = true;
	// 57 M11: its Animation states graph (plain JSON, normalized on every apply)
	if (root?.userData?.animGraph && typeof root.userData.animGraph === 'object') clips.animGraph = JSON.parse(JSON.stringify(root.userData.animGraph));
	const lod = root?.userData?.lod;
	if (!lod || typeof lod !== 'object') return clips;
	try {
		return { lod: JSON.parse(JSON.stringify(lod)), ...clips };
	} catch {
		return clips;
	}
}

// ---- 57 M1: CLIP ASSETS (`.tpanim`) ---------------------------------------------------
// A clip is its own small file (fork F1): assigning one to a model writes a REFERENCE
// `userData.clipRefs = [{hash, name}]` on the root — the model's bytes never change, the clip's
// bytes travel once by content hash (assetShare), and every peer binds it to its own parse of the
// model. The refs ride the objectfile message / save entry / undo entry (rootDataFields) and a
// change is ONE `objectParameters 'clipRefs'` message + ONE `clipRefs` undo entry. Binding lives
// in tpanim/clipAssets.js, loaded only when a model has refs (nothing enters the boot graph).

const MAX_CLIP_REFS = 64;

/**
 * The clip refs on a root, normalized (hash + name strings, deduped by hash, capped).
 * @param {any} root @returns {{hash: string, name: string, speed?: number, loop?: boolean, mode?: 'inplace'|'moving'}[]}
 */
export function clipRefsOf(root) {
	return normalizeClipRefs(root?.userData?.clipRefs);
}

/** @param {any} raw @returns {{hash: string, name: string, speed?: number, loop?: boolean, mode?: 'inplace'|'moving'}[]} */
export function normalizeClipRefs(raw) {
	if (!Array.isArray(raw)) return [];
	/** @type {any[]} */
	const out = [];
	const seen = new Set();
	for (const r of raw) {
		if (!r || typeof r.hash !== 'string' || !/^[0-9a-f]{16,128}$/i.test(r.hash) || seen.has(r.hash)) continue;
		seen.add(r.hash);
		/** @type {any} */
		const ref = { hash: r.hash, name: String(r.name ?? 'Clip').slice(0, 80) || 'Clip' };
		// 57 M8: per-clip playback settings, absent = defaults (so a plain ref stays two keys)
		if (Number.isFinite(r.speed) && r.speed > 0 && r.speed !== 1) ref.speed = Math.min(8, Math.max(0.05, r.speed));
		if (typeof r.loop === 'boolean') ref.loop = r.loop;
		// 57 M3: In place / Moving per clip on this model (absent = what the file says)
		if (r.mode === 'inplace' || r.mode === 'moving') ref.mode = r.mode;
		out.push(ref);
		if (out.length >= MAX_CLIP_REFS) break;
	}
	return out;
}

/** 57 M8: the clips the model's own file carries, and whether they are switched off @param {string} uuid */
export function embeddedClipsOf(uuid) {
	const record = mixers.get(uuid);
	return { names: record?.embedded ?? [], off: !!record?.embeddedOff };
}

/** the bound AnimationClip for a clip name (Extract clips reads the embedded ones) @param {string} uuid @param {string} name */
export function threeClipOf(uuid, name) {
	return mixers.get(uuid)?.actions[name]?.getClip() ?? null;
}

/** what a bound clip-asset action was bound from (hash|mode), or null @param {string} uuid @param {string} name */
export function clipAssetKey(uuid, name) {
	return mixers.get(uuid)?.assetKeys?.[name] ?? null;
}

/** the rest pose this model was parsed with, per node (for humanoid binding and Extract clips)
 * @param {string} uuid @returns {(o: any) => {p: number[], q: number[], s: number[]} | null} */
export function restPoseOf(uuid) {
	const rest = mixers.get(uuid)?.rest;
	return (o) => rest?.get(o) ?? null;
}

/** @param {any} root @param {Map<any, {p: number[], q: number[], s: number[]}>} [rest] add to (nodes it holds keep theirs) */
function captureRest(root, rest = new Map()) {
	root.traverse((/** @type {any} */ o) => {
		if (o !== root && !rest.has(o)) rest.set(o, { p: o.position.toArray(), q: o.quaternion.toArray(), s: o.scale.toArray() });
	});
	return rest;
}

/**
 * Add (or replace) a bound clip-asset action on a model's mixer. Called by clipAssets once the
 * bytes are here and bound; a transport already naming this clip starts it.
 * @param {string} uuid @param {any} clip a THREE.AnimationClip bound to this model @param {string} hash
 * @param {string} [key] what the bind depended on (hash + per-ref mode), so a re-attach skips it
 */
export function addClipAction(uuid, clip, hash, key = hash) {
	const record = mixers.get(uuid);
	if (!record) return false;
	const old = record.actions[clip.name];
	if (old) {
		old.stop();
		// an EMBEDDED clip of the same name is stashed, not dropped (Extract ▸ use the files keeps
		// the names, so a graph naming "Walk" plays the file) — it comes back when the file goes
		if (!record.assets?.[clip.name]) record.stashed = { ...(record.stashed ?? {}), [clip.name]: old };
		else record.mixer.uncacheAction(old.getClip());
	}
	record.actions[clip.name] = record.mixer.clipAction(clip);
	record.durations[clip.name] = clip.duration;
	record.assets = { ...(record.assets ?? {}), [clip.name]: hash };
	record.assetKeys = { ...(record.assetKeys ?? {}), [clip.name]: key };
	const entry = get(animatedObjects)[uuid];
	if (entry) {
		const clips = [...entry.clips.filter((c) => c !== clip.name), clip.name];
		/** @type {any} */
		const next = { ...entry, clips, clip: entry.clip ?? clip.name };
		if (entry.resume === clip.name) {
			next.clip = clip.name;
			next.playing = true;
			delete next.resume;
		}
		animatedObjects.update((map) => ({ ...map, [uuid]: next }));
		if (next.playing && next.clip === clip.name) {
			Object.values(record.actions).forEach((action) => action.stop());
			record.actions[clip.name].setEffectiveWeight(1).play();
		}
	}
	return true;
}

/**
 * Drop the clip-asset actions whose name is not in `keep` (a ref was removed or renamed).
 * @param {string} uuid @param {Set<string>} keep
 */
export function pruneClipActions(uuid, keep) {
	const record = mixers.get(uuid);
	if (!record?.assets) return;
	const gone = Object.keys(record.assets).filter((name) => !keep.has(name));
	if (!gone.length) return;
	for (const name of gone) {
		const action = record.actions[name];
		if (action) {
			action.stop();
			record.mixer.uncacheAction(action.getClip());
		}
		delete record.actions[name];
		delete record.durations[name];
		delete record.assets[name];
		if (record.assetKeys) delete record.assetKeys[name];
		const stashed = record.stashed?.[name];
		if (stashed) {
			record.actions[name] = stashed;
			record.durations[name] = stashed.getClip().duration;
			delete record.stashed?.[name];
		}
	}
	const entry = get(animatedObjects)[uuid];
	if (entry) {
		// a restored embedded clip stays listed (unless the embedded clips are off)
		const back = (/** @type {string} */ c) => !!record.actions[c] && !record.embeddedOff;
		const clips = entry.clips.filter((c) => !gone.includes(c) || back(c));
		const clip = gone.includes(entry.clip) && !back(entry.clip) ? clips[0] : entry.clip;
		// a playing clip that goes stops — and comes back playing if its ref returns (undo, then redo)
		const stopped = gone.includes(entry.clip) && entry.playing ? { resume: entry.clip } : {};
		animatedObjects.update((map) => ({ ...map, [uuid]: { ...entry, clips, clip, playing: gone.includes(entry.clip) ? false : entry.playing, ...stopped } }));
	}
}

/** load the binder and (re)bind this model's clip refs — lazy, so a scene without clip assets never fetches it
 * @param {string} uuid */
function attachClipRefs(uuid) {
	const root = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	const hasRefs = clipRefsOf(root).length > 0;
	if (!hasRefs && !mixers.get(uuid)?.assets) return;
	void import('./tpanim/clipAssets.js').then((m) => m.attachClipAssets(uuid));
}

/**
 * Set a model's clip refs: applied here, bound, and (unless `replicate` is false) broadcast as ONE
 * message and recorded as ONE undo entry. 57 M8: `clipsOff` switches the model's EMBEDDED clips
 * off (or back on) in the same step — absent = unchanged.
 * @param {string} uuid @param {any[]} refs @param {{replicate?: boolean, record?: boolean, clipsOff?: boolean}} [opts]
 */
export function setClipRefs(uuid, refs, opts = {}) {
	const root = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (!root && opts.replicate === false) return parkEarly(uuid, { refs, ...(typeof opts.clipsOff === 'boolean' ? { clipsOff: opts.clipsOff } : {}) });
	if (!root || !ensureClipModel(root)) return false;
	const before = clipRefsOf(root);
	const after = normalizeClipRefs(refs);
	const offBefore = !!root.userData.clipsOff;
	const offAfter = typeof opts.clipsOff === 'boolean' ? opts.clipsOff : offBefore;
	if (JSON.stringify(before) === JSON.stringify(after) && offBefore === offAfter) return false;
	if (after.length) root.userData.clipRefs = after;
	else delete root.userData.clipRefs;
	if (offAfter !== offBefore) setEmbeddedOff(uuid, offAfter);
	attachClipRefs(uuid);
	pokeClipModels(); // a settings-only change (mode / loop / speed) moves no clip list
	if (opts.record !== false)
		recordEntry({ kind: 'clipRefs', uuid, before: { refs: before, clipsOff: offBefore }, after: { refs: after, clipsOff: offAfter } });
	if (opts.replicate !== false) {
		/** @type {any} */
		const peer = get(peers);
		if (peer) peer.send({ type: 'objectParameters', parameter: 'clipRefs', uuid, clipRefs: after, ...(offAfter || offBefore ? { clipsOff: offAfter } : {}) });
	}
	return true;
}

/** 57 M8: switch a model's embedded clips off/on (the bytes are untouched; the list hides them) @param {string} uuid @param {boolean} off */
function setEmbeddedOff(uuid, off) {
	const root = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	const record = mixers.get(uuid);
	if (!root || !record) return;
	if (off) root.userData.clipsOff = true;
	else delete root.userData.clipsOff;
	record.embeddedOff = off;
	const entry = get(animatedObjects)[uuid];
	if (!entry) return;
	const assets = Object.keys(record.assets ?? {});
	const clips = off ? entry.clips.filter((c) => assets.includes(c)) : [...(record.embedded ?? []), ...entry.clips.filter((c) => !(record.embedded ?? []).includes(c))];
	const hidden = off && !assets.includes(entry.clip);
	if (hidden) record.actions[entry.clip]?.stop();
	animatedObjects.update((map) => ({ ...map, [uuid]: { ...entry, clips, clip: hidden ? clips[0] : entry.clip, playing: hidden ? false : entry.playing } }));
}

registerHistoryKind('clipRefs', (entry, state) => {
	if (!get(objectsGroup)?.getObjectByProperty('uuid', entry.uuid)) {
		showToast('Cannot undo/redo: the object no longer exists');
		return false;
	}
	// a pre-M8 entry is the refs array alone
	if (Array.isArray(state)) setClipRefs(entry.uuid, state, { record: false });
	else setClipRefs(entry.uuid, state?.refs ?? [], { record: false, clipsOff: !!state?.clipsOff });
	return true;
});

/** GLTFLoader with draco + meshopt decoders wired — 34 R7: the app's one (gltfLoader.js) */
export { createGltfLoader };

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
	// 46: KTX2-aware, scene-safe (a KTX2 texture becomes an ordinary one + its twin)
	/** @type {any} */
	const gltf = await parseGltfSceneSafe(bytes);
	return { root: gltf.scene, animations: gltf.animations ?? [] };
}

/** @param {string} uuid */
export function hasAnimatedImport(uuid) {
	return fileBytes.has(uuid);
}

// ---- 57 M12: PARTS MODELS ---------------------------------------------------------------
// A model with no rig and no clips (an img2threejs import, a kit piece with a rotor and a door)
// can still be animated: its NAMED NODES are its parts. On the first clip ref it gets a mixer of
// its own (no bytes — it replicates and saves through the ordinary object path, which carries
// `userData.clipRefs` / `animGraph`), and node-name `.tpanim` clips bind to it like any skeleton
// clip. A sweep registers the parts models that arrive by a load or a peer's object sync.

/** does this object have a mixer for clips (an animated import, or a parts model)? @param {string} uuid */
export function hasClipModel(uuid) {
	return mixers.has(uuid);
}

/**
 * Make sure an object can take clips: an animated import already can; anything else becomes a
 * PARTS model (a mixer over its own nodes). A functional item (a pack door) cannot.
 * @param {any} root @returns {boolean}
 */
export function ensureClipModel(root) {
	if (!root?.uuid) return false;
	const held = mixers.get(root.uuid);
	// a parts model whose object was REPLACED by an object sync (same uuid, new instance) re-registers
	if (held?.parts && held.mixer.getRoot() !== root) dropPartsRecord(root.uuid, held, true);
	else if (held) return !behaviors.has(root.uuid);
	const mixer = new THREE.AnimationMixer(root);
	mixers.set(root.uuid, { mixer, actions: {}, durations: {}, rest: captureRest(root), embedded: [], embeddedOff: false, parts: true, nodeCount: nodeCountOf(root), born: performance.now() });
	// a re-registered (replaced) model keeps its transport: its clips rebind and carry on playing
	animatedObjects.update((map) => ({ ...map, [root.uuid]: map[root.uuid] ? { ...map[root.uuid], clips: [] } : { clips: [], clip: '', playing: false, speed: 1 } }));
	return true;
}

/** @param {any} root */
function nodeCountOf(root) {
	let n = 0;
	root.traverse(() => n++);
	return n;
}

/** a parts model registered in the last few seconds may still be assembling (see growParts) @param {string} uuid */
export function partsModelSettling(uuid) {
	const record = mixers.get(uuid);
	return !!record?.parts && performance.now() - (record.born ?? 0) < PARTS_SETTLE_MS;
}
const PARTS_SETTLE_MS = 4000;

/**
 * A parts model's NODES can land after its refs: an object sync builds a peer's copy one object
 * at a time (the root, then each part parented to it). When the node count changes, the nodes it
 * gained get a rest pose and the clips not bound yet try again.
 * @param {any} root @param {any} record
 */
function growParts(root, record) {
	const n = nodeCountOf(root);
	if (n === record.nodeCount) return;
	record.nodeCount = n;
	captureRest(root, record.rest);
	if (clipRefsOf(root).some((r) => !record.assets?.[r.name])) attachClipRefs(root.uuid);
}

// A peer's clipRefs / animGraph / transport message can land while its OBJECT is still in this
// peer's ingest queue (an agent imports a model and animates it at once): parked here by uuid and
// applied when the object arrives, refs first, so the transport finds its clip. Unclaimed ones expire.
const EARLY_TTL_MS = 30000;
/** @type {Map<string, {t: number, refs?: any[], clipsOff?: boolean, graph?: any, state?: any}>} */
const early = new Map();

/** @param {string} uuid @param {{refs?: any[], clipsOff?: boolean, graph?: any, state?: any}} part @returns {false} */
function parkEarly(uuid, part) {
	early.set(uuid, { ...(early.get(uuid) ?? {}), ...part, t: performance.now() });
	return false;
}

/** @param {any} group */
function drainEarly(group) {
	const now = performance.now();
	for (const [uuid, held] of [...early]) {
		if (now - held.t > EARLY_TTL_MS) {
			early.delete(uuid);
			continue;
		}
		if (!group.getObjectByProperty('uuid', uuid)) continue;
		early.delete(uuid);
		if (held.refs) setClipRefs(uuid, held.refs, { replicate: false, record: false, ...(typeof held.clipsOff === 'boolean' ? { clipsOff: held.clipsOff } : {}) });
		if ('graph' in held) void setAnimGraph(uuid, held.graph, { replicate: false, record: false });
		if (held.state) setAnimationState(uuid, held.state, false);
	}
}

let lastSweep = 0;
/** register parts models that arrived carrying refs or a graph; forget the ones that left @param {number} time */
function sweepPartsModels(time) {
	if (Math.abs(time - lastSweep) < 0.5) return;
	lastSweep = time;
	const group = get(objectsGroup);
	if (!group) return;
	if (early.size) drainEarly(group);
	for (const child of group.children) {
		const ud = child.userData;
		if (ud?.attachTo && !socketFollowers.has(child.uuid)) syncSocketFollower(child);
		const held = mixers.get(child.uuid);
		if (held?.parts && held.mixer.getRoot() !== child) dropPartsRecord(child.uuid, held, true);
		else if (held) {
			if (held.parts) growParts(child, held);
			continue;
		}
		if (!ud?.clipRefs && !ud?.animGraph) continue;
		if (ensureClipModel(child)) {
			attachClipRefs(child.uuid);
			loadGraphRuntime(child);
		}
	}
	for (const [uuid, record] of mixers) if (record.parts && !group.getObjectByProperty('uuid', uuid)) dropPartsRecord(uuid, record);
}

/** forget a parts model's mixer (its object left, or — `replaced` — a sync swapped the instance)
 * @param {string} uuid @param {any} record @param {boolean} [replaced] keep its transport entry */
function dropPartsRecord(uuid, record, replaced = false) {
	record.mixer.stopAllAction();
	mixers.delete(uuid);
	drivers.delete(uuid);
	if (replaced) return;
	animatedObjects.update((map) => {
		const next = { ...map };
		delete next[uuid];
		return next;
	});
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
	return Object.keys(record.actions).filter((name) => !record.embeddedOff || record.assets?.[name]).map((name) => ({
		name,
		duration: record.durations[name] ?? 0,
		// 57 M1: a clip that came from a `.tpanim` asset names its hash
		...(record.assets?.[name] ? { asset: record.assets[name] } : {})
	}));
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
	const embeddedOff = !!root.userData.clipsOff;
	mixers.set(root.uuid, { mixer, actions, durations, rest: captureRest(root), embedded: animations.map((c) => c.name), embeddedOff });
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
	const first = spec && actions[spec.clip] ? spec.clip : embeddedOff ? undefined : animations[0]?.name;
	animatedObjects.update((map) => ({
		...map,
		[root.uuid]: { clips: embeddedOff ? [] : animations.map((c) => c.name), clip: first, playing: false, speed: 1 }
	}));
	if (behaviors.has(root.uuid)) behaviorHooks.registered?.(root.uuid);
	attachClipRefs(root.uuid); // 57 M1
	loadGraphRuntime(root); // 57 M11
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
	// 57 M12: parts models arriving by a load or a peer's sync (throttled)
	sweepPartsModels(time);
	// 57 M11: the Animation states graphs feed their pose drivers first (lazy; absent = none)
	if (graphTick) graphTick(time);
	mixers.forEach((record, uuid) => {
		if (behaviors.has(uuid)) return; // 33 P2: packBehavior poses these
		// 57 M3: a Blend by Speed node (or a state machine) drives this model's weights LOCALLY
		const driver = drivers.get(uuid);
		if (driver && (driver.hold || (time - driver.stamp < DRIVER_STALE_S && time >= driver.stamp - 1))) return applyDriver(record, driver, time);
		if (driver) releaseDriver(uuid, record);
		const state = states[uuid];
		if (!state || !state.playing || !state.clip) return;
		const { mixer, durations, actions } = record;
		const duration = durations[state.clip] || 1;
		const speed = state.speed * (record.clipSpeed?.[state.clip] ?? 1);
		// 57 M8: a clip ref set to play ONCE holds its last frame (timed from the stamp it began at)
		const at = Number(state.at);
		const once = record.clipOnce?.[state.clip] && Number.isFinite(at);
		const t = once ? Math.min(Math.max((time - at) * speed, 0), duration - 1e-4) : (time * speed) % duration;
		// 57 M3: a CROSSFADE — from `at` for `fade` seconds both clips play and their weights cross,
		// on every peer from the same stamp (no message per frame, no snap)
		const fromName = state.from ?? '';
		const fade = Number(state.fade) || 0;
		const from = fromName ? actions[fromName] : null;
		if (from && fade > 0 && time - at < fade) {
			const k = Math.min(1, Math.max(0, (time - at) / fade));
			const w = k * k * (3 - 2 * k);
			const to = actions[state.clip];
			if (!from.isScheduled()) from.play();
			if (to && !to.isScheduled()) to.play();
			const fromSpeed = (state.fromSpeed ?? state.speed) * (record.clipSpeed?.[fromName] ?? 1);
			from.setEffectiveWeight(1 - w);
			from.time = (time * fromSpeed) % (durations[fromName] || 1);
			if (to) {
				to.setEffectiveWeight(w);
				to.time = t;
			}
			mixer.update(0);
			return;
		}
		if (from?.isScheduled()) {
			from.stop();
			actions[state.clip]?.setEffectiveWeight(1);
		}
		mixer.setTime(t);
	});
	// 57 M12: objects attached to a socket follow it, after the sockets were posed this frame
	if (socketFollowers.size) followSockets();
}

// ---- 57 M12: ATTACH TO A SOCKET ------------------------------------------------------------
// `userData.attachTo = {uuid, socket, offset: [px,py,pz, qx,qy,qz,qw]}` on an object makes it
// follow a named node of a model (a sword in a hand, a lamp on a rotor arm). A CONSTRAINT, not a
// re-parent: the object stays a top-level object (its own saves, sync and undo are untouched) and
// every peer places it each frame from the socket it poses itself — no message per frame.

/** uuid of the follower -> its attach spec @type {Map<string, {uuid: string, socket: string, offset: number[]}>} */
const socketFollowers = new Map();
const _sm = new THREE.Matrix4();
const _so = new THREE.Matrix4();
const _sp = new THREE.Vector3();
const _sq = new THREE.Quaternion();
const _ss = new THREE.Vector3();

/** (re)read one object's attach spec @param {any} object */
export function syncSocketFollower(object) {
	const a = object?.userData?.attachTo;
	if (a && typeof a.uuid === 'string' && typeof a.socket === 'string') socketFollowers.set(object.uuid, { uuid: a.uuid, socket: a.socket, offset: Array.isArray(a.offset) && a.offset.length === 7 ? a.offset : [0, 0, 0, 0, 0, 0, 1] });
	else socketFollowers.delete(object?.uuid);
}

/**
 * Attach an object to a model's socket (a named node), or detach it (`socket` null). `snap` puts
 * it ON the socket; otherwise it keeps where it stands relative to the socket. Applied here and —
 * unless `replicate` / `record` is false — ONE `objectParameters 'attachTo'` message and ONE
 * `attachTo` undo entry. A detach leaves the object where it was last placed.
 * @param {string} itemUuid @param {string | null} modelUuid @param {string | null} socket
 * @param {{snap?: boolean, replicate?: boolean, record?: boolean, spec?: any}} [opts] `spec` = an exact stored spec (undo / a peer)
 * @returns {boolean}
 */
export function attachToSocket(itemUuid, modelUuid, socket, opts = {}) {
	const group = get(objectsGroup);
	const item = group?.getObjectByProperty('uuid', itemUuid);
	if (!item) return false;
	const before = item.userData?.attachTo ?? null;
	/** @type {any} */
	let after = null;
	if (opts.spec !== undefined) after = opts.spec;
	else if (modelUuid && socket) {
		const model = group.getObjectByProperty('uuid', modelUuid);
		const node = model?.getObjectByName(socket) ?? model?.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(socket));
		if (!model || !node || model === item || item.getObjectByProperty('uuid', model.uuid)) return false;
		let offset = [0, 0, 0, 0, 0, 0, 1];
		if (!opts.snap) {
			node.updateWorldMatrix(true, false);
			item.updateWorldMatrix(true, false);
			const rel = new THREE.Matrix4().copy(node.matrixWorld).invert().multiply(item.matrixWorld);
			const p = new THREE.Vector3();
			const q = new THREE.Quaternion();
			rel.decompose(p, q, new THREE.Vector3());
			offset = [...p.toArray(), ...q.toArray()];
		}
		after = { uuid: model.uuid, socket: node.name, offset };
	}
	if (JSON.stringify(before) === JSON.stringify(after)) return false;
	if (after) item.userData.attachTo = after;
	else delete item.userData.attachTo;
	syncSocketFollower(item);
	if (!after) {
		// detached: tell everyone where it was left (the follow was local on every peer)
		/** @type {any} */
		const peer = get(peers);
		if (peer && opts.replicate !== false) peer.send({ type: 'move', uuid: item.uuid, pos: item.position.toArray(), rot: item.rotation.toArray(), scale: item.scale.toArray() });
	}
	if (opts.record !== false) recordEntry({ kind: 'attachTo', uuid: item.uuid, before, after });
	if (opts.replicate !== false) {
		/** @type {any} */
		const peer = get(peers);
		if (peer) peer.send({ type: 'objectParameters', parameter: 'attachTo', uuid: item.uuid, attachTo: after });
	}
	return true;
}

registerHistoryKind('attachTo', (entry, state) => {
	if (!get(objectsGroup)?.getObjectByProperty('uuid', entry.uuid)) {
		showToast('Cannot undo/redo: the object no longer exists');
		return false;
	}
	attachToSocket(entry.uuid, null, null, { spec: state ?? null, record: false });
	return true;
});

/** the sockets (named nodes) a model offers, for a picker @param {string} uuid @returns {string[]} */
export function socketsOf(uuid) {
	const model = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	/** @type {string[]} */
	const out = [];
	model?.traverse((/** @type {any} */ o) => {
		if (o !== model && o.name && !o.isMesh && !o.isSkinnedMesh) out.push(o.name);
	});
	return out;
}

function followSockets() {
	const group = get(objectsGroup);
	if (!group) return;
	for (const [uuid, a] of socketFollowers) {
		const obj = group.getObjectByProperty('uuid', uuid);
		const model = group.getObjectByProperty('uuid', a.uuid);
		const socket = model?.getObjectByName(a.socket) ?? model?.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(a.socket));
		if (!obj || !socket || obj.userData?.attachTo?.uuid !== a.uuid) {
			if (!obj || !obj.userData?.attachTo) socketFollowers.delete(uuid);
			continue;
		}
		socket.updateWorldMatrix(true, false);
		_so.compose(_sp.set(a.offset[0], a.offset[1], a.offset[2]), _sq.set(a.offset[3], a.offset[4], a.offset[5], a.offset[6]), _ss.set(1, 1, 1));
		_sm.multiplyMatrices(socket.matrixWorld, _so);
		// into the follower's parent frame (normally the scene root)
		if (obj.parent) {
			obj.parent.updateWorldMatrix(true, false);
			_sm.premultiply(_so.copy(obj.parent.matrixWorld).invert());
		}
		_sm.decompose(_sp, _sq, _ss);
		obj.position.copy(_sp);
		obj.quaternion.copy(_sq);
	}
}

// ---- 57 M3: LOCAL POSE DRIVERS (Blend by Speed, the Animation states graph) ---------------
// A driver sets per-clip WEIGHTS and rates every frame from inputs every peer already has (a
// speed derived from the replicated transform, synced parameters), so it needs no message: each
// peer blends its own copy. It overrides the transport while it is fresh, and lets go when its
// node stops feeding it (deleted, or the graph stopped).

const DRIVER_STALE_S = 0.5;
/** 57 M3: a driver weight below this sits out of the blend (see applyDriver) */
const DRIVER_MIN_WEIGHT = 0.01;

// ---- 57 M11: the ANIMATION STATES graph on a model -----------------------------------------
// `userData.animGraph` (tpanim/animGraph.js's shape) is config: it rides the objectfile message,
// saves and undo (rootDataFields), a change is ONE `objectParameters 'animGraph'` message + ONE
// `animGraph` undo entry, and every peer evaluates it itself (tpanim/animGraphRuntime.js, loaded
// only when a model has one) into the model's pose driver.

/** @type {((time: number) => void) | null} */
let graphTick = null;
/** the graph runtime plugs its per-frame step in here @param {((time: number) => void) | null} fn */
export function setAnimGraphTick(fn) {
	graphTick = fn;
}

/** userData changed under the clip panels: a shallow copy re-runs every subscriber */
function pokeClipModels() {
	animatedObjects.update((map) => ({ ...map }));
}

/** @param {any} root */
function loadGraphRuntime(root) {
	if (!root?.userData?.animGraph && !graphTick) return;
	void import('./tpanim/animGraphRuntime.js').then((m) => m.syncAnimGraph(root.uuid));
}

/**
 * Set (or clear, with null) a model's Animation states graph — ONE message, ONE undo step.
 * @param {string} uuid @param {any} graph @param {{replicate?: boolean, record?: boolean}} [opts]
 */
export async function setAnimGraph(uuid, graph, opts = {}) {
	const root = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (!root && opts.replicate === false) return parkEarly(uuid, { graph: graph ?? null });
	if (!root || !ensureClipModel(root)) return false;
	const { normalizeAnimGraph } = await import('./tpanim/animGraph.js');
	const before = root.userData.animGraph ?? null;
	const after = graph ? normalizeAnimGraph(graph) : null;
	if (JSON.stringify(before) === JSON.stringify(after)) return false;
	if (after) root.userData.animGraph = after;
	else delete root.userData.animGraph;
	loadGraphRuntime(root);
	pokeClipModels();
	if (opts.record !== false) recordEntry({ kind: 'animGraph', uuid, before, after });
	if (opts.replicate !== false) {
		/** @type {any} */
		const peer = get(peers);
		if (peer) peer.send({ type: 'objectParameters', parameter: 'animGraph', uuid, animGraph: after });
	}
	return true;
}

registerHistoryKind('animGraph', (entry, state) => {
	if (!get(objectsGroup)?.getObjectByProperty('uuid', entry.uuid)) {
		showToast('Cannot undo/redo: the object no longer exists');
		return false;
	}
	void setAnimGraph(entry.uuid, state, { record: false });
	return true;
});
/** @type {Map<string, {weights: Record<string, number>, rates: Record<string, number>, phase: Record<string, number>, stamp: number, last: number, hold?: boolean, times?: Record<string, number> | null}>} */
const drivers = new Map();

/**
 * Feed a model's blend for this frame: `weights` per clip name (normalized here), `rates` = clip
 * seconds per second for each (1 = its own speed). LOCAL, never sent. 57 M8: `times` pins clips
 * at absolute clip times (the Animation window's scrub preview) and `hold` keeps the driver until
 * `clearPoseDriver`, with no per-frame feeding.
 * @param {string} uuid @param {Record<string, number>} weights @param {Record<string, number>} [rates]
 * @param {{times?: Record<string, number>, hold?: boolean}} [opts]
 */
export function setPoseDriver(uuid, weights, rates = {}, opts = {}) {
	if (!mixers.has(uuid) || behaviors.has(uuid)) return false;
	const now = runtimeNow();
	const d = drivers.get(uuid) ?? { weights: {}, rates: {}, phase: {}, stamp: now, last: now };
	d.weights = weights;
	d.rates = rates;
	d.stamp = now;
	d.hold = !!opts.hold;
	d.times = opts.times ?? null;
	drivers.set(uuid, d);
	return true;
}

/** stop driving a model (it returns to its transport) @param {string} uuid */
export function clearPoseDriver(uuid) {
	const record = mixers.get(uuid);
	if (record) releaseDriver(uuid, record);
	else drivers.delete(uuid);
}

/** is a driver feeding this model now? @param {string} uuid */
export function poseDriverOf(uuid) {
	const d = drivers.get(uuid);
	return d && runtimeNow() - d.stamp < DRIVER_STALE_S ? { weights: { ...d.weights } } : null;
}

/** @param {any} record @param {any} d @param {number} time */
function applyDriver(record, d, time) {
	const dt = Math.min(Math.max(time - d.last, 0), 0.1);
	d.last = time;
	// a sliver of weight (a blend's tail: run at 0.0004 beside walk) costs a whole skeleton's
	// evaluation and shows nothing — below 1 % a clip sits out and the rest renormalize
	let floor = DRIVER_MIN_WEIGHT;
	let top = 0;
	for (const name of Object.keys(d.weights)) if (record.actions[name]) top = Math.max(top, d.weights[name]);
	if (top < floor) floor = top; // every weight that small: the strongest still plays (never the rest pose)
	const live = (/** @type {string} */ name) => d.weights[name] > 0 && d.weights[name] >= floor;
	let sum = 0;
	for (const name of Object.keys(d.weights)) if (record.actions[name] && live(name)) sum += d.weights[name];
	for (const [name, action] of Object.entries(record.actions)) {
		const w = sum > 0 && live(name) ? d.weights[name] / sum : 0;
		const a = /** @type {any} */ (action);
		if (w <= 0) {
			if (a.isScheduled()) a.stop();
			continue;
		}
		if (!a.isScheduled()) a.play();
		const duration = record.durations[name] || 1;
		const rate = (d.rates[name] ?? 1) * (record.clipSpeed?.[name] ?? 1);
		const pinned = d.times?.[name];
		if (Number.isFinite(pinned)) d.phase[name] = Math.min(Math.max(/** @type {number} */ (pinned), 0), duration - 1e-4);
		else d.phase[name] = ((d.phase[name] ?? (time * rate) % duration) + dt * rate) % duration;
		a.setEffectiveWeight(w);
		a.time = d.phase[name];
	}
	record.mixer.update(0);
}

/** @param {string} uuid @param {any} record */
function releaseDriver(uuid, record) {
	drivers.delete(uuid);
	for (const action of Object.values(record.actions)) {
		/** @type {any} */ (action).stop();
		/** @type {any} */ (action).setEffectiveWeight(1);
	}
	const state = get(animatedObjects)[uuid];
	if (state?.playing && state.clip) record.actions[state.clip]?.play();
}

/**
 * 57 M8: per-clip playback factors from the refs (speed multiplier, play-once) — kept on the record
 * so the tick reads plain numbers. @param {string} uuid @param {{name: string, speed?: number, loop?: boolean}[]} refs
 */
export function setClipPlayback(uuid, refs) {
	const record = mixers.get(uuid);
	if (!record) return;
	/** @type {Record<string, number>} */
	const speed = {};
	/** @type {Record<string, boolean>} */
	const once = {};
	for (const r of refs) {
		if (r.speed && r.speed !== 1) speed[r.name] = r.speed;
		if (r.loop === false) once[r.name] = true;
	}
	record.clipSpeed = speed;
	record.clipOnce = once;
}

/**
 * Apply clip/playing/speed (local UI and remote objectParameters both land here).
 * @param {string} uuid @param {{clip?: string, playing?: boolean, speed?: number, at?: number, fade?: number, from?: string, fromSpeed?: number}} next @param {boolean} replicate
 */
export function setAnimationState(uuid, next, replicate = true) {
	const entry = get(animatedObjects)[uuid];
	const record = mixers.get(uuid);
	if ((!entry || !record) && !replicate && !get(objectsGroup)?.getObjectByProperty('uuid', uuid)) {
		parkEarly(uuid, { state: { ...(early.get(uuid)?.state ?? {}), ...next } });
		return;
	}
	if (!entry || !record) return;
	// 33 P2: a functional item has no transport. Pressing play on one in the Animation panel
	// or the Inspector is a LOCAL PREVIEW — never sent, never saved, back to rest at the end
	// (the user's rule: previewing a door in Edit must not leave it open in the file)
	if (behaviors.has(uuid)) {
		if (replicate && (next.playing || next.clip)) behaviorHooks.preview?.(uuid, next.clip ?? entry.clip);
		return;
	}
	/** @type {any} */
	const state = { ...entry, ...next };
	// a transport change overrides a clip waiting to resume (pruneClipActions)
	delete state.resume;
	const changed = !!next.clip && next.clip !== entry.clip;
	// 57 M3: the moment the clip began (`at`, a synced stamp — the trigger's, when a node played it)
	// times a play-once clip and a crossfade. A remote state carries its own; a local change takes
	// the caller's, else now. `fade` > 0 on a clip change while one plays = a crossfade from it.
	if (replicate || next.at === undefined) {
		if (changed || (next.playing && !entry.playing)) state.at = Number.isFinite(next.at) ? next.at : runtimeNow();
		if (changed && Number(next.fade) > 0 && entry.playing && entry.clip && record.actions[entry.clip]) {
			state.from = entry.clip;
			state.fromSpeed = entry.speed;
			state.fade = Math.min(5, Number(next.fade));
		} else if (changed) {
			delete state.from;
			delete state.fromSpeed;
			delete state.fade;
		}
	}
	animatedObjects.update((map) => ({ ...map, [uuid]: state }));
	if (changed) {
		Object.entries(record.actions).forEach(([name, action]) => {
			if (name !== state.from) action.stop();
		});
		// 57 M3: stop() keeps an action's weight, so one left mid-crossfade would play half-strength
		record.actions[state.clip]?.setEffectiveWeight(1).play();
	}
	// 33 P2: nothing autoplays at registration any more, so the FIRST play is what schedules
	// the action — without this a press (or a restored `playing: true`) changed the state and
	// moved nothing
	if (state.playing && state.clip && !record.actions[state.clip]?.isScheduled()) {
		Object.values(record.actions).forEach((action) => action.stop());
		// 57 M3: stop() keeps an action's weight, so one left mid-crossfade would play half-strength
		record.actions[state.clip]?.setEffectiveWeight(1).play();
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
				speed: state.speed,
				// 57 M3: additive — absent for a peer that sends no stamp (it then plays on the clock)
				...(Number.isFinite(state.at) ? { at: state.at } : {}),
				...(state.from ? { from: state.from, fromSpeed: state.fromSpeed, fade: state.fade } : {})
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
		if (data.clipRefs || data.clipsOff !== undefined)
			setClipRefs(data.uuid, data.clipRefs ?? clipRefsOf(held), { replicate: false, record: false, clipsOff: !!data.clipsOff });
		if (data.animGraph !== undefined) void setAnimGraph(data.uuid, data.animGraph, { replicate: false, record: false });
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
		// 57 M1: the clip assets this model plays (bound once registered)
		const refs = normalizeClipRefs(data.clipRefs);
		if (refs.length) root.userData.clipRefs = refs;
		if (data.clipsOff === true) root.userData.clipsOff = true;
		if (data.animGraph && typeof data.animGraph === 'object') root.userData.animGraph = data.animGraph; // 57 M11
		// 33-scenes: the pack file these bytes are, so this copy SAVES as a reference too
		const ref = animRefOf({ userData: { animRef: data.animRef } });
		if (ref) root.userData.animRef = ref;
		if (data.pos) root.position.fromArray(data.pos);
		if (data.rot) root.rotation.set(data.rot[0], data.rot[1], data.rot[2]);
		if (data.scale) root.scale.fromArray(data.scale);
		group.add(root);
		pokeScene();
		registerAnimatedImport(root, animations, bytes, data.kind === 'fbx' ? 'fbx' : 'gltf');
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
				clipRefs: entry.clipRefs,
				clipsOff: entry.clipsOff,
				animGraph: entry.animGraph,
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
	behaviors.delete(uuid);
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
	behaviors.clear();
	fileBytes.clear();
	fileKinds.clear();
	mixers.clear();
	early.clear();
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
			clipRefs: entry.clipRefs,
			clipsOff: entry.clipsOff,
			animGraph: entry.animGraph,
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
