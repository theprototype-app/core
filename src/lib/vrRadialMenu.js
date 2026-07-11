import { writable, get } from 'svelte/store';
import {
	vrMenuOpen,
	vrMenuHand,
	vrSnapAngle,
	selectedObject,
	vrWireframeSelection
} from '../stores/sceneStore';
import { environment, setEnvironment, ENVIRONMENT_PRESETS } from './environment';
import { setMicMode, vrMicMode } from './voiceChat';
import { toggleObjectVisibility, duplicateObject, deleteSelection } from './objectActions';
import { savePrefab } from './prefabs';

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
 * @param {{id: string, group?: string, label: string, order?: number,
 *   ring?: string, action?: () => void, active?: () => boolean,
 *   color?: string, closes?: boolean}} entry
 * `ring` makes it a navigation sector into that sub-ring; `color` renders the
 * sector as a swatch; `closes` closes the menu after the action runs.
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

/** Entries of a ring, in registration/order order @param {string} group */
export function ringEntries(group) {
	return [...(registry.get(group) ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
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

const SNAP_ANGLES = [15, 30, 45];

function registerBuiltins() {
	// base ring (8 sectors; 109 remap): Redo/Undo swapped per user muscle
	// memory, Chat replaces Mic ▸ (the mic ring nests under System now).
	registerVRMenuEntry({ id: 'objects', label: 'Objects', order: 0 });
	registerVRMenuEntry({ id: 'nav:add', label: 'Add ▸', order: 1, ring: 'add' });
	registerVRMenuEntry({ id: 'nav:scene', label: 'Scene ▸', order: 2, ring: 'scene' });
	registerVRMenuEntry({ id: 'draw', label: 'Draw', order: 3 });
	registerVRMenuEntry({ id: 'redo', label: 'Redo', order: 4 });
	registerVRMenuEntry({ id: 'undo', label: 'Undo', order: 5 });
	registerVRMenuEntry({ id: 'chat', label: 'Chat', order: 6 });
	registerVRMenuEntry({ id: 'nav:system', label: 'System ▸', order: 7, ring: 'system' });

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
		label: 'Turn °',
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
	registerVRMenuEntry({ id: 'passthru', group: 'system', label: 'Passthru', order: 2 });
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

	// Edit ▸ (hub when something is selected): ops + Snap (moved from System, 109)
	registerVRMenuEntry({ id: 'snap', group: 'object', label: 'Snap', order: 12 });
	registerVRMenuEntry({
		id: 'obj:visible',
		group: 'object',
		label: 'Show/Hide',
		order: 0,
		action: () => {
			const uuid = get(selectedObject)?.uuid;
			if (uuid) toggleObjectVisibility(uuid);
		}
	});
	registerVRMenuEntry({
		id: 'obj:duplicate',
		group: 'object',
		label: 'Duplicate',
		order: 1,
		closes: true,
		action: () => duplicateObject(undefined)
	});
	registerVRMenuEntry({
		id: 'obj:delete',
		group: 'object',
		label: 'Delete',
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
	// Properties opens the core-editable-set panel (112)
	registerVRMenuEntry({ id: 'obj:props', group: 'object', label: 'Properties', order: 5 });
	// Vertices enters mesh edit mode for simple meshes (113)
	registerVRMenuEntry({ id: 'obj:vertices', group: 'object', label: 'Vertices', order: 7 });
	// Faces ▸ enters face-edit mode + opens the ops sub-ring (118)
	registerVRMenuEntry({ id: 'nav:faces', group: 'object', label: 'Faces ▸', order: 8, ring: 'faces' });

	// Faces sub-ring (118): the four ops that cover ~90% of blockout
	registerVRMenuEntry({ id: 'face:extrude', group: 'faces', label: 'Extrude', order: 0 });
	registerVRMenuEntry({ id: 'face:inset', group: 'faces', label: 'Inset', order: 1 });
	registerVRMenuEntry({ id: 'face:move', group: 'faces', label: 'Move', order: 2 });
	registerVRMenuEntry({ id: 'face:delete', group: 'faces', label: 'Delete', order: 3 });
	// Save prefab (115): the selection joins the library, thumbnail included
	registerVRMenuEntry({
		id: 'obj:prefab',
		group: 'object',
		label: 'Save prefab',
		order: 6,
		closes: true,
		action: () => {
			const uuid = /** @type {any} */ (get(selectedObject))?.uuid;
			if (uuid) savePrefab(uuid);
		}
	});
}

registerBuiltins();

// closing the menu (any path) resets navigation to the base ring
vrMenuOpen.subscribe((open) => {
	if (!open) resetRings();
});
