import { writable, get } from 'svelte/store';
import {
	vrMenuOpen,
	vrMenuHand,
	vrSnapAngle,
	selectedObject,
	vrWireframeSelection,
	vrEditMenuOpen,
	vrSnapMenuOpen,
	vrToolMode
} from '../stores/sceneStore';
import { environment, setEnvironment, ENVIRONMENT_PRESETS } from './environment';
import { setMicMode, vrMicMode } from './voiceChat';
import { duplicateSelection, deleteSelection, groupSelection, selectionUuids } from './objectActions';
import { savePrefab, savePrefabSelection } from './prefabs';

// D4 (roadmap 13): selection-set helpers for the Edit ring — counted labels
// act on the whole SET (parity with the desktop object menu, U-2)
function selCount() {
	return selectionUuids().length;
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
// 99: ~50% smaller than v2 — the ring rides ON the controller now
export const RING_INNER = 0.028;
export const RING_OUTER = 0.105;
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

/**
 * Register (or replace, by id) a radial menu entry.
 * @param {{id: string, group?: string, label: string | (() => string), order?: number,
 *   ring?: string, action?: () => void, active?: () => boolean,
 *   color?: string, closes?: boolean, visible?: () => boolean,
 *   disabled?: () => boolean}} entry
 * `ring` makes it a navigation sector into that sub-ring; `color` renders the
 * sector as a swatch; `closes` closes the menu after the action runs;
 * `disabled` greys the sector out and blocks activation (D4).
 */
export function registerVRMenuEntry(entry) {
	const group = entry.group ?? 'root';
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
	if (ring !== 'root') return { id: 'back', label: '←' };
	if (hasSelection) return { id: 'nav:object', label: 'Edit' };
	return { id: 'close', label: '✕' };
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

// unified with the VR settings panel + desktop Settings (R-2): 0 = Off, so the
// radial can also turn snap-turn off and cycling is consistent across all three
const SNAP_ANGLES = [0, 15, 30, 45];

function registerBuiltins() {
	// base ring (8 sectors; 109 remap): Redo/Undo swapped per user muscle
	// memory, Chat replaces Mic ▸ (the mic ring nests under System now).
	registerVRMenuEntry({ id: 'objects', label: 'Objects', order: 0 });
	registerVRMenuEntry({ id: 'nav:add', label: 'Add ▸', order: 1, ring: 'add' });
	registerVRMenuEntry({ id: 'nav:scene', label: 'Scene ▸', order: 2, ring: 'scene' });
	registerVRMenuEntry({ id: 'nav:tools', label: 'Tools ▸', order: 3, ring: 'tools' });
	registerVRMenuEntry({ id: 'redo', label: 'Redo', order: 4 });
	registerVRMenuEntry({ id: 'undo', label: 'Undo', order: 5 });
	registerVRMenuEntry({ id: 'chat', label: 'Chat', order: 6 });
	registerVRMenuEntry({ id: 'nav:system', label: 'System ▸', order: 7, ring: 'system' });

	// Tools ▸ (214) — the trigger tool mode: single Select, Box Select marquee, Draw
	registerVRMenuEntry({ id: 'tool:select', group: 'tools', label: 'Select', order: 0, active: () => get(vrToolMode) === 'select' });
	registerVRMenuEntry({ id: 'tool:box', group: 'tools', label: 'Box Select', order: 1, active: () => get(vrToolMode) === 'box' });
	registerVRMenuEntry({ id: 'tool:draw', group: 'tools', label: 'Draw', order: 2, active: () => get(vrToolMode) === 'draw' });
	// Ping (U-1): immediate ping from the pointer hand — a discoverable partner
	// to the right-stick-click ping; highlights the object if the ray hits one
	registerVRMenuEntry({ id: 'ping', group: 'tools', label: 'Ping', order: 3 });

	// Add ▸ — ids resolve in executeVRMenuAction's switch, which spawns the
	// primitive 2m ahead of the camera (spawnPrimitive)
	['box', 'wedge', 'stairs', 'sphere', 'cylinder', 'torus'].forEach((kind, order) =>
		registerVRMenuEntry({
			id: kind,
			group: 'add',
			label: kind[0].toUpperCase() + kind.slice(1),
			order
		})
	);
	// Prefabs opens the thumbnail window (115)
	registerVRMenuEntry({ id: 'prefabs', group: 'add', label: 'Prefabs', order: 6 });

	// Scene ▸ — environment presets + snap-turn angle
	Object.entries(ENVIRONMENT_PRESETS).forEach(([key, preset], order) =>
		registerVRMenuEntry({
			id: 'env:' + key,
			group: 'scene',
			label: preset.label,
			order,
			active: () => get(environment)?.preset === key,
			action: () => setEnvironment(key)
		})
	);
	registerVRMenuEntry({
		id: 'snapangle',
		group: 'scene',
		// live label so the change is visible immediately in the radial (R-2);
		// the sector re-derives on $vrSnapAngle in VRMenu
		label: () => 'Turn: ' + (get(vrSnapAngle) ? get(vrSnapAngle) + '°' : 'Off'),
		order: 9,
		action: () => {
			const next =
				SNAP_ANGLES[(SNAP_ANGLES.indexOf(get(vrSnapAngle)) + 1) % SNAP_ANGLES.length];
			vrSnapAngle.set(next);
			try {
				localStorage.setItem('vrSnapAngle', String(next));
			} catch {}
		}
	});

	// Mic ▸ — explicit modes (the old tile cycled blindly)
	[
		['ptt', 'PTT'],
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

	// System ▸ — toggles + session controls (109: Snap moved to the Edit ring,
	// Mic ▸ nests here — the nav stack makes its Back return to System)
	registerVRMenuEntry({ id: 'grid', group: 'system', label: 'Grid', order: 0 });
	registerVRMenuEntry({ id: 'world', group: 'system', label: 'World 1:1', order: 1 });
	registerVRMenuEntry({ id: 'settings', group: 'system', label: 'Settings', order: 2 });
	registerVRMenuEntry({
		id: 'hand',
		group: 'system',
		label: 'Swap hand',
		order: 3,
		action: () => {
			const next = get(vrMenuHand) === 'left' ? 'right' : 'left';
			vrMenuHand.set(/** @type {any} */ (next));
			try {
				localStorage.setItem('vrMenuHand', next);
			} catch {}
		}
	});
	registerVRMenuEntry({ id: 'stats', group: 'system', label: 'Statistics', order: 4 });
	registerVRMenuEntry({ id: 'grabmode', group: 'system', label: 'Grab mode', order: 5 });
	registerVRMenuEntry({ id: 'nav:mic', label: 'Mic ▸', group: 'system', order: 6, ring: 'mic' });
	registerVRMenuEntry({ id: 'exitvr', group: 'system', label: 'Exit VR', order: 7 });

	// Edit ▸ (hub when something is selected): ops + Snap (moved from System, 109).
	// 137: Show/Hide removed (the Objects list does it); Snap is a toggle that
	// opens its side-menu (active dot), reworked in 156.
	registerVRMenuEntry({
		id: 'snap',
		group: 'object',
		label: 'Snap',
		order: 12,
		active: () => get(vrSnapMenuOpen)
	});
	// D4: counted labels act on the SET (duplicateSelection falls back to the
	// single path for a lone selection; deleteSelection was already set-wide)
	registerVRMenuEntry({
		id: 'obj:duplicate',
		group: 'object',
		label: () => 'Duplicate' + countSuffix(),
		order: 1,
		closes: true,
		action: () => duplicateSelection()
	});
	registerVRMenuEntry({
		id: 'obj:delete',
		group: 'object',
		label: () => 'Delete' + countSuffix(),
		order: 2,
		closes: true,
		action: () => deleteSelection()
	});
	// Color opens the continuous palette panel (110 — the 8 swatches left)
	registerVRMenuEntry({ id: 'obj:color', group: 'object', label: 'Color', order: 3 });
	registerVRMenuEntry({
		id: 'wireframe',
		group: 'object',
		label: 'Wireframe',
		order: 4,
		active: () => get(vrWireframeSelection)
	});
	// Properties opens the core-editable-set panel (112) — D4: primary-only,
	// greyed out for a multi-selection instead of silently editing one member
	registerVRMenuEntry({
		id: 'obj:props',
		group: 'object',
		label: 'Properties',
		order: 5,
		disabled: () => selCount() > 1
	});
	// Edit Mesh (137): a TOGGLE (active dot) that enters mesh-edit mode + opens
	// the controller side-menu with Vertices/Faces mode + tools (replaces the
	// old Vertices entry + Faces ▸ sub-ring)
	registerVRMenuEntry({
		id: 'obj:editmesh',
		group: 'object',
		label: 'Edit Mesh',
		order: 7,
		active: () => get(vrEditMenuOpen),
		// 216: a GROUP selection can't be mesh-edited; it shows Ungroup instead.
		// D4: a MULTI-selection shows Make Group instead
		visible: () =>
			selCount() <= 1 && /** @type {any} */ (get(selectedObject))?.type !== 'Group'
	});
	// 216: Ungroup (dissolve the group, move children up) — replaces Edit Mesh
	// when the selection is a Group
	registerVRMenuEntry({
		id: 'obj:ungroup',
		group: 'object',
		label: 'Ungroup',
		order: 7,
		closes: true,
		visible: () =>
			selCount() <= 1 && /** @type {any} */ (get(selectedObject))?.type === 'Group'
	});
	// D4: Make Group takes the Edit Mesh slot when 2+ objects are selected —
	// groupSelection is the one-undo U-2 op (replicated create + reparent)
	registerVRMenuEntry({
		id: 'obj:group',
		group: 'object',
		label: () => 'Make Group' + countSuffix(),
		order: 7,
		closes: true,
		visible: () => selCount() > 1,
		action: () => groupSelection()
	});

	// Face ops (118/137): still ids the side-menu arms via setFaceOp; the
	// 'faces' group is kept registered so those ids resolve (no longer a ring)
	registerVRMenuEntry({ id: 'face:extrude', group: 'faces', label: 'Extrude', order: 0 });
	registerVRMenuEntry({ id: 'face:inset', group: 'faces', label: 'Inset', order: 1 });
	registerVRMenuEntry({ id: 'face:move', group: 'faces', label: 'Move', order: 2 });
	registerVRMenuEntry({ id: 'face:delete', group: 'faces', label: 'Delete', order: 3 });
	// Save prefab (115): the selection joins the library, thumbnail included.
	// D3 (roadmap 13): a MULTI-selection saves as ONE layout-preserving prefab
	// (savePrefabSelection, the U-2 op desktop already uses)
	registerVRMenuEntry({
		id: 'obj:prefab',
		group: 'object',
		label: () => 'Save prefab' + countSuffix(),
		order: 6,
		closes: true,
		action: () => {
			const uuids = selectionUuids();
			if (uuids.length > 1) savePrefabSelection(uuids);
			else if (uuids[0]) savePrefab(uuids[0]);
		}
	});
}

registerBuiltins();

// closing the menu (any path) resets navigation to the base ring
vrMenuOpen.subscribe((open) => {
	if (!open) resetRings();
});
