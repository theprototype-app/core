// 36-water — presets and render defaults. Pure DATA (imports only the pure wave module):
// a preset is a complete water blob minus the shape, so applying one is a single
// userData.water write that replicates, saves and undoes like any other.
//
// LOOK (userData.water.look), every key optional:
//   shallowColor / deepColor   absorption gradient (hex); clarity = metres until "deep"
//   opacity                    0..1 — how much of the floor shows through at all
//   refraction 0..1            screen-space bend strength (0 = no refraction: lava, ice)
//   chromatic 0..1             RGB split of the refraction
//   reflection 'env'|'planar'|'none' + reflectivity 0..1
//   fresnel                    rim exponent (higher = mirror only at grazing angles)
//   roughness 0..1             blurs the sky reflection and widens the sun glint
//   foam 0..1 + foamColor      crest + shoreline foam; foamWidth = shoreline band (m)
//   caustics 0..1 + causticScale (m per cell) + causticSpeed
//   emissive (hex) + emissiveStrength — lava/toxic glow, unaffected by lighting
//   detail 0..1 + detailScale (m) + detailSpeed — the scrolling normal-map ripples
//   fogColor + fogDistance (m) — underwater fog while the camera is inside
//   frozen (bool)              still, frosted surface; nothing moves
// BUBBLES (userData.water.bubbles): see BUBBLE_DEFAULTS.

import { WAVE_DEFAULTS } from './waves.js';

/** @type {Record<string, any>} */
export const LOOK_DEFAULTS = Object.freeze({
	shallowColor: '#5fd3e6',
	deepColor: '#0b4f6c',
	clarity: 3,
	opacity: 0.85,
	refraction: 0.5,
	chromatic: 0.15,
	reflection: 'env',
	reflectivity: 0.6,
	fresnel: 4,
	roughness: 0.08,
	foam: 0.4,
	foamColor: '#ffffff',
	foamWidth: 0.25,
	caustics: 0.5,
	causticScale: 1.2,
	causticSpeed: 0.6,
	emissive: '#000000',
	emissiveStrength: 0,
	detail: 0.5,
	detailScale: 2,
	detailSpeed: 0.4,
	fogColor: '',
	fogDistance: 12,
	frozen: false
});

/** @type {Record<string, any>} */
export const BUBBLE_DEFAULTS = Object.freeze({
	enabled: false,
	count: 40, // live bubbles (instances)
	rate: 8, // spawned per second; count / rate = how long one bubble lives at most
	sizeMin: 0.02, // m (diameter)
	sizeMax: 0.06,
	riseSpeed: 0.6, // m/s
	wobble: 0.3, // 0..1 side-to-side sway
	spread: 0.6, // 0..1 of the volume footprint (or metres around a standalone emitter)
	pop: true, // a tiny ring where a bubble reaches the surface
	color: '#e8fbff',
	opacity: 0.7,
	mode: 'continuous', // 'continuous' | 'burst'
	burstAt: -1, // shared-clock seconds of the last burst (burst mode)
	height: 2 // standalone emitter: how far a bubble rises when it is not under water
});

/**
 * 36-fb-water F18: what "Add bubble emitter" / Add ▸ Water ▸ Bubbles start with. The volume
 * defaults (2-6 cm, 40 of them) suit an aquarium seen through glass; on an object they were the
 * reported "does nothing visible" — a faint few dots, half of them inside the object.
 */
export const STANDALONE_BUBBLES = Object.freeze({ count: 70, rate: 16, sizeMin: 0.04, sizeMax: 0.11, spread: 0.4, opacity: 0.9, riseSpeed: 0.7 });

/** Bubble cap per emitter (one instanced draw). */
export const MAX_BUBBLES = 400;

/**
 * The lineup. `name` shows in menus; `key` is the stable id stored in blob.preset.
 * @type {{key: string, name: string, shape?: string, water: any}[]}
 */
export const WATER_PRESETS = [
	{
		key: 'pool',
		name: 'Pool',
		shape: 'box',
		water: {
			look: {
				shallowColor: '#7fe3f0',
				deepColor: '#1677a8',
				clarity: 6,
				refraction: 0.55,
				caustics: 0.8,
				causticScale: 1,
				foam: 0.15,
				detail: 0.45
			},
			waves: {
				count: 3,
				amplitude: 0.015,
				wavelength: 1.6,
				speed: 0.6,
				direction: 30,
				choppiness: 0.3
			},
			bubbles: { enabled: false }
		}
	},
	{
		key: 'aquarium',
		name: 'Aquarium',
		shape: 'box',
		water: {
			look: {
				shallowColor: '#9be7d8',
				deepColor: '#155e63',
				clarity: 2.5,
				refraction: 0.35,
				chromatic: 0.1,
				caustics: 0.7,
				causticScale: 0.45,
				causticSpeed: 0.8,
				foam: 0.05,
				detail: 0.3,
				detailScale: 0.6,
				fogDistance: 4
			},
			waves: {
				count: 2,
				amplitude: 0.006,
				wavelength: 0.5,
				speed: 0.5,
				direction: 10,
				choppiness: 0.2
			},
			bubbles: {
				enabled: true,
				count: 60,
				rate: 10,
				sizeMin: 0.008,
				sizeMax: 0.025,
				riseSpeed: 0.35,
				wobble: 0.5,
				spread: 0.15
			}
		}
	},
	{
		key: 'ocean',
		name: 'Ocean',
		shape: 'plane',
		water: {
			density: 1025,
			look: {
				shallowColor: '#3fb6c8',
				deepColor: '#06304a',
				clarity: 8,
				refraction: 0.4,
				reflectivity: 0.85,
				roughness: 0.05,
				foam: 0.7,
				foamWidth: 0.8,
				caustics: 0.4,
				causticScale: 3,
				detail: 0.6,
				detailScale: 6,
				fogDistance: 25
			},
			waves: {
				count: 6,
				amplitude: 0.45,
				wavelength: 18,
				speed: 1,
				direction: 20,
				choppiness: 0.75
			},
			bubbles: { enabled: false }
		}
	},
	{
		key: 'lake',
		name: 'Lake',
		shape: 'plane',
		water: {
			look: {
				shallowColor: '#5c9e86',
				deepColor: '#16352c',
				clarity: 3,
				refraction: 0.35,
				reflectivity: 0.8,
				roughness: 0.04,
				foam: 0.2,
				caustics: 0.3,
				causticScale: 2,
				detail: 0.35,
				detailScale: 4,
				fogDistance: 8
			},
			waves: {
				count: 3,
				amplitude: 0.04,
				wavelength: 4,
				speed: 0.6,
				direction: 60,
				choppiness: 0.3
			},
			bubbles: { enabled: false }
		}
	},
	{
		key: 'river',
		name: 'River',
		shape: 'box',
		water: {
			flow: [1.2, 0, 0],
			linearDrag: 2,
			look: {
				shallowColor: '#6fb3a8',
				deepColor: '#1d4b4a',
				clarity: 2,
				refraction: 0.45,
				foam: 0.55,
				foamWidth: 0.4,
				caustics: 0.35,
				detail: 0.7,
				detailScale: 1.5,
				detailSpeed: 1.2,
				fogDistance: 5
			},
			waves: {
				count: 3,
				amplitude: 0.03,
				wavelength: 1.5,
				speed: 1.4,
				direction: 0,
				choppiness: 0.6
			},
			bubbles: { enabled: false }
		}
	},
	{
		key: 'lava',
		name: 'Lava',
		shape: 'box',
		water: {
			density: 3100,
			linearDrag: 8,
			angularDrag: 6,
			look: {
				shallowColor: '#ff7a1a',
				deepColor: '#3a0700',
				clarity: 0.15,
				opacity: 1,
				refraction: 0,
				chromatic: 0,
				reflection: 'none',
				reflectivity: 0.1,
				roughness: 0.6,
				foam: 0.6,
				foamColor: '#2a1206',
				foamWidth: 0.3,
				caustics: 0,
				emissive: '#ff4a00',
				emissiveStrength: 1.6,
				detail: 0.8,
				detailScale: 1.4,
				detailSpeed: 0.15,
				fogColor: '#ff3a00',
				fogDistance: 0.6
			},
			waves: {
				count: 3,
				amplitude: 0.05,
				wavelength: 2.4,
				speed: 0.12,
				direction: 45,
				choppiness: 0.2
			},
			bubbles: {
				enabled: true,
				count: 24,
				rate: 2,
				sizeMin: 0.08,
				sizeMax: 0.25,
				riseSpeed: 0.15,
				wobble: 0.1,
				spread: 0.8,
				color: '#ffb347',
				opacity: 0.9
			}
		}
	},
	{
		key: 'swamp',
		name: 'Swamp',
		shape: 'plane',
		water: {
			linearDrag: 3,
			look: {
				shallowColor: '#5d6b2c',
				deepColor: '#1f2410',
				clarity: 0.6,
				opacity: 0.97,
				refraction: 0.15,
				reflectivity: 0.35,
				roughness: 0.25,
				foam: 0.35,
				foamColor: '#9aa35a',
				caustics: 0.05,
				detail: 0.25,
				detailScale: 3,
				detailSpeed: 0.1,
				fogDistance: 1.5
			},
			waves: {
				count: 2,
				amplitude: 0.008,
				wavelength: 3,
				speed: 0.2,
				direction: 10,
				choppiness: 0.1
			},
			bubbles: {
				enabled: true,
				count: 16,
				rate: 1.5,
				sizeMin: 0.03,
				sizeMax: 0.09,
				riseSpeed: 0.25,
				wobble: 0.2,
				spread: 0.9,
				color: '#c9d18a',
				opacity: 0.6
			}
		}
	},
	{
		key: 'toxic',
		name: 'Toxic',
		shape: 'box',
		water: {
			density: 1200,
			look: {
				shallowColor: '#a6ff3d',
				deepColor: '#1f5c08',
				clarity: 0.9,
				opacity: 0.95,
				refraction: 0.25,
				reflectivity: 0.4,
				roughness: 0.15,
				foam: 0.5,
				foamColor: '#e4ff9a',
				caustics: 0.2,
				emissive: '#6dff1a',
				emissiveStrength: 0.35,
				detail: 0.6,
				detailScale: 1.2,
				detailSpeed: 0.3,
				fogColor: '#4cff00',
				fogDistance: 2
			},
			waves: {
				count: 3,
				amplitude: 0.02,
				wavelength: 1.4,
				speed: 0.4,
				direction: 80,
				choppiness: 0.3
			},
			bubbles: {
				enabled: true,
				count: 40,
				rate: 6,
				sizeMin: 0.02,
				sizeMax: 0.07,
				riseSpeed: 0.45,
				wobble: 0.4,
				spread: 0.7,
				color: '#d7ff7a',
				opacity: 0.8
			}
		}
	},
	{
		key: 'ice',
		name: 'Ice',
		shape: 'box',
		water: {
			density: 917,
			linearDrag: 0,
			angularDrag: 0,
			look: {
				shallowColor: '#dff6ff',
				deepColor: '#6aa6c8',
				clarity: 1.5,
				opacity: 0.95,
				refraction: 0,
				chromatic: 0,
				reflectivity: 0.5,
				roughness: 0.35,
				foam: 0,
				caustics: 0,
				detail: 0.35,
				detailScale: 0.8,
				detailSpeed: 0,
				frozen: true,
				fogDistance: 2
			},
			waves: { count: 0, amplitude: 0 },
			bubbles: { enabled: false }
		}
	}
];

/** @param {string} key */
export function presetByKey(key) {
	return WATER_PRESETS.find((p) => p.key === key) ?? null;
}

/** @param {any} v */
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/**
 * A full water blob for `key` (null for an unknown key). `shape` keeps the caller's shape
 * when given (a preset applied to an existing pool must not turn it into an ocean).
 * @param {string} key @param {{shape?: string}} [opts]
 */
export function waterPreset(key, opts = {}) {
	const p = presetByKey(key);
	if (!p) return null;
	const w = p.water;
	return {
		version: 1,
		shape: opts.shape ?? p.shape ?? 'box',
		level: null,
		density: w.density ?? 1000,
		linearDrag: w.linearDrag ?? 1.5,
		angularDrag: w.angularDrag ?? 1,
		flow: [...(w.flow ?? [0, 0, 0])],
		preset: key,
		look: { ...LOOK_DEFAULTS, ...obj(w.look) },
		waves: { ...WAVE_DEFAULTS, ...obj(w.waves) },
		bubbles: { ...BUBBLE_DEFAULTS, ...obj(w.bubbles) }
	};
}

/** Render params with every default filled (what the shader reads). @param {any} spec normalized blob */
export function resolveLook(spec) {
	const look = { ...LOOK_DEFAULTS, ...obj(spec?.look) };
	if (!look.fogColor) look.fogColor = look.deepColor;
	if (look.frozen) {
		look.detailSpeed = 0;
		look.foam = 0;
	}
	return look;
}

/** Bubble params with every default filled, clamped. @param {any} bubbles */
export function resolveBubbles(bubbles) {
	const b = { ...BUBBLE_DEFAULTS, ...obj(bubbles) };
	const n = (/** @type {any} */ v, /** @type {number} */ d) =>
		typeof v === 'number' && Number.isFinite(v) ? v : d;
	b.count = Math.max(0, Math.min(MAX_BUBBLES, Math.round(n(b.count, BUBBLE_DEFAULTS.count))));
	b.rate = Math.max(0.01, n(b.rate, BUBBLE_DEFAULTS.rate));
	b.sizeMin = Math.max(0.001, n(b.sizeMin, BUBBLE_DEFAULTS.sizeMin));
	b.sizeMax = Math.max(b.sizeMin, n(b.sizeMax, BUBBLE_DEFAULTS.sizeMax));
	b.riseSpeed = Math.max(0.01, n(b.riseSpeed, BUBBLE_DEFAULTS.riseSpeed));
	b.wobble = Math.max(0, Math.min(1, n(b.wobble, BUBBLE_DEFAULTS.wobble)));
	b.spread = Math.max(0, n(b.spread, BUBBLE_DEFAULTS.spread));
	b.opacity = Math.max(0, Math.min(1, n(b.opacity, BUBBLE_DEFAULTS.opacity)));
	b.height = Math.max(0.05, n(b.height, BUBBLE_DEFAULTS.height));
	b.burstAt = n(b.burstAt, -1);
	b.mode = b.mode === 'burst' ? 'burst' : 'continuous';
	b.enabled = !!b.enabled;
	b.pop = b.pop !== false;
	return b;
}

/**
 * A user preset is a blob minus the per-object fields (shape, level) under a name. The
 * returned record is what "Save as preset" stores; `applyUserPreset` turns it back.
 * @param {string} name @param {any} spec normalized blob
 */
export function userPresetFrom(name, spec) {
	return {
		name: String(name).slice(0, 60),
		water: {
			density: spec.density,
			linearDrag: spec.linearDrag,
			angularDrag: spec.angularDrag,
			flow: [...(spec.flow ?? [0, 0, 0])],
			look: { ...obj(spec.look) },
			waves: { ...obj(spec.waves) },
			bubbles: { ...obj(spec.bubbles), burstAt: -1 }
		}
	};
}

/** @param {{name: string, water: any}} record @param {any} current normalized blob (keeps shape/level) */
export function applyUserPreset(record, current) {
	const w = obj(record?.water);
	return {
		...current,
		density: w.density ?? current.density,
		linearDrag: w.linearDrag ?? current.linearDrag,
		angularDrag: w.angularDrag ?? current.angularDrag,
		flow: Array.isArray(w.flow) ? [...w.flow] : current.flow,
		preset: 'user:' + record.name,
		look: { ...LOOK_DEFAULTS, ...obj(w.look) },
		waves: { ...WAVE_DEFAULTS, ...obj(w.waves) },
		bubbles: { ...BUBBLE_DEFAULTS, ...obj(w.bubbles) }
	};
}
