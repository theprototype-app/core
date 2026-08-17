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
	vrSleeveEnabled
} from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { parkEditOverlays } from './editOverlays';
import { snapEnabled, snapSettings, dropToSurface } from './snapping';
import { beginHistoryBatch, endHistoryBatch, recordTransform, recordObjectPresence } from './history';
import { createGeometry } from './geometries.svelte';
import { customGeometryBuilders } from './customGeometries';
import {
	controllerIndexFor,
	rigidGrabPose,
	hapticPulse,
	registerNavSuppressor,
	registerPanelGroupProvider,
	registerVRTriggerHooks,
	registerGripDropHook,
	registerVRFrameHook
} from './vrControls';
import { resumeAnimation } from './flowRuntime';
import { instantiatePrefab } from './prefabs';
import { getInput } from './inputRuntime';
import { idbGet, idbPut } from './idb';

// K (roadmap 13): VR sleeve palette — a FLAT STRIP of ghost mini-primitives
// riding up the sleeve-hand forearm like a bracer (slots wrist → elbow).
// Point + TRIGGER on a ghost detaches a held preview that rigid-follows the
// grabbing controller (stick-Y scales it, wrist motion rotates 1:1); releasing
// the trigger creates the primitive at the preview's world pose with the same
// vrSnapMode rules as a grip-grab drop, as ONE undo batch. K2 adds CUSTOM
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
const HOLD_SCALE_MIN = 0.2;
const HOLD_SCALE_MAX = 5;
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
/** @type {any} held preview: {mesh, kind?, slot?, hand, index, relPos, relQuat, scale} */
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
			ghost = ghostify(new THREE.ObjectLoader().parse(slot.element));
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

// ---- K1: hold / place ---------------------------------------------------------

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
		object = ghostify(new THREE.ObjectLoader().parse(entry.slot.element));
	} catch {
		object = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), ghostMaterial(0xbfd6ff));
	}
	object.name = 'vrsleeve-preview';
	return object;
}

/**
 * Detach a ghost into a held preview. Pure state + scene-root mesh work so
 * headless tests can drive it with synthetic controller poses.
 * @param {{kind?: string, slot?: any}} entry
 * @param {{position: any, quaternion: any}} controllerPose world pose of the grabbing controller
 * @param {{hand?: 'left'|'right', index?: number}} [source]
 * @returns {boolean}
 */
export function beginHoldEntry(entry, controllerPose, source = {}) {
	if (!get(vrSleeveEnabled) || hold) return false;
	const scene = get(globalScene);
	if (!scene) return false;
	const mesh = previewFor(entry);
	// the preview appears ~0.9 m along the grabbing controller's ray and
	// rigid-follows it from there (wrist motion rotates it 1:1)
	const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(controllerPose.quaternion);
	mesh.position.copy(controllerPose.position).add(dir.multiplyScalar(0.9));
	mesh.quaternion.copy(controllerPose.quaternion);
	scene.add(mesh);
	const invQuat = controllerPose.quaternion.clone().invert();
	hold = {
		mesh,
		kind: entry.kind ?? null,
		slot: entry.slot ?? null,
		hand: source.hand ?? null,
		index: source.index ?? -1,
		relPos: mesh.position.clone().sub(controllerPose.position).applyQuaternion(invQuat),
		relQuat: invQuat.clone().multiply(mesh.quaternion),
		scale: 1
	};
	hapticPulse(0.3, 30);
	return true;
}

/** Is a sleeve preview currently held? (navigation suppressor + tests) */
export function sleeveHoldActive() {
	return !!hold;
}

/**
 * One frame of the held preview: rigid-follow the controller pose; the
 * grabbing hand's stick Y scales the preview (deadzone 0.15, clamp 0.2–5).
 * @param {any} controllerPos world @param {any} controllerQuat world
 * @param {number} [stickY]
 */
export function updateHeldPose(controllerPos, controllerQuat, stickY = 0) {
	if (!hold) return;
	const pose = rigidGrabPose(controllerPos, controllerQuat, hold.relPos, hold.relQuat);
	hold.mesh.position.copy(pose.position);
	hold.mesh.quaternion.copy(pose.quaternion);
	const y = Math.abs(stickY) > 0.15 ? stickY : 0;
	if (y) hold.scale = Math.min(Math.max(hold.scale * (1 - y * 0.02), HOLD_SCALE_MIN), HOLD_SCALE_MAX);
	hold.mesh.scale.setScalar(hold.scale);
}

/** Apply the release pose to a freshly created object: world → objectsGroup
 * local, snap per vrSnapMode (grid rounds x/z, surface rests it), then ONE
 * final replicated transform + undo entry. @param {any} object @param {any} pose @param {number} scale */
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
	objectsGroup.update((v) => v);
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
 * the slot prefab) at the preview's world pose — create + transform commit as
 * ONE undo batch; place=false just cancels.
 * @param {boolean} [place]
 * @returns {any|null} the created object (or null)
 */
export function releaseSleeveHold(place = true) {
	if (!hold) return null;
	const { mesh, kind, slot, scale } = hold;
	hold = null;
	handledAt = Date.now();
	const pose = {
		position: mesh.getWorldPosition(new THREE.Vector3()),
		quaternion: mesh.getWorldQuaternion(new THREE.Quaternion())
	};
	mesh.parent?.remove(mesh);
	if (!place) return null;
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

/** selectstart hook: a trigger press on a sleeve node picks it up (or clears a
 * slot). Returns true when consumed. @param {number} index */
export function vrSleeveTriggerStart(index) {
	if (!get(vrSleeveEnabled) || !sleeveGroup?.parent || hold) return false;
	const ray = controllerRay(index);
	if (!ray) return false;
	const hits = ray.intersectObject(sleeveGroup, true);
	const node = hits.length ? sleeveNodeOf(hits[0].object) : null;
	if (!node) return false;
	if (node.name.startsWith('vrsleeve-clear:')) {
		clearSlot(node.name.slice('vrsleeve-clear:'.length));
		handledAt = Date.now();
		hapticPulse(0.25, 30);
		return true;
	}
	const pose = controllerPose(index);
	if (!pose) return false;
	if (node.name.startsWith('vrsleeve-slot:')) {
		const slot = get(sleeveSlots).find((s) => s.id === node.userData.sleeveSlotId);
		return slot ? beginHoldEntry({ slot }, pose, { hand: pose.hand, index }) : false;
	}
	const kind = node.userData.sleeveKind;
	return kind ? beginHoldEntry({ kind }, pose, { hand: pose.hand, index }) : false;
}

/** selectend hook: releasing the trigger places the held preview. @param {number} index */
export function vrSleeveTriggerEnd(index) {
	if (!hold) return false;
	if (hold.index >= 0 && index >= 0 && hold.index !== index) return false;
	releaseSleeveHold(true);
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
	objectsGroup.update((v) => v);
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
 * while the radial owns that hand, and drive the held preview. */
export function updateVRSleeve() {
	const renderer = get(globalRenderer);
	const presenting = !!renderer?.xr?.isPresenting;
	if (!presenting || !get(vrSleeveEnabled)) {
		if (sleeveGroup?.parent) sleeveGroup.parent.remove(sleeveGroup);
		if (hold) releaseSleeveHold(false);
		return;
	}
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
	if (hold) {
		const pose = hold.index >= 0 ? controllerPose(hold.index) : null;
		if (!pose) return;
		const axes = getInput().axes ?? {};
		const stickY = (pose.hand ?? hold.hand) === 'left' ? (axes.ly ?? 0) : (axes.ry ?? 0);
		updateHeldPose(pose.position, pose.quaternion, stickY);
	}
}

/** Debug/test view. */
export function sleeveState() {
	return {
		enabled: get(vrSleeveEnabled),
		attached: !!sleeveGroup?.parent,
		ghosts: sleeveGroup ? sleeveGroup.children.filter((/** @type {any} */ c) => c.name.startsWith('vrsleeve-')).map((/** @type {any} */ c) => c.name) : [],
		holding: hold ? { kind: hold.kind, slot: hold.slot?.id ?? null, scale: hold.scale } : null,
		slots: get(sleeveSlots).map((s) => s.id)
	};
}

/** Wire the sleeve into the VR interaction loop (called by the vrsleeve core
 * module's register — if the module is disabled, none of this exists). */
export function registerVRSleeve() {
	if (registered) return;
	registered = true;
	registerNavSuppressor(() => !!hold);
	registerPanelGroupProvider(() =>
		get(vrSleeveEnabled) && sleeveGroup?.parent && sleeveGroup.visible ? sleeveGroup : null
	);
	registerVRTriggerHooks({
		start: vrSleeveTriggerStart,
		end: vrSleeveTriggerEnd,
		swallow: vrSleeveSwallowSelect
	});
	registerGripDropHook(sleeveGripDrop);
	registerVRFrameHook(updateVRSleeve);
	loadSleeveSlots();
}
