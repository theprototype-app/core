// 72 LK3 — THE PURE HALF OF THE VR-SAFE LOOK (no three, no stores: unit-tested in node).
//
// A headset never runs the composer (Outline.svelte), so a scene's look simply vanished in VR. The
// parts that are a function of one pixel do not need a pass at all: three applies tone mapping
// inside every material when it draws to an XR target, so the grade is written INTO that function
// (three's CustomToneMapping hook) and costs a few ALU per fragment with no extra render target,
// which is what keeps the Quest's foveation and MSAA. This turns a stack into that GLSL, in stack
// order, because the desktop runs the same effects in that order too.
//
// Three outcomes per kind (`xrSupportOf`, which the Look panel shows):
//   baked   exact: tone mapping, hue / saturation, brightness / contrast
//   approx  an affine fit of a LUT, a vignette drawn as one blended quad per eye
//   none    needs neighbouring pixels or a depth pass; stays desktop-only

// (SMAA counts as baked: the headset's own MSAA already does that job)
const BAKED = new Set(['tonemapping', 'huesaturation', 'brightnesscontrast', 'smaa', 'antialias']);
const APPROX = new Set(['lut', 'vignette']);

/** @param {string} kind @returns {'baked'|'approx'|'none'} how this effect appears in a headset */
export function xrSupportOf(kind) {
	if (BAKED.has(kind)) return 'baked';
	if (APPROX.has(kind)) return 'approx';
	return 'none';
}

/** the post stack's curve names -> three's tone-mapping functions (the two three lacks: the nearest) */
const CURVE_FN = {
	AGX: 'AgXToneMapping',
	ACES_FILMIC: 'ACESFilmicToneMapping',
	NEUTRAL: 'NeutralToneMapping',
	REINHARD: 'ReinhardToneMapping',
	REINHARD2: 'ReinhardToneMapping',
	CINEON: 'CineonToneMapping',
	UNCHARTED2: 'ACESFilmicToneMapping',
	LINEAR: 'LinearToneMapping'
};

/** @param {any} v @param {number} d */
function num(v, d = 0) {
	const n = Number(v);
	return Number.isFinite(n) ? n : d;
}
/** a GLSL float literal @param {number} n */
function f(n) {
	const s = Number(n.toFixed(6)).toString();
	return /[.e]/.test(s) ? s : s + '.0';
}

/** @param {number} hue radians — the same rotation postprocessing's HueSaturationEffect builds */
function hueLine(hue) {
	const c = Math.cos(hue);
	const s = Math.sin(hue);
	const w = (1 / 3) * (1 - c);
	const q = Math.sqrt(1 / 3) * s;
	const m = [c + w, w - q, w + q, w + q, c + w, w - q, w - q, w + q, c + w];
	return `color = mat3(${m.map(f).join(', ')}) * color;`;
}

/** @param {any} p */
function hueSatLines(p) {
	const lines = [];
	const hue = num(p.hue);
	const sat = num(p.saturation);
	if (hue) lines.push(hueLine(hue));
	if (sat > 0) lines.push(`color += (vec3((color.r + color.g + color.b) / 3.0) - color) * ${f(1 - 1 / (1.001 - sat))};`);
	else if (sat < 0) lines.push(`color += (vec3((color.r + color.g + color.b) / 3.0) - color) * ${f(-sat)};`);
	return lines;
}

/** @param {any} p */
function brightContrastLines(p) {
	const b = num(p.brightness);
	const c = num(p.contrast);
	if (!b && !c) return [];
	const k = c > 0 ? 1 / (1 - c) : 1 + c;
	return [`color = (color + vec3(${f(b - 0.5)})) * ${f(k)} + vec3(0.5);`];
}

/**
 * The best affine map (3x4) of a 3D LUT over its cube, by least squares on a coarse grid: what a
 * LUT's tint, contrast and channel mix amount to, without a third texture in every material.
 * A LUT with a strong curve loses the curve: the panel says "approximate".
 * @param {ArrayLike<number>} data RGBA or RGB, r varying fastest, values 0..1 or 0..255 @param {number} size
 * @param {number} [channels] @returns {number[]} rows [r r r r, g g g g, b b b b]
 */
export function lutAffine(data, size, channels = 4) {
	const scale = data.constructor === Uint8Array || data.constructor === Uint8ClampedArray ? 1 / 255 : 1;
	const A = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
	const B = [
		[0, 0, 0, 0],
		[0, 0, 0, 0],
		[0, 0, 0, 0]
	];
	const step = Math.max(1, Math.floor((size - 1) / 8));
	for (let z = 0; z < size; z += step)
		for (let y = 0; y < size; y += step)
			for (let x = 0; x < size; x += step) {
				const o = (z * size * size + y * size + x) * channels;
				const v = [x / (size - 1), y / (size - 1), z / (size - 1), 1];
				for (let i = 0; i < 4; i++) {
					for (let j = 0; j < 4; j++) A[i][j] += v[i] * v[j];
					for (let c = 0; c < 3; c++) B[c][i] += v[i] * data[o + c] * scale;
				}
			}
	return B.flatMap((row) => solve4(A, row));
}

/** Gaussian elimination with pivoting on a copy @param {number[][]} A @param {number[]} b */
function solve4(A, b) {
	const m = A.map((row, i) => [...row, b[i]]);
	for (let i = 0; i < 4; i++) {
		let p = i;
		for (let r = i + 1; r < 4; r++) if (Math.abs(m[r][i]) > Math.abs(m[p][i])) p = r;
		[m[i], m[p]] = [m[p], m[i]];
		const d = m[i][i] || 1e-9;
		for (let r = 0; r < 4; r++) {
			if (r === i) continue;
			const k = m[r][i] / d;
			for (let c = i; c < 5; c++) m[r][c] -= k * m[i][c];
		}
	}
	return m.map((row, i) => row[4] / (row[i] || 1e-9));
}

/** A LUT grades sRGB-encoded colour (LUT3DEffect's input space), so the fit runs there too @param {number[]} a */
function lutLines(a) {
	const row = (/** @type {number} */ i) => `dot(vec4(s, 1.0), vec4(${a.slice(i, i + 4).map(f).join(', ')}))`;
	return [
		'{',
		'vec3 s = pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2));',
		`s = vec3(${row(0)}, ${row(4)}, ${row(8)});`,
		'color = pow(clamp(s, 0.0, 1.0), vec3(2.2));',
		'}'
	];
}

/**
 * What a stack becomes in a headset.
 * @param {{kind: string, params?: any}[]} entries the effective stack, in order
 * @param {{baseCurve?: string, lutFit?: (hash: string) => number[] | null}} [opts] `baseCurve` = the
 *   three function the environment's own curve means here ('' = none: a scene with no sky image is not
 *   tone mapped on the desktop either)
 * @returns {{active: boolean, glsl: string, curve: string, vignette: {offset: number, darkness: number, eskil: boolean} | null,
 *   baked: string[], skipped: string[], key: string}}
 *   `glsl` empty + `curve` set = the plain curve is enough, no shader hook at all
 */
export function planXrLook(entries, opts = {}) {
	const lines = [];
	/** @type {string[]} */
	const baked = [];
	/** @type {string[]} */
	const skipped = [];
	let curve = '';
	let grade = 0;
	/** @type {any} */
	let vignette = null;
	for (const entry of entries ?? []) {
		const p = entry.params ?? {};
		if (entry.kind === 'tonemapping') {
			if (curve) continue; // one curve: a second would map twice
			curve = /** @type {any} */ (CURVE_FN)[p.mode] ?? CURVE_FN.AGX;
			lines.push(`color = ${curve}(color);`);
			baked.push(entry.kind);
		} else if (entry.kind === 'huesaturation' || entry.kind === 'brightnesscontrast') {
			const made = entry.kind === 'huesaturation' ? hueSatLines(p) : brightContrastLines(p);
			if (made.length) {
				lines.push(...made);
				grade++;
				baked.push(entry.kind);
			}
		} else if (entry.kind === 'lut') {
			const fit = p.lut ? (opts.lutFit?.(String(p.lut)) ?? null) : null;
			if (fit) {
				lines.push(...lutLines(fit));
				grade++;
				baked.push(entry.kind);
			} else if (p.lut) skipped.push(entry.kind); // not here yet, or unreadable
		} else if (entry.kind === 'vignette') {
			vignette = { offset: num(p.offset, 0.5), darkness: num(p.darkness, 0.5), eskil: p.technique === 'ESKIL' };
			baked.push(entry.kind);
		} else if (xrSupportOf(entry.kind) === 'none') {
			skipped.push(entry.kind);
		}
	}
	const active = !!(curve || grade || vignette);
	if (!grade) {
		// no grade: three's own curve, the shader hook is not needed
		const c = curve || opts.baseCurve || '';
		return { active, glsl: '', curve: c, vignette, baked, skipped, key: JSON.stringify([c, vignette]) };
	}
	// no curve in the stack: the environment's runs last, as its pass does on the desktop
	if (!curve && opts.baseCurve) {
		curve = opts.baseCurve;
		lines.push(`color = ${curve}(color);`);
	}
	const glsl = lines.join('\n\t');
	return { active, glsl, curve, vignette, baked, skipped, key: JSON.stringify([glsl, vignette]) };
}

/** the fragment of the per-eye vignette quad, the same falloffs as postprocessing's VignetteEffect */
export const VIGNETTE_FRAGMENT = `
	varying vec2 vUv;
	uniform float uOffset, uDarkness, uEskil;
	void main() {
		vec2 c = vUv - vec2(0.5);
		float keep = uEskil > 0.5
			? 1.0 - clamp(dot(c * uOffset, c * uOffset) * uDarkness, 0.0, 1.0)
			: smoothstep(0.8, uOffset * 0.799, length(c) * (uDarkness + uOffset));
		gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0 - clamp(keep, 0.0, 1.0));
	}`;
