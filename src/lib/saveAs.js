// R22 ROUND 11 — "SAVE AS…", AND WHAT A PREFAB IS MADE OF.
//
// The user settled the formats themselves and the wording is worth keeping verbatim,
// because it contains the design:
//
//   "I would like to be able to save prefabs as they are now with right click 'Save
//    as...' for selected objects with following options: prefab (.glb), prefab
//    (.tpscene) — tooltip when hovering that it includes animations/object-graph-nodes/
//    shaders/etc, glb/gltf — just downloads selected objects. ... for dragging to Library
//    and back: 3d objects automatically placed as existing format (.glb/.gltf), .tpscene
//    are placed as .tpscene (with thumbnail). This solves converting dilemma, we do not
//    need to convert anything in this case."
//
// THE DESIGN QUESTION THIS ANSWERS. A prefab was a JSON snapshot in IndexedDB, not a
// file, so "prefab (.glb)" had nothing to mean. It means something now: A PREFAB RECORD
// MAY CARRY A FORMAT AND THE FILE'S OWN BYTES, and the ObjectLoader snapshot stays the
// DEFAULT — because the no-conversion rule above only works if a prefab ALREADY IS one of
// those formats when it travels.
//
// The bytes ride BESIDE the snapshot rather than instead of it, and that is the whole
// reason nothing else in the app had to change: the thumbnail, the Properties 3D preview,
// the facts block, the VR sleeve, the drag-to-viewport placement and undo all read
// `element`, and every one of them would have gone blank for the new formats. The bytes
// exist for the two things a snapshot cannot do — hand the file back in its own format,
// and move to the Library without being converted. It is the same rule the codebase
// already keeps for animated rigs and material arrays: what a serializer cannot carry
// rides beside it and replaces its twin on the way back in.
//
// WHAT EACH FORMAT KEEPS, which is what the tooltips say out loud:
//   · snapshot  — everything three can serialize, and nothing keyed by uuid beside it
//   · .glb      — geometry, materials, baked authored clips, the baked origin. NOT node
//                 shaders (glTF has no node materials), NOT object flow graphs
//   · .tpscene  — the objects PLUS their clips, flow graphs, shader graphs and the joints
//                 between them. NOT the world: sky, look, gravity, music, HUD and game
//                 shell stay with the scene they belong to
//
// A LEAF in the sense that matters here: it composes prefabs / fileHandler / sessions and
// nothing composes it back. `sessions` is reached by DYNAMIC import — it pulls the zip
// library and the whole save machinery, and an object menu has no business paying for
// that until somebody picks the one format that needs it.

import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { addPrefabRecord, prefabElementFor, prefabThumbnail } from './prefabs';
import { gltfBytesFor } from './fileHandler.svelte.js';

/**
 * The catalog, as DATA — the `buildObjectMenuItems` / `hudActions` shape, so the menu
 * renders FROM it and a format cannot exist in one place and not the other.
 * @typedef {{id: string, label: string, kind: 'prefab'|'download', ext?: string, tooltip: string}} SaveAsFormat
 * @type {SaveAsFormat[]}
 */
export const SAVE_AS_FORMATS = [
	{
		id: 'snapshot',
		label: 'Prefab',
		kind: 'prefab',
		tooltip:
			'Reusable copy in your Library, exactly as prefabs have always worked — local, and instances replicate.'
	},
	{
		id: 'glb',
		label: 'Prefab (.glb)',
		kind: 'prefab',
		ext: 'glb',
		tooltip:
			'A prefab that IS a .glb file: geometry, materials and baked animation. Node shaders and object flow graphs are not part of glTF, so they stay behind. Drags to the Library as a .glb.'
	},
	{
		id: 'tpscene',
		label: 'Prefab (.tpscene)',
		kind: 'prefab',
		ext: 'tpscene',
		tooltip:
			'A prefab that IS a .tpscene: the objects plus their animation clips, object flow graphs, shader graphs and the joints between them. The scene itself — sky, look, gravity, music, HUD — stays behind. Drags to the Library as a .tpscene.'
	},
	{
		id: 'download-glb',
		label: 'glTF binary (.glb)',
		kind: 'download',
		ext: 'glb',
		tooltip: 'Just download the selected objects. Nothing is stored in your Library.'
	},
	{
		id: 'download-gltf',
		label: 'glTF (.gltf)',
		kind: 'download',
		ext: 'gltf',
		tooltip: 'Just download the selected objects as text glTF. Nothing is stored in your Library.'
	}
];

/** @param {string} id */
export function saveAsFormat(id) {
	return SAVE_AS_FORMATS.find((f) => f.id === id) ?? null;
}

/** which format a stored prefab IS. Absent means the snapshot every prefab used to be.
 * @param {any} prefab @returns {string} */
export function prefabFormatOf(prefab) {
	return String(prefab?.format ?? 'snapshot');
}

/** the file name a byte-backed prefab hands back @param {any} prefab @returns {string} */
export function prefabFileName(prefab) {
	const format = prefabFormatOf(prefab);
	const stem = String(prefab?.name || 'prefab').replace(/[^\w-]+/g, '_');
	return format === 'snapshot' ? stem + '.json' : stem + '.' + format;
}

/** the live objects behind a uuid list @param {string[]} uuids */
function rootsOf(uuids) {
	const group = get(objectsGroup);
	return (uuids ?? [])
		.map((uuid) => group?.getObjectByProperty('uuid', uuid))
		.filter(Boolean);
}

/**
 * Run one catalog entry against a selection. ONE entry point, so the menu, a keyboard
 * route and any future caller cannot disagree about what a format does.
 * @param {string} formatId @param {string[]} uuids @param {string} [name]
 * @returns {Promise<any>} the prefab record, true for a download, or null
 */
export async function saveSelectionAs(formatId, uuids, name) {
	const format = saveAsFormat(formatId);
	const list = (uuids ?? []).filter(Boolean);
	if (!format) return null;
	if (!list.length) {
		showToast('Nothing selected');
		return null;
	}
	if (format.kind === 'download') return downloadSelectionAs(format, list, name);
	if (format.id === 'snapshot') {
		const element = prefabElementFor(list, name);
		if (!element) return null;
		const entry = await addPrefabRecord({ name: element.name, element: element.element });
		if (entry) showToast('Prefab saved to your library');
		return entry;
	}
	// BOTH byte formats build the snapshot FIRST — it is the picture, the preview and the
	// thing that lands at the cursor when the prefab is dragged back out. `keepUuids` is
	// only meaningful for .tpscene, where the documents are keyed by them, but asking for
	// it in both places keeps the two branches the same shape.
	const snap = prefabElementFor(list, name, { keepUuids: true });
	if (!snap) return null;
	const thumbnail = prefabThumbnail(snap.element);
	const bytes = format.id === 'glb' ? await glbBytes(list) : await tpsceneBytes(snap.name, list);
	if (!bytes) {
		showToast('That selection could not be written as ' + format.label);
		return null;
	}
	const entry = await addPrefabRecord({
		name: snap.name,
		element: snap.element,
		thumbnail,
		format: format.id,
		bytes
	});
	if (entry) showToast('Saved "' + entry.name + '" as a ' + format.label.toLowerCase());
	return entry;
}

/** @param {string[]} uuids @returns {Promise<ArrayBuffer|null>} */
export function glbBytes(uuids) {
	return gltfBytesFor(rootsOf(uuids), { binary: true });
}

/** @param {string} name @param {string[]} uuids @returns {Promise<ArrayBuffer|null>} */
export async function tpsceneBytes(name, uuids) {
	try {
		const { buildSelectionPayload, exportSessionZip } = await import('./sessions');
		const payload = buildSelectionPayload(name, uuids);
		// `assets: false` — a prefab is objects, and a texture already lives in the library
		// it is being saved into. `flow: true` keeps the graphs, which is the whole point.
		const zip = await exportSessionZip(payload, { assets: false, packs: false, flow: true });
		return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength);
	} catch (error) {
		console.log('tpscene prefab failed', error);
		return null;
	}
}

/** the two rows that only download. @param {SaveAsFormat} format @param {string[]} uuids @param {string} [name] */
async function downloadSelectionAs(format, uuids, name) {
	const bytes = await gltfBytesFor(rootsOf(uuids), { binary: format.ext === 'glb' });
	if (!bytes) {
		showToast('Nothing in the selection could be exported');
		return null;
	}
	const stem = String(name || 'selection').replace(/[^\w-]+/g, '_');
	saveBytes(bytes, stem + '.' + format.ext, format.ext === 'glb' ? 'model/gltf-binary' : 'model/gltf+json');
	showToast('Exported ' + uuids.length + ' object' + (uuids.length === 1 ? '' : 's') + ' as .' + format.ext);
	return true;
}

/** the anchor + object URL ritual, the one way a page can start a download
 * @param {ArrayBuffer} bytes @param {string} filename @param {string} [type] */
export function saveBytes(bytes, filename, type = 'application/octet-stream') {
	const url = URL.createObjectURL(new Blob([bytes], { type }));
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}
