// 65 M6 — the SMOKE / INK FLUID LAYER's rules, pure (imports NOTHING; vitest runs it with no
// GPU). The runtime (fluidLayer.js) owns the solver, the post effect and the XR panel; this is
// only what it decides: the look entry's params, the device-budget tier, the dye colour, the
// solver physics a set of params means, and where the automatic stirrer is at a moment.

/** @typedef {{style: 'smoke'|'ink', palette: string, intensity: number, curl: number, fade: number, radius: number, auto: boolean}} FluidParams */
/** @typedef {{tier: 'high'|'medium'|'low', simRes: number, dyeRes: number, iterations: number}} FluidTier */

export const FLUID_STYLES = ['smoke', 'ink'];
export const FLUID_PALETTES = ['rainbow', 'ember', 'ocean', 'mono'];

/** @type {FluidParams} */
export const FLUID_DEFAULTS = Object.freeze({
	style: 'smoke',
	palette: 'rainbow',
	intensity: 1,
	curl: 25,
	fade: 0.8,
	radius: 0.25,
	auto: true
});

/** @param {any} v @param {number} lo @param {number} hi @param {number} d */
const clampNum = (v, lo, hi, d) => {
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

/**
 * ONE normalize for a look entry's params (they arrive through the wire, undo and the saves
 * with the rest of the scene look). @param {any} raw @returns {FluidParams}
 */
export function normalizeFluidParams(raw) {
	const d = FLUID_DEFAULTS;
	return {
		style: FLUID_STYLES.includes(raw?.style) ? raw.style : d.style,
		palette: FLUID_PALETTES.includes(raw?.palette) ? raw.palette : d.palette,
		intensity: clampNum(raw?.intensity, 0, 3, d.intensity),
		curl: clampNum(raw?.curl, 0, 60, d.curl),
		fade: clampNum(raw?.fade, 0, 5, d.fade),
		radius: clampNum(raw?.radius, 0.05, 1, d.radius),
		auto: raw?.auto === undefined ? d.auto : !!raw.auto
	};
}

/**
 * THE DEVICE BUDGET. The solver's cost is (sim texels x Jacobi iterations) + dye texels, so the
 * tiers trade grid size and iterations: a desktop affords 128/512/20, a desktop the governor
 * has already shrunk (dpr scale <= 0.72) 96/384/14, a phone or a headset 64/256/8. A headset
 * whose governor is already capping particles gets NO fluid (null): it is the first thing to
 * give up, before frames are.
 * @param {{xr?: boolean, phone?: boolean, dprScale?: number, particlesCapped?: boolean}} ctx
 * @returns {FluidTier|null}
 */
export function fluidTierFor(ctx) {
	if (ctx.xr && ctx.particlesCapped) return null;
	if (ctx.xr || ctx.phone) return { tier: 'low', simRes: 64, dyeRes: 256, iterations: 8 };
	if ((ctx.dprScale ?? 1) <= 0.72) return { tier: 'medium', simRes: 96, dyeRes: 384, iterations: 14 };
	return { tier: 'high', simRes: 128, dyeRes: 512, iterations: 20 };
}

/**
 * What the params mean to the solver. `fade` is how fast the dye goes (0 = it never does);
 * the velocity always fades a little, even at fade 0, or a stirred layer churns forever.
 * @param {FluidParams} p @returns {import('./fluidSim.js').FluidPhysics}
 */
export function physicsFor(p) {
	return {
		curl: p.curl,
		dyeFade: p.fade,
		velocityFade: 0.2 + p.fade * 0.5,
		pressureDecay: 0.8,
		radius: p.radius
	};
}

/** @param {number} h 0..1 @param {number} s @param {number} v @returns {number[]} */
function hsv(h, s, v) {
	const i = Math.floor(h * 6);
	const f = h * 6 - i;
	const p = v * (1 - s);
	const q = v * (1 - f * s);
	const t = v * (1 - (1 - f) * s);
	switch (((i % 6) + 6) % 6) {
		case 0: return [v, t, p];
		case 1: return [q, v, p];
		case 2: return [p, v, t];
		case 3: return [p, q, v];
		case 4: return [t, p, v];
		default: return [v, p, q];
	}
}

/**
 * The dye a splat puts in at phase `t` (seconds; the colour drifts as time goes). Linear RGB,
 * scaled so one splat is visible but a held pointer does not blow out at once.
 * @param {string} palette @param {number} t @returns {number[]}
 */
export function dyeColor(palette, t) {
	const k = 0.15;
	const wave = (/** @type {number} */ period) => 0.5 + 0.5 * Math.sin((t / period) * Math.PI * 2);
	let c;
	if (palette === 'ember') c = hsv(0.02 + 0.1 * wave(7), 0.9, 1);
	else if (palette === 'ocean') c = hsv(0.5 + 0.17 * wave(9), 0.8, 1);
	else if (palette === 'mono') c = [1, 1, 1];
	else c = hsv((t / 12) % 1, 0.85, 1);
	return [c[0] * k, c[1] * k, c[2] * k];
}

/**
 * The automatic stirrer: a slow Lissajous path (0..1 UV) and its velocity in UV per second,
 * so a layer with nobody's pointer on it still moves.
 * @param {number} t seconds @returns {{x: number, y: number, vx: number, vy: number}}
 */
export function autoStir(t) {
	const a = 0.31;
	const b = 0.23;
	return {
		x: 0.5 + 0.32 * Math.sin(t * a * Math.PI * 2),
		y: 0.5 + 0.28 * Math.sin(t * b * Math.PI * 2 + 1.1),
		vx: 0.32 * a * Math.PI * 2 * Math.cos(t * a * Math.PI * 2),
		vy: 0.28 * b * Math.PI * 2 * Math.cos(t * b * Math.PI * 2 + 1.1)
	};
}

/**
 * A pointer move turned into a splat: position in UV (y up) and velocity in UV per second,
 * clamped so a frame hitch is not a cannon. Null when it did not move.
 * @param {{x: number, y: number}} from @param {{x: number, y: number}} to @param {number} dt seconds
 */
export function pointerSplat(from, to, dt) {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	if (Math.abs(dx) + Math.abs(dy) < 1e-5) return null;
	const s = 1 / Math.max(dt, 1 / 240);
	const cap = 6;
	return { x: to.x, y: to.y, vx: Math.max(-cap, Math.min(cap, dx * s)), vy: Math.max(-cap, Math.min(cap, dy * s)) };
}
