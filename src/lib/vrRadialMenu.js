import { writable, get } from 'svelte/store';
import {
	vrMenuOpen,
	vrMenuHand,
	vrSnapAngle,
	selectedObject
} from '../stores/sceneStore';
import { environment, setEnvironment, ENVIRONMENT_PRESETS } from './environment';
import { setMicMode, vrMicMode } from './voiceChat';
import { recordMaterialChange } from './materialsHandler';
import { peers } from '../stores/appStore';
import { toggleObjectVisibility, duplicateObject, deleteSelection } from './objectActions';

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
 * The center hub doubles as Close (base ring), Object ▸ (base ring with a
 * selection) or Back (sub-rings).
 * @param {string} ring @param {boolean} hasSelection
 */
export function hubEntry(ring, hasSelection) {
	if (ring !== 'root') return { id: 'back', label: '←' };
	if (hasSelection) return { id: 'nav:object', label: 'Object' };
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
	// base ring (8 sectors, remapped in 99): Move/Rotate left (grip grab in 100
	// replaces them), Objects (VR list panel, 101) and Redo (next to Undo) in.
	registerVRMenuEntry({ id: 'objects', label: 'Objects', order: 0 });
	registerVRMenuEntry({ id: 'nav:add', label: 'Add ▸', order: 1, ring: 'add' });
	registerVRMenuEntry({ id: 'nav:scene', label: 'Scene ▸', order: 2, ring: 'scene' });
	registerVRMenuEntry({ id: 'draw', label: 'Draw', order: 3 });
	registerVRMenuEntry({ id: 'undo', label: 'Undo', order: 4 });
	registerVRMenuEntry({ id: 'redo', label: 'Redo', order: 5 });
	registerVRMenuEntry({ id: 'nav:mic', label: 'Mic ▸', order: 6, ring: 'mic' });
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

	// System ▸ — toggles + session controls (legacy switch ids; Redo moved to
	// the base ring in 99, Statistics (102) and the legacy grab-mode toggle in)
	registerVRMenuEntry({ id: 'snap', group: 'system', label: 'Snap', order: 0 });
	registerVRMenuEntry({ id: 'grid', group: 'system', label: 'Grid', order: 1 });
	registerVRMenuEntry({ id: 'world', group: 'system', label: 'World 1:1', order: 2 });
	registerVRMenuEntry({ id: 'passthru', group: 'system', label: 'Passthru', order: 3 });
	registerVRMenuEntry({
		id: 'hand',
		group: 'system',
		label: 'Swap hand',
		order: 4,
		action: () => {
			const next = get(vrMenuHand) === 'left' ? 'right' : 'left';
			vrMenuHand.set(/** @type {any} */ (next));
			try {
				localStorage.setItem('vrMenuHand', next);
			} catch {}
		}
	});
	registerVRMenuEntry({ id: 'stats', group: 'system', label: 'Statistics', order: 5 });
	registerVRMenuEntry({ id: 'grabmode', group: 'system', label: 'Grab mode', order: 6 });
	registerVRMenuEntry({ id: 'exitvr', group: 'system', label: 'Exit VR', order: 7 });

	// Object ▸ (hub when something is selected): ops + color palette ring
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
	['#e63946', '#f4a261', '#ffd166', '#2a9d8f', '#4f83cc', '#9b5de5', '#f1f1f1', '#333333'].forEach(
		(color, order) =>
			registerVRMenuEntry({
				id: 'color:' + color.slice(1),
				group: 'object',
				label: '',
				color,
				order: 3 + order,
				action: () => {
					// same path as the Inspector picker: set + `color` message + undo
					const object = get(selectedObject);
					if (!object?.uuid || !object?.material?.color) return;
					const before = '#' + object.material.color.getHexString();
					object.material.color.set(color);
					recordMaterialChange(object.uuid, 'color', null, before, color);
					/** @type {any} */
					const peer = get(peers);
					if (peer) peer.send({ type: 'color', uuid: object.uuid, color });
				}
			})
	);
}

registerBuiltins();

// closing the menu (any path) resets navigation to the base ring
vrMenuOpen.subscribe((open) => {
	if (!open) activeRing.set('root');
});
