// 105 T1: "From Explorer" — ONE picker for library files, opened from every place that takes an image
// (material map slots, the UV editor's slots, Image to 3D, touch button images). The window itself is a
// lazy chunk mounted on <body> for the length of one pick; this leaf only opens it and keeps the
// "recent" list (LOCAL: a fact about this person's habits, never saved with a scene or sent).
import { safeStorage } from './safeStorage';
import { withRecent } from './explorerPickerCore.js';

const RECENT_KEY = 'explorer:recentPicks';

/** @returns {string[]} */
export function recentPicks() {
	try {
		const list = JSON.parse(safeStorage.getItem(RECENT_KEY) || '[]');
		return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : [];
	} catch {
		return [];
	}
}

/** @param {string} id */
export function noteRecentPick(id) {
	safeStorage.setItem(RECENT_KEY, JSON.stringify(withRecent(recentPicks(), id)));
}

/** the pick open now, so a second open replaces it (its promise resolves null) @type {(() => void) | null} */
let closeOpen = null;

/**
 * Open the Explorer picker and resolve the chosen library record, or null when it was closed.
 * @param {{title?: string, accept?: string[], id?: string}} [opts] `accept`: item kinds ('image') and/or
 *   extensions ('.svg'); default images. `id` names the dialog for suites (`#explorer-picker` by default).
 * @returns {Promise<any | null>}
 */
export async function pickFromExplorer(opts = {}) {
	closeOpen?.();
	const [{ mount, unmount }, { default: Picker }, { loadExplorer }] = await Promise.all([
		import('svelte'),
		import('../components/editors/ExplorerPicker.svelte'),
		import('./explorer')
	]);
	await loadExplorer();
	return new Promise((resolve) => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		/** @type {any} */
		let app = null;
		let settled = false;
		/** @param {any} item */
		const done = (item) => {
			if (settled) return;
			settled = true;
			if (closeOpen === cancel) closeOpen = null;
			if (item?.id) noteRecentPick(item.id);
			// unmount after the click that chose has finished bubbling through the dialog
			queueMicrotask(() => {
				if (app) unmount(app);
				host.remove();
			});
			resolve(item ?? null);
		};
		const cancel = () => done(null);
		closeOpen = cancel;
		app = mount(Picker, {
			target: host,
			props: { title: opts.title ?? 'Pick an image from the Explorer', accept: opts.accept ?? ['image'], dialogId: opts.id ?? 'explorer-picker', recent: recentPicks(), done }
		});
	});
}
