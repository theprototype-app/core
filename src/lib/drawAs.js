// 103 H11 — "DRAW AS": how THIS device draws the viewport, beyond the three view modes (viewMode: shaded,
// shaded + AO, wireframe). A boot leaf (svelte/store + safeStorage): the materials and hooks are the lazy
// half (./drawAsRender.js), fetched only when someone picks a mode other than Normal.
//
// LOCAL, every bit of it: saved on this device (like viewMode), never sent, never in a scene file, never
// published to a watcher (lookPresence carries viewMode only — a watcher keeps their own look). Play always
// draws the normal look, and so do a headset and the Cinematic view (the lazy half reads `drawAsActive`).
//
// One choice at a time. Picking a view mode (the Preview menu, Configure scene ▸ View, the Z key) puts
// Draw as back to Normal, so the two never stack into something nobody picked.
import { writable, derived, get } from 'svelte/store';
import { safeStorage } from './safeStorage';
import { viewMode, isLocked, isVRMode } from '../stores/sceneStore';
import { cinematicState } from './cinematic/cinematicStore.js';

/** the modes beside viewMode's three, in menu order. `normal` = none of them. */
export const DRAW_AS = /** @type {const} */ (['normal', 'wire-over', 'ao-only', 'normals', 'uv-checker', 'weights']);
/** @typedef {typeof DRAW_AS[number]} DrawAs */

/** the labels the menu, the tooltip and the drawer print */
export const DRAW_AS_LABEL = /** @type {Record<string, string>} */ ({
	shaded: 'Shaded',
	'shaded-ao': 'Shaded + AO',
	wireframe: 'Wireframe',
	'wire-over': 'Wireframe over shaded',
	'ao-only': 'Ambient occlusion only',
	normals: 'Normals',
	'uv-checker': 'UV checker',
	weights: 'Weights'
});

/** one line each, for the menu rows' tooltips */
export const DRAW_AS_HINT = /** @type {Record<string, string>} */ ({
	shaded: 'The scene as it is lit',
	'shaded-ao': 'Lit, with soft contact shadows (ambient occlusion)',
	wireframe: 'Only the edges of every triangle',
	'wire-over': 'The lit scene with every triangle edge drawn on top',
	'ao-only': 'White clay with soft contact shadows: shapes without colour or texture',
	normals: 'Which way each surface faces, as colour',
	'uv-checker': 'A checker pattern through each model’s texture coordinates: stretching shows as uneven squares',
	weights: 'Skin weights: the selected bone’s influence from blue (none) to red (all); with no bone selected, each bone a colour'
});

const KEY = 'drawAs';
/** @param {any} v @returns {DrawAs} */
export const asDrawAs = (v) => (DRAW_AS.includes(v) ? v : 'normal');

/** the chosen mode (this device) @type {import('svelte/store').Writable<DrawAs>} */
export const drawAs = writable(asDrawAs(typeof localStorage === 'undefined' ? null : safeStorage.getItem(KEY)));
drawAs.subscribe((v) => {
	if (typeof localStorage === 'undefined') return;
	if (v === 'normal') safeStorage.removeItem(KEY);
	else safeStorage.setItem(KEY, v);
});

// a view mode picked anywhere (the menu, Configure scene ▸ View, Z) ends the Draw as mode
let lastMode = get(viewMode);
viewMode.subscribe((m) => {
	if (m === lastMode) return;
	lastMode = m;
	if (get(drawAs) !== 'normal') drawAs.set('normal');
});

/** the mode in force right now: Normal in Play, in a headset and while the Cinematic view draws */
export const drawAsActive = derived([drawAs, isLocked, isVRMode, cinematicState], ([$d, $locked, $vr, $cine]) =>
	$locked === true || $vr || ($cine?.mode && $cine.mode !== 'off') ? 'normal' : $d
);

/** the menu's one list: viewMode's three, then Draw as's own */
export const DRAW_ROWS = ['shaded', 'shaded-ao', 'wireframe', 'wire-over', 'ao-only', 'normals', 'uv-checker', 'weights'];

/** the row that reads checked @param {string} mode the viewMode @param {DrawAs} d */
export function drawRowOf(mode, d) {
	return d !== 'normal' ? d : mode;
}

/** a row other than the everyday look — the chevron's dot @param {string} row */
export const isUnusualRow = (row) => row !== 'shaded' && row !== 'shaded-ao';

/** pick a row: a view mode clears Draw as; a Draw as mode leaves wireframe (one override at a time) @param {string} row */
export function pickDrawRow(row) {
	if (row === 'shaded' || row === 'shaded-ao' || row === 'wireframe') {
		viewMode.set(row);
		drawAs.set('normal');
		return;
	}
	const d = asDrawAs(row);
	if (get(viewMode) === 'wireframe') viewMode.set('shaded'); // resets drawAs first, then:
	drawAs.set(d);
}

let started = false;
/** wire the lazy half in: it loads the first time a mode other than Normal is in force */
export function startDrawAs() {
	if (started || typeof window === 'undefined') return;
	started = true;
	/** @type {Promise<any> | null} */
	let half = null;
	drawAsActive.subscribe((d) => {
		if (d === 'normal' && !half) return;
		half ??= import('./drawAsRender.js').then((m) => (m.start(), m));
	});
}
