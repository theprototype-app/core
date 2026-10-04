// VR controls — the VR panels: objects/props/prefabs/chat/approve/keyboard/palette raycasts and actions, window grab.
// 34 R4 (A5): one concern of src/lib/vrControls.js, which re-exports the public names unchanged.
import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import {
	objectsGroup,
	globalScene,
	vrSettingsPanelOpen,
	selectedObject,
	vrObjectsPanelOpen,
	vrChatPanelOpen,
	vrPaletteOpen,
	vrPropsPanelOpen,
	vrPrefabsPanelOpen,
	vrEditMenuOpen,
	vrSnapMenuOpen,
	vrSnapMode,
	vrGrabbedHand,
	vrApprovePanelOpen,
	pokeScene
} from '../../stores/sceneStore';
import { paletteColorAt, barValueAt } from '../vrPalette';
import { recordMaterialChange, setMaterialParam } from '../materialsHandler';
import { prefabs, instantiatePrefab } from '../prefabs';
import { peers, showToast, messages } from '../../stores/appStore';
import { recordTransform, beginHistoryBatch, endHistoryBatch } from '../history';
import { snapEnabled, snapSettings, surfaceSnap } from '../snapping';
import {
	toggleObjectVisibility,
	duplicateObject,
	deleteSelection,
	selectionUuids
} from '../objectActions';
import { vrKeyboardTarget } from '../vrKeyboard';
import { safeStorage } from '../safeStorage';
import { vrWindowAdjust, windowAnchor, offsetFromWorld, saveWindowPose } from '../vrWindowPoses';
import { S } from './state.js';
import { renderer } from './core.js';
import { transformStateOf, broadcastMove, rigidGrabPose } from './grip.js';
import { hapticPulse } from './haptics.js';
import { axesForSlot } from './input.js';
import { controllerRay } from './pointer.js';
import { executeVRMenuAction } from './radial.js';

// VR interactions (all gated on an active XR session):
// - A/X button on the menu hand toggles the quick-menu
// - trigger = select objects / activate menu tiles (Scene.svelte routes it)
// - squeeze = grab the pointed-at object: Move or Rotate mode follows the
//   controller; squeezing with BOTH hands scales by controller distance.
// Grabs broadcast the regular `move` message and record undo entries, so
// peers can't tell VR edits from desktop gizmo edits.

/** name of the hovered quick-menu tile (for highlight) @type {import('svelte/store').Writable<string|null>} */
export const vrHovered = writable(null);
/** 183: VR create-face select mode — a trigger-tap adds the picked vertex to the
 * Create-face selection instead of grabbing it @type {import('svelte/store').Writable<boolean>} */
export const vrFaceCreateMode = writable(false);
/** the quick-menu THREE group, registered by VRMenu.svelte for raycasts @type {import('svelte/store').Writable<any>} */
export const vrMenuGroup = writable(null);
/** the objects panel THREE group (101) @type {import('svelte/store').Writable<any>} */
export const vrPanelGroup = writable(null);
/** objects panel row CURSOR (109.4) — the stick moves it, press selects it */
export const vrPanelCursor = writable(0);
/** 215: set of expanded group uuids in the VR objects panel @type {import('svelte/store').Writable<Set<string>>} */
export const vrPanelExpanded = writable(new Set());

/**
 * 215: flatten the objects tree into the panel's visible rows — top-level
 * children, with an EXPANDED group's descendants inlined and indented by depth.
 * Pure so VRObjectsPanel (reactive) and the stick-scroll loop (get-based) render
 * and navigate the exact same ordering.
 * @param {any[]} nodes top-level children @param {Set<string>} expanded group uuids
 * @returns {{uuid: string, object: any, depth: number, isGroup: boolean}[]}
 */
export function flattenPanelRows(nodes, expanded) {
	/** @type {{uuid: string, object: any, depth: number, isGroup: boolean}[]} */
	const out = [];
	/** @param {any[]} list @param {number} depth */
	const walk = (list, depth) => {
		for (const obj of list) {
			const isGroup = obj.type === 'Group';
			out.push({ uuid: obj.uuid, object: obj, depth, isGroup });
			if (isGroup && expanded.has(obj.uuid) && obj.children?.length) walk(obj.children, depth + 1);
		}
	};
	walk(nodes ?? [], 0);
	return out;
}

/**
 * VR focus (120): teleport the rig so the viewer frames an object — the
 * desktop focusObject bails in VR (camera is XR-driven). Translation only
 * (matches teleport/world-pan): keep facing, stand back a framing distance.
 * @param {string} uuid
 */
export function vrFocusObject(uuid) {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	if (!object || !renderer?.xr?.isPresenting) return;
	const box = new THREE.Box3().setFromObject(object);
	if (!isFinite(box.min.x)) return;
	const center = box.getCenter(new THREE.Vector3());
	const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.3);
	const viewer = renderer.xr.getCamera().getWorldPosition(new THREE.Vector3());
	const dir = viewer.clone().sub(center);
	dir.y = 0;
	if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
	dir.normalize();
	const desired = center.clone().add(dir.multiplyScalar(radius * 3 + 0.5));
	desired.y = viewer.y; // keep eye height
	const move = desired.sub(viewer); // world displacement we want for the viewer
	const space = renderer.xr.getReferenceSpace();
	// getOffsetReferenceSpace moves the viewer by -(offset), so negate the move
	// @ts-ignore - XRRigidTransform is a WebXR global (no TS lib here)
	const offset = new XRRigidTransform({ x: -move.x, y: -move.y, z: -move.z });
	if (space) renderer.xr.setReferenceSpace(space.getOffsetReferenceSpace(offset));
	hapticPulse(0.3, 40);
}
/** the cursored row's action id, published by VRObjectsPanel @type {import('svelte/store').Writable<string|null>} */
export const vrPanelCursorAction = writable(null);
/** the stats card THREE group (111 grab target) @type {import('svelte/store').Writable<any>} */
export const vrStatsGroup = writable(null);

// VR chat unread badge (117): messages arriving while the VR chat panel is
// closed accumulate; opening the panel clears the count
/** @type {import('svelte/store').Writable<number>} */
export const vrChatUnread = writable(0);
let lastMessageCount = 0;
messages.subscribe((list) => {
	const count = Array.isArray(list) ? list.length : 0;
	if (count > lastMessageCount && !get(vrChatPanelOpen)) vrChatUnread.update((n) => n + (count - lastMessageCount));
	lastMessageCount = count;
});
vrChatPanelOpen.subscribe((open) => {
	if (open) vrChatUnread.set(0);
});

/** Raycast the objects panel rows (101) @param {number} index @returns {string|null} panel action */
export function raycastPanel(index) {
	const panel = get(vrPanelGroup);
	if (!panel || !get(vrObjectsPanelOpen)) return null;
	const hits = controllerRay(index).intersectObject(panel, true);
	const row = hits.find((/** @type {any} */ h) => h.object.name?.startsWith('vrpanel-'));
	return row ? 'panel:' + row.object.name.slice('vrpanel-'.length) : null;
}

/** the palette THREE group (110) @type {import('svelte/store').Writable<any>} */
export const vrPaletteGroup = writable(null);

/** True when the controller ray lands on the palette (110) — the paint loop
 * owns that trigger, so trigger-select must not fire @param {number} index */
export function raycastPalette(index) {
	const palette = get(vrPaletteGroup);
	if (!palette || !get(vrPaletteOpen)) return false;
	const hits = controllerRay(index).intersectObject(palette, true);
	return hits.some((/** @type {any} */ h) => h.object.name?.startsWith('vrpalette-'));
}
/** the live lightness (bar) value @type {import('svelte/store').Writable<number>} */
export const vrPaletteLightness = writable(0.55);

// ---- VR properties panel (112): core editable set for the selection ----
/** the props panel THREE group @type {import('svelte/store').Writable<any>} */
export const vrPropsGroup = writable(null);
/** stick row cursor (objects-panel pattern): index into PROPS_ROWS */
export const vrPropsCursor = writable(0);
/** interactive rows top-to-bottom; axis rows nudge, the rest activate */
export const PROPS_ROWS = [
	'pos:x',
	'pos:y',
	'pos:z',
	'rot:x',
	'rot:y',
	'rot:z',
	'scale:x',
	'scale:y',
	'scale:z',
	'opacity',
	'visible',
	// 33 (K6, P3): Force LOD + the level drawn — left/right (or press) cycles Auto, LOD0…
	'lod'
	// 120: color/duplicate/delete removed — they live on the Edit ring + palette
];

/** 33: the LOD group actions, PRIMED (a static edge would pull the history family's
 * importers through lodGroup's loaders into this module's graph) @type {any} */
let lodActions = null;
import('../lodGroupActions').then((m) => (lodActions = m));
/** @type {any} */
let lodRuntime = null;
import('../lodGroup').then((m) => (lodRuntime = m));

/**
 * The VR props panel's LOD row: cycle Force LOD by `sign` through Auto, LOD0 … LODn.
 * Returns the new choice ('auto' | level), or null when the object has no group.
 * @param {string} uuid @param {number} sign
 */
export function cycleForceLod(uuid, sign) {
	const info = lodRuntime?.lodGroupInfo(uuid);
	if (!info || !lodActions) return null;
	/** @type {('auto' | number)[]} */
	const options = ['auto', ...info.levels.map((/** @type {any} */ _l, /** @type {number} */ i) => i)];
	const now = info.block.mode === 'forced' ? info.block.forced : 'auto';
	const at = Math.max(0, options.indexOf(now));
	const next = options[(at + (sign < 0 ? -1 : 1) + options.length) % options.length];
	lodActions.forceLodLevel(uuid, next);
	return next;
}

/** The LOD row's readout for the VR panel. @param {string} uuid */
export function lodReadout(uuid) {
	const info = lodRuntime?.lodGroupInfo(uuid);
	if (!info) return 'none';
	if (info.block.mode === 'forced') return 'LOD' + info.block.forced + ' forced';
	return 'Auto · ' + (info.current < 0 ? 'culled' : 'LOD' + info.current);
}

/** Raycast the props panel controls @param {number} index @returns {string|null} props action */
export function raycastProps(index) {
	const panel = get(vrPropsGroup);
	if (!panel || !get(vrPropsPanelOpen)) return null;
	const hits = controllerRay(index).intersectObject(panel, true);
	const control = hits.find((/** @type {any} */ h) => h.object.name?.startsWith('vrprops-'));
	return control ? 'props:' + control.object.name.slice('vrprops-'.length) : null;
}

/** the Edit Mesh side-menu group (137) @type {import('svelte/store').Writable<any>} */
export const vrEditGroup = writable(null);
/** Raycast the Edit Mesh side-menu (137) — control names carry the FULL action
 * (edit:mode:faces / face:extrude / edit:close) @param {number} index */
export function raycastEdit(index) {
	const panel = get(vrEditGroup);
	if (!panel || !get(vrEditMenuOpen)) return null;
	const hits = controllerRay(index).intersectObject(panel, true);
	const control = hits.find((/** @type {any} */ h) => h.object.name?.startsWith('vredit-'));
	return control ? control.object.name.slice('vredit-'.length) : null;
}

/** the Snap side-menu group (156) @type {import('svelte/store').Writable<any>} */
export const vrSnapGroup = writable(null);
/** Raycast the Snap side-menu (156) — control names carry the FULL action
 * (snap:mode:grid / snap:grid:0.5 / snap:rot:reset) @param {number} index */
export function raycastSnap(index) {
	const panel = get(vrSnapGroup);
	if (!panel || !get(vrSnapMenuOpen)) return null;
	const hits = controllerRay(index).intersectObject(panel, true);
	const control = hits.find((/** @type {any} */ h) => h.object.name?.startsWith('vrsnap-'));
	return control ? control.object.name.slice('vrsnap-'.length) : null;
}

/** the VR Settings panel group (187) @type {import('svelte/store').Writable<any>} */
export const vrSettingsGroup = writable(null);
/** Raycast the Settings panel (187) — control names carry the FULL action
 * (settings:teleport / settings:close ...) @param {number} index */
export function raycastSettings(index) {
	const panel = get(vrSettingsGroup);
	if (!panel || !get(vrSettingsPanelOpen)) return null;
	const hits = controllerRay(index).intersectObject(panel, true);
	const control = hits.find((/** @type {any} */ h) => h.object.name?.startsWith('vrsettings-'));
	return control ? control.object.name.slice('vrsettings-'.length) : null;
}

/**
 * Map a VR snap MODE onto the shared snapping stores (156). off = nothing;
 * grid/rotation = the gizmo/nudge grid+rotate snap (snapEnabled); surface =
 * rest-on-surface (surfaceSnap, applied per-frame in the VR grab). Exported so
 * headless tests can drive the mapping without a controller. @param {string} mode
 */
export function applySnapMode(mode) {
	vrSnapMode.set(mode);
	try {
		safeStorage.setItem('vrSnapMode', mode);
	} catch {}
	snapEnabled.set(mode === 'grid' || mode === 'rotation');
	surfaceSnap.set(mode === 'surface');
}

/**
 * Snap-aware nudge step per transform kind (112). Pure for tests.
 * @param {string} kind pos|rot|scale @param {boolean} snapOn
 * @param {{translate: number, rotateDeg: number, scale: number}} settings
 */
export function nudgeStep(kind, snapOn, settings) {
	if (kind === 'pos') return snapOn ? settings.translate : 0.1;
	if (kind === 'rot') return ((snapOn ? settings.rotateDeg : 5) * Math.PI) / 180;
	return snapOn ? settings.scale : 0.1;
}

/** One nudge click/stick-tick: local apply + move replication + undo entry
 * @param {any} object @param {string} kind @param {string} axis @param {number} sign */
function nudgeTransform(object, kind, axis, sign) {
	const before = transformStateOf(object);
	const step = nudgeStep(kind, get(snapEnabled), get(snapSettings));
	if (kind === 'pos') object.position[axis] += sign * step;
	else if (kind === 'rot') object.rotation[axis] += sign * step;
	else object.scale[axis] = Math.max(0.01, object.scale[axis] + sign * step);
	recordTransform({ uuid: object.uuid, before, after: transformStateOf(object) });
	broadcastMove(object, true);
	pokeScene();
}

/** Props panel actions ('props:' prefix in executeVRMenuAction) @param {string} action */
export function handlePropsAction(action) {
	if (action === 'close') {
		vrPropsPanelOpen.set(false);
		return;
	}
	const object = /** @type {any} */ (get(selectedObject));
	if (!object?.uuid) return;
	if (action === 'visible') toggleObjectVisibility(object.uuid);
	else if (action === 'duplicate') duplicateObject(undefined);
	else if (action === 'delete') {
		deleteSelection();
		vrPropsPanelOpen.set(false);
	} else if (action === 'color') executeVRMenuAction('obj:color');
	else if (action.startsWith('opacity:')) {
		if (!object.material) return;
		const sign = parseInt(action.slice('opacity:'.length)) || 0;
		const next = Math.min(Math.max((object.material.opacity ?? 1) + sign * 0.1, 0.1), 1);
		if (next < 1 && !object.material.transparent) setMaterialParam(object.uuid, 'transparent', true);
		setMaterialParam(object.uuid, 'opacity', Math.round(next * 10) / 10);
	} else if (action.startsWith('nudge:')) {
		const [kind, axis, sign] = action.slice('nudge:'.length).split(':');
		if (['x', 'y', 'z'].includes(axis)) nudgeTransform(object, kind, axis, parseInt(sign) || 1);
	} else if (action.startsWith('lod:')) {
		if (cycleForceLod(object.uuid, parseInt(action.slice('lod:'.length)) || 1) === null)
			showToast('This object has no LOD levels — generate them in its properties on the desktop');
	}
}

/** Stick press / cursored activation for a PROPS_ROWS row @param {string} row */
export function propsRowAction(row) {
	if (row === 'opacity') return 'props:opacity:1';
	if (row === 'lod') return 'props:lod:1';
	if (row.includes(':')) return 'props:nudge:' + row + ':1';
	return 'props:' + row;
}

// ---- VR prefabs window + ghost placement (115) ----
/** the prefabs window THREE group @type {import('svelte/store').Writable<any>} */
export const vrPrefabsGroup = writable(null);
/** grid cell cursor (stick up/down) */
export const vrPrefabsCursor = writable(0);
/** armed prefab {id, name} while a placement ghost rides the ray, else null
 * @type {import('svelte/store').Writable<any>} */
export const vrPrefabGhost = writable(null);
/** @type {any} the translucent THREE clone at the scene root */
let ghostObject = null;
/** @type {any} */
let ghostPrefab = null;

// ---- VR chat panel (117) ----
/** the chat panel THREE group @type {import('svelte/store').Writable<any>} */
export const vrChatGroup = writable(null);

/** Raycast the chat panel controls @param {number} index @returns {string|null} chat action */
export function raycastChat(index) {
	const panel = get(vrChatGroup);
	if (!panel || !get(vrChatPanelOpen)) return null;
	const hits = controllerRay(index).intersectObject(panel, true);
	const control = hits.find((/** @type {any} */ h) => h.object.name?.startsWith('vrchat-'));
	return control ? 'chat:' + control.object.name.slice('vrchat-'.length) : null;
}

// ---- VR peer-approval panel (211) ----
/** the approval panel THREE group @type {import('svelte/store').Writable<any>} */
export const vrApproveGroup = writable(null);

/** Raycast the approval panel controls @param {number} index @returns {string|null} approve action */
export function raycastApprove(index) {
	const panel = get(vrApproveGroup);
	if (!panel || !get(vrApprovePanelOpen)) return null;
	const hits = controllerRay(index).intersectObject(panel, true);
	const control = hits.find((/** @type {any} */ h) => h.object.name?.startsWith('vrapprove-'));
	return control ? 'approve:' + control.object.name.slice('vrapprove-'.length) : null;
}

// ---- VR keyboard (116): raycast the key grid, route presses ----
/** the keyboard THREE group @type {import('svelte/store').Writable<any>} */
export const vrKeyboardGroup = writable(null);

/** Raycast the keyboard keys @param {number} index @returns {string|null} kbd action */
export function raycastKeyboard(index) {
	const panel = get(vrKeyboardGroup);
	if (!panel || !get(vrKeyboardTarget)) return null;
	const hits = controllerRay(index).intersectObject(panel, true);
	const key = hits.find((/** @type {any} */ h) => h.object.name?.startsWith('vrkey-'));
	return key ? 'kbd:' + key.object.name.slice('vrkey-'.length) : null;
}

/** Raycast the prefabs window controls @param {number} index */
export function raycastPrefabs(index) {
	const panel = get(vrPrefabsGroup);
	if (!panel || !get(vrPrefabsPanelOpen)) return null;
	const hits = controllerRay(index).intersectObject(panel, true);
	const control = hits.find((/** @type {any} */ h) => h.object.name?.startsWith('vrprefabs-'));
	return control ? 'prefabs:' + control.object.name.slice('vrprefabs-'.length) : null;
}

/** Arm the placement ghost for a prefab id (trigger on a cell) @param {string} id */
export function armPrefabGhost(id) {
	const prefab = get(prefabs).find((p) => p.id === id);
	const scene = get(globalScene);
	if (!prefab || !scene) return;
	cancelPrefabGhost();
	let clone;
	try {
		clone = new THREE.ObjectLoader().parse(prefab.element);
	} catch {
		return;
	}
	// fresh parse = own materials, safe to fade in place
	clone.traverse((/** @type {any} */ node) => {
		if (node.material) {
			node.material.transparent = true;
			node.material.opacity = 0.35;
			node.material.depthWrite = false;
		}
	});
	clone.name = 'vr-prefab-ghost';
	scene.add(clone);
	ghostObject = clone;
	ghostPrefab = prefab;
	vrPrefabGhost.set({ id: prefab.id, name: prefab.name });
	hapticPulse(0.2, 25);
}

/** Drop the ghost without placing (grip / panel close / menu open) */
export function cancelPrefabGhost() {
	if (ghostObject) {
		ghostObject.parent?.remove(ghostObject);
		ghostObject.traverse((/** @type {any} */ node) => node.geometry?.dispose?.());
	}
	ghostObject = null;
	ghostPrefab = null;
	vrPrefabGhost.set(null);
}

// closing the prefabs window (any path — ✕, menu open, exclusions) drops the ghost
vrPrefabsPanelOpen.subscribe((open) => {
	if (!open) cancelPrefabGhost();
});

/** Ghost follows the pointer ray: objects first, floor plane as fallback @param {number} index */
export function updatePrefabGhost(index) {
	if (!ghostObject || index < 0) return;
	const ray = controllerRay(index);
	const group = get(objectsGroup);
	let point = null;
	if (group) {
		const hits = ray
			.intersectObjects(group.children, true)
			.filter((/** @type {any} */ h) => h.object !== ghostObject);
		if (hits.length) point = hits[0].point;
	}
	if (!point) {
		const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
		point = ray.ray.intersectPlane(floor, new THREE.Vector3());
	}
	if (point) ghostObject.position.copy(point);
}

/** Trigger while the ghost is armed: instantiate at the ghost spot, stay armed.
 * Returns true when a placement happened (Scene.svelte consumes the select). */
export function placePrefabGhost() {
	if (!ghostObject || !ghostPrefab) return false;
	// picking a cell re-arms instead of placing — the panel raycast runs first
	const group = get(objectsGroup);
	if (!group) return false;
	group.updateMatrixWorld(true);
	const local = group.worldToLocal(ghostObject.position.clone());
	const object = instantiatePrefab(ghostPrefab, local);
	if (!object) return false;
	hapticPulse(0.35, 40);
	return true;
}
let paintGesture = /** @type {any} */ (null);
let lastColorSent = 0;

/** D4: the palette paints the whole SELECTION SET (parity with the desktop
 * menu's counted set ops); a lone selection keeps the single-object behavior.
 * @returns {any[]} selected objects with a paintable material color */
function paintTargets() {
	const group = get(objectsGroup);
	return selectionUuids()
		.map((uuid) => group?.getObjectByProperty('uuid', uuid))
		.filter((object) => object?.material?.color);
}

/** Continuous palette painting while the trigger is held (110)
 * @param {number} index @param {boolean} triggerHeld */
export function updatePalettePaint(index, triggerHeld) {
	const paletteGroup = get(vrPaletteGroup);
	const targets = paintTargets();
	if (!paletteGroup || !targets.length) {
		paintGesture = null;
		return;
	}
	if (!triggerHeld) {
		if (paintGesture) {
			// one undo entry + one final replicated color per pick gesture; a
			// multi-selection collapses into ONE composite history entry (D4)
			/** @type {any} */ const peer = get(peers);
			const multi = paintGesture.before.size > 1;
			if (multi) beginHistoryBatch();
			for (const object of targets) {
				const before = paintGesture.before.get(object.uuid);
				if (!before) continue;
				const after = '#' + object.material.color.getHexString();
				recordMaterialChange(object.uuid, 'color', null, before, after);
				peer?.send({ type: 'color', uuid: object.uuid, color: after });
			}
			if (multi) endHistoryBatch('Color (' + paintGesture.before.size + ')');
			paintGesture = null;
		}
		return;
	}
	const hits = controllerRay(index).intersectObject(paletteGroup, true);
	const hit = hits.find((/** @type {any} */ h) => h.object.name?.startsWith('vrpalette-'));
	if (!hit) return;
	if (hit.object.name === 'vrpalette-close') {
		vrPaletteOpen.set(false);
		paintGesture = null;
		return;
	}
	if (hit.object.name === 'vrpalette-bar') {
		vrPaletteLightness.set(barValueAt(hit.uv?.x ?? 0.5));
		return;
	}
	if (hit.object.name === 'vrpalette-disc') {
		const picked = paletteColorAt(hit.uv?.x ?? 0.5, hit.uv?.y ?? 0.5, get(vrPaletteLightness));
		if (!picked) return;
		if (!paintGesture)
			paintGesture = {
				before: new Map(
					targets.map((object) => [object.uuid, '#' + object.material.color.getHexString()])
				)
			};
		const now = Date.now();
		const sendNow = now - lastColorSent > 120;
		if (sendNow) lastColorSent = now;
		for (const object of targets) {
			object.material.color.set(picked.hex);
			if (sendNow)
				/** @type {any} */ (get(peers))?.send({ type: 'color', uuid: object.uuid, color: picked.hex });
		}
	}
}

// ---- VR window grab (111): grip-hold a follower window to re-place it ----


/** 23-B1 (finding 13): VR windows a MODULE registers, so its panel can be grip-repositioned
 * like every core one. `windowGroupFor` / `windowHitAt` consult it after the built-ins.
 * @type {Map<string, any>} id -> a store holding the panel's THREE.Group (or null) */
const moduleWindows = new Map();
/** @param {string} id @param {any} groupStore @returns {() => void} */
export function registerVRWindow(id, groupStore) {
	moduleWindows.set(id, groupStore);
	return () => {
		if (moduleWindows.get(id) === groupStore) moduleWindows.delete(id);
	};
}
/** every window id the grab knows, built-ins first (tests) */
export function vrWindowIds() {
	return [...BUILTIN_WINDOW_IDS, ...moduleWindows.keys()];
}
const BUILTIN_WINDOW_IDS = ['menu', 'objects', 'palette', 'stats', 'props', 'prefabs', 'keyboard', 'chat', 'editmenu', 'snapmenu', 'approve'];

export function windowGroupFor(/** @type {string} */ id) {
	const registered = moduleWindows.get(id);
	if (registered) return get(registered);
	return get(
		{
			menu: vrMenuGroup,
			objects: vrPanelGroup,
			palette: vrPaletteGroup,
			stats: vrStatsGroup,
			props: vrPropsGroup,
			prefabs: vrPrefabsGroup,
			keyboard: vrKeyboardGroup,
			chat: vrChatGroup,
			editmenu: vrEditGroup,
			snapmenu: vrSnapGroup,
			settingspanel: vrSettingsGroup,
			approve: vrApproveGroup
		}[id] ?? vrMenuGroup
	);
}

/** Which open window the controller ray lands on @param {number} index */
export function windowHitAt(index) {
	let best = null;
	for (const id of vrWindowIds()) {
		const group = windowGroupFor(id);
		if (!group) continue;
		const hits = controllerRay(index).intersectObject(group, true);
		if (hits.length && (!best || hits[0].distance < best.distance))
			best = { id, distance: hits[0].distance };
	}
	return best && best.distance < 3 ? best.id : null;
}

export function beginWindowAdjust() {
	const { id, index } = /** @type {any} */ (S.windowGrabPending);
	S.windowGrabPending = null;
	const group = windowGroupFor(id);
	if (!group) return;
	const controller = renderer.xr.getController(index);
	const cPos = controller.getWorldPosition(new THREE.Vector3());
	const cQuat = controller.getWorldQuaternion(new THREE.Quaternion());
	S.windowGrab = {
		id,
		index,
		relPos: group.position.clone().sub(cPos).applyQuaternion(cQuat.clone().invert()),
		relQuat: cQuat.clone().invert().multiply(group.quaternion),
		scale: group.scale.x || 1
	};
	vrWindowAdjust.set({ id, index });
	// gate that hand's stick (locomotion) — it scales the window now
	vrGrabbedHand.set(renderer.xr.getController(index)?.userData?.handedness ?? null);
	hapticPulse(0.5, 60);
}

export function updateWindowAdjust() {
	const group = windowGroupFor(S.windowGrab.id);
	if (!group || !group.parent) {
		// the window closed mid-adjust — drop the gesture
		S.windowGrab = null;
		vrWindowAdjust.set(null);
		vrGrabbedHand.set(null);
		return;
	}
	const controller = renderer.xr.getController(S.windowGrab.index);
	const cPos = controller.getWorldPosition(new THREE.Vector3());
	const cQuat = controller.getWorldQuaternion(new THREE.Quaternion());
	const pose = rigidGrabPose(cPos, cQuat, S.windowGrab.relPos, S.windowGrab.relQuat);
	group.position.copy(pose.position);
	group.quaternion.copy(pose.quaternion);
	// gripping hand's stick fwd/back resizes the window
	const axes = axesForSlot(S.windowGrab.index);
	const y = Math.abs(axes[3] ?? 0) > 0.15 ? (axes[3] ?? 0) : 0;
	S.windowGrab.scale = Math.min(Math.max(S.windowGrab.scale * (1 - y * 0.02), 0.35), 3);
	group.scale.setScalar(S.windowGrab.scale);
}

export function finishWindowAdjust() {
	const group = windowGroupFor(S.windowGrab.id);
	const anchor = windowAnchor(S.windowGrab.id);
	if (group && anchor)
		saveWindowPose(
			S.windowGrab.id,
			offsetFromWorld(anchor, group.position, group.quaternion, group.scale.x || 1)
		);
	S.windowGrab = null;
	vrWindowAdjust.set(null);
	vrGrabbedHand.set(null);
	hapticPulse(0.3, 40);
}
