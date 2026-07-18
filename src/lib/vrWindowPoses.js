// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable } from 'svelte/store';

// VR window grab (111): every follower window (radial ring, objects panel,
// color palette, stats card) can be detached by holding the other hand's grip
// on it for HOLD_MS, then moved/rotated 1:1 and stick-scaled. The release
// pose is stored RELATIVE to the window's controller anchor (quiz decision:
// windows keep following the hand, just where you like them) and persists in
// localStorage. vrControls owns the input state machine; the components keep
// computing their default anchor every frame and apply the composed pose.

export const HOLD_MS = 600;

/** 0..1 progress of the grab-hold timer @param {number} startedAt @param {number} now */
export function holdProgress(startedAt, now) {
	return Math.min(Math.max((now - startedAt) / HOLD_MS, 0), 1);
}

/** {id, index} while a window is detached for adjusting, else null
 * @type {import('svelte/store').Writable<any>} */
export const vrWindowAdjust = writable(null);

function loadPoses() {
	try {
		return JSON.parse(localStorage.getItem('vrWindowPoses') ?? '{}') ?? {};
	} catch {
		return {};
	}
}

/** per-window user offsets: id -> {pos:[3], quat:[4], scale}
 * @type {import('svelte/store').Writable<Record<string, any>>} */
export const windowPoses = writable(typeof localStorage !== 'undefined' ? loadPoses() : {});
let posesValue = /** @type {Record<string, any>} */ ({});
windowPoses.subscribe((v) => (posesValue = v ?? {}));
let adjustValue = /** @type {any} */ (null);
vrWindowAdjust.subscribe((v) => (adjustValue = v));

/** @param {string} id @param {any} offset {pos, quat, scale} */
export function saveWindowPose(id, offset) {
	windowPoses.update((poses) => {
		const next = { ...poses, [id]: offset };
		try {
			localStorage.setItem('vrWindowPoses', JSON.stringify(next));
		} catch {}
		return next;
	});
}

/** Settings ▸ VR reset button — windows snap back to their default anchors */
export function resetWindowPoses() {
	windowPoses.set({});
	try {
		localStorage.removeItem('vrWindowPoses');
	} catch {}
}

/**
 * World pose = anchor ∘ user offset (offset lives in ANCHOR-LOCAL space).
 * @param {{position: any, quaternion: any}} anchor
 * @param {{pos: number[], quat: number[], scale?: number}|null|undefined} offset
 */
export function composePose(anchor, offset) {
	if (!offset)
		return { position: anchor.position.clone(), quaternion: anchor.quaternion.clone(), scale: 1 };
	const position = new THREE.Vector3()
		.fromArray(offset.pos)
		.applyQuaternion(anchor.quaternion)
		.add(anchor.position);
	const quaternion = anchor.quaternion.clone().multiply(new THREE.Quaternion().fromArray(offset.quat));
	return { position, quaternion, scale: offset.scale ?? 1 };
}

/**
 * Inverse of composePose: express a world pose as an anchor-local offset.
 * @param {{position: any, quaternion: any}} anchor
 * @param {any} worldPos @param {any} worldQuat @param {number} scale
 */
export function offsetFromWorld(anchor, worldPos, worldQuat, scale = 1) {
	const inv = anchor.quaternion.clone().invert();
	const pos = worldPos.clone().sub(anchor.position).applyQuaternion(inv);
	const quat = inv.clone().multiply(worldQuat);
	return { pos: pos.toArray(), quat: quat.toArray(), scale };
}

// components publish their CURRENT default anchor every frame so the release
// handler can convert the adjusted world pose back into an offset
const anchors = new Map();

/** @param {string} id @param {any} position @param {any} quaternion */
export function setWindowAnchor(id, position, quaternion) {
	let record = anchors.get(id);
	if (!record) {
		record = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
		anchors.set(id, record);
	}
	record.position.copy(position);
	record.quaternion.copy(quaternion);
}

/** @param {string} id */
export function windowAnchor(id) {
	return anchors.get(id) ?? null;
}

/**
 * Apply the composed pose to the window group — unless that window is
 * currently detached (vrControls drives it then). extraScale multiplies the
 * user scale (the menu's open animation). Returns true when applied.
 * @param {any} group @param {string} id @param {{position: any, quaternion: any}} anchor
 * @param {number=} extraScale
 */
export function applyWindowPose(group, id, anchor, extraScale = 1) {
	setWindowAnchor(id, anchor.position, anchor.quaternion);
	if (adjustValue?.id === id) return false;
	const pose = composePose(anchor, posesValue[id]);
	group.position.copy(pose.position);
	group.quaternion.copy(pose.quaternion);
	group.scale.setScalar(pose.scale * extraScale);
	return true;
}
