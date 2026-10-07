// VR controls — the DOLLHOUSE TELEPORT (37 R10). Scene ▸ Dollhouse shrinks the world rig onto a table in front
// of you (dollhouseMath.js has the layout): the whole scene as a model, a marker where you stand. Point into
// it — the pointer hand's ray lands a disc on whatever it hits (or the model's floor) — and pull the trigger
// to stand there at full size. A trigger on nothing, the sector again, or World 1:1 leaves without moving.
//
// Nothing is cloned and nothing replicates: the world rig is this device's own transform (71), peers keep
// seeing your avatar where you are. While it is up the model can still be grabbed with both grips (turn
// it, scale it); leaving always puts the rig back exactly as it was. In a game (Interact) it opens only when
// the scene's play block allows teleporting, and a landing must pass the same verdict the arc does
// (walkable, inside the bounds) — refused is a red disc and a `fail` buzz.
//
// Rides the K1 hook registries (trigger / frame / nav), registered on first open (the splineEdit pattern).
import * as THREE from 'three';
import { get } from 'svelte/store';
import { worldRig, objectsGroup, editorMode, vrMenuHand, vrMenuOpen } from '../../stores/sceneStore';
import { vrHovered } from './panels.js';
import { vrDollhouseOpen } from './worldStores.js';
import { showToast } from '../../stores/appStore';
import { moduleWorldChildren } from '../moduleWorld';
import { renderer } from './core.js';
import { hapticPulse, hapticPattern } from './haptics.js';
import { controllerIndexFor } from './input.js';
import { controllerRay, safeIntersect } from './pointer.js';
import { viewerNow, vrLocomotionNow, teleportVerdict, teleportTo, hideArc } from './locomotion.js';
import { registerVRFrameHook, registerVRTriggerHooks, registerNavSuppressor } from './hooks.js';
import { dollhouseLayout, contentToWorld, rayToContentFloor, DOLLHOUSE_FLOOR_MARGIN } from './dollhouseMath.js';

export { vrDollhouseOpen };

/**
 * @type {{rig0: {pos: number[], quat: number[], scale: number}, scale: number, box: {min: number[], max: number[]},
 *   mode: string, target: number[] | null, normalY: number, valid: boolean} | null}
 */
let state = null;
/** @type {any} */ let group = null; // marker + landing disc + table plate, children of the RIG (they scale with it)
/** @type {any} */ let marker = null;
/** @type {any} */ let disc = null;
/** @type {any} */ let plate = null;
let hooked = false;
/** the last open's measurements, for the suites */
const stats = { opens: 0, lands: 0, refused: 0, cancels: 0 };

const GREEN = 0x22cc66;
const RED = 0xcc3344;

/** @returns {{pos: number[], quat: number[], scale: number} | null} */
function rigNow() {
	const rig = get(worldRig);
	return rig ? { pos: rig.position.toArray(), quat: rig.quaternion.toArray(), scale: rig.scale.x } : null;
}
/** @param {{pos: number[], quat: number[], scale: number}} t */
function setRig(t) {
	const rig = get(worldRig);
	if (!rig) return;
	rig.position.fromArray(t.pos);
	rig.quaternion.fromArray(t.quat);
	rig.scale.setScalar(t.scale);
	rig.updateMatrixWorld(true);
}

/** the content bounds in the CONTENT frame (objects + module content), measured at an identity rig */
function contentBox() {
	const rig = get(worldRig);
	const saved = rigNow();
	if (rig) {
		rig.position.set(0, 0, 0);
		rig.quaternion.identity();
		rig.scale.setScalar(1);
		rig.updateMatrixWorld(true);
	}
	const box = new THREE.Box3();
	const roots = [...(get(objectsGroup)?.children ?? []), ...moduleWorldChildren()];
	for (const root of roots) if (root.visible !== false) box.expandByObject(root);
	if (saved) setRig(saved);
	if (box.isEmpty() || !Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return { min: [-5, 0, -5], max: [5, 0, 5] };
	return { min: box.min.toArray(), max: box.max.toArray() };
}

/** the head (world) + heading: the XR viewer pose, else the camera @returns {{head: number[], yaw: number} | null} */
function headNow() {
	const v = viewerNow();
	if (v) return { head: [v.head.x, v.head.y, v.head.z], yaw: v.yaw };
	const cam = renderer?.xr?.getCamera?.();
	if (!cam) return null;
	const p = cam.getWorldPosition(new THREE.Vector3());
	const fwd = cam.getWorldDirection(new THREE.Vector3());
	return { head: p.toArray(), yaw: Math.atan2(-fwd.x, -fwd.z) };
}

/** where the viewer's FEET are, in the content frame, under the rig `rig0` */
function feetInContent(/** @type {{pos: number[], quat: number[], scale: number}} */ rig0) {
	const v = viewerNow();
	const h = headNow();
	if (!h) return [0, 0, 0];
	const feetY = v ? v.head.y - v.headHeight : h.head[1] - 1.6;
	const inv = new THREE.Quaternion().fromArray(rig0.quat).invert();
	return new THREE.Vector3(h.head[0], feetY, h.head[2])
		.sub(new THREE.Vector3().fromArray(rig0.pos))
		.applyQuaternion(inv)
		.divideScalar(rig0.scale)
		.toArray();
}

function ensureGroup() {
	if (group) return group;
	group = new THREE.Group();
	group.name = 'vr-dollhouse';
	// you are here: an amber pin pointing down at your feet
	marker = new THREE.Mesh(
		new THREE.ConeGeometry(0.4, 1, 12).rotateX(Math.PI).translate(0, 0.5, 0),
		new THREE.MeshBasicMaterial({ color: 0xf59e0b, depthTest: false, transparent: true, opacity: 0.95 })
	);
	marker.name = 'vr-dollhouse-here';
	marker.renderOrder = 996;
	// the landing disc
	disc = new THREE.Mesh(
		new THREE.RingGeometry(0.55, 1, 28).rotateX(-Math.PI / 2),
		new THREE.MeshBasicMaterial({ color: GREEN, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
	);
	disc.name = 'vr-dollhouse-target';
	disc.renderOrder = 997;
	disc.visible = false;
	// a faint table under the model, so it reads as a model and not as the world gone small
	plate = new THREE.Mesh(
		new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2),
		new THREE.MeshBasicMaterial({ color: 0x0f172a, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide })
	);
	plate.name = 'vr-dollhouse-table';
	group.add(plate, marker, disc);
	return group;
}

function ensureHooks() {
	if (hooked) return;
	hooked = true;
	// the stick's arc would aim into the model: navigation stands down while it is up
	registerNavSuppressor(() => !!state);
	registerVRTriggerHooks({ start: (/** @type {number} */ i) => dollhouseTrigger(i), swallow: () => takeSwallow() });
	registerVRFrameHook(() => tickDollhouse());
}
/** a press the dollhouse took: its trailing 'select' must not fall through to a pick (stale after 5 s) */
let swallowAt = 0;
function takeSwallow() {
	const pending = swallowAt && Date.now() - swallowAt < 5000;
	swallowAt = 0;
	return !!pending;
}

/** Scene ▸ Dollhouse: open (or close, when it is up). @returns {boolean} open after the call */
export function toggleDollhouse() {
	if (state) {
		closeDollhouse();
		return false;
	}
	return openDollhouse();
}

/** @returns {boolean} */
export function openDollhouse() {
	if (state) return true;
	const rig = get(worldRig);
	const h = headNow();
	if (!rig || !h || !renderer?.xr?.getSession?.()) return false;
	if (!vrLocomotionNow().teleport) {
		showToast('Teleporting is off in this game, so the dollhouse is too');
		return false;
	}
	ensureHooks();
	const rig0 = /** @type {{pos: number[], quat: number[], scale: number}} */ (rigNow());
	const box = contentBox();
	const layout = dollhouseLayout(box, h.head, h.yaw, rig0.quat);
	state = { rig0, scale: layout.scale, box, mode: get(editorMode), target: null, normalY: 1, valid: false };
	setRig(layout);
	// the overlay rides the rig in CONTENT units: size it in world metres through 1/scale
	const g = ensureGroup();
	if (g.parent !== rig) rig.add(g);
	g.visible = true;
	const k = 1 / layout.scale;
	const feet = feetInContent(rig0);
	marker.position.fromArray(feet);
	marker.scale.set(0.03 * k, 0.06 * k, 0.03 * k);
	const radius = Math.max(box.max[0] - box.min[0], box.max[2] - box.min[2], 4) * 0.62;
	plate.position.set((box.min[0] + box.max[0]) / 2, box.min[1] - 0.002 * k, (box.min[2] + box.max[2]) / 2);
	plate.scale.setScalar(radius);
	disc.scale.setScalar(0.022 * k);
	disc.visible = false;
	hideArc();
	vrMenuOpen.set(false);
	vrDollhouseOpen.set(true);
	stats.opens++;
	hapticPulse(0.3, 30, undefined, true);
	return true;
}

/** leave without moving: the rig goes back exactly as it was @param {boolean} [restore] false = something else owns the rig now */
export function closeDollhouse(restore = true) {
	if (!state) return;
	if (restore) setRig(state.rig0);
	state = null;
	if (group) group.visible = false;
	vrDollhouseOpen.set(false);
}

/** the pointer hand (the one that does not hold the menu) */
function pointerIndex() {
	return controllerIndexFor(get(vrMenuHand) === 'right' ? 'left' : 'right');
}

/** aim one hand into the model: the content point it lands on + that surface's up-ness @param {number} index */
function aim(index) {
	if (!state || index < 0) return null;
	const ray = controllerRay(index);
	const roots = [...(get(objectsGroup)?.children ?? []), ...moduleWorldChildren()];
	/** @type {any} */ let best = null;
	for (const root of roots) {
		if (root.visible === false) continue;
		for (const hit of safeIntersect(ray, root)) {
			if (!hit.object.isMesh || hit.object.visible === false) continue;
			if (!best || hit.distance < best.distance) best = hit;
			break;
		}
	}
	const rig = get(worldRig);
	if (best && rig) {
		const p = rig.worldToLocal(best.point.clone()).toArray();
		const n = best.face?.normal ? best.face.normal.clone().transformDirection(best.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
		// the rig is uniform-scaled + yawed, so a world normal's up-ness is the content one's
		return { point: p, normalY: n.y };
	}
	// nothing under the ray: the model's floor, a little past its edges
	const live = rigNow();
	if (!live) return null;
	const p = rayToContentFloor(ray.ray.origin.toArray(), ray.ray.direction.toArray(), live, state.box.min[1]);
	if (!p) return null;
	const m = DOLLHOUSE_FLOOR_MARGIN;
	const b = state.box;
	if (p[0] < b.min[0] - m || p[0] > b.max[0] + m || p[2] < b.min[2] - m || p[2] > b.max[2] + m) return null;
	return { point: p, normalY: 1 };
}

/** would standing on this content point be allowed? @param {number[]} p @param {number} normalY */
function landingAllowed(p, normalY) {
	if (!state) return false;
	if (state.mode !== 'interact') return true; // Edit lands anywhere, like its arc
	return teleportVerdict(null, contentToWorld(p, state.rig0), normalY).ok;
}

/** per frame: the disc follows the pointer hand; leaving the session or the mode drops the dollhouse */
export function tickDollhouse() {
	if (!state) return;
	if (!renderer?.xr?.getSession?.()) {
		closeDollhouse(false); // the session end resets the rig itself
		return;
	}
	if (get(editorMode) !== state.mode) {
		closeDollhouse(false); // Interact's entry resets the rig and spawns
		return;
	}
	const hit = aim(pointerIndex());
	const had = !!state.target;
	state.target = hit ? hit.point : null;
	state.normalY = hit ? hit.normalY : 1;
	state.valid = !!hit && landingAllowed(hit.point, hit.normalY);
	if (disc) {
		disc.visible = !!hit;
		if (hit) {
			disc.position.fromArray(hit.point);
			disc.material.color.setHex(state.valid ? GREEN : RED);
		}
	}
	if (hit && !had) hapticPulse(0.12, 14);
}

/** a trigger while the dollhouse is up: land on the pointed spot, or leave @param {number} index */
export function dollhouseTrigger(index) {
	if (!state) return false;
	// the radial or a panel row under the ray owns this press (the menu can close the dollhouse)
	if (get(vrMenuOpen) || get(vrHovered)) return false;
	swallowAt = Date.now();
	const hit = aim(index >= 0 ? index : pointerIndex());
	if (!hit) {
		stats.cancels++;
		closeDollhouse();
		return true;
	}
	if (!landingAllowed(hit.point, hit.normalY)) {
		stats.refused++;
		hapticPattern('fail');
		return true;
	}
	landAt(hit.point);
	return true;
}

/** stand on a CONTENT point at full size: the rig goes back, then a feet-first teleport @param {number[]} point */
export function landAt(point) {
	if (!state) return false;
	const rig0 = state.rig0;
	closeDollhouse();
	teleportTo(contentToWorld(point, rig0));
	stats.lands++;
	return true;
}

/** the suites' view */
export function dollhouseDebug() {
	return {
		open: !!state,
		scale: state?.scale ?? null,
		box: state?.box ?? null,
		target: state?.target ?? null,
		valid: state?.valid ?? false,
		rig0: state?.rig0 ?? null,
		marker: marker && state ? marker.position.toArray() : null,
		discVisible: !!disc?.visible && !!state,
		...stats
	};
}
