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
//  36 B3 (weather): shape 'box' + area [w, d] (emit anywhere on the rectangle, falling
//  down), wind [x, y, z] m/s, fall = metres to the ground below the emitter (0 = none),
//  ground 'splash' (a growing, fading ring — rain) | 'settle' (lies there and fades — snow)
//  37-fx: render 'points' (sprites) | 'stretch' (quads stretched along the motion — sparks;
//  `stretch` = seconds of path each covers) | 'trails' (each particle draws its own path,
//  `trail` seconds long in `trailSegments` pieces) | 'ribbon' (one band through the
//  particles in birth order — with space 'world', the path the emitter took; continuous
//  emitters only, a burst falls back to trails); inherit = share of the emitter's velocity
//  a particle is born with (world space; 1 = all of it)

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
	space: 'local',
	render: 'points',
	inherit: 0,
	stretch: 0.04,
	trail: 0.4,
	trailSegments: 8
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
			sizeStart: 0.05, sizeEnd: 0.015,
			colorStart: '#fff6c8', colorEnd: '#ff7a1a',
			opacity: 1, fadeIn: 0.02, fadeOut: 0.4,
			// 37-fx: each spark is a quad stretched along its motion (the streak sprite was a
			// fixed vertical bar); inherit half of a moving emitter's speed
			sprite: 'dot', blending: 'additive', spin: 0, space: 'world',
			render: 'stretch', stretch: 0.05, inherit: 0.5
		}
	},
	{
		// 37-fx: a band behind whatever carries it — a thrown ball, a sword, a car's tail light
		key: 'trail',
		name: 'Ribbon trail',
		config: {
			count: 48, lifetime: 0.7, lifeJitter: 0,
			shape: 'cone', angle: 0, radius: 0,
			speed: 0, speedJitter: 0, gravity: 0, drag: 0, turbulence: 0,
			sizeStart: 0.22, sizeEnd: 0.02,
			colorStart: '#9ef0ff', colorEnd: '#3b5bff',
			opacity: 0.85, fadeIn: 0, fadeOut: 0.7,
			sprite: 'dot', blending: 'additive', spin: 0, space: 'world',
			render: 'ribbon'
		}
	},
	{
		// 37-fx: every particle draws its own path — wisps that curl off a moving object
		key: 'wisps',
		name: 'Magic wisps',
		config: {
			count: 40, lifetime: 1.6, lifeJitter: 0.3,
			shape: 'sphere', radius: 0.2,
			speed: 0.6, speedJitter: 0.6, gravity: 0.4, drag: 0.8, turbulence: 0.9,
			sizeStart: 0.05, sizeEnd: 0.01,
			colorStart: '#e9d7ff', colorEnd: '#8a5cff',
			opacity: 0.9, fadeIn: 0.1, fadeOut: 0.5,
			sprite: 'dot', blending: 'additive', spin: 0, space: 'world',
			render: 'trails', trail: 0.5, trailSegments: 10, inherit: 0.3
		}
	},
	{
		// 36 B3: rain over an area; place the emitter at cloud height (Add ▸ Effects lifts it)
		key: 'rain',
		name: 'Rain',
		config: {
			count: 500, lifetime: 1.05, lifeJitter: 0.15,
			shape: 'box', area: [8, 8], angle: 2, radius: 0,
			speed: 5, speedJitter: 0.25, gravity: -9.8, drag: 0, turbulence: 0,
			sizeStart: 0.16, sizeEnd: 0.16,
			colorStart: '#8aa6c1', colorEnd: '#7d99b5',
			opacity: 0.8, fadeIn: 0.05, fadeOut: 0.05,
			sprite: 'streak', blending: 'normal', spin: 0, space: 'world',
			wind: [0.8, 0, 0.2], fall: 6, ground: 'splash'
		}
	},
	{
		key: 'snow',
		name: 'Snow',
		config: {
			count: 400, lifetime: 7.5, lifeJitter: 0.2,
			shape: 'box', area: [8, 8], angle: 10, radius: 0,
			speed: 0.35, speedJitter: 0.5, gravity: -0.28, drag: 0.4, turbulence: 0.7,
			sizeStart: 0.06, sizeEnd: 0.05,
			colorStart: '#ffffff', colorEnd: '#eef4ff',
			opacity: 0.9, fadeIn: 0.05, fadeOut: 0.3,
			sprite: 'dot', blending: 'normal', spin: 0.5, space: 'world',
			wind: [0.35, 0, 0.12], fall: 6, ground: 'settle'
		}
	}
];

/** Full config for a preset key (defaults + preset + preset tag). @param {string} key */
export function particlePreset(key) {
	const preset = PARTICLE_PRESETS.find((p) => p.key === key) ?? PARTICLE_PRESETS[0];
	return { ...PARTICLE_DEFAULTS, ...preset.config, preset: preset.key };
}
