// 105-noise (roadmap 105 T4a row 3) — "FILL WITH NOISE" ON A MATERIAL SLOT'S MAP ROW. Lazy: the Inspector's rows
// reach this by a dynamic import, so nothing here is in the boot chunk.
//
// A slot WITH an image: the Image editor opens on it with the Noise panel open (the colour map through the editor's
// own `editMaterialTexture`, which links the slot to its library image so Save re-textures it; any other map row is
// put in the library and remembered on the editor's target as `slotMap`, so Save also writes that row).
// A slot WITHOUT one: a size dialog (512 / 1024 / 2048, default 1024; 2048 warns on the phone tier), then a noise
// image is made with the row's own sensible defaults, put in the library, set on the slot as ONE undo step, and the
// editor opens on it to tune.
//
// The result is an ORDINARY texture: the colour map goes through `setObjectsTexture` (the `map` message, its
// `source` link already existing), the other rows through `setObjectsMapSlot` (the `mapSlot` message). No new wire
// type and no new save field: an older build sees a texture. Every slot texture is stored at most 1024 px
// (materialsHandler TEXTURE_MAX_SIDE), so a 2048 fill keeps its full size in the library and the slot draws it at
// 1024 (QUESTIONS-105-noise Q2).
import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore';
import { showToast } from '../../stores/appStore';
import { showChoice } from '../confirmDialog';
import { deviceClass } from '../deviceClass.js';
import { addItemFromBytes } from '../explorer';
import { materialAt, setObjectsTexture } from '../materialsHandler';
import { mapPreviewUrl } from '../loadGuard.js';
import { setObjectsMapSlot } from '../materialMaps';
import { mapSlotUrl } from '../materialMapTextures.js';
import { MAP_SLOTS } from '../materialParamRules.js';
import { withWireBatchAsync } from '../wireBatch';
import { openImageEditor, editMaterialTexture, encodeImage } from './imageEditor';
import { renderNoise } from './noiseRun';
import { NOISE_ROW_DEFAULTS } from './noiseCore.js';

/** the sizes the dialog offers; the first is the default */
export const FILL_SIZES = Object.freeze([1024, 512, 2048]);
/** above this the phone tier is warned */
export const PHONE_SIZE_WARN = 1024;

/** the row's starting options (noiseCore NOISE_ROW_DEFAULTS) @param {string} key */
export function noiseDefaultsFor(key) {
	return { ...(NOISE_ROW_DEFAULTS[key] ?? NOISE_ROW_DEFAULTS.map) };
}

/** the row's words: 'map' is the Texture (colour) row @param {string} key */
export function rowLabel(key) {
	return key === 'map' ? 'Colour' : (MAP_SLOTS.find((s) => s.key === key)?.label ?? 'Map');
}

/** @param {string} uuid */
const objectOf = (uuid) => /** @type {any} */ (get(objectsGroup))?.getObjectByProperty?.('uuid', uuid) ?? null;

/** @param {string} name */
const fileStem = (name) => String(name || 'Object').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Object';

/**
 * The size dialog. @param {string} label @returns {Promise<number | null>}
 */
export async function askFillSize(label) {
	const phone = get(deviceClass) === 'phone';
	const choice = await showChoice({
		title: 'Fill the ' + label + ' map with noise',
		message:
			'The size of the new texture. A material draws at most 1024 px; a 2048 image keeps its full size in the library.' +
			(phone ? ' On a phone, sizes above ' + PHONE_SIZE_WARN + ' are slow to make and use a lot of memory.' : ''),
		choices: FILL_SIZES.map((size) => ({
			value: String(size),
			label: size + ' px' + (size === FILL_SIZES[0] ? ' (default)' : '') + (phone && size > PHONE_SIZE_WARN ? ' (slow on a phone)' : '')
		}))
	});
	const n = Number(choice);
	return FILL_SIZES.includes(n) ? n : null;
}

/**
 * The row's button. `uuids` = the objects the row writes to (the Inspector's targets), `slot` = the material slot.
 * @param {{uuids: string[], key: string, slot?: number, size?: number}} opts
 * @returns {Promise<boolean>}
 */
export async function fillSlotWithNoise({ uuids, key, slot = 0, size }) {
	const list = (uuids ?? []).filter(Boolean);
	const object = objectOf(list[0]);
	const material = object && materialAt(object, slot);
	if (!material || !(key in material)) {
		showToast('That material has no ' + rowLabel(key) + ' map');
		return false;
	}
	const noise = noiseDefaultsFor(key);
	const label = rowLabel(key);
	// a slot that already has an image: the editor on it, with the panel open
	if (key === 'map' && mapPreviewUrl(material)) return editMaterialTexture(list[0], slot, { panel: 'noise', noise });
	const current = key === 'map' ? null : mapSlotUrl(material, key);
	if (current) {
		const blob = await (await fetch(current)).blob();
		const ext = blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/png' ? 'png' : 'webp';
		const record = await addItemFromBytes(await blob.arrayBuffer(), fileStem(object.name) + ' ' + label + ' map.' + ext, null, { imported: true });
		if (!record) return false;
		return openImageEditor(record.id, { panel: 'noise', noise, slotMap: { uuids: list, key, slot } });
	}
	// no image yet: make one
	const side = size ?? (await askFillSize(label));
	if (!side) return false;
	const raster = await renderNoise(noise, { width: side, height: side });
	const blob = await encodeImage(raster, { type: 'image/png' });
	const record = await addItemFromBytes(await blob.arrayBuffer(), fileStem(object.name) + ' ' + label + ' noise.png', null, { type: 'image/png' });
	if (!record) return false;
	const applied =
		key === 'map'
			? await withWireBatchAsync(() => setObjectsTexture(list, blob, slot, { source: record.hash }))
			: await withWireBatchAsync(() => setObjectsMapSlot(list, key, blob, slot));
	if (!applied) return false;
	showToast('Filled the ' + label + ' map with noise' + (list.length > 1 ? ' on ' + list.length + ' objects' : '') + ' — tune it in the Image editor');
	return openImageEditor(record.id, key === 'map' ? { panel: 'noise', noise } : { panel: 'noise', noise, slotMap: { uuids: list, key, slot } });
}

/**
 * The editor saved an image it was opened on from a non-colour map row: write it to that row too (the colour row
 * needs nothing, its `source` link already re-textures it). One undo step of its own.
 * @param {{uuids: string[], key: string, slot?: number}} slotMap @param {Blob} blob @returns {Promise<number>}
 */
export async function writeSlotMapBack(slotMap, blob) {
	if (!slotMap?.uuids?.length || slotMap.key === 'map') return 0;
	return withWireBatchAsync(() => setObjectsMapSlot(slotMap.uuids, slotMap.key, blob, slotMap.slot ?? 0));
}
