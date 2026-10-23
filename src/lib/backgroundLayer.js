// 65 M2 — THE BACKGROUND LAYER: a shader graph drawn behind the scene (full screen), on a
// picked plane, or — in a headset — on a big sphere around you.
//
// WHERE THE DOCUMENT LIVES: `shaderGraphs['background']`, domain 'background' (the third
// domain, beside surface and post). Its `layer` field ({mode, target, pointer, scroll}) rides
// INSIDE that document, so replication (`shadergraph`), the 'shadergraph' history kind, the
// four save paths and a late joiner's handshake are all inherited — nothing new on the wire.
// A packs preset is COPIED into the document when applied (backgroundPresets.js), so a scene
// never depends on the CDN.
//
// WHAT IS LOCAL: the pointer and scroll inputs (each viewer's own pointer moves their own
// background, nothing is sent — the shared clock alone keeps the drift in step everywhere),
// the device-budget tier, and View ▸ Overrides ▸ Scene shaders, which switches it off here.
//
// HOW IT DRAWS (all three meshes live under the scene-root `background-root` group, never in
// sceneObjects, so nothing here is serialised or sent — the particle-root rule):
//   screen  one triangle covering the viewport at the FAR plane (z = w): behind everything,
//           depth-tested so it never paints over an object whatever order it is drawn in
//   sphere  in XR a screen background is HEAD-LOCKED (it turns with your head), so it becomes
//           the inside of a sphere re-centred on each EYE every draw (zero disparity = at
//           infinity), with mirrored UVs so a pattern that does not tile has no seam behind you
//   plane   the target object's own geometry and world matrix, drawn over its surface with a
//           polygon offset — the object keeps its material, collider and shadow untouched
//
// THE DEVICE BUDGET (backgroundLayerCore.tierFor): on a headset, a phone, or once the quality
// governor gives up the scene look, the material is rebuilt with TP_OCTAVE_CAP = 2, so the
// same graph costs a fraction (fractal noise is where a background's time goes).

import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup, globalCamera, globalRenderer, isVRMode } from '../stores/sceneStore.js';
import { shaderGraphOf, setShaderGraphFor, registerGraphDomain, shaderErrors, shaderClockNow, scheduleCompile, shaderGraphs } from './shaderGraph.js';
import { compileBackgroundGraphToIR } from './shaderCompile.js';
import { shaderTextureFor, resolveShaderTexture, shaderPlaceholderTexture, registerShaderTextureListener } from './shaderTextures.js';
import { normalizeLayer, drawModeFor, tierFor, octaveCapFor, sphereUv, easePointer, pageScrollProgress } from './backgroundLayerCore.js';
import { viewportOverrides, renderLayer } from './viewportOverrides.js';
import { qualityOverrides, phoneQuality } from './qualityGovernor.js';
import { ndcFromClient } from './canvasRect.js';
import { pointerHandRay } from './vr/pointer.js';

/** The ONE background document key (a scene has one background). */
export const BACKGROUND_KEY = 'background';

/** Behind everything else that sorts by renderOrder. */
const RENDER_ORDER = -1e6;
/** The XR sphere's radius: far enough that the head's own movement shows no parallax. */
const SPHERE_RADIUS = 500;

/**
 * What the layer is doing on THIS device — the Inspector section's status line and the e2e
 * seam. `draw` is the mode actually drawn ('none' when off, hidden locally, or a plane whose
 * object is gone); `tier` the budget tier.
 * @type {import('svelte/store').Writable<{draw: string, tier: 'high'|'low', mode: string, compiled: boolean, octaveCap: number, transparent: boolean}>}
 */
export const backgroundState = writable({ draw: 'none', tier: 'high', mode: 'off', compiled: false, octaveCap: 8, transparent: false });

// ---- the shared layer uniforms --------------------------------------------------
// ONE object shared by every material the layer builds, so a mode switch never re-seeds them.
const U = {
	uShaderTime: { value: 0 },
	uPointer: { value: new THREE.Vector4(0.5, 0.5, 0, 0) },
	uScroll: { value: new THREE.Vector2(0, 0) },
	uAspect: { value: 1 },
	resolution: { value: new THREE.Vector2(1, 1) },
	texelSize: { value: new THREE.Vector2(1, 1) }
};

const SCREEN_VERTEX = /* glsl */ `
	varying vec2 vUv;
	void main() {
		vUv = position.xy * 0.5 + 0.5;
		// z = w: the far plane, so every object in front wins the depth test
		gl_Position = vec4(position.xy, 1.0, 1.0);
	}
`;
// the direction mapping MUST match backgroundLayerCore.sphereUv (the pointer reads it back)
const SPHERE_VERTEX = /* glsl */ `
	varying vec2 vUv;
	void main() {
		vec3 d = normalize(position);
		vUv = vec2(abs(atan(d.z, d.x)) / 3.14159265, asin(clamp(d.y, -1.0, 1.0)) / 3.14159265 + 0.5);
		vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
		gl_Position = p.xyww;
	}
`;
const PLANE_VERTEX = /* glsl */ `
	varying vec2 vUv;
	void main() {
		vUv = uv;
		gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
	}
`;

/** @type {any} the scene-root group (Scene.svelte) */
let root = null;
/** @type {Record<'screen'|'sphere'|'plane', any>} */
const meshes = { screen: null, sphere: null, plane: null };
/** @type {Record<'screen'|'sphere'|'plane', any>} */
const materials = { screen: null, sphere: null, plane: null };

/** The last GOOD compile — a broken edit keeps drawing this (the shaderGraph rule). @type {any} */
let compiled = null;
/** uniform name -> slot, for the graph's own params @type {Record<string, {value: any}>} */
let nodeUniforms = {};
/** @type {{name: string, hash: string}[]} */
let textureRefs = [];
let tier = /** @type {'high'|'low'} */ ('high');
let localOn = true;

// ---- the domain compiler ----------------------------------------------------------

/** @param {string[]} errors */
function setErrors(errors) {
	shaderErrors.update((all) => {
		const next = { ...all };
		if (errors.length) next[BACKGROUND_KEY] = errors;
		else delete next[BACKGROUND_KEY];
		return next;
	});
}

/** @param {any} u @returns {any} */
function slotValue(u) {
	if (u.type === 'sampler2D') return u.hash ? (shaderTextureFor(u.hash) ?? shaderPlaceholderTexture()) : null;
	return Array.isArray(u.value) ? u.value.slice() : u.value;
}

/** Compile the background document (the `registerGraphDomain` hook). @param {string} key */
export function compileBackground(key) {
	if (key !== BACKGROUND_KEY) {
		shaderErrors.update((all) => ({ ...all, [key]: ['Only one background per scene: its key is "background".'] }));
		return { ok: false };
	}
	const doc = shaderGraphOf(key);
	if (!doc) {
		compiled = null;
		disposeMaterials();
		setErrors([]);
		refreshDraw();
		return { ok: true };
	}
	const result = compileBackgroundGraphToIR(doc);
	if (!result.ok || !result.ir) {
		setErrors(result.errors ?? ['The background graph did not compile.']);
		refreshDraw();
		return { ok: false, errors: result.errors };
	}
	const ir = result.ir;
	const structural = !compiled || compiled.fragment !== ir.fragment || compiled.hasAlpha !== ir.hasAlpha;
	if (structural) {
		nodeUniforms = {};
		for (const u of ir.uniforms) nodeUniforms[u.name] = { value: slotValue(u) };
		disposeMaterials();
	} else {
		// a VALUE edit (a slider): write the numbers, keep the programs
		for (const u of ir.uniforms) {
			const slot = nodeUniforms[u.name];
			if (slot) slot.value = slotValue(u);
		}
	}
	textureRefs = ir.uniforms.filter((u) => u.type === 'sampler2D' && u.hash).map((u) => ({ name: u.name, hash: u.hash }));
	for (const ref of textureRefs) {
		if (shaderTextureFor(ref.hash)) continue;
		void resolveShaderTexture(ref.hash).then(refillTextures, () => {});
	}
	compiled = ir;
	setErrors([]);
	refreshDraw();
	return { ok: true };
}

function refillTextures() {
	for (const ref of textureRefs) {
		const slot = nodeUniforms[ref.name];
		const tex = shaderTextureFor(ref.hash);
		if (slot && tex) slot.value = tex;
	}
}

/** @param {'screen'|'sphere'|'plane'} mode */
function materialFor(mode) {
	if (materials[mode]) return materials[mode];
	if (!compiled) return null;
	const material = new THREE.ShaderMaterial({
		name: 'tp-background-' + mode,
		vertexShader: mode === 'screen' ? SCREEN_VERTEX : mode === 'sphere' ? SPHERE_VERTEX : PLANE_VERTEX,
		fragmentShader: compiled.fragment,
		// the shared layer uniforms + this graph's own, by reference
		uniforms: { ...U, ...nodeUniforms },
		defines: { TP_OCTAVE_CAP: octaveCapFor(tier) },
		depthWrite: false,
		depthTest: true,
		transparent: !!compiled.hasAlpha,
		// authored colours, shown as authored: the scene's tone mapping would grey a gradient
		toneMapped: false,
		fog: false,
		side: mode === 'sphere' ? THREE.BackSide : mode === 'plane' ? THREE.DoubleSide : THREE.FrontSide
	});
	if (mode === 'plane') {
		// sit ON the target's surface: it already wrote its depth there
		material.polygonOffset = true;
		material.polygonOffsetFactor = -1;
		material.polygonOffsetUnits = -4;
	}
	materials[mode] = material;
	if (meshes[mode]) meshes[mode].material = material;
	return material;
}

function disposeMaterials() {
	for (const mode of /** @type {const} */ (['screen', 'sphere', 'plane'])) {
		materials[mode]?.dispose?.();
		materials[mode] = null;
	}
}

// ---- the meshes ---------------------------------------------------------------------

function ensureMeshes() {
	if (!root || meshes.screen) return;
	const tri = new THREE.BufferGeometry();
	tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
	meshes.screen = new THREE.Mesh(tri, undefined);
	const sphere = new THREE.SphereGeometry(1, 48, 24);
	meshes.sphere = new THREE.Mesh(sphere, undefined);
	meshes.plane = new THREE.Mesh(new THREE.BufferGeometry(), undefined);
	for (const [mode, mesh] of Object.entries(meshes)) {
		mesh.name = 'background-' + mode;
		mesh.frustumCulled = false;
		mesh.renderOrder = RENDER_ORDER;
		mesh.visible = false;
		mesh.matrixAutoUpdate = false;
		mesh.matrixWorldAutoUpdate = false;
		// never pickable: a background is not a thing you click
		mesh.raycast = () => {};
		root.add(mesh);
	}
	// re-centre the sphere on the EYE that is drawing (each XR sub-camera in turn)
	meshes.sphere.onBeforeRender = (/** @type {any} */ _r, /** @type {any} */ _s, /** @type {any} */ camera) => {
		const m = camera.matrixWorld.elements;
		meshes.sphere.matrixWorld.makeScale(SPHERE_RADIUS, SPHERE_RADIUS, SPHERE_RADIUS).setPosition(m[12], m[13], m[14]);
	};
	meshes.plane.onBeforeRender = () => {
		const target = planeTarget();
		if (target) meshes.plane.matrixWorld.copy(target.matrixWorld);
	};
	refreshDraw();
}

/** Scene.svelte hands over the scene-root group. @param {any} group */
export function setBackgroundRoot(group) {
	root = group;
	ensureMeshes();
}

/** The picked plane's MESH (a group target draws on its first mesh). @returns {any} */
function planeTarget() {
	const doc = shaderGraphOf(BACKGROUND_KEY);
	const layer = normalizeLayer(/** @type {any} */ (doc)?.layer);
	if (!layer.target) return null;
	const object = get(objectsGroup)?.getObjectByProperty?.('uuid', layer.target);
	if (!object) return null;
	if (object.isMesh) return object;
	/** @type {any} */
	let found = null;
	object.traverse?.((/** @type {any} */ node) => {
		if (!found && node.isMesh) found = node;
	});
	return found;
}

/** Which mesh shows, per the document + this device. Cheap; called per frame. */
function refreshDraw() {
	const doc = shaderGraphOf(BACKGROUND_KEY);
	const layer = normalizeLayer(/** @type {any} */ (doc)?.layer);
	const xr = !!get(globalRenderer)?.xr?.isPresenting || get(isVRMode) === true;
	const target = layer.mode === 'plane' ? planeTarget() : null;
	const draw = !doc || !compiled || !localOn ? 'none' : drawModeFor(layer, { xr, targetFound: !!target });
	if (meshes.screen) {
		for (const mode of /** @type {const} */ (['screen', 'sphere', 'plane'])) {
			const on = draw === mode;
			const mesh = meshes[mode];
			if (on) {
				const material = materialFor(mode);
				if (!material) {
					mesh.visible = false;
					continue;
				}
				mesh.material = material;
				if (mode === 'plane' && target && mesh.geometry !== target.geometry) mesh.geometry = target.geometry;
			}
			mesh.visible = on && !!mesh.material;
		}
	}
	const prev = get(backgroundState);
	const next = {
		draw,
		tier,
		mode: doc ? layer.mode : 'off',
		compiled: !!compiled,
		octaveCap: octaveCapFor(tier),
		transparent: !!compiled?.hasAlpha
	};
	if (Object.keys(next).some((k) => /** @type {any} */ (next)[k] !== /** @type {any} */ (prev)[k])) backgroundState.set(next);
	return { draw, layer, target };
}

// ---- inputs: pointer + scroll (LOCAL) --------------------------------------------------

const pointer = { x: 0.5, y: 0.5, vx: 0, vy: 0 };
const pointerTarget = { x: 0.5, y: 0.5, clientX: 0, clientY: 0, seen: false, moved: false };
let wheelScroll = 0;
/** @type {number|null} an embed / scroll-hero drives scroll directly (setBackgroundScroll) */
let scrollOverride = null;
const scrollState = { value: 0, speed: 0 };
/** @type {(() => void)[]} */
const stops = [];
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

/**
 * Drive the Scroll input from outside (a scroll-driven export, M7). `null` hands it back to the
 * page scroll / wheel. @param {number|null} progress 0..1
 */
export function setBackgroundScroll(progress) {
	scrollOverride = progress === null ? null : Math.max(0, Math.min(1, Number(progress) || 0));
}

function startInputs() {
	if (typeof window === 'undefined' || stops.length) return;
	const onMove = (/** @type {PointerEvent} */ e) => {
		pointerTarget.clientX = e.clientX;
		pointerTarget.clientY = e.clientY;
		pointerTarget.seen = true;
		pointerTarget.moved = true;
	};
	const onWheel = (/** @type {WheelEvent} */ e) => {
		// only over the viewport: a scrolling panel is not the background's scroll
		const canvas = get(globalRenderer)?.domElement;
		if (canvas && e.target !== canvas) return;
		wheelScroll = Math.max(0, Math.min(1, wheelScroll + e.deltaY * 0.0004));
	};
	window.addEventListener('pointermove', onMove, { passive: true });
	window.addEventListener('wheel', onWheel, { passive: true });
	stops.push(() => window.removeEventListener('pointermove', onMove));
	stops.push(() => window.removeEventListener('wheel', onWheel));
}

/** Where the pointer is in the layer's own space, or null if it is not over it. */
function pointerTargetUv(/** @type {string} */ draw, /** @type {any} */ target, /** @type {any} */ camera) {
	if (draw === 'sphere') {
		const ray = pointerHandRay?.();
		if (!ray) return null;
		const d = ray.ray.direction;
		return sphereUv(d.x, d.y, d.z);
	}
	if (draw === 'plane') {
		if (!target) return null;
		/** @type {any} */
		let caster = null;
		if (get(isVRMode)) caster = pointerHandRay?.();
		else if (pointerTarget.seen && camera) {
			const p = ndcFromClient(pointerTarget.clientX, pointerTarget.clientY);
			ndc.set(p.x, p.y);
			raycaster.setFromCamera(ndc, camera);
			caster = raycaster;
		}
		if (!caster) return null;
		const hit = caster.intersectObject(target, false)[0];
		return hit?.uv ? [hit.uv.x, hit.uv.y] : null;
	}
	if (!pointerTarget.seen) return null;
	const p = ndcFromClient(pointerTarget.clientX, pointerTarget.clientY);
	return [p.x * 0.5 + 0.5, p.y * 0.5 + 0.5];
}

// ---- the per-frame tick ------------------------------------------------------------------

let lastTick = 0;
/** test seam: hold the clock so a frame differs only by its inputs @type {number|null} */
let frozenClock = null;
/** @param {number|null} t seconds, or null to follow the shared clock again */
export function setBackgroundClockForTest(t) {
	frozenClock = t === null ? null : Number(t);
}
const bufferSize = new THREE.Vector2();
const box = new THREE.Box3();
const boxSize = new THREE.Vector3();
const worldScale = new THREE.Vector3();

/**
 * ONE per-frame entry (a single Scene useTask line). Inert — one store read — when the scene
 * has no background document.
 * @param {any} [camera] @param {any} [renderer] @param {number} [now] ms
 */
export function tickBackgroundLayer(camera = get(globalCamera), renderer = get(globalRenderer), now = performance.now()) {
	if (!get(shaderGraphs)[BACKGROUND_KEY]) {
		if (meshes.screen && (meshes.screen.visible || meshes.sphere.visible || meshes.plane.visible)) refreshDraw();
		lastTick = now;
		return;
	}
	const dt = lastTick ? Math.min((now - lastTick) / 1000, 0.1) : 0.016;
	lastTick = now;
	// the budget tier: a change rebuilds the programs with the new octave cap
	const q = get(qualityOverrides);
	const xr = !!renderer?.xr?.isPresenting;
	const nextTier = tierFor({ xr, phone: phoneQuality(), postOff: q.postOff, dprScale: q.dprScale });
	if (nextTier !== tier) {
		tier = nextTier;
		disposeMaterials();
	}
	const { draw, layer, target } = refreshDraw();
	if (draw === 'none') return;
	U.uShaderTime.value = frozenClock ?? shaderClockNow();
	if (renderer) {
		renderer.getDrawingBufferSize(bufferSize);
		U.resolution.value.set(Math.max(bufferSize.x, 1), Math.max(bufferSize.y, 1));
		U.texelSize.value.set(1 / U.resolution.value.x, 1 / U.resolution.value.y);
	}
	if (draw === 'screen') U.uAspect.value = U.resolution.value.x / U.resolution.value.y;
	else if (draw === 'sphere') U.uAspect.value = 1;
	else if (target) {
		if (!target.geometry.boundingBox) target.geometry.computeBoundingBox();
		box.copy(target.geometry.boundingBox).getSize(boxSize);
		target.getWorldScale(worldScale);
		boxSize.multiply(worldScale);
		const h = boxSize.y > 1e-4 ? boxSize.y : boxSize.z;
		U.uAspect.value = h > 1e-4 ? Math.abs(boxSize.x / h) : 1;
	}
	if (layer.pointer && compiled?.usesPointer) {
		// raycasting a plane or the hand ray only when something could have moved it
		if (draw === 'screen' || draw === 'sphere' || pointerTarget.moved || get(isVRMode)) {
			const uv = pointerTargetUv(draw, target, camera);
			if (uv) {
				pointerTarget.x = uv[0];
				pointerTarget.y = uv[1];
			}
			pointerTarget.moved = false;
		}
		easePointer(pointer, pointerTarget.x, pointerTarget.y, dt);
		U.uPointer.value.set(pointer.x, pointer.y, pointer.vx, pointer.vy);
	}
	if (layer.scroll && compiled?.usesScroll) {
		const page = typeof document !== 'undefined' ? pageScrollProgress(/** @type {any} */ (document.scrollingElement)) : null;
		const want = scrollOverride ?? page ?? wheelScroll;
		const k = 1 - Math.exp(-8 * dt);
		const next = scrollState.value + (want - scrollState.value) * k;
		scrollState.speed += ((dt > 0 ? (next - scrollState.value) / dt : 0) - scrollState.speed) * k;
		scrollState.value = next;
		U.uScroll.value.set(scrollState.value, scrollState.speed);
	}
}

// ---- authoring --------------------------------------------------------------------------

/**
 * Change the layer settings (mode / target / pointer / scroll) — one replicated, undoable
 * document write. @param {Partial<import('./backgroundLayerCore.js').LayerSettings>} patch
 */
export function setBackgroundLayer(patch) {
	const doc = shaderGraphOf(BACKGROUND_KEY);
	if (!doc) return null;
	const layer = normalizeLayer({ ...normalizeLayer(/** @type {any} */ (doc).layer), ...patch });
	return setShaderGraphFor(BACKGROUND_KEY, { layer });
}

/**
 * Put a preset document in the scene as THE background (a copy — the scene never points at
 * the CDN). Keeps the current mode/target when one exists, so switching presets on a plane
 * stays on that plane. @param {any} presetDoc a normalized preset (backgroundPresetsCore)
 */
export function applyBackgroundDoc(presetDoc) {
	const current = shaderGraphOf(BACKGROUND_KEY);
	const prev = current ? normalizeLayer(/** @type {any} */ (current).layer) : null;
	const layer = normalizeLayer({ ...(prev ?? {}), pointer: presetDoc.layer?.pointer, scroll: presetDoc.layer?.scroll, mode: prev?.mode ?? 'screen' });
	return setShaderGraphFor(BACKGROUND_KEY, {
		domain: 'background',
		name: presetDoc.name,
		preset: presetDoc.preset,
		nodes: structuredClone(presetDoc.nodes),
		edges: structuredClone(presetDoc.edges),
		layer
	});
}

/** Remove the background (the sky shows again). Undoable like any graph delete. */
export function removeBackground() {
	if (!shaderGraphOf(BACKGROUND_KEY)) return false;
	setShaderGraphFor(BACKGROUND_KEY, null);
	return true;
}

// ---- wiring ---------------------------------------------------------------------------

let started = false;

/** Idempotent; at module load (the postGraphs precedent) and safe again from a test. */
export function startBackgroundLayer() {
	if (started) return;
	started = true;
	registerGraphDomain('background', compileBackground, (key) => key === BACKGROUND_KEY);
	viewportOverrides.subscribe(() => {
		localOn = renderLayer('shaders');
		refreshDraw();
	});
	// a plane target can arrive after the document (a joiner) or be deleted and undeleted
	objectsGroup.subscribe(() => {
		if (shaderGraphOf(BACKGROUND_KEY)) refreshDraw();
	});
	registerShaderTextureListener(refillTextures);
	startInputs();
	// a document restored before this module loaded still compiles
	if (shaderGraphOf(BACKGROUND_KEY)) scheduleCompile(BACKGROUND_KEY, 0);
}

startBackgroundLayer();

/** test/debug view */
export function backgroundLayerDebug() {
	const doc = shaderGraphOf(BACKGROUND_KEY);
	return {
		...get(backgroundState),
		layer: doc ? normalizeLayer(/** @type {any} */ (doc).layer) : null,
		preset: /** @type {any} */ (doc)?.preset ?? null,
		pointer: { ...pointer },
		scroll: { ...scrollState },
		uniforms: { aspect: U.uAspect.value, time: U.uShaderTime.value, resolution: U.resolution.value.toArray() },
		visible: Object.fromEntries(Object.entries(meshes).map(([k, m]) => [k, !!m?.visible])),
		programs: Object.fromEntries(Object.entries(materials).map(([k, m]) => [k, !!m])),
		usesPointer: !!compiled?.usesPointer,
		usesScroll: !!compiled?.usesScroll
	};
}

/** test seam: the meshes (for a pixel probe / render-order check) */
export function backgroundMeshes() {
	return { ...meshes };
}
