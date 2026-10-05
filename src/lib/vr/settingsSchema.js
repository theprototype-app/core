// VR controls — ONE LIST OF EVERY VR SETTING (36-vr, U3). The radial menu's Settings rings, the in-headset
// Settings panel and desktop Settings ▸ VR all render from this table, so a setting has ONE name, ONE icon,
// ONE place in the order and ONE write path (which also persists it under the key it always had). Adding a
// VR setting = one row here; every surface picks it up.
//
// Row kinds: 'toggle' (on/off) · 'choice' (one of `options`, cycled by a press) · 'range' (− / + by `step`)
// · 'action' (a button). `desktop: false` keeps a row out of desktop Settings (it lives elsewhere there),
// `vr: false` keeps it out of the headset. `keywords` feed the settings search (I4).
import { writable, derived, get } from 'svelte/store';
import {
	vrSnapAngle,
	vrMirrorSnapTurn,
	vrTeleportEnabled,
	vrFlying,
	vrMenuHand,
	vrMenuHold,
	vrGrabStyle,
	vrTargetHz,
	vrStatsOpen,
	peerHandStyle,
	vrPassthrough,
	vrWireframeSelection,
	vrVertexHold,
	vrSleeveEnabled,
	vrSettingsPanelOpen,
	isVRMode
} from '../../stores/sceneStore';
import { showToast } from '../../stores/appStore';
import { perfStatsShown } from '../fpsMeter';
import { vrMicMode, setMicMode } from '../voiceChat';
import { vrFaceCap } from '../faceEdit';
import { vrVertexCap } from '../meshEdit';
import { resetWindowPoses } from '../vrWindowPoses';
import { safeStorage } from '../safeStorage';
import { openVRKeyboard } from '../vrKeyboard';
import { renderer } from './core.js';
import { applyVRFrameRate } from './input.js';
import { vrSmoothTurn, vrSmoothTurnSpeed, vrComfortVignette, vrStance, vrHeightOffset, vrSnapAngleLast, clampHeight, SMOOTH_SPEEDS, SNAP_ANGLES, HEIGHT_LIMIT } from './prefs.js';
import { vrBindings, resetBindings, mirrorBindings, isLeftHanded, VR_ACTIONS, CONTROLS_FOR, bindingOf, setBinding, actionInfo, controlName } from './bindings.js';

/** @typedef {{value: any, label: string}} Option */
/**
 * @typedef {{id: string, page: string, label: string, icon: string, kind: 'toggle' | 'choice' | 'range' | 'action',
 *   get?: () => any, set?: (v: any) => void, run?: () => void, options?: Option[], min?: number, max?: number,
 *   step?: number, format?: (v: number) => string, keywords?: string[], note?: string, desktop?: boolean,
 *   vr?: boolean, tour?: string}} SettingRow
 */

/** the pages (= the radial's Settings sub-rings and the panel's tabs), in order */
export const VR_SETTING_PAGES = [
	{ id: 'comfort', label: 'Comfort', icon: 'heart-pulse', keywords: ['motion sickness', 'turn', 'vignette', 'teleport'] },
	{ id: 'body', label: 'Body', icon: 'person-standing', keywords: ['seated', 'standing', 'height', 'stance'] },
	{ id: 'controls', label: 'Controls', icon: 'gamepad-2', keywords: ['buttons', 'bindings', 'remap', 'hand', 'left-handed'] },
	{ id: 'display', label: 'Display', icon: 'monitor', keywords: ['refresh', 'fps', 'passthrough', 'hands'] },
	{ id: 'voice', label: 'Voice', icon: 'mic', keywords: ['microphone', 'push to talk'] },
	{ id: 'editing', label: 'Editing', icon: 'pencil', keywords: ['vertex', 'face', 'sleeve', 'mesh'] }
];

/** @param {any} store @param {string} key @param {any} value */
function put(store, key, value) {
	store.set(value);
	try {
		safeStorage.setItem(key, String(value));
	} catch {}
}
const cm = (/** @type {number} */ v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Math.round(v * 100)) + ' cm';

/** @type {SettingRow[]} */
export const VR_SETTINGS = [
	// ---- Comfort
	{
		id: 'turning',
		page: 'comfort',
		label: 'Turning',
		icon: 'rotate-cw',
		kind: 'choice',
		options: [
			{ value: 'snap', label: 'Snap' },
			{ value: 'smooth', label: 'Smooth' },
			{ value: 'off', label: 'Off' }
		],
		get: () => (get(vrSmoothTurn) ? 'smooth' : get(vrSnapAngle) ? 'snap' : 'off'),
		set: (v) => {
			put(vrSmoothTurn, 'vrSmoothTurn', v === 'smooth');
			if (v === 'off') put(vrSnapAngle, 'vrSnapAngle', 0);
			else if (!get(vrSnapAngle)) put(vrSnapAngle, 'vrSnapAngle', get(vrSnapAngleLast) || 45);
		},
		keywords: ['snap turn', 'smooth turn', 'rotation'],
		tour: 'settings-vr-turning'
	},
	{
		id: 'snapAngle',
		page: 'comfort',
		label: 'Snap angle',
		icon: 'rotate-ccw',
		kind: 'choice',
		options: SNAP_ANGLES.map((a) => ({ value: a, label: a + '°' })),
		get: () => get(vrSnapAngle) || get(vrSnapAngleLast) || 45,
		set: (v) => {
			const a = Number(v);
			vrSnapAngleLast.set(a);
			// a picked angle is a snap angle: it does not switch smooth turning off, but Off becomes Snap
			if (get(vrSnapAngle) || !get(vrSmoothTurn)) put(vrSnapAngle, 'vrSnapAngle', a);
		},
		keywords: ['snap turn', 'degrees', 'flick']
	},
	{
		id: 'smoothSpeed',
		page: 'comfort',
		label: 'Smooth speed',
		icon: 'gauge',
		kind: 'choice',
		options: SMOOTH_SPEEDS.map((d) => ({ value: d, label: d + '°/s' })),
		get: () => get(vrSmoothTurnSpeed),
		set: (v) => vrSmoothTurnSpeed.set(Number(v)),
		keywords: ['smooth turn', 'rotation speed']
	},
	{ id: 'mirror', page: 'comfort', label: 'Mirror turn', icon: 'arrow-left-right', kind: 'toggle', get: () => get(vrMirrorSnapTurn), set: (v) => put(vrMirrorSnapTurn, 'vrMirrorSnapTurn', !!v), keywords: ['invert', 'flip', 'snap turn'] },
	{ id: 'vignette', page: 'comfort', label: 'Comfort vignette', icon: 'scan-eye', kind: 'toggle', get: () => get(vrComfortVignette), set: (v) => vrComfortVignette.set(!!v), keywords: ['tunnel', 'motion sickness', 'blinders'], note: 'Darkens the edges while the stick moves or turns you' },
	{ id: 'teleport', page: 'comfort', label: 'Teleport', icon: 'footprints', kind: 'toggle', get: () => get(vrTeleportEnabled), set: (v) => put(vrTeleportEnabled, 'vrTeleportEnabled', !!v), keywords: ['arc', 'jump'], note: 'Push the teleport stick up to aim, let go to land' },
	{ id: 'flying', page: 'comfort', label: 'Flying', icon: 'move', kind: 'toggle', get: () => get(vrFlying), set: (v) => put(vrFlying, 'vrFlying', !!v), keywords: ['fly', 'free movement'], note: 'In Edit the move stick follows where that controller points' },
	// ---- Body
	{
		id: 'stance',
		page: 'body',
		label: 'Stance',
		icon: 'armchair',
		kind: 'choice',
		options: [
			{ value: 'standing', label: 'Standing' },
			{ value: 'seated', label: 'Seated' }
		],
		get: () => get(vrStance),
		set: (v) => vrStance.set(v === 'seated' ? 'seated' : 'standing'),
		keywords: ['seated', 'sitting', 'standing', 'chair', 'wheelchair'],
		note: 'Seated lifts your view to a standing eye height',
		tour: 'settings-vr-stance'
	},
	{
		id: 'height',
		page: 'body',
		label: 'Height',
		icon: 'ruler',
		kind: 'range',
		min: -HEIGHT_LIMIT,
		max: HEIGHT_LIMIT,
		step: 0.05,
		format: cm,
		get: () => get(vrHeightOffset),
		set: (v) => vrHeightOffset.set(clampHeight(Number(v))),
		keywords: ['eye height', 'offset', 'tall', 'short', 'floor']
	},
	{ id: 'heightReset', page: 'body', label: 'Reset height', icon: 'rotate-ccw', kind: 'action', run: () => vrHeightOffset.set(0), desktop: false },
	// ---- Controls
	{
		id: 'menuHand',
		page: 'controls',
		label: 'Menu hand',
		icon: 'hand',
		kind: 'choice',
		options: [
			{ value: 'right', label: 'Right' },
			{ value: 'left', label: 'Left' }
		],
		get: () => get(vrMenuHand),
		set: (v) => {
			// vrMenuHand is the menu binding's truth: the bindings follow (and keep Edit/Interact clear of it)
			vrMenuHand.set(v === 'left' ? 'left' : 'right');
			try {
				safeStorage.setItem('vrMenuHand', v === 'left' ? 'left' : 'right');
			} catch {}
		},
		keywords: ['radial', 'quick menu', 'handedness'],
		note: 'Which controller opens the radial menu; the other one points'
	},
	{ id: 'menuHold', page: 'controls', label: 'Hold to open menu', icon: 'circle-dot', kind: 'toggle', get: () => get(vrMenuHold), set: (v) => put(vrMenuHold, 'vrMenuHold', !!v), keywords: ['radial', 'press and hold'], note: 'Hold the menu button, release over a sector to pick it' },
	{ id: 'leftHanded', page: 'controls', label: 'Left-handed', icon: 'arrow-left-right', kind: 'toggle', get: () => isLeftHanded(), set: (v) => v !== isLeftHanded() && mirrorBindings(), keywords: ['handedness', 'mirror', 'swap hands'], note: 'Mirrors every button to the other hand' },
	{
		id: 'grabStyle',
		page: 'controls',
		label: 'Grab style',
		icon: 'hand',
		kind: 'choice',
		options: [
			{ value: 'rigid', label: 'Rigid' },
			{ value: 'move', label: 'Move only' },
			{ value: 'rotate', label: 'Rotate only' }
		],
		get: () => get(vrGrabStyle),
		set: (v) => put(vrGrabStyle, 'vrGrabStyle', v),
		keywords: ['grip', 'hold'],
		note: 'Rigid: the controller is the handle (the stick reels and scales)'
	},
	{ id: 'remap', page: 'controls', label: 'Remap buttons', icon: 'keyboard', kind: 'action', run: () => openVRSettingsPage('buttons'), desktop: false },
	{ id: 'bindingsReset', page: 'controls', label: 'Reset buttons', icon: 'refresh-cw', kind: 'action', run: () => (resetBindings(), showToast('VR buttons reset to the defaults')), desktop: false },
	// ---- Display
	{
		id: 'refresh',
		page: 'display',
		label: 'Refresh rate',
		icon: 'zap',
		kind: 'choice',
		options: [
			{ value: 'auto', label: 'Max' },
			{ value: '90', label: '90 Hz' },
			{ value: '120', label: '120 Hz' }
		],
		get: () => get(vrTargetHz),
		set: (v) => {
			vrTargetHz.set(String(v));
			applyVRFrameRate();
		},
		keywords: ['hz', 'frame rate', '120'],
		note: '120 Hz needs the headset’s own 120 Hz setting'
	},
	{ id: 'fps', page: 'display', label: 'FPS and draw calls', icon: 'activity', kind: 'toggle', get: () => get(perfStatsShown), set: (v) => perfStatsShown.set(!!v), keywords: ['performance', 'frames'], desktop: false },
	{ id: 'stats', page: 'display', label: 'Statistics card', icon: 'chart-bar', kind: 'toggle', get: () => get(vrStatsOpen), set: (v) => put(vrStatsOpen, 'vrStats', !!v), keywords: ['stats', 'peers', 'network'], note: 'A card on the other hand: peers, objects, network' },
	{
		id: 'peerHands',
		page: 'display',
		label: 'Peer hands',
		icon: 'hand',
		kind: 'choice',
		options: [
			{ value: 'model', label: 'Model' },
			{ value: 'hands', label: 'Hands' },
			{ value: 'spheres', label: 'Spheres' }
		],
		get: () => get(peerHandStyle),
		set: (v) => peerHandStyle.set(v),
		keywords: ['hand tracking', 'avatars'],
		note: 'How hand-tracked peers look to you'
	},
	{
		id: 'passthrough',
		page: 'display',
		label: 'Passthrough',
		icon: 'eye',
		kind: 'toggle',
		get: () => get(vrPassthrough),
		set: (v) => {
			put(vrPassthrough, 'vrPassthrough', !!v);
			showToast('Passthrough ' + (v ? 'on' : 'off') + ' — takes effect on the next VR entry');
		},
		keywords: ['mixed reality', 'ar', 'camera'],
		note: 'Mixed reality — applies on the next VR entry'
	},
	{ id: 'wireframe', page: 'display', label: 'Selection wireframe', icon: 'box', kind: 'toggle', get: () => get(vrWireframeSelection), set: (v) => put(vrWireframeSelection, 'vrWireframe', !!v), keywords: ['outline', 'highlight'], note: 'Draws a wireframe over what you select' },
	{ id: 'resetPanels', page: 'display', label: 'Reset panel positions', icon: 'layers', kind: 'action', run: () => (resetWindowPoses(), showToast('VR panel positions reset')), keywords: ['windows', 'menus'], note: 'Panels you moved go back to their spots on the controllers' },
	// ---- Voice
	{
		id: 'mic',
		page: 'voice',
		label: 'Microphone',
		icon: 'mic',
		kind: 'choice',
		options: [
			{ value: 'ptt', label: 'Push to talk' },
			{ value: 'open', label: 'Open' },
			{ value: 'off', label: 'Off' }
		],
		get: () => get(vrMicMode),
		set: (v) => void setMicMode(v),
		keywords: ['voice', 'talk', 'mute'],
		desktop: false
	},
	// ---- Editing
	{ id: 'vertexHold', page: 'editing', label: 'Hold to move vertex', icon: 'mouse-pointer-2', kind: 'toggle', get: () => get(vrVertexHold), set: (v) => put(vrVertexHold, 'vrVertexHold', !!v), keywords: ['mesh', 'vertex', 'trigger'], note: 'Off: press to pick a vertex up, press again to drop it' },
	{ id: 'sleeve', page: 'editing', label: 'Sleeve palette', icon: 'package', kind: 'toggle', get: () => get(vrSleeveEnabled), set: (v) => put(vrSleeveEnabled, 'vrSleeveEnabled', !!v), keywords: ['forearm', 'primitives', 'experimental'], note: 'Experimental: drag shapes off a strip on your forearm' },
	{
		id: 'faceCap',
		page: 'editing',
		label: 'Face edit limit',
		icon: 'shapes',
		kind: 'choice',
		options: [500, 1000, 2500, 5000, 10000].map((n) => ({ value: n, label: n + ' tris' })),
		get: () => get(vrFaceCap),
		set: (v) => vrFaceCap.set(Number(v)),
		keywords: ['mesh', 'triangles', 'cap']
	},
	{
		id: 'vertexCap',
		page: 'editing',
		label: 'Vertex edit limit',
		icon: 'grid-3x3',
		kind: 'choice',
		options: [200, 400, 800, 1600, 3200].map((n) => ({ value: n, label: n + ' verts' })),
		get: () => get(vrVertexCap),
		set: (v) => vrVertexCap.set(Number(v)),
		keywords: ['mesh', 'vertices', 'cap']
	}
];
const ROW = new Map(VR_SETTINGS.map((r) => [r.id, r]));

/** @param {string} id */
export function vrSettingRow(id) {
	return ROW.get(id) ?? null;
}
/** the rows of a page, in order (VR surfaces) @param {string} page */
export function vrSettingsOf(page) {
	return VR_SETTINGS.filter((r) => r.page === page && r.vr !== false);
}

/** "Smooth", "On", "+10 cm" — the row's current value as text @param {SettingRow} row */
export function settingValueText(row) {
	const v = row.get?.();
	if (row.kind === 'toggle') return v ? 'On' : 'Off';
	if (row.kind === 'range') return row.format ? row.format(Number(v)) : String(v);
	if (row.kind === 'choice') {
		const hit = row.options?.find((o) => String(o.value) === String(v));
		return hit ? hit.label : String(v ?? '');
	}
	return '';
}
/** a CUSTOM value (typed on desktop, e.g. a 1200 face cap) still cycles from the nearest option */
function optionIndex(/** @type {SettingRow} */ row) {
	const opts = row.options ?? [];
	const v = row.get?.();
	const i = opts.findIndex((o) => String(o.value) === String(v));
	if (i >= 0) return i;
	if (typeof v === 'number') {
		let best = 0;
		opts.forEach((o, k) => {
			if (Math.abs(Number(o.value) - v) < Math.abs(Number(opts[best].value) - v)) best = k;
		});
		return best;
	}
	return 0;
}

/**
 * Press a row: a toggle flips, a choice moves to the next option (wrapping), a range steps by
 * `dir * step`, an action runs. The one write path every VR surface uses.
 * @param {string} id @param {number} [dir] +1 / −1
 */
export function activateVRSetting(id, dir = 1) {
	const row = ROW.get(id);
	if (!row) return false;
	if (row.kind === 'toggle') row.set?.(!row.get?.());
	else if (row.kind === 'choice') {
		const opts = row.options ?? [];
		if (!opts.length) return false;
		const next = (optionIndex(row) + (dir < 0 ? opts.length - 1 : 1)) % opts.length;
		row.set?.(opts[next].value);
	} else if (row.kind === 'range') {
		const step = row.step ?? 0.05;
		const v = Number(row.get?.()) || 0;
		row.set?.(Math.max(row.min ?? -Infinity, Math.min(row.max ?? Infinity, v + (dir < 0 ? -step : step))));
	} else row.run?.();
	vrSettingsTick.update((n) => n + 1);
	return true;
}

/** bumps whenever any VR setting changes (a dependency for the radial's live labels and the panels) */
export const vrSettingsTick = writable(0);
/** 36-vr-ai (B9): what the in-headset Search page filters by (typed on the VR keyboard) */
export const vrSettingsQuery = writable('');
const watched = [vrSnapAngle, vrMirrorSnapTurn, vrTeleportEnabled, vrFlying, vrMenuHand, vrMenuHold, vrGrabStyle, vrTargetHz, vrStatsOpen, peerHandStyle, vrPassthrough, vrWireframeSelection, vrVertexHold, vrSleeveEnabled, perfStatsShown, vrMicMode, vrFaceCap, vrVertexCap, vrSmoothTurn, vrSmoothTurnSpeed, vrComfortVignette, vrStance, vrHeightOffset, vrBindings, vrSettingsQuery];
/** one derived over every watched store: any change re-renders whatever shows a setting */
let version = 0;
export const vrSettingsVersion = derived([vrSettingsTick, ...watched], () => ++version);

/** the page the in-headset Settings panel shows ('comfort' … 'editing', or 'buttons' = the remap table) */
export const vrSettingsPage = writable('comfort');
/** open the in-headset Settings panel on a page @param {string} page */
export function openVRSettingsPage(page) {
	vrSettingsPage.set(page);
	vrSettingsPanelOpen.set(true);
}

/** is a headset session up (the panel's Exit VR row) */
export function vrPresenting() {
	return !!renderer?.xr?.isPresenting || get(isVRMode);
}

/** desktop/search: every keyword of the VR section (labels included) */
export function vrSettingsKeywords() {
	const out = new Set(['vr', 'virtual reality', 'headset', 'quest']);
	for (const p of VR_SETTING_PAGES) {
		out.add(p.label.toLowerCase());
		for (const k of p.keywords) out.add(k);
	}
	for (const r of VR_SETTINGS) {
		out.add(r.label.toLowerCase());
		for (const k of r.keywords ?? []) out.add(k);
	}
	return [...out];
}

// ---- the in-headset BUTTONS page (plan 55.2 in VR) ------------------------------------------------
/** the row the Settings panel's stick cursor is on */
export const vrSettingsCursor = writable(0);
/** a remap press that hit a conflict: the NEXT press on the same row swaps @type {import('svelte/store').Writable<{action: string, want: {hand: any, control: any}, other: string, at: number} | null>} */
export const vrRemapPending = writable(null);
const PENDING_MS = 6000;

/** every {hand, control} an action may be bound to, the current hand first @param {string} id */
export function bindingOptions(id) {
	const info = actionInfo(id);
	if (!info || info.kind === 'locked') return [];
	const cur = bindingOf(id);
	const hands = cur.hand === 'left' ? ['left', 'right'] : ['right', 'left'];
	/** @type {{hand: any, control: any}[]} */
	const out = [];
	for (const hand of hands) for (const control of CONTROLS_FOR[info.kind]) out.push({ hand, control });
	return out;
}

/** the action's label, e.g. "Talk / jump" @param {string} id */
export function actionLabel(id) {
	return actionInfo(id)?.label ?? id;
}

/**
 * Press a Buttons-page row: the action moves to its next possible control. A conflict does nothing
 * yet and arms a swap — the row says so, and a second press within a few seconds swaps the two.
 * @param {string} id @returns {{ok: boolean, conflict?: string, swapped?: string}}
 */
export function cycleBinding(id) {
	const pending = get(vrRemapPending);
	if (pending && pending.action === id && Date.now() - pending.at < PENDING_MS) {
		const r = setBinding(id, pending.want, { swap: true });
		vrRemapPending.set(null);
		if (r.ok && r.swapped)
			showToast(
				actionLabel(id) + ' → ' + controlName(pending.want.hand, pending.want.control) + ' · ' +
					r.swapped.split(',').map(actionLabel).join(', ') + ' moved to make room'
			);
		vrSettingsTick.update((n) => n + 1);
		return r;
	}
	const opts = bindingOptions(id);
	if (!opts.length) return { ok: false };
	const cur = bindingOf(id);
	const at = opts.findIndex((o) => o.hand === cur.hand && o.control === cur.control);
	const next = opts[(at + 1) % opts.length];
	const r = setBinding(id, next);
	vrRemapPending.set(!r.ok && r.conflict ? { action: id, want: next, other: r.conflict, at: Date.now() } : null);
	vrSettingsTick.update((n) => n + 1);
	return r;
}

/** the Buttons page rows (every action, locked ones included so the table is complete) */
export function bindingRows() {
	return VR_ACTIONS.map((a) => ({ id: a.id, label: a.label, locked: a.kind === 'locked', doc: a.doc }));
}

/** the page tabs the in-headset panel shows: the settings pages + Buttons (the remap table) + Search (B9) */
export const VR_PANEL_TABS = [
	...VR_SETTING_PAGES.filter((p) => p.id !== 'voice'),
	{ id: 'buttons', label: 'Buttons', icon: 'keyboard', keywords: [] },
	{ id: 'search', label: 'Search', icon: 'search', keywords: [] }
];

/**
 * 36-vr-ai (B9): the VR settings a query finds — every word must appear in the row's label, its keywords or
 * its page's name ("turn" finds Turning, Snap angle, Smooth speed and Mirror turn but not Teleport; "comfort
 * vignette" the vignette). The page's own keywords do NOT count: they would match every row on it. Empty = none.
 * @param {string} query @returns {SettingRow[]}
 */
export function searchVRSettings(query) {
	const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return [];
	return VR_SETTINGS.filter((r) => {
		if (r.vr === false || r.id === 'heightReset') return false;
		const page = VR_SETTING_PAGES.find((p) => p.id === r.page);
		const text = [r.label, ...(r.keywords ?? []), page?.label ?? ''].join(' ').toLowerCase();
		return words.every((w) => text.includes(w));
	});
}

/** B9: type the search on the VR keyboard — the results follow every key; Esc puts the old query back */
export function openVRSettingsSearch() {
	const before = get(vrSettingsQuery);
	vrSettingsPage.set('search');
	openVRKeyboard({
		title: 'Search settings',
		initial: before,
		onInput: (text) => vrSettingsQuery.set(text),
		onCommit: (text) => vrSettingsQuery.set(text.trim()),
		onCancel: () => vrSettingsQuery.set(before)
	});
}

/**
 * The panel's rows for a page, top to bottom — what it draws and what the stick cursor walks. Row 0 is
 * always the tab strip (left/right on it changes page); the last two are Back and Close.
 * @param {string} page
 * @returns {{action: string, kind: string, rowId?: string, label: string}[]}
 */
export function settingsPanelRows(page) {
	/** @type {{action: string, kind: string, rowId?: string, label: string}[]} */
	const rows = [{ action: 'tabs', kind: 'tabs', label: 'Pages' }];
	if (page === 'search') {
		const query = get(vrSettingsQuery).trim();
		rows.push({ action: 'vrset:search', kind: 'search', label: query ? 'Search: ' + query : 'Type to search…' });
		const found = searchVRSettings(query);
		for (const r of found) rows.push({ action: 'vrset:' + r.id, kind: r.kind, rowId: r.id, label: r.label });
		if (query && !found.length) rows.push({ action: '', kind: 'locked', label: 'No VR setting matches' });
	} else if (page === 'buttons') {
		for (const b of bindingRows()) rows.push({ action: b.locked ? '' : 'vrbind:' + b.id, kind: b.locked ? 'locked' : 'binding', rowId: b.id, label: b.label });
		rows.push({ action: 'vrset:leftHanded', kind: 'toggle', rowId: 'leftHanded', label: 'Left-handed' });
		rows.push({ action: 'vrset:bindingsReset', kind: 'action', rowId: 'bindingsReset', label: 'Reset buttons' });
	} else {
		for (const r of vrSettingsOf(page)) {
			if (r.id === 'heightReset' || r.id === 'bindingsReset') continue; // a range carries its own reset; Buttons has its own
			rows.push({ action: 'vrset:' + r.id, kind: r.kind, rowId: r.id, label: r.label });
		}
		// Voice has no tab: its one row rides on Display
		if (page === 'display') {
			const mic = vrSettingRow('mic');
			if (mic) rows.push({ action: 'vrset:mic', kind: mic.kind, rowId: 'mic', label: mic.label });
		}
	}
	rows.push({ action: 'vrset:back', kind: 'nav', label: 'Back to menu' });
	rows.push({ action: 'vrset:close', kind: 'nav', label: 'Close' });
	return rows;
}

/** the tab left / right of `page` @param {string} page @param {number} dir */
export function neighbourTab(page, dir) {
	const i = Math.max(0, VR_PANEL_TABS.findIndex((t) => t.id === page));
	return VR_PANEL_TABS[(i + (dir < 0 ? VR_PANEL_TABS.length - 1 : 1)) % VR_PANEL_TABS.length].id;
}
