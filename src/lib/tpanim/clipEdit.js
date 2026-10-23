// 57 M3 + M8: what the Animation window's clip tools DO — every edit that changes a clip's motion
// writes a NEW `.tpanim` (a different clip is a different file: peers holding the old one still
// hold exactly that, and the original stays in the Explorer) and swaps the model's ref to it in
// ONE ref change (one message, one undo step). Settings that are not motion (name, loop, speed,
// In place / Moving) are ref fields and never write a file.
//
// Lazy: loaded by the clip tools panel only.

import { get } from 'svelte/store';
import { addItemFromBytes, itemByHash } from '../explorer';
import { sendAsset } from '../assetShare';
import { objectsGroup } from '../../stores/sceneStore';
import { showToast } from '../../stores/appStore';
import { clipRefsOf, setClipRefs, embeddedClipsOf, threeClipOf, restPoseOf, hasAnimatedImport } from '../animatedImports';
import { encodeTpanim, tpFromThreeClip, toHumanoid, clipFacts } from './format.js';
import { loopSeam, makeLoop, trimClip, splitClip, joinClips, joinProblem, rootTravel } from './clipOps.js';
import { loadClip } from './clipAssets.js';
import { humanoidMapOf } from './humanoidMap.js';

/** @param {string} uuid */
function rootOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;
}

/** @param {string} uuid @param {string} name */
function refOf(uuid, name) {
	return clipRefsOf(rootOf(uuid)).find((r) => r.name === name) ?? null;
}

/**
 * The facts a clip row shows: fps, frames, length, humanoid, travel, and the loop seam.
 * @param {string} hash @returns {Promise<null | ReturnType<typeof clipFacts> & {seam: ReturnType<typeof loopSeam>, travel: number}>}
 */
export async function clipFactsFor(hash) {
	const tp = await loadClip(hash);
	if (!tp) return null;
	return { ...clipFacts(tp), seam: loopSeam(tp), travel: rootTravel(tp).distance };
}

/**
 * Write a clip as a new Explorer item beside `nearHash`'s (same folder) and push it to peers.
 * @param {import('./format.js').TpClip} tp @param {string} name @param {string} [nearHash]
 * @returns {Promise<{hash: string, name: string} | null>}
 */
export async function saveClip(tp, name, nearHash) {
	const folder = nearHash ? itemByHash(nearHash)?.folderId ?? null : null;
	const fileName = name.replace(/\.tpanim$/i, '') + '.tpanim';
	const item = await addItemFromBytes(encodeTpanim({ ...tp, name: name.replace(/\.tpanim$/i, '') }), fileName, folder, { kind: 'anim' });
	if (!item?.hash) return null;
	void sendAsset(item.hash);
	return { hash: item.hash, name: item.name };
}

/** swap one ref's file (keeping its name + settings) — one undo step @param {string} uuid @param {string} name @param {string} hash */
function swapRef(uuid, name, hash) {
	const refs = clipRefsOf(rootOf(uuid));
	return setClipRefs(uuid, refs.map((r) => (r.name === name ? { ...r, hash } : r)));
}

/** @param {string} uuid @param {string} name */
async function clipOfRef(uuid, name) {
	const ref = refOf(uuid, name);
	if (!ref) return null;
	const tp = await loadClip(ref.hash);
	if (!tp) showToast('"' + name + '" is still arriving — try again in a moment');
	return tp ? { ref, tp } : null;
}

/**
 * LOOP IT (M3): a new file whose last frames blend into its first; the model plays it.
 * @param {string} uuid @param {string} name
 */
export async function loopClipAsset(uuid, name) {
	const got = await clipOfRef(uuid, name);
	if (!got) return false;
	const looped = makeLoop(got.tp);
	const saved = await saveClip(looped, got.tp.name + ' (loop)', got.ref.hash);
	if (!saved) return false;
	swapRef(uuid, name, saved.hash);
	const seam = loopSeam(looped);
	showToast('Looped "' + name + '" — seam ' + seam.angle.toFixed(1) + '°');
	return true;
}

/**
 * TRIM (M8): keep the part between the in and out markers (a new file; the model plays it).
 * @param {string} uuid @param {string} name @param {number} from @param {number} to
 */
export async function trimClipAsset(uuid, name, from, to) {
	const got = await clipOfRef(uuid, name);
	if (!got) return false;
	if (Math.abs(to - from) < 1 / got.tp.fps) return showToast('Set the in and out markers at least a frame apart'), false;
	const saved = await saveClip(trimClip(got.tp, from, to), got.tp.name + ' (trim)', got.ref.hash);
	if (!saved) return false;
	return swapRef(uuid, name, saved.hash);
}

/**
 * SPLIT (M8): two clips at the playhead — the first replaces this one, the second is added after it.
 * Names come from the caller (cut a long take into Walk, Turn, Stop).
 * @param {string} uuid @param {string} name @param {number} at @param {[string, string]} [names]
 */
export async function splitClipAsset(uuid, name, at, names) {
	const got = await clipOfRef(uuid, name);
	if (!got) return false;
	if (at <= 1 / got.tp.fps || at >= got.tp.duration - 1 / got.tp.fps) return showToast('Move the playhead inside the clip to split it'), false;
	const [a, b] = splitClip(got.tp, at);
	const na = names?.[0]?.trim() || name + ' A';
	const nb = names?.[1]?.trim() || name + ' B';
	const sa = await saveClip(a, na, got.ref.hash);
	const sb = await saveClip(b, nb, got.ref.hash);
	if (!sa || !sb) return false;
	const refs = clipRefsOf(rootOf(uuid));
	const taken = new Set(refs.map((r) => r.name));
	taken.delete(name);
	const uniq = (/** @type {string} */ n) => {
		let out = n;
		for (let i = 2; taken.has(out); i++) out = n + ' ' + i;
		taken.add(out);
		return out;
	};
	const next = [];
	for (const r of refs) {
		if (r.name !== name) next.push(r);
		else {
			const { hash: _h, name: _n, ...settings } = r;
			next.push({ ...settings, hash: sa.hash, name: uniq(na) }, { ...settings, hash: sb.hash, name: uniq(nb) });
		}
	}
	return setClipRefs(uuid, next);
}

/**
 * JOIN (M8): the picked clips one after another with a crossfade at each seam, as a new clip
 * added to the model (the parts stay).
 * @param {string} uuid @param {string[]} names in order @param {number} fade seconds @param {string} [joinedName]
 */
export async function joinClipAssets(uuid, names, fade, joinedName) {
	const parts = [];
	for (const n of names) {
		const got = await clipOfRef(uuid, n);
		if (!got) return false;
		parts.push(got);
	}
	const why = joinProblem(parts.map((p) => p.tp));
	if (why) return showToast('Cannot join: ' + why), false;
	const joined = joinClips(parts.map((p) => p.tp), fade, joinedName);
	const saved = await saveClip(joined, joined.name, parts[0].ref.hash);
	if (!saved) return false;
	const refs = clipRefsOf(rootOf(uuid));
	let nm = joined.name;
	for (let i = 2; refs.some((r) => r.name === nm); i++) nm = joined.name + ' ' + i;
	return setClipRefs(uuid, [...refs, { hash: saved.hash, name: nm }]);
}

/**
 * EXTRACT CLIPS (M8): the model's embedded clips become `.tpanim` files (humanoid when the model's
 * bones map, so they play on any humanoid) assigned to it; `useFiles` also switches the embedded
 * ones off — in the same undo step, and the model's bytes are untouched.
 * @param {string} uuid @param {{useFiles?: boolean}} [opts] @returns {Promise<number>} clips written
 */
export async function extractClips(uuid, opts = {}) {
	const root = rootOf(uuid);
	if (!root || !hasAnimatedImport(uuid)) return 0;
	const { names } = embeddedClipsOf(uuid);
	if (!names.length) {
		showToast('"' + (root.name || 'This model') + '" has no clips of its own to extract');
		return 0;
	}
	const map = humanoidMapOf(root);
	const rest = restPoseOf(uuid);
	const refs = [...clipRefsOf(root)];
	const taken = new Set(refs.map((r) => r.name));
	let written = 0;
	for (const name of names) {
		const clip = threeClipOf(uuid, name);
		if (!clip) continue;
		let tp = tpFromThreeClip(root, clip, { rest, provenance: { tool: 'extract', source: root.name || 'model', date: new Date().toISOString().slice(0, 10) } });
		if (map) {
			try {
				tp = toHumanoid(tp, map);
			} catch (error) {
				console.log('extract: kept a skeleton clip', error);
			}
		}
		const saved = await saveClip(tp, (root.name ? root.name + ' - ' : '') + name);
		if (!saved) continue;
		written++;
		if (refs.some((r) => r.hash === saved.hash)) continue;
		// with the embedded clips off the file takes the clip's own name; beside them it needs another
		let nm = opts.useFiles ? name : name + ' (file)';
		for (let i = 2; taken.has(nm); i++) nm = (opts.useFiles ? name : name + ' (file)') + ' ' + i;
		taken.add(nm);
		refs.push({ hash: saved.hash, name: nm });
	}
	setClipRefs(uuid, refs, opts.useFiles ? { clipsOff: true } : {});
	showToast('Extracted ' + written + ' clip' + (written === 1 ? '' : 's') + ' to the Explorer');
	return written;
}
