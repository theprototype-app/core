// 65 M2 — the BACKGROUND PRESET LOADER: the packs repo's `backgrounds/` set over the same
// pinned jsDelivr ref as the Explorer packs (PACKS_BASE), plus the one preset core ships
// itself (backgroundPresetsCore.builtinPresetDoc) so an offline build is never empty.
//
// LOCAL by construction: the list is a fact about this machine's network, and applying a
// preset COPIES its graph into the scene's `background` document (backgroundLayer
// .applyBackgroundDoc) — peers receive the document, never a CDN path, so a peer whose
// CDN is blocked still sees the background.

import { writable, get } from 'svelte/store';
import { PACKS_BASE } from './packs';
import { fetchIndex, onContentStale } from './contentBase';
import { normalizePresetIndex, normalizePresetDoc, builtinPresetDoc, BUILTIN_PRESET_KEY } from './backgroundPresetsCore.js';

/** Where the set lives inside the packs repo. */
export const BACKGROUNDS_PATH = 'backgrounds';

/**
 * @typedef {{key: string, label: string, hint: string, file: string, source: 'packs'|'builtin'}} PresetRow
 * @type {import('svelte/store').Writable<{status: 'idle'|'loading'|'ready'|'offline', error: string, presets: PresetRow[]}>}
 */
export const backgroundPresets = writable({
	status: 'idle',
	error: '',
	presets: [builtinRow()]
});

function builtinRow() {
	const doc = builtinPresetDoc();
	return /** @type {PresetRow} */ ({
		key: BUILTIN_PRESET_KEY,
		label: doc.name,
		hint: 'A calm two-tone gradient with a soft glow under the pointer. Built in — works offline.',
		file: '',
		source: 'builtin'
	});
}

const base = () => String(PACKS_BASE).replace(/\/+$/, '') + '/' + BACKGROUNDS_PATH;

/** @type {Promise<any>|null} */
let loading = null;
/** key -> normalized doc @type {Map<string, any>} */
const docs = new Map();

/** Fetch the list once per session (Retry / an app update re-fetches). @param {{force?: boolean}} [opts] */
export function loadBackgroundPresets(opts = {}) {
	if (loading && !opts.force) return loading;
	backgroundPresets.update((s) => ({ ...s, status: 'loading', error: '' }));
	loading = (async () => {
		try {
			const res = await fetchIndex(base() + '/index.json');
			if (!res.ok) throw new Error('HTTP ' + res.status);
			const index = normalizePresetIndex(await res.json());
			if (!index.ok) throw new Error(index.error);
			/** @type {PresetRow[]} */
			const rows = index.presets.map((p) => ({ ...p, source: /** @type {const} */ ('packs') }));
			backgroundPresets.set({ status: 'ready', error: '', presets: [...rows, builtinRow()] });
		} catch (err) {
			// offline, blocked or a broken file: the built-in stays, and the reason is shown
			backgroundPresets.set({
				status: 'offline',
				error: 'The background pack could not be loaded (' + String(/** @type {any} */ (err)?.message ?? err) + ').',
				presets: [builtinRow()]
			});
		}
		return get(backgroundPresets);
	})();
	return loading;
}

onContentStale(() => {
	loading = null;
	docs.clear();
});

/**
 * One preset's graph, normalized and ready for applyBackgroundDoc.
 * @param {string} key
 * @returns {Promise<{ok: true, doc: any} | {ok: false, error: string}>}
 */
export async function fetchBackgroundPreset(key) {
	if (key === BUILTIN_PRESET_KEY) return normalizePresetDoc(builtinPresetDoc(), key);
	const hit = docs.get(key);
	if (hit) return { ok: true, doc: hit };
	await loadBackgroundPresets();
	const row = get(backgroundPresets).presets.find((p) => p.key === key);
	if (!row || row.source !== 'packs') return { ok: false, error: 'There is no background preset called "' + key + '".' };
	try {
		// a preset FILE is content, not a list: the default cache is right (fetchIndex's rule)
		const res = await fetch(base() + '/' + row.file);
		if (!res.ok) throw new Error('HTTP ' + res.status);
		const result = normalizePresetDoc(await res.json(), key);
		if (result.ok) docs.set(key, result.doc);
		return result;
	} catch (err) {
		return { ok: false, error: 'The preset "' + row.label + '" could not be loaded (' + String(/** @type {any} */ (err)?.message ?? err) + ').' };
	}
}

/**
 * Fetch + apply in one step — what the picker and the e2e suite call.
 * @param {string} key @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function applyBackgroundPreset(key) {
	const result = await fetchBackgroundPreset(key);
	if (!result.ok) return { ok: false, error: result.error };
	const { applyBackgroundDoc } = await import('./backgroundLayer.js');
	applyBackgroundDoc(result.doc);
	return { ok: true };
}
