// 98 P1 — the bake PLAN: from the scene's static meshes to (a) where each one sits in the atlas,
// (b) one world-space SAMPLE per covered texel and (c) the triangle soup the rays hit. Pure, ZERO
// IMPORTS beyond the other bake cores; it runs in the Worker so the editor never stalls on it.

import { chooseUnwrap, rebuildLayout, triangleList, buildCharts, autoUnwrap, layoutFromUv, atlasUv, rasterTriangles } from './bakeUnwrapCore.js';
import { planAtlas } from './bakeAtlasCore.js';

/**
 * @typedef {{
 *   key: string, receive: boolean,
 *   pos: Float32Array, index: Uint32Array | null, normal: Float32Array | null,
 *   uv0: Float32Array | null, uv1: Float32Array | null,
 *   world: ArrayLike<number>, albedo: number[]
 * }} BakeMesh  (pos / normal in OBJECT space; world = column-major matrixWorld)
 */

/** world-scale of a matrix: the cube root of |det| of its 3x3 @param {ArrayLike<number>} m */
export function worldScaleOf(m) {
	const det =
		m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
	return Math.cbrt(Math.abs(det)) || 1;
}

/** @param {ArrayLike<number>} m @param {number} x @param {number} y @param {number} z @param {Float64Array} out */
function xform(m, x, y, z, out) {
	out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
	out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
	out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
	return out;
}

/** the normal matrix as a cofactor 3x3 (row-major), right for non-uniform scale @param {ArrayLike<number>} m */
function normalMatrix(m) {
	const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
	const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
	const s = det < 0 ? -1 : 1;
	return [
		s * (e * i - f * h), s * (f * g - d * i), s * (d * h - e * g),
		s * (c * h - b * i), s * (a * i - c * g), s * (b * g - a * h),
		s * (b * f - c * e), s * (c * d - a * f), s * (a * e - b * d)
	];
}

/**
 * @param {BakeMesh[]} meshes @param {{ atlas: number, pad: number, maxDensity: number }} budget
 * @returns {{ error: string } | {
 *   side: number, density: number, samples: Float32Array, texelOf: Uint32Array, aoOnly: Uint8Array,
 *   tris: Float32Array, albedo: Float32Array, aoDistance: number, bias: number, far: number,
 *   objects: { key: string, src: string, mode: string, pad: number, x: number, y: number, s: number, texels: number }[],
 *   skipped: { key: string, reason: string }[]
 * }}
 */
export function planBake(meshes, budget) {
	const side = budget.atlas;
	const p = new Float64Array(3);
	// triangle soup (every mesh occludes) + scene bounds
	let triCount = 0;
	const lists = meshes.map((m) => {
		const tris = triangleList(m.index, Math.floor(m.pos.length / 3));
		triCount += tris.length / 3;
		return tris;
	});
	const soup = new Float32Array(triCount * 9);
	const albedo = new Float32Array(triCount * 3);
	let k = 0;
	let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
	meshes.forEach((m, mi) => {
		const tris = lists[mi];
		for (let t = 0; t < tris.length; t += 3) {
			for (let c = 0; c < 3; c++) {
				const v = tris[t + c];
				xform(m.world, m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2], p);
				soup[k * 9 + c * 3] = p[0];
				soup[k * 9 + c * 3 + 1] = p[1];
				soup[k * 9 + c * 3 + 2] = p[2];
				if (m.receive) {
					if (p[0] < x0) x0 = p[0];
					if (p[0] > x1) x1 = p[0];
					if (p[1] < y0) y0 = p[1];
					if (p[1] > y1) y1 = p[1];
					if (p[2] < z0) z0 = p[2];
					if (p[2] > z1) z1 = p[2];
				}
			}
			albedo[k * 3] = m.albedo[0];
			albedo[k * 3 + 1] = m.albedo[1];
			albedo[k * 3 + 2] = m.albedo[2];
			k++;
		}
	});
	const diag = Number.isFinite(x0) ? Math.hypot(x1 - x0, y1 - y0, z1 - z0) : 1;
	const aoDistance = Math.min(4, Math.max(0.25, diag * 0.12));
	const bias = Math.max(1e-4, diag * 2e-4);
	const far = Math.max(1, diag * 2);

	// unwrap every receiver at a first density guess (the overlap check needs a texel size)
	const receivers = meshes.map((m, i) => ({ m, i })).filter((r) => r.m.receive);
	let worldArea = 0;
	const areaOf = receivers.map(({ m, i }) => {
		const ws = worldScaleOf(m.world);
		const tris = lists[i];
		let a = 0;
		for (let t = 0; t < tris.length; t += 3) {
			const A = tris[t] * 3, B = tris[t + 1] * 3, C = tris[t + 2] * 3;
			const ux = m.pos[B] - m.pos[A], uy = m.pos[B + 1] - m.pos[A + 1], uz = m.pos[B + 2] - m.pos[A + 2];
			const vx = m.pos[C] - m.pos[A], vy = m.pos[C + 1] - m.pos[A + 1], vz = m.pos[C + 2] - m.pos[A + 2];
			a += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
		}
		worldArea += a * ws * ws;
		return { ws, area: a };
	});
	if (!(worldArea > 0)) return { error: 'nothing to bake: no static surfaces' };
	const d0 = Math.min(budget.maxDensity, Math.sqrt((side * side * 0.45) / worldArea));
	/** @type {{ key: string, reason: string }[]} */
	const skipped = [];
	/** @type {any[]} */
	const items = [];
	receivers.forEach(({ m, i }, ri) => {
		const { ws, area } = areaOf[ri];
		const geo = { pos: m.pos, index: m.index, uv0: m.uv0, uv1: m.uv1 };
		const chosen = chooseUnwrap(geo, budget.pad / (d0 * ws), d0 * ws);
		if ('error' in chosen) {
			skipped.push({ key: m.key, reason: chosen.error });
			return;
		}
		const tris = lists[i];
		const built = chosen.src === 'auto' ? buildCharts(m.pos, tris, m.uv0) : null;
		const fixed = chosen.src === 'auto' ? null : layoutFromUv(m.pos, tris, /** @type {any} */ (chosen.src === 'uv1' ? m.uv1 : m.uv0));
		items.push({
			key: m.key,
			ws,
			area,
			mi: i,
			src: chosen.src,
			mode: chosen.mode,
			layoutFor: (/** @type {number} */ pad) => (built ? autoUnwrap(m.pos, tris, m.uv0, pad, built) : fixed)
		});
	});
	if (!items.length) return { error: skipped.length ? 'no mesh could be unwrapped (' + skipped[0].reason + ')' : 'nothing to bake' };
	const atlas = planAtlas(items, side, budget.pad, budget.maxDensity);
	if ('error' in atlas) return { error: atlas.error };

	// samples: one per (covered texel, triangle)
	/** @type {number[]} */
	const samp = [];
	/** @type {number[]} */
	const texels = [];
	/** @type {number[]} */
	const flags = [];
	const n = new Float64Array(3);
	const objects = items.map((it, idx) => {
		const pl = atlas.placements[idx];
		const m = meshes[it.mi];
		const layout = it.layoutFor(pl.pad);
		const uv = atlasUv(layout.uv, pl.x, pl.y, pl.s);
		const tex = new Float32Array(uv.length);
		for (let q = 0; q < uv.length; q++) tex[q] = uv[q] * side;
		const tris = lists[it.mi];
		const nm = normalMatrix(m.world);
		const aoFlag = it.mode === 'ao' ? 1 : 0;
		rasterTriangles(tex, tris, side, side, (texel, t, b0, b1, b2) => {
			const A = tris[t * 3], B = tris[t * 3 + 1], C = tris[t * 3 + 2];
			const lx = m.pos[A * 3] * b0 + m.pos[B * 3] * b1 + m.pos[C * 3] * b2;
			const ly = m.pos[A * 3 + 1] * b0 + m.pos[B * 3 + 1] * b1 + m.pos[C * 3 + 1] * b2;
			const lz = m.pos[A * 3 + 2] * b0 + m.pos[B * 3 + 2] * b1 + m.pos[C * 3 + 2] * b2;
			xform(m.world, lx, ly, lz, p);
			let nx, ny, nz;
			if (m.normal) {
				nx = m.normal[A * 3] * b0 + m.normal[B * 3] * b1 + m.normal[C * 3] * b2;
				ny = m.normal[A * 3 + 1] * b0 + m.normal[B * 3 + 1] * b1 + m.normal[C * 3 + 1] * b2;
				nz = m.normal[A * 3 + 2] * b0 + m.normal[B * 3 + 2] * b1 + m.normal[C * 3 + 2] * b2;
			} else {
				const ux = m.pos[B * 3] - m.pos[A * 3], uy = m.pos[B * 3 + 1] - m.pos[A * 3 + 1], uz = m.pos[B * 3 + 2] - m.pos[A * 3 + 2];
				const vx = m.pos[C * 3] - m.pos[A * 3], vy = m.pos[C * 3 + 1] - m.pos[A * 3 + 1], vz = m.pos[C * 3 + 2] - m.pos[A * 3 + 2];
				nx = uy * vz - uz * vy;
				ny = uz * vx - ux * vz;
				nz = ux * vy - uy * vx;
			}
			n[0] = nm[0] * nx + nm[1] * ny + nm[2] * nz;
			n[1] = nm[3] * nx + nm[4] * ny + nm[5] * nz;
			n[2] = nm[6] * nx + nm[7] * ny + nm[8] * nz;
			const len = Math.hypot(n[0], n[1], n[2]);
			if (!(len > 0)) return;
			samp.push(p[0], p[1], p[2], n[0] / len, n[1] / len, n[2] / len);
			texels.push(texel);
			flags.push(aoFlag);
		});
		return { key: it.key, src: it.src, mode: it.mode, pad: pl.pad, x: pl.x, y: pl.y, s: pl.s, texels: pl.texels };
	});
	return {
		side,
		density: atlas.density,
		samples: Float32Array.from(samp),
		texelOf: Uint32Array.from(texels),
		aoOnly: Uint8Array.from(flags),
		tris: soup,
		albedo,
		aoDistance,
		bias,
		far,
		objects,
		skipped
	};
}

/**
 * The APPLY side's bake UVs for one mesh (every peer): rebuild its layout from the record entry
 * and place it in the atlas. Null when the geometry no longer unwraps the same way.
 * @param {{ pos: Float32Array, index: ArrayLike<number> | null, uv0?: Float32Array | null, uv1?: Float32Array | null }} geo
 * @param {{ src: 'uv1' | 'auto' | 'uv0', pad: number, x: number, y: number, s: number }} entry @returns {Float32Array | null}
 */
export function bakeUvFor(geo, entry) {
	const layout = rebuildLayout(geo, entry.src, entry.pad);
	if (!layout.ok) return null;
	return atlasUv(layout.uv, entry.x, entry.y, entry.s);
}
