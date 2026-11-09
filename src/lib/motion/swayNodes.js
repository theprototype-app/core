// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { addDeformer, removeDeformer, hasDeformer } from '../vertexDeform.js';
import { swayParams, flowOffset, clampNum, SWAY_DEFAULTS, WATER_DEFAULTS } from './swayCore.js';
import { localBounds } from './tweenNodes.js';
import { proceduralMaps } from '../materialPresetMaps.js';
import { registerParkHook } from '../parkHooks.js';

// 85 N5 — WIND SWAY (plants, flags, banners, curtains) and FLOWING WATER (a river, a fountain
// basin, an aquarium surface), the THREE half. A LEAF: three, the pure core, vertexDeform (the
// one-clone-per-mesh registry, so a swaying plant that also Jiggles, or a flag with a Body Wave,
// COMPOSES — fix-agenttest item 2), the procedural maps and the park registry.
//
// Both draw through the vertex shader, never the transform (the Body Wave rule: physics, picking
// and the network keep the rest pose). Flowing Water also scrolls the material's colour / normal
// maps — on the deformer's own material clone with CLONED textures, so another object sharing the
// material or the texture does not flow too — and lends a mesh with no normal map the procedural
// ripple map. A serializer's park puts the authored maps back for the save.

const vA = new THREE.Vector3();
const qA = new THREE.Quaternion();
const mA = new THREE.Matrix4();

export const SWAY_DECL = /* glsl */ `
uniform mat4 wsToRoot;
uniform mat3 wsFromRoot;
uniform vec3 wsAxis;
uniform vec2 wsRange;
uniform vec3 wsBend;
uniform vec4 wsDrive;
uniform float wsMode;
`;
// u: 0 at the anchor, 1 at the free end. Plant: lean with the wind (u^2, a stem bends most at the
// tip) with a slow sway and a leaf flutter; flag: a wave running away from the pole, growing
// toward the free edge. The per-vertex phase comes from the position, so a bush does not move
// as one rigid block.
export const SWAY_VERTEX = /* glsl */ `
#include <begin_vertex>
{
	vec3 wsR = (wsToRoot * vec4(transformed, 1.0)).xyz;
	float wsU = clamp((dot(wsR, wsAxis) - wsRange.x) / max(wsRange.y, 1e-4), 0.0, 1.0);
	float wsP = dot(wsR, vec3(0.37, 0.21, 0.53));
	float wsOff;
	if (wsMode < 0.5) {
		wsOff = wsDrive.x * wsU * wsU * (0.65 + 0.35 * sin(6.2831853 * wsDrive.z + wsP))
			+ wsDrive.x * wsDrive.w * 0.15 * wsU * sin(6.2831853 * wsDrive.z * 3.7 + wsP * 7.0);
	} else {
		wsOff = wsDrive.x * wsU * sin(6.2831853 * (wsU * wsRange.y * wsDrive.y - wsDrive.z))
			+ wsDrive.x * wsDrive.w * 0.2 * wsU * sin(6.2831853 * wsDrive.z * 2.3 + wsP * 5.0);
	}
	transformed += wsFromRoot * (wsBend * wsOff);
}
`;

export const WATER_DECL = /* glsl */ `
uniform mat4 wfToRoot;
uniform mat3 wfFromRoot;
uniform vec4 wfDrive;
`;
// a gentle swell on the object's own up axis: two crossed sines over the surface
export const WATER_VERTEX = /* glsl */ `
#include <begin_vertex>
{
	vec3 wfR = (wfToRoot * vec4(transformed, 1.0)).xyz;
	float wfOff = wfDrive.x * sin(wfR.x * wfDrive.y + 6.2831853 * wfDrive.z) * cos(wfR.z * wfDrive.y * 0.8 + 6.2831853 * wfDrive.z * 1.3);
	transformed += wfFromRoot * vec3(0.0, wfOff, 0.0);
}
`;

/** meshes under an object (its own subtree) @param {any} object */
function meshesOf(object) {
	/** @type {any[]} */
	const out = [];
	object.traverse((/** @type {any} */ o) => {
		if (o.isMesh && o.geometry && o.material && !Array.isArray(o.material) && o.visible !== false) out.push(o);
	});
	return out;
}

/** a mesh's matrix relative to an ancestor, from the LOCAL chain @param {any} node @param {any} root @param {THREE.Matrix4} out */
function relTo(node, root, out) {
	node.updateMatrix();
	out.copy(node.matrix);
	for (let p = node.parent; p && p !== root; p = p.parent) {
		p.updateMatrix();
		out.premultiply(p.matrix);
	}
	return out;
}

/**
 * @typedef {{mesh: any, id: string, uniforms: any, maps?: {map: any, normalMap: any, ownMap: any, ownNormal: any, normalScale: number[] | null}}} DeformMesh
 * @typedef {{object: any, kind: string, meshes: DeformMesh[], sig: string, seen: number}} Deform
 */
/** @type {Map<string, Deform>} */
const live = new Map();
let frameNo = 0;

/** @param {string} kind @param {any} object */
function sigOf(kind, object) {
	return kind + '|' + meshesOf(object).map((m) => m.uuid + ':' + m.geometry.uuid).join(',');
}

/** the procedural ripple normal map, one texture per session (browser only) @type {any} */
let rippleTex = null;
function rippleTexture() {
	if (rippleTex) return rippleTex;
	const maps = proceduralMaps(/** @type {any} */ ('water'));
	if (!maps?.normalMap || typeof Image === 'undefined') return null;
	const img = new Image();
	const tex = new THREE.Texture(img);
	img.onload = () => (tex.needsUpdate = true);
	img.src = maps.normalMap;
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	tex.repeat.set(3, 3);
	rippleTex = tex;
	return tex;
}

/** @param {DeformMesh} m */
function putMapsBack(m) {
	if (!m.maps) return;
	const mat = m.mesh.material;
	if (mat && hasDeformer(m.mesh, m.id)) {
		mat.map = m.maps.map;
		mat.normalMap = m.maps.normalMap;
		if (m.maps.normalScale && mat.normalScale) mat.normalScale.fromArray(m.maps.normalScale);
		mat.needsUpdate = true;
	}
	m.maps.ownMap?.dispose?.();
	if (m.maps.ownNormal && m.maps.ownNormal !== rippleTex) m.maps.ownNormal.dispose?.();
	m.maps = undefined;
}

/** @param {string} key */
function detach(key) {
	const d = live.get(key);
	if (!d) return;
	for (const m of d.meshes) {
		putMapsBack(m);
		removeDeformer(m.mesh, m.id);
	}
	live.delete(key);
}

/**
 * Attach (or keep) one deformer per mesh for (node, object). Rebuilt when the subtree changes; a
 * material swapped under it (an Inspector edit) is re-wrapped.
 * @param {string} key @param {string} kind 'windsway' | 'waterflow' @param {any} object @param {any} data
 */
function deformFor(key, kind, object, data) {
	const sig = sigOf(kind, object);
	let d = live.get(key);
	if (d && (d.sig !== sig || d.object !== object)) {
		detach(key);
		d = undefined;
	}
	if (!d) {
		d = { object, kind, meshes: [], sig, seen: frameNo };
		for (const mesh of meshesOf(object)) {
			const m = attachMesh(mesh, key, kind);
			if (m) d.meshes.push(m);
		}
		if (!d.meshes.length) return null;
		live.set(key, d);
	}
	for (let i = 0; i < d.meshes.length; i++) {
		const m = d.meshes[i];
		if (!hasDeformer(m.mesh, m.id)) {
			const fresh = attachMesh(m.mesh, key, kind);
			if (fresh) d.meshes[i] = fresh;
		}
	}
	if (kind === 'waterflow') for (const m of d.meshes) ensureMaps(m, data);
	d.seen = frameNo;
	return d;
}

/** @param {any} mesh @param {string} key @param {string} kind @returns {DeformMesh | null} */
function attachMesh(mesh, key, kind) {
	const id = kind + ':' + key;
	const uniforms =
		kind === 'windsway'
			? {
					wsToRoot: { value: new THREE.Matrix4() },
					wsFromRoot: { value: new THREE.Matrix3() },
					wsAxis: { value: new THREE.Vector3(0, 1, 0) },
					wsRange: { value: new THREE.Vector2(0, 1) },
					wsBend: { value: new THREE.Vector3(1, 0, 0) },
					wsDrive: { value: new THREE.Vector4() },
					wsMode: { value: 0 }
				}
			: {
					wfToRoot: { value: new THREE.Matrix4() },
					wfFromRoot: { value: new THREE.Matrix3() },
					wfDrive: { value: new THREE.Vector4() }
				};
	const clone = addDeformer(mesh, id, {
		kind,
		prefix: kind === 'windsway' ? 'ws' : 'wf',
		key: kind + '1',
		decl: kind === 'windsway' ? SWAY_DECL : WATER_DECL,
		vertex: kind === 'windsway' ? SWAY_VERTEX : WATER_VERTEX,
		uniforms
	});
	if (!clone) return null;
	return { mesh, id, uniforms };
}

/** Flowing Water: the clone gets its OWN copies of the maps (and the ripple map if it had none) @param {DeformMesh} m @param {any} data */
function ensureMaps(m, data) {
	const mat = m.mesh.material;
	if (!mat || m.maps) return;
	const map = mat.map ?? null;
	const normalMap = mat.normalMap ?? null;
	const ownMap = map ? map.clone() : null;
	let ownNormal = normalMap ? normalMap.clone() : null;
	if (!ownNormal && data?.ripples !== false && 'normalMap' in mat) ownNormal = rippleTexture();
	for (const t of [ownMap, ownNormal]) if (t && t !== rippleTex) t.wrapS = t.wrapT = THREE.RepeatWrapping;
	const normalScale = mat.normalScale ? mat.normalScale.toArray() : null;
	if (ownMap) mat.map = ownMap;
	if (ownNormal) {
		mat.normalMap = ownNormal;
		if (!normalMap && mat.normalScale) mat.normalScale.set(0.5, 0.5);
	}
	mat.needsUpdate = true;
	m.maps = { map, normalMap, ownMap, ownNormal, normalScale };
}

/**
 * Wind Sway: plants lean and sway with gusts, flags wave from their pole. Shader-only.
 * @param {any} object @param {any} data @param {number} time @param {{key: string}} ctx
 */
export function applyWindSway(object, data, time, ctx) {
	const d = deformFor(ctx.key, 'windsway', object, data);
	if (!d) return null;
	const box = localBounds(object) ?? { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] };
	// the wind's world heading (degrees about +y, 0 = +x) into the object's own frame
	const dir = (clampNum(data?.direction, SWAY_DEFAULTS.direction, -360, 360) * Math.PI) / 180;
	object.updateWorldMatrix(true, false);
	object.getWorldQuaternion(qA).invert();
	vA.set(Math.cos(dir), 0, -Math.sin(dir)).applyQuaternion(qA).normalize();
	const p = swayParams(data, box, vA.toArray(), time);
	for (const m of d.meshes) {
		const u = m.uniforms;
		relTo(m.mesh, object, u.wsToRoot.value);
		u.wsFromRoot.value.setFromMatrix4(u.wsToRoot.value).invert();
		u.wsAxis.value.fromArray(p.axis);
		u.wsRange.value.set(p.base, p.len);
		u.wsBend.value.fromArray(p.bend);
		u.wsDrive.value.set(p.strength, p.k, p.phase, p.flutter);
		u.wsMode.value = p.mode;
	}
	return p;
}

/**
 * Flowing Water: the maps scroll (the current), the surface swells. Shader + texture offsets.
 * @param {any} object @param {any} data @param {number} time @param {{key: string}} ctx
 */
export function applyWaterFlow(object, data, time, ctx) {
	const d = deformFor(ctx.key, 'waterflow', object, data);
	if (!d) return null;
	const [ou, ov] = flowOffset(data, time);
	const swell = clampNum(data?.swell, WATER_DEFAULTS.swell, 0, 2);
	const k = (2 * Math.PI) / clampNum(data?.swellSize, WATER_DEFAULTS.swellSize, 0.1, 100);
	const phase = (time * 0.25) % 1000;
	for (const m of d.meshes) {
		const u = m.uniforms;
		relTo(m.mesh, object, u.wfToRoot.value);
		u.wfFromRoot.value.setFromMatrix4(u.wfToRoot.value).invert();
		u.wfDrive.value.set(swell, k, phase, 0);
		if (m.maps?.ownMap) m.maps.ownMap.offset.set(ou, ov);
		// the ripples drift a little slower and across, so the surface never reads as one sliding sheet
		if (m.maps?.ownNormal) m.maps.ownNormal.offset.set(ou * 1.3, ov * 1.3 + ou * 0.2);
	}
	return { offset: [ou, ov], swell };
}

/** call once per tick with the (node, object) keys still driven: the rest stand down @param {Set<string>} liveKeys */
export function pruneSwayNodes(liveKeys) {
	frameNo++;
	for (const key of [...live.keys()]) if (!liveKeys.has(key)) detach(key);
}

/** put every original material back (a scene clear) */
export function resetSwayNodes() {
	for (const key of [...live.keys()]) detach(key);
}

/** debug: what the sway runtime holds */
export function swayNodesDebug() {
	return Object.fromEntries([...live].map(([k, d]) => [k, { kind: d.kind, meshes: d.meshes.length, flowing: d.meshes.filter((m) => !!m.maps?.ownNormal || !!m.maps?.ownMap).length }]));
}

// a serializer's park: the authored maps in for the save (the clone keeps the original's uuid,
// so a save would otherwise write the scrolled copies / the ripple map into the file)
registerParkHook(() => {
	/** @type {[any, any, any][]} */
	const lifted = [];
	for (const d of live.values())
		for (const m of d.meshes) {
			if (!m.maps) continue;
			const mat = m.mesh.material;
			lifted.push([mat, mat.map, mat.normalMap]);
			mat.map = m.maps.map;
			mat.normalMap = m.maps.normalMap;
		}
	if (!lifted.length) return null;
	return () => {
		for (const [mat, map, normalMap] of lifted) {
			mat.map = map;
			mat.normalMap = normalMap;
		}
	};
});
