// 26-F phase 2 — THE DECIMATION ARITHMETIC, with no THREE, no DOM and no Worker.
//
// It runs INSIDE the decimation Worker (decimateWorker.js) and in the unit suite, which
// is why it imports nothing: the simplifier is HANDED IN (meshoptimizer's
// `MeshoptSimplifier`, once its wasm is ready), and a mesh arrives as plain typed arrays.
// That keeps the one part with real arithmetic in it — welding a triangle soup, splitting
// by material group, compacting the vertex buffer — testable in node against the real
// simplifier, with no browser and no GPU.
//
// WHY meshoptimizer and not three's SimplifyModifier, which the roadmap named: MEASURED
// on this box (node, same machine as 26-E) — SimplifyModifier is quadratic: 40k triangles
// took 1.0s and 80k took 4.8s, so the 200k-triangle case 26-E designs against would run
// for ~30s and a 2.4M scan for hours, in a Worker or not. meshoptimizer's quadric
// simplifier took 200k -> 50k in 107ms (133ms keeping normals and uvs), is attribute-aware
// (seams and uv islands survive), reports the error it introduced, and was already in the
// dependency tree (three's own typings pull it in). A decimator whose runtime is a
// function of luck is not something a person can be asked to wait for.

/**
 * @typedef {{key: string, positions: Float32Array, normals?: Float32Array | null,
 *   uvs?: Float32Array | null, colors?: Float32Array | null, colorSize?: number,
 *   index?: Uint32Array | null, groups?: {start: number, count: number, materialIndex?: number}[],
 *   target: number}} MeshIn
 * @typedef {{key: string, positions: Float32Array, normals: Float32Array | null,
 *   uvs: Float32Array | null, colors: Float32Array | null, colorSize: number, index: Uint32Array,
 *   groups: {start: number, count: number, materialIndex?: number}[], triangles: number,
 *   before: number, error: number, recomputeNormals: boolean, skipped?: string}} MeshOut
 */

/**
 * Weld a triangle SOUP into an indexed mesh. meshoptimizer collapses EDGES, and a soup
 * has none shared — every triangle owns its three corners — so an unwelded OBJ or STL
 * would come back exactly as it went in (measured on the first pass: 0% reduction).
 *
 * Welded by POSITION plus UV (uvs are what a seam must keep apart). NORMALS are
 * deliberately NOT part of the key and are recomputed afterwards: an STL arrives with a
 * flat normal per face, so keying on them would weld nothing at all.
 * @param {Float32Array} positions @param {Float32Array | null | undefined} uvs
 * @param {Float32Array | null | undefined} colors @param {number} colorSize
 * @returns {{positions: Float32Array, uvs: Float32Array | null, colors: Float32Array | null, index: Uint32Array}}
 */
export function weldSoup(positions, uvs, colors, colorSize = 3) {
	const count = positions.length / 3;
	/** @type {Map<string, number>} */
	const seen = new Map();
	const index = new Uint32Array(count);
	/** @type {number[]} */
	const firsts = [];
	for (let i = 0; i < count; i++) {
		let key = positions[i * 3] + ',' + positions[i * 3 + 1] + ',' + positions[i * 3 + 2];
		if (uvs) key += '|' + uvs[i * 2] + ',' + uvs[i * 2 + 1];
		let at = seen.get(key);
		if (at === undefined) {
			at = firsts.length;
			seen.set(key, at);
			firsts.push(i);
		}
		index[i] = at;
	}
	const n = firsts.length;
	const outPos = new Float32Array(n * 3);
	const outUv = uvs ? new Float32Array(n * 2) : null;
	const outCol = colors ? new Float32Array(n * colorSize) : null;
	for (let j = 0; j < n; j++) {
		const i = firsts[j];
		outPos[j * 3] = positions[i * 3];
		outPos[j * 3 + 1] = positions[i * 3 + 1];
		outPos[j * 3 + 2] = positions[i * 3 + 2];
		if (outUv && uvs) {
			outUv[j * 2] = uvs[i * 2];
			outUv[j * 2 + 1] = uvs[i * 2 + 1];
		}
		if (outCol && colors) for (let c = 0; c < colorSize; c++) outCol[j * colorSize + c] = colors[i * colorSize + c];
	}
	return { positions: outPos, uvs: outUv, colors: outCol, index };
}

/** Interleave the attribute channels meshoptimizer weighs alongside position.
 * @param {number} count @param {(Float32Array | null | undefined)[]} channels @param {number[]} sizes */
function interleave(count, channels, sizes) {
	const stride = sizes.reduce((a, b, i) => a + (channels[i] ? b : 0), 0);
	if (!stride) return { data: null, stride: 0 };
	const data = new Float32Array(count * stride);
	for (let v = 0; v < count; v++) {
		let o = v * stride;
		channels.forEach((channel, i) => {
			if (!channel) return;
			const size = sizes[i];
			for (let c = 0; c < size; c++) data[o++] = channel[v * size + c];
		});
	}
	return { data, stride };
}

/** Attribute weights, relative to position error. Normals matter less than uvs: a normal
 * that drifts a little shades a little differently, a uv that drifts moves the texture.
 * These are meshoptimizer's own documented starting points. */
const WEIGHT = { normal: 0.5, uv: 1, color: 1 };

/**
 * The error the simplifier may introduce, relative to the mesh's extent. It is a CAP, not
 * a goal: the simplifier stops at the target triangle count if it gets there first. 5% is
 * generous on purpose — the budget, not the error, is what the user was shown — and the
 * error actually introduced is REPORTED, so the dialog can say how far the shape moved.
 */
export const ERROR_CAP = 0.05;

/**
 * Simplify one mesh towards `mesh.target` triangles. PURE apart from the handed-in
 * simplifier. Material groups are simplified SEPARATELY with their borders locked, so the
 * seam between two materials cannot open (a crack) and no triangle changes material.
 * @param {any} simplifier meshoptimizer's MeshoptSimplifier, ready
 * @param {MeshIn} mesh
 * @returns {MeshOut}
 */
export function simplifyMesh(simplifier, mesh) {
	let positions = mesh.positions;
	let normals = mesh.normals ?? null;
	let uvs = mesh.uvs ?? null;
	let colors = mesh.colors ?? null;
	const colorSize = mesh.colorSize ?? 3;
	let index = mesh.index ?? null;
	let recomputeNormals = false;
	const before = Math.floor((index ? index.length : positions.length / 3) / 3);
	if (!index) {
		const welded = weldSoup(positions, uvs, colors, colorSize);
		positions = welded.positions;
		uvs = welded.uvs;
		colors = welded.colors;
		index = welded.index;
		normals = null;
		recomputeNormals = true;
	} else {
		index = new Uint32Array(index);
	}
	const vertexCount = positions.length / 3;
	const { data: attrs, stride } = interleave(vertexCount, [normals, uvs, colors], [3, 2, colorSize]);
	/** @type {number[]} */
	const weights = [];
	if (normals) weights.push(WEIGHT.normal, WEIGHT.normal, WEIGHT.normal);
	if (uvs) weights.push(WEIGHT.uv, WEIGHT.uv);
	if (colors) for (let c = 0; c < colorSize; c++) weights.push(WEIGHT.color);

	const groups = mesh.groups?.length ? mesh.groups : [{ start: 0, count: index.length }];
	const multi = groups.length > 1;
	const ratio = before > 0 ? Math.min(1, Math.max(0, mesh.target / before)) : 1;
	/** @type {Uint32Array[]} */
	const pieces = [];
	/** @type {{start: number, count: number, materialIndex?: number}[]} */
	const outGroups = [];
	let error = 0;
	let at = 0;
	for (const group of groups) {
		const start = Math.max(0, group.start);
		const end = Math.min(index.length, start + Math.min(group.count, index.length - start));
		const slice = index.subarray(start, end - ((end - start) % 3));
		const targetCount = Math.max(3, Math.floor((slice.length / 3) * ratio) * 3);
		const flags = multi ? ['LockBorder'] : [];
		/** @type {[Uint32Array, number]} */
		const [out, err] = attrs
			? simplifier.simplifyWithAttributes(slice, positions, 3, attrs, stride, weights, null, Math.min(targetCount, slice.length), ERROR_CAP, flags)
			: simplifier.simplify(slice, positions, 3, Math.min(targetCount, slice.length), ERROR_CAP, flags);
		pieces.push(out);
		outGroups.push({ start: at, count: out.length, ...(group.materialIndex !== undefined ? { materialIndex: group.materialIndex } : {}) });
		at += out.length;
		error = Math.max(error, err);
	}
	const joined = new Uint32Array(at);
	let o = 0;
	for (const piece of pieces) {
		joined.set(piece, o);
		o += piece.length;
	}
	// drop the vertices no triangle uses any more — the whole memory (and wire) saving of
	// a decimation lives here; an index shrunk over an untouched vertex buffer saves draw
	// time and nothing else
	const [remap, unique] = joined.length ? simplifier.compactMesh(joined) : [new Uint32Array(0), 0];
	/** @param {Float32Array | null} src @param {number} size */
	const pack = (src, size) => {
		if (!src) return null;
		const dst = new Float32Array(unique * size);
		for (let v = 0; v < remap.length; v++) {
			const to = remap[v];
			if (to >= unique) continue;
			for (let c = 0; c < size; c++) dst[to * size + c] = src[v * size + c];
		}
		return dst;
	};
	return {
		key: mesh.key,
		positions: /** @type {Float32Array} */ (pack(positions, 3)),
		normals: pack(normals, 3),
		uvs: pack(uvs, 2),
		colors: pack(colors, colorSize),
		colorSize,
		index: joined,
		groups: multi ? outGroups : [],
		triangles: joined.length / 3,
		before,
		error,
		recomputeNormals
	};
}

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
