// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { normalizeFlowPath, compileFlow, MAX_FLOWS } from './flowPathCore.js';

// 36-fb F24: the runtime side of FLOW PATHS.
//   · flowFieldFor — every path reaching an emitter's area, compiled into the solver's frame
//     (the worker steers / recycles / pipes with it: flowPathCore.applyFlows);
//   · tickFlowPaths — the ANIMATED SURFACE of every visible river: a scene-root overlay that
//     shares the path's geometry and scrolls ripples along it at the path's speed on the
//     shared clock. It is the body of water you see on Quest (where an emitter runs few
//     particles) and the sheen over the particles on desktop. LOCAL, never saved: it hangs
//     next to the content (objectsGroup's parent), tagged like the fluid visual.

/**
 * @param {any} root objectsGroup
 * @param {{min: THREE.Vector3, max: THREE.Vector3}} areaW the area's world AABB
 * @param {THREE.Vector3} center the solver origin (area-local = world - center)
 * @returns {any[] | null} compiled flows
 */
export function flowFieldFor(root, areaW, center) {
	if (!root) return null;
	/** @type {any[]} */
	const out = [];
	const area = new THREE.Box3(areaW.min, areaW.max);
	const v = new THREE.Vector3();
	root.traverse((/** @type {any} */ o) => {
		if (out.length >= MAX_FLOWS || !o.userData?.flowPath) return;
		const spec = normalizeFlowPath(o.userData.flowPath);
		o.updateWorldMatrix(true, false);
		const local = spec.points.map((p) => {
			v.set(p[0], p[1], p[2]).applyMatrix4(o.matrixWorld);
			return [v.x - center.x, v.y - center.y, v.z - center.z];
		});
		// any part of it in the area (a pipe needs its intake there; its outlet may be anywhere in it)
		const box = new THREE.Box3();
		for (const p of local) box.expandByPoint(v.set(p[0] + center.x, p[1] + center.y, p[2] + center.z));
		box.expandByScalar(Math.max(spec.width, spec.depth));
		if (!box.intersectsBox(area)) return;
		// a scaled object scales its path (width with the horizontal scale)
		const s = new THREE.Vector3().setFromMatrixScale(o.matrixWorld);
		const scaled = { ...spec, width: spec.width * Math.max(Math.abs(s.x), Math.abs(s.z)), depth: spec.depth * Math.abs(s.y) };
		out.push(compileFlow(scaled, local));
	});
	return out.length ? out : null;
}

// ---------------------------------------------------------------- the animated surface

const SURFACE_VS = /* glsl */ `
varying vec2 vUv;
varying vec3 vView;
void main() {
	vUv = uv;
	vec4 mv = modelViewMatrix * vec4(position, 1.0);
	vView = -mv.xyz;
	gl_Position = projectionMatrix * mv;
}`;

// scrolling streaks + a soft edge foam: cheap value noise, no textures
const SURFACE_FS = /* glsl */ `
uniform float uTime;
uniform float uFlow;
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vUv;
varying vec3 vView;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
	vec2 i = floor(p), f = fract(p);
	f = f * f * (3.0 - 2.0 * f);
	return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
	vec2 p = vec2(vUv.x * 4.0, vUv.y * 2.0 - uTime * uFlow);
	float n = noise(p * vec2(1.0, 1.6)) * 0.6 + noise(p * 3.1 + 7.0) * 0.4;
	float streak = smoothstep(0.62, 0.9, n);
	float edge = smoothstep(0.38, 0.5, abs(vUv.x - 0.5));
	float a = clamp(streak * 0.55 + edge * 0.35, 0.0, 1.0) * uOpacity;
	gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.75), a);
}`;

/** @type {Map<string, {mesh: any, material: any, geometry: any}>} */
const overlays = new Map();
let visualParent = /** @type {any} */ (null);

/** @param {any} spec */
function makeOverlay(spec) {
	const material = new THREE.ShaderMaterial({
		vertexShader: SURFACE_VS,
		fragmentShader: SURFACE_FS,
		uniforms: { uTime: { value: 0 }, uFlow: { value: 1 }, uColor: { value: new THREE.Color(spec.color) }, uOpacity: { value: 0.9 } },
		transparent: true,
		depthWrite: false,
		side: THREE.DoubleSide,
		polygonOffset: true,
		polygonOffsetFactor: -2,
		polygonOffsetUnits: -2
	});
	const mesh = new THREE.Mesh(undefined, material);
	mesh.name = 'Flow surface (visual)';
	mesh.matrixAutoUpdate = false;
	mesh.userData.__fluidVisual = true;
	mesh.renderOrder = 9;
	return { mesh, material, geometry: null };
}

/**
 * Per frame (tickSim): keep one surface overlay per visible river, glued to its path.
 * @param {any} root objectsGroup @param {number} now ms (the overlay's clock; the look only)
 */
export function tickFlowPaths(root, now) {
	visualParent = root?.parent ?? null;
	/** @type {Set<string>} */
	const alive = new Set();
	if (root && visualParent) {
		visualParent.updateWorldMatrix(true, false);
		const inv = new THREE.Matrix4().copy(visualParent.matrixWorld).invert();
		root.traverse((/** @type {any} */ o) => {
			if (!o.userData?.flowPath || !o.geometry) return;
			const spec = normalizeFlowPath(o.userData.flowPath);
			if (spec.kind !== 'river' || !spec.show || !o.visible) return;
			alive.add(o.uuid);
			let ov = overlays.get(o.uuid);
			if (!ov) {
				ov = makeOverlay(spec);
				overlays.set(o.uuid, ov);
			}
			if (ov.mesh.parent !== visualParent) visualParent.add(ov.mesh);
			if (ov.mesh.geometry !== o.geometry) ov.mesh.geometry = o.geometry; // shared, never disposed here
			ov.material.uniforms.uColor.value.set(spec.color);
			// v runs in path-widths, so the ripples move at the path's speed
			ov.material.uniforms.uFlow.value = spec.speed / Math.max(spec.width, 0.1);
			ov.material.uniforms.uTime.value = now / 1000;
			o.updateWorldMatrix(true, false);
			ov.mesh.matrix.copy(inv).multiply(o.matrixWorld);
			ov.mesh.matrixWorldNeedsUpdate = true;
		});
	}
	for (const [uuid, ov] of overlays)
		if (!alive.has(uuid)) {
			ov.mesh.removeFromParent();
			ov.material.dispose();
			overlays.delete(uuid);
		}
}

/** TEST/DEBUG */
export function flowPathDebug() {
	return [...overlays.keys()];
}
