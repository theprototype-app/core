// 98 P1 — the ATLAS: where each baked mesh sits in the one shared lightmap, and the image's
// layout. ZERO IMPORTS.
//
// ONE atlas per bake, on purpose: a material shared by several objects carries ONE lightMap,
// so every baked object must read the same texture. A mesh that shares such a material but was
// not baked has no bake UVs; three then reads the attribute's default (0, 0), so texel (0, 0)
// is kept NEUTRAL (no light, no occlusion) and that mesh looks exactly as before.
//
// THE IMAGE: [light half | 2-texel gutter | AO half], one PNG, `side` texels tall. The light
// half is RGB irradiance (sRGB-encoded, scaled by `lightScale`), the AO half is grey. Two
// three.js textures read it through offset / repeat. The gutter is WHITE, so the AO half's
// texture sampled at u = 0 (the neutral corner, on the half boundary) blends white with white.

import { shelfPack } from './bakeUnwrapCore.js';

export const GUTTER = 2;

/** image width for an atlas side @param {number} side */
export function imageWidth(side) {
	return side * 2 + GUTTER;
}

/** offset / repeat (in image u) of the two halves @param {number} side */
export function halves(side) {
	const w = imageWidth(side);
	return { light: { offset: 0, repeat: side / w }, ao: { offset: (side + GUTTER) / w, repeat: side / w } };
}

/**
 * @typedef {{ key: string, ws: number, area: number, layoutFor: (pad: number) => ({ ok: true, w: number, h: number } | { ok: false, reason: string }) }} AtlasItem
 * @typedef {{ key: string, x: number, y: number, s: number, pad: number, texels: number }} Placement
 */

/**
 * Place every item in one `side`² atlas at the highest texel density that fits (binary search),
 * never above `maxDensity` texels per world unit. `pad` (texels) separates charts and objects.
 * Returns placements in ATLAS units (0..1) and the density reached.
 * @param {AtlasItem[]} items @param {number} side @param {number} padTexels @param {number} maxDensity
 * @returns {{ placements: Placement[], density: number, used: number } | { error: string }}
 */
export function planAtlas(items, side, padTexels, maxDensity) {
	if (!items.length) return { error: 'nothing to bake' };
	let worldArea = 0;
	for (const it of items) worldArea += it.area * it.ws * it.ws;
	if (!(worldArea > 0)) return { error: 'nothing with any area' };
	/** @param {number} d */
	const attempt = (d) => {
		/** @type {{w: number, h: number}[]} */
		const rects = [];
		/** @type {number[]} */
		const pads = [];
		for (const it of items) {
			const pad = padTexels / (d * it.ws);
			const layout = it.layoutFor(pad);
			if (!layout.ok) return null;
			pads.push(pad);
			rects.push({ w: Math.max(1, Math.ceil(layout.w * d * it.ws)), h: Math.max(1, Math.ceil(layout.h * d * it.ws)) });
		}
		const packed = shelfPack(rects, side, padTexels);
		if (packed.h > side || packed.w > side) return null;
		return { rects, pads, packed };
	};
	let lo = 0;
	let hi = Math.min(maxDensity, Math.sqrt((side * side) / worldArea));
	let best = attempt(hi);
	if (best) lo = hi;
	else {
		for (let i = 0; i < 18; i++) {
			const mid = (lo + hi) / 2;
			const got = attempt(mid);
			if (got) {
				lo = mid;
				best = got;
			} else hi = mid;
		}
	}
	if (!best || !(lo > 0)) return { error: 'the scene does not fit one lightmap' };
	const d = lo;
	return {
		density: d,
		used: best.packed.h / side,
		placements: items.map((it, i) => ({
			key: it.key,
			x: best.packed.x[i] / side,
			y: best.packed.y[i] / side,
			s: (d * it.ws) / side,
			pad: best.pads[i],
			texels: best.rects[i].w * best.rects[i].h
		}))
	};
}
