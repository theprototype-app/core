import { writable, get } from 'svelte/store';
import { globalCamera, orbitControls } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { flyTo } from './objectActions';

// Up to 5 saved camera views, persisted, recalled from the viewport menu or Shift+1..5.

const MAX_SLOTS = 5;
const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('cameraBookmarks') : null;

/** @type {import('svelte/store').Writable<{position: number[], target: number[], ts: number}[]>} */
export const bookmarks = writable(stored ? JSON.parse(stored) : []);

bookmarks.subscribe((value) => {
	if (typeof localStorage !== 'undefined')
		localStorage.setItem('cameraBookmarks', JSON.stringify(value));
});

export function saveBookmark() {
	/** @type {any} */
	const camera = get(globalCamera);
	/** @type {any} */
	const controls = get(orbitControls);
	if (!camera || !controls) return;
	bookmarks.update((list) => {
		const entry = { position: camera.position.toArray(), target: controls.target.toArray(), ts: Date.now() };
		const next = [...list, entry];
		if (next.length > MAX_SLOTS) next.shift();
		showToast('View ' + next.length + ' saved (Shift+' + next.length + ')');
		return next;
	});
}

/** @param {number} index */
export function recallBookmark(index) {
	const list = get(bookmarks);
	const bookmark = list[index];
	if (!bookmark) return;
	flyTo(bookmark.position, bookmark.target);
}

export function clearBookmarks() {
	bookmarks.set([]);
}
