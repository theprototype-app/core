// 98 P4/P5 — the PURE half of the lens and film finish (imports NOTHING).
//
// TSL-portable rule (roadmap 2.0 S1): every decision lives here in plain JS — the device tier, the
// per-tier cost caps, where the sun is on screen and how strong a shaft is — so the S2 WebGPU port
// rewrites only the small shader bodies in `finishShaders.js`, never this logic.

/** @typedef {'pc'|'phone'|'quest'} FinishTier */

/**
 * The device tier the finish (and the pro presets) scale to.
 * @param {{presenting?: boolean, headset?: boolean, phone?: boolean}} facts
 * @returns {FinishTier}
 */
export function finishTier(facts) {
	if (facts?.presenting || facts?.headset) return 'quest';
	if (facts?.phone) return 'phone';
	return 'pc';
}

/**
 * COST CAPS per tier. The fog and god-ray marches never take more steps than this, whatever a scene
 * asks for: the "volumetric fog has a cost cap on phones" row (a phone marches a third of a PC's
 * steps; its own render resolution is already the governor's to lower). Quest: 0 steps = the effect stands down (the Quest preset leaves fog / god rays off,
 * and a scene that pins them still costs nothing in a headset — postprocessing never reaches XR).
 */
export const FINISH_CAPS = Object.freeze({
	pc: Object.freeze({ fogSteps: 24, raySamples: 48 }),
	phone: Object.freeze({ fogSteps: 8, raySamples: 16 }),
	quest: Object.freeze({ fogSteps: 0, raySamples: 0 })
});

/** @param {FinishTier} tier */
export function capsFor(tier) {
	return FINISH_CAPS[tier] ?? FINISH_CAPS.pc;
}

/**
 * Steps actually marched: the scene's ask clamped to this tier's cap (and to >= 1 when the tier
 * allows any at all).
 * @param {number} asked @param {number} cap
 */
export function cappedSteps(asked, cap) {
	const n = Math.round(Number(asked) || 0);
	if (cap <= 0) return 0;
	return Math.max(1, Math.min(cap, n || cap));
}

/**
 * Where a far-away light (the rig sun) sits on screen. `dir` points FROM the scene TOWARD the sun;
 * `viewProj` is the camera's projection * view matrix (column-major, 16 numbers, three's layout).
 * Returns uv in 0..1 plus `visible` (in front of the camera) and `fade` (1 on screen, falling to 0
 * half a screen outside it), which scales the god-ray strength so shafts never pop at the edge.
 * @param {number[]} dir @param {number[]} camPos @param {ArrayLike<number>} viewProj
 * @returns {{x: number, y: number, visible: boolean, fade: number}}
 */
export function sunScreen(dir, camPos, viewProj) {
	const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
	const far = 1000;
	const px = camPos[0] + (dir[0] / len) * far;
	const py = camPos[1] + (dir[1] / len) * far;
	const pz = camPos[2] + (dir[2] / len) * far;
	const m = viewProj;
	const cx = m[0] * px + m[4] * py + m[8] * pz + m[12];
	const cy = m[1] * px + m[5] * py + m[9] * pz + m[13];
	const cw = m[3] * px + m[7] * py + m[11] * pz + m[15];
	if (!(cw > 1e-6)) return { x: 0.5, y: 0.5, visible: false, fade: 0 };
	const x = (cx / cw) * 0.5 + 0.5;
	const y = (cy / cw) * 0.5 + 0.5;
	const out = Math.max(0, Math.abs(x - 0.5) - 0.5, Math.abs(y - 0.5) - 0.5);
	const fade = Math.max(0, 1 - out / 0.5);
	return { x, y, visible: true, fade };
}

/**
 * 98 P3 — AO per device tier, for the params an author left on 'auto'. A phone always renders AO at
 * HALF resolution with a lighter denoise (fill-bound: half res is ~4x fewer AO pixels, the denoise
 * hides the softer result); a PC keeps the device's shadow-quality mapping and N8AO's full denoise.
 * @param {'pc'|'phone'|'quest'} tier @param {string} [shadowQuality]
 * @returns {{halfRes: boolean, denoiseSamples: number, denoiseRadius: number}}
 */
export function aoTierSettings(tier, shadowQuality) {
	if (tier !== 'pc') return { halfRes: true, denoiseSamples: 4, denoiseRadius: 8 };
	const low = shadowQuality === 'low' || shadowQuality === 'medium' || shadowQuality === 'off';
	return { halfRes: low, denoiseSamples: 8, denoiseRadius: 12 };
}

/** The finish effect kinds this lane adds (P4). Off by default = not in the stack = no pass. */
export const FINISH_KINDS = Object.freeze(['lensflare', 'godrays', 'volumetricfog']);
