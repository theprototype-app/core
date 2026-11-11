import { parseCheckedObject } from './loadGuard.js';
// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import {
	objectsGroup,
	globalScene,
	globalRenderer,
	vrMenuHand,
	vrMenuOpen,
	vrSnapMode,
	vrSleeveEnabled, pokeScene } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { parkEditOverlays } from './editOverlays';
import { snapEnabled, snapSettings, dropToSurface } from './snapping';
import { beginHistoryBatch, endHistoryBatch, recordTransform, recordObjectPresence } from './history';
import { createGeometry } from './geometries.svelte';
import { customGeometryBuilders } from './customGeometries';
import {
	controllerIndexFor,
	grabStickAdjust,
	hapticPulse,
	registerNavSuppressor,
	registerPanelGroupProvider,
	registerVRTriggerHooks,
	registerGripHooks,
	registerGripDropHook,
	registerVRFrameHook
} from './vrControls';
import { axesForSlot } from './vr/input.js';
import { resumeAnimation } from './flowRuntime';
import { instantiatePrefab } from './prefabs';
import { idbGet, idbPut } from './idb';
import { disposeTree } from './disposeTree.js';
import { motionMs } from './motion';
import {
	GROW_FAR,
	CONTACT_RANGE,
	FLY_BACK_MS,
	growthTarget,
	stepGrowth,
	growthFactor,
	clampedOffset,
	viewAngleDeg,
	cancelStep,
	flyBackProgress,
	placementScale,
	originRadius
} from './vrSleeveMath.js';

// K (roadmap 13): VR sleeve palette — a FLAT STRIP of ghost mini-primitives
// riding up the sleeve-hand forearm like a bracer (slots wrist → elbow).
// Point + TRIGGER (a pinch on hands) on a ghost, or GRIP with the other hand AT
// a slot, takes it: the preview grows from ghost to true size as the hand moves
// away from the wrist and latches (roadmap 82 P1-P4, see the hold section);
// releasing a latched preview creates the primitive at its world pose with the
// same vrSnapMode rules as a grip-grab drop, as ONE undo batch. K2 adds CUSTOM
// slots: grip-carry an object and drop it ONTO the strip to capture a prefab
// snapshot (LOCAL idb persistence, never replicated); trigger-drag the custom
// ghost out to instantiate it. Everything is SCENE-GRAPH ONLY — the strip and
// previews never parent into objectsGroup (they must not replicate/export).
// Packaged as the `vrsleeve` core module; gated by Settings ▸ VR ▸ "VR sleeve
// palette" (vrSleeveEnabled, DEFAULT OFF). Feel/placement on-device = the
// user's manual check; the math/state below is covered headlessly.

export const SLEEVE_KINDS = ['Box', 'Wedge', 'Stairs', 'Sphere', 'Cylinder', 'Torus'];
export const SLEEVE_SLOT_PITCH = 0.055;
export const SLEEVE_MAX_SLOTS = 8;
const GHOST_SIZE = 0.032; // max extent of a ghost mesh on the strip
const STRIP_BASE = { x: 0, y: 0.025, z: 0.1 }; // first slot, controller-local (near the wrist)
const CUSTOM_ROW_X = -0.05; // custom slots ride a parallel row beside the primitives
const CAPTURE_RANGE = 0.06; // grip-drop within this of the strip captures a slot
const SLOTS_KEY = 'vrsleeve-slots-v1';

/** The default /create constructor args per primitive (primitivesCatalog). */
const DEFAULT_PARAMS = /** @type {Record<string, number[]>} */ ({
	Box: [2, 2, 2],
	Wedge: [2, 1, 2],
	Stairs: [2, 1.5, 2, 6],
	Sphere: [1],
	Cylinder: [1, 1, 2],
	Torus: [1, 0.4]
});

/** K2 custom slots: [{id, name, element}] — LOCAL only (a sleeve is personal).
 * @type {import('svelte/store').Writable<any[]>} */
export const sleeveSlots = writable([]);

/** @type {any} the strip group (child of the sleeve-hand controller in VR) */
let sleeveGroup = null;
/** @type {any} held preview (beginHoldEntry has the fields) */
let hold = null;
/** trailing-'select' swallow stamp (a pick/place/clear just handled the trigger) */
let handledAt = 0;
let registered = false;
let slotsLoaded = false;

/** @param {number} hex */
function ghostMaterial(hex = 0x8ab4ff) {
	return new THREE.MeshBasicMaterial({
		color: hex,
		transparent: true,
		opacity: 0.4,
		depthWrite: false
	});
}

/** Build the real geometry for a sleeve kind (the same shapes /create makes).
 * @param {string} kind @returns {any} */
function geometryFor(kind) {
	const p = DEFAULT_PARAMS[kind] ?? [];
	const custom = /** @type {any} */ (customGeometryBuilders)[kind];
	if (custom) return custom(...p);
	if (kind === 'Sphere') return new THREE.SphereGeometry(p[0] ?? 1, 24, 16);
	if (kind === 'Cylinder') return new THREE.CylinderGeometry(p[0] ?? 1, p[1] ?? 1, p[2] ?? 2, 24);
	if (kind === 'Torus') return new THREE.TorusGeometry(p[0] ?? 1, p[1] ?? 0.4, 12, 32);
	return new THREE.BoxGeometry(p[0] ?? 2, p[1] ?? 2, p[2] ?? 2);
}

/** Scale an object uniformly so its largest extent is `size`. @param {any} object @param {number} size */
function normalizeTo(object, size) {
	const box = new THREE.Box3().setFromObject(object);
	const extent = box.getSize(new THREE.Vector3());
	const max = Math.max(extent.x, extent.y, extent.z, 1e-6);
	object.scale.multiplyScalar(size / max);
	return object;
}

/** Ghost-ify a parsed prefab clone: transparent materials, no shadows. @param {any} object */
function ghostify(object) {
	object.traverse((/** @type {any} */ node) => {
		node.castShadow = false;
		node.receiveShadow = false;
		if (node.isMesh) {
			const material = Array.isArray(node.material) ? node.material[0] : node.material;
			const clone = material?.clone ? material.clone() : ghostMaterial();
			clone.transparent = true;
			clone.opacity = 0.4;
			clone.depthWrite = false;
			node.material = clone;
		}
	});
	return object;
}

/** Slot i's controller-local position (row 0 = primitives, row 1 = custom).
 * @param {number} i @param {number} [row] */
function slotPosition(i, row = 0) {
	return new THREE.Vector3(
		STRIP_BASE.x + (row === 1 ? CUSTOM_ROW_X : 0),
		STRIP_BASE.y,
		STRIP_BASE.z + i * SLEEVE_SLOT_PITCH
	);
}

/** Rebuild the custom-slot row (K2) under the existing group. */
function rebuildCustomRow() {
	if (!sleeveGroup) return;
	for (const child of [...sleeveGroup.children]) {
		if (child.userData.sleeveCustom) sleeveGroup.remove(child);
	}
	get(sleeveSlots).forEach((slot, i) => {
		let ghost;
		try {
			ghost = ghostify(parseCheckedObject(slot.element, 'library', 'prefab'));
		} catch {
			ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), ghostMaterial(0xffc46b));
		}
		normalizeTo(ghost, GHOST_SIZE);
		const holder = new THREE.Group();
		holder.name = 'vrsleeve-slot:' + slot.id;
		holder.userData.sleeveCustom = true;
		holder.userData.sleeveSlotId = slot.id;
		holder.position.copy(slotPosition(i, 1));
		holder.add(ghost);
		sleeveGroup.add(holder);
		// hover ✕ chip: a small tab beside the ghost clears the slot
		const chip = new THREE.Mesh(new THREE.PlaneGeometry(0.014, 0.014), ghostMaterial(0xcc5555));
		chip.name = 'vrsleeve-clear:' + slot.id;
		chip.userData.sleeveCustom = true;
		chip.position.copy(slotPosition(i, 1)).add(new THREE.Vector3(-0.028, 0.004, 0));
		chip.rotation.x = -Math.PI / 2;
		sleeveGroup.add(chip);
	});
}

/** Build (once) and return the strip group — 6 named ghost primitives along
 * the forearm axis + any custom slots. NOT parented here; updateVRSleeve
 * anchors it to the live sleeve-hand controller. @returns {any} */
export function ensureSleeveGroup() {
	if (sleeveGroup) return sleeveGroup;
	sleeveGroup = new THREE.Group();
	sleeveGroup.name = 'vr-sleeve';
	SLEEVE_KINDS.forEach((kind, i) => {
		const mesh = new THREE.Mesh(geometryFor(kind), ghostMaterial());
		mesh.name = 'vrsleeve-' + kind;
		mesh.userData.sleeveKind = kind;
		mesh.castShadow = false;
		normalizeTo(mesh, GHOST_SIZE);
		mesh.position.copy(slotPosition(i, 0));
		sleeveGroup.add(mesh);
	});
	rebuildCustomRow();
	return sleeveGroup;
}

/** The sleeve rides the LEFT forearm unless the radial menu owns the left
 * hand — then it mirrors to the right (locked decision). @returns {'left'|'right'} */
export function sleeveHand() {
	return get(vrMenuHand) === 'left' ? 'right' : 'left';
}

/** Walk a raycast hit up to the named sleeve node. @param {any} object */
function sleeveNodeOf(object) {
	let node = object;
	while (node && node !== sleeveGroup) {
		if (typeof node.name === 'string' && node.name.startsWith('vrsleeve-')) return node;
		node = node.parent;
	}
	return null;
}

// ---- K1: hold / place (roadmap 82 P1-P4: grow, latch, reel, cancel) ----------------
// A taken ghost rides the taking hand and GROWS with that hand's distance from the sleeve wrist
// (vrSleeveMath: ghost size at 6 cm, true size × the world's scale at 40 cm), pushed out along the
// hand's ray so it never covers more than ~50° of the view. Full size LATCHES (a detent tick): it is
// then an ordinary grab — the grip-move sticks reel (Y) and scale (X) it through grabStickAdjust. The
// hand back within 10 cm of the wrist cancels: the preview shrinks and flies back into its slot. A
// release before the latch is a cancel too. The per-frame path allocates nothing (Quest budget).

/** Preview mesh for a hold entry ({kind} or {slot}). @param {any} entry */
function previewFor(entry) {
	if (entry.kind) {
		const mesh = new THREE.Mesh(geometryFor(entry.kind), ghostMaterial(0xbfd6ff));
		mesh.material.opacity = 0.6;
		mesh.name = 'vrsleeve-preview';
		return mesh;
	}
	let object;
	try {
		object = ghostify(parseCheckedObject(entry.slot.element, 'library', 'prefab'));
	} catch {
		object = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), ghostMaterial(0xbfd6ff));
	}
	object.name = 'vrsleeve-preview';
	return object;
}

// per-frame scratch (no allocations in the frame path)
const _handPos = new THREE.Vector3();
const _handQuat = new THREE.Quaternion();
const _wristPos = new THREE.Vector3();
const _headPos = new THREE.Vector3();
const _slotPos = new THREE.Vector3();
const _groupScale = new THREE.Vector3();
const _dir = new THREE.Vector3();
/** the objectsGroup, kept by a subscription while registered (a get() per frame allocates) @type {any} */
let liveGroup = null;
/** @type {any} the shrinking preview flying back into its slot (P3) */
let flyBack = null;
/** latch count, for the suites (each latch = one detent) */
let latches = 0;

/** the objects' world scale (the world rig shrinks it in miniature mode) */
function groupWorldScale() {
	const group = liveGroup ?? get(objectsGroup);
	if (!group) return 1;
	group.getWorldScale(_groupScale);
	return _groupScale.x || 1;
}

/**
 * Detach a ghost into a held preview at GHOST size on the taking hand. Pure state + scene-root mesh work
 * so headless tests can drive it with synthetic controller poses.
 * @param {{kind?: string, slot?: any}} entry
 * @param {{position: any, quaternion: any}} controllerPose world pose of the taking controller
 * @param {{hand?: 'left'|'right'|null, index?: number, slotNode?: any, contact?: boolean}} [source]
 * @returns {boolean}
 */
export function beginHoldEntry(entry, controllerPose, source = {}) {
	if (!get(vrSleeveEnabled) || hold) return false;
	const scene = get(globalScene);
	if (!scene) return false;
	if (flyBack) finishFlyBack();
	const mesh = previewFor(entry);
	// measure at the object's own origin: true size (its own scale), radius about the origin
	mesh.position.set(0, 0, 0);
	mesh.quaternion.identity();
	mesh.updateMatrixWorld(true);
	const box = new THREE.Box3().setFromObject(mesh);
	const extent = box.getSize(new THREE.Vector3());
	const maxExtent = Math.max(extent.x, extent.y, extent.z, 1e-6);
	hold = {
		mesh,
		kind: entry.kind ?? null,
		slot: entry.slot ?? null,
		hand: source.hand ?? null,
		index: source.index ?? -1,
		slotNode: source.slotNode ?? null,
		contact: !!source.contact,
		baseScale: mesh.scale.clone(),
		trueRadius: originRadius(box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z),
		ghostFactor: GHOST_SIZE / maxExtent,
		factor: GHOST_SIZE / maxExtent,
		t: 0,
		latched: false,
		armed: false,
		offset: 0,
		userScale: 1,
		viewDeg: 0,
		lastAt: 0
	};
	scene.add(mesh);
	poseHeld(controllerPose.position, controllerPose.quaternion, null);
	hapticPulse(0.3, 30);
	return true;
}

/** Is a sleeve preview currently held? (navigation suppressor + tests) */
export function sleeveHoldActive() {
	return !!hold;
}

/** place the held preview from the hand pose (factor already set) @param {any} handPos @param {any} handQuat @param {any} headPos */
function poseHeld(handPos, handQuat, headPos) {
	const radius = hold.trueRadius * hold.factor;
	_dir.set(0, 0, -1).applyQuaternion(handQuat);
	const e = headPos ?? handPos; // no head known: only the in-front-of-the-hand gap applies
	const offset = headPos
		? clampedOffset(handPos.x, handPos.y, handPos.z, _dir.x, _dir.y, _dir.z, e.x, e.y, e.z, radius, hold.latched ? hold.offset : 0)
		: Math.max(hold.latched ? hold.offset : 0, radius + 0.04);
	if (hold.latched && offset > hold.offset) hold.offset = offset; // the clamp is the reel's floor
	hold.mesh.position.copy(handPos).addScaledVector(_dir, offset);
	hold.mesh.quaternion.copy(handQuat);
	hold.mesh.scale.copy(hold.baseScale).multiplyScalar(hold.factor);
	if (headPos) hold.viewDeg = viewAngleDeg(radius, hold.mesh.position.distanceTo(headPos));
	return offset;
}

/**
 * One frame of the held preview (P1-P3). Growth follows the taking hand's distance from the sleeve
 * WRIST; full size latches (a detent tick) and from then on the grabbing hand's stick reels (Y) and
 * scales (X) it through grip-move's own grabStickAdjust; the hand back at the wrist cancels.
 * @param {any} handPos world @param {any} handQuat world
 * @param {{wrist?: any, head?: any, axes?: ArrayLike<number> | null, dt?: number, groupScale?: number}} [frame]
 *   wrist = the sleeve wrist (no wrist: grows straight to full), head = the eye (the 50° clamp),
 *   axes = the taking hand's gamepad axes (xr-standard: [2] X, [3] Y), dt seconds, groupScale = the world's scale
 * @returns {'hold' | 'latched' | 'cancel' | null}
 */
export function updateHeldPose(handPos, handQuat, frame = {}) {
	if (!hold) return null;
	const wrist = frame.wrist ?? null;
	const d = wrist ? handPos.distanceTo(wrist) : GROW_FAR;
	if (wrist) {
		const step = cancelStep(d, hold.armed);
		if (step === 1) hold.armed = true;
		else if (step === 2) {
			cancelSleeveHold();
			return 'cancel';
		}
	}
	const now = performance.now();
	const dt = frame.dt ?? (hold.lastAt ? (now - hold.lastAt) / 1000 : 1 / 72);
	hold.lastAt = now;
	const worldScale = frame.groupScale ?? groupWorldScale();
	if (!hold.latched) {
		hold.t = stepGrowth(hold.t, growthTarget(d), dt);
		if (hold.t >= 1) {
			hold.latched = true;
			latches++;
			// the detent: forced, the one pulse an Edit-mode feature gives (the mode-switch tick's rule)
			hapticPulse(0.5, 14, hold.hand ?? undefined, true);
		}
	} else {
		const axes = frame.axes;
		if (axes && (axes.length ?? 0) > 3) {
			const adjusted = grabStickAdjust({ length: Math.max(hold.offset, 0.05), scale: hold.userScale, x: axes[2] ?? 0, y: axes[3] ?? 0 });
			hold.offset = adjusted.length;
			hold.userScale = adjusted.scale;
		}
	}
	hold.factor = growthFactor(hold.t, hold.ghostFactor, worldScale * hold.userScale);
	poseHeld(handPos, handQuat, frame.head ?? null);
	return hold.latched ? 'latched' : 'hold';
}

/** P3: cancel the hold — the preview shrinks and flies back into its slot (nothing is created) */
export function cancelSleeveHold() {
	if (!hold) return false;
	const { mesh, slotNode, baseScale, ghostFactor } = hold;
	hold = null;
	handledAt = Date.now();
	flyBack = {
		mesh,
		slotNode,
		from: mesh.position.clone(),
		fromScale: mesh.scale.clone(),
		toScale: baseScale.clone().multiplyScalar(ghostFactor),
		startedAt: performance.now(),
		ms: motionMs(FLY_BACK_MS)
	};
	stepFlyBack(flyBack.startedAt);
	return true;
}

/** one frame of the fly-back @param {number} now ms */
function stepFlyBack(now) {
	if (!flyBack) return;
	const p = flyBackProgress(now - flyBack.startedAt, flyBack.ms);
	if (p >= 1) {
		finishFlyBack();
		return;
	}
	const { mesh } = flyBack;
	if (flyBack.slotNode?.parent) flyBack.slotNode.getWorldPosition(_slotPos);
	else _slotPos.copy(flyBack.from);
	mesh.position.copy(flyBack.from).lerp(_slotPos, p);
	mesh.scale.copy(flyBack.fromScale).lerp(flyBack.toScale, p);
}

function finishFlyBack() {
	if (!flyBack) return;
	const { mesh } = flyBack;
	flyBack = null;
	mesh.parent?.remove(mesh);
	disposeTree(mesh);
}

/** Apply the release pose to a freshly created object: world → objectsGroup
 * local, snap per vrSnapMode (grid rounds x/z, surface rests it), then ONE
 * final replicated transform + undo entry. `scale` multiplies the object's own
 * scale and is already in objectsGroup-local terms. @param {any} object @param {any} pose @param {number} scale */
function applyPlacement(object, pose, scale) {
	const group = get(objectsGroup);
	if (!group) return;
	const before = {
		pos: object.position.toArray(),
		rot: [object.rotation.x, object.rotation.y, object.rotation.z],
		scale: object.scale.toArray()
	};
	group.updateMatrixWorld(true);
	object.position.copy(group.worldToLocal(pose.position.clone()));
	const groupQuat = group.getWorldQuaternion(new THREE.Quaternion()).invert();
	object.quaternion.copy(groupQuat.multiply(pose.quaternion));
	object.scale.multiplyScalar(scale);
	// placement RESPECTS the snap settings, exactly like a grip-grab drop
	if (get(vrSnapMode) === 'surface') {
		dropToSurface(object, group);
	} else if (get(snapEnabled)) {
		const step = get(snapSettings).translate;
		object.position.x = Math.round(object.position.x / step) * step;
		object.position.z = Math.round(object.position.z / step) * step;
	}
	object.updateMatrix();
	pokeScene();
	/** @type {any} */
	const peer = get(peers);
	if (peer)
		peer.send({
			type: 'move',
			uuid: object.uuid,
			pos: object.position.toArray(),
			rot: [object.rotation.x, object.rotation.y, object.rotation.z],
			scale: object.scale.toArray()
		});
	recordTransform({
		uuid: object.uuid,
		before,
		after: {
			pos: object.position.toArray(),
			rot: [object.rotation.x, object.rotation.y, object.rotation.z],
			scale: object.scale.toArray()
		}
	});
}

/**
 * Release the held preview. place=true creates the primitive (or instantiates
 * the slot prefab) at the preview's world pose AND world size (true size × the
 * world's scale × the stick scale — so it lands at true size in a miniature world
 * too); create + transform commit as ONE undo batch. place=false cancels with no
 * fly-back (teardown).
 * @param {boolean} [place]
 * @returns {any|null} the created object (or null)
 */
export function releaseSleeveHold(place = true) {
	if (!hold) return null;
	const { mesh, kind, slot, factor } = hold;
	hold = null;
	handledAt = Date.now();
	const pose = {
		position: mesh.getWorldPosition(new THREE.Vector3()),
		quaternion: mesh.getWorldQuaternion(new THREE.Quaternion())
	};
	mesh.parent?.remove(mesh);
	disposeTree(mesh);
	if (!place) return null;
	// the preview lives at the scene root; the objects under the (maybe shrunk) world rig
	const scale = placementScale(factor, groupWorldScale());
	/** @type {any} */
	const peer = get(peers);
	let created = null;
	beginHistoryBatch();
	try {
		if (kind) {
			const command = ('/create ' + kind + ' ' + (DEFAULT_PARAMS[kind] ?? []).join(' ')).trim();
			const uuid = crypto.randomUUID();
			createGeometry(command, uuid);
			created = get(objectsGroup)?.getObjectByProperty('uuid', uuid) ?? null;
			if (created) {
				if (peer) peer.send({ type: 'create', command, uuid });
				recordObjectPresence('create', created);
				applyPlacement(created, pose, scale);
			}
		} else if (slot) {
			// replicated instantiate (fresh uuids) + the same snap-on-release rules
			created = instantiatePrefab(slot, undefined);
			if (created) applyPlacement(created, pose, scale);
		}
	} finally {
		endHistoryBatch('VR sleeve place');
	}
	if (created) hapticPulse(0.35, 40);
	return created;
}

/** the end of a take's button (trigger, pinch or grip): a latched hold places, an unlatched one cancels */
function finishHold() {
	if (!hold) return;
	if (hold.latched) releaseSleeveHold(true);
	else cancelSleeveHold();
}

/** Scene.svelte guard: the trailing 'select' click of a pick/place/clear must
 * not fall through to raycastSelect. @returns {boolean} */
export function vrSleeveSwallowSelect() {
	return Date.now() - handledAt < 300;
}

// ---- controller-facing wrappers (thin; the math above is the tested part) ----

/** @param {number} index @returns {any} a THREE.Raycaster along that controller */
function controllerRay(index) {
	const renderer = get(globalRenderer);
	const controller = renderer?.xr?.getController(index);
	if (!controller) return null;
	controller.updateWorldMatrix(true, false);
	const origin = controller.getWorldPosition(new THREE.Vector3());
	const rotation = new THREE.Matrix4().extractRotation(controller.matrixWorld);
	const direction = new THREE.Vector3(0, 0, -1).applyMatrix4(rotation).normalize();
	const ray = new THREE.Raycaster(origin, direction);
	ray.far = 5;
	return ray;
}

/** @param {number} index */
function controllerPose(index) {
	const renderer = get(globalRenderer);
	const controller = renderer?.xr?.getController(index);
	if (!controller) return null;
	return {
		position: controller.getWorldPosition(new THREE.Vector3()),
		quaternion: controller.getWorldQuaternion(new THREE.Quaternion()),
		hand: controller.userData?.handedness ?? null
	};
}

/** the sleeve's takeable nodes (primitive ghosts + custom slot holders) */
function slotNodes() {
	return sleeveGroup ? sleeveGroup.children.filter((/** @type {any} */ c) => c.userData.sleeveKind || c.name.startsWith('vrsleeve-slot:')) : [];
}

/**
 * P4: the slot a hand at `point` (world) is touching — the nearest within CONTACT_RANGE, else null.
 * @param {any} point
 */
export function sleeveSlotAt(point) {
	if (!sleeveGroup?.parent || !sleeveGroup.visible) return null;
	let best = null;
	let bestD = CONTACT_RANGE;
	for (const node of slotNodes()) {
		const d = node.getWorldPosition(_slotPos).distanceTo(point);
		if (d < bestD) {
			bestD = d;
			best = node;
		}
	}
	return best;
}

/** take `node` with controller slot `index` @param {any} node @param {number} index @param {boolean} contact */
function takeNode(node, index, contact) {
	const pose = controllerPose(index);
	if (!pose) return false;
	const source = { hand: pose.hand, index, slotNode: node, contact };
	if (node.name.startsWith('vrsleeve-slot:')) {
		const slot = get(sleeveSlots).find((s) => s.id === node.userData.sleeveSlotId);
		return slot ? beginHoldEntry({ slot }, pose, source) : false;
	}
	const kind = node.userData.sleeveKind;
	return kind ? beginHoldEntry({ kind }, pose, source) : false;
}

/** the hand that is NOT wearing the sleeve may take from it @param {number} index */
function isTakingHand(index) {
	return index >= 0 && index !== controllerIndexFor(sleeveHand());
}

/** selectstart hook (a trigger press, or a PINCH on a tracked hand): the ray on a sleeve node takes it
 * from a distance (or clears a slot), the hand AT a slot takes it directly. Returns true when consumed.
 * @param {number} index */
export function vrSleeveTriggerStart(index) {
	if (!get(vrSleeveEnabled) || !sleeveGroup?.parent || hold) return false;
	const ray = controllerRay(index);
	if (!ray) return false;
	const hits = sleeveGroup.visible ? ray.intersectObject(sleeveGroup, true) : [];
	const node = hits.length ? sleeveNodeOf(hits[0].object) : null;
	if (node?.name.startsWith('vrsleeve-clear:')) {
		clearSlot(node.name.slice('vrsleeve-clear:'.length));
		handledAt = Date.now();
		hapticPulse(0.25, 30);
		return true;
	}
	if (node) return takeNode(node, index, false);
	// P4: no ray hit — a hand (a pinch) AT a slot takes it directly
	if (!isTakingHand(index)) return false;
	const touched = sleeveSlotAt(ray.ray.origin);
	return touched ? takeNode(touched, index, true) : false;
}

/** selectend hook: releasing the trigger places a latched preview, cancels an unlatched one. @param {number} index */
export function vrSleeveTriggerEnd(index) {
	if (!hold) return false;
	if (hold.index >= 0 && index >= 0 && hold.index !== index) return false;
	finishHold();
	return true;
}

/** P4 grip hook: a grip with the taking hand AT a slot (< 4 cm) is a direct take — claimed BEFORE any
 * grab or the 52 V5 world grab sees the squeeze (the contact zone wins). @param {number} index */
export function vrSleeveGripStart(index) {
	if (!get(vrSleeveEnabled) || !sleeveGroup?.parent || hold || !isTakingHand(index)) return false;
	const renderer = get(globalRenderer);
	const controller = renderer?.xr?.getController(index);
	if (!controller) return false;
	const touched = sleeveSlotAt(controller.getWorldPosition(new THREE.Vector3()));
	return touched ? takeNode(touched, index, true) : false;
}

/** the grip's release ends a grip take (place when latched, else cancel) @param {number} index */
export function vrSleeveGripEnd(index) {
	if (!hold || hold.index !== index) return false;
	finishHold();
	return true;
}

// ---- K2: custom slots ----------------------------------------------------------

export async function loadSleeveSlots() {
	if (slotsLoaded || typeof indexedDB === 'undefined') return;
	slotsLoaded = true;
	try {
		sleeveSlots.set((await idbGet(SLOTS_KEY)) ?? []);
	} catch (error) {
		console.log('sleeve slots load failed', error);
	}
	rebuildCustomRow();
}

async function persistSlots() {
	try {
		await idbPut(SLOTS_KEY, get(sleeveSlots));
	} catch (error) {
		console.log('sleeve slots persist failed', error);
	}
}

/**
 * Capture an object into a custom slot (prefab snapshot — groups work too,
 * 5 MB cap, LOCAL only). @param {any} object @returns {boolean}
 */
export function captureSlotFromObject(object) {
	if (!object) return false;
	if (get(sleeveSlots).length >= SLEEVE_MAX_SLOTS) {
		showToast('Sleeve is full — clear a slot first (' + SLEEVE_MAX_SLOTS + ' max)');
		return false;
	}
	let element;
	// a slot is a prefab snapshot, so it carries whatever the tree carries: park
	// the mesh-edit wireframe first or the slot spawns a permanently wireframed
	// copy for everyone (editOverlays.js)
	const unpark = parkEditOverlays(object);
	try {
		element = object.toJSON();
	} catch {
		return false;
	} finally {
		unpark();
	}
	if (JSON.stringify(element).length > 5_000_000) {
		showToast('Object is too large for a sleeve slot (>5 MB)');
		return false;
	}
	const entry = { id: crypto.randomUUID().slice(0, 8), name: object.name || object.type, element };
	sleeveSlots.update((list) => [...list, entry]);
	persistSlots();
	rebuildCustomRow();
	showToast('Captured "' + entry.name + '" into your sleeve');
	return true;
}

/** Remove a custom slot (the ✕ chip). @param {string} id */
export function clearSlot(id) {
	sleeveSlots.update((list) => list.filter((s) => s.id !== id));
	persistSlots();
	rebuildCustomRow();
}

/**
 * Grip-release interceptor: an object dropped ONTO the strip captures a slot;
 * the object snaps back to where the grab started (the drop is a gesture, not
 * a move). Returns true when captured. @param {any} object @param {any} before
 */
export function sleeveGripDrop(object, before) {
	if (!get(vrSleeveEnabled) || !sleeveGroup?.parent || !object) return false;
	const box = new THREE.Box3().setFromObject(sleeveGroup).expandByScalar(CAPTURE_RANGE);
	const position = object.getWorldPosition(new THREE.Vector3());
	if (!box.containsPoint(position)) return false;
	if (!captureSlotFromObject(object)) return false;
	// restore the pre-grab pose + rebroadcast so peers snap back too
	if (before?.pos) object.position.fromArray(before.pos);
	if (before?.rot) object.rotation.set(before.rot[0], before.rot[1], before.rot[2]);
	if (before?.scale) object.scale.fromArray(before.scale);
	pokeScene();
	/** @type {any} */
	const peer = get(peers);
	if (peer)
		peer.send({
			type: 'move',
			uuid: object.uuid,
			pos: object.position.toArray(),
			rot: [object.rotation.x, object.rotation.y, object.rotation.z],
			scale: object.scale.toArray()
		});
	resumeAnimation(object.uuid);
	return true;
}

// ---- lifecycle ------------------------------------------------------------------

/** Per-frame: anchor the strip to the live sleeve-hand controller, hide it
 * while the radial owns that hand, and drive the held preview (no allocations). */
export function updateVRSleeve() {
	const renderer = get(globalRenderer);
	const presenting = !!renderer?.xr?.isPresenting;
	if (!presenting || !get(vrSleeveEnabled)) {
		if (sleeveGroup?.parent) sleeveGroup.parent.remove(sleeveGroup);
		if (hold) releaseSleeveHold(false);
		finishFlyBack();
		return;
	}
	if (flyBack) stepFlyBack(performance.now());
	const hand = sleeveHand();
	const index = controllerIndexFor(hand);
	if (index < 0) return;
	const controller = renderer.xr.getController(index);
	if (!controller) return;
	ensureSleeveGroup();
	if (sleeveGroup.parent !== controller) {
		sleeveGroup.parent?.remove(sleeveGroup);
		controller.add(sleeveGroup);
	}
	sleeveGroup.visible = !(get(vrMenuOpen) && get(vrMenuHand) === hand);
	if (!hold || hold.index < 0) return;
	const taker = renderer.xr.getController(hold.index);
	if (!taker) return;
	taker.getWorldPosition(_handPos);
	taker.getWorldQuaternion(_handQuat);
	controller.getWorldPosition(_wristPos);
	const cam = renderer.xr.getCamera();
	cam.getWorldPosition(_headPos);
	frameInput.wrist = _wristPos;
	frameInput.head = _headPos;
	// P2: grip-move's sticks, read the grip way (axesForSlot), only once it is a grab
	frameInput.axes = hold.latched ? axesForSlot(hold.index) : null;
	updateHeldPose(_handPos, _handQuat, frameInput);
}
/** the frame's reused input record @type {{wrist: any, head: any, axes: any}} */
const frameInput = { wrist: null, head: null, axes: null };

/** Debug/test view. */
export function sleeveState() {
	return {
		enabled: get(vrSleeveEnabled),
		attached: !!sleeveGroup?.parent,
		ghosts: sleeveGroup ? sleeveGroup.children.filter((/** @type {any} */ c) => c.name.startsWith('vrsleeve-')).map((/** @type {any} */ c) => c.name) : [],
		holding: hold
			? {
					kind: hold.kind,
					slot: hold.slot?.id ?? null,
					t: hold.t,
					latched: hold.latched,
					armed: hold.armed,
					contact: hold.contact,
					factor: hold.factor,
					userScale: hold.userScale,
					offset: hold.offset,
					viewDeg: hold.viewDeg,
					index: hold.index
				}
			: null,
		flyingBack: !!flyBack,
		latches,
		slots: get(sleeveSlots).map((s) => s.id)
	};
}

/** Wire the sleeve into the VR interaction loop (called by the vrsleeve core
 * module's register — if the module is disabled, none of this exists).
 * 34 R6: returns the UNDO — every hook removed, a held preview cancelled, the strip taken
 * off the controller and its GPU resources freed — so the module unloads live.
 * @returns {() => void} */
export function registerVRSleeve() {
	if (registered) return () => {};
	registered = true;
	const offs = [
		registerNavSuppressor(() => !!hold),
		registerPanelGroupProvider(() =>
			get(vrSleeveEnabled) && sleeveGroup?.parent && sleeveGroup.visible ? sleeveGroup : null
		),
		registerVRTriggerHooks({
			start: vrSleeveTriggerStart,
			end: vrSleeveTriggerEnd,
			swallow: vrSleeveSwallowSelect
		}),
		registerGripHooks({ start: vrSleeveGripStart, end: vrSleeveGripEnd }),
		registerGripDropHook(sleeveGripDrop),
		registerVRFrameHook(updateVRSleeve),
		objectsGroup.subscribe((group) => (liveGroup = group))
	];
	loadSleeveSlots();
	return () => {
		if (!registered) return;
		registered = false;
		offs.forEach((off) => off());
		releaseSleeveHold(false);
		finishFlyBack();
		liveGroup = null;
		if (sleeveGroup) {
			sleeveGroup.parent?.remove(sleeveGroup);
			disposeTree(sleeveGroup);
			sleeveGroup = null;
		}
	};
}
