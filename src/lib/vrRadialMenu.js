import { writable, get } from 'svelte/store';
import {
	vrMenuOpen,
	showGrid,
	selectedObject,
	vrWireframeSelection,
	vrEditMenuOpen,
	vrSnapMenuOpen,
	vrToolMode
} from '../stores/sceneStore';
import { environment, setEnvironment, ENVIRONMENT_PRESETS } from './environment';
import { simulating, remoteSimulating, toggleSimulation } from './physics';
import { setMicMode, vrMicMode } from './voiceChat';
import { duplicateSelection, deleteSelection, groupSelection, selectionUuids } from './objectActions';
import { savePrefab, savePrefabSelection } from './prefabs';
import { perfContext } from './perf/perfMarks.js'; // 34 PF: an import-free leaf
import { vrDollhouseOpen, vrSculptActive } from './vr/worldStores.js'; // 37: a leaf
import { sculptOp } from './terrainSculpt';

// D4 (roadmap 13): selection-set helpers for the Edit ring — counted labels
// act on the whole SET (parity with the desktop object menu, U-2)
function selCount() {
	return selectionUuids().length;
}
/** 57.4: does the lone selection carry a spline record? */
function isSplineSelection() {
	const object = /** @type {any} */ (get(selectedObject));
	return !!object?.userData?.spline?.points?.length;
}
/** 37 R9: is the lone selection a Terrain (its Selected ring offers Sculpt terrain instead of Edit mesh)? */
function isTerrainSelection() {
	return !!(/** @type {any} */ (get(selectedObject))?.userData?.terrain);
}
function countSuffix() {
	const n = selCount();
	return n > 1 ? ` (${n})` : '';
}

// VR radial menu v2 (74): a flat 8-sector base ring with nested sub-rings.
// Entries live in a registry so modules and later phases can add their own
// (registerVRMenuEntry, exposed through the module SDK). vrControls owns the
// input side (hover ray/stick, activation, haptics); VRMenu.svelte renders
// whatever ring is active. Sector-hit math is pure and exported for tests.

// ---- ring geometry constants (meters, menu-local) ----
// 99: ~50% smaller than v2 — the ring rides ON the controller now. 36: a little wider (0.105 -> 0.12 m)
// so a sector holds an icon AND a two-line label that stays readable (the labels used to collide)
export const RING_INNER = 0.028;
export const RING_OUTER = 0.12;
export const HUB_RADIUS = 0.024;
const SECTOR_GAP = 0.05; // radians trimmed off each sector edge

// controller anchoring (99): the ring's center sits at the thumbstick and the
// ring lies in the top-button plane, tilted back from the grip axis
const ANCHOR_OFFSET = [0, 0.014, -0.05];
const ANCHOR_TILT_X = -Math.PI * 0.3; // ~-54° — matches a resting controller top

/**
 * World pose for the menu given the menu-hand controller pose (99). Pure —
 * the caller feeds THREE vectors/quaternions; tested headlessly.
 * @param {any} THREE_NS three namespace @param {any} controllerPos @param {any} controllerQuat
 */
export function menuPoseFromController(THREE_NS, controllerPos, controllerQuat) {
	const offset = new THREE_NS.Vector3(...ANCHOR_OFFSET).applyQuaternion(controllerQuat);
	const tilt = new THREE_NS.Quaternion().setFromAxisAngle(
		new THREE_NS.Vector3(1, 0, 0),
		ANCHOR_TILT_X
	);
	return {
		position: controllerPos.clone().add(offset),
		quaternion: controllerQuat.clone().multiply(tilt)
	};
}

/** 36 (R11): the last activated sector + when — VRMenu flashes it @type {import('svelte/store').Writable<{id: string, at: number}>} */
export const vrMenuPressed = writable({ id: '', at: 0 });

/** the ring currently shown: 'root' or a sub-ring group name */
export const activeRing = writable('root');
/** bumps whenever the registry changes so the menu re-derives */
export const ringVersion = writable(0);

// navigation STACK (109): rings can nest (System ▸ Mic ▸) — Back pops one
// level instead of teleporting to root
let ringStack = ['root'];
/** @param {string} ring */
export function pushRing(ring) {
	ringStack.push(ring);
	activeRing.set(ring);
}
export function popRing() {
	if (ringStack.length > 1) ringStack.pop();
	activeRing.set(ringStack[ringStack.length - 1]);
}
export function resetRings() {
	ringStack = ['root'];
	activeRing.set('root');
}

/** @type {Map<string, any[]>} group -> entries */
const registry = new Map();

/** 36: the old System ring became Settings — an entry a module still files under 'system' lands there */
const GROUP_ALIASES = /** @type {Record<string, string>} */ ({ system: 'settings' });

/**
 * Register (or replace, by id) a radial menu entry.
 * @param {{id: string, group?: string, label: string | (() => string), order?: number,
 *   ring?: string, action?: () => void, active?: () => boolean,
 *   color?: string, closes?: boolean, visible?: () => boolean,
 *   disabled?: () => boolean, icon?: string | (() => string), value?: () => string}} entry
 * `ring` makes it a navigation sector into that sub-ring; `color` renders the
 * sector as a swatch; `closes` closes the menu after the action runs;
 * `disabled` greys the sector out and blocks activation (D4). 36: `icon` = a lucide name (the
 * desktop menu's icon for the same command, drawn above the label); `value` = a second, smaller
 * line (a setting's current value).
 */
export function registerVRMenuEntry(entry) {
	const group = GROUP_ALIASES[entry.group ?? 'root'] ?? entry.group ?? 'root';
	let list = registry.get(group);
	if (!list) {
		list = [];
		registry.set(group, list);
	}
	const existing = list.findIndex((e) => e.id === entry.id);
	if (existing >= 0) list[existing] = entry;
	else list.push(entry);
	ringVersion.update((v) => v + 1);
}

/**
 * Remove a registered entry (A2: module teardown for the dev-mode reload).
 * @param {string} id the FULL id as registered (module entries carry the
 * `moduleId:` prefix the SDK adds) @param {string=} group
 */
export function unregisterVRMenuEntry(id, group = 'root') {
	const list = registry.get(GROUP_ALIASES[group] ?? group);
	if (!list) return;
	const index = list.findIndex((e) => e.id === id);
	if (index < 0) return;
	list.splice(index, 1);
	ringVersion.update((v) => v + 1);
}

/**
 * Entries of a ring, in order, minus any whose `visible()` predicate is false.
 * @param {string} group
 */
export function ringEntries(group) {
	return [...(registry.get(group) ?? [])]
		.filter((e) => (e.visible ? e.visible() : true))
		.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** Find an entry by id across all rings @param {string} id */
export function findMenuEntry(id) {
	for (const list of registry.values()) {
		const entry = list.find((e) => e.id === id);
		if (entry) return entry;
	}
	return null;
}

/** The stats card rides the hand OPPOSITE the menu hand (102) @param {string} menuHand */
export function statsHand(menuHand) {
	return menuHand === 'right' ? 'left' : 'right';
}

/**
 * The center hub doubles as Close (base ring), Edit ▸ (base ring with a
 * selection — renamed from 'Object' in 109, it read too close to 'Objects')
 * or Back (sub-rings).
 * @param {string} ring @param {boolean} hasSelection
 */
export function hubEntry(ring, hasSelection) {
	if (ring !== 'root') return { id: 'back', label: 'Back', icon: 'arrow-left' };
	// 36: "Selected" — the desktop viewport menu's name for what acts on the selection
	if (hasSelection) return { id: 'nav:object', label: 'Selected', icon: 'box' };
	return { id: 'close', label: 'Close', icon: 'x' };
}

/** 36: a sector id that moves through the rings (a ▸ sector or the Back hub) rather than acting @param {string} id */
export function isRingNav(id) {
	return id.startsWith('nav:') || id === 'back';
}

/** 36: the title shown under the hub for each ring (the label of the sector that opens it) @param {string} ring */
export function ringTitle(ring) {
	if (ring === 'root') return '';
	if (ring === 'object') return 'Selected';
	if (ring === 'sculpt') return 'Sculpt terrain'; // 37 R9: opened by a session, not a ▸ sector
	for (const list of registry.values()) {
		const opener = list.find((e) => e.ring === ring);
		if (opener) return typeof opener.label === 'function' ? opener.label() : opener.label;
	}
	return ring;
}

/** 36 (T1): the stable tour id of a radial entry — `radial:<id>` (the hub is `radial:hub`) @param {string} id */
export function radialTourId(id) {
	return 'radial:' + id;
}

/** 36: the label / icon of an entry as text (they may be functions) @param {any} entry */
export function entryLabel(entry) {
	return typeof entry?.label === 'function' ? entry.label() : (entry?.label ?? '');
}
/** @param {any} entry */
export function entryIcon(entry) {
	return typeof entry?.icon === 'function' ? entry.icon() : (entry?.icon ?? null);
}

/**
 * Which sector a menu-local point hits. Sector 0 is centered at 12 o'clock,
 * counting clockwise. Returns an index, 'hub' inside the center, or null.
 * @param {number} x @param {number} y @param {number} count
 */
export function sectorFromPoint(x, y, count, inner = RING_INNER, outer = RING_OUTER) {
	const r = Math.hypot(x, y);
	if (r <= HUB_RADIUS) return 'hub';
	if (r < inner || r > outer || count <= 0) return null;
	// atan2(x, y) is 0 at 12 o'clock and grows clockwise (for y-up coords)
	let angle = Math.atan2(x, y);
	if (angle < 0) angle += Math.PI * 2;
	const step = (Math.PI * 2) / count;
	return Math.floor(((angle + step / 2) % (Math.PI * 2)) / step);
}

/**
 * Thumbstick deflection -> sector (74.1). xr-standard sticks report +y as
 * DOWN, so the y axis flips. Returns null inside the deadzone.
 * @param {number} x @param {number} y @param {number} count
 */
export function sectorFromStick(x, y, count, deadzone = 0.5) {
	if (Math.hypot(x, y) < deadzone || count <= 0) return null;
	let angle = Math.atan2(x, -y);
	if (angle < 0) angle += Math.PI * 2;
	const step = (Math.PI * 2) / count;
	return Math.floor(((angle + step / 2) % (Math.PI * 2)) / step);
}

/**
 * Render layout of sector i of n: THREE.RingGeometry theta window (measured
 * counter-clockwise from +X) plus the label centroid.
 * @param {number} i @param {number} count
 */
export function sectorLayout(i, count) {
	const step = (Math.PI * 2) / count;
	// sector centered at 12 o'clock minus i steps (clockwise)
	const center = Math.PI / 2 - i * step;
	const rMid = (RING_INNER + RING_OUTER) / 2;
	return {
		thetaStart: center - step / 2 + SECTOR_GAP / 2,
		thetaLength: step - SECTOR_GAP,
		labelX: Math.cos(center) * rMid,
		labelY: Math.sin(center) * rMid
	};
}

// ---- built-in rings ----
// 36 (U3): THE RING RULES. Root = categories + the four things used every minute (undo, redo, chat,
// objects); a ▸ sector opens a ring; a ring's sectors ACT (or open one more ring of choices) — so every
// entry, every VR setting included, is at most two levels deep, and the hub is always Back (or Close /
// Selected on the root). Names, icons and order follow the desktop menus: the viewport menu (Add, Undo,
// Redo, Ping), the object menu (Duplicate · Group · Properties · Edit mesh · Save · Delete LAST), the
// burger menu (Settings), Tools (Draw mode, Simulate physics). The Settings rings are built from the one
// settings table (vr/settingsSchema.js) by vr/settingsRings.js.

function registerBuiltins() {
	// base ring (8 sectors, clockwise from 12): Undo sits LEFT of Redo, the desktop menu's reading order
	registerVRMenuEntry({ id: 'objects', label: 'Objects', icon: 'list', order: 0 });
	registerVRMenuEntry({ id: 'nav:add', label: 'Add', icon: 'plus', order: 1, ring: 'add' });
	registerVRMenuEntry({ id: 'nav:scene', label: 'Scene', icon: 'sliders-horizontal', order: 2, ring: 'scene' });
	registerVRMenuEntry({ id: 'nav:tools', label: 'Tools', icon: 'wrench', order: 3, ring: 'tools' });
	registerVRMenuEntry({ id: 'redo', label: 'Redo', icon: 'redo-2', order: 4 });
	registerVRMenuEntry({ id: 'undo', label: 'Undo', icon: 'undo-2', order: 5 });
	registerVRMenuEntry({ id: 'chat', label: 'Chat', icon: 'message-square', order: 6 });
	registerVRMenuEntry({ id: 'nav:settings', label: 'Settings', icon: 'settings', order: 7, ring: 'settings' });

	// Tools ▸ (214 + 36) — the trigger tool mode, Ping, the simulation (desktop: Tools ▸ Simulate physics)
	// and the profiler
	registerVRMenuEntry({ id: 'tool:select', group: 'tools', label: 'Select', icon: 'mouse-pointer-2', order: 0, active: () => get(vrToolMode) === 'select' });
	registerVRMenuEntry({ id: 'tool:box', group: 'tools', label: 'Box select', icon: 'square-dashed', order: 1, active: () => get(vrToolMode) === 'box' });
	registerVRMenuEntry({ id: 'tool:draw', group: 'tools', label: 'Draw mode', icon: 'pen-tool', order: 2, active: () => get(vrToolMode) === 'draw' });
	// Ping (U-1): ARMS a one-shot — the next trigger pings the pointed spot (D6)
	registerVRMenuEntry({ id: 'ping', group: 'tools', label: 'Ping', icon: 'radar', order: 3 });
	// PFX-C: start/stop the scene simulation from VR (greyed while a REMOTE peer runs it)
	registerVRMenuEntry({
		id: 'physics',
		group: 'tools',
		label: () => (get(simulating) || get(remoteSimulating) ? 'Stop physics' : 'Simulate physics'),
		icon: () => (get(simulating) || get(remoteSimulating) ? 'square' : 'play'),
		order: 4,
		active: () => get(simulating),
		disabled: () => !!get(remoteSimulating),
		action: () => toggleSimulation()
	});

	// Add ▸ — the desktop Add menu's names; ids resolve in executeVRMenuAction's switch, which spawns
	// the primitive 2 m ahead of the camera (spawnPrimitive)
	[
		['box', 'Cube', 'box'],
		['wedge', 'Wedge', 'triangle-right'],
		['stairs', 'Stairs', 'door-stairwell'],
		['sphere', 'Sphere', 'circle'],
		['cylinder', 'Cylinder', 'cylinder'],
		['torus', 'Torus', 'torus']
	].forEach(([id, label, icon], order) => registerVRMenuEntry({ id, group: 'add', label, icon, order }));
	// 37 R9: Terrain lands ahead of you and starts a sculpt session on it (the desktop Add menu's Terrain)
	registerVRMenuEntry({ id: 'terrain', group: 'add', label: 'Terrain', icon: 'mountain', order: 5.5 });
	// Prefabs opens the thumbnail window (115)
	registerVRMenuEntry({ id: 'prefabs', group: 'add', label: 'Prefabs', icon: 'package', order: 6 });

	// Scene ▸ — Environment ▸ (the presets), the grid, world scale back to 1:1 (+ Colocate ▸ from its module)
	registerVRMenuEntry({ id: 'nav:environment', group: 'scene', label: 'Environment', icon: 'sun', order: 0, ring: 'environment' });
	Object.entries(ENVIRONMENT_PRESETS).forEach(([key, preset], order) =>
		registerVRMenuEntry({
			id: 'env:' + key,
			group: 'environment',
			label: preset.label,
			order,
			active: () => get(environment)?.preset === key,
			action: () => setEnvironment(key)
		})
	);
	registerVRMenuEntry({ id: 'grid', group: 'scene', label: 'Grid', icon: 'grid-3x3', order: 3, active: () => !!get(showGrid) });
	registerVRMenuEntry({ id: 'world', group: 'scene', label: 'World 1:1', icon: 'maximize', order: 4 });
	// 37 R10: the whole scene as a model on a table; point into it and pull the trigger to stand there
	registerVRMenuEntry({
		id: 'dollhouse',
		group: 'scene',
		label: 'Dollhouse',
		icon: 'house',
		order: 5,
		closes: true,
		active: () => get(vrDollhouseOpen),
		action: () => void import('./vr/dollhouse.js').then((m) => m.toggleDollhouse())
	});

	// Mic modes — explicit (kept registered: Settings ▸ Microphone cycles them; the ids still resolve)
	[
		['ptt', 'Push to talk'],
		['open', 'Open'],
		['off', 'Off']
	].forEach(([mode, label], order) =>
		registerVRMenuEntry({
			id: 'mic:' + mode,
			group: 'mic',
			label,
			order,
			active: () => get(vrMicMode) === mode,
			action: () => setMicMode(/** @type {any} */ (mode))
		})
	);

	// 34 PF: Profile ▸ (under Tools since 36) — record the headset (light / detailed), stop, and "Report this
	// moment". Labels/visibility read the recorder through the perfMarks LEAF; every action is a dynamic
	// import: the perf modules stay out of the VR import family.
	registerVRMenuEntry({ id: 'nav:profile', group: 'tools', label: 'Profile', icon: 'activity', order: 5, ring: 'profile', active: () => !!perfContext('recording') });
	const recording = () => !!perfContext('recording');
	registerVRMenuEntry({
		id: 'perf:record',
		group: 'profile',
		label: 'Record',
		icon: 'circle-dot',
		order: 0,
		closes: true,
		visible: () => !recording(),
		action: () => void import('./perf/recorder.js').then((r) => r.startRecording({ mode: 'light' }))
	});
	registerVRMenuEntry({
		id: 'perf:detailed',
		group: 'profile',
		label: 'Record detailed',
		icon: 'activity',
		order: 1,
		closes: true,
		visible: () => !recording(),
		action: () => void import('./perf/recorder.js').then((r) => r.startRecording({ mode: 'detailed' }))
	});
	registerVRMenuEntry({
		id: 'perf:stop',
		group: 'profile',
		label: 'Stop recording',
		icon: 'square',
		order: 0,
		closes: true,
		active: () => true,
		visible: recording,
		action: () => void import('./perf/recorder.js').then((r) => r.stopRecording())
	});
	registerVRMenuEntry({
		id: 'moment',
		group: 'profile',
		label: 'Report moment',
		icon: 'flag',
		order: 2,
		closes: true,
		action: () => {
			void Promise.all([import('./perf/moment.js'), import('./vrKeyboard.js')]).then(([m, k]) => m.vrReportMoment(k.openVRKeyboard));
		}
	});
	// 37 R20: the headset's "Report a problem" — the eye picture + a note from the VR keyboard,
	// sent to the team when signed in (the keyboard's title says so), else kept on this device
	registerVRMenuEntry({
		id: 'problem',
		group: 'profile',
		label: 'Report a problem',
		icon: 'flag',
		order: 3,
		closes: true,
		action: () => {
			void Promise.all([import('./problemReport.js'), import('./vrKeyboard.js')]).then(([p, k]) => p.vrReportProblem(k.openVRKeyboard));
		}
	});

	// Settings ▸ — its category rings come from the settings table (vr/settingsRings.js); these two are
	// not settings: the whole list as a panel, and leaving the headset
	registerVRMenuEntry({ id: 'settings', group: 'settings', label: 'All settings', icon: 'layers', order: 20 });
	registerVRMenuEntry({ id: 'exitvr', group: 'settings', label: 'Exit VR', icon: 'log-out', order: 30 });

	// Selected ▸ (the hub when something is selected) — the desktop object menu's order: Duplicate ·
	// Group / Ungroup / Edit mesh / Edit spline (one slot, by what is selected) · Properties · Color ·
	// Snapping · Wireframe · Save prefab · Delete LAST. D4: counted labels act on the whole SET.
	registerVRMenuEntry({
		id: 'obj:duplicate',
		group: 'object',
		label: () => 'Duplicate' + countSuffix(),
		icon: 'copy',
		order: 0,
		closes: true,
		action: () => duplicateSelection()
	});
	// Edit mesh (137): a TOGGLE (active dot) that enters mesh-edit mode + opens the controller side-menu
	registerVRMenuEntry({
		id: 'obj:editmesh',
		group: 'object',
		label: 'Edit mesh',
		icon: 'pen-tool',
		order: 1,
		active: () => get(vrEditMenuOpen),
		// 216: a GROUP selection shows Ungroup instead; D4: a MULTI-selection shows Group selection
		visible: () =>
			selCount() <= 1 &&
			/** @type {any} */ (get(selectedObject))?.type !== 'Group' &&
			!isSplineSelection() &&
			!isTerrainSelection()
	});
	// 37 R9: a TERRAIN gets the sculpt brush in the same slot (the desktop object menu's Sculpt terrain)
	registerVRMenuEntry({
		id: 'obj:sculpt',
		group: 'object',
		label: 'Sculpt terrain',
		icon: 'brush',
		order: 1,
		closes: true,
		visible: () => selCount() <= 1 && isTerrainSelection(),
		action: () => {
			const uuid = /** @type {any} */ (get(selectedObject))?.uuid;
			if (uuid) void import('./vr/sculpt.js').then((m) => m.startVRSculpt(uuid));
		}
	});
	// 57.4: a SPLINE gets its own editor in the same slot
	registerVRMenuEntry({
		id: 'obj:editspline',
		group: 'object',
		label: 'Edit spline',
		icon: 'spline',
		order: 1,
		closes: true,
		visible: () => selCount() <= 1 && isSplineSelection(),
		action: () =>
			import('./splineEdit').then((m) => {
				const uuid = /** @type {any} */ (get(selectedObject))?.uuid;
				if (!uuid) return;
				if (get(m.splineEditObject)) m.exitSplineEdit();
				else m.enterSplineEdit(uuid);
			})
	});
	// 36 X4: Edit Collider — the custom-collider session in the headset. It runs the
	// SAME face/vertex tools on a scene-root proxy and opens the edit side-menu, which
	// gains the collider rows (+ Box / + Sphere piece, Decompose, Done, Cancel).
	registerVRMenuEntry({
		id: 'obj:editcollider',
		group: 'object',
		label: 'Edit collider',
		icon: 'shapes',
		order: 6.5, // after Save prefab, Delete (7) stays last (36-vr R5)
		closes: true,
		visible: () =>
			selCount() <= 1 &&
			/** @type {any} */ (get(selectedObject))?.type !== 'Group' &&
			!isSplineSelection(),
		action: () =>
			import('./colliderEdit').then((m) => {
				const uuid = /** @type {any} */ (get(selectedObject))?.uuid;
				if (!uuid) return;
				if (get(m.colliderEditObject)) {
					m.exitColliderEdit();
					vrEditMenuOpen.set(false);
				} else if (m.enterColliderEdit(uuid)) vrEditMenuOpen.set(true);
			})
	});
	// 216: Ungroup (dissolve the group, move children up)
	registerVRMenuEntry({
		id: 'obj:ungroup',
		group: 'object',
		label: 'Ungroup',
		icon: 'ungroup',
		order: 1,
		closes: true,
		visible: () => selCount() <= 1 && /** @type {any} */ (get(selectedObject))?.type === 'Group'
	});
	// D4: Group selection (2+ objects) — the one-undo U-2 op (replicated create + reparent)
	registerVRMenuEntry({
		id: 'obj:group',
		group: 'object',
		label: () => 'Group selection' + countSuffix(),
		icon: 'group',
		order: 1,
		closes: true,
		visible: () => selCount() > 1,
		action: () => groupSelection()
	});
	// Properties opens the core-editable-set panel (112) — primary-only, greyed for a multi-selection
	registerVRMenuEntry({ id: 'obj:props', group: 'object', label: 'Properties', icon: 'sliders-horizontal', order: 2, disabled: () => selCount() > 1 });
	// Color opens the continuous palette panel (110)
	registerVRMenuEntry({ id: 'obj:color', group: 'object', label: 'Color', icon: 'palette', order: 3 });
	// Snapping toggles its side-menu (156; desktop: the viewport menu's Snapping)
	registerVRMenuEntry({ id: 'snap', group: 'object', label: 'Snapping', icon: 'magnet', order: 4, active: () => get(vrSnapMenuOpen) });
	registerVRMenuEntry({ id: 'wireframe', group: 'object', label: 'Wireframe', icon: 'box', order: 5, active: () => get(vrWireframeSelection) });
	// Save prefab (115): the selection joins the library; D3: a multi-selection saves as ONE prefab
	registerVRMenuEntry({
		id: 'obj:prefab',
		group: 'object',
		label: () => 'Save prefab' + countSuffix(),
		icon: 'package',
		order: 6,
		closes: true,
		action: () => {
			const uuids = selectionUuids();
			if (uuids.length > 1) savePrefabSelection(uuids);
			else if (uuids[0]) savePrefab(uuids[0]);
		}
	});
	registerVRMenuEntry({
		id: 'obj:delete',
		group: 'object',
		label: () => 'Delete' + countSuffix(),
		icon: 'trash-2',
		order: 7,
		closes: true,
		action: () => deleteSelection()
	});

	// 37 R9: the Sculpt ring — the radial opens on it while a VR sculpt session is up (Back = the usual menu)
	[
		['raise', 'Raise', 'arrow-up'],
		['lower', 'Lower', 'arrow-down'],
		['smooth', 'Smooth', 'waves-horizontal'],
		['flatten', 'Flatten', 'minus']
	].forEach(([op, label, icon], order) =>
		registerVRMenuEntry({
			id: 'sculpt:' + op,
			group: 'sculpt',
			label,
			icon,
			order,
			closes: true,
			active: () => get(sculptOp) === op,
			action: () => void import('./vr/sculpt.js').then((m) => m.setVRSculptOp(op))
		})
	);
	registerVRMenuEntry({
		id: 'sculpt:done',
		group: 'sculpt',
		label: 'Done',
		icon: 'check',
		order: 4,
		closes: true,
		action: () => void import('./vr/sculpt.js').then((m) => m.stopVRSculpt())
	});

	// Face ops (118/137): ids the side-menu arms via setFaceOp; the 'faces' group stays registered so
	// those ids resolve (no longer a ring)
	registerVRMenuEntry({ id: 'face:extrude', group: 'faces', label: 'Extrude', order: 0 });
	registerVRMenuEntry({ id: 'face:inset', group: 'faces', label: 'Inset', order: 1 });
	registerVRMenuEntry({ id: 'face:move', group: 'faces', label: 'Move', order: 2 });
	registerVRMenuEntry({ id: 'face:delete', group: 'faces', label: 'Delete', order: 3 });
}

registerBuiltins();

// closing the menu (any path) resets navigation to the base ring
vrMenuOpen.subscribe((open) => {
	if (!open) resetRings();
	// 37 R9: a sculpt session opens the menu on its own ring (Back pops to the base ring)
	else if (get(vrSculptActive) && get(activeRing) === 'root') pushRing('sculpt');
});
