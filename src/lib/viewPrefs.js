import { writable } from 'svelte/store';

// 18-A: viewport LINE colours — the wireframe view mode, the selection outline and
// the mesh-edit overlay. A LOCAL per-device view preference, never replicated and
// never serialized into a snapshot: the same family as gridSettings, themes and the
// cameraClip planes. Peers each pick their own; only scene CONTENT replicates.
//
// `editWireColor` keeps an 'auto' setting because the mesh-edit overlay CHOOSES its
// colour from the material's luminance (a fixed blue vanished on light materials).
// Overriding that is a preference; losing it would be a regression.
//
// W9 added `dockPushesViewport`, which is not a colour but is the same KIND of thing:
// how THIS screen draws the viewport, decided per device, stored locally, and of no
// interest to any peer. Deliberately not in appStore — a layout preference has no
// business in the panel-state store, and the key is additive, so the documented
// unknown-keys-fall-back-to-defaults rule migrates every existing payload for free.

const KEY = 'viewPrefs';

export const DEFAULT_VIEW_PREFS = {
	/** Shaded ▸ Wireframe view mode — the scene.overrideMaterial colour */
	wireColor: '#9aa4b0',
	/** selection outline (both the visible and the see-through edges) */
	outlineColor: '#353535',
	/** Edit Mesh overlay: 'auto' = pick from the material's luminance, else a hex */
	editWireColor: 'auto',
	/**
	 * W9 — does the bottom dock RESIZE the viewport (true, the DCC behaviour every
	 * editor uses: the canvas ends where the dock begins) or OVERLAY it (false, what
	 * this app did before: a full-window canvas with the dock drawn on top of it).
	 * Default true.
	 */
	dockPushesViewport: true
};

function load() {
	try {
		const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
		// unknown/missing keys fall back to defaults, so old payloads keep working
		const stored = raw ? JSON.parse(raw) : {};
		return { ...DEFAULT_VIEW_PREFS, ...stored };
	} catch {
		return { ...DEFAULT_VIEW_PREFS };
	}
}

/** @type {import('svelte/store').Writable<typeof DEFAULT_VIEW_PREFS>} */
export const viewPrefs = writable(load());

viewPrefs.subscribe((value) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(value));
});

/** @param {Partial<typeof DEFAULT_VIEW_PREFS>} patch */
export function setViewPrefs(patch) {
	viewPrefs.update((value) => ({ ...value, ...patch }));
}

export function resetViewPrefs() {
	viewPrefs.set({ ...DEFAULT_VIEW_PREFS });
}

/**
 * The Edit Mesh overlay colour, or null to mean "decide from the material" — pure,
 * so faceEdit and the settings panel agree on what 'auto' means.
 * @param {typeof DEFAULT_VIEW_PREFS} prefs
 * @returns {string | null}
 */
export function editWireOverride(prefs) {
	const value = prefs?.editWireColor;
	return !value || value === 'auto' ? null : value;
}
