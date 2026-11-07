// 98 P5 — PRO PRESETS, the pure half (imports NOTHING). Product shot / Cinematic / Stylised each set
// the sky + light (an ENVIRONMENT_PRESETS entry — the ONE preset list the 72 look presets live in),
// tone mapping, exposure and the P3/P4 post effects. The scene stores ONE version (the PC one) and
// every device SCALES it as it builds the passes (`scaleProEffects`): a phone marches fewer fog /
// god-ray steps and runs AO at half resolution, a Quest leaves fog, god rays and lens flare out
// entirely. So a phone and a desktop in one session share one look at two costs, and nobody's
// device rewrites the scene for the others.

/** @typedef {{kind: string, params: Record<string, any>}} ProEffect */

/** @type {Record<string, {label: string, exposure: number, effects: ProEffect[]}>} */
export const PRO_LOOKS = {
	product: {
		label: 'Product shot',
		exposure: 1,
		effects: [
			{ kind: 'ao', params: { aoRadius: 0.8, intensity: 2, distanceFalloff: 1, quality: 'high', halfRes: 'auto' } },
			{ kind: 'bloom', params: { intensity: 0.25, luminanceThreshold: 0.92, luminanceSmoothing: 0.03, radius: 0.6 } },
			{ kind: 'tonemapping', params: { mode: 'NEUTRAL', whitePoint: 4, middleGrey: 0.6 } },
			{ kind: 'vignette', params: { offset: 0.35, darkness: 0.3, technique: 'DEFAULT' } },
			{ kind: 'smaa', params: { preset: 'HIGH' } }
		]
	},
	cinematic: {
		label: 'Cinematic',
		exposure: 1.05,
		effects: [
			{ kind: 'ao', params: { aoRadius: 1.5, intensity: 2.5, distanceFalloff: 1, quality: 'auto', halfRes: 'auto' } },
			{ kind: 'volumetricfog', params: { amount: 1, color: '#c9b49a', density: 0.015, falloff: 0.2, baseHeight: 0, scatter: 1.5, steps: 24, maxDistance: 300 } },
			{ kind: 'godrays', params: { amount: 0.5, samples: 48, density: 0.9, decay: 0.96, threshold: 0.5 } },
			{ kind: 'bloom', params: { intensity: 0.6, luminanceThreshold: 0.85, luminanceSmoothing: 0.05, radius: 0.8 } },
			{ kind: 'lensflare', params: { amount: 0.25, threshold: 1, spacing: 0.35, halo: 0.4 } },
			{ kind: 'tonemapping', params: { mode: 'ACES_FILMIC', whitePoint: 4, middleGrey: 0.6 } },
			{ kind: 'chromaticaberration', params: { offsetX: 0.0008, offsetY: 0.0004, radialModulation: true } },
			{ kind: 'grain', params: { opacity: 0.12, premultiply: true } },
			{ kind: 'vignette', params: { offset: 0.45, darkness: 0.55, technique: 'DEFAULT' } },
			{ kind: 'smaa', params: { preset: 'MEDIUM' } }
		]
	},
	stylised: {
		label: 'Stylised',
		exposure: 1.1,
		effects: [
			{ kind: 'ao', params: { aoRadius: 1, intensity: 3, distanceFalloff: 1, quality: 'auto', halfRes: 'auto' } },
			{ kind: 'bloom', params: { intensity: 0.45, luminanceThreshold: 0.8, luminanceSmoothing: 0.05, radius: 0.7 } },
			{ kind: 'tonemapping', params: { mode: 'AGX', whitePoint: 4, middleGrey: 0.6 } },
			{ kind: 'huesaturation', params: { hue: 0, saturation: 0.3 } },
			{ kind: 'brightnesscontrast', params: { brightness: 0.02, contrast: 0.15 } },
			{ kind: 'vignette', params: { offset: 0.5, darkness: 0.35, technique: 'DEFAULT' } },
			{ kind: 'smaa', params: { preset: 'MEDIUM' } }
		]
	}
};

export const PRO_PRESET_KEYS = Object.freeze(Object.keys(PRO_LOOKS));

/** @param {string} name */
export function isProPreset(name) {
	return Object.prototype.hasOwnProperty.call(PRO_LOOKS, name);
}

/** Kinds a tier leaves out of the built stack (they stay in the scene for the other devices).
 * @type {Readonly<Record<string, readonly string[]>>} */
export const TIER_DROPS = Object.freeze({
	pc: Object.freeze([]),
	phone: Object.freeze([]),
	quest: Object.freeze(['volumetricfog', 'godrays', 'lensflare'])
});

/**
 * The effects this device BUILDS from an effective stack: the tier's drops removed. Entries other
 * than the finish kinds pass through untouched (AO's own `auto` already halves it on a phone).
 * @template {{kind: string}} T @param {T[]} entries @param {'pc'|'phone'|'quest'} tier @returns {T[]}
 */
export function scaleProEffects(entries, tier) {
	const drop = TIER_DROPS[tier] ?? [];
	return drop.length ? entries.filter((e) => !drop.includes(e.kind)) : entries;
}

/**
 * The scene post document a pro preset writes (fresh ids are the store's job).
 * @param {string} name @returns {{kind: string, enabled: boolean, params: Record<string, any>}[] | null}
 */
export function proLookEntries(name) {
	const look = PRO_LOOKS[name];
	if (!look) return null;
	return look.effects.map((e) => ({ kind: e.kind, enabled: true, params: { ...e.params } }));
}
