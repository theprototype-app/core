// Particle emitter presets (PFX-A). Pure data — every preset is a tuned config
// over the SAME analytic engine (particleRuntime/particleShader); users pick a
// preset then tweak any field. Configs are plain JSON so they replicate via
// objectParameters and round-trip GLTF extras / sessions like userData.physics.
//
// Schema (all fields optional — defaults below):
//  mode        'continuous' | 'burst'   burst idles until a replicated trigger
//  count       particle slots (max alive; implicit rate = count / lifetime)
//  lifetime    seconds; lifeJitter = ±fraction per particle
//  shape       'cone' | 'sphere' | 'disc'; angle = cone half-angle (deg);
//              radius = emit radius (sphere/disc)
//  speed       start speed m/s; speedJitter = ±fraction
//  gravity     m/s² along +Y (positive = rises, negative = falls)
//  drag        exponential damping k (0 = none)
//  turbulence  analytic wobble amount
//  sizeStart/sizeEnd   world-space size over life
//  colorStart/colorEnd hex; colorMode 'life' (gradient over life) |
//              'particle' (each particle picks a mix — confetti)
//  opacity     peak alpha; fadeIn/fadeOut = fractions of life
//  sprite      'dot' | 'streak' | 'puff' | 'star' | 'square'
//  blending    'additive' | 'normal'
//  spin        sprite rotation speed (rad/s)
//  space       'local' (particles ride the object) | 'world' (trail behind)

/** @type {any} */
export const PARTICLE_DEFAULTS = {
	mode: 'continuous',
	count: 80,
	lifetime: 1.5,
	lifeJitter: 0.3,
	shape: 'cone',
	angle: 25,
	radius: 0.15,
	offset: [0, 0, 0],
	speed: 1,
	speedJitter: 0.4,
	gravity: 0,
	drag: 0.2,
	turbulence: 0.2,
	sizeStart: 0.1,
	sizeEnd: 0.03,
	colorStart: '#ffffff',
	colorEnd: '#8899aa',
	colorMode: 'life',
	opacity: 0.9,
	fadeIn: 0.08,
	fadeOut: 0.4,
	sprite: 'dot',
	blending: 'additive',
	spin: 0,
	space: 'local'
};

// The Core 6 (user-locked lineup). Names show in menus; keys are stable ids.
/** @type {{ key: string, name: string, config: any }[]} */
export const PARTICLE_PRESETS = [
	{
		key: 'sparkles',
		name: 'Sparkles',
		config: {
			count: 90, lifetime: 1.4, lifeJitter: 0.4,
			shape: 'sphere', radius: 0.35,
			speed: 0.35, speedJitter: 0.8, gravity: 0.2, drag: 0.5, turbulence: 0.5,
			sizeStart: 0.07, sizeEnd: 0.015,
			colorStart: '#fffbe8', colorEnd: '#ffcf5e',
			opacity: 1, fadeIn: 0.05, fadeOut: 0.35,
			sprite: 'star', blending: 'additive', spin: 2, space: 'local'
		}
	},
	{
		key: 'fire',
		name: 'Fire',
		config: {
			count: 140, lifetime: 0.9, lifeJitter: 0.5,
			shape: 'cone', angle: 14, radius: 0.18,
			speed: 1.1, speedJitter: 0.5, gravity: 1.4, drag: 0.3, turbulence: 0.45,
			sizeStart: 0.22, sizeEnd: 0.05,
			colorStart: '#ffd27a', colorEnd: '#ff4a00',
			opacity: 0.9, fadeIn: 0.08, fadeOut: 0.5,
			sprite: 'puff', blending: 'additive', spin: 1, space: 'local'
		}
	},
	{
		key: 'smoke',
		name: 'Smoke',
		config: {
			count: 60, lifetime: 2.8, lifeJitter: 0.3,
			shape: 'cone', angle: 18, radius: 0.12,
			speed: 0.55, speedJitter: 0.3, gravity: 0.25, drag: 0.6, turbulence: 0.35,
			sizeStart: 0.25, sizeEnd: 0.85,
			colorStart: '#9aa0a8', colorEnd: '#5c6066',
			opacity: 0.35, fadeIn: 0.25, fadeOut: 0.45,
			sprite: 'puff', blending: 'normal', spin: 0.4, space: 'world'
		}
	},
	{
		key: 'dust',
		name: 'Dust puff',
		config: {
			mode: 'burst',
			count: 50, lifetime: 0.8, lifeJitter: 0.3,
			shape: 'disc', angle: 55, radius: 0.3,
			speed: 1.6, speedJitter: 0.6, gravity: -2.2, drag: 2.2, turbulence: 0.15,
			sizeStart: 0.16, sizeEnd: 0.4,
			colorStart: '#cfc4b2', colorEnd: '#a99e8c',
			opacity: 0.5, fadeIn: 0.02, fadeOut: 0.55,
			sprite: 'puff', blending: 'normal', spin: 0.6, space: 'world'
		}
	},
	{
		key: 'confetti',
		name: 'Confetti',
		config: {
			mode: 'burst',
			count: 160, lifetime: 2.2, lifeJitter: 0.3,
			shape: 'cone', angle: 35, radius: 0.1,
			speed: 4, speedJitter: 0.5, gravity: -4.5, drag: 1.1, turbulence: 0.3,
			sizeStart: 0.09, sizeEnd: 0.08,
			colorStart: '#ff4a6e', colorEnd: '#3fd0ff', colorMode: 'particle',
			opacity: 1, fadeIn: 0.02, fadeOut: 0.15,
			sprite: 'square', blending: 'normal', spin: 8, space: 'world'
		}
	},
	{
		key: 'sparks',
		name: 'Sparks',
		config: {
			mode: 'burst',
			count: 120, lifetime: 0.7, lifeJitter: 0.5,
			shape: 'sphere', radius: 0.05,
			speed: 6, speedJitter: 0.7, gravity: -6, drag: 1.6, turbulence: 0.1,
			sizeStart: 0.1, sizeEnd: 0.02,
			colorStart: '#fff6c8', colorEnd: '#ff7a1a',
			opacity: 1, fadeIn: 0.02, fadeOut: 0.4,
			sprite: 'streak', blending: 'additive', spin: 0, space: 'world'
		}
	}
];

/** Full config for a preset key (defaults + preset + preset tag). @param {string} key */
export function particlePreset(key) {
	const preset = PARTICLE_PRESETS.find((p) => p.key === key) ?? PARTICLE_PRESETS[0];
	return { ...PARTICLE_DEFAULTS, ...preset.config, preset: preset.key };
}
