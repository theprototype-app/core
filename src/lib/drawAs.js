// 103 H11 — "DRAW AS": how THIS device draws the viewport, beyond the three view modes (viewMode: shaded,
// shaded + AO, wireframe). NOT on the boot: only the Preview pill / drawer import it, and the materials and
// hooks are a second lazy half (./drawAsRender.js), fetched only when someone picks a mode other than Normal.
//
// LOCAL and SESSION-ONLY (claude:9's Q8 ruling): never saved, so a reload — and a scene change — is back to
// the everyday look; only viewMode's three persist, as they always have. Nobody opens a white clay scene the
// next day and wonders where the colours went. Never sent, never in a scene file, never published to a
// watcher (lookPresence carries viewMode only). Play always draws the normal look, and so do a headset and
// the Cinematic view (the lazy half reads `drawAsActive`).
//
// One choice at a time. Picking a view mode (the Preview menu, Configure scene ▸ View, the Z key) puts
// Draw as back to Normal, so the two never stack into something nobody picked.
import { writable, derived, get } from 'svelte/store';
import { drawAsWantsAo } from './viewMode';
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

/** @param {any} v @returns {DrawAs} */
export const asDrawAs = (v) => (DRAW_AS.includes(v) ? v : 'normal');

/** the chosen mode (this device, this page only) @type {import('svelte/store').Writable<DrawAs>} */
export const drawAs = writable(/** @type {DrawAs} */ ('normal'));

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
// Ambient occlusion only asks Outline (boot) for the personal AO pass through a one-line flag in viewMode,
// so Outline never has to import this module
drawAsActive.subscribe((d) => drawAsWantsAo.set(d === 'ao-only'));

// a scene change (open, travel, New scene) ends the Draw as mode, like a reload. levels is already loaded
// by the boot's own lazy import, so this costs no extra fetch.
if (typeof window !== 'undefined')
	void import('./levels.js').then(({ currentLevel }) => {
		/** @type {string | null | undefined} */
		let was;
		currentLevel.subscribe((l) => {
			const id = l ? (l.hash || '') + '|' + (l.name || '') : null;
			if (was !== undefined && id !== was && get(drawAs) !== 'normal') drawAs.set('normal');
			was = id;
		});
	});

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

// the lazy half loads the first time a mode other than Normal is in force
if (typeof window !== 'undefined') {
	/** @type {Promise<any> | null} */
	let half = null;
	drawAsActive.subscribe((d) => {
		if (d === 'normal' && !half) return;
		half ??= import('./drawAsRender.js').then((m) => (m.start(), m));
	});
}
