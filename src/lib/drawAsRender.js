// 103 H11 — the LAZY half of "Draw as" (./drawAs.js is the boot leaf). Fetched the first time a mode other
// than Normal is in force; nothing here runs for a person who never picks one.
//
// Every mode is LOCAL to this tab and never touches a replicated material: the scene-wide ones go through
// `scene.overrideMaterial`, the viewMode wireframe / UV-editor checker precedent (a per-material swap would be
// serialized by the object sync and autosave and leak the debug look into somebody's scene).
//   ao-only     a white clay material + the personal AO pass (Outline reads drawAsActive and asks for AO)
//   normals     MeshNormalMaterial
//   uv-checker  the UV editor's checker idea, its own material here (that module is the whole UV editor)
//   weights     a skinning-aware shader: the picked / selected bone's weight blue -> red, else a colour per bone
//   wire-over   the shaded scene with each mesh's triangle edges drawn on top: a per-mesh onAfterRender that
//               draws the same geometry once more as lines, inside the same pass (so the depth test is the
//               scene's own — a second whole-scene render after the composer would have no depth to test).
//               The hook is an own property on the mesh, removed when the mode ends; toJSON / clone never copy it.
// What we added vs reused: wireframe, shaded and shaded + AO are viewMode's (reused as they are); the AO pass
// is the personal N8AO pass (reused); the four overrides and the wire overlay are new, ~200 lines, here.
// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene, objectsGroup, selectedObject } from '../stores/sceneStore';
import { drawAsActive } from './drawAs.js';
import { viewPrefs } from './viewPrefs';

/** @type {Record<string, any>} */
const mats = {};

function checkerTexture(size = 512, cells = 8) {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	const step = size / cells;
	for (let y = 0; y < cells; y++)
		for (let x = 0; x < cells; x++) {
			ctx.fillStyle = (x + y) % 2 === 0 ? '#3d4653' : '#d7dde6'; // tokens-ok: a texture, not UI
			ctx.fillRect(x * step, y * step, step, step);
		}
	const t = new THREE.CanvasTexture(canvas);
	t.colorSpace = THREE.SRGBColorSpace;
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	return t;
}

const WEIGHT_VERT = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
uniform float uBone;
varying vec3 vColor;
vec3 hue(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
vec3 heat(float w) { return w < 0.5 ? mix(vec3(0.08, 0.16, 0.7), vec3(0.1, 0.8, 0.3), w * 2.0) : mix(vec3(0.1, 0.8, 0.3), vec3(1.0, 0.18, 0.06), w * 2.0 - 1.0); }
void main() {
	#include <beginnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <begin_vertex>
	#include <skinning_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	float lit = 0.55 + 0.45 * abs(normalize(transformedNormal).z);
	#ifdef USE_SKINNING
		if (uBone >= 0.0) {
			float w = 0.0;
			for (int i = 0; i < 4; i++) w += abs(skinIndex[i] - uBone) < 0.5 ? skinWeight[i] : 0.0;
			vColor = heat(clamp(w, 0.0, 1.0)) * lit;
		} else {
			float best = skinWeight.x; float idx = skinIndex.x;
			if (skinWeight.y > best) { best = skinWeight.y; idx = skinIndex.y; }
			if (skinWeight.z > best) { best = skinWeight.z; idx = skinIndex.z; }
			if (skinWeight.w > best) { best = skinWeight.w; idx = skinIndex.w; }
			vColor = (hue(fract(idx * 0.618034)) * 0.8 + 0.15) * lit;
		}
	#else
		vColor = vec3(0.32) * lit;
	#endif
}`;
const WEIGHT_FRAG = /* glsl */ `
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
void main() {
	#include <logdepthbuf_fragment>
	gl_FragColor = vec4(vColor, 1.0);
	#include <colorspace_fragment>
}`;

/** the picked bone's name (the Skeleton window's pick), read only while Weights is on */
let pickedName = '';
/** @type {(() => void) | null} */
let unPick = null;

/** @param {string} mode */
function materialFor(mode) {
	if (mats[mode]) return mats[mode];
	if (mode === 'ao-only') mats[mode] = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 1, metalness: 0 });
	else if (mode === 'normals') mats[mode] = new THREE.MeshNormalMaterial();
	else if (mode === 'uv-checker') mats[mode] = new THREE.MeshBasicMaterial({ map: checkerTexture() });
	else if (mode === 'weights') {
		const m = new THREE.ShaderMaterial({ uniforms: { uBone: { value: -1 } }, vertexShader: WEIGHT_VERT, fragmentShader: WEIGHT_FRAG });
		// the bone index differs per skeleton: set it per object as each one draws
		m.onBeforeRender = (/** @type {any} */ _r, /** @type {any} */ _s, /** @type {any} */ _c, /** @type {any} */ _g, /** @type {any} */ object) => {
			let idx = -1;
			const bones = object?.isSkinnedMesh ? object.skeleton?.bones : null;
			if (bones) {
				const sel = /** @type {any} */ (get(selectedObject));
				if (sel?.isBone) idx = bones.indexOf(sel);
				if (idx < 0 && pickedName) idx = bones.findIndex((/** @type {any} */ b) => b.name === pickedName);
			}
			if (m.uniforms.uBone.value !== idx) {
				m.uniforms.uBone.value = idx;
				m.uniformsNeedUpdate = true;
			}
		};
		mats[mode] = m;
	}
	return mats[mode] ?? null;
}

const OWN = new Set();
/** is this override one of ours (never clear the wireframe's or the UV editor's) @param {any} m */
const ours = (m) => !!m && OWN.has(m);

// ---- wire over shaded --------------------------------------------------------------------------
/** @type {any} */ let wireMat = null;
/** @type {Set<any>} */ const hooked = new Set();
/** @type {ReturnType<typeof setInterval> | 0} */ let rescan = 0;

/** @this {any} @param {any} renderer @param {any} scene @param {any} camera @param {any} geometry @param {any} _m @param {any} group */
function drawWire(renderer, scene, camera, geometry, _m, group) {
	// the main pass only: AO, the outline and the cinematic passes draw with an override of their own
	if (scene?.overrideMaterial || !wireMat) return;
	renderer.renderBufferDirect(camera, scene, geometry, wireMat, this, group);
}

function hookAll() {
	const root = /** @type {any} */ (get(objectsGroup));
	if (!root) return;
	root.traverse((/** @type {any} */ o) => {
		if (!o.isMesh || hooked.has(o) || Object.prototype.hasOwnProperty.call(o, 'onAfterRender')) return;
		o.onAfterRender = drawWire;
		hooked.add(o);
	});
}

function unhookAll() {
	for (const o of hooked) if (o.onAfterRender === drawWire) delete o.onAfterRender;
	hooked.clear();
	if (rescan) clearInterval(rescan);
	rescan = 0;
}

// ---- the switch ---------------------------------------------------------------------------------
let current = 'normal';

/** @param {string} mode */
function apply(mode) {
	const scene = /** @type {any} */ (get(globalScene));
	if (!scene) return;
	if (current === 'wire-over' && mode !== 'wire-over') unhookAll();
	if (current === 'weights' && mode !== 'weights') {
		unPick?.();
		unPick = null;
	}
	const m = materialFor(mode);
	if (m) {
		OWN.add(m);
		scene.overrideMaterial = m;
	} else if (ours(scene.overrideMaterial)) scene.overrideMaterial = null;
	if (mode === 'wire-over' && current !== 'wire-over') {
		wireMat ??= new THREE.MeshBasicMaterial({ wireframe: true, color: get(viewPrefs).wireColor, transparent: true, opacity: 0.55, depthFunc: THREE.LessEqualDepth });
		hookAll();
		rescan = setInterval(hookAll, 500);
	}
	if (mode === 'weights' && !unPick) {
		void import('./rig/rigFixes.js').then((r) => {
			if (current !== 'weights' || unPick) return;
			unPick = r.pickedBone.subscribe((n) => {
				pickedName = n || '';
			});
		});
	}
	current = mode;
}

let started = false;
export function start() {
	if (started) return;
	started = true;
	drawAsActive.subscribe((d) => apply(d));
	globalScene.subscribe(() => apply(get(drawAsActive)));
	viewPrefs.subscribe((p) => wireMat?.color.set(p.wireColor));
}

/** for the suite: which override is on and how many meshes carry the wire hook */
export function drawAsDebug() {
	const scene = /** @type {any} */ (get(globalScene));
	return { current, override: scene?.overrideMaterial?.type ?? null, ours: ours(scene?.overrideMaterial), hooked: hooked.size };
}
