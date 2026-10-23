import { writable, get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { showToast, showInfoToast, dismissToastById } from '../stores/appStore';

// 59 T7a — WATCH THE EXPORTED FILE, the DCC pipeline's reload. On Chromium desktop the File System
// Access API hands us a HANDLE to the .glb the other tool writes; its modified time is polled, and
// when it changes the app offers Reload (or reloads at once — a per-object toggle). Other browsers
// have no handle to keep, so they keep the manual drop, which works everywhere.
//
// LOCAL ONLY: a handle is a permission on THIS machine's file, so nothing here is sent or saved —
// the reload itself is an ordinary Replace (T1), and that replicates. A watch ends when its object
// is gone, when the file can no longer be read (moved, permission revoked) or on Stop; a reload
// keeps it (the next save in the tool is the next reload).
//
// A SAVE IS NOT ATOMIC in every tool: Blender writes the .glb in place, so a poll can land on a
// half-written file. A change is acted on only when two reads POLL_SETTLE_MS apart agree on the
// size and the time, and a file that does not parse is simply waited out (the next save wins).

const POLL_MS = 1500;
const POLL_SETTLE_MS = 400;

/** uuid -> what the Inspector shows @type {import('svelte/store').Writable<Record<string, {fileName: string, auto: boolean, lastModified: number}>>} */
export const watchedModels = writable({});

/** uuid -> {handle, lastModified, size, busy} @type {Map<string, {handle: any, lastModified: number, size: number, busy: boolean}>} */
const watches = new Map();
/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;

/** can this browser keep a handle to a file on disk? (Chromium desktop) */
export function canWatchFiles() {
	if (typeof window === 'undefined' || typeof (/** @type {any} */ (window).showOpenFilePicker) !== 'function') return false;
	// a phone's picker hands back a copy, not the file the other tool writes
	return !/Android|iPhone|iPad/i.test(navigator.userAgent ?? '');
}

/** @param {string} uuid */
function objectOf(uuid) {
	/** @type {any} */
	const group = get(objectsGroup);
	return group?.getObjectByProperty('uuid', uuid) ?? null;
}

/** @param {string} uuid */
const toastId = (uuid) => 'model-watch-' + uuid;

function publish() {
	/** @type {Record<string, {fileName: string, auto: boolean, lastModified: number}>} */
	const out = {};
	const prev = get(watchedModels);
	for (const [uuid, w] of watches) out[uuid] = { fileName: w.handle?.name ?? 'model.glb', auto: !!prev[uuid]?.auto, lastModified: w.lastModified };
	watchedModels.set(out);
}

/**
 * Watch `handle` (a FileSystemFileHandle, or anything with `name` + `getFile()`) for `uuid`.
 * @param {string} uuid @param {any} handle @param {{auto?: boolean}} [opts]
 */
export async function watchHandle(uuid, handle, opts = {}) {
	if (!handle?.getFile) return false;
	/** @type {any} */
	let file;
	try {
		file = await handle.getFile();
	} catch {
		showToast('Could not read ' + (handle.name ?? 'that file') + '.');
		return false;
	}
	watches.set(uuid, { handle, lastModified: file.lastModified, size: file.size, busy: false });
	watchedModels.update((map) => ({ ...map, [uuid]: { fileName: handle.name ?? 'model.glb', auto: !!opts.auto, lastModified: file.lastModified } }));
	if (!timer) timer = setInterval(() => void pollAll(), POLL_MS);
	return true;
}

/**
 * T7a: pick the file the other tool saves (Chromium desktop) and watch it. The picker must run in
 * the click that asked for it (a user activation), which is why the card's button calls this.
 * @param {string} uuid
 */
export async function watchModelFile(uuid) {
	if (!canWatchFiles()) {
		showToast('This browser cannot watch a file — drop the exported file onto the model instead.');
		return false;
	}
	/** @type {any} */
	let handle;
	try {
		[handle] = await /** @type {any} */ (window).showOpenFilePicker({
			id: 'tp-model-watch',
			startIn: 'downloads',
			types: [{ description: 'glTF model', accept: { 'model/gltf-binary': ['.glb'], 'model/gltf+json': ['.gltf'] } }]
		});
	} catch {
		return false; // cancelled
	}
	const ok = await watchHandle(uuid, handle);
	if (ok) showToast('Watching ' + handle.name + ' — save it again in your tool and "' + (objectOf(uuid)?.name ?? 'the model') + '" offers to reload.');
	return ok;
}

/** @param {string} uuid */
export function stopWatching(uuid) {
	watches.delete(uuid);
	dismissToastById(toastId(uuid));
	watchedModels.update((map) => {
		const next = { ...map };
		delete next[uuid];
		return next;
	});
	if (!watches.size && timer) {
		clearInterval(timer);
		timer = null;
	}
}

/** the per-object "reload automatically" toggle @param {string} uuid @param {boolean} on */
export function setAutoReload(uuid, on) {
	watchedModels.update((map) => (map[uuid] ? { ...map, [uuid]: { ...map[uuid], auto: !!on } } : map));
}

/** reload `uuid` from its watched file now @param {string} uuid @param {any} [file] */
export async function reloadWatched(uuid, file) {
	const w = watches.get(uuid);
	if (!w) return null;
	dismissToastById(toastId(uuid));
	w.busy = true;
	try {
		const f = file ?? (await w.handle.getFile());
		// dynamic: the Inspector imports this module for its store, and must not pull the replace in
		const { replaceModelFromFile } = await import('./modelReplace');
		return await replaceModelFromFile(uuid, f, { source: 'watch' });
	} catch (error) {
		console.log('model watch: reload failed', error);
		return null;
	} finally {
		w.busy = false;
	}
}

/** one poll of every watch (exported for the suites, which drive it instead of waiting) */
export async function pollAll() {
	for (const [uuid, w] of [...watches]) {
		if (w.busy) continue;
		const live = objectOf(uuid);
		if (!live) {
			stopWatching(uuid);
			continue;
		}
		/** @type {any} */
		let file;
		try {
			file = await w.handle.getFile();
		} catch {
			stopWatching(uuid);
			showToast('Stopped watching ' + (w.handle.name ?? 'the file') + ' — it can no longer be read.');
			continue;
		}
		if (file.lastModified === w.lastModified && file.size === w.size) continue;
		// settle: a tool may still be writing it
		await new Promise((r) => setTimeout(r, POLL_SETTLE_MS));
		/** @type {any} */
		let again;
		try {
			again = await w.handle.getFile();
		} catch {
			continue;
		}
		if (again.lastModified !== file.lastModified || again.size !== file.size || !again.size) continue;
		w.lastModified = again.lastModified;
		w.size = again.size;
		publish();
		if (get(watchedModels)[uuid]?.auto) {
			void reloadWatched(uuid, again);
			continue;
		}
		const name = live.name || 'the model';
		showInfoToast(toastId(uuid), (w.handle.name ?? 'The file') + ' changed — reload "' + name + '"?', [
			{ label: 'Reload', action: () => void reloadWatched(uuid) },
			{
				label: 'Always reload',
				action: () => {
					setAutoReload(uuid, true);
					void reloadWatched(uuid);
				}
			},
			{ label: 'Stop watching', action: () => stopWatching(uuid) }
		]);
	}
}
