// 41b H14 — THE SAVE OPTIONS, one store for the burger's Save button and the "Save options" modal
// (both layouts: Compact's Save ▾, List's ⚙). A LEAF (svelte/store + safeStorage). The values and their
// localStorage keys are exactly the ones Sidebar.svelte kept in local state since B3 / 21-H1 / 21-I5, so
// a device keeps its choices: `saveFormat` (tp | tpscene | gltf | json), `showGltfFormat` /
// `showJsonFormat` (the two optional formats, OFF by default), and what a .tpscene / .tp carries
// (`tpsceneAssets` ON, `tpscenePacks` OFF, `tpsceneFlow` ON, `tpProjectVersions` ON — fileHandler's
// tpsceneOptions() and projectFile read these keys at save time).
import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';
// 56 C13 (addendum 2026-10-28f): "When several libraries are open" — Ask (default) / Save the active one / Save all I can
import { normalizeSaveMany, SAVE_MANY_KEY } from './sessionVolumeCore';

/** @typedef {{format: string, showGltf: boolean, showJson: boolean, tpAssets: boolean, tpPacks: boolean, tpFlow: boolean, tpProjectVersions: boolean, exportPreset: 'full' | 'quest', saveMany: 'ask' | 'active' | 'all'}} SaveOptions */

/** 46 P3: the export presets a GLTF / .tpscene save (and the Publish / Export bundle) is made with.
 * `exportPreset` is the LAST CHOICE, remembered on this device. */
export const EXPORT_PRESET_OPTIONS = [
	{ value: 'full', label: 'Full quality', title: 'Today\'s output: textures and geometry exactly as they are' },
	{ value: 'quest', label: 'For Quest / web', title: 'KTX2/Basis textures at most 2048 px, an LOD chain, and (GLTF) meshopt compression — smaller files, a fraction of the GPU memory' }
];

export const SAVE_FORMATS = [
	{ value: 'tp', label: 'Project', ext: '.tp', title: 'Saves the whole project as .tp — the Explorer library, scene history and manifest' },
	{ value: 'tpscene', label: 'Scene', ext: '.tpscene', title: 'Saves the open scene as .tpscene' },
	{ value: 'gltf', label: 'GLTF', ext: '.gltf', title: 'Exports the selected objects as glTF (nothing selected: offers the whole scene) — for other tools, not for keeping your work' },
	{ value: 'json', label: 'JSON', ext: '.json', title: 'Saves the scene as raw JSON' }
];

/**
 * A STORED format can name one that is no longer offered (its "Show" switch went off) — a Save
 * button pointing at a format the user cannot see. Falls back to the project format.
 * @param {string} f @param {boolean} json @param {boolean} gltf
 */
export function visibleFormat(f, json, gltf) {
	if (f === 'json' && !json) return 'tp';
	if (f === 'gltf' && !gltf) return 'tp';
	return SAVE_FORMATS.some((s) => s.value === f) ? f : 'tp';
}

/** @param {string} key @param {boolean} dflt */
function readBool(key, dflt) {
	const v = typeof localStorage !== 'undefined' ? safeStorage.getItem(key) : null;
	return v === null ? dflt : v === 'true';
}

/** @returns {SaveOptions} */
export function readSaveOptions() {
	const showJson = readBool('showJsonFormat', false);
	const showGltf = readBool('showGltfFormat', false);
	const stored = typeof localStorage !== 'undefined' ? safeStorage.getItem('saveFormat') || 'tp' : 'tp';
	return {
		format: visibleFormat(stored, showJson, showGltf),
		showGltf,
		showJson,
		tpAssets: readBool('tpsceneAssets', true),
		tpPacks: readBool('tpscenePacks', false),
		tpFlow: readBool('tpsceneFlow', true),
		tpProjectVersions: readBool('tpProjectVersions', true),
		exportPreset: (typeof localStorage !== 'undefined' ? safeStorage.getItem('exportPreset') : null) === 'quest' ? 'quest' : 'full',
		// absent (every device before 56) = Ask, the default — no migration step
		saveMany: normalizeSaveMany(typeof localStorage !== 'undefined' ? safeStorage.getItem(SAVE_MANY_KEY) : null)
	};
}

export const saveOptions = writable(readSaveOptions());

/** the "Save options" modal (Compact's ▾, List's ⚙) */
export const saveOptionsOpen = writable(false);

/**
 * Write options (a partial patch) — normalised (the format stays a visible one) and PERSISTED, the
 * fallback format included: the stored value is what the next boot reads.
 * @param {Partial<SaveOptions>} patch
 */
export function setSaveOptions(patch) {
	const next = { ...get(saveOptions), ...patch };
	next.format = visibleFormat(next.format, next.showJson, next.showGltf);
	safeStorage.setItem('saveFormat', next.format);
	safeStorage.setItem('showGltfFormat', String(next.showGltf));
	safeStorage.setItem('showJsonFormat', String(next.showJson));
	safeStorage.setItem('tpsceneAssets', String(next.tpAssets));
	safeStorage.setItem('tpscenePacks', String(next.tpPacks));
	safeStorage.setItem('tpsceneFlow', String(next.tpFlow));
	safeStorage.setItem('tpProjectVersions', String(next.tpProjectVersions));
	next.exportPreset = next.exportPreset === 'quest' ? 'quest' : 'full';
	safeStorage.setItem('exportPreset', next.exportPreset);
	next.saveMany = normalizeSaveMany(next.saveMany);
	safeStorage.setItem(SAVE_MANY_KEY, next.saveMany);
	saveOptions.set(next);
	return next;
}
