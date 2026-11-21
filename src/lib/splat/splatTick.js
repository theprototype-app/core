import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore';
import { registerSceneEntrySource } from '../sceneAssets';
import { isSplatObject } from './splatObject.js';

// 102-splats: the per-frame entry for Gaussian splats — ONE line in Scene's useTask (the textPathTick
// shape). Spark (~1 MB gzip) and the runtime are imported only once a scene holds a splat object; a
// scene with none pays a scan per scene poke (and one a second as a backstop), never a per-frame
// traversal and never the chunk.

const FALLBACK_MS = 1000;

let wanted = true;
let lastScan = 0;
/** @type {any[]} */
let carriers = [];
/** @type {null | ((carriers: any[]) => void)} */
let tick = null;
let loading = false;
let ever = false;

objectsGroup.subscribe(() => {
	wanted = true;
});

/** @param {any} root */
function findCarriers(root) {
	/** @type {any[]} */
	const out = [];
	root?.traverse?.((/** @type {any} */ o) => {
		if (isSplatObject(o)) out.push(o);
	});
	return out;
}

// the scan files are scene assets: listed in Explorer ▸ Scene ▸ splats and bundled into a .tpscene
registerSceneEntrySource(() => {
	const seen = new Set();
	return findCarriers(get(objectsGroup))
		.map((c) => c.userData.splat)
		.filter((r) => typeof r?.hash === 'string' && r.hash && !seen.has(r.hash) && seen.add(r.hash))
		.map((r) => ({ id: 'splat:' + r.hash, group: 'splats', name: String(r.file || 'splat.spz'), kind: 'splat', hash: r.hash, derived: false }));
});

/** force a rescan on the next frame (an import or a record change that did not poke the scene) */
export function pokeSplats() {
	wanted = true;
}

/**
 * @param {any} root objectsGroup @param {number} now ms
 */
export function tickSplatsLazy(root, now) {
	if (!root) return;
	if (wanted || now - lastScan > FALLBACK_MS) {
		wanted = false;
		lastScan = now;
		carriers = findCarriers(root);
	}
	const has = carriers.length > 0;
	if (tick) {
		// the last splat went: one more pass lets the runtime drop its meshes, then it rests
		if (has || ever) tick(carriers);
		ever = has;
		return;
	}
	if (loading || !has) return;
	loading = true;
	import('./splatRuntime.js')
		.then((m) => {
			tick = m.tickSplats;
		})
		.catch((err) => console.log('splat runtime failed to load', err))
		.finally(() => (loading = false));
}

/** set while splat objects exist */
export function splatsActive() {
	return carriers.length > 0;
}
