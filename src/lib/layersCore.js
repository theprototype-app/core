// 102b-arrange row 2 — LAYERS, the schema half (a zero-import LEAF: scenePhysics, pickPass and the
// layer UI read it). The table lives in the scenePhysics singleton as `layers` (present only when
// authored, so a scene without layers is byte-identical) and an object names its layer in
// `userData.layer` (an id). Name, colour and lock are scene data (saved, replicated); HIDE is this
// screen's (layersRuntime.js), so one person tidying never blanks somebody else's view.

export const LAYERS_MAX = 64;
const HEX = /^#[0-9a-f]{6}$/i;
/** the colours a new layer takes in turn (colour-blind safe hues; the swatch is never the only cue) */
export const LAYER_COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#b07aa1', '#76b7b2', '#edc948', '#9c755f'];

/** @typedef {{id: string, name: string, color: string, locked?: true}} Layer */

/** One boundary for the table: bad rows dropped, names trimmed, at most LAYERS_MAX; null when empty.
 * @param {any} raw @returns {Layer[] | null} */
export function normalizeLayers(raw) {
	if (!Array.isArray(raw)) return null;
	/** @type {Layer[]} */
	const out = [];
	const seen = new Set();
	for (const r of raw) {
		if (!r || typeof r.id !== 'string' || !r.id || r.id.length > 64 || seen.has(r.id)) continue;
		seen.add(r.id);
		const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 60) : 'Layer';
		const color = typeof r.color === 'string' && HEX.test(r.color) ? r.color.toLowerCase() : LAYER_COLORS[out.length % LAYER_COLORS.length];
		out.push(r.locked === true ? { id: r.id, name, color, locked: true } : { id: r.id, name, color });
		if (out.length >= LAYERS_MAX) break;
	}
	return out.length ? out : null;
}

/** the ids of the locked layers @param {any} layers @returns {Set<string>} */
export function lockedLayerIds(layers) {
	return new Set((Array.isArray(layers) ? layers : []).filter((l) => l?.locked === true).map((l) => l.id));
}
