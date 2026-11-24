// 26-F PLANNERS (split out of decimateCore by 102): how many triangles each mesh keeps and how far
// textures are drawn down. PURE, imports nothing. Their own module because decimate.js (in the boot
// chunk) needs only these two, while the simplifier half is shared with the LAZY Simplify — one
// module would pull the whole reducer into the boot (measured +1.6 KB gz).

/**
 * How many triangles to ask for. PURE — the quality judgement's arithmetic, out where a
 * test can read it.
 *
 * `room` is the triangle budget left for the WHOLE model (null = no scene-wide limit),
 * `meshCap` the most vertices one mesh may hold. The scene-wide share is split across
 * meshes in proportion to their size, so a model of one huge mesh and ten small ones
 * reduces the huge one and barely touches the rest; the per-mesh cap applies on top
 * (vertices scale with triangles at about 1:2 on a closed surface, so the ratio carries).
 *
 * `floor` is the fraction nothing is reduced below: past about a tenth of its triangles a
 * mesh stops looking like itself, and a reduction that still does not fit is better said
 * out loud ("still over budget") than bought with a shape nobody recognises. Meshes under
 * `minTriangles` are left alone — too small to be worth a seam.
 * @param {{triangles: number, vertices: number}[]} meshes
 * @param {{room?: number | null, meshCap?: number | null, floor?: number, minTriangles?: number}} opts
 * @returns {number[]} a target per mesh (equal to its own count = untouched)
 */
export function planTargets(meshes, opts = {}) {
	const floor = opts.floor ?? 0.1;
	const minTriangles = opts.minTriangles ?? 1000;
	const total = meshes.reduce((a, m) => a + (m.triangles >= minTriangles ? m.triangles : 0), 0);
	const small = meshes.reduce((a, m) => a + (m.triangles < minTriangles ? m.triangles : 0), 0);
	const room = opts.room == null ? null : Math.max(0, opts.room - small);
	const sceneRatio = room == null || total === 0 ? 1 : Math.min(1, room / total);
	return meshes.map((m) => {
		if (m.triangles < minTriangles) return m.triangles;
		let ratio = sceneRatio;
		if (opts.meshCap && m.vertices > opts.meshCap) ratio = Math.min(ratio, opts.meshCap / m.vertices);
		ratio = Math.max(floor, Math.min(1, ratio));
		return ratio >= 1 ? m.triangles : Math.max(minTriangles, Math.floor(m.triangles * ratio));
	});
}

/**
 * The longest side textures should be drawn down to, or null to leave them. PURE.
 *
 * `single` is the single-texture ceiling (nothing above it survives); `budget` is the
 * byte total this model's textures may take (RGBA8 + mips, the importBudget unit) — when
 * the ceiling alone does not fit it, the cap halves down to no smaller than 512px. One
 * cap for every texture rather than a per-texture sum: a model whose albedo is halved
 * and whose normal map is not looks worse than one whose maps all lost the same detail.
 * @param {{width: number, height: number}[]} sizes
 * @param {{single?: number | null, budget?: number | null}} opts
 * @returns {number | null}
 */
export function planTextureCap(sizes, opts = {}) {
	const longest = sizes.reduce((m, s) => Math.max(m, s.width || 0, s.height || 0), 0);
	if (!longest) return null;
	/** @param {number} cap */
	const bytesAt = (cap) =>
		sizes.reduce((sum, s) => {
			const scale = Math.min(1, cap / Math.max(1, s.width, s.height));
			return sum + Math.round(s.width * scale) * Math.round(s.height * scale) * 4 * (4 / 3);
		}, 0);
	let cap = opts.single && longest > opts.single ? opts.single : longest;
	if (opts.budget != null) {
		while (bytesAt(cap) > opts.budget && cap > 512) cap = Math.max(512, 2 ** Math.floor(Math.log2(cap - 1)));
	}
	return cap < longest ? cap : null;
}
