// 77 K1/K2/K3 — THE CUT RUNTIME: draws the program over the rendered frame. A LAZY chunk: the
// player imports it the first time a sequence with clips, titles or transitions plays or is
// scrubbed (sequencePlayer.ensureCut), and it registers into the programOverlay seam, which
// Outline.svelte calls right after the main render — so the recorder and the export capture it.
//
// Per frame, from `programAt(seq, t)` (cutCore, pure):
//   1. a crossfade / wipe between two CAMERA SHOTS: the outgoing shot is rendered into a target
//      from a scratch camera posed like the player's glide hook, and drawn over the live
//      incoming shot (fading out, or masked by the wipe). Only during the transition; that half
//      carries no post stack (QUESTIONS-77-cut-a fork 3) — tone mapping is applied in the shader
//   2. clip layers bottom to top: one quad each, its texture from the item's decoder
//      (clipMedia.js), fitted cover / contain, faded or wiped; a crossfade draws the previous
//      clip (held on its last frame) underneath first
//   3. titles (troika text, the deployment's self-hosted fonts — troikaFonts.js), with a bar
//      behind the lower-third presets; a title wipe is troika's clipRect
//   4. veils (fades, dips) as full-frame colour quads
// Everything is LOCAL: each peer draws its own frame from the replicated document and the
// shared clock, which is the player's netcode (golden rule 8). Nothing here sends anything.
//
// The overlay space is 1080 units high and as wide as the canvas aspect, origin at the centre,
// so titles keep their size at any resolution.

import * as THREE from 'three';
import { get } from 'svelte/store';
// @ts-ignore - troika-three-text ships no type declarations (threlte's <Text> dependency)
import { Text } from 'troika-three-text';
import { sequences } from '../sequences';
import { programAt } from '../cutCore';
import { findCameraObject, cameraSpec } from '../cameraObjects';
import { withMarkersHidden } from '../helperLayer';
import { setProgramOverlay } from '../programOverlay';
import { decoderFor, clipsPending, sweepDecoders, clipDebug, disposeClips } from './clipMedia.js';
import { titlePreset, titleAnchor } from './titlePresets.js';

const H = 1080;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// mode 0 = texture, 1 = flat colour. `fit` scales uv about the centre (cover / contain);
// `wipe` = (progress, dir.x, dir.y, invert) — the incoming side shows where s < p.
const FRAG = /* glsl */ `
uniform sampler2D map;
uniform vec3 color;
uniform float opacity;
uniform float mode;
uniform vec2 fit;
uniform vec4 wipe;
varying vec2 vUv;
#include <common>
void main() {
	vec4 c = vec4(color, 1.0);
	if (mode < 0.5) {
		vec2 uv = (vUv - 0.5) * fit + 0.5;
		if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
		c = texture2D(map, uv);
	}
	float a = c.a * opacity;
	if (wipe.x >= 0.0) {
		float s = wipe.y > 0.5 ? vUv.x : wipe.y < -0.5 ? 1.0 - vUv.x : wipe.z > 0.5 ? vUv.y : 1.0 - vUv.y;
		float shown = 1.0 - smoothstep(wipe.x - 0.01, wipe.x + 0.01, s);
		a *= wipe.w > 0.5 ? 1.0 - shown : shown;
	}
	if (a <= 0.0) discard;
	gl_FragColor = vec4(c.rgb, a);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`;

const WIPE_DIR = /** @type {Record<string, [number, number]>} */ ({
	right: [1, 0], // the edge travels left → right
	left: [-1, 0],
	up: [0, 1],
	down: [0, -1]
});

/** @param {boolean} toneMapped */
function layerMaterial(toneMapped) {
	return new THREE.ShaderMaterial({
		uniforms: {
			map: { value: null },
			color: { value: new THREE.Color(0, 0, 0) },
			opacity: { value: 1 },
			mode: { value: 0 },
			fit: { value: new THREE.Vector2(1, 1) },
			wipe: { value: new THREE.Vector4(-1, 0, 0, 0) }
		},
		vertexShader: VERT,
		fragmentShader: FRAG,
		transparent: true,
		depthTest: false,
		depthWrite: false,
		toneMapped
	});
}

/** @type {any} */
let state = null;

function build() {
	const scene = new THREE.Scene();
	const camera = new THREE.OrthographicCamera(-H / 2, H / 2, H / 2, -H / 2, -10, 10);
	const geometry = new THREE.PlaneGeometry(1, 1);
	return {
		scene,
		camera,
		geometry,
		/** @type {THREE.Mesh[]} */ quads: [],
		/** @type {THREE.Mesh[]} */ shotQuads: [],
		/** @type {Map<string, any>} */ texts: new Map(),
		/** @type {THREE.Mesh[]} */ bars: [],
		/** @type {THREE.WebGLRenderTarget|null} */ rt: null,
		shotCam: new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1000),
		frames: 0,
		barUsed: 0,
		last: /** @type {any} */ (null)
	};
}

/** the i-th pooled quad of a pool (made on demand) @param {THREE.Mesh[]} pool @param {number} i @param {boolean} [toneMapped] */
function quad(pool, i, toneMapped = false) {
	while (pool.length <= i) {
		const mesh = new THREE.Mesh(state.geometry, layerMaterial(toneMapped));
		mesh.frustumCulled = false;
		mesh.visible = false;
		state.scene.add(mesh);
		pool.push(mesh);
	}
	return pool[i];
}

/** @param {THREE.Mesh} mesh @param {number} W @param {number} order */
function fullFrame(mesh, W, order) {
	mesh.scale.set(W, H, 1);
	mesh.position.set(0, 0, 0);
	mesh.renderOrder = order;
	mesh.visible = true;
	return /** @type {THREE.ShaderMaterial} */ (mesh.material);
}

/** cover / contain as a uv scale @param {number} frameA @param {number} clipA @param {string} fit */
function fitScale(frameA, clipA, fit) {
	if (fit === 'contain')
		return clipA > frameA ? [1, clipA / frameA] : [frameA / clipA, 1];
	return clipA > frameA ? [frameA / clipA, 1] : [1, clipA / frameA];
}

/** @param {THREE.ShaderMaterial} m @param {{p: number, dir: string}|null} wipe @param {boolean} invert */
function setWipe(m, wipe, invert) {
	const w = /** @type {THREE.Vector4} */ (m.uniforms.wipe.value);
	if (!wipe) return w.set(-1, 0, 0, 0);
	const [x, y] = WIPE_DIR[wipe.dir] ?? WIPE_DIR.right;
	w.set(wipe.p, x, y, invert ? 1 : 0);
}

const posA = new THREE.Vector3();
const posB = new THREE.Vector3();
const quatA = new THREE.Quaternion();
const quatB = new THREE.Quaternion();
const scl = new THREE.Vector3();

/** Pose the scratch camera like the shot (and its glide). False = cannot (missing, ortho). @param {any} item @param {number} blend @param {number} aspect */
function poseShot(item, blend, aspect) {
	const a = findCameraObject(item.camera);
	if (!a) return false;
	const sa = cameraSpec(a);
	if (sa.kind === 'orthographic') return false;
	const cam = state.shotCam;
	a.updateWorldMatrix(true, false);
	a.matrixWorld.decompose(posA, quatA, scl);
	let fov = sa.fov;
	const b = item.to ? findCameraObject(item.to) : null;
	if (b) {
		b.updateWorldMatrix(true, false);
		b.matrixWorld.decompose(posB, quatB, scl);
		posA.lerp(posB, blend);
		quatA.slerp(quatB, blend);
		const sb = cameraSpec(b);
		if (sb.kind !== 'orthographic') fov = sa.fov + (sb.fov - sa.fov) * blend;
	}
	cam.position.copy(posA);
	cam.quaternion.copy(quatA);
	cam.fov = fov;
	cam.near = sa.near;
	cam.far = sa.far;
	cam.aspect = aspect;
	cam.updateProjectionMatrix();
	cam.updateMatrixWorld(true);
	return true;
}

/** @param {any} renderer */
function shotTarget(renderer) {
	const size = renderer.getDrawingBufferSize(new THREE.Vector2());
	const w = Math.max(2, Math.round(size.x));
	const h = Math.max(2, Math.round(size.y));
	if (!state.rt) state.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType });
	else if (state.rt.width !== w || state.rt.height !== h) state.rt.setSize(w, h);
	return state.rt;
}

/** @param {string} key */
function textFor(key) {
	let t = state.texts.get(key);
	if (!t) {
		t = { main: new Text(), sub: new Text(), used: 0 };
		for (const x of [t.main, t.sub]) {
			x.material.depthTest = false;
			x.material.depthWrite = false;
			x.material.toneMapped = false;
			x.frustumCulled = false;
			state.scene.add(x);
		}
		state.texts.set(key, t);
	}
	return t;
}

/** @param {any} entry @param {number} W @param {number} order */
function layoutTitle(entry, W, order) {
	const { item, alpha, wipe } = entry;
	const p = titlePreset(item.preset);
	const scale = Math.max(0.2, Math.min(4, Number(item.size) || 1));
	const at = titleAnchor(p, W);
	const align = item.align || p.align;
	const t = textFor(item.id);
	t.used = state.frames;
	const lift = Number(item.y) || 0;
	const main = t.main;
	const sub = t.sub;
	const hasSub = !!item.sub;
	const mainSize = p.size * scale;
	const subSize = p.subSize * scale;
	const gap = hasSub ? subSize * 0.35 : 0;
	const lineMain = mainSize * 1.2;
	const lineSub = hasSub ? subSize * 1.2 : 0;
	const block = lineMain + gap + lineSub;
	// the block's TOP edge, from its anchor (both lines then hang from it)
	const top = at.ay === 'top' ? at.y + lift : at.ay === 'bottom' ? at.y + lift + block : at.y + lift + block / 2;
	for (const [x, text, size, color, y] of /** @type {const} */ ([
		[main, item.text, mainSize, item.color || p.color, top],
		[sub, item.sub, subSize, p.subColor, top - lineMain - gap]
	])) {
		const show = !!text && alpha > 0.001;
		x.visible = show;
		if (!show) continue;
		if (x.text !== text) x.text = text;
		x.fontSize = size;
		x.color = color;
		x.anchorX = align === 'left' ? 'left' : align === 'right' ? 'right' : 'center';
		x.anchorY = 'top';
		x.textAlign = align;
		x.maxWidth = W * 0.8;
		x.outlineWidth = p.bar ? 0 : size * 0.04;
		x.outlineColor = '#000000';
		x.outlineOpacity = 0.55 * alpha;
		x.fillOpacity = alpha;
		x.position.set(at.x, y, 0);
		x.renderOrder = order + 1;
		const bounds = x.textRenderInfo?.blockBounds;
		x.clipRect = wipe && bounds ? [bounds[0], -1e5, bounds[0] + (bounds[2] - bounds[0]) * wipe.p, 1e5] : null;
		x.sync();
	}
	// the bar behind a lower-third / caption / corner preset, sized from troika's measured block
	if (p.bar) {
		const bar = quad(state.bars, state.barUsed++);
		const m = fullFrame(bar, W, order);
		const pad = mainSize * 0.45;
		/** @type {number[]|null} */
		let box = null;
		for (const x of [main, sub]) {
			const b = x.visible ? x.textRenderInfo?.blockBounds : null;
			if (!b) continue;
			const bb = [b[0] + x.position.x, b[1] + x.position.y, b[2] + x.position.x, b[3] + x.position.y];
			box = box ? [Math.min(box[0], bb[0]), Math.min(box[1], bb[1]), Math.max(box[2], bb[2]), Math.max(box[3], bb[3])] : bb;
		}
		if (!box) bar.visible = false;
		else {
			const reveal = wipe ? wipe.p : 1;
			const w = (box[2] - box[0] + pad * 2) * reveal;
			bar.scale.set(Math.max(1, w), box[3] - box[1] + pad * 1.2, 1);
			bar.position.set(box[0] - pad + w / 2, (box[1] + box[3]) / 2, 0);
			m.uniforms.mode.value = 1;
			/** @type {THREE.Color} */ (m.uniforms.color.value).set(item.bar || '#0b0f19');
			m.uniforms.opacity.value = 0.72 * alpha;
			setWipe(m, null, false);
		}
	}
}

/**
 * The overlay pass (Outline's render task, after the main frame).
 * @param {() => ({id: string, t: number}|null)} source @param {any} renderer @param {any} scene
 */
function draw(source, renderer, scene) {
	const prog = source();
	const seq = prog ? get(sequences)[prog.id] : null;
	state.frames++;
	if (state.frames % 120 === 0) sweepDecoders();
	if (!seq) {
		if (state.last) hideAll();
		state.last = null;
		return;
	}
	const at = /** @type {{t: number}} */ (prog).t;
	const p = programAt(seq, at);
	state.last = { id: seq.id, t: at, layers: p.layers.length, titles: p.titles.length, veils: p.veils.length, shotTrans: p.shotTrans?.kind ?? null };
	const size = renderer.getDrawingBufferSize(new THREE.Vector2());
	const aspect = size.x / Math.max(1, size.y);
	const W = H * aspect;
	const cam = state.camera;
	if (cam.right !== W / 2) {
		cam.left = -W / 2;
		cam.right = W / 2;
		cam.updateProjectionMatrix();
	}
	for (const m of [...state.quads, ...state.shotQuads, ...state.bars]) m.visible = false;
	for (const t of state.texts.values()) t.main.visible = t.sub.visible = false;
	state.barUsed = 0;
	let order = 0;
	let qi = 0;
	let any = false;
	// 1. the outgoing camera shot, over the live incoming one
	if (p.shotTrans && poseShot(p.shotTrans.prev.item, p.shotTrans.prev.blend, aspect)) {
		const rt = shotTarget(renderer);
		const before = renderer.getRenderTarget();
		renderer.setRenderTarget(rt);
		renderer.clear();
		withMarkersHidden(() => renderer.render(scene, state.shotCam));
		renderer.setRenderTarget(before);
		const m = fullFrame(quad(state.shotQuads, 0, true), W, order++);
		m.uniforms.mode.value = 0;
		m.uniforms.map.value = rt.texture;
		/** @type {THREE.Vector2} */ (m.uniforms.fit.value).set(1, 1);
		m.uniforms.opacity.value = p.shotTrans.kind === 'crossfade' ? 1 - p.shotTrans.p : 1;
		setWipe(m, p.shotTrans.kind === 'wipe' ? { p: p.shotTrans.p, dir: p.shotTrans.dir } : null, true);
		any = true;
	}
	// 2. clips
	for (const layer of p.layers) {
		for (const part of layer.prev ? [layer.prev, layer] : [layer]) {
			const it = part.item;
			const dec = decoderFor(it.id, it.src, it.media);
			dec.want(part.local);
			if (!dec.texture || (it.media !== 'image' && dec.shown.start < 0)) continue;
			const m = fullFrame(quad(state.quads, qi++), W, order++);
			m.uniforms.mode.value = 0;
			m.uniforms.map.value = dec.texture;
			const f = fitScale(aspect, dec.aspect, it.fit);
			/** @type {THREE.Vector2} */ (m.uniforms.fit.value).set(f[0], f[1]);
			m.uniforms.opacity.value = part === layer ? layer.alpha : part.alpha;
			setWipe(m, part === layer ? layer.wipe : null, false);
			any = true;
		}
	}
	// 3. titles
	for (const title of p.titles) {
		layoutTitle(title, W, order);
		order += 2;
		any = true;
	}
	// 4. veils
	for (const v of p.veils) {
		const m = fullFrame(quad(state.quads, qi++), W, order++);
		m.uniforms.mode.value = 1;
		/** @type {THREE.Color} */ (m.uniforms.color.value).set(v.color === 'white' ? 0xffffff : 0x000000);
		m.uniforms.opacity.value = v.alpha;
		setWipe(m, null, false);
		any = true;
	}
	// drop the text of titles that left the frame a while ago
	for (const [k, t] of state.texts) if (state.frames - t.used > 300) {
		t.main.dispose();
		t.sub.dispose();
		state.scene.remove(t.main, t.sub);
		state.texts.delete(k);
	}
	if (!any) return;
	const autoClear = renderer.autoClear;
	renderer.autoClear = false;
	renderer.render(state.scene, cam);
	renderer.autoClear = autoClear;
}

function hideAll() {
	for (const m of [...state.quads, ...state.shotQuads, ...state.bars]) m.visible = false;
	for (const t of state.texts.values()) t.main.visible = t.sub.visible = false;
}

/** @type {(() => void)|null} */
let unhook = null;

/**
 * Install (idempotent). `source` = the player's programSource.
 * @param {() => ({id: string, t: number}|null)} source
 */
export function startCutRuntime(source) {
	if (unhook) return;
	state = build();
	unhook = setProgramOverlay((renderer, scene) => draw(source, renderer, scene));
}

/** Test seam: tear everything down. */
export function stopCutRuntime() {
	unhook?.();
	unhook = null;
	if (!state) return;
	for (const m of [...state.quads, ...state.shotQuads, ...state.bars]) /** @type {any} */ (m.material).dispose();
	for (const t of state.texts.values()) {
		t.main.dispose();
		t.sub.dispose();
	}
	state.geometry.dispose();
	state.rt?.dispose();
	disposeClips();
	state = null;
}

/** Any clip still decoding the frame it was asked for — the export holds frame i until false. */
export function cutPending() {
	return clipsPending();
}

/** test / debug view */
export function cutDebug() {
	return {
		running: !!unhook,
		last: state?.last ?? null,
		frames: state?.frames ?? 0,
		quads: state ? [...state.quads, ...state.shotQuads].filter((m) => m.visible).length : 0,
		texts: state ? [...state.texts.values()].filter((t) => t.main.visible).map((t) => t.main.text) : [],
		pending: clipsPending(),
		clips: clipDebug()
	};
}
