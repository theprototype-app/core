// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, globalScene, globalRenderer, selectedObjects } from '../stores/sceneStore';
import { showInfoToast, dismissToastById } from '../stores/appStore';
import {
	placeholderStyle,
	placeholderGrid,
	placeholderStuckSeconds,
	loadOf,
	loadRevision,
	visualState,
	progressOf,
	loadNow,
	currentStuckMs,
	VIS_LOADING,
	VIS_FAILED
} from './loadStates';

// 36 U9 — THE PLACEHOLDERS A LOADING KIT PIECE SHOWS, drawn as TWO instanced calls whatever
// the count (500 boxes = 2 draw calls, the Quest budget's whole point):
//   the BODY   one InstancedMesh of a unit box. 'boxes' (33 L1's grey blocks) is a
//              MeshStandardMaterial tinted per instance (grey / amber stuck / red failed);
//              'modern' (the default since 36 L1) is ONE ShaderMaterial — a translucent blue hologram with a fresnel rim, a
//              slow pulse, a scan band sweeping up, depth fade, a FILL LEVEL that is the piece's
//              byte progress and an optional triplanar world-space grid/checker.
//   the ICONS  one InstancedMesh of quads, a screen-constant "!" disc over every FAILED box
//              (drawn only while something failed — otherwise hidden, so no call).
// Both live at the SCENE ROOT beside objectsGroup (golden rule 5: never saved, sent or undone)
// and are not pickable themselves — the STUB is (packRefs gives each one a box raycast), so
// selection, the gizmo, the Inspector, multi-select and the context menu are the ordinary
// object paths and a transform made while loading is an ordinary replicated edit.
//
// PER FRAME, no allocations: the body's `updateMatrixWorld` (which the renderer calls on every
// frame before it projects anything) re-reads each stub's world matrix and load state into the
// preallocated instance buffers, flagging an upload only when something actually changed. A
// stub moved by the gizmo is therefore followed on the frame it moves.

const BODY_NAME = 'kit-placeholders';
const ICON_NAME = 'kit-placeholder-icons';

/** the 33 L1 grey */
const GREY = new THREE.Color(0x9aa0a8);
const AMBER = new THREE.Color(0xf2a33a);
const RED = new THREE.Color(0xe5484d);
const HOLO = new THREE.Color(0x3ba7ff);
/** a 1 m block standing on the origin, for stubs saved before 1.19 (no packRef.box) */
export const DEFAULT_BOX = [-0.5, 0, -0.5, 0.5, 1, 0.5];

/**
 * @typedef {{stub: any, url: string, box: number[]}} PlaceholderEntry
 */

/** @type {PlaceholderEntry[]} */
let entries = [];
/** @type {any} */
let body = null;
/** @type {any} */
let icons = null;
/** @type {any} */
let classicMaterial = null;
/** @type {any} */
let modernMaterial = null;
/** @type {any} */
let iconMaterial = null;
let capacity = 0;
let startedAt = 0;
/** how many entries are red, refreshed per frame (the toast + the suites read it) */
let failedCount = 0;
let failedStubs = 0;
/** @type {(() => void) | null} */
let retryAllHook = null;
/** per-instance state last uploaded, so a frame that changed nothing uploads nothing */
let lastSig = new Float32Array(0);
/** @type {Set<string>} */
const failedUrlScratch = new Set();
// setting values the frame reads, kept current by subscriptions (a get() per frame allocates)
let animSpeed = 1;
let stuckMs = 10000;
/** @type {any} */
let renderer = null;
placeholderStuckSeconds.subscribe((s) => (stuckMs = s * 1000));
globalRenderer.subscribe((r) => (renderer = r));

// scratch, allocated once
const _m = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _toHost = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _size = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _col = new THREE.Color();
const _top = new THREE.Vector3();

/** packRefs registers the Retry-all action (it owns the refills; this module must not import it).
 * @param {() => void} fn */
export function setRetryAllHook(fn) {
	retryAllHook = fn;
}

// ---- materials -------------------------------------------------------------------------

const MODERN_VERT = /* glsl */ `
attribute vec4 aInfo;
varying vec3 vLocal;
varying vec3 vWorld;
varying vec3 vWorldNormal;
varying vec3 vViewDir;
varying vec4 vInfo;
varying float vDepth;
void main() {
	vLocal = position;
	vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
	vWorld = wp.xyz;
	vWorldNormal = normalize(mat3(modelMatrix * instanceMatrix) * normal);
	vec4 mv = viewMatrix * wp;
	vDepth = -mv.z;
	vViewDir = cameraPosition - wp.xyz;
	vInfo = aInfo;
	gl_Position = projectionMatrix * mv;
}
`;

const MODERN_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uBase;
uniform vec3 uAmber;
uniform vec3 uRed;
uniform float uGridOn;
uniform float uGridSize;
uniform vec3 uGridColor;
uniform float uGridOpacity;
varying vec3 vLocal;
varying vec3 vWorld;
varying vec3 vWorldNormal;
varying vec3 vViewDir;
varying vec4 vInfo;
varying float vDepth;

// an anti-aliased grid line in a 2D world plane, 1 on the line, 0 between
float gridLine(vec2 p, float size) {
	vec2 g = p / size;
	vec2 w = max(fwidth(g), vec2(1e-4));
	vec2 f = abs(fract(g - 0.5) - 0.5) / (w * 1.25);
	return 1.0 - min(min(f.x, f.y), 1.0);
}

void main() {
	float progress = vInfo.x;
	float state = vInfo.y;
	float selected = vInfo.z;
	float phase = vInfo.w;
	vec3 tint = state > 1.5 ? uRed : (state > 0.5 ? uAmber : uBase);
	float t = uTime;

	vec3 n = normalize(vWorldNormal);
	if (!gl_FrontFacing) n = -n;
	vec3 v = normalize(vViewDir);
	float fres = pow(1.0 - clamp(abs(dot(n, v)), 0.0, 1.0), 2.2);

	// the fill: bytes / total from the bottom up; an unknown size breathes instead
	float y01 = clamp(vLocal.y + 0.5, 0.0, 1.0);
	float level = progress < 0.0 ? 0.45 + 0.3 * sin(t * 1.7 + phase) : progress;
	float filled = step(y01, level);
	float surface = (level > 0.002 && level < 0.998) ? smoothstep(0.035, 0.0, abs(y01 - level)) : 0.0;

	// living: a slow pulse and a scan band spreading upward
	float pulse = 0.82 + 0.18 * sin(t * 2.1 + phase);
	float sweep = fract(t * 0.28 + phase * 0.13);
	float band = smoothstep(0.09, 0.0, abs(y01 - sweep)) * (1.0 - sweep * 0.5);

	// the box's own edges (local space: two coordinates at the face boundary)
	vec3 a = abs(vLocal) * 2.0;
	float hi = max(a.x, max(a.y, a.z));
	float lo = min(a.x, min(a.y, a.z));
	float second = a.x + a.y + a.z - hi - lo;
	float edge = smoothstep(0.93, 0.995, second);

	// the prototype grid: triplanar in WORLD metres, so every box reads at one scale
	vec3 bw = pow(abs(n), vec3(6.0));
	bw /= max(bw.x + bw.y + bw.z, 1e-4);
	float grid = gridLine(vWorld.zy, uGridSize) * bw.x + gridLine(vWorld.xz, uGridSize) * bw.y + gridLine(vWorld.xy, uGridSize) * bw.z;
	vec3 cell = floor(vWorld / uGridSize + 1e-3);
	float checker = mod(cell.x + cell.y + cell.z, 2.0);

	vec3 col = tint * (0.55 + 0.45 * filled) + tint * fres * 0.9;
	col += vec3(0.85, 0.95, 1.0) * (surface * 0.9 + band * 0.35 + edge * 0.35);
	float alpha = 0.07 + 0.16 * filled + 0.55 * fres + 0.55 * surface + 0.22 * band + 0.42 * edge;
	if (uGridOn > 0.5) {
		col = mix(col, uGridColor, grid * uGridOpacity);
		alpha += grid * uGridOpacity * 0.55 + checker * 0.04 * uGridOpacity;
	}
	if (selected > 0.5) {
		col = mix(col, vec3(1.0), 0.18 + 0.25 * edge);
		alpha += 0.12 + 0.35 * edge;
	}
	// depth fade: far boxes recede into the scene instead of stacking into a blue wall
	alpha *= mix(1.0, 0.4, smoothstep(12.0, 70.0, vDepth));
	alpha *= pulse;
	gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.92));
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}
`;

const ICON_VERT = /* glsl */ `
uniform vec2 uViewport;
uniform float uPx;
varying vec2 vUv;
void main() {
	vUv = uv;
	vec4 clip = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
	clip.xy += position.xy * (uPx * 2.0 / uViewport) * clip.w;
	gl_Position = clip;
}
`;

const ICON_FRAG = /* glsl */ `
varying vec2 vUv;
void main() {
	vec2 p = vUv - 0.5;
	float r = length(p);
	if (r > 0.5) discard;
	float disc = smoothstep(0.5, 0.46, r);
	// the "!": a bar and a dot
	float bar = step(abs(p.x), 0.06) * step(-0.05, p.y) * step(p.y, 0.3);
	float dot2 = step(length(p - vec2(0.0, -0.18)), 0.07);
	float mark = max(bar, dot2);
	vec3 col = mix(vec3(0.898, 0.282, 0.302), vec3(1.0), mark);
	float ring = smoothstep(0.46, 0.44, r);
	col = mix(vec3(1.0), col, ring);
	gl_FragColor = vec4(col, disc);
	#include <colorspace_fragment>
}
`;

function makeModernMaterial() {
	const grid = get(placeholderGrid);
	return new THREE.ShaderMaterial({
		name: 'placeholder-hologram',
		vertexShader: MODERN_VERT,
		fragmentShader: MODERN_FRAG,
		transparent: true,
		depthWrite: false,
		side: THREE.DoubleSide,
		toneMapped: false,
		uniforms: {
			uTime: { value: 0 },
			uBase: { value: HOLO.clone() },
			uAmber: { value: AMBER.clone() },
			uRed: { value: RED.clone() },
			uGridOn: { value: grid.on ? 1 : 0 },
			uGridSize: { value: grid.size },
			uGridColor: { value: new THREE.Color(grid.color) },
			uGridOpacity: { value: grid.opacity }
		}
	});
}

function makeIconMaterial() {
	return new THREE.ShaderMaterial({
		name: 'placeholder-error-icon',
		vertexShader: ICON_VERT,
		fragmentShader: ICON_FRAG,
		transparent: true,
		depthWrite: false,
		depthTest: false,
		uniforms: { uViewport: { value: new THREE.Vector2(1280, 720) }, uPx: { value: 22 } }
	});
}

/** the live grid settings reach the shader as they change (no rebuild) */
placeholderGrid.subscribe((grid) => {
	animSpeed = grid.speed;
	if (!modernMaterial) return;
	const u = modernMaterial.uniforms;
	u.uGridOn.value = grid.on ? 1 : 0;
	u.uGridSize.value = grid.size;
	u.uGridColor.value.set(grid.color);
	u.uGridOpacity.value = grid.opacity;
});

/** switching the style swaps the body's material in place (same instances, same buffers) */
placeholderStyle.subscribe((style) => {
	if (!body) return;
	body.material = style === 'modern' ? (modernMaterial ??= makeModernMaterial()) : classicMaterial;
	lastSig.fill(-1);
});

// ---- the meshes ------------------------------------------------------------------------

function disposeAll() {
	for (const mesh of [body, icons]) {
		if (!mesh) continue;
		mesh.parent?.remove(mesh);
		mesh.geometry.dispose();
	}
	classicMaterial?.dispose();
	modernMaterial?.dispose();
	iconMaterial?.dispose();
	body = icons = classicMaterial = modernMaterial = iconMaterial = null;
	capacity = 0;
}

/** @param {number} n */
function build(n) {
	disposeAll();
	capacity = Math.max(32, n);
	const geometry = new THREE.BoxGeometry(1, 1, 1);
	geometry.setAttribute('aInfo', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4));
	classicMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
	const style = get(placeholderStyle);
	if (style === 'modern') modernMaterial = makeModernMaterial();
	body = new THREE.InstancedMesh(geometry, style === 'modern' ? modernMaterial : classicMaterial, capacity);
	body.name = BODY_NAME;
	body.frustumCulled = false;
	body.raycast = () => {};
	body.renderOrder = 2;
	body.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
	body.userData.capacity = capacity;
	// THE PER-FRAME HOOK: the renderer calls this before it projects the scene
	const own = THREE.InstancedMesh.prototype.updateMatrixWorld;
	body.updateMatrixWorld = function (/** @type {boolean} */ force) {
		own.call(this, force);
		syncFrame();
	};
	iconMaterial = makeIconMaterial();
	icons = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), iconMaterial, capacity);
	icons.name = ICON_NAME;
	icons.frustumCulled = false;
	icons.raycast = () => {};
	icons.renderOrder = 3000;
	icons.visible = false;
	lastSig = new Float32Array(capacity * 8).fill(-1);
	startedAt = performance.now();
}

/**
 * The stubs to draw now (packRefs calls this from every scan). An empty list removes both
 * meshes and every GPU resource.
 * @param {PlaceholderEntry[]} list
 */
export function drawPlaceholders(list) {
	entries = list;
	/** @type {any} */
	const scene = get(globalScene);
	if (!scene || !list.length) {
		if (body) disposeAll();
		failedCount = failedStubs = 0;
		updateFailureToast();
		return;
	}
	if (!body || capacity < list.length) build(list.length);
	// beside objectsGroup (in its parent — the world rig a VR world-grab moves), never in it
	/** @type {any} */
	const host = get(objectsGroup)?.parent ?? scene;
	if (body.parent !== host) host.add(body);
	if (icons.parent !== host) host.add(icons);
	body.count = list.length;
	lastSig.fill(-1);
	syncFrame();
}

/** the selection set as a Set, rebuilt only when the store changes */
let selectedSet = new Set();
selectedObjects.subscribe((uuids) => {
	selectedSet = new Set(Array.isArray(uuids) ? uuids : []);
});

/** Write every instance from its stub and its file's state. Allocation-free. */
function syncFrame() {
	if (!body || !entries.length) return;
	const host = body.parent;
	if (!host) return;
	const now = loadNow();
	if (modernMaterial) modernMaterial.uniforms.uTime.value = ((performance.now() - startedAt) / 1000) * animSpeed;
	_toHost.copy(host.matrixWorld).invert();
	const info = body.geometry.attributes.aInfo;
	const colors = body.instanceColor;
	let matricesChanged = false;
	let infoChanged = false;
	let failed = 0;
	let iconCount = 0;
	const failedUrls = failedUrlScratch;
	failedUrls.clear();
	for (let i = 0; i < entries.length; i++) {
		const { stub, url, box } = entries[i];
		const load = loadOf(url);
		const state = visualState(load, now, stuckMs);
		const progress = progressOf(load);
		const selected = selectedSet.has(stub.uuid) ? 1 : 0;
		// the matrix: the stub's world pose times its box, in the host's frame
		_pos.set((box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2);
		_size.set(Math.max(0.01, box[3] - box[0]), Math.max(0.01, box[4] - box[1]), Math.max(0.01, box[5] - box[2]));
		_local.compose(_pos, _q, _size);
		_m.multiplyMatrices(_toHost, stub.matrixWorld).multiply(_local);
		const e = _m.elements;
		const at = i * 16;
		const arr = body.instanceMatrix.array;
		for (let k = 0; k < 16; k++) {
			if (arr[at + k] !== e[k]) {
				arr[at + k] = e[k];
				matricesChanged = true;
			}
		}
		const s = i * 8;
		if (lastSig[s] !== progress || lastSig[s + 1] !== state || lastSig[s + 2] !== selected) {
			lastSig[s] = progress;
			lastSig[s + 1] = state;
			lastSig[s + 2] = selected;
			info.array[i * 4] = progress;
			info.array[i * 4 + 1] = state;
			info.array[i * 4 + 2] = selected;
			info.array[i * 4 + 3] = (i * 0.61803) % 6.283;
			_col.copy(state === VIS_FAILED ? RED : state === 1 ? AMBER : GREY);
			if (selected) _col.lerp(HOLO, 0.45);
			colors.array[i * 3] = _col.r;
			colors.array[i * 3 + 1] = _col.g;
			colors.array[i * 3 + 2] = _col.b;
			infoChanged = true;
		}
		if (state === VIS_FAILED) {
			failed++;
			failedUrls.add(url);
			// the icon sits on the box's top centre
			_top.set(_pos.x, box[4] + 0.05, _pos.z).applyMatrix4(stub.matrixWorld).applyMatrix4(_toHost);
			_m.makeTranslation(_top.x, _top.y, _top.z);
			icons.setMatrixAt(iconCount++, _m);
		}
	}
	if (matricesChanged) body.instanceMatrix.needsUpdate = true;
	if (infoChanged) {
		info.needsUpdate = true;
		colors.needsUpdate = true;
	}
	icons.count = iconCount;
	icons.visible = iconCount > 0;
	if (iconCount) {
		icons.instanceMatrix.needsUpdate = true;
		const el = renderer?.domElement;
		if (el && el.clientWidth) iconMaterial.uniforms.uViewport.value.set(el.clientWidth, el.clientHeight);
	}
	if (failed !== failedStubs || failedUrls.size !== failedCount) {
		failedStubs = failed;
		failedCount = failedUrls.size;
		updateFailureToast();
	}
}
// ---- the scene-level failure toast -------------------------------------------------------

const TOAST_ID = 'placeholders-failed';
function updateFailureToast() {
	if (!failedStubs) {
		dismissToastById(TOAST_ID);
		return;
	}
	const text = failedStubs + (failedStubs === 1 ? ' object' : ' objects') + ' failed to load' + (failedCount > 1 ? ' (' + failedCount + ' files)' : '');
	showInfoToast(TOAST_ID, text, [{ label: 'Retry all', action: () => retryAllHook?.() }]);
}

// a phase change (a failure, a retry) must reach the toast even on a frame-starved page
loadRevision.subscribe(() => {
	if (body) syncFrame();
});

// ---- reads (the UI, the suites) -----------------------------------------------------------

/** What is drawn: counts, style and the draw calls it costs. */
export function placeholderStats() {
	return {
		count: body?.parent ? body.count : 0,
		failed: failedStubs,
		failedFiles: failedCount,
		icons: icons?.visible ? icons.count : 0,
		style: get(placeholderStyle),
		drawCalls: (body?.parent && body.count ? 1 : 0) + (icons?.visible ? 1 : 0),
		capacity
	};
}

/** What each instance carries right now — the values the GPU draws (the suites read it). */
export function placeholderInstances() {
	if (!body) return [];
	const info = body.geometry.attributes.aInfo.array;
	return entries.map((entry, i) => ({ uuid: entry.stub.uuid, progress: info[i * 4], state: info[i * 4 + 1], selected: info[i * 4 + 2] }));
}

/**
 * 36 L2: is EVERY piece still waiting stuck (amber) or failed (red)? A camera hold ends on
 * it — a broken piece never extends a hold. False while nothing is drawn: no placeholder is
 * not evidence that everything stalled.
 */
export function allPlaceholdersStalled(now = loadNow(), stuckMs = currentStuckMs()) {
	if (!entries.length) return false;
	for (let i = 0; i < entries.length; i++) if (visualState(loadOf(entries[i].url), now, stuckMs) === VIS_LOADING) return false;
	return true;
}

/** for the per-frame allocation probe: the frame body, callable on its own */
export function placeholderFrameForTest() {
	syncFrame();
}

/** @param {any} stub @returns {number[]} the box a stub's placeholder covers (root frame) */
export function placeholderBoxOf(stub) {
	const box = stub?.userData?.packRef?.box;
	return Array.isArray(box) && box.length === 6 ? box : DEFAULT_BOX;
}
