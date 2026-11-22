// 98 P1 — what a bake sees in the live scene: the STATIC meshes (receivers + occluders), their
// geometry as plain arrays, the scene's lights, the device tier. Shared by the runner (bake time)
// and bakeApply (every peer, to rebuild the bake UVs and the stale signatures). Lazy: only the
// bake chunk imports it.
//
// STATIC = a mesh under objectsGroup that nothing moves: no dynamic / kinematic physics body on it
// or its top object, not driven by a flow graph or an authored clip, not skinned or instanced, not
// transient (spawned while a world runs), not an edit overlay, visible. A RECEIVER is a static
// mesh whose materials can take a lightMap (standard / physical / lambert / phong / basic / toon),
// not driven by a shader graph, with a free uv channel (uv2 or uv3) for its bake UVs. Every
// static mesh OCCLUDES, receiver or not.

import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, globalScene } from '../../stores/sceneStore';
import { isAnimatedTarget } from '../flowRuntime';
import { animations } from '../animationPreview';
import { isTransient } from '../transientObjects';
import { isEditOverlay } from '../editOverlays';
import { isShaderDriven } from '../shaderGraph';
import { bakeTierOf } from './bakeRecordCore.js';

const LIGHTMAP_TYPES = new Set([
	'MeshStandardMaterial',
	'MeshPhysicalMaterial',
	'MeshLambertMaterial',
	'MeshPhongMaterial',
	'MeshBasicMaterial',
	'MeshToonMaterial'
]);

/** the user-facing top object a mesh belongs to (the child of objectsGroup) @param {any} o @param {any} group */
export function topOf(o, group) {
	let node = o;
	while (node?.parent && node.parent !== group) node = node.parent;
	return node?.parent === group ? node : null;
}

/** @param {any} o */
function visibleInWorld(o) {
	for (let n = o; n; n = n.parent) if (n.visible === false) return false;
	return true;
}

/** @param {any} o @param {any} group @returns {string} '' when static, else why not */
export function whyNotStatic(o, group) {
	if (!o?.isMesh || !o.geometry?.attributes?.position) return 'not a mesh';
	if (o.isSkinnedMesh) return 'animated character';
	if (o.isInstancedMesh || o.isBatchedMesh) return 'instanced';
	if (isEditOverlay?.(o)) return 'overlay';
	const top = topOf(o, group);
	if (!top) return 'not in the scene';
	if (isTransient(top)) return 'spawned';
	if (!visibleInWorld(o)) return 'hidden';
	for (let n = o; n && n !== group; n = n.parent) {
		const mode = n.userData?.physics?.mode;
		if (mode === 'dynamic' || mode === 'kinematic') return 'moves with physics';
		if (isAnimatedTarget(n.uuid)) return 'moved by a flow graph';
		if (/** @type {any} */ (get(animations))?.[n.uuid]) return 'has an animation';
		if (n.userData?.bake === false) return 'left out of the bake';
	}
	return '';
}

/** @param {any} o @returns {string} '' when it can take baked maps, else why not */
export function whyNotReceiver(o) {
	/** @type {any[]} */
	const materials = Array.isArray(o.material) ? o.material : [o.material];
	if (!materials.length || materials.some((m) => !m || !LIGHTMAP_TYPES.has(m.type))) return 'its material cannot take baked light';
	if (isShaderDriven(o.uuid) || materials.some((m) => m.isShaderMaterial)) return 'drawn by a shader graph';
	if (!freeChannel(o.geometry)) return 'no free UV channel';
	return '';
}

/** uv2 unless it is someone else's, else uv3, else 0 @param {any} geometry @returns {2 | 3 | 0} */
export function freeChannel(geometry) {
	const ours = geometry?.userData?.__bakeCh;
	if (ours === 2 || ours === 3) return ours;
	if (!geometry?.attributes?.uv2) return 2;
	if (!geometry?.attributes?.uv3) return 3;
	return 0;
}

/** an attribute as a plain Float32Array (handles interleaved / normalized / quantized) @param {any} attr @param {number} size */
export function readAttr(attr, size) {
	if (!attr) return null;
	const n = attr.count;
	const out = new Float32Array(n * size);
	for (let i = 0; i < n; i++) {
		out[i * size] = attr.getX(i);
		if (size > 1) out[i * size + 1] = attr.getY(i);
		if (size > 2) out[i * size + 2] = attr.getZ(i);
	}
	return out;
}

/** the geometry arrays the unwrap reads (bake side and apply side read them the same way) @param {any} geometry */
export function geometryArrays(geometry) {
	const index = geometry.index ? Uint32Array.from(geometry.index.array) : null;
	return {
		pos: /** @type {Float32Array} */ (readAttr(geometry.attributes.position, 3)),
		index,
		normal: readAttr(geometry.attributes.normal, 3),
		uv0: readAttr(geometry.attributes.uv, 2),
		uv1: readAttr(geometry.attributes.uv1, 2)
	};
}

const tmpColor = new THREE.Color();
/** albedo of a mesh for the bounce: its first material's colour (linear), clamped @param {any} o */
function albedoOf(o) {
	const m = Array.isArray(o.material) ? o.material[0] : o.material;
	if (m?.color?.isColor) tmpColor.copy(m.color);
	else tmpColor.setRGB(0.7, 0.7, 0.7);
	// a textured surface reflects roughly its texture's mean; without reading pixels, 0.75 of the tint
	const k = m?.map ? 0.75 : 1;
	return [Math.min(0.9, tmpColor.r * k), Math.min(0.9, tmpColor.g * k), Math.min(0.9, tmpColor.b * k)];
}

/**
 * Collect the bake input from the live scene.
 * @returns {{ meshes: any[], receivers: any[], skipped: { uuid: string, name: string, reason: string }[], lights: any[] }}
 */
export function collectBakeScene() {
	/** @type {any} */
	const group = get(objectsGroup);
	/** @type {any[]} */ const meshes = [];
	/** @type {any[]} */ const receivers = [];
	/** @type {{ uuid: string, name: string, reason: string }[]} */ const skipped = [];
	group?.updateMatrixWorld?.(true);
	group?.traverse?.((/** @type {any} */ o) => {
		if (!o.isMesh) return;
		const why = whyNotStatic(o, group);
		if (why) {
			if (why !== 'overlay' && why !== 'not a mesh') skipped.push({ uuid: o.uuid, name: o.name || topOf(o, group)?.name || 'object', reason: why });
			return;
		}
		const arrays = geometryArrays(o.geometry);
		const receiveWhy = whyNotReceiver(o);
		const receive = !receiveWhy;
		if (!receive) skipped.push({ uuid: o.uuid, name: o.name || topOf(o, group)?.name || 'object', reason: receiveWhy });
		const entry = { key: o.uuid, receive, ...arrays, world: Array.from(o.matrixWorld.elements), albedo: albedoOf(o) };
		meshes.push(entry);
		if (receive) receivers.push(o);
	});
	return { meshes, receivers, skipped, lights: collectLights() };
}

const wp = new THREE.Vector3();
const tp = new THREE.Vector3();
/** the scene's direct lights as BakeLights (strongest 6) */
export function collectLights() {
	/** @type {any} */
	const scene = get(globalScene) ?? get(objectsGroup)?.parent;
	/** @type {any[]} */
	const out = [];
	scene?.updateMatrixWorld?.(true);
	scene?.traverse?.((/** @type {any} */ l) => {
		if (!l.isLight || !visibleInWorld(l) || !(l.intensity > 0)) return;
		const r = l.color.r * l.intensity, g = l.color.g * l.intensity, b = l.color.b * l.intensity;
		if (l.isDirectionalLight) {
			l.getWorldPosition(wp);
			(l.target ? l.target.getWorldPosition(tp) : tp.set(0, 0, 0));
			const d = wp.sub(tp).normalize();
			out.push({ type: 'dir', dx: d.x, dy: d.y, dz: d.z, r, g, b });
		} else if (l.isPointLight || l.isSpotLight) {
			l.getWorldPosition(wp);
			/** @type {any} */
			const light = { type: l.isSpotLight ? 'spot' : 'point', x: wp.x, y: wp.y, z: wp.z, r, g, b, distance: l.distance ?? 0, decay: l.decay ?? 2 };
			if (l.isSpotLight) {
				l.target.getWorldPosition(tp);
				const d = tp.sub(wp).normalize();
				light.dx = d.x;
				light.dy = d.y;
				light.dz = d.z;
				light.cosOuter = Math.cos(l.angle);
				light.cosInner = Math.cos(l.angle * (1 - (l.penumbra ?? 0)));
			}
			out.push(light);
		}
	});
	out.sort((a, b) => b.r + b.g + b.b - (a.r + a.g + a.b));
	return out.slice(0, 6);
}

/** this device's bake tier */
export async function deviceBakeTier() {
	let quest = false, phone = false;
	try {
		quest = (await import('../shaderCodeReach.js')).isQuestUserAgent(navigator.userAgent);
	} catch {}
	try {
		phone = (await import('../qualityGovernor.js')).isPhoneDevice();
	} catch {}
	return bakeTierOf({ quest, phone });
}
