// 103 H7 — THE TRANSFORM GIZMO'S LOCAL PREFS AND STATE. A LEAF (svelte/store + safeStorage only): Scene,
// the bar buttons, the phone strip, Settings and objectActions read it, so it must not pull the styles in.
// Nothing here is replicated or saved in a scene: how the handles look is a fact about this person's
// device and hands, like the theme. What a drag DOES is unchanged in every style (same undo step, same
// `move` wire), so a peer never knows which style anyone uses.
//
//  gizmoStyle  'auto' (default)  B with a mouse or pen, C on touch (and in VR)
//              'A'               separate tools: today's three.js gizmo, one tool at a time
//              'B'               all in one: arrows + plane squares + rings + resize cubes + centre knob
//              'C'               touch puck: ground disc, lift arrow, turn ring, even-resize knob
//              'D'               box handles: corner resize, face push / pull, a turn arc, the size shown
//  gizmoSize   'S' | 'M' (default) | 'L'
//  gizmoHide   per style, the handle kinds switched off in Settings ("show only"): ./gizmoHide.js (lazy)
//
//  handleSet   row 8's triple switch: 'tool' = the active tool's handles, 'all' = all in one. The third
//              step (hidden) is the existing repeat-press exit (objectActions.setTransformMode), so it is
//              not a value here. Styles B / C / D start on 'all' (row 4: none lit = all handles); A starts
//              on 'tool' (today).
import { writable, derived, get } from 'svelte/store';
import { safeStorage } from '../safeStorage';

export const GIZMO_STYLES = ['auto', 'A', 'B', 'C', 'D'];
export const GIZMO_SIZES = ['S', 'M', 'L'];
/** the size factor per step (M = three's own default size) */
export const SIZE_FACTOR = { S: 0.8, M: 1, L: 1.3 };

/** @param {string} key @param {string} fallback @param {string[]} allowed */
function pref(key, fallback, allowed) {
	let initial = fallback;
	try {
		const raw = typeof localStorage !== 'undefined' ? safeStorage.getItem(key) : null;
		if (raw && allowed.includes(raw)) initial = raw;
	} catch {
		/* private mode: the default */
	}
	const store = writable(initial);
	store.subscribe((value) => {
		try {
			if (typeof localStorage === 'undefined') return;
			if (value === fallback) safeStorage.removeItem(key);
			else safeStorage.setItem(key, value);
		} catch {
			/* private mode */
		}
	});
	return store;
}

/** @type {import('svelte/store').Writable<string>} */
export const gizmoStyle = pref('gizmoStyle', 'auto', GIZMO_STYLES);
/** @type {import('svelte/store').Writable<string>} */
export const gizmoSize = pref('gizmoSize', 'M', GIZMO_SIZES);

// --- what kind of pointer this person uses now (Auto picks from it) ---
function coarseAtBoot() {
	try {
		return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
	} catch {
		return false;
	}
}
/** 'touch' once a finger pressed last, else 'mouse' (a pen counts as a mouse: it is precise) */
export const pointerKind = writable(coarseAtBoot() ? 'touch' : 'mouse');
if (typeof window !== 'undefined') {
	window.addEventListener(
		'pointerdown',
		(e) => {
			const kind = e.pointerType === 'touch' ? 'touch' : 'mouse';
			if (get(pointerKind) !== kind) pointerKind.set(kind);
		},
		{ capture: true, passive: true }
	);
}

/** the style in force: Auto resolved (VR is resolved by the VR driver itself: always C) */
export const activeGizmoStyle = derived([gizmoStyle, pointerKind], ([s, kind]) => (s === 'auto' ? (kind === 'touch' ? 'C' : 'B') : s));

/** row 8: which handles the active tool shows — 'tool' or 'all'. Set by setTransformMode / a style change. */
export const handleSet = writable(get(activeGizmoStyle) === 'A' ? 'tool' : 'all');
let lastStyle = get(activeGizmoStyle);
activeGizmoStyle.subscribe((s) => {
	// a style change starts that style's cycle where it starts (A: the tool; B, C, D: all in one)
	if (s === lastStyle) return;
	if ((s === 'A') !== (lastStyle === 'A')) handleSet.set(s === 'A' ? 'tool' : 'all');
	lastStyle = s;
});

/** the cycle's start for the style in force */
export function cycleStart() {
	return get(activeGizmoStyle) === 'A' ? 'tool' : 'all';
}

// a repeat press HID the gizmo (the cycle's third step): the press that brings the selection back
// lands on the tool's handles, where an ordinary new selection starts the style's cycle afresh
let backToTool = false;
export function noteHiddenByTool() {
	backToTool = true;
	handleSet.set('tool');
}
/** a selection appeared: start the cycle unless a tool press is bringing it back */
export function selectionAppeared() {
	if (backToTool) backToTool = false;
	else handleSet.set(cycleStart());
}
