import { mount, unmount } from 'svelte';
import { writable, get } from 'svelte/store';
import MusicToolbox from '../components/menu/MusicToolbox.svelte';
import { registerModuleToolbox, unregisterModuleToolbox } from './moduleToolboxes';
import { setDeviceFor, deviceCatalog, deviceCatalogVersion } from './audioDevices';

// THE MUSIC TOOLBOX (roadmap #23 B2, cloud plans-core/pending/23-b-interfaces.md).
//
// One toolbox, two faces: the selected DEVICE's settings, rendered from its spec's
// declarative `params` (so a new device gets a pane for free — the reason A3 made
// params data rather than a callback), and a MIXER strip with every device in the
// scene as a channel. Plus PRESETS: a named `{kind, params}` snapshot in localStorage,
// applied through `setDeviceFor` so it replicates and undoes like any param write.
//
// It is NOT a hand-rolled overlay. It registers through the SAME toolbox registry a
// module uses (`registerModuleToolbox`, moduleId 'core'), so it inherits the shell —
// header drag with persistence, the width grip, z-band focus, the <=640px bottom
// sheet, the `.tbx-*` contract — and BOTH openers (the sidebar's Modules section and
// the viewport menu) off the one builder, with no plumbing of its own. The body is a
// Svelte component mounted imperatively into the node the shell hands over, which is
// what lets it use DragRow (the app's one numeric field) rather than re-inventing it.

/** the registry id the openers know it by */
export const MUSIC_TOOLBOX_ID = 'mod-core-music';

/** 23-B4: an EXTERNAL pick for the toolbox's device face (the Inspector's "Open in Music
 * toolbox" link, scoped to the primary of the selection). The component adopts it once and
 * clears it, so the pane goes back to following the selection afterwards. */
export const musicToolboxPick = writable('');

let registered = false;
/** @type {(() => void)|null} */ let stop = null;

/**
 * Register the toolbox WHILE DEVICE KINDS EXIST — the viewport menu's own rule for module
 * tools ("the whole entry disappears when no module registered one"). Core ships no device
 * kind of its own, so a user without a music module never sees a Music row in the
 * sidebar; installing one makes it appear, disabling the last one takes it away again
 * (an unregister force-closes it). Idempotent; App boot calls it once.
 */
export function startMusicToolbox() {
	if (stop || typeof window === 'undefined') return;
	stop = deviceCatalogVersion.subscribe(() => {
		const wanted = deviceCatalog().length > 0;
		if (wanted && !registered) {
			registered = true;
			registerModuleToolbox({
				moduleId: 'core',
				id: 'music',
				title: 'Music',
				width: 300,
				minW: 240,
				defaultRect: { right: 12, top: 76 },
				// a jam happens in Play mode too
				playMode: true,
				mount(el) {
					const app = mount(MusicToolbox, { target: el });
					return () => unmount(app);
				}
			});
		} else if (!wanted && registered) {
			registered = false;
			unregisterModuleToolbox(MUSIC_TOOLBOX_ID);
		}
	});
}

/** Test seam. */
export function musicToolboxRegistered() {
	return registered;
}

// ---- presets ----------------------------------------------------------------------------

const PRESETS_KEY = 'musicPresets';

/** @returns {Record<string, {name: string, params: Record<string, any>}[]>} kind -> presets */
function loadPresets() {
	try {
		const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PRESETS_KEY) : null;
		const parsed = raw ? JSON.parse(raw) : {};
		return parsed && typeof parsed === 'object' ? parsed : {};
	} catch {
		return {};
	}
}

/** Named param snapshots, keyed by device kind. LOCAL — a preset is this user's
 * library, and applying one is what replicates. */
export const musicPresets = writable(loadPresets());

function persist() {
	try {
		localStorage.setItem(PRESETS_KEY, JSON.stringify(get(musicPresets)));
	} catch {}
}

/** @param {string} kind */
export function presetsFor(kind) {
	return get(musicPresets)[kind] ?? [];
}

/** Save (or overwrite) a preset. @param {string} kind @param {string} name @param {Record<string, any>} params */
export function savePreset(kind, name, params) {
	const trimmed = String(name ?? '').trim();
	if (!kind || !trimmed) return false;
	musicPresets.update((all) => {
		const list = (all[kind] ?? []).filter((p) => p.name !== trimmed);
		return { ...all, [kind]: [...list, { name: trimmed, params: structuredClone(params ?? {}) }] };
	});
	persist();
	return true;
}

/** @param {string} kind @param {string} name */
export function deletePreset(kind, name) {
	musicPresets.update((all) => ({ ...all, [kind]: (all[kind] ?? []).filter((p) => p.name !== name) }));
	persist();
}

/** Apply a preset to a device: ONE replicated, undoable write. @param {string} uuid
 * @param {{name: string, params: Record<string, any>}} preset */
export function applyPreset(uuid, preset) {
	if (!preset) return null;
	return setDeviceFor(uuid, { params: structuredClone(preset.params ?? {}) });
}
