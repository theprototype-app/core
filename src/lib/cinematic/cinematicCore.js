// 100 C1 — THE CINEMATIC VIEW'S RULES, PURE (only ./cinematicOffer.js: unit-tested without a GPU; a LAZY module).
//
//   offerVerdict      where the switch is offered at all (a strong desktop on Chrome's default WebGPU path)
//   QUALITY           Basic (no GI) · Standard (GI + reflections at half resolution) · High (full resolution)
//   qualityChoices    which of them this window may pick (High hides above 1440p-equivalent pixel counts)
//   createDropWatch   the dynamic step down: frame p95 over budget for 2 s → one step lower, once per step
//   standInKind       what a material the WebGPU renderer cannot draw is, in the words the chip uses
//   notShownText      the one chip line: "Not shown in Cinematic view: Water"
//   (troika text is not a stand-in since C2-1: it draws as canvas-texture quads, labelQuads.js)
//   lightingPlan      106 S3: the step + the two passes the view draws (Reflections = SSR, Global light = SSGI), each
//                     On / Off / Auto, Auto = what the step decides; the drop lowers the step first, then a switch set
//                     to On; stepText / costText are the chip's and the menu's words; createCostMeter measures a pass
//   fxCoverKind       which effects the view draws itself through TSL (C2-2 / C2-4: particles, bursts, bubbles,
//                     vertex deformers), so they get no stand-in and the chip does not list them

/** @typedef {import('./cinematicOffer.js').Quality} Quality */
import { asQuality, asLightMode, DEFAULT_QUALITY } from './cinematicOffer.js';
export { asQuality, asLightMode, DEFAULT_QUALITY, offerVerdict } from './cinematicOffer.js';

/** the three steps, lowest first (the drop walks this list down) @type {Quality[]} */
export const QUALITY_STEPS = ['basic', 'standard', 'high'];


/**
 * The lighting each step draws (100-light C0b: SSGI 2 slices x 8 steps; "medium" = half resolution).
 * gi/ssr off = GTAO in their place (the basic look: tone mapping, GTAO, TRAA, bloom).
 */
export const QUALITY = Object.freeze({
	basic: Object.freeze({ label: 'Basic', gi: false, ssr: false, scale: 1 }),
	standard: Object.freeze({ label: 'Standard', gi: true, ssr: true, scale: 0.5 }),
	high: Object.freeze({ label: 'High', gi: true, ssr: true, scale: 1 })
});

/** the words under each choice (the quality menu) */
export const QUALITY_HINT = Object.freeze({
	basic: 'Soft shadows and glow, no bounced light',
	standard: 'Bounced light and reflections at half resolution',
	high: 'Bounced light and reflections at full resolution'
});

/** High is not offered above this many drawn pixels (2560 x 1440): full-resolution GI costs 39 ms at 4K */
export const HIGH_MAX_PIXELS = 2560 * 1440;

/** a frame p95 above this for DROP_AFTER_MS steps the quality down (a 30 fps floor) */
export const FRAME_BUDGET_MS = 1000 / 30;
export const DROP_AFTER_MS = 2000;

/**
 * The choices for a view of `pixels` drawn pixels (CSS size x device pixel ratio).
 * @param {number} pixels @returns {Quality[]}
 */
export function qualityChoices(pixels) {
	return pixels > HIGH_MAX_PIXELS ? ['basic', 'standard'] : ['basic', 'standard', 'high'];
}

/**
 * What the view runs: the asked step, capped by the window's size and lowered by the dynamic drop.
 * @param {Quality} asked @param {number} pixels @param {number} drops how many steps the drop took
 * @returns {Quality}
 */
export function effectiveQuality(asked, pixels, drops = 0) {
	const choices = qualityChoices(pixels);
	let i = QUALITY_STEPS.indexOf(asQuality(asked));
	while (i > 0 && !choices.includes(QUALITY_STEPS[i])) i--;
	return QUALITY_STEPS[Math.max(0, i - Math.max(0, drops | 0))];
}

/** p-quantile of a list (nearest rank) @param {number[]} xs @param {number} q */
export function quantile(xs, q) {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

/**
 * The dynamic step down. Feed it every drawn frame; it answers true ONCE when the frame p95 of the
 * last second has stayed over budget for DROP_AFTER_MS, then starts over (the next step gets its own
 * 2 s). Frames over a second (a tab in the background, a compile) are not frames.
 * @param {{ budgetMs?: number, afterMs?: number, windowMs?: number }} [o]
 */
export function createDropWatch(o = {}) {
	const budget = o.budgetMs ?? FRAME_BUDGET_MS;
	const after = o.afterMs ?? DROP_AFTER_MS;
	const windowMs = o.windowMs ?? 1000;
	/** @type {{ t: number, ms: number }[]} */
	let frames = [];
	let overSince = -1;
	return {
		/** @param {number} frameMs @param {number} now @returns {boolean} drop one step now */
		feed(frameMs, now) {
			if (!(frameMs > 0) || frameMs > 1000) return false;
			frames.push({ t: now, ms: frameMs });
			while (frames.length && frames[0].t < now - windowMs) frames.shift();
			// judge a full window only
			if (frames.length < 10 || now - frames[0].t < windowMs * 0.8) return false;
			const p95 = quantile(frames.map((f) => f.ms), 0.95);
			if (p95 <= budget) {
				overSince = -1;
				return false;
			}
			if (overSince < 0) overSince = now;
			if (now - overSince < after) return false;
			overSince = -1;
			frames = [];
			return true;
		},
		reset() {
			frames = [];
			overSince = -1;
		},
		p95() {
			return quantile(frames.map((f) => f.ms), 0.95);
		}
	};
}

/** the chip's words for each kind of thing the view draws as a plain stand-in, in the order they are listed */
export const STAND_IN_LABELS = Object.freeze({
	water: 'Water',
	fluid: 'Fluid tanks',
	particles: 'Particles',
	shader: 'Shader graph and code materials',
	terrain: 'Terrain paint layers',
	deform: 'Jiggle and sway',
	custom: 'Custom materials',
	heightfog: 'Height fog' // 102b-papercuts: the WebGPU view draws distance fog, not the ground layer
});

/** @typedef {keyof typeof STAND_IN_LABELS} StandInKind */

/**
 * How the WebGPU renderer draws one material, and whether the chip lists it.
 *   swap: a ShaderMaterial / RawShaderMaterial (GLSL the WebGPU renderer cannot run: its own fallback is
 *         an OPAQUE material that can cover the view) gets a plain stand-in for the view's lifetime;
 *   a material patched through onBeforeCompile (an own property: three's default hook lives on
 *         Material.prototype) is drawn as its BASE material by the WebGPU renderer, patch ignored;
 *   kind: what the chip names (null = drawn close enough that it is not news: avatars' outfit tint,
 *         a baked kit's AO atlas — the view lights the scene itself).
 * @param {any} o the drawn object @param {any} m its material
 * @param {{ deformed?: (o: any) => boolean, covered?: (o: any, m: any) => boolean }} [hints] facts only the owners
 *   know (vertexDeform's records; `covered` = the view draws this itself, fxCover.js)
 * @returns {{ swap: boolean, kind: StandInKind | null }}
 */
export function classifyMaterial(o, m, hints = {}) {
	if (!m || m.isNodeMaterial) return { swap: false, kind: null };
	if (hints.covered?.(o, m)) return { swap: false, kind: null };
	const shader = !!(m.isShaderMaterial || m.isRawShaderMaterial);
	const patched = typeof m.onBeforeCompile === 'function' && Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile');
	if (!shader && !patched) return { swap: false, kind: null };
	return { swap: shader, kind: standInKind(o, m, shader, hints) };
}

/**
 * What a stand-in object is, from itself and its ancestors (names and userData the owners set).
 * @param {any} o @param {any} m @param {boolean} shader a GLSL material (else a patched base material)
 * @param {{ deformed?: (o: any) => boolean }} [hints]
 * @returns {StandInKind | null}
 */
export function standInKind(o, m, shader = true, hints = {}) {
	if (hints.deformed?.(o)) return 'deform';
	if (m?.userData?.shaderUniforms || m?.userData?.shaderTextureRefs || m?.userData?.shaderCode) return 'shader';
	for (let p = o, depth = 0; p && depth < 12; p = p.parent, depth++) {
		const name = String(p.name || '');
		const ud = p.userData || {};
		if (ud.water || /^water-/.test(name)) return 'water';
		if (ud.fluid || name === 'Fluid (visual)') return 'fluid';
		if (ud.particles || /^particles-/.test(name)) return 'particles';
		if (ud.terrainSplat || ud.terrainLayers) return 'terrain';
		if (ud.jiggle) return 'deform';
	}
	if (o?.isPoints) return 'particles';
	return shader ? 'custom' : null;
}

/**
 * The chip line for what is in THIS scene (empty when nothing is missing).
 * @param {Iterable<StandInKind>} kinds
 */
export function notShownText(kinds) {
	const set = new Set(kinds);
	const words = /** @type {StandInKind[]} */ (Object.keys(STAND_IN_LABELS)).filter((k) => set.has(k)).map((k) => STAND_IN_LABELS[k]);
	return words.length ? 'Not shown in Cinematic view: ' + words.join(', ') : '';
}

/** the vertex deformers fxCover.js has a TSL twin for (vertexDeform.js kinds) */
export const DEFORM_COVERED = Object.freeze(['jiggle', 'bodywave', 'windsway', 'waterflow']);

/**
 * Which effect the Cinematic view draws itself (fxCover.js), from the object and its CURRENT material:
 *   particles      a particleRuntime emitter in point mode (THREE.Points + its analytic ShaderMaterial)
 *   particleStrip  the same emitter in stretch / trails / ribbon mode (a Mesh)
 *   burst          an effectsBurst system (THREE.Points + PointsMaterial over CPU buffers): WebGPU draws a Points
 *                  at ONE pixel, so before C2-2 a burst showed as specks and was listed nowhere
 *   bubbles        the water runtime's bubble mesh (standalone userData.bubbles and water-volume bubbles)
 *   deform         a mesh whose material is a vertexDeform clone and every deformer on it is a covered kind
 * null for everything else (a stand-in or the renderer's own conversion, as before).
 * @param {any} o @param {any} m @param {(o: any) => string[]} [deformKinds] the deformer kinds on a mesh
 * @returns {'particles' | 'particleStrip' | 'burst' | 'bubbles' | 'deform' | null}
 */
export function fxCoverKind(o, m, deformKinds) {
	if (!o || !m || m.isNodeMaterial || Array.isArray(o.material)) return null;
	const name = String(o.name || '');
	if (m.isShaderMaterial && /^particles-/.test(name) && m.uniforms?.uSizeStart && m.uniforms?.uMap) {
		if (o.isPoints) return 'particles';
		if (o.isMesh) return 'particleStrip';
		return null;
	}
	if (o.isPoints && m.isPointsMaterial && /^effects-burst-/.test(name) && o.geometry?.getAttribute?.('color')) return 'burst';
	if (o.isMesh && m.isShaderMaterial && m.name === 'water-bubbles' && o.geometry?.isInstancedBufferGeometry) return 'bubbles';
	if (o.isMesh && deformKinds) {
		const kinds = deformKinds(o);
		if (kinds.length && kinds.every((k) => DEFORM_COVERED.includes(k))) return 'deform';
	}
	return null;
}

// ---- 106 S3: Reflections and Global light, this device's switches ---------------------------------------------------

/** @typedef {import('./cinematicOffer.js').LightMode} LightMode */
/** @typedef {'reflections' | 'globalLight'} LightSwitch */

/** the two switches, in menu order @type {LightSwitch[]} */
export const LIGHT_SWITCHES = ['reflections', 'globalLight'];
export const LIGHT_LABEL = Object.freeze({ reflections: 'Reflections', globalLight: 'Global light' });
export const LIGHT_HINT = Object.freeze({
	reflections: 'Screen-space reflections on shiny and smooth surfaces',
	globalLight: 'Bounced light between surfaces (objects with baked light keep theirs)'
});
/** the order the drop turns a switch set to On off: the dearer pass first */
const DROP_ORDER = /** @type {LightSwitch[]} */ (['globalLight', 'reflections']);
/** a pass forced On at Basic draws at the Standard step's resolution (half), not Basic's full one */
const FORCED_SCALE = 0.5;

/**
 * What the view draws: the asked step (capped by the window's size), the drop's steps, and the two switches.
 * The drop takes the quality steps first (Auto passes follow the step down), then switches a pass set to On
 * off, Global light first. `steps` = how many drops this plan can still take.
 * @param {{ asked: Quality, pixels: number, drops?: number, reflections?: LightMode, globalLight?: LightMode }} o
 * @returns {{ quality: Quality, gi: boolean, ssr: boolean, scale: number, off: LightSwitch[], qualityDrops: number, steps: number }}
 */
export function lightingPlan(o) {
	const capped = effectiveQuality(o.asked, o.pixels, 0);
	const top = QUALITY_STEPS.indexOf(capped);
	const drops = Math.max(0, o.drops ?? 0) | 0;
	const qualityDrops = Math.min(drops, top);
	const quality = QUALITY_STEPS[top - qualityDrops];
	const q = QUALITY[quality];
	const modes = { reflections: asLightMode(o.reflections), globalLight: asLightMode(o.globalLight) };
	const on = { globalLight: modes.globalLight === 'auto' ? q.gi : modes.globalLight === 'on', reflections: modes.reflections === 'auto' ? q.ssr : modes.reflections === 'on' };
	/** @type {LightSwitch[]} */
	const off = [];
	let rest = drops - qualityDrops;
	for (const k of DROP_ORDER) {
		if (rest <= 0) break;
		if (modes[k] === 'on' && on[k]) {
			on[k] = false;
			off.push(k);
			rest--;
		}
	}
	const forcedLeft = DROP_ORDER.filter((k) => modes[k] === 'on' && on[k]).length;
	const gi = on.globalLight;
	const ssr = on.reflections;
	return { quality, gi, ssr, scale: q.gi || q.ssr || !(gi || ssr) ? q.scale : FORCED_SCALE, off, qualityDrops, steps: top - qualityDrops + forcedLeft };
}

/** one plan's identity (a pipeline is rebuilt when it changes) @param {{ quality: string, gi: boolean, ssr: boolean, scale: number }} p @param {boolean} [baked] */
export function planKey(p, baked = false) {
	return `${p.quality}|${p.gi ? 'g' : '-'}${p.ssr ? 'r' : '-'}|${p.scale}|${baked ? 'b' : '-'}`;
}

/**
 * The step-down chip's words ('' = the drop took nothing).
 * @param {{ quality: Quality, off: LightSwitch[], qualityDrops: number }} p
 */
export function stepText(p) {
	const parts = [];
	if (p.qualityDrops > 0) parts.push('Lowered to ' + QUALITY[p.quality].label);
	if (p.off.length) parts.push(p.off.map((k) => LIGHT_LABEL[k]).join(' and ') + ' off');
	if (!parts.length) return '';
	const s = parts.join(', ') + ' to keep it smooth';
	return s[0].toUpperCase() + s.slice(1);
}

/**
 * A measured cost in the menu's words, scaled to the window's drawn pixels now (the passes cost per pixel).
 * @param {{ ms: number, pixels: number } | undefined} c @param {number} pixels @returns {string} '' = not known yet
 */
export function costText(c, pixels) {
	if (!c || !(c.ms >= 0) || !(c.pixels > 0)) return '';
	const ms = pixels > 0 ? (c.ms * pixels) / c.pixels : c.ms;
	if (ms < 0.5) return 'under 1 ms';
	return 'about ' + Math.round(ms) + ' ms';
}

/** a frame-work sample's configuration key: the passes and their resolution (none = any resolution) */
export function costKey(/** @type {{ gi: boolean, ssr: boolean, scale: number }} */ p) {
	return (p.gi || p.ssr ? p.scale : 'x') + '|' + (p.gi ? 1 : 0) + (p.ssr ? 1 : 0);
}

/**
 * Measures what each pass costs on this device: every drawn frame's WORK (the render call until the GPU finished
 * it, which a 60 Hz display does not hide the way a frame interval does) is filed under its configuration; a
 * pass's cost = the median with it minus the median without it, the other pass and the resolution the same.
 * Known once both sides have MIN samples (a switch flipped, a step dropped).
 * @param {{ min?: number, keep?: number }} [o]
 */
export function createCostMeter(o = {}) {
	const min = o.min ?? 20;
	const keep = o.keep ?? 90;
	/** @type {Map<string, number[]>} */
	const samples = new Map();
	/** @param {string} k */
	const median = (k) => {
		const xs = samples.get(k);
		return xs && xs.length >= min ? quantile(xs, 0.5) : null;
	};
	return {
		/** @param {{ gi: boolean, ssr: boolean, scale: number }} p @param {number} ms */
		feed(p, ms) {
			if (!(ms > 0) || ms > 1000) return;
			const k = costKey(p);
			let xs = samples.get(k);
			if (!xs) samples.set(k, (xs = []));
			xs.push(ms);
			if (xs.length > keep) xs.shift();
		},
		/**
		 * the pass's cost in ms near the plan `p` (null = not known yet)
		 * @param {LightSwitch} which @param {{ gi: boolean, ssr: boolean, scale: number }} p
		 */
		cost(which, p) {
			const scales = [p.scale, ...[0.5, 1].filter((s) => s !== p.scale)];
			for (const scale of scales) {
				for (const other of [which === 'reflections' ? p.gi : p.ssr, !(which === 'reflections' ? p.gi : p.ssr)]) {
					const withIt = which === 'reflections' ? { gi: other, ssr: true, scale } : { gi: true, ssr: other, scale };
					const without = which === 'reflections' ? { gi: other, ssr: false, scale } : { gi: false, ssr: other, scale };
					const a = median(costKey(withIt));
					const b = median(costKey(without));
					if (a != null && b != null) return Math.max(0, a - b);
				}
			}
			return null;
		},
		reset() {
			samples.clear();
		},
		/** @returns {Record<string, number>} the sample counts (e2e / debug) */
		counts() {
			return Object.fromEntries([...samples].map(([k, v]) => [k, v.length]));
		}
	};
}
