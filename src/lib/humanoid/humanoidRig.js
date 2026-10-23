// 57 M2 — HUMANOIDS IN THE SCENE: each rigged model's map, and clips applied to it from elsewhere.
//
// THE CONFIG is `root.userData.humanoid = {map?: {bone: nodeName | ''}, clips?: [{name, src}]}` —
// the user's map FIXES on top of the detected map, and the clips applied to this character. It is
// replicated (`objectParameters` parameter 'humanoid'), saved, sent with the bytes (rootDataFields)
// and undoable. What it NAMES is computed here, on every peer: the source clip is retargeted onto
// this rig and added to its mixer as a RUNTIME clip. The model's bytes never change.
//
// A clip's `src` is one of:
//   {uuid, clip}       a clip another model in the scene plays (embedded, or itself applied)
//   {lib: 'avatars', clip}  the 36 avatars' shared KayKit motions (CC0), on the KayKit rig
//   {asset, clip?}     a `.tpanim` clip asset (57 M1; resolved through `clipAssetResolver`)
// A source that is not here yet (a late joiner's restore order, an asset still arriving) leaves the
// target PENDING; every registration and every resolver retry looks again.
//
// LAZY: imported only for a model that has a config, by the Inspector's Character section, by the
// wire applier and by the Apply dialog — never on the boot graph.

import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../../stores/sceneStore';
import { peers, showToast } from '../../stores/appStore';
import { registerHistoryKind, recordEntry, beginHistoryBatch, endHistoryBatch } from '../history';
import {
	restRowsOf,
	clipOf,
	setRuntimeClips,
	onAnimatedRegistered,
	animatedObjects,
	hasAnimatedImport,
	setAnimationState,
	runtimeClipNames
} from '../animatedImports';
import {
	detectHumanoidMap,
	applyMapOverrides,
	missingRequired,
	rigFamily,
	isHumanBone
} from './humanoidMap.js';
export { rigLabel, boneLabel } from './humanoidMap.js';
import { makeSnapshot, retargetClip } from './retarget.js';
import { licenceOf, normalizeLicence } from '../provenance.js';

/** @typedef {import('./humanoidMap.js').HumanoidMap} HumanoidMap */
/** @typedef {{uuid: string, clip: string} | {lib: 'avatars', clip: string} | {asset: string, clip?: string}} ClipSource */
/** @typedef {{name: string, src: ClipSource, licence?: any, from?: string}} AppliedClip */
/** @typedef {{map?: Record<string, string>, clips?: AppliedClip[]}} HumanoidConfig */

const MAX_CLIPS = 64;
/** retargeted clips are sampled at this rate on every peer (part of what makes them identical) */
export const RETARGET_FPS = 30;

/** maps a model brought with it (a VRM's humanoid extension) @type {Map<string, Record<string, string>>} */
const fileMaps = new Map();
/** targets whose config names a source not here yet */
const pending = new Set();
/** rebuild generation per target (a stale async result is dropped) @type {Map<string, number>} */
const generation = new Map();

/**
 * 57 M1 plugs in here: a `.tpanim` asset -> the clip + the rig it is on (null = not here yet).
 * @typedef {(src: {asset: string, clip?: string}) => Promise<{clip: THREE.AnimationClip, snapshot: import('./retarget.js').RigSnapshot, licence?: any} | null>} ClipAssetResolver
 */
/** @type {ClipAssetResolver | null} */
let clipAssetResolver = null;
/** @param {ClipAssetResolver | null} fn */
export function setClipAssetResolver(fn) {
	clipAssetResolver = fn;
	for (const uuid of [...pending]) void rebuildHumanoidClips(uuid);
}

/** A VRM (or any file that names its own humanoid bones) registers its map here.
 * @param {string} uuid @param {Record<string, string>} map */
export function setFileHumanoid(uuid, map) {
	fileMaps.set(uuid, { ...map });
	detected.delete(uuid);
}

/** @param {string} uuid */
function rootOf(uuid) {
	return /** @type {any} */ (get(objectsGroup))?.getObjectByProperty('uuid', uuid) ?? null;
}

// ---- the map -------------------------------------------------------------------------------

/**
 * The bone list detection reads: the rest rows' BONES, parents re-pointed past non-bone nodes,
 * root-space rest positions.
 * @param {ReturnType<typeof restRowsOf>} rows
 */
export function boneEntries(rows) {
	/** @type {THREE.Matrix4[]} */
	const M = [];
	rows.forEach((r) => {
		const m = new THREE.Matrix4().compose(
			new THREE.Vector3().fromArray(r.t),
			new THREE.Quaternion().fromArray(r.q),
			new THREE.Vector3().fromArray(r.s)
		);
		if (r.parent >= 0) m.premultiply(M[r.parent]);
		M.push(m);
	});
	const boneIdx = rows.map((r, i) => (r.bone ? i : -1)).filter((i) => i >= 0);
	const at = new Map(boneIdx.map((i, k) => [i, k]));
	return boneIdx.map((i) => {
		let p = rows[i].parent;
		while (p >= 0 && !at.has(p)) p = rows[p].parent;
		const v = new THREE.Vector3().setFromMatrixPosition(M[i]);
		return {
			name: rows[i].name,
			parent: p >= 0 ? /** @type {number} */ (at.get(p)) : -1,
			pos: [v.x, v.y, v.z]
		};
	});
}

/** detection results per uuid (the rest never changes for a registered model) @type {Map<string, HumanoidMap>} */
const detected = new Map();

/**
 * This model's humanoid map: the file's own (VRM), else detected, with the user's fixes on top.
 * @param {string} uuid @returns {(HumanoidMap & {detected: Record<string, string>, overrides: Record<string, string>, bones: string[]}) | null}
 */
export function humanoidOf(uuid) {
	const rows = restRowsOf(uuid);
	if (!rows.length) return null;
	let base = detected.get(uuid);
	if (!base) {
		const file = fileMaps.get(uuid);
		if (file)
			base = {
				map: file,
				rig: 'vrm',
				missing: missingRequired(file),
				ok: !missingRequired(file).length,
				via: 'file'
			};
		else base = detectHumanoidMap(boneEntries(rows));
		detected.set(uuid, base);
	}
	const overrides = configOf(uuid).map ?? {};
	const map = applyMapOverrides(base.map, overrides);
	const missing = missingRequired(map);
	return {
		...base,
		map,
		missing,
		ok: !missing.length,
		detected: base.map,
		overrides,
		bones: rows.filter((r) => r.bone).map((r) => r.name)
	};
}

/** the rig's rest snapshot on its humanoid map @param {string} uuid */
export function restSnapshotOf(uuid) {
	const h = humanoidOf(uuid);
	if (!h) return null;
	return makeSnapshot(restRowsOf(uuid), h.map);
}

/** forget a model's cached detection (its bytes were replaced by a rig fix) @param {string} uuid */
export function forgetHumanoid(uuid) {
	detected.delete(uuid);
	fileMaps.delete(uuid);
}

// ---- the config ----------------------------------------------------------------------------

/** @param {any} raw @returns {HumanoidConfig} */
export function normalizeHumanoidConfig(raw) {
	/** @type {HumanoidConfig} */
	const out = {};
	if (!raw || typeof raw !== 'object') return out;
	if (raw.map && typeof raw.map === 'object') {
		/** @type {Record<string, string>} */
		const map = {};
		for (const [k, v] of Object.entries(raw.map))
			if (isHumanBone(k) && typeof v === 'string' && v.length <= 200) map[k] = v;
		if (Object.keys(map).length) out.map = map;
	}
	if (Array.isArray(raw.clips)) {
		/** @type {AppliedClip[]} */
		const clips = [];
		for (const c of raw.clips.slice(0, MAX_CLIPS)) {
			const src = normalizeSource(c?.src);
			if (!src || typeof c.name !== 'string' || !c.name || c.name.length > 120) continue;
			/** @type {AppliedClip} */
			const row = { name: c.name, src };
			const lic = normalizeLicence(c.licence);
			if (lic) row.licence = lic;
			if (typeof c.from === 'string') row.from = c.from.slice(0, 120);
			clips.push(row);
		}
		if (clips.length) out.clips = clips;
	}
	return out;
}

/** @param {any} s @returns {ClipSource | null} */
function normalizeSource(s) {
	if (!s || typeof s !== 'object') return null;
	if (typeof s.uuid === 'string' && typeof s.clip === 'string')
		return { uuid: s.uuid.slice(0, 64), clip: s.clip.slice(0, 200) };
	if (s.lib === 'avatars' && typeof s.clip === 'string')
		return { lib: 'avatars', clip: s.clip.slice(0, 200) };
	if (typeof s.asset === 'string')
		return typeof s.clip === 'string'
			? { asset: s.asset.slice(0, 128), clip: s.clip.slice(0, 200) }
			: { asset: s.asset.slice(0, 128) };
	return null;
}

/** @param {string} uuid @returns {HumanoidConfig} */
export function configOf(uuid) {
	return normalizeHumanoidConfig(rootOf(uuid)?.userData?.humanoid);
}

/**
 * Set a model's config: apply here, rebuild its clips, send, undo. LOCAL = no send, no undo
 * (the wire applier, an undo step).
 * @param {string} uuid @param {HumanoidConfig} cfg @param {{replicate?: boolean, history?: boolean}} [opts]
 */
export function applyHumanoidConfig(uuid, cfg, opts = {}) {
	const root = rootOf(uuid);
	if (!root) return false;
	const before = normalizeHumanoidConfig(root.userData.humanoid);
	const next = normalizeHumanoidConfig(cfg);
	if (next.map || next.clips) root.userData.humanoid = next;
	else delete root.userData.humanoid;
	if (opts.history !== false && opts.replicate !== false)
		recordEntry({ kind: 'humanoidcfg', uuid, before: { cfg: before }, after: { cfg: next } });
	if (opts.replicate !== false) {
		/** @type {any} */
		const peer = get(peers);
		peer?.send({ type: 'objectParameters', parameter: 'humanoid', uuid, humanoid: next });
	}
	void rebuildHumanoidClips(uuid);
	pokeScene();
	return true;
}

registerHistoryKind('humanoidcfg', (entry, state) => {
	if (!rootOf(entry.uuid)) {
		showToast('Cannot undo/redo: the object no longer exists');
		return false;
	}
	applyHumanoidConfig(entry.uuid, state.cfg, { history: false });
	return true;
});

/** the wire applier (commandsHandler `objectParameters`) @param {any} data */
export function receiveHumanoid(data) {
	applyHumanoidConfig(data.uuid, data.humanoid, { replicate: false });
}

// ---- sources -------------------------------------------------------------------------------

/** the KayKit library rig + clips, loaded once @type {Promise<{snapshot: import('./retarget.js').RigSnapshot, clips: Record<string, THREE.AnimationClip>}> | null} */
let avatarLib = null;

function loadAvatarLibrary() {
	if (!avatarLib) {
		avatarLib = (async () => {
			const { loadCharacter, loadClips } = await import('../avatars/assets.js');
			const { rigSnapshot } = await import('./retarget.js');
			const [gltf, clips] = await Promise.all([loadCharacter('knight'), loadClips()]);
			/** @type {any[]} */
			const bones = [];
			gltf.scene.traverse((/** @type {any} */ o) => o.isBone && bones.push(o));
			// the shared template is never posed (avatars clone it), so this IS the rest
			const rows = bones.map((b) => {
				const v = new THREE.Vector3();
				b.getWorldPosition(v);
				return { name: b.name, parent: bones.indexOf(b.parent), pos: [v.x, v.y, v.z] };
			});
			const { map } = detectHumanoidMap(rows);
			return { snapshot: rigSnapshot(gltf.scene, map), clips };
		})();
		avatarLib.catch(() => (avatarLib = null));
	}
	return avatarLib;
}

/** the avatars' motions a user can apply (names only) */
export async function avatarClipNames() {
	try {
		const lib = await loadAvatarLibrary();
		return Object.keys(lib.clips).sort();
	} catch {
		return [];
	}
}

/**
 * Resolve a source to the clip + the rig it is on. null = not here (yet).
 * @param {ClipSource} src @returns {Promise<{clip: THREE.AnimationClip, snapshot: import('./retarget.js').RigSnapshot, licence?: any} | null>}
 */
async function resolveSource(src) {
	if ('uuid' in src) {
		const clip = clipOf(src.uuid, src.clip);
		const snapshot = restSnapshotOf(src.uuid);
		if (!clip || !snapshot) return null;
		return { clip, snapshot, licence: licenceOf(rootOf(src.uuid)?.userData) };
	}
	if ('lib' in src) {
		const lib = await loadAvatarLibrary();
		const clip = lib.clips[src.clip];
		return clip
			? {
					clip,
					snapshot: lib.snapshot,
					licence: {
						id: 'CC0-1.0',
						author: 'Kay Lousberg (KayKit)',
						title: 'KayKit character animations'
					}
				}
			: null;
	}
	return clipAssetResolver ? clipAssetResolver(src) : null;
}

/**
 * Rebuild a target's runtime clips from its config (every peer runs this for itself).
 * @param {string} uuid @returns {Promise<number>} how many clips were built
 */
export async function rebuildHumanoidClips(uuid) {
	const gen = (generation.get(uuid) ?? 0) + 1;
	generation.set(uuid, gen);
	const cfg = configOf(uuid);
	const target = restSnapshotOf(uuid);
	if (!target || !hasAnimatedImport(uuid)) return 0;
	/** @type {THREE.AnimationClip[]} */
	const built = [];
	let missing = 0;
	for (const row of cfg.clips ?? []) {
		/** @type {any} */
		let source = null;
		try {
			source = await resolveSource(row.src);
		} catch (error) {
			console.log('clip source failed', error);
		}
		if (generation.get(uuid) !== gen) return 0; // a newer config superseded this one
		if (!source) {
			missing++;
			continue;
		}
		built.push(
			retargetClip(source.clip, source.snapshot, target, { fps: RETARGET_FPS, name: row.name })
		);
	}
	if (generation.get(uuid) !== gen) return 0;
	if (missing) pending.add(uuid);
	else pending.delete(uuid);
	setRuntimeClips(uuid, built);
	pokeScene();
	return built.length;
}

// a source that arrives late (restore order, a joiner) completes its pending targets
onAnimatedRegistered((uuid) => {
	for (const t of [...pending]) {
		if (t === uuid) continue;
		if ((configOf(t).clips ?? []).some((c) => 'uuid' in c.src && c.src.uuid === uuid))
			void rebuildHumanoidClips(t);
	}
});

// ---- Apply to… -------------------------------------------------------------------------------

/**
 * Every model in the scene with a humanoid map, for the Apply dialog's target list.
 * @returns {{uuid: string, name: string, rig: string, ok: boolean, missing: string[]}[]}
 */
export function humanoidsInScene() {
	/** @type {{uuid: string, name: string, rig: string, ok: boolean, missing: string[]}[]} */
	const out = [];
	for (const child of /** @type {any} */ (get(objectsGroup))?.children ?? []) {
		if (!hasAnimatedImport(child.uuid)) continue;
		const h = humanoidOf(child.uuid);
		if (!h || !h.bones.length) continue;
		out.push({
			uuid: child.uuid,
			name: child.name || 'Character',
			rig: h.rig,
			ok: h.ok,
			missing: h.missing
		});
	}
	return out;
}

/**
 * Every clip a user can apply: models in the scene that play clips on a humanoid rig, and the
 * built-in avatar motions.
 * @returns {Promise<{label: string, src: ClipSource, group: string}[]>}
 */
export async function clipSourcesInScene() {
	/** @type {{label: string, src: ClipSource, group: string}[]} */
	const out = [];
	const states = get(animatedObjects);
	for (const child of /** @type {any} */ (get(objectsGroup))?.children ?? []) {
		const state = states[child.uuid];
		if (!state?.clips?.length) continue;
		const h = humanoidOf(child.uuid);
		if (!h?.ok) continue;
		for (const clip of state.clips)
			out.push({ label: clip, src: { uuid: child.uuid, clip }, group: child.name || 'Model' });
	}
	for (const clip of await avatarClipNames())
		out.push({ label: clip, src: { lib: 'avatars', clip }, group: 'Avatar motions (KayKit, CC0)' });
	return out;
}

/** a clip name not yet used on this target @param {string} uuid @param {string} want @param {HumanoidConfig} cfg */
function uniqueClipName(uuid, want, cfg) {
	const taken = new Set([
		...(get(animatedObjects)[uuid]?.clips ?? []),
		...(cfg.clips ?? []).map((c) => c.name)
	]);
	if (!taken.has(want)) return want;
	for (let n = 2; n < 1000; n++) if (!taken.has(want + ' ' + n)) return want + ' ' + n;
	return want + ' ' + Date.now();
}

/**
 * Apply a clip to humanoid targets: each gets a config row, rebuilds its clip, and (`play`)
 * starts playing it. One undo step per target (a batch when several).
 * @param {string[]} targets @param {ClipSource} src @param {{play?: boolean, name?: string}} [opts]
 * @returns {Promise<{applied: string[], refused: {uuid: string, why: string}[]}>}
 */
export async function applyClipTo(targets, src, opts = {}) {
	/** @type {string[]} */
	const applied = [];
	/** @type {{uuid: string, why: string}[]} */
	const refused = [];
	const source = await resolveSource(src);
	if (!source) {
		showToast('That clip is not available yet');
		return { applied, refused: targets.map((uuid) => ({ uuid, why: 'source missing' })) };
	}
	const srcName =
		'uuid' in src
			? rootOf(src.uuid)?.name || 'a model'
			: 'lib' in src
				? 'Avatar motions'
				: 'a clip file';
	const many = targets.length > 1;
	if (many) beginHistoryBatch();
	try {
		for (const uuid of targets) {
			if ('uuid' in src && src.uuid === uuid) {
				refused.push({ uuid, why: "it is the clip's own model" });
				continue;
			}
			const h = humanoidOf(uuid);
			if (!h?.ok) {
				refused.push({
					uuid,
					why: h ? 'missing bones: ' + h.missing.join(', ') : 'not a rigged model'
				});
				continue;
			}
			const cfg = configOf(uuid);
			const name = uniqueClipName(
				uuid,
				opts.name ?? source.clip.name ?? ('clip' in src ? src.clip : 'Clip'),
				cfg
			);
			/** @type {AppliedClip} */
			const row = { name, src, from: srcName };
			if (source.licence) row.licence = source.licence;
			applyHumanoidConfig(uuid, { ...cfg, clips: [...(cfg.clips ?? []), row] });
			applied.push(uuid);
		}
	} finally {
		if (many) endHistoryBatch('Apply clip');
	}
	if (opts.play !== false) {
		for (const uuid of applied) {
			await rebuildHumanoidClips(uuid);
			const name = configOf(uuid).clips?.slice(-1)[0]?.name;
			if (name && runtimeClipNames(uuid).includes(name))
				setAnimationState(uuid, { clip: name, playing: true });
		}
	}
	return { applied, refused };
}

/** remove an applied clip from a target @param {string} uuid @param {string} name */
export function removeAppliedClip(uuid, name) {
	const cfg = configOf(uuid);
	const clips = (cfg.clips ?? []).filter((c) => c.name !== name);
	if (clips.length === (cfg.clips ?? []).length) return false;
	applyHumanoidConfig(uuid, { ...cfg, clips });
	return true;
}

/**
 * Fix one bone of a model's map ('' = this bone is not mapped; null = back to the detected one).
 * @param {string} uuid @param {string} bone @param {string | null} nodeName
 */
export function setMapBone(uuid, bone, nodeName) {
	if (!isHumanBone(bone)) return false;
	const cfg = configOf(uuid);
	/** @type {Record<string, string>} */
	const map = { ...(cfg.map ?? {}) };
	if (nodeName === null) delete map[bone];
	else map[bone] = nodeName;
	applyHumanoidConfig(uuid, { ...cfg, map: Object.keys(map).length ? map : undefined });
	return true;
}

/** a short line for the Inspector ("Mixamo rig · 52 of 55 bones") @param {string} uuid */
export function humanoidSummary(uuid) {
	const h = humanoidOf(uuid);
	if (!h || !h.bones.length) return null;
	return {
		...h,
		mapped: Object.keys(h.map).length,
		family: h.rig === 'vrm' ? 'vrm' : rigFamily(h.bones)
	};
}
