// 78-int PL16 + PL12 — WHAT A PRESET SETS, AND WHAT CHANGED SINCE (scene panel item 4 / G1, owner
// APPROVED 2026-11-08). The pure half: imports NOTHING, so it is unit-tested with plain objects.
//
// The `basedOn` key (additive, inside the environment's custom payload): an edit of a named preset
// detaches into a custom payload as before, and now REMEMBERS which preset it started from instead of
// becoming an anonymous "Custom". The panel then says "Cinematic · Modified: sun, fog" with a Reset,
// and every environment row marks itself when it differs from that preset. Old scenes have no key
// (no badge); older peers ignore it. The presets lane after 1.64 (presets as files) builds on it.

/** one sentence per built-in: why you would pick it */
export const PRESET_WHY = Object.freeze({
	studio: 'Neutral grey backdrop and soft even light: the place to build and judge shapes.',
	daylight: 'Bright blue sky, warm high sun and a light haze: an outdoor scene at midday.',
	sunset: 'Low orange sun, dusky sky and close fog: warm and moody.',
	night: 'Dark blue sky and a cool dim moon: a night scene that still reads.',
	classic: 'A plain white backdrop with no light rig: bring your own lights.',
	clearsky: 'A real sky photo lights the scene, reflections included.',
	meadow: 'A green meadow under clouds: soft natural outdoor light.',
	sunrise: 'Early sun low over the horizon: long warm shadows.',
	starlight: 'A starry night sky: dark, with a cool glow.',
	photostudio: 'Studio softboxes light a plain backdrop: clean reflections for objects.',
	product: 'Softbox light, neutral colour and gentle contact shadows: for product stills.',
	cinematic: 'Low warm sun through haze, film grain and ACES colour: for trailers and stills.',
	stylised: 'Bright gradient sky, punchy colour and soft bloom: a playful, illustrated look.'
});

/**
 * The fields a preset holds, in words ("Sets: …").
 * @param {any} preset an ENVIRONMENT_PRESETS entry (or a custom payload)
 * @param {{effects?: number}} [extra] a pro look's effect count
 * @returns {string[]}
 */
export function presetSets(preset, extra = {}) {
	if (!preset) return [];
	const out = [];
	if (preset.hdri) out.push(preset.hdri.background === false ? 'sky image (light only)' : 'sky image');
	out.push(preset.gradient ? 'gradient backdrop' : 'backdrop');
	if (preset.hemi) out.push('ambient');
	if (preset.sun) out.push('sun');
	out.push(preset.fog ? 'fog' : 'no fog');
	out.push('exposure ' + Number(preset.exposure ?? 1).toFixed(2));
	if (preset.pro) {
		out.push('tone mapping');
		if (extra.effects) out.push(extra.effects + ' effects');
	}
	return out;
}

/** @param {unknown} a @param {unknown} b */
function same(a, b) {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
/** @param {unknown} a @param {unknown} b */
function near(a, b) {
	return Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.0005;
}

/**
 * Which preset the environment comes from, and what differs from it now.
 * @param {{preset?: string, exposure?: number, customPreset?: any}} state the environment store
 * @param {Record<string, any>} presets ENVIRONMENT_PRESETS
 * @param {{effects?: string[] | null, look?: string[] | null}} [post] the scene's effect kinds and the pro look's own
 * @returns {{basedOn: string | null, label: string, modified: string[]}}
 */
export function envChanges(state, presets, post = {}) {
	const custom = state?.preset === 'custom';
	const key = custom ? state?.customPreset?.basedOn : state?.preset;
	const base = key ? presets[key] : null;
	if (!base) return { basedOn: null, label: custom ? String(state?.customPreset?.label ?? 'Custom') : '', modified: [] };
	const now = custom ? state.customPreset ?? {} : base;
	const modified = [];
	if (!same(now.hdri, base.hdri)) modified.push('sky image');
	if (!same(now.background, base.background) || !same(now.gradient, base.gradient)) modified.push('background');
	if (!same(now.hemi, base.hemi)) modified.push('ambient');
	if (!same(now.sun, base.sun)) modified.push('sun');
	if (!same(now.fog, base.fog)) modified.push('fog');
	if (!near(state?.exposure ?? 1, presetExposure(base))) modified.push('exposure');
	if (base.pro && Array.isArray(post.effects) && Array.isArray(post.look) && !same(post.effects, post.look)) modified.push('effects');
	return { basedOn: key ?? null, label: String(base.label ?? key), modified };
}

/**
 * The Exposure slider is a MULTIPLIER on the preset's own exposure (environment.applyEnvironment), so a
 * plain preset's slider value is 1; a pro look writes its look exposure there (post/proPresets.js).
 * @param {any} preset @returns {number}
 */
export function presetExposure(preset) {
	return preset?.pro ? Number(preset.exposure ?? 1) : 1;
}

/**
 * The preset an edit keeps as its origin: the named preset being edited, else the custom payload's own.
 * @param {{preset?: string, customPreset?: any}} state @param {Record<string, any>} presets
 * @returns {string | undefined}
 */
export function basedOnOf(state, presets) {
	if (state?.preset && state.preset !== 'custom') return presets[state.preset] ? state.preset : undefined;
	const b = state?.customPreset?.basedOn;
	return typeof b === 'string' && presets[b] ? b : undefined;
}
