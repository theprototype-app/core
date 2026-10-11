// 41 G17 — THE PROFILER'S SETTINGS TAB (the right sidebar's ⚙, like the Explorer's). LOCAL to
// this device, persisted in one record; nothing replicates. The toggles picked are the ones that
// change what you can READ in a recording:
//   lanes          which graphs the timeline draws (FPS / frame ms / draw calls / triangles /
//                  quality) — fewer lanes, taller lanes
//   budget         the Quest budget: the dashed line and the red over-budget columns
//   followLive     a live stream keeps its newest frames in view (off = it holds still to read)
//   selectInScene  a tree / ranking row also selects its object in the scene (off = it only
//                  fills the Details tab, the scene selection is left alone)
// The fifth row, the FPS and draw-call overlay, is the app's own pref (fpsMeter.perfStatsShown).
import { writable, get } from 'svelte/store';
import { safeStorage } from '../safeStorage';

export const PROFILER_LANES = /** @type {const} */ (['fps', 'ms', 'calls', 'tris', 'quality']);
const KEY = 'profiler:prefs';
/** @typedef {{lanes: string[], budget: boolean, followLive: boolean, selectInScene: boolean}} ProfilerPrefs */
/** @type {ProfilerPrefs} */
export const PROFILER_DEFAULTS = Object.freeze({ lanes: [...PROFILER_LANES], budget: true, followLive: true, selectInScene: true });

/** @param {any} raw @returns {ProfilerPrefs} */
export function normalizeProfilerPrefs(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const lanes = Array.isArray(r.lanes) ? PROFILER_LANES.filter((k) => r.lanes.includes(k)) : [...PROFILER_LANES];
	return {
		lanes: lanes.length ? lanes : [...PROFILER_LANES],
		budget: r.budget !== false,
		followLive: r.followLive !== false,
		selectInScene: r.selectInScene !== false
	};
}

function load() {
	try {
		return normalizeProfilerPrefs(JSON.parse(safeStorage.getItem(KEY) || 'null'));
	} catch {
		return normalizeProfilerPrefs(null);
	}
}
export const profilerPrefs = writable(load());

/** @param {Partial<ProfilerPrefs>} patch */
export function setProfilerPrefs(patch) {
	profilerPrefs.update((p) => {
		const next = normalizeProfilerPrefs({ ...p, ...patch });
		try {
			safeStorage.setItem(KEY, JSON.stringify(next));
		} catch {
			// private mode: this session only
		}
		return next;
	});
}

/** turn one timeline lane on/off — the last lane cannot go (an empty timeline reads as broken)
 * @param {string} key @param {boolean} on */
export function setProfilerLane(key, on) {
	const cur = get(profilerPrefs).lanes;
	const next = on ? [...new Set([...cur, key])] : cur.filter((k) => k !== key);
	if (!next.length) return;
	setProfilerPrefs({ lanes: next });
}
