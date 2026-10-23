// 57 M1: clip ASSETS on models — a `.tpanim` hash resolved to a decoded clip, bound to one model,
// and added to that model's mixer as an ordinary action (so the Animation panel, the Play
// Animation node, the Timeline and clip sync all see it with no change of their own).
//
// LAZY: animatedImports loads this module only when a model carries clip refs, so a scene without
// clip assets never fetches it. Bytes follow golden rule 9 (the hudImages shape): pushed once on
// assign, pulled by any peer missing the hash, and a WATCH on the Explorer finishes the bind when
// they land — a late joiner, a restore and a peer that missed the push all converge the same way.

import { get } from 'svelte/store';
import { explorerItems, itemByHash, itemBlob } from '../explorer';
import { requestAsset, sendAsset } from '../assetShare';
import { objectsGroup } from '../../stores/sceneStore';
import { showToast } from '../../stores/appStore';
import {
	animatedObjects,
	clipRefsOf,
	clipInfo,
	addClipAction,
	clipAssetKey,
	setClipPlayback,
	pruneClipActions,
	restPoseOf,
	setClipRefs,
	setAnimationState,
	hasAnimatedImport,
	animatedImportUuids
} from '../animatedImports';
import { decodeTpanim, tpToThreeClip, bindHumanoid, clipFit } from './format.js';
import { stripRootMotion } from './clipOps.js';
import { humanoidMapOf } from './humanoidMap.js';
import { registerSceneAssetSource } from '../sceneAssets';

/** 57-chars M2's character code (lazy), loaded before the first humanoid bind @type {any} */
let characterRig = null;

/** hash -> the decode (shared by every model using the clip; a failure is forgotten) @type {Map<string, Promise<import('./format.js').TpClip | null>>} */
const decoded = new Map();
/** hash -> the models waiting for its bytes @type {Map<string, Set<string>>} */
const awaiting = new Map();
/** one warning per model + clip @type {Set<string>} */
const warned = new Set();

/** @param {string} uuid */
function rootOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;
}

/**
 * The decoded clip for a hash, or null while its bytes are not here (then a pull is asked and the
 * model is re-bound when they land).
 * @param {string} hash @param {string} [forUuid] @returns {Promise<import('./format.js').TpClip | null>}
 */
export async function loadClip(hash, forUuid) {
	const hit = decoded.get(hash);
	if (hit) return hit;
	const item = itemByHash(hash);
	if (!item) {
		if (forUuid) {
			const set = awaiting.get(hash) ?? new Set();
			set.add(forUuid);
			awaiting.set(hash, set);
		}
		requestAsset(hash);
		return null;
	}
	const job = (async () => {
		const blob = await itemBlob(item.id);
		if (!blob) return null;
		try {
			return decodeTpanim(await blob.arrayBuffer());
		} catch (error) {
			console.log('clip decode failed', item.name, error);
			showToast('"' + item.name + '" is not a readable animation clip');
			return null;
		}
	})();
	decoded.set(hash, job);
	job.then((tp) => !tp && decoded.delete(hash));
	return job;
}

/**
 * Bind a decoded clip to one model, or null (with one toast saying why).
 * @param {import('./format.js').TpClip} tp @param {any} root @param {string} name
 */
export function bindClip(tp, root, name) {
	const key = root.uuid + '|' + name;
	const warn = (/** @type {string} */ text) => {
		if (warned.has(key)) return null;
		warned.add(key);
		showToast(text);
		return null;
	};
	if (tp.humanoid) {
		// 57-chars M2: the rest- and facing-corrected retarget onto the character's own map (its
		// detector + the user's fixes); attachClipAssets loads it before a humanoid bind
		if (characterRig) {
			try {
				const clip = characterRig.retargetTpClip(tp, root.uuid, name);
				if (clip) return clip;
			} catch (error) {
				console.log('humanoid retarget failed', error);
				return warn('"' + name + '" could not be applied to "' + (root.name || 'this model') + '".');
			}
			return warn('"' + name + '" is a humanoid clip, and "' + (root.name || 'this model') + '" has no humanoid bones mapped yet.');
		}
		const map = humanoidMapOf(root);
		if (!map) return warn('"' + name + '" is a humanoid clip, and "' + (root.name || 'this model') + '" has no humanoid bones mapped yet.');
		try {
			return bindHumanoid(tp, root, map, { rest: restPoseOf(root.uuid), name });
		} catch (error) {
			console.log('humanoid bind failed', error);
			return warn('"' + name + '" could not be applied to "' + (root.name || 'this model') + '".');
		}
	}
	const fit = clipFit(tp, root);
	if (fit.fit === 'none') return warn('"' + name + '" was made for another skeleton — none of its bones are in "' + (root.name || 'this model') + '".');
	const clip = tpToThreeClip(tp, root);
	clip.name = name;
	return clip;
}

/**
 * (Re)bind a model's clip refs: prune actions for refs that went, bind the ones not bound yet.
 * @param {string} uuid
 */
export async function attachClipAssets(uuid) {
	const root = rootOf(uuid);
	if (!root || !hasAnimatedImport(uuid)) return;
	const refs = clipRefsOf(root);
	pruneClipActions(uuid, new Set(refs.map((r) => r.name)));
	setClipPlayback(uuid, refs); // 57 M8: speed / play-once per ref
	for (const ref of refs) {
		const key = ref.hash + '|' + (ref.mode ?? '');
		if (clipAssetKey(uuid, ref.name) === key) continue;
		const tp = await loadClip(ref.hash, uuid);
		if (!tp) continue;
		if (tp.humanoid && !characterRig) characterRig = await import('../humanoid/humanoidRig.js');
		// the refs may have moved on while the bytes decoded
		if (!clipRefsOf(root).some((r) => r.hash === ref.hash && r.name === ref.name && (r.mode ?? '') === (ref.mode ?? ''))) continue;
		// 57 M3: In place strips the root's travel at bind time (the file is untouched); Moving keeps it
		const shaped = ref.mode === 'inplace' && tp.rootMotion !== 'inplace' ? stripRootMotion(tp) : tp;
		const clip = bindClip(shaped, root, ref.name);
		if (clip) addClipAction(uuid, clip, ref.hash, key);
	}
}

/** @param {any} root @param {string} wanted */
function uniqueClipName(root, wanted) {
	const taken = new Set([...clipInfo(root.uuid).map((c) => c.name), ...clipRefsOf(root).map((r) => r.name)]);
	const base = wanted.trim() || 'Clip';
	if (!taken.has(base)) return base;
	for (let i = 2; ; i++) if (!taken.has(base + ' ' + i)) return base + ' ' + i;
}

/**
 * Assign a clip asset to a model (the Explorer drop, the Animation window's Add clip): ONE ref
 * change (one message, one undo step), the bytes pushed once. `play` also starts it on every peer.
 * @param {string} uuid @param {{hash: string, name: string}} item @param {{play?: boolean}} [opts]
 * @returns {string | null} the clip's name on that model
 */
export function assignClipAsset(uuid, item, opts = {}) {
	const root = rootOf(uuid);
	if (!root || !hasAnimatedImport(uuid)) {
		showToast('Drop a clip on a rigged model (a character, an animated import)');
		return null;
	}
	const refs = clipRefsOf(root);
	const held = refs.find((r) => r.hash === item.hash);
	const name = held?.name ?? uniqueClipName(root, String(item.name ?? 'Clip').replace(/\.(tpanim|vrma|glb)$/i, ''));
	if (!held) {
		setClipRefs(uuid, [...refs, { hash: item.hash, name }]);
		void sendAsset(item.hash);
	}
	if (opts.play) setAnimationState(uuid, { clip: name, playing: true });
	return name;
}

/** Remove one clip ref from a model (one undo step). @param {string} uuid @param {string} name */
export function removeClipAsset(uuid, name) {
	const root = rootOf(uuid);
	if (!root) return false;
	return setClipRefs(uuid, clipRefsOf(root).filter((r) => r.name !== name));
}

/**
 * Change one ref's per-clip settings (57 M8: rename / loop / speed) — one undo step.
 * @param {string} uuid @param {string} name @param {{name?: string, loop?: boolean, speed?: number, mode?: 'inplace'|'moving'}} patch
 */
export function updateClipRef(uuid, name, patch) {
	const root = rootOf(uuid);
	if (!root) return false;
	const refs = clipRefsOf(root);
	const i = refs.findIndex((r) => r.name === name);
	if (i < 0) return false;
	const next = { ...refs[i], ...patch };
	if (patch.name !== undefined) {
		const others = refs.filter((_, k) => k !== i);
		const want = String(patch.name).trim() || refs[i].name;
		next.name = others.some((r) => r.name === want) || clipInfo(uuid).some((c) => c.name === want && !c.asset) ? refs[i].name : want;
		// a rename moves a playing transport with it
		const st = /** @type {any} */ (get(animatedObjects))[uuid];
		if (st?.clip === refs[i].name && next.name !== refs[i].name) queueMicrotask(() => setAnimationState(uuid, { clip: next.name }));
	}
	return setClipRefs(uuid, refs.map((r, k) => (k === i ? next : r)));
}

// ---- the watch: bytes that land later finish their binds ------------------------------------
explorerItems.subscribe((items) => {
	if (!awaiting.size || !Array.isArray(items)) return;
	const landed = [...awaiting.keys()].filter((hash) => items.some((it) => it?.hash === hash));
	for (const hash of landed) {
		const uuids = awaiting.get(hash) ?? new Set();
		awaiting.delete(hash);
		for (const uuid of uuids) void attachClipAssets(uuid);
	}
});

// ---- .tpscene: the clips a scene uses are scene assets (bundled in assets/, pulled on load) ----
registerSceneAssetSource(() => {
	const group = get(objectsGroup);
	/** @type {{hash: string, name: string, kind: string}[]} */
	const out = [];
	for (const uuid of animatedImportUuids(group)) {
		const root = group?.getObjectByProperty('uuid', uuid);
		for (const ref of clipRefsOf(root)) out.push({ hash: ref.hash, name: itemByHash(ref.hash)?.name ?? ref.name + '.tpanim', kind: 'anim' });
	}
	return out;
});

/** test/debug view */
export function clipAssetsDebug() {
	return { decoded: [...decoded.keys()], awaiting: [...awaiting.entries()].map(([h, s]) => [h, [...s]]), warned: [...warned] };
}
