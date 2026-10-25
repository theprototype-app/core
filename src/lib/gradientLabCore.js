// 65 gradient — THE GRADIENT LAB's rules, pure (imports NOTHING; vitest runs it with no GPU).
//
// A port of the ShaderGradient look (github.com/ruucm/shadergradient, MIT © ruucm, stone-skipper —
// the GLSL in that repo, not its React package) into the M2 background system. The look IS a
// displaced, lit mesh seen from its own camera — a plane ribbon, a sphere, or a water plane —
// so it cannot be a fragment-only background node. The `gradientLab` node therefore SAMPLES a
// picture that the lazy runtime (gradientLab.js) renders offscreen from that node's params.
// Its params ride in the ordinary background document, so sync, undo and every save path are
// inherited, and the picture is a pure function of (params, shared clock): every peer draws the
// same frame at the same moment with nothing sent.
//
// What lives here: the param schema the catalog node, the panel and the presets all read; the
// one normalize; the camera; the wrapped clock; the device budget; Randomize; and the preset
// document "Copy as preset" produces (the packs repo's backgrounds/ format).

/** The node type. */
export const GRADIENT_NODE = 'gradientLab';

/** @typedef {'plane'|'sphere'|'waterPlane'} GradientShape */
export const GRADIENT_SHAPES = /** @type {GradientShape[]} */ (['plane', 'sphere', 'waterPlane']);
/** The panel's words for them. */
export const SHAPE_LABELS = { plane: 'Ribbon', sphere: 'Sphere', waterPlane: 'Water' };
/** 'ambient' = ShaderGradient's "3d" light (flat, no shading); 'environment' = its "env" (reflections). */
export const GRADIENT_LIGHTS = ['ambient', 'environment'];
/** The procedural studio's tints (ShaderGradient downloads HDRs; we draw a small analytic one). */
export const GRADIENT_ENVS = ['city', 'dawn', 'lobby'];

/**
 * THE PARAM SCHEMA, one list for the catalog node (shaderCatalog), the normalize, the panel's
 * ranges and Randomize. `uniform` only for `grain`: it is the one param the BACKGROUND shader reads
 * (the dot screen mixes in there, at full resolution); everything else drives the offscreen mesh,
 * which the runtime reads straight from the node's data, so a change there never recompiles.
 * Angles in DEGREES, as ShaderGradient's URLs and UI have them.
 */
/** @typedef {{name: string, type: 'enum'|'vec3'|'float', default: any, min?: number, max?: number, options?: string[], uniform?: boolean}} GradientParam */
/** @type {GradientParam[]} */
export const GRADIENT_PARAMS = [
	{ name: 'shape', type: 'enum', default: 'plane', options: GRADIENT_SHAPES },
	{ name: 'color1', type: 'vec3', default: '#ff5005' },
	{ name: 'color2', type: 'vec3', default: '#dbba95' },
	{ name: 'color3', type: 'vec3', default: '#d0bce1' },
	{ name: 'speed', type: 'float', default: 0.4, min: 0, max: 2 },
	{ name: 'density', type: 'float', default: 1.3, min: 0, max: 7 },
	{ name: 'strength', type: 'float', default: 4, min: 0, max: 10 },
	// the sphere's spiral twist (ShaderGradient's frequency / amplitude); unused by the planes
	{ name: 'frequency', type: 'float', default: 5.5, min: 0, max: 10 },
	{ name: 'amplitude', type: 'float', default: 1, min: 0, max: 10 },
	{ name: 'brightness', type: 'float', default: 1.2, min: 0, max: 3 },
	{ name: 'lighting', type: 'enum', default: 'ambient', options: GRADIENT_LIGHTS },
	{ name: 'environment', type: 'enum', default: 'city', options: GRADIENT_ENVS },
	{ name: 'reflection', type: 'float', default: 0.1, min: 0, max: 1 },
	{ name: 'azimuth', type: 'float', default: 180, min: -360, max: 360 },
	{ name: 'polar', type: 'float', default: 90, min: 0, max: 180 },
	{ name: 'distance', type: 'float', default: 3.6, min: 0.1, max: 30 },
	{ name: 'zoom', type: 'float', default: 1, min: 0.1, max: 40 },
	{ name: 'fov', type: 'float', default: 45, min: 10, max: 100 },
	{ name: 'posX', type: 'float', default: -1.4, min: -10, max: 10 },
	{ name: 'posY', type: 'float', default: 0, min: -10, max: 10 },
	{ name: 'posZ', type: 'float', default: 0, min: -10, max: 10 },
	{ name: 'rotX', type: 'float', default: 0, min: -360, max: 360 },
	{ name: 'rotY', type: 'float', default: 10, min: -360, max: 360 },
	{ name: 'rotZ', type: 'float', default: 50, min: -360, max: 360 },
	{ name: 'grain', type: 'float', default: 1, min: 0, max: 1, uniform: true }
];

/** @type {Record<string, any>} */
const SCHEMA = Object.fromEntries(GRADIENT_PARAMS.map((p) => [p.name, p]));

const HEX_RE = /^#[0-9a-f]{6}$/i;

/**
 * ONE normalize: whatever a document carries (a hand-edited preset, a newer peer's extra field,
 * a missing key) becomes a complete, clamped param set. Unknown keys are not returned, never
 * deleted from the document — the runtime only reads.
 * @param {any} data @returns {Record<string, any>}
 */
export function normalizeGradient(data) {
	/** @type {Record<string, any>} */
	const out = {};
	for (const param of GRADIENT_PARAMS) {
		// every enum names its options and every float its range (the list above)
		const p = /** @type {Required<GradientParam>} */ (param);
		const raw = data?.[p.name];
		if (p.type === 'enum') out[p.name] = p.options.includes(raw) ? raw : p.default;
		else if (p.type === 'vec3') out[p.name] = typeof raw === 'string' && HEX_RE.test(raw.trim()) ? raw.trim().toLowerCase() : p.default;
		else {
			const n = Number(raw);
			out[p.name] = Number.isFinite(n) && raw !== null && raw !== '' ? Math.max(p.min, Math.min(p.max, n)) : p.default;
		}
	}
	return out;
}

/**
 * A colour as ShaderGradient uses it: the hex's bytes / 255, taken AS IS (it renders with a
 * linear, untone-mapped canvas, so a hex is the displayed value — the shader mixes in that space
 * and the background node converts once at the end). @param {string} hex @returns {[number, number, number]}
 */
export function displayRgb(hex) {
	const m = HEX_RE.exec(String(hex ?? '').trim());
	if (!m) return [1, 1, 1];
	const n = parseInt(m[0].slice(1), 16);
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const RAD = Math.PI / 180;

/**
 * The camera: an orbit about the origin (camera-controls' convention — polar from +Y, azimuth
 * about Y from +Z), looking at the origin with +Y up.
 * @param {Record<string, any>} p normalized
 * @returns {{position: [number, number, number], fov: number, zoom: number}}
 */
export function gradientCamera(p) {
	const r = p.distance;
	const phi = p.polar * RAD;
	const theta = p.azimuth * RAD;
	const s = Math.sin(phi);
	// a pole exactly overhead/underfoot leaves lookAt with no "up" to keep; nudge off it
	const sp = Math.abs(s) < 1e-4 ? 1e-4 : s;
	return {
		position: [r * sp * Math.sin(theta), r * Math.cos(phi), r * sp * Math.cos(theta)],
		fov: p.fov,
		zoom: p.zoom
	};
}

/**
 * The SHARED clock, scaled and WRAPPED before it reaches the GPU. The app clock is seconds into
 * the day (0..86400); times a speed it would be too big for a float's fraction bits. The planes'
 * classic noise repeats every 289 units on each axis (its mod-289 permutation), so wrapping at 289
 * is seamless; the sphere's periodic noise and spiral share no period, so it wraps at 1000 (one
 * jump every ~1000/speed s, the same kind of jump every node takes at midnight).
 * @param {number} seconds shaderClockNow() @param {number} speed @param {GradientShape} shape
 */
export function gradientClock(seconds, speed, shape) {
	const t = (Number(seconds) || 0) * (Number(speed) || 0);
	const period = shape === 'sphere' ? 1000 : 289;
	return ((t % period) + period) % period;
}

/**
 * THE DEVICE BUDGET. One document, three costs:
 *   high   desktop: the full ShaderGradient mesh (192 segments), half-resolution target, every frame
 *   low    phone / governor stepped down: a coarser mesh, a smaller target, every second frame
 *   still  a headset or reduced motion: ONE frame at t = 0, redrawn only when a param or the size
 *          changes (static = deterministic, so two headsets agree), at the headset's mesh size
 * The dot-screen grain is high only; low and still take the one-sample grain (the background
 * shader picks it by the existing TP_OCTAVE_CAP tier define, so no second program is needed).
 * @param {{tier: 'high'|'low', xr?: boolean, reducedMotion?: boolean}} d
 */
export function gradientBudget(d) {
	const still = !!d.xr || !!d.reducedMotion;
	const low = d.tier === 'low' || !!d.xr;
	return {
		mode: still ? 'still' : low ? 'low' : 'high',
		animate: !still,
		/** frames between target refreshes while animating */
		every: low ? 2 : 1,
		/** plane rows (the ribbon has ONE column, as upstream) and the water plane's grid */
		segments: d.xr ? 128 : low ? 96 : 192,
		/** icosahedron detail (upstream 64 = 192 / 3) */
		sphereDetail: d.xr ? 40 : low ? 32 : 64,
		/** target size as a fraction of the layer's pixels, and its cap on the long side */
		scale: low ? 0.35 : 0.5,
		maxSide: d.xr ? 1024 : low ? 640 : 1280
	};
}

/**
 * The target's pixel size for a layer. @param {number} w @param {number} h layer pixels
 * @param {{scale: number, maxSide: number}} budget @param {boolean} sphere the XR sphere (2:1)
 * @returns {[number, number]}
 */
export function targetSize(w, h, budget, sphere = false) {
	if (sphere) return [budget.maxSide, Math.max(1, Math.round(budget.maxSide / 2))];
	let tw = Math.max(1, Math.round(w * budget.scale));
	let th = Math.max(1, Math.round(h * budget.scale));
	const long = Math.max(tw, th);
	if (long > budget.maxSide) {
		const k = budget.maxSide / long;
		tw = Math.max(1, Math.round(tw * k));
		th = Math.max(1, Math.round(th * k));
	}
	return [tw, th];
}

/**
 * Each shape's own framing (camera + transform), taken when the panel switches shape: the
 * ribbon's camera sits 3.6 m off a 10 m plane, the sphere is a 1 m ball seen through a long lens,
 * so a param set framed for one shows nothing useful of another.
 */
export const SHAPE_BASES = {
	plane: { azimuth: 180, polar: 90, distance: 3.6, zoom: 1, posX: -1.4, posY: 0, posZ: 0, rotX: 0, rotY: 10, rotZ: 50, density: 1.3, strength: 4 },
	sphere: { azimuth: 250, polar: 140, distance: 14, zoom: 12.5, posX: 0, posY: 0, posZ: 0, rotX: 0, rotY: 0, rotZ: 140, density: 0.8, strength: 0.4, frequency: 5.5, amplitude: 7 },
	waterPlane: { azimuth: 170, polar: 70, distance: 4.4, zoom: 1, posX: 0, posY: 0.9, posZ: -0.3, rotX: 45, rotY: 0, rotZ: 0, density: 1.2, strength: 3.4 }
};

/** @param {number} h 0..360 @param {number} s 0..1 @param {number} l 0..1 */
function hslHex(h, s, l) {
	const k = (/** @type {number} */ n) => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (/** @type {number} */ n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return '#' + [f(0), f(8), f(4)].map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('');
}

/**
 * RANDOMIZE: a new look that is still a good one — a harmonious palette (one hue, a neighbour or
 * a complement, and a light or dark third), a shape with its own framing, and motion inside the
 * ranges the upstream presets use. `rand` is injected so a test can replay it; the panel passes
 * Math.random and writes the RESULT into the document, so every peer gets the same numbers.
 * @param {() => number} [rand] @param {{keepShape?: GradientShape}} [opts]
 * @returns {Record<string, any>} a complete param set (grain kept by the caller if it wants)
 */
export function randomizeGradient(rand = Math.random, opts = {}) {
	const r = (/** @type {number} */ a, /** @type {number} */ b) => a + (b - a) * rand();
	const round = (/** @type {number} */ v, /** @type {number} */ d = 2) => Math.round(v * 10 ** d) / 10 ** d;
	const shape = opts.keepShape && GRADIENT_SHAPES.includes(opts.keepShape) ? opts.keepShape : GRADIENT_SHAPES[Math.floor(rand() * 3) % 3];
	const hue = r(0, 360);
	const scheme = rand();
	const hue2 = scheme < 0.4 ? hue + r(25, 60) : scheme < 0.75 ? hue + 180 + r(-20, 20) : hue - r(25, 60);
	const third = rand() < 0.5 ? hslHex((hue + r(-15, 15) + 360) % 360, r(0.2, 0.5), r(0.82, 0.94)) : hslHex((hue2 + 360) % 360, r(0.4, 0.8), r(0.08, 0.22));
	const base = SHAPE_BASES[shape];
	const out = normalizeGradient({
		...base,
		shape,
		color1: hslHex(((hue % 360) + 360) % 360, r(0.65, 1), r(0.5, 0.65)),
		color2: hslHex(((hue2 % 360) + 360) % 360, r(0.55, 0.95), r(0.55, 0.72)),
		color3: third,
		speed: round(r(0.1, 0.5)),
		density: round(shape === 'sphere' ? r(0.6, 1.6) : r(0.9, 2)),
		strength: round(shape === 'sphere' ? r(0.2, 1.2) : r(1.5, 4.5)),
		frequency: round(r(3, 7)),
		amplitude: round(shape === 'sphere' ? r(0.5, 7) : 0),
		brightness: round(r(1, 1.5)),
		lighting: rand() < 0.8 ? 'ambient' : 'environment',
		environment: GRADIENT_ENVS[Math.floor(rand() * 3) % 3],
		reflection: round(r(0.1, 0.5)),
		azimuth: Math.round(base.azimuth + r(-25, 25)),
		polar: Math.round(Math.max(5, Math.min(175, base.polar + r(-20, 20)))),
		rotZ: Math.round(base.rotZ + r(-40, 40))
	});
	return out;
}

/** A preset key from a name: lower-case words and dashes (the packs KEY_RE). @param {string} name */
export function presetKeyFrom(name) {
	const key = String(name ?? '')
		.toLowerCase()
		.normalize('NFKD')
		// the accents NFKD split off, so "é" keys as "e" rather than "e-"
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64);
	return key || 'my-gradient';
}

/**
 * COPY AS PRESET: the scene's background document as a packs `backgrounds/<key>.json` file —
 * the exact shape tools/backgrounds/build.cjs writes and backgroundPresetsCore.normalizePresetDoc
 * reads (format 1). Positions and edges are kept as authored, so a graph built around the lab
 * node (extra grain, a pointer glow) travels whole.
 * @param {any} doc the background document @param {string} [name]
 */
export function gradientPresetDoc(doc, name) {
	const label = String(name ?? doc?.name ?? 'My gradient').trim().slice(0, 60) || 'My gradient';
	return {
		format: 1,
		domain: 'background',
		name: label,
		preset: presetKeyFrom(label),
		layer: { pointer: doc?.layer?.pointer !== false, scroll: doc?.layer?.scroll === true },
		nodes: (doc?.nodes ?? []).map((/** @type {any} */ n) => ({ id: n.id, type: n.type, position: n.position ?? { x: 0, y: 0 }, data: n.data ?? {} })),
		edges: (doc?.edges ?? []).map((/** @type {any} */ e) => ({
			id: e.id,
			source: e.source,
			sourceHandle: e.sourceHandle,
			target: e.target,
			targetHandle: e.targetHandle
		}))
	};
}

/** The first lab node in a background document, or null. @param {any} doc */
export function gradientNodeOf(doc) {
	return (doc?.nodes ?? []).find((/** @type {any} */ n) => n?.type === GRADIENT_NODE) ?? null;
}

/**
 * The smallest background document a lab look needs: the node into the output. What the panel's
 * "Start a gradient" builds and what the packs generator writes for each Gradient preset.
 * @param {Record<string, any>} params @param {string} name @param {string} [key]
 */
export function gradientDocFor(params, name, key) {
	const data = normalizeGradient(params);
	return {
		format: 1,
		domain: 'background',
		name,
		preset: key ?? presetKeyFrom(name),
		layer: { pointer: false, scroll: false },
		nodes: [
			{ id: 'lab', type: GRADIENT_NODE, position: { x: 80, y: 80 }, data },
			{ id: 'out', type: 'backgroundOutput', position: { x: 420, y: 120 }, data: {} }
		],
		edges: [{ id: 'e-lab.out-out.color', source: 'lab', sourceHandle: 'out', target: 'out', targetHandle: 'color' }]
	};
}
