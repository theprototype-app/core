import { writable, get } from 'svelte/store';
import { globalCamera, orbitControls } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { flyTo } from './objectActions';
import { cameraNear, cameraFar, setCameraNear, setCameraFar } from './cameraClip';

// Saved camera views, persisted LOCALLY (never replicated), recalled from the
// viewport menu, Configure Scene ▸ Camera, or Shift+1..5 for the first five.
//
// 16-P4: they used to be five anonymous slots where a sixth save silently pushed
// the oldest out. Now: an unlimited NAMED list, each entry carrying the LENS it
// was saved with (FOV + clip planes) so recalling restores the whole look, and a
// management UI (rename / overwrite from the current view / delete / reorder).
// Legacy `{position, target, ts}` payloads normalize on read.

/** how many entries the Shift+N shortcuts reach */
export const SHORTCUT_SLOTS = 5;

const KEY = 'cameraBookmarks';

/**
 * @typedef {{id: string, name: string, position: number[], target: number[],
 *   lens: {fov: number, near: number, far: number} | null, ts: number}} Bookmark
 */

/** @param {any} entry @param {number} index */
export function normalizeBookmark(entry, index) {
	return {
		id: entry?.id ?? 'bm-' + (entry?.ts ?? index) + '-' + index,
		name: entry?.name || 'View ' + (index + 1),
		position: Array.isArray(entry?.position) ? entry.position : [0, 0, 0],
		target: Array.isArray(entry?.target) ? entry.target : [0, 0, 0],
		// legacy entries have no lens — recall then leaves the current lens alone
		lens: entry?.lens ?? null,
		ts: entry?.ts ?? Date.now()
	};
}

function load() {
	try {
		const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
		const list = raw ? JSON.parse(raw) : [];
		return Array.isArray(list) ? list.map(normalizeBookmark) : [];
	} catch {
		return [];
	}
}

/** @type {import('svelte/store').Writable<Bookmark[]>} */
export const bookmarks = writable(load());

bookmarks.subscribe((value) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(value));
});

/** the current view as a bookmark payload, or null when the camera isn't ready */
function currentView() {
	/** @type {any} */
	const camera = get(globalCamera);
	/** @type {any} */
	const controls = get(orbitControls);
	if (!camera || !controls) return null;
	return {
		position: camera.position.toArray(),
		target: controls.target.toArray(),
		lens: {
			fov: camera.fov ?? 40,
			near: get(cameraNear),
			far: get(cameraFar)
		},
		ts: Date.now()
	};
}

/** @param {string} [name] */
export function saveBookmark(name) {
	const view = currentView();
	if (!view) return null;
	/** @type {any} */
	let saved = null;
	bookmarks.update((list) => {
		const entry = {
			id: 'bm-' + view.ts + '-' + list.length,
			name: name || 'View ' + (list.length + 1),
			...view
		};
		saved = entry;
		const next = [...list, entry];
		showToast(
			next.length <= SHORTCUT_SLOTS
				? `"${entry.name}" saved (Shift+${next.length})`
				: `"${entry.name}" saved`
		);
		return next;
	});
	return saved;
}

/** Recall by index — position + target always, the lens when the entry has one.
 * @param {number} index */
export function recallBookmark(index) {
	const bookmark = get(bookmarks)[index];
	if (!bookmark) return;
	if (bookmark.lens) {
		/** @type {any} */
		const camera = get(globalCamera);
		if (camera && typeof bookmark.lens.fov === 'number') {
			camera.fov = bookmark.lens.fov;
			camera.updateProjectionMatrix();
		}
		// near/far go through cameraClip so the orbit zoom clamp stays paired with far
		if (typeof bookmark.lens.near === 'number') setCameraNear(bookmark.lens.near);
		if (typeof bookmark.lens.far === 'number') setCameraFar(bookmark.lens.far);
	}
	flyTo(bookmark.position, bookmark.target);
}

/** @param {string} id */
export function recallBookmarkById(id) {
	const index = get(bookmarks).findIndex((entry) => entry.id === id);
	if (index >= 0) recallBookmark(index);
}

/** @param {string} id @param {string} name */
export function renameBookmark(id, name) {
	const clean = (name ?? '').trim();
	if (!clean) return;
	bookmarks.update((list) => list.map((entry) => (entry.id === id ? { ...entry, name: clean } : entry)));
}

/** Re-point an existing bookmark at the CURRENT view, keeping its name @param {string} id */
export function overwriteBookmark(id) {
	const view = currentView();
	if (!view) return;
	bookmarks.update((list) => list.map((entry) => (entry.id === id ? { ...entry, ...view } : entry)));
	showToast('View updated');
}

/** @param {string} id */
export function deleteBookmark(id) {
	bookmarks.update((list) => list.filter((entry) => entry.id !== id));
}

/** Move an entry one place up/down — order IS the Shift+N mapping.
 * @param {string} id @param {-1 | 1} direction */
export function moveBookmark(id, direction) {
	bookmarks.update((list) => {
		const index = list.findIndex((entry) => entry.id === id);
		const next = index + direction;
		if (index < 0 || next < 0 || next >= list.length) return list;
		const copy = [...list];
		[copy[index], copy[next]] = [copy[next], copy[index]];
		return copy;
	});
}

export function clearBookmarks() {
	bookmarks.set([]);
}
