import { writable, get } from 'svelte/store';
import { snapSettings } from './snapping';

// Grid appearance (16-P3): a LOCAL per-device view preference, never replicated —
// same family as `showGrid`, `viewMode` and the cameraClip planes. Peers each get
// their own grid; only scene CONTENT replicates.
//
// `matchSnapStep` is the one that earns its keep: with it on, the visible cell
// size tracks the translate snap step, so the grid you see is the grid objects
// actually land on.

const KEY = 'gridSettings';

export const DEFAULT_GRID = {
	/** world units per cell (ignored while matchSnapStep is on) */
	cellSize: 1,
	/** keep cellSize == the translate snap step */
	matchSnapStep: false,
	/** a thicker "section" line every N cells */
	sectionEvery: 10,
	cellColor: '#484d55',
	sectionColor: '#77808d',
	/** 'auto' = the I4 camera-distance fade (no lerp), 'fixed' = a set radius */
	fadeMode: 'auto',
	fadeDistance: 400,
	fadeStrength: 1.5,
	/** infinite grid vs a finite patch of `size` units */
	infinite: true,
	size: 100,
	/**
	 * 16-Q2: what the grid centre tracks — 'off' (world origin), 'camera' (your
	 * position) or 'lookat' (where you are LOOKING: the orbit target). Always
	 * horizontal: the grid stays the ground plane at y=0 rather than lifting with
	 * the camera. The follow position snaps to whole cells so the lines keep
	 * agreeing with world coordinates instead of sliding under objects.
	 * (The old boolean `followCamera` migrates to 'lookat' — following your own
	 * position was what made it feel broken.)
	 */
	follow: 'off',
	/** local origin axes helper (X red / Y green / Z blue) */
	showAxes: false
};

function load() {
	try {
		const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
		// unknown/missing keys fall back to defaults, so old payloads keep working
		const stored = raw ? JSON.parse(raw) : {};
		const value = { ...DEFAULT_GRID, ...stored };
		// migrate the old boolean
		if (stored.followCamera !== undefined && stored.follow === undefined)
			value.follow = stored.followCamera ? 'lookat' : 'off';
		delete value.followCamera;
		return value;
	} catch {
		return { ...DEFAULT_GRID };
	}
}

/** @type {import('svelte/store').Writable<typeof DEFAULT_GRID>} */
export const gridSettings = writable(load());

gridSettings.subscribe((value) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(value));
});

/** @param {Partial<typeof DEFAULT_GRID>} patch */
export function setGrid(patch) {
	gridSettings.update((value) => ({ ...value, ...patch }));
}

export function resetGrid() {
	gridSettings.set({ ...DEFAULT_GRID });
}

/** The cell size actually drawn — pure, so the Grid component and the panel agree.
 * @param {typeof DEFAULT_GRID} settings @param {number} [snapTranslate] */
export function effectiveCell(settings, snapTranslate) {
	const step = snapTranslate ?? get(snapSettings).translate;
	const cell = settings.matchSnapStep ? step : settings.cellSize;
	return cell > 0 ? cell : 1;
}
