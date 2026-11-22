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

/**
 * 98-int T1 (device-lab: Templates ▸ Tavern interior failed "the scene does not fit one lightmap" on the PC, the
 * phone and at Quality ▸ High): its 414 receivers auto-unwrap into 111 599 charts (bevelled kit stone: a 35 m² wall
 * is 534 charts) and EVERY chart costs at least (pad + 1)² texels whatever the density — ~2.8 M texels of padding for
 * a 1 M atlas (9 M of 4 M at High). No atlas size fixes that. When the whole scene does not fit:
 *   1. the most chart-heavy meshes switch to their OWN uv0 as one chart (`alt`: clean → light + AO, overlapping →
 *      AO only), in steps from the heaviest down, until it fits — the Tavern then keeps every receiver;
 *   2. still too much: keep the receivers with the most surface per chart and leave the rest out. Left-out meshes
 *      still OCCLUDE (every static mesh is in the ray soup) and keep their realtime light; the bake's note names them.
 * A scene that fits is planned exactly as before. Deterministic (ties by input order).
 * @template {AtlasItem & { charts?: number, alt?: (() => (Partial<AtlasItem> & { src: string, mode: string, charts: number }) | null) | null }} T
 * @param {T[]} items @param {number} side @param {number} padTexels @param {number} maxDensity
 * @returns {{ atlas: { placements: Placement[], density: number, used: number }, kept: T[], dropped: T[] } | { error: string }}
 */
export function fitAtlas(items, side, padTexels, maxDensity) {
	const full = planAtlas(items, side, padTexels, maxDensity);
	if (!('error' in full)) return { atlas: full, kept: items, dropped: [] };
	// 1. own uv0 for the chart-heavy, heaviest first
	/** @type {T[]} */
	let set = items;
	for (const threshold of [512, 128, 32, 8, 2]) {
		let changed = false;
		const next = set.map((it) => {
			if (!it.alt || (it.charts ?? 1) < threshold) return it;
			const alt = it.alt();
			if (!alt) return it;
			changed = true;
			return /** @type {T} */ ({ ...it, ...alt, alt: null });
		});
		if (!changed) continue;
		set = next;
		const atlas = planAtlas(set, side, padTexels, maxDensity);
		if (!('error' in atlas)) return { atlas, kept: set, dropped: [] };
	}
	// 2. leave the least surface per chart out
	if (set.length < 2) return full;
	const worldOf = (/** @type {T} */ it) => it.area * it.ws * it.ws;
	const order = set
		.map((it, i) => ({ it, i, v: worldOf(it) / Math.max(1, it.charts ?? 1) }))
		.sort((a, b) => b.v - a.v || a.i - b.i);
	let total = 0;
	for (const o of order) total += worldOf(o.it);
	// a first guess from the texel budget at three quarters of the density the area alone would allow
	const d = Math.min(maxDensity, Math.sqrt((0.45 * side * side) / Math.max(1e-9, total))) * 0.75;
	const perChart = (padTexels + 1) * (padTexels + 1);
	let used = 0;
	let k = 0;
	for (; k < order.length; k++) {
		const it = order[k].it;
		const t = worldOf(it) * d * d + (it.charts ?? 1) * perChart;
		if (used + t > 0.6 * side * side) break;
		used += t;
	}
	k = Math.min(k, order.length - 1);
	for (let tries = 0; k > 0 && tries < 16; tries++, k = Math.floor(k * 0.85)) {
		const keep = new Set(order.slice(0, k).map((o) => o.i));
		const kept = set.filter((_, i) => keep.has(i));
		const atlas = planAtlas(kept, side, padTexels, maxDensity);
		if (!('error' in atlas)) return { atlas, kept, dropped: set.filter((_, i) => !keep.has(i)) };
	}
	return full;
}
