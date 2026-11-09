// 93 LP2 — THE EXPORT'S LOADING SCREEN. An exported game boots on its author's loading screen, so the screen
// has to be known BEFORE the scene file is read: its config rides play.js (exportBoot copies `loading` as data,
// loading.normalizeLoading cleans it again at use), and a library image (an Explorer hash) is copied into the
// bundle as `assets/loading/<hash>.<ext>` so the export needs no library to draw it.

/**
 * @param {Record<string, Uint8Array>} out the bundle's files @param {any} payload the scene's payload
 * @param {string[]} warnings @returns {Promise<any | null>} the config for play.js (null = none authored)
 */
export async function exportLoadingScreen(out, payload, warnings) {
	const raw = payload?.physics?.levels?.loading;
	if (!raw) return null;
	const { normalizeLoading } = await import('./loadingConfig.js');
	/** @type {any} */
	const cfg = normalizeLoading(raw);
	for (const key of ['image', 'logo']) {
		const ref = cfg[key];
		if (!ref || /^(https?:|data:)/.test(ref)) continue;
		try {
			const { itemByHash, itemBlob } = await import('../explorer');
			const item = itemByHash(ref);
			const blob = item ? await itemBlob(item.id) : null;
			if (!blob) throw new Error('not in the library');
			const ext = (String(blob.type).split('/')[1] || 'png').replace(/[^a-z0-9]/g, '').slice(0, 5) || 'png';
			const path = 'assets/loading/' + String(ref).replace(/[^\w-]/g, '').slice(0, 24) + '.' + ext;
			out[path] = new Uint8Array(await blob.arrayBuffer());
			cfg[key] = path;
		} catch {
			delete cfg[key];
			warnings.push(`The loading screen's ${key} could not be copied — the export shows the screen without it.`);
		}
	}
	return cfg;
}

/** an exported bundle path the loading screen may draw (relative, no scheme, no `..`) @param {string} ref */
export function bundledLoadingPath(ref) {
	return typeof ref === 'string' && ref.startsWith('assets/loading/') && !ref.split('/').includes('..');
}
