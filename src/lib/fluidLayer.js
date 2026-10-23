// 65 M6 — the SMOKE / INK FLUID LAYER: one shared stable-fluids sim (fluidSim.js), stirred by
// the pointer (or the VR controllers) and an optional automatic stirrer, shown two ways.
//
// ON A SCREEN it is a scene-look entry, kind `fluid` (registerPostEffect): the entry is SCENE
// DATA like every look entry — it replicates, saves and undoes with the look — and its Effect
// both steps the solver (in `update`, where postprocessing's own Bloom renders its mips) and
// composites the dye over the finished frame: smoke ADDS light, ink MIXES pigment in.
//
// IN A HEADSET the composer does not run (Outline renders the XR frame directly), and a
// screen-space layer would be head-locked anyway. So the same entry becomes a WORLD PANEL
// about 3 m in front of where you stood when the session started, under the scene-root
// `background-root` group (never in sceneObjects — the particle-root rule), stepped from the
// Scene useTask (tickFluidLayer) with `renderer.xr.enabled` off while the passes render, and
// stirred by whichever controller ray crosses it.
//
// LOCAL by nature: the sim, its pointer and the automatic stirrer are each viewer's own — the
// smoke is not the same swirl on two screens, the 36-sim fluid-particles rule. Only the
// entry's params are shared.
//
// THE BUDGET (fluidLayerCore.fluidTierFor): grid size and Jacobi iterations drop on a
// governor-shrunk desktop, again on a phone or a headset, and a headset whose governor is
// already capping particles gets no fluid at all. Nothing composited the dye for ~500 ms (the
// entry was switched off, the look disabled here, the tab hidden) = nothing steps; after 10 s
// the GPU targets are freed.

import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import { Effect, BlendFunction } from 'postprocessing';
import { FluidSim } from './fluidSim.js';
import {
	FLUID_DEFAULTS,
	FLUID_PALETTES,
	normalizeFluidParams,
	fluidTierFor,
	physicsFor,
	dyeColor,
	autoStir,
	pointerSplat
} from './fluidLayerCore.js';
import { registerPostEffect, scenePost } from './scenePost.js';
import { viewportOverrides } from './viewportOverrides.js';
import { qualityOverrides, phoneQuality } from './qualityGovernor.js';
import { globalRenderer } from '../stores/sceneStore.js';
import { ndcFromClient } from './canvasRect.js';
import { backgroundRootGroup } from './backgroundLayer.js';
import { controllerRay } from './vr/pointer.js';

/** The look entry's kind. */
export const FLUID_KIND = 'fluid';
/** Nothing composited for this long = stop stepping. */
const IDLE_MS = 500;
/** ... and for this long = free the targets. */
const FREE_MS = 10000;
/** The XR panel: width x height in metres, and how far ahead of the viewer it is put. */
const PANEL_W = 3.2;
const PANEL_H = 1.8;
const PANEL_DIST = 3;
/** Velocity a pointer splat carries, per UV/s of pointer speed. */
const FORCE = 1.6;

/**
 * What the layer is doing on THIS device (debug hook + e2e seam).
 * @type {import('svelte/store').Writable<{presenter: 'none'|'post'|'panel', tier: string, simRes: number, dyeRes: number, iterations: number, steps: number, splats: number}>}
 */
export const fluidState = writable({ presenter: 'none', tier: 'off', simRes: 0, dyeRes: 0, iterations: 0, steps: 0, splats: 0 });

// ---- the one shared sim -----------------------------------------------------------------

/** @type {FluidSim|null} */
let sim = null;
let lastStep = 0;
let lastUsed = 0;
/** @type {'none'|'post'|'panel'} */
let presenter = 'none';
/** splats waiting for the next step @type {{x: number, y: number, vx: number, vy: number}[]} */
const queue = [];
/** a pointer splat's colour phase, so a stroke drifts through the palette */
let phase = 0;
/** test seam: hold the automatic stirrer still @type {boolean} */
let autoHeld = false;

/** @param {import('./fluidLayerCore.js').FluidTier} tier @param {number} aspect */
function ensureSim(tier, aspect) {
	if (!sim) sim = new FluidSim(tier, aspect);
	else sim.configure(tier, aspect);
	return sim;
}

function freeSim() {
	sim?.dispose();
	sim = null;
	publish();
}

function publish() {
	fluidState.set({
		presenter,
		tier: sim ? currentTier?.tier ?? 'off' : 'off',
		simRes: sim?.quality.simRes ?? 0,
		dyeRes: sim?.quality.dyeRes ?? 0,
		iterations: sim?.quality.iterations ?? 0,
		steps: sim?.steps ?? 0,
		splats: sim?.splats ?? 0
	});
}

/** @type {import('./fluidLayerCore.js').FluidTier|null} */
let currentTier = null;

function tierNow(/** @type {boolean} */ xr) {
	const q = get(qualityOverrides);
	return fluidTierFor({ xr, phone: phoneQuality(), dprScale: q.dprScale, particlesCapped: q.particlesCapped });
}

/**
 * Splats in, one solver step. Saves and restores the render target, and switches XR off for
 * the passes (three would otherwise swap in the XR camera and draw each pass twice, once per
 * eye, into the eye viewports).
 * @param {any} renderer @param {import('./fluidLayerCore.js').FluidParams} params @param {number} now ms
 */
function stepShared(renderer, params, now) {
	if (!sim) return;
	// the composer may render more than once a frame (picture-in-picture views): step once
	if (lastStep && now - lastStep < 4) return;
	const dt = lastStep ? Math.min((now - lastStep) / 1000, 1 / 30) : 1 / 60;
	lastStep = now;
	lastUsed = now;
	const prevTarget = renderer.getRenderTarget();
	const xrOn = renderer.xr.enabled;
	const autoClear = renderer.autoClear;
	renderer.xr.enabled = false;
	renderer.autoClear = false;
	try {
		if (!sim.cleared) sim.clearAll(renderer);
		const t = now / 1000;
		const radius = params.radius * 0.1;
		if (params.auto && !autoHeld) {
			const s = autoStir(t);
			sim.splat(renderer, s.x, s.y, s.vx * FORCE * 0.5, s.vy * FORCE * 0.5, scaled(dyeColor(params.palette, t), 0.35), radius);
		}
		for (const s of queue.splice(0, 16)) {
			phase += 0.05;
			sim.splat(renderer, s.x, s.y, s.vx * FORCE, s.vy * FORCE, dyeColor(params.palette, t + phase), radius);
		}
		queue.length = 0;
		sim.step(renderer, dt, physicsFor(params));
	} finally {
		renderer.setRenderTarget(prevTarget);
		renderer.xr.enabled = xrOn;
		renderer.autoClear = autoClear;
	}
	publish();
}

/** @param {number[]} c @param {number} k */
const scaled = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

// ---- local pointer input ----------------------------------------------------------------

let listening = false;
/** @type {{x: number, y: number, t: number}|null} */
let lastPointer = null;

function listen() {
	if (listening || typeof window === 'undefined') return;
	listening = true;
	window.addEventListener(
		'pointermove',
		(e) => {
			if (presenter !== 'post') return;
			const canvas = get(globalRenderer)?.domElement;
			if (canvas && e.target !== canvas) {
				lastPointer = null;
				return;
			}
			const p = ndcFromClient(e.clientX, e.clientY);
			const at = { x: p.x * 0.5 + 0.5, y: p.y * 0.5 + 0.5, t: e.timeStamp || performance.now() };
			if (at.x < 0 || at.x > 1 || at.y < 0 || at.y > 1) {
				lastPointer = null;
				return;
			}
			if (lastPointer) {
				const s = pointerSplat(lastPointer, at, (at.t - lastPointer.t) / 1000);
				if (s && queue.length < 64) queue.push(s);
			}
			lastPointer = at;
		},
		{ passive: true }
	);
}

// ---- ON A SCREEN: the look entry ---------------------------------------------------------

const COMPOSITE = /* glsl */ `
	uniform sampler2D uDye;
	uniform float uIntensity;
	uniform float uInk;
	void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
		vec3 dye = texture2D(uDye, uv).rgb * uIntensity;
		float peak = max(dye.r, max(dye.g, dye.b));
		// smoke: light, soft-clipped so a dense patch saturates instead of blowing out
		vec3 smoke = inputColor.rgb + (1.0 - exp(-3.0 * max(dye, vec3(0.0))));
		// ink: the dye's hue as a dark pigment, covering in proportion to how much is there
		float cover = 1.0 - exp(-4.0 * max(peak, 0.0));
		vec3 pigment = (dye / max(peak, 1e-3)) * 0.35;
		vec3 ink = mix(inputColor.rgb, pigment, cover);
		outputColor = vec4(mix(smoke, ink, uInk), inputColor.a);
	}
`;

class FluidEffect extends Effect {
	/** @param {import('./fluidLayerCore.js').FluidParams} params */
	constructor(params) {
		super('FluidLayerEffect', COMPOSITE, {
			blendFunction: BlendFunction.NORMAL,
			uniforms: new Map(/** @type {[string, THREE.Uniform<any>][]} */ ([
				['uDye', new THREE.Uniform(null)],
				['uIntensity', new THREE.Uniform(params.intensity)],
				['uInk', new THREE.Uniform(params.style === 'ink' ? 1 : 0)]
			]))
		});
		this.fluidParams = params;
	}

	/** @param {any} renderer @param {any} inputBuffer */
	update(renderer, inputBuffer) {
		const now = performance.now();
		const tier = tierNow(false);
		currentTier = tier;
		const u = /** @type {any} */ (this.uniforms);
		if (!tier) {
			u.get('uDye').value = null;
			return;
		}
		const aspect = inputBuffer?.width && inputBuffer?.height ? inputBuffer.width / inputBuffer.height : 1;
		ensureSim(tier, aspect);
		presenter = 'post';
		stepShared(renderer, this.fluidParams, now);
		u.get('uDye').value = sim?.texture ?? null;
	}
}

registerPostEffect(FLUID_KIND, {
	label: 'Smoke / ink',
	group: 'stylize',
	params: [
		{ key: 'style', label: 'Style', type: 'select', default: FLUID_DEFAULTS.style,
			options: [
				{ value: 'smoke', label: 'Smoke (adds light)' },
				{ value: 'ink', label: 'Ink (mixes pigment in)' }
			] },
		{ key: 'palette', label: 'Colours', type: 'select', default: FLUID_DEFAULTS.palette,
			options: FLUID_PALETTES.map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) })) },
		{ key: 'intensity', label: 'Intensity', min: 0, max: 3, step: 0.05, decimals: 2, default: FLUID_DEFAULTS.intensity },
		{ key: 'curl', label: 'Swirl', min: 0, max: 60, step: 1, decimals: 0, default: FLUID_DEFAULTS.curl,
			hint: 'How strongly the flow curls into eddies.' },
		{ key: 'fade', label: 'Fade', min: 0, max: 5, step: 0.05, decimals: 2, default: FLUID_DEFAULTS.fade,
			hint: 'How fast the smoke or ink thins out. 0 keeps it.' },
		{ key: 'radius', label: 'Brush size', min: 0.05, max: 1, step: 0.01, decimals: 2, default: FLUID_DEFAULTS.radius },
		{ key: 'auto', label: 'Stir by itself', type: 'bool', default: FLUID_DEFAULTS.auto,
			hint: 'A slow automatic stir, so the layer moves with nobody touching it. Your pointer (or a controller in VR) stirs your own view.' }
	],
	make: (params) => {
		listen();
		return new FluidEffect(normalizeFluidParams(params));
	}
});

// ---- IN A HEADSET: the world panel -------------------------------------------------------

/** @type {any} */
let panel = null;
let panelPlaced = false;
const lastHit = /** @type {({x: number, y: number, t: number}|null)[]} */ ([null, null]);
const headPos = new THREE.Vector3();
const headDir = new THREE.Vector3();

function ensurePanel() {
	if (panel) return panel;
	const material = new THREE.ShaderMaterial({
		uniforms: { uDye: { value: null }, uIntensity: { value: 1 }, uInk: { value: 0 } },
		vertexShader: /* glsl */ `
			varying vec2 vUv;
			void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
		`,
		fragmentShader: /* glsl */ `
			uniform sampler2D uDye;
			uniform float uIntensity;
			uniform float uInk;
			varying vec2 vUv;
			void main() {
				vec3 dye = max(texture2D(uDye, vUv).rgb * uIntensity, vec3(0.0));
				float peak = max(dye.r, max(dye.g, dye.b));
				// soft edges, so the panel reads as a cloud and not a screen
				vec2 e = smoothstep(vec2(0.0), vec2(0.12), vUv) * smoothstep(vec2(0.0), vec2(0.12), 1.0 - vUv);
				float edge = e.x * e.y;
				vec3 smoke = (1.0 - exp(-3.0 * dye)) * edge;
				float cover = (1.0 - exp(-4.0 * peak)) * edge;
				vec3 pigment = (dye / max(peak, 1e-3)) * 0.35;
				gl_FragColor = uInk > 0.5 ? vec4(pigment, cover) : vec4(smoke, 1.0);
			}
		`,
		transparent: true,
		depthWrite: false,
		side: THREE.DoubleSide,
		blending: THREE.AdditiveBlending,
		toneMapped: false
	});
	panel = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_H), material);
	panel.name = 'fluid-panel';
	panel.renderOrder = 10;
	panel.visible = false;
	return panel;
}

/** The scene look's enabled fluid entry, or null (XR reads the scene document directly). */
function sceneFluidEntry() {
	if (get(viewportOverrides).post === false) return null;
	const doc = get(scenePost);
	if (!doc?.enabled) return null;
	return doc.effects.find((e) => e.kind === FLUID_KIND && e.enabled) ?? null;
}

/** @param {any} renderer @param {any} p @param {number} now */
function panelInput(renderer, p, now) {
	for (const index of [0, 1]) {
		let hit = null;
		try {
			hit = controllerRay(index).intersectObject(panel, false)[0] ?? null;
		} catch {}
		if (!hit?.uv) {
			lastHit[index] = null;
			continue;
		}
		const at = { x: hit.uv.x, y: hit.uv.y, t: now };
		const prev = lastHit[index];
		if (prev) {
			const s = pointerSplat(prev, at, (now - prev.t) / 1000);
			if (s && queue.length < 64) queue.push(s);
		}
		lastHit[index] = at;
	}
}

/**
 * ONE per-frame entry (a single Scene useTask line). On a screen it only notices that the
 * effect stopped compositing (and frees the targets later); in a headset it is the panel's
 * presenter. @param {any} camera @param {any} renderer @param {number} now ms
 */
export function tickFluidLayer(camera, renderer = get(globalRenderer), now = performance.now()) {
	const xr = !!renderer?.xr?.isPresenting;
	if (!xr) {
		if (panel?.visible) panel.visible = false;
		panelPlaced = false;
		if (presenter !== 'none' && now - lastUsed > IDLE_MS) {
			presenter = 'none';
			publish();
		}
		if (sim && now - lastUsed > FREE_MS) freeSim();
		return;
	}
	const entry = sceneFluidEntry();
	const tier = entry ? tierNow(true) : null;
	currentTier = tier;
	const root = backgroundRootGroup();
	if (!entry || !tier || !root) {
		if (panel?.visible) panel.visible = false;
		if (presenter === 'panel') {
			presenter = 'none';
			publish();
		}
		if (sim && now - lastUsed > FREE_MS) freeSim();
		return;
	}
	const p = normalizeFluidParams(entry.params);
	ensurePanel();
	if (panel.parent !== root) root.add(panel);
	if (!panelPlaced) {
		// ahead of where the viewer looks when the session starts, upright, facing them
		const xrCam = renderer.xr.getCamera();
		xrCam.getWorldPosition(headPos);
		xrCam.getWorldDirection(headDir);
		headDir.y = 0;
		if (headDir.lengthSq() < 1e-6) headDir.set(0, 0, -1);
		headDir.normalize();
		panel.position.copy(headPos).addScaledVector(headDir, PANEL_DIST);
		panel.lookAt(headPos.x, panel.position.y, headPos.z);
		panel.updateMatrixWorld(true);
		panelPlaced = true;
	}
	panel.visible = true;
	ensureSim(tier, PANEL_W / PANEL_H);
	presenter = 'panel';
	panelInput(renderer, p, now);
	stepShared(renderer, p, now);
	const m = panel.material;
	m.uniforms.uDye.value = sim?.texture ?? null;
	m.uniforms.uIntensity.value = p.intensity;
	const ink = p.style === 'ink';
	m.uniforms.uInk.value = ink ? 1 : 0;
	const blending = ink ? THREE.NormalBlending : THREE.AdditiveBlending;
	if (m.blending !== blending) {
		m.blending = blending;
		m.needsUpdate = true;
	}
}

// ---- test / debug seams ------------------------------------------------------------------

/** Queue a splat as if a pointer had moved (UV, UV/s). @param {number} x @param {number} y @param {number} vx @param {number} vy */
export function fluidSplatForTest(x, y, vx, vy) {
	queue.push({ x, y, vx, vy });
}

/** Hold the automatic stirrer, so a test frame differs only by its own splats. @param {boolean} on */
export function holdFluidAutoForTest(on) {
	autoHeld = !!on;
}

/** a small 8-bit copy of the dye, for the read-back (half-float read-back is not portable) @type {any} */
let probe = null;

/**
 * The dye's total (sum of r+g+b over a 64x36 8-bit copy, so dense patches clip at 1 per
 * channel) — "is there smoke, and on which half". Null with no sim.
 * @returns {{total: number, left: number, right: number}|null}
 */
export function readFluidDyeForTest() {
	const renderer = get(globalRenderer);
	if (!sim || !renderer) return null;
	const w = 64;
	const h = 36;
	probe ??= new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
	const prevTarget = renderer.getRenderTarget();
	const xrOn = renderer.xr.enabled;
	renderer.xr.enabled = false;
	const buf = new Uint8Array(w * h * 4);
	try {
		const m = sim.mats.scale;
		m.uniforms.uSource.value = sim.texture;
		m.uniforms.uScale.value = 1;
		sim.blit(renderer, m, probe);
		renderer.readRenderTargetPixels(probe, 0, 0, w, h, buf);
	} catch {
		return null;
	} finally {
		renderer.setRenderTarget(prevTarget);
		renderer.xr.enabled = xrOn;
	}
	let total = 0;
	let left = 0;
	let right = 0;
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			const v = (buf[i] + buf[i + 1] + buf[i + 2]) / 255;
			total += v;
			if (x < w / 2) left += v;
			else right += v;
		}
	return { total, left, right };
}

/** debug hook row */
export function fluidLayerDebug() {
	return {
		...get(fluidState),
		queued: queue.length,
		idleMs: lastUsed ? Math.round(performance.now() - lastUsed) : null,
		panel: panel ? { visible: panel.visible, placed: panelPlaced, parent: panel.parent?.name ?? null } : null,
		sim: sim ? { sim: [sim.velocity.w, sim.velocity.h], dye: [sim.dye.w, sim.dye.h] } : null
	};
}
