// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import { objectsGroup, selectedObjects } from '../stores/sceneStore';
import { flowGraphs } from '../stores/flowStore';
import { showToast } from '../stores/appStore';
import { SCATTER_PRIMITIVES, sourceKey, sourceOf } from './terrainScatterCore';

// 51 E1 — WHAT A SCATTER SET CAN DRAW, as ONE catalog the brush toolbar, the Inspector's Scatter
// section and the object menu share: the primitives, Library models, PACK ITEMS (a kit's rock, by
// the pack path every peer fetches from the pack CDN — nothing travels but the path), PREFABS and
// "USE SELECTED OBJECT".
//
// A prefab or a scene object scatters as its LOOK ONLY (the user's ruling, 2026-10-21): model +
// materials, never its flow graph, physics, behaviour or scripts — an instance is a draw, not an
// object, so there is nothing for logic to run on. The look is exported to a GLB and filed in the
// Library under its content hash (the same path a Library model takes, so peers pull the bytes by
// hash and a reload finds them), with a NOTE the source row shows. "Convert to object" (51-edit)
// is the way back to one real copy with its logic. A placed pack piece that is still pristine
// scatters as the PACK ITEM itself — no byte copy at all.

/** @typedef {{value: string, name: string}} Choice */

/** pack path -> {pack, item}: what a 'k:' choice resolves to (filled by `packChoices`) */
/** @type {Map<string, {pack: string, item: string}>} */
const packNames = new Map();

/** The pack items every peer can fetch: each installed CDN pack's list (cached by packs.js).
 * Imported (zip) packs are Library items already and list there. @returns {Promise<Choice[]>} */
export async function packChoices() {
	const packs = await import('./packs');
	const refs = await import('./packRefs');
	/** @type {Choice[]} */
	const out = [];
	for (const pack of /** @type {any[]} */ (get(packs.packs))) {
		if (pack?.source === 'imported' || !pack?.listUrl) continue;
		let items = [];
		try {
			items = await packs.listPackItems(pack);
		} catch {
			continue;
		}
		for (const item of items) {
			if (item?.behavior) continue; // a door or a lid scatters badly and loses what it is
			const ref = item?.glbUrl ? refs.packRefFromUrl(item.glbUrl, { pack: pack.name, item: item.name }) : null;
			if (!ref) continue;
			packNames.set(ref.path, { pack: ref.pack, item: ref.item });
			out.push({ value: 'k:' + ref.path, name: (pack.title || pack.name) + ' ▸ ' + (item.label || item.name) });
		}
	}
	return out;
}

/** pack choices, loaded once per session on first use (a list of lists over the CDN) */
export const packChoiceList = writable(/** @type {Choice[]} */ ([]));
let packsAsked = false;
export function loadPackChoices() {
	if (packsAsked) return;
	packsAsked = true;
	packChoices()
		.then((list) => packChoiceList.set(list))
		.catch(() => (packsAsked = false));
}

/**
 * The whole catalog as select items. `current` (a source already in use) is listed even when
 * nothing else names it (a pack item from a peer's scene, a look exported on another machine).
 * @param {{library?: any[], prefabs?: any[], packs?: Choice[], current?: any[]}} lists
 * @returns {Choice[]}
 */
export function sourceChoices(lists) {
	/** @type {Choice[]} */
	const out = SCATTER_PRIMITIVES.map((type) => ({ value: 'p:' + type, name: type }));
	const seen = new Set(out.map((c) => c.value));
	const add = (/** @type {Choice} */ c) => {
		if (!seen.has(c.value)) (seen.add(c.value), out.push(c));
	};
	for (const item of lists.library ?? []) if (item?.kind === 'object' && item.hash) add({ value: 'l:' + item.hash, name: item.name });
	for (const c of lists.packs ?? []) add(c);
	for (const p of lists.prefabs ?? []) if (p?.id) add({ value: 'f:' + p.id, name: 'Prefab ▸ ' + (p.name || 'Prefab') + ' (look only)' });
	for (const s of lists.current ?? []) {
		const key = sourceKey(s);
		if (key) add({ value: key, name: sourceLabel(s) });
	}
	return out;
}

/** What a source row says. @param {any} s */
export function sourceLabel(s) {
	if (!s) return '';
	if (s.kind === 'primitive') return s.type;
	if (s.kind === 'pack') return (s.pack ? s.pack + ' ▸ ' : '') + (s.item || s.path.split('/').pop());
	return s.name || 'Library model';
}

/**
 * A choice value -> a source (async: a prefab is exported first). Null when it cannot be made.
 * @param {string} value @param {any[]} [library] the Explorer items (for a Library model's name)
 */
export async function resolveSourceChoice(value, library = []) {
	if (value.startsWith('p:')) return sourceOf({ kind: 'primitive', type: value.slice(2) });
	if (value.startsWith('l:')) {
		const hash = value.slice(2);
		const item = library.find((i) => i?.hash === hash);
		return sourceOf({ kind: 'library', hash, name: item?.name ?? '' });
	}
	if (value.startsWith('k:')) {
		const path = value.slice(2);
		const names = packNames.get(path) ?? { pack: '', item: (path.split('/').pop() ?? '').replace(/\.\w+$/, '') };
		return sourceOf({ kind: 'pack', path, ...names });
	}
	if (value.startsWith('f:')) return sourceFromPrefab(value.slice(2));
	return null;
}

/** Does this subtree carry LOGIC that a look-only scatter leaves behind? @param {any} root */
export function carriesLogic(root) {
	const graphs = /** @type {any} */ (get(flowGraphs));
	let logic = false;
	root?.traverse?.((/** @type {any} */ n) => {
		const ud = n.userData ?? {};
		if (graphs?.[n.uuid]?.nodes?.length || ud.physics || ud.behavior || ud.packRef?.behavior || ud.charControl || ud.camera) logic = true;
	});
	return logic;
}

export const LOOK_ONLY = 'Look only: model + materials (its logic is not scattered)';

/**
 * A subtree's LOOK as a Library model: a clone with every userData dropped, standing with its
 * lowest point at y 0 (an instance stands on the ground the way a primitive does), its own scale
 * kept, its place and turn not — then a GLB, the Library, and a push to the peers.
 * @param {any} root @param {string} name @param {string} note @param {{prefab?: string}} [extra]
 * @returns {Promise<any | null>} a library source
 */
export async function lookSource(root, name, note, extra = {}) {
	const clone = root.clone(true);
	clone.traverse((/** @type {any} */ n) => {
		n.userData = {};
	});
	clone.position.set(0, 0, 0);
	clone.quaternion.identity();
	clone.updateMatrixWorld(true);
	const box = new THREE.Box3().setFromObject(clone);
	if (box.isEmpty()) return null;
	clone.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
	const holder = new THREE.Group();
	holder.name = name;
	holder.add(clone);
	const { gltfBytesFor } = await import('./fileHandler.svelte.js');
	const bytes = await gltfBytesFor(holder, { binary: true });
	if (!bytes) return null;
	const explorer = await import('./explorer');
	const file = String(name || 'Scatter model').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80) + ' (scatter look).glb';
	const item = await explorer.addItemFromBytes(bytes, file, null, { kind: 'object' });
	if (!item?.hash) return null;
	void import('./assetShare').then((m) => m.sendAsset(item.hash)).catch(() => {});
	return sourceOf({ kind: 'library', hash: item.hash, name: item.name ?? file, note, ...extra });
}

/** A prefab as a scatter source: its look only. @param {string} id */
export async function sourceFromPrefab(id) {
	const prefabs = await import('./prefabs');
	const entry = prefabs.prefabById(id);
	const object = prefabs.prefabObject(id);
	if (!entry || !object) {
		showToast('That prefab is not in your library');
		return null;
	}
	return lookSource(object, entry.name || 'Prefab', 'Prefab "' + (entry.name || 'Prefab') + '" — ' + LOOK_ONLY.toLowerCase(), { prefab: id });
}

/** A scene object as a scatter source: a pristine pack piece as its pack item, anything else as
 * its look (with the note when it carried logic). @param {string} uuid */
export async function sourceFromObject(uuid) {
	const object = /** @type {any} */ (get(objectsGroup))?.getObjectByProperty?.('uuid', uuid);
	if (!object) return null;
	if (object.userData?.terrain) {
		showToast('A terrain cannot be scattered — pick the model you want to scatter on it');
		return null;
	}
	let hasMesh = false;
	object.traverse((/** @type {any} */ n) => {
		if (n.isMesh) hasMesh = true;
	});
	if (!hasMesh) {
		showToast('Only an object with a model can be scattered');
		return null;
	}
	try {
		const refs = await import('./packRefs');
		const ref = refs.packRefOf(object);
		if (ref && !object.userData?.behavior && refs.isPristinePackRef(object)) return sourceOf({ kind: 'pack', path: ref.path, pack: ref.pack, item: ref.item });
	} catch {
		/* not a kit piece */
	}
	const logic = carriesLogic(object);
	return lookSource(object, object.name || 'Object', logic ? LOOK_ONLY : '');
}

/**
 * Object menu / Inspector "Use selected object": the brush's source becomes this object's look.
 * @param {string} [uuid] defaults to the selection (the set's first, never the sticky primary)
 */
export async function useAsScatterSource(uuid) {
	const id = uuid ?? (/** @type {string[]} */ (get(selectedObjects)) ?? [])[0];
	if (!id) {
		showToast('Select the object to scatter first');
		return null;
	}
	const source = await sourceFromObject(id);
	if (!source) return null;
	const paint = await import('./terrainPaint');
	paint.scatterSource.set(source);
	showToast('Scatter source: ' + sourceLabel(source) + (source.note ? ' — ' + source.note : '') + '. Open a terrain’s Scatter brush to paint it.');
	return source;
}
