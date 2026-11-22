// 98 P1 — the bake KERNEL: per-texel AO + one bounce of the scene's lights, then dilation, a
// light denoise and the RGBA encode. ZERO IMPORTS (it runs in the Worker and in node tests).
//
// WHAT IS BAKED, and why exactly this (three r186's shading model decides it):
//   · AO (the aoMap half) = how open the sky is above a texel, cosine-weighted, out to
//     `aoDistance`. three multiplies INDIRECT diffuse by it (ambient, hemisphere, the HDRI's
//     diffuse and the lightmap itself), so the realtime sky stays live and gets its corners.
//   · LIGHT (the lightMap half) = irradiance from ONE BOUNCE of the scene's lights: every
//     hemisphere ray that hits a surface brings back that surface's albedo times the direct light
//     falling on it (with a shadow ray per light). three ADDS a lightMap to indirect irradiance,
//     so this is the soft coloured fill a realtime renderer cannot do — the realtime direct light
//     and its shadows stay as they are, and nothing is counted twice.
// Irradiance units: E = mean over cosine-distributed rays of albedo_hit · E_direct(hit), which
// is π · L_in averaged — the value three expects in a lightMap texel.

import { traceFirst, occluded, hit, faceNormal } from './bakeTraceCore.js';

/**
 * @typedef {{ type: 'dir', dx: number, dy: number, dz: number, r: number, g: number, b: number }
 *   | { type: 'point' | 'spot', x: number, y: number, z: number, r: number, g: number, b: number, distance: number, decay: number,
 *       dx?: number, dy?: number, dz?: number, cosOuter?: number, cosInner?: number }} BakeLight
 *   (dir: dx/dy/dz point FROM the surface TOWARDS the light; r/g/b = colour × intensity)
 */

/** Hammersley points on the cosine-weighted hemisphere (tangent space, z up). @param {number} n @returns {Float32Array} */
export function hemisphereDirs(n) {
	const out = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) {
		let bits = i;
		bits = ((bits << 16) | (bits >>> 16)) >>> 0;
		bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
		bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
		bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
		bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
		const u = (i + 0.5) / n;
		const v = bits / 4294967296;
		const r = Math.sqrt(u);
		const phi = 2 * Math.PI * v;
		out[i * 3] = r * Math.cos(phi);
		out[i * 3 + 1] = r * Math.sin(phi);
		out[i * 3 + 2] = Math.sqrt(Math.max(0, 1 - u));
	}
	return out;
}

/** a per-texel rotation so neighbouring texels use different ray sets (noise, not banding) @param {number} i */
function texelAngle(i) {
	let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
	h ^= h >>> 13;
	h = Math.imul(h, 0xc2b2ae35);
	h ^= h >>> 16;
	return ((h >>> 0) / 4294967296) * Math.PI * 2;
}

const N = new Float32Array(3);

/**
 * Direct irradiance at a point (shadowed). Into `out` [r, g, b].
 * @param {import('./bakeTraceCore.js').Bvh} bvh @param {BakeLight[]} lights
 * @param {number} px @param {number} py @param {number} pz @param {number} nx @param {number} ny @param {number} nz
 * @param {number} bias @param {number} far @param {Float64Array} out
 */
export function directAt(bvh, lights, px, py, pz, nx, ny, nz, bias, far, out) {
	out[0] = out[1] = out[2] = 0;
	const ox = px + nx * bias, oy = py + ny * bias, oz = pz + nz * bias;
	for (const l of lights) {
		if (l.type === 'dir') {
			const ndl = nx * l.dx + ny * l.dy + nz * l.dz;
			if (ndl <= 0) continue;
			if (occluded(bvh, ox, oy, oz, l.dx, l.dy, l.dz, far)) continue;
			out[0] += l.r * ndl;
			out[1] += l.g * ndl;
			out[2] += l.b * ndl;
			continue;
		}
		let vx = l.x - px, vy = l.y - py, vz = l.z - pz;
		const d = Math.sqrt(vx * vx + vy * vy + vz * vz);
		if (!(d > 1e-6)) continue;
		vx /= d;
		vy /= d;
		vz /= d;
		const ndl = nx * vx + ny * vy + nz * vz;
		if (ndl <= 0) continue;
		// three's getDistanceAttenuation
		let atten = 1 / Math.max(Math.pow(d, l.decay), 0.01);
		if (l.distance > 0) {
			const f = Math.min(1, Math.max(0, 1 - Math.pow(d / l.distance, 4)));
			atten *= f * f;
		}
		if (l.type === 'spot') {
			const cos = -(vx * (l.dx ?? 0) + vy * (l.dy ?? 0) + vz * (l.dz ?? -1));
			const lo = l.cosOuter ?? 0.9, hi = l.cosInner ?? 1;
			const t = hi > lo ? Math.min(1, Math.max(0, (cos - lo) / (hi - lo))) : cos >= lo ? 1 : 0;
			atten *= t * t * (3 - 2 * t);
		}
		if (!(atten > 1e-5)) continue;
		if (occluded(bvh, ox, oy, oz, vx, vy, vz, d - bias)) continue;
		out[0] += l.r * ndl * atten;
		out[1] += l.g * ndl * atten;
		out[2] += l.b * ndl * atten;
	}
	return out;
}

/**
 * Trace samples [from, to). A sample = world position + world normal (6 floats). Writes per-sample
 * AO (1 = open) and bounce irradiance (rgb). Returns how many samples it finished — it stops early
 * once `deadline` (ms, from `now()`) passes, so a caller can honour a time cap and Cancel.
 * @param {{ bvh: import('./bakeTraceCore.js').Bvh, albedo: Float32Array, lights: BakeLight[], dirs: Float32Array,
 *   aoDistance: number, bias: number, far: number, bounce: boolean, aoOnly?: Uint8Array | null }} scene
 * @param {Float32Array} samples @param {Float32Array} ao @param {Float32Array} light
 * @param {number} from @param {number} to @param {number} deadline @param {() => number} now
 */
export function traceSamples(scene, samples, ao, light, from, to, deadline, now) {
	const { bvh, albedo, lights, dirs, aoDistance, bias, far } = scene;
	const aoOnly = scene.aoOnly ?? null;
	const rays = dirs.length / 3;
	const direct = new Float64Array(3);
	for (let i = from; i < to; i++) {
		if ((i & 63) === 0 && i > from && now() > deadline) return i - from;
		const o = i * 6;
		// an AO-only mesh (overlapping UVs) gets no light: its shared texels would mix two places
		const bounce = scene.bounce && !(aoOnly && aoOnly[i]);
		const px = samples[o], py = samples[o + 1], pz = samples[o + 2];
		const nx = samples[o + 3], ny = samples[o + 4], nz = samples[o + 5];
		// tangent frame, rotated per texel
		let tx, ty, tz;
		if (Math.abs(nx) < 0.9) {
			tx = 0;
			ty = nz;
			tz = -ny;
		} else {
			tx = -nz;
			ty = 0;
			tz = nx;
		}
		const tl = Math.hypot(tx, ty, tz) || 1;
		tx /= tl;
		ty /= tl;
		tz /= tl;
		let bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
		const a = texelAngle(i), ca = Math.cos(a), sa = Math.sin(a);
		const rtx = tx * ca + bx * sa, rty = ty * ca + by * sa, rtz = tz * ca + bz * sa;
		bx = bx * ca - tx * sa;
		by = by * ca - ty * sa;
		bz = bz * ca - tz * sa;
		const ox = px + nx * bias, oy = py + ny * bias, oz = pz + nz * bias;
		let occ = 0, lr = 0, lg = 0, lb = 0;
		for (let r = 0; r < rays; r++) {
			const u = dirs[r * 3], v = dirs[r * 3 + 1], w = dirs[r * 3 + 2];
			const dx = rtx * u + bx * v + nx * w, dy = rty * u + by * v + ny * w, dz = rtz * u + bz * v + nz * w;
			if (!traceFirst(bvh, ox, oy, oz, dx, dy, dz, bounce ? far : aoDistance)) continue;
			const t = hit.t;
			if (t < aoDistance) occ += 1 - t / aoDistance;
			if (!bounce || !lights.length) continue;
			const tri = hit.tri;
			faceNormal(bvh.tris, tri, N);
			let hnx = N[0], hny = N[1], hnz = N[2];
			if (hnx * dx + hny * dy + hnz * dz > 0) {
				hnx = -hnx;
				hny = -hny;
				hnz = -hnz;
			}
			directAt(bvh, lights, ox + dx * t, oy + dy * t, oz + dz * t, hnx, hny, hnz, bias, far, direct);
			lr += albedo[tri * 3] * direct[0];
			lg += albedo[tri * 3 + 1] * direct[1];
			lb += albedo[tri * 3 + 2] * direct[2];
		}
		ao[i] = 1 - occ / rays;
		light[i * 3] = lr / rays;
		light[i * 3 + 1] = lg / rays;
		light[i * 3 + 2] = lb / rays;
	}
	return to - from;
}

/**
 * Splat samples into texels (overlapping samples average), dilate into empty texels so bilinear
 * sampling at chart edges reads real values, and blur once inside covered texels (denoise).
 * @param {Uint32Array} texelOf sample -> texel @param {Float32Array} ao @param {Float32Array} light
 * @param {number} count samples done @param {number} side
 * @returns {{ ao: Float32Array, light: Float32Array, covered: Uint8Array }}
 */
export function resolveTexels(texelOf, ao, light, count, side) {
	const n = side * side;
	const sumAo = new Float32Array(n);
	const sumL = new Float32Array(n * 3);
	const cnt = new Uint16Array(n);
	for (let i = 0; i < count; i++) {
		const t = texelOf[i];
		sumAo[t] += ao[i];
		sumL[t * 3] += light[i * 3];
		sumL[t * 3 + 1] += light[i * 3 + 1];
		sumL[t * 3 + 2] += light[i * 3 + 2];
		cnt[t]++;
	}
	const covered = new Uint8Array(n);
	let outAo = new Float32Array(n).fill(1);
	let outL = new Float32Array(n * 3);
	for (let t = 0; t < n; t++) {
		if (!cnt[t]) continue;
		covered[t] = 1;
		outAo[t] = sumAo[t] / cnt[t];
		outL[t * 3] = sumL[t * 3] / cnt[t];
		outL[t * 3 + 1] = sumL[t * 3 + 1] / cnt[t];
		outL[t * 3 + 2] = sumL[t * 3 + 2] / cnt[t];
	}
	// denoise: a 3x3 mean over covered neighbours only
	const blurAo = new Float32Array(outAo);
	const blurL = new Float32Array(outL);
	for (let y = 0; y < side; y++) {
		for (let x = 0; x < side; x++) {
			const t = y * side + x;
			if (!covered[t]) continue;
			let a = 0, r = 0, g = 0, b = 0, k = 0;
			for (let dy = -1; dy <= 1; dy++) {
				const yy = y + dy;
				if (yy < 0 || yy >= side) continue;
				for (let dx = -1; dx <= 1; dx++) {
					const xx = x + dx;
					if (xx < 0 || xx >= side) continue;
					const u = yy * side + xx;
					if (!covered[u]) continue;
					a += outAo[u];
					r += outL[u * 3];
					g += outL[u * 3 + 1];
					b += outL[u * 3 + 2];
					k++;
				}
			}
			blurAo[t] = a / k;
			blurL[t * 3] = r / k;
			blurL[t * 3 + 1] = g / k;
			blurL[t * 3 + 2] = b / k;
		}
	}
	outAo = blurAo;
	outL = blurL;
	// dilate: 4 rings outward, each empty texel takes the mean of its filled neighbours
	let filled = new Uint8Array(covered);
	for (let pass = 0; pass < 4; pass++) {
		const next = new Uint8Array(filled);
		for (let y = 0; y < side; y++) {
			for (let x = 0; x < side; x++) {
				const t = y * side + x;
				if (filled[t]) continue;
				let a = 0, r = 0, g = 0, b = 0, k = 0;
				for (let dy = -1; dy <= 1; dy++) {
					const yy = y + dy;
					if (yy < 0 || yy >= side) continue;
					for (let dx = -1; dx <= 1; dx++) {
						const xx = x + dx;
						if (xx < 0 || xx >= side) continue;
						const u = yy * side + xx;
						if (!filled[u]) continue;
						a += outAo[u];
						r += outL[u * 3];
						g += outL[u * 3 + 1];
						b += outL[u * 3 + 2];
						k++;
					}
				}
				if (!k) continue;
				outAo[t] = a / k;
				outL[t * 3] = r / k;
				outL[t * 3 + 1] = g / k;
				outL[t * 3 + 2] = b / k;
				next[t] = 1;
			}
		}
		filled = next;
	}
	return { ao: outAo, light: outL, covered };
}

/** linear -> sRGB byte @param {number} v */
function srgbByte(v) {
	const c = v <= 0 ? 0 : v >= 1 ? 1 : v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
	return Math.round(c * 255);
}

/** the light scale: the 99th percentile of covered texels' brightest channel, so one hot texel does not crush the rest
 * @param {Float32Array} light @param {Uint8Array} covered */
export function lightScaleOf(light, covered) {
	/** @type {number[]} */
	const vals = [];
	for (let t = 0; t < covered.length; t++) if (covered[t]) vals.push(Math.max(light[t * 3], light[t * 3 + 1], light[t * 3 + 2]));
	if (!vals.length) return 0;
	vals.sort((a, b) => a - b);
	return vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.99))];
}

/**
 * The RGBA image: [light | white gutter | AO], `side` rows, opaque. Texel (0, 0) of each half is
 * NEUTRAL (black light, white AO). Rows run in texel order (row 0 = v 0); the apply side sets
 * flipY = false so image row 0 IS v = 0.
 * @param {Float32Array} ao @param {Float32Array} light @param {number} side @param {number} scale
 * @param {number} gutter @returns {Uint8ClampedArray}
 */
export function encodeAtlas(ao, light, side, scale, gutter) {
	const w = side * 2 + gutter;
	const out = new Uint8ClampedArray(w * side * 4);
	const inv = scale > 0 ? 1 / scale : 0;
	for (let y = 0; y < side; y++) {
		for (let x = 0; x < side; x++) {
			const t = y * side + x;
			const neutral = t === 0;
			const L = (y * w + x) * 4;
			out[L] = neutral ? 0 : srgbByte(light[t * 3] * inv);
			out[L + 1] = neutral ? 0 : srgbByte(light[t * 3 + 1] * inv);
			out[L + 2] = neutral ? 0 : srgbByte(light[t * 3 + 2] * inv);
			out[L + 3] = 255;
			const A = (y * w + side + gutter + x) * 4;
			const g = neutral ? 255 : Math.round(Math.min(1, Math.max(0, ao[t])) * 255);
			out[A] = out[A + 1] = out[A + 2] = g;
			out[A + 3] = 255;
		}
		for (let x = side; x < side + gutter; x++) {
			const G = (y * w + x) * 4;
			out[G] = out[G + 1] = out[G + 2] = out[G + 3] = 255;
		}
	}
	return out;
}

/**
 * Box-downscale an encoded atlas (each half on its own, the gutter rebuilt) — the phone / Quest
 * copy. `factor` is a power of two.
 * @param {Uint8ClampedArray} rgba @param {number} side @param {number} factor @param {number} gutter
 * @returns {{ rgba: Uint8ClampedArray, side: number }}
 */
export function downscaleAtlas(rgba, side, factor, gutter) {
	if (factor <= 1) return { rgba, side };
	const w = side * 2 + gutter;
	const s2 = Math.floor(side / factor);
	const w2 = s2 * 2 + gutter;
	const out = new Uint8ClampedArray(w2 * s2 * 4);
	const area = factor * factor;
	for (let half = 0; half < 2; half++) {
		const src0 = half ? side + gutter : 0;
		const dst0 = half ? s2 + gutter : 0;
		for (let y = 0; y < s2; y++) {
			for (let x = 0; x < s2; x++) {
				let r = 0, g = 0, b = 0;
				for (let dy = 0; dy < factor; dy++) {
					for (let dx = 0; dx < factor; dx++) {
						const i = ((y * factor + dy) * w + src0 + x * factor + dx) * 4;
						r += rgba[i];
						g += rgba[i + 1];
						b += rgba[i + 2];
					}
				}
				const o = (y * w2 + dst0 + x) * 4;
				out[o] = r / area;
				out[o + 1] = g / area;
				out[o + 2] = b / area;
				out[o + 3] = 255;
			}
		}
	}
	for (let y = 0; y < s2; y++) {
		for (let x = s2; x < s2 + gutter; x++) {
			const G = (y * w2 + x) * 4;
			out[G] = out[G + 1] = out[G + 2] = out[G + 3] = 255;
		}
	}
	// keep the neutral corners exact
	out[0] = out[1] = out[2] = 0;
	const A = (s2 + gutter) * 4;
	out[A] = out[A + 1] = out[A + 2] = 255;
	return { rgba: out, side: s2 };
}
