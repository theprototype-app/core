// 47-cc0 (C2) — from a browser card to something in the app, ALWAYS through a path that exists:
//   · a MODEL  -> one packed .glb -> `importFiles` (the Explorer drop entry, so roadmap 46's
//                 auto-optimize applies once 46 is merged) -> a Library item carrying `source`
//   · an HDRI  -> the .hdr -> `importFiles` -> a Library item (kind hdri) -> `editEnvSky` (the
//                 Configure Scene ▸ Environment picker's own write: it persists and replicates)
//   · a MATERIAL (ambientCG) / a TEXTURE set (Poly Haven) -> a material PRESET in your library
//                 (37 R5), its maps as JPEG data-URLs at the picked resolution -> optionally
//                 applied to the selection through `applyMaterialPreset` (the `materials` message)
// The CC0 credit (site / authors / licence / url) rides every one: the Library record and the
// Explorer Properties pane, the GLB's scene extras (so a PLACED copy carries `userData.source`
// through the ordinary object sync), and the preset (`source`, shown on its swatch).
import { get, writable } from 'svelte/store';
import { unzipSync } from 'fflate';
import { explorerFolders, explorerItems, createFolder, importFiles, patchRecord, itemBlob, MAX_ITEM_BYTES, loadExplorer } from '../explorer';
import { selectedObjects } from '../../stores/sceneStore';
import { showToast } from '../../stores/appStore';
import { CC0_SITES, phFilePlan, acgDownloadFor, acgMapsFromNames, sourceRecord, assetFileName, packGlb, gltfExternalUris, classifyError } from './cc0Core.js';
import { phFiles, acgResolve, fetchBytes } from './cc0Fetch.js';
import { assetBrowserTarget } from './assetBrowserState.js'; // 105-slots: Apply to <slot>
// static, not dynamic: this module is itself loaded lazily (with the window), and a dynamic import
// from it could bind a SECOND instance of these singletons on a long-lived dev server
import { editEnvSky } from '../environment';
import * as materialPresetsModule from '../materialPresets';
import { beginHistoryBatch, endHistoryBatch } from '../history';
import { importFile } from '../fileHandler.svelte.js';

/** one row per card being fetched: {key, label, done, total, phase} — the cards draw from it */
export const cc0Jobs = writable(/** @type {Record<string, {done: number, total: number, phase: string}>} */ ({}));

/** @param {any} row */
export const rowKey = (row) => row.source + ':' + row.kind + ':' + row.id;

/** @param {string} key @param {any} patch */
function setJob(key, patch) {
	cc0Jobs.update((j) => ({ ...j, [key]: { ...(j[key] ?? { done: 0, total: 0, phase: '' }), ...patch } }));
}
/** @param {string} key */
function endJob(key) {
	cc0Jobs.update((j) => {
		const next = { ...j };
		delete next[key];
		return next;
	});
}

const MB = 1024 * 1024;
/** @param {number} n */
const mb = (n) => (n / MB).toFixed(n < 10 * MB ? 1 : 0) + ' MB';

/** @param {string} message @param {'size'|'format'} [code] */
function refuse(message, code = 'size') {
	return Object.assign(new Error(message), { cc0: { code, message } });
}

/** the library folder a source's downloads land in ("Poly Haven", "ambientCG"), made on first use
 * @param {'polyhaven'|'ambientcg'} site */
function folderFor(site) {
	const name = CC0_SITES[site].label;
	const held = get(explorerFolders).find((f) => f.parentId == null && f.name === name);
	return held ?? createFolder(name, null);
}

/** a Library item this browser already brought in for a row (by its source record) @param {any} row */
export function heldItemFor(row) {
	return (
		get(explorerItems).find(
			(/** @type {any} */ it) => it.source?.site === row.source && it.source?.id === row.id && (row.kind === 'hdris' ? it.kind === 'hdri' : it.kind === 'object')
		) ?? null
	);
}

/**
 * Bring one asset in. Returns what it made: {item} for a model / an HDRI, {preset} for a material.
 * Throws with `err.cc0 = {code, message}` for anything a person should read.
 * @param {any} row @param {string} res
 * @param {{applySky?: boolean, applyToSelection?: boolean}} [opts]
 */
export async function importCc0(row, res, opts = {}) {
	const key = rowKey(row);
	setJob(key, { phase: 'Looking up files…', done: 0, total: 0 });
	try {
		await loadExplorer();
		if (row.kind === 'models') return { item: await importModel(row, res, key) };
		if (row.kind === 'hdris') return { item: await importHdri(row, res, key, opts.applySky !== false) };
		if (row.kind === 'textures' || row.kind === 'materials') return { preset: await importMaterial(row, res, key, !!opts.applyToSelection) };
		throw refuse('Unknown asset kind', 'format');
	} finally {
		endJob(key);
	}
}

/** a progress callback over several files that add up to `total` @param {string} key @param {number} total */
function progress(key, total) {
	let base = 0;
	return {
		/** @param {string} phase */
		file(phase) {
			const start = base;
			setJob(key, { phase, total });
			return (/** @type {number} */ done, /** @type {number} */ size) => {
				setJob(key, { done: start + done, total: Math.max(total, start + (size || done)) });
				if (size && done >= size) base = start + size;
			};
		},
		/** @param {number} n */
		add(n) {
			base += n;
		}
	};
}

/** @param {any} row @param {string} res @param {string} key */
async function importModel(row, res, key) {
	const files = (await phFiles(row.id)).data;
	const plan = /** @type {any} */ (phFilePlan(files, 'models', res));
	if (!plan) throw refuse('This model has no glTF download.', 'format');
	if (plan.total > MAX_ITEM_BYTES)
		throw refuse(`${row.name} is ${mb(plan.total)} at ${plan.res} — over the Library's 25 MB limit. Pick 1k.`);
	const p = progress(key, plan.total);
	const gltfBytes = await fetchBytes(plan.gltf.url, p.file('Downloading the model…'));
	p.add(gltfBytes.byteLength);
	const gltf = JSON.parse(new TextDecoder().decode(gltfBytes));
	/** @type {Map<string, Uint8Array>} */
	const resources = new Map();
	const byPath = new Map(plan.include.map((/** @type {any} */ x) => [x.path, x]));
	for (const uri of gltfExternalUris(gltf)) {
		const path = decodeURIComponent(uri);
		const inc = byPath.get(path) ?? byPath.get(uri);
		if (!inc) throw refuse('The model names a file Poly Haven does not list (' + path + ').', 'format');
		const bytes = await fetchBytes(inc.url, p.file('Downloading ' + path.split('/').pop() + '…'));
		resources.set(path, bytes);
		resources.set(uri, bytes);
	}
	setJob(key, { phase: 'Packing…' });
	const source = sourceRecord(row);
	const glb = packGlb(gltf, (u) => resources.get(u), { source });
	if (glb.byteLength > MAX_ITEM_BYTES) throw refuse(`${row.name} packs to ${mb(glb.byteLength)} — over the 25 MB limit. Pick 1k.`);
	const file = new File([/** @type {any} */ (glb)], assetFileName(row.name, 'glb'), { type: 'model/gltf-binary' });
	setJob(key, { phase: 'Adding to the Library…' });
	return landInLibrary(file, row, source);
}

/** @param {any} row @param {string} res @param {string} key @param {boolean} applySky */
async function importHdri(row, res, key, applySky) {
	const files = (await phFiles(row.id)).data;
	const plan = /** @type {any} */ (phFilePlan(files, 'hdris', res));
	if (!plan) throw refuse('This HDRI has no .hdr download.', 'format');
	if (plan.size > MAX_ITEM_BYTES) throw refuse(`${row.name} is ${mb(plan.size)} at ${plan.res} — over the 25 MB limit peers can receive. Pick 1k.`);
	const p = progress(key, plan.size);
	const bytes = await fetchBytes(plan.url, p.file('Downloading the sky…'));
	const source = sourceRecord(row);
	const file = new File([/** @type {any} */ (bytes)], assetFileName(row.name + ' ' + plan.res, 'hdr'));
	setJob(key, { phase: 'Adding to the Library…' });
	const item = await landInLibrary(file, row, source);
	if (applySky && item?.hash) {
		editEnvSky({ hdri: { src: 'hash:' + item.hash, name: item.name } });
	}
	return item;
}

/**
 * THE IMPORT ENTRY: the same `importFiles` a file dropped on the Explorer goes through, into the
 * source's folder, then the credit on the record (LOCAL metadata — the shared index carries
 * hash/name/kind/folderId only, and the bytes carry their own credit).
 * @param {File} file @param {any} row @param {any} source
 */
async function landInLibrary(file, row, source) {
	const folder = folderFor(row.source);
	const [item] = await importFiles([file], folder?.id ?? null, { duplicates: 'reuse' });
	if (!item) throw refuse('The Library refused ' + file.name + '.', 'format');
	patchRecord(item.id, { source });
	return get(explorerItems).find((/** @type {any} */ it) => it.id === item.id) ?? item;
}

// ---- materials -------------------------------------------------------------------------------

/** the edge a map is scaled to for a resolution @param {string} res */
const edgeFor = (res) => (parseInt(res, 10) || 1) * 1024;

/**
 * Decode an image and re-encode it as a JPEG data-URL no wider than `edge` (a preset's maps are
 * data-URLs; a JPEG at 0.85 keeps a 1k map in the hundreds of KB).
 * @param {Uint8Array} bytes @param {number} edge
 */
async function jpegDataUrl(bytes, edge) {
	const bitmap = await createImageBitmap(new Blob([/** @type {any} */ (bytes)]));
	const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
	const w = Math.max(1, Math.round(bitmap.width * scale));
	const h = Math.max(1, Math.round(bitmap.height * scale));
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	canvas.getContext('2d')?.drawImage(bitmap, 0, 0, w, h);
	bitmap.close?.();
	return canvas.toDataURL('image/jpeg', 0.85);
}

/** the mean of a greyscale map's red channel, 0..1 (roughness / metalness as one number)
 * @param {Uint8Array} bytes */
async function meanOf(bytes) {
	const bitmap = await createImageBitmap(new Blob([/** @type {any} */ (bytes)]), { resizeWidth: 32, resizeHeight: 32 });
	const canvas = document.createElement('canvas');
	canvas.width = 32;
	canvas.height = 32;
	const g = canvas.getContext('2d', { willReadFrequently: true });
	if (!g) return null;
	g.drawImage(bitmap, 0, 0);
	bitmap.close?.();
	const d = g.getImageData(0, 0, 32, 32).data;
	let sum = 0;
	for (let i = 0; i < d.length; i += 4) sum += d[i];
	return Math.round((sum / (d.length / 4) / 255) * 1000) / 1000;
}

/** @param {any} row @param {string} res @param {string} key @param {boolean} applyToSelection */
async function importMaterial(row, res, key, applyToSelection) {
	/** @type {Record<string, Uint8Array>} */
	const maps = {};
	let usedRes = res;
	if (row.source === 'ambientcg') {
		const dl = acgDownloadFor(row.downloads, res);
		if (!dl) throw refuse('This material has no JPG download.', 'format');
		usedRes = dl.res;
		if (dl.size > 4 * MAX_ITEM_BYTES) throw refuse(`${row.name} is ${mb(dl.size)} at ${dl.res}. Pick 1k.`);
		setJob(key, { phase: 'Asking the relay where it lives…' });
		const url = await acgResolve(dl.file);
		const zip = await fetchBytes(url, progress(key, dl.size).file('Downloading the material…'));
		setJob(key, { phase: 'Unpacking…' });
		/** @type {Record<string, Uint8Array>} */
		let entries;
		try {
			entries = unzipSync(zip, { filter: (f) => /\.(jpe?g|png)$/i.test(f.name) });
		} catch {
			throw refuse('The download was not a readable zip.', 'format');
		}
		const names = acgMapsFromNames(Object.keys(entries));
		for (const [slot, name] of Object.entries(names)) maps[slot] = entries[name];
	} else {
		const files = (await phFiles(row.id)).data;
		const plan = /** @type {any} */ (phFilePlan(files, 'textures', res));
		if (!plan) throw refuse('This texture has no colour map.', 'format');
		usedRes = plan.res;
		const p = progress(key, plan.total);
		for (const [slot, m] of Object.entries(plan.maps)) {
			if (slot === 'ao') continue; // a preset has no AO slot
			maps[slot] = await fetchBytes(m.url, p.file('Downloading ' + slot + '…'));
		}
	}
	if (!maps.map) throw refuse('No colour map in this download.', 'format');
	const edge = edgeFor(usedRes);
	const source = sourceRecord(row);
	setJob(key, { phase: 'Preparing the colour map…' });
	/** @type {any} */
	const payload = { version: 1, label: row.name, type: 'MeshStandardMaterial', color: '#ffffff', map: await jpegDataUrl(maps.map, edge), source };
	setJob(key, { phase: 'Reading roughness…' });
	payload.roughness = maps.roughness ? ((await meanOf(maps.roughness)) ?? 0.8) : 0.8;
	payload.metalness = maps.metalness ? ((await meanOf(maps.metalness)) ?? 0) : 0;
	if (maps.normalMap) {
		setJob(key, { phase: 'Preparing the normal map…' });
		payload.normalMap = await jpegDataUrl(maps.normalMap, edge);
		payload.normalScale = 1;
	}
	setJob(key, { phase: 'Saving to your materials…' });
	const mp = materialPresetsModule;
	const name = await mp.saveMaterialPreset(row.name, payload);
	if (!name) throw refuse('Could not save the material to your library.', 'format');
	const preset = { ...payload, label: name };
	if (applyToSelection) await applyToSelected(mp, preset);
	return { name, payload: preset };
}

/** @param {any} mp the materialPresets module @param {any} preset */
async function applyToSelected(mp, preset) {
	// 105-slots: a slot target (Switch material… > CC0 library) wins over the selection, once
	const target = get(assetBrowserTarget);
	if (target) {
		assetBrowserTarget.set(null);
		const ok = mp.applyMaterialPreset(target.uuid, preset, target.slot);
		if (!ok) showToast('That slot is gone — pick it again');
		return ok ? 1 : 0;
	}
	const uuids = get(selectedObjects)
		.map((/** @type {any} */ o) => (typeof o === 'string' ? o : o?.uuid))
		.filter(Boolean);
	if (!uuids.length) return 0;
	if (uuids.length > 1) beginHistoryBatch();
	let n = 0;
	for (const uuid of uuids) if (mp.applyMaterialPreset(uuid, preset)) n++;
	if (uuids.length > 1) endHistoryBatch('Material: ' + preset.label);
	if (!n) showToast('The selection has no single material to take it');
	return n;
}

/** put a saved CC0 preset on the selection (the card's Apply) @param {any} preset */
export async function applyPresetToSelection(preset) {
	return applyToSelected(materialPresetsModule, preset);
}

/**
 * Place a Library model in the scene (the card's "Add to scene"): the Explorer's own placement
 * path — `importFile` on the item's blob, at the origin — so it replicates like any drop.
 * @param {any} item
 */
export async function placeItem(item) {
	const blob = await itemBlob(item.id);
	if (!blob) return null;
	return importFile(new File([blob], item.name), item.name.replace(/\.\w+$/, ''), undefined, [0, 0, 0]);
}

/** an error as the message a card shows @param {any} err */
export function errorText(err) {
	if (err?.cc0?.message) return err.cc0.message;
	return classifyError(err, typeof navigator === 'undefined' || navigator.onLine !== false).message;
}
