// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene, globalRenderer, objectsGroup } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { hapticPulse, registerNavSuppressor, registerVRTriggerHooks, registerVRFrameHook } from './vrControls';
import { beginHistoryBatch, endHistoryBatch } from './history';
import { isDeviceObject, deviceSpec, deviceOf, setDeviceFor, previewDeviceParams } from './audioDevices';
import { addCable, removeCable, cablesOf, setCableHidden, PORT_COLORS } from './audioPatch';
// The DESKTOP path reaches the mouse ray and the click dispatch through a primed dynamic
// import (the moduleSDK precedent) — a static edge into that module is a cycle risk.
/** @type {any} */ let sdkRef = null;
import('./moduleSDK').then((m) => (sdkRef = m));

// VR PATCHING (roadmap #23 B1, cloud plans-core/pending/23-b-interfaces.md).
//
// `vrSleeve.js` is the template and this is a PORT, not a build: the same five hook
// registries, the same hold-state shape, the same scene-root preview, the same
// synthetic-pose seams a headless suite drives. Nothing here touches vrControls'
// gesture code — module trigger hooks are dispatched FIRST in Scene.svelte, so a
// plug or a knob under the ray wins cleanly over vertex grab, stretch and box select.
//
//   PLUGS  child meshes of a device named `vrpatch-out:<port>` / `vrpatch-in:<port>`
//          (the vr<panel>-<action> convention: the mesh name carries the action). A
//          hit resolves by walking UP the parent chain to the first `vrpatch-` name —
//          a plug is a nested mesh and the raycast hits its geometry. `addDevice`
//          adds default plugs for every declared port a mesh does not draw itself.
//   CABLE  trigger-press on a plug starts a hold; the free end rides the controller
//          each frame and a dangling preview is drawn AT THE SCENE ROOT (never in
//          objectsGroup — a cable mid-pull must never enter GLTF sync); trigger
//          release on a COMPATIBLE plug (opposite side, same port kind) writes ONE
//          cable, one undo entry. Pressing on an IN plug that already holds a cable
//          picks that cable up: dropping it on another IN re-plugs it (remove + add
//          in ONE history batch), dropping it nowhere unplugs it. The document is
//          untouched until release — the picked cable is only HIDDEN while held, so
//          the route keeps sounding until the hand decides.
//   KNOBS  child meshes named `vrknob:<paramKey>`: the stretch-slider state machine
//          over the same hooks. Vertical controller motion drives the value (a 25 cm
//          sweep is the whole range), a haptic tick per step crossed, the replicated
//          write THROTTLED to ~15 Hz through a history-free preview, and ONE exact
//          `setDeviceFor` on release carrying the value the gesture STARTED from as
//          its `before` — a knob turned at headset framerate is 90 writes a second.
//   MOUSE   the same hold state without VR: a LEFT CLICK on a plug arms it (the wire then
//          follows the mouse ray at the plug's depth), a click on a compatible plug
//          connects, Escape or a click on anything else cancels; clicking a plugged
//          INPUT picks its cable up, clicking that same input again unplugs it. Wired
//          into the module click dispatch, which Play mode's tap and the editor's
//          click both route through, so it works from the moment you hit Play.
//   GUARDS `end` is honoured only for the hand that started (`hold.index`), so the
//          other hand's trigger does not drop what you are holding; the trailing
//          'select' is swallowed for 300 ms after a gesture (`handledAt`); navigation
//          is suppressed while anything is held.

/** the two names a plug can carry, by side */
const PLUG_PREFIX = { out: 'vrpatch-out:', in: 'vrpatch-in:' };
const KNOB_PREFIX = 'vrknob:';
/** how many metres of vertical travel sweep a knob's whole range */
const KNOB_SWEEP_M = 0.25;
/** replicated knob writes at most this often while held (one exact write on release) */
const KNOB_SEND_MS = 66;
const SWALLOW_MS = 300;
const CABLE_RADIUS = 0.02;

// ---- resolution (pure) ---------------------------------------------------------------

/** Walk a raycast hit up to the named plug node, or null. @param {any} object */
export function plugNodeOf(object) {
	let node = object;
	while (node) {
		if (typeof node.name === 'string' && node.name.startsWith('vrpatch-')) return node;
		node = node.parent;
	}
	return null;
}

/** Walk a raycast hit up to the named knob node, or null. @param {any} object */
export function knobNodeOf(object) {
	let node = object;
	while (node) {
		if (typeof node.name === 'string' && node.name.startsWith(KNOB_PREFIX)) return node;
		node = node.parent;
	}
	return null;
}

/** The device object a node belongs to (itself or an ancestor). @param {any} node */
export function deviceObjectOf(node) {
	let cursor = node;
	while (cursor) {
		if (isDeviceObject(cursor)) return cursor;
		cursor = cursor.parent;
	}
	return null;
}

/**
 * @typedef {{node: any, device: any, uuid: string, side: 'out'|'in', port: string, kind: string}} PlugInfo
 * @typedef {{node: any, device: any, uuid: string, key: string, param: any}} KnobInfo
 */

/** Everything about a plug node: which device, which side, which port, which KIND
 * (from the device's registered spec; 'audio' when unknown). @param {any} node
 * @returns {PlugInfo|null} */
export function plugInfo(node) {
	if (!node || typeof node.name !== 'string') return null;
	const side = node.name.startsWith(PLUG_PREFIX.out) ? 'out' : node.name.startsWith(PLUG_PREFIX.in) ? 'in' : null;
	if (!side) return null;
	const port = node.name.slice(PLUG_PREFIX[side].length) || 'main';
	const device = deviceObjectOf(node);
	if (!device) return null;
	const spec = deviceSpec(device.userData.device.kind);
	const declared = spec?.ports?.[side]?.find((p) => p.id === port);
	return { node, device, uuid: device.uuid, side, port, kind: declared?.kind ?? 'audio' };
}

/** @param {any} node @returns {KnobInfo|null} */
export function knobInfo(node) {
	if (!node || typeof node.name !== 'string' || !node.name.startsWith(KNOB_PREFIX)) return null;
	const key = node.name.slice(KNOB_PREFIX.length);
	const device = deviceObjectOf(node);
	if (!device || !key) return null;
	const spec = deviceSpec(device.userData.device.kind);
	const param = spec?.params?.find((p) => p.key === key) ?? null;
	return { node, device, uuid: device.uuid, key, param };
}

/** The plug under a ray, if any. @param {any} ray a THREE.Raycaster @returns {PlugInfo|null} */
export function plugAt(ray) {
	const group = get(objectsGroup);
	if (!ray || !group) return null;
	for (const hit of ray.intersectObject(group, true)) {
		const node = plugNodeOf(hit.object);
		if (node) return plugInfo(node);
	}
	return null;
}

/** The knob under a ray, if any. @param {any} ray @returns {KnobInfo|null} */
export function knobAt(ray) {
	const group = get(objectsGroup);
	if (!ray || !group) return null;
	for (const hit of ray.intersectObject(group, true)) {
		const node = knobNodeOf(hit.object);
		if (node) return knobInfo(node);
	}
	return null;
}

/** Two port kinds may be cabled together only when they agree. @param {string} a @param {string} b */
export function kindsCompatible(a, b) {
	return (a ?? 'audio') === (b ?? 'audio');
}

// ---- controller access (VR only; the suite drives the seams below directly) ---------

/** @param {number} index */
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

// ---- the cable drag ------------------------------------------------------------------

/** @type {{index: number, hand: string|null, from: PlugInfo, picked: any|null, preview: any, free: any}|null} */
let hold = null;
let handledAt = 0;
/** @type {any} */ let previewRoot = null;

function ensurePreviewRoot() {
	const scene = get(globalScene);
	if (!scene) return null;
	if (!previewRoot) {
		previewRoot = new THREE.Group();
		previewRoot.name = 'vr-patch-preview';
		scene.add(previewRoot);
	}
	return previewRoot;
}

const endA = new THREE.Vector3();
const mid = new THREE.Vector3();

/** A hanging tube from a to b (the audioPatch curve, at preview opacity). @param {any} a @param {any} b */
function previewGeometry(a, b) {
	const span = a.distanceTo(b);
	mid.addVectors(a, b).multiplyScalar(0.5);
	mid.y -= Math.min(0.6, 0.15 + span * 0.2);
	return new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a.clone(), mid.clone(), b.clone()), 20, CABLE_RADIUS, 6, false);
}

/** The OUT plug a cable leaves from, resolved from the document (for a picked-up cable).
 * @param {any} cable @returns {PlugInfo|null} */
function outPlugOf(cable) {
	const device = get(objectsGroup)?.getObjectByProperty('uuid', cable.from.uuid);
	if (!device || !isDeviceObject(device)) return null;
	const node = device.getObjectByName(PLUG_PREFIX.out + cable.from.port) ?? device;
	const spec = deviceSpec(device.userData.device.kind);
	const declared = spec?.ports?.out?.find((p) => p.id === cable.from.port);
	return { node, device, uuid: device.uuid, side: 'out', port: cable.from.port, kind: declared?.kind ?? 'audio' };
}

/**
 * Start dragging a cable from a plug. Pure state + scene-root mesh work, so a
 * headless suite drives it with a synthetic pose. Pressing an IN plug that already
 * holds a cable picks THAT cable up (its OUT end becomes the anchor, the cable is
 * hidden until release).
 * @param {PlugInfo|null} plug @param {{position: any, quaternion?: any, hand?: string|null}} pose
 * @param {{index?: number, hand?: string|null}} [source]
 */
export function beginCableDrag(plug, pose, source = {}) {
	if (!plug || hold || knob) return false;
	const root = ensurePreviewRoot();
	if (!root) return false;
	/** @type {PlugInfo} */
	let from = plug;
	/** @type {any} */
	let picked = null;
	if (plug.side === 'in') {
		picked = cablesOf(plug.uuid).find((c) => c.to.uuid === plug.uuid && c.to.port === plug.port) ?? null;
		const anchor = picked ? outPlugOf(picked) : null;
		if (picked && anchor) {
			from = anchor;
			setCableHidden(picked.id, true);
		} else picked = null; // a bare IN plug: drag backwards, the OUT is found on release
	}
	const preview = new THREE.Mesh(
		new THREE.BufferGeometry(),
		new THREE.MeshStandardMaterial({ color: PORT_COLORS[from.kind] ?? '#94a3b8', transparent: true, opacity: 0.7, roughness: 0.6 })
	);
	preview.name = 'vr-patch-cable';
	preview.raycast = () => {};
	root.add(preview);
	hold = { index: source.index ?? -1, hand: source.hand ?? pose.hand ?? null, from, picked, preview, free: pose.position.clone() };
	updateCableDrag(pose);
	hapticPulse(0.3, 30);
	return true;
}

/** One frame of the drag: the free end rides the controller. @param {{position: any}} pose */
export function updateCableDrag(pose) {
	if (!hold || !pose) return;
	hold.free.copy(pose.position);
	hold.from.node.getWorldPosition(endA);
	hold.preview.geometry?.dispose?.();
	hold.preview.geometry = previewGeometry(endA, hold.free);
}

/**
 * Release. `target` is a THREE.Raycaster (the controller ray at release), a PlugInfo,
 * or null (dropped nowhere). Only the hand that started may end (`source.index`).
 * Returns what happened: `{cable}` (plugged / re-plugged), `{unplugged}`, or null.
 * @param {any} target @param {{index?: number}} [source]
 */
export function endCableDrag(target, source = {}) {
	if (!hold) return null;
	if (source.index != null && hold.index >= 0 && source.index !== hold.index) return null; // the other hand
	// a Raycaster has no is-flag in three; the method is the tell
	const plug = target && typeof target.intersectObject === 'function' ? plugAt(target) : target ?? null;
	const current = hold;
	hold = null;
	handledAt = Date.now();
	current.preview.geometry?.dispose?.();
	current.preview.material?.dispose?.();
	previewRoot?.remove(current.preview);
	if (current.picked) setCableHidden(current.picked.id, false);
	return commitCable(current, plug);
}

/** @param {any} current the ended hold @param {PlugInfo|null} plug where it was dropped */
function commitCable(current, plug) {
	const from = current.from;
	const valid =
		!!plug &&
		plug.side !== from.side &&
		!(plug.uuid === from.uuid && plug.port === from.port) &&
		kindsCompatible(from.kind, plug.kind);
	if (current.picked) {
		const picked = current.picked;
		if (!valid) {
			// dropped nowhere (or somewhere it cannot go): the cable is unplugged
			removeCable(picked.id);
			hapticPulse(0.2, 30);
			return { unplugged: picked.id };
		}
		if (plug.uuid === picked.to.uuid && plug.port === picked.to.port) return { cable: picked.id }; // put back where it was
		// re-plug: ONE undo entry for the whole gesture
		beginHistoryBatch();
		removeCable(picked.id);
		const id = addCable({ from: { uuid: from.uuid, port: from.port }, to: { uuid: plug.uuid, port: plug.port }, kind: from.kind });
		endHistoryBatch('Re-plug cable');
		hapticPulse(0.4, 60);
		return { cable: id };
	}
	if (!valid) return null;
	const outEnd = from.side === 'out' ? from : plug;
	const inEnd = from.side === 'out' ? plug : from;
	const id = addCable({ from: { uuid: outEnd.uuid, port: outEnd.port }, to: { uuid: inEnd.uuid, port: inEnd.port }, kind: outEnd.kind });
	hapticPulse(0.4, 60);
	return id ? { cable: id } : null;
}

// ---- the desktop (mouse) path -----------------------------------------------------------

/** the hold index the mouse uses, so a VR hand can never "end" a mouse hold */
const MOUSE = -2;
const ARMED_SCALE = 1.6;
/** @type {any} */ let armedNode = null;

/** @param {any} node @param {boolean} on */
function highlightPlug(node, on) {
	if (!node) return;
	if (on) {
		node.userData.__plugScale = node.scale.clone();
		node.scale.multiplyScalar(ARMED_SCALE);
	} else if (node.userData.__plugScale) {
		node.scale.copy(node.userData.__plugScale);
		delete node.userData.__plugScale;
	}
}

/** Is the mouse holding a wire? (tests, the Escape key) */
export function desktopPatchArmed() {
	return !!hold && hold.index === MOUSE;
}

/** The cable a hold PICKED UP, if any. Its own function because `clickPlug` reads it from
 * inside the `if (!hold)` branch, where the narrowing has already made `hold` never. */
function heldPickedCable() {
	return hold?.picked ?? null;
}

/**
 * A left click on a scene object, from the module click dispatch. Returns true when it
 * was a plug (the click is consumed: no selection, no key press). A click on anything
 * else while a wire is held cancels the wire and is NOT consumed.
 * @param {any} object the exact mesh hit
 */
export function clickPlug(object) {
	const plug = plugInfo(plugNodeOf(object));
	if (!plug) {
		if (desktopPatchArmed()) cancelDesktopPatch();
		return false;
	}
	if (hold && hold.index !== MOUSE) return false; // a VR hand holds one; leave it alone
	if (!hold) {
		const at = new THREE.Vector3();
		plug.node.getWorldPosition(at);
		if (!beginCableDrag(plug, { position: at, hand: 'mouse' }, { index: MOUSE, hand: 'mouse' })) return false;
		armedNode = plug.node;
		highlightPlug(armedNode, true);
		// picking a cable up HIDES it while the mouse holds it, which on its own reads as
		// "my cable disappeared" - say what the three ways out are, once per pick-up
		if (heldPickedCable())
			showToast('Cable held. Click another input to move it, this input again to unplug it, or Escape to put it back.');
		return true;
	}
	// a second click on the very input a picked-up cable came from: UNPLUG it
	if (hold.picked && plug.uuid === hold.picked.to.uuid && plug.port === hold.picked.to.port) {
		highlightPlug(armedNode, false);
		armedNode = null;
		endCableDrag(null, { index: MOUSE });
		return true;
	}
	highlightPlug(armedNode, false);
	armedNode = null;
	endCableDrag(plug, { index: MOUSE });
	return true;
}

/** Escape, or a click elsewhere: drop the wire, change nothing (a picked-up cable goes
 * back where it was). */
export function cancelDesktopPatch() {
	if (!desktopPatchArmed()) return false;
	highlightPlug(armedNode, false);
	armedNode = null;
	cancelCableDrag();
	handledAt = Date.now();
	return true;
}

const mouseEnd = new THREE.Vector3();
const plugWorld = new THREE.Vector3();

/** Per frame while the mouse holds a wire: the free end sits on the mouse ray at the
 * armed plug's distance from the camera, so it reads as following the cursor. */
function updateDesktopPreview() {
	const held = hold;
	if (!held || held.index !== MOUSE || !sdkRef?.pointerRayNow) return;
	const ray = sdkRef.pointerRayNow();
	if (!ray?.ray) return;
	held.from.node.getWorldPosition(plugWorld);
	const depth = Math.max(0.5, ray.ray.origin.distanceTo(plugWorld));
	ray.ray.at(depth, mouseEnd);
	updateCableDrag({ position: mouseEnd });
}

/** Abandon a drag without writing anything (a teardown, a scene clear). */
export function cancelCableDrag() {
	if (!hold) return;
	const current = hold;
	hold = null;
	current.preview.geometry?.dispose?.();
	previewRoot?.remove(current.preview);
	if (current.picked) setCableHidden(current.picked.id, false);
}

// ---- knobs ------------------------------------------------------------------------------

/** @type {{index: number, uuid: string, key: string, param: any, startValue: number, value: number, lastY: number, before: any, lastSent: number}|null} */
let knob = null;

/** @param {any} param @param {number} value */
function snapValue(param, value) {
	const min = typeof param?.min === 'number' ? param.min : 0;
	const max = typeof param?.max === 'number' ? param.max : 1;
	const step = typeof param?.step === 'number' && param.step > 0 ? param.step : 0;
	let v = Math.max(min, Math.min(max, value));
	if (step) v = min + Math.round((v - min) / step) * step;
	return +v.toFixed(6);
}

/**
 * Grab a knob. Records the value the gesture STARTS from, which becomes the undo
 * entry's `before` on release. @param {KnobInfo|null} info @param {{position: any}} pose
 * @param {{index?: number}} [source]
 */
export function beginKnobDrag(info, pose, source = {}) {
	if (!info || knob || hold) return false;
	const doc = deviceOf(info.device);
	if (!doc) return false;
	const param = info.param ?? { min: 0, max: 1, step: 0 };
	const startValue = typeof doc.params[info.key] === 'number' ? doc.params[info.key] : (param.default ?? param.min ?? 0);
	knob = {
		index: source.index ?? -1,
		uuid: info.uuid,
		key: info.key,
		param,
		startValue,
		value: startValue,
		lastY: pose.position.y,
		before: structuredClone(info.device.userData.device),
		lastSent: 0
	};
	hapticPulse(0.2, 20);
	return true;
}

/** One frame of the knob: vertical controller travel drives the value; a haptic tick
 * per step crossed; the replicated write throttled. @param {{position: any}} pose */
export function updateKnobDrag(pose) {
	if (!knob || !pose) return;
	const dy = pose.position.y - knob.lastY;
	if (Math.abs(dy) < 0.0005) return;
	knob.lastY = pose.position.y;
	const min = typeof knob.param.min === 'number' ? knob.param.min : 0;
	const max = typeof knob.param.max === 'number' ? knob.param.max : 1;
	const next = snapValue(knob.param, knob.value + (dy / KNOB_SWEEP_M) * (max - min));
	if (next === knob.value) return;
	knob.value = next;
	hapticPulse(0.15, 15); // a detent: the value crossed a step
	const now = Date.now();
	const broadcast = now - knob.lastSent >= KNOB_SEND_MS;
	if (broadcast) knob.lastSent = now;
	previewDeviceParams(knob.uuid, { [knob.key]: next }, { broadcast });
}

/** Release: ONE exact replicated write, ONE undo entry from the value the gesture
 * started at. Returns `{uuid, key, value}` or null. */
export function endKnobDrag() {
	if (!knob) return null;
	const { uuid, key, value, before, startValue } = knob;
	knob = null;
	handledAt = Date.now();
	setDeviceFor(uuid, { params: { [key]: value } }, { before: value === startValue ? undefined : before });
	return { uuid, key, value };
}

// ---- the hooks -------------------------------------------------------------------------

/** Is anything held? (navigation suppressor + tests) */
export function vrPatchSuppressed() {
	return !!hold || !!knob;
}

/** The trailing 'select' after a gesture must not deselect / pick (Scene asks). */
export function vrPatchSwallowSelect() {
	return Date.now() - handledAt < SWALLOW_MS;
}

/** selectstart: a knob or a plug under the ray starts a gesture. @param {number} index */
export function vrPatchTriggerStart(index) {
	if (hold || knob) return false;
	const ray = controllerRay(index);
	const pose = controllerPose(index);
	if (!ray || !pose) return false;
	const k = knobAt(ray);
	if (k) return beginKnobDrag(k, pose, { index });
	const p = plugAt(ray);
	if (p) return beginCableDrag(p, pose, { index, hand: pose.hand });
	return false;
}

/** selectend: only the hand that started may end. @param {number} index */
export function vrPatchTriggerEnd(index) {
	if (knob) {
		if (knob.index >= 0 && knob.index !== index) return false;
		endKnobDrag();
		return true;
	}
	if (hold) {
		if (hold.index >= 0 && hold.index !== index) return false;
		endCableDrag(controllerRay(index), { index });
		return true;
	}
	return false;
}

/** Per VR frame: the held end and the held knob follow their controller. Only while a
 * session PRESENTS: outside one  still answers with a controller
 * parked at the origin, and following it slammed a knob to its minimum every frame
 * between the synthetic poses a headless suite feeds the seams. */
export function updateVRPatch() {
	updateDesktopPreview();
	if (!get(globalRenderer)?.xr?.isPresenting) return;
	if (hold) {
		const pose = controllerPose(hold.index);
		if (pose) updateCableDrag(pose);
	}
	if (knob) {
		const pose = controllerPose(knob.index);
		if (pose) updateKnobDrag(pose);
	}
}

let registered = false;

/** Wire patching into the VR interaction loop (App boot, once). */
export function registerVRPatch() {
	if (registered || typeof window === 'undefined') return;
	registered = true;
	registerNavSuppressor(vrPatchSuppressed);
	registerVRTriggerHooks({ start: vrPatchTriggerStart, end: vrPatchTriggerEnd, swallow: vrPatchSwallowSelect });
	registerVRFrameHook(updateVRPatch);
	// the desktop path: a plug click through the SAME dispatch Play mode's tap and the
	// editor's click use for module objects, a click on NOTHING through the MISS dispatch
	// (that one never sees a mesh, so a held wire had no way to hear "you clicked the sky"
	// and a picked-up cable stayed hidden and armed for the rest of the session), and
	// Escape to drop a held wire
	import('./moduleSDK').then((m) => {
		if (!m.moduleClickHandlers.includes(clickPlug)) m.moduleClickHandlers.unshift(clickPlug);
		if (!m.moduleClickMissHandlers.includes(cancelDesktopPatch)) m.moduleClickMissHandlers.push(cancelDesktopPatch);
	});
	window.addEventListener('keydown', (event) => {
		if (event.key === 'Escape' && cancelDesktopPatch()) event.stopPropagation();
	}, true);
}

/** Debug/test view. */
export function vrPatchState() {
	return {
		holding: hold
			? { index: hold.index, hand: hold.hand, from: { uuid: hold.from.uuid, port: hold.from.port, side: hold.from.side, kind: hold.from.kind }, picked: hold.picked?.id ?? null, previewVisible: !!hold.preview.parent }
			: null,
		knob: knob ? { index: knob.index, uuid: knob.uuid, key: knob.key, value: knob.value, startValue: knob.startValue } : null,
		desktopArmed: desktopPatchArmed(),
		previewRootParent: previewRoot?.parent?.name ?? null,
		handledAgo: handledAt ? Date.now() - handledAt : null
	};
}
