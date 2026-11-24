// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { peers } from '../stores/appStore';
import { normalizeDecal, isDecalObject, decalPoseMatrix, stampCap, stampLifetime } from './decalCore.js';
import { loadDecalRuntime } from './decalTick.js';
import { sessionNow } from './sessionClock.js';

// 102 M3: the Stamp Decal action's sending half (flowRuntime reaches it by dynamic import). The
// acting peer turns a point + normal into a box pose in the TARGET's frame, applies the mark and
// sends ONE `decalstamp`; every receiver applies the same message (applyRemoteDecalStamp). The
// mark's id makes a resend or a second actor's copy a no-op (admitStamp).

const m4 = new THREE.Matrix4();
const inv = new THREE.Matrix4();

/**
 * @param {{ id: string, target: string, point: number[], normal: number[], source?: string, size?: number, depth?: number, life?: number, cap?: number }} req
 *   point/normal in the objects group's frame (the physics world)
 * @returns {Promise<any | null>} the message sent, or null
 */
export async function stampDecalFromFlow(req) {
	const group = get(objectsGroup);
	const target = group?.getObjectByProperty('uuid', req.target);
	if (!group || !target || isDecalObject(target)) return null;
	const template = req.source ? group.getObjectByProperty('uuid', req.source) : null;
	const look = isDecalObject(template) ? normalizeDecal(template.userData.decal) : normalizeDecal({});
	const size = Math.max(0.01, Math.min(50, Number(req.size) || 0.4));
	const depth = Math.max(0.01, Math.min(50, Number(req.depth) || 0.3));
	// a template's own scale sets the mark's size when it is wired
	const dims = isDecalObject(template) ? template.scale.toArray() : [size, size, depth];
	// a spin from the id: every mark turns differently, and the same mark turns the same everywhere
	let hash = 0;
	for (let i = 0; i < req.id.length; i++) hash = (hash * 31 + req.id.charCodeAt(i)) | 0;
	const spin = ((hash >>> 0) % 6283) / 1000;
	m4.fromArray(decalPoseMatrix(req.point, req.normal, dims, spin));
	// the point is in the objects group's frame; the pose is kept in the target's
	group.updateWorldMatrix(true, false);
	target.updateWorldMatrix(true, false);
	m4.premultiply(group.matrixWorld);
	inv.copy(target.matrixWorld).invert();
	m4.premultiply(inv);
	const msg = {
		type: 'decalstamp',
		id: req.id,
		at: sessionNow(),
		life: stampLifetime(req.life),
		cap: stampCap(req.cap),
		target: req.target,
		pose: m4.elements.map((v) => +v.toFixed(6)),
		image: look.image,
		tint: look.tint,
		opacity: look.opacity
	};
	const rt = await loadDecalRuntime();
	if (!rt.applyDecalStamp(msg)) return null;
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send(msg);
	return msg;
}

/** a received `decalstamp` @param {any} data */
export function applyRemoteDecalStamp(data) {
	return loadDecalRuntime().then((rt) => rt.applyDecalStamp(data));
}
