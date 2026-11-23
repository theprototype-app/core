// 92-input GC4: what a Character Controller's `camera` asks for, as data. A LEAF (imports nothing):
// flowRuntime, the node card and the agent tool all read it. See playViewSeam.js.

/** the cameras a Character Controller offers (`first` = no view: the code that was always there) */
export const PLAY_VIEWS = ['first', 'third', 'side', 'top'];

/** each view's tunables when the node does not say (metres / degrees). Shared with the node card
 * (`defaultsBy`), so the number a card shows is the number in force. */
export const PLAY_VIEW_DEFAULTS = {
	third: { distance: 4, height: 0.5, minZoom: 1.5, maxZoom: 10, collide: true },
	side: { distance: 12, height: 1, lookAhead: 2.5, minZoom: 5, maxZoom: 30 },
	top: { distance: 16, angle: 60, minZoom: 6, maxZoom: 40 }
};

/** @typedef {{camera: 'third'|'side'|'top', distance: number, height: number, lookAhead: number, angle: number, minZoom: number, maxZoom: number, collide: boolean}} PlayView */

/**
 * The view a Character Controller's data asks for, or null for first person. Pure.
 * @param {Record<string, any> | null | undefined} d @returns {PlayView | null}
 */
export function playViewSettings(d) {
	const camera = String(d?.camera ?? 'first');
	if (camera !== 'third' && camera !== 'side' && camera !== 'top') return null;
	/** @type {Record<string, any>} */
	const base = PLAY_VIEW_DEFAULTS[camera];
	const n = (/** @type {string} */ k, /** @type {number} */ lo, /** @type {number} */ hi, /** @type {number} */ dflt) => {
		const v = Number(d?.[k] ?? base[k] ?? dflt);
		return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;
	};
	const minZoom = n('minZoom', 0.5, 100, 2);
	const maxZoom = Math.max(minZoom, n('maxZoom', 0.5, 200, 30));
	return {
		camera,
		distance: Math.max(minZoom, Math.min(maxZoom, n('distance', 0.5, 200, 6))),
		height: n('height', -5, 20, 0.5),
		lookAhead: n('lookAhead', 0, 20, 0),
		angle: n('angle', 15, 90, 60),
		minZoom,
		maxZoom,
		collide: (d?.collide ?? base.collide ?? false) !== false
	};
}

