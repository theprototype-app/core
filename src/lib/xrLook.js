// 72 LK3 — THE VR-SAFE LOOK, applied. See xrLookCore.js for what becomes what and why no pass.
//
// While an immersive-vr session runs, the scene's look is written into three's CustomToneMapping
// function (ShaderChunk), so every material a tone curve reaches is graded as it draws. Nothing runs
// outside a session and a scene with no look costs nothing: the renderer keeps the environment's
// plain curve. The vignette is ONE quad in clip space, drawn last per eye by the XR cameras: no pose
// to follow, no texture, one layer of blended fill. AR is left alone (the room is not graded).
//
// THREE HAS NO WORD FOR "THE SHADER TEXT CHANGED". A program is cached by its parameters and the chunk
// text is not one of them, so a program built for the last look would serve the next. Hence the
// token in `customProgramCacheKey` (the prototype's, and a wrap around a material's own: shader
// graphs, terrain, avatars). Materials made after a sweep with a key of their own are the known
// gap: they keep the look current when they compiled until the next session.
// To make every material notice mid-session, the curve flips for one frame: a tone-mapping change is
// what three compares (including for its private background material).
//
// Reached by dynamic import from xrLookWire.js at the first session: not in the boot graph.
import * as THREE from 'three';
import { planXrLook, VIGNETTE_FRAGMENT } from './xrLookCore.js';
import { setToneFilter, reapplyToneMapping } from './environment';

const MARKER = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
const ORIGINAL_CHUNK = THREE.ShaderChunk.tonemapping_pars_fragment;

const CONSTANT_OF = {
	AgXToneMapping: THREE.AgXToneMapping,
	ACESFilmicToneMapping: THREE.ACESFilmicToneMapping,
	NeutralToneMapping: THREE.NeutralToneMapping,
	ReinhardToneMapping: THREE.ReinhardToneMapping,
	CineonToneMapping: THREE.CineonToneMapping,
	LinearToneMapping: THREE.LinearToneMapping
};
/** @param {number} constant @returns {string} the GLSL name, '' for none */
function curveName(constant) {
	for (const [name, value] of Object.entries(CONSTANT_OF)) if (value === constant) return name;
	return '';
}

/** @type {any} */ let renderer = null;
/** @type {any} */ let scene = null;
/** @type {any[]} */ let entries = [];
/** @type {any} the plan on screen, or null */ let plan = null;
let token = 0;
/** @type {any} */ let quad = null;
/** what a LUT hash fits to (a fit is the work, and a look edit re-plans) @type {Map<string, number[] | null>} */
const lutFits = new Map();
/** what the environment asked for, with what it knows @type {{constant: number, hasSkyImage: boolean}} */
let wanted = { constant: THREE.ACESFilmicToneMapping, hasSkyImage: false };

let keyPatched = false;
function patchProgramKey() {
	if (keyPatched) return;
	keyPatched = true;
	const proto = /** @type {any} */ (THREE.Material.prototype);
	const base = proto.customProgramCacheKey;
	proto.customProgramCacheKey = function () {
		return base.call(this) + (token ? '|xrlook' + token : '');
	};
}

/** Materials with their own key: wrap once, so the token reaches them too @param {any} root */
function wrapOwnKeys(root) {
	root?.traverse?.((/** @type {any} */ o) => {
		if (!o.material) return;
		for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
			if (!Object.prototype.hasOwnProperty.call(m, 'customProgramCacheKey') || m.customProgramCacheKey.__xrLook) continue;
			const own = m.customProgramCacheKey;
			const wrapped = function (/** @type {any} */ ...args) {
				return own.apply(m, args) + (token ? '|xrlook' + token : '');
			};
			wrapped.__xrLook = true;
			m.customProgramCacheKey = wrapped;
		}
	});
}

/** @param {{offset: number, darkness: number, eskil: boolean} | null} v */
function syncVignette(v) {
	if (!v) {
		if (quad) quad.visible = false;
		return;
	}
	if (!quad) {
		quad = new THREE.Mesh(
			new THREE.PlaneGeometry(2, 2),
			new THREE.ShaderMaterial({
				uniforms: { uOffset: { value: 0.5 }, uDarkness: { value: 0.5 }, uEskil: { value: 0 } },
				// clip space: it fills whichever eye draws it, so it has no pose to keep
				vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
				fragmentShader: VIGNETTE_FRAGMENT,
				transparent: true,
				depthTest: false,
				depthWrite: false,
				toneMapped: false
			})
		);
		quad.name = 'xr-look-vignette';
		quad.frustumCulled = false;
		quad.renderOrder = 999; // over the world, under the VR panels and the comfort ring (1100)
		quad.userData.localOnly = true;
	}
	if (scene && quad.parent !== scene) scene.add(quad);
	quad.material.uniforms.uOffset.value = v.offset;
	quad.material.uniforms.uDarkness.value = v.darkness;
	quad.material.uniforms.uEskil.value = v.eskil ? 1 : 0;
	quad.visible = true;
}

function presentingVr() {
	const session = renderer?.xr?.isPresenting ? renderer.xr.getSession() : null;
	return !!session && session.environmentBlendMode !== 'additive' && session.environmentBlendMode !== 'alpha-blend';
}

/** @param {string} hash */
function lutFitFor(hash) {
	if (lutFits.has(hash)) return lutFits.get(hash) ?? null;
	lutFits.set(hash, null);
	import('./postEffects')
		.then(({ lutTableOf }) => lutTableOf(hash))
		.then((fit) => {
			lutFits.set(hash, fit);
			if (fit) sync();
		})
		.catch(() => {});
	return null;
}

/** The environment's filter: what renderer.toneMapping actually becomes. @param {number} constant @param {boolean} hasSkyImage */
function toneFilter(constant, hasSkyImage) {
	const changed = wanted.constant !== constant || wanted.hasSkyImage !== hasSkyImage;
	wanted = { constant, hasSkyImage };
	// the sky image landed (or the curve moved): the plan's base curve is stale
	if (changed && renderer?.xr?.isPresenting) queueMicrotask(sync);
	if (!plan) return constant;
	if (plan.glsl) return THREE.CustomToneMapping;
	return /** @type {any} */ (CONSTANT_OF)[plan.curve] ?? THREE.NoToneMapping;
}

function sync() {
	if (!renderer) return;
	const on = presentingVr();
	const next = on
		? planXrLook(entries, {
				// the desktop shows no curve on a scene with no sky image (the composer path), so neither
				// does a headset showing that scene's look
				baseCurve: wanted.hasSkyImage ? curveName(wanted.constant) : '',
				lutFit: lutFitFor
			})
		: null;
	const live = next?.active ? next : null;
	if (plan?.key === live?.key) return;
	const sameShader = plan?.glsl === live?.glsl;
	const wasCustom = !!plan?.glsl;
	plan = live;
	if (plan?.glsl && !sameShader) {
		patchProgramKey();
		wrapOwnKeys(scene);
		token++;
		THREE.ShaderChunk.tonemapping_pars_fragment = ORIGINAL_CHUNK.replace(
			MARKER,
			`vec3 CustomToneMapping( vec3 color ) {\n\t${plan.glsl}\n\treturn color;\n}`
		);
	}
	if (!plan?.glsl) {
		THREE.ShaderChunk.tonemapping_pars_fragment = ORIGINAL_CHUNK;
		token = 0;
	}
	syncVignette(plan?.vignette ?? null);
	reapplyToneMapping();
	if (plan?.glsl && wasCustom && !sameShader) {
		// new text under the same curve constant: one frame on another curve makes three look again
		renderer.toneMapping = THREE.LinearToneMapping;
		renderer.xr.getSession()?.requestAnimationFrame(() => {
			if (plan?.glsl) renderer.toneMapping = THREE.CustomToneMapping;
		});
	}
}

/**
 * xrLookWire.js: the look to carry, on every stack change and session edge.
 * @param {any} r the renderer @param {any} s the scene @param {any[]} stack the composed entries
 */
export function syncXrLook(r, s, stack) {
	if (renderer !== r) setToneFilter(toneFilter);
	renderer = r;
	scene = s;
	entries = stack ?? [];
	sync();
}

/** TEST/EVIDENCE, and what the panel reads */
export const xrLookDebug = {
	plan: () => plan,
	token: () => token,
	vignette: () => !!quad?.visible,
	programs: () => renderer?.info?.programs?.length ?? 0,
	toneMapping: () => renderer?.toneMapping
};
