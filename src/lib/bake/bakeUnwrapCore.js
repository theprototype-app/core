// 98 P1 — LIGHTMAP UVs: the auto-unwrap, the chart packer, the overlap check and the texel
// rasterizer the bake and the apply share. ZERO IMPORTS (unit layer + Worker).
//
// THE RULE THIS FILE KEEPS: an unwrap is a pure function of the GEOMETRY (object-space
// positions, index, uv0, uv1) plus the per-object numbers the bake record stores (`pad`, the
// atlas rect). So a peer that receives a bake record rebuilds the very same lightmap UVs from
// its own copy of the mesh — no UV array ever travels, and nothing is written into the user's
// geometry topology (the bake UVs live in their own attribute, uv2 or uv3).
//
// Source order per mesh (`chooseUnwrap`): the mesh's own uv1 when it is a clean lightmap layout
// → the auto-unwrap → its uv0 (primitives' uv0 is often a valid layout). The first one with no
// overlap wins and gets AO + light; when every candidate overlaps the mesh bakes AO ONLY on the
// least-overlapping one (overlapping texels average their AO, which reads fine; baked LIGHT on
// shared texels would be wrong, so it is left out) — the "AO only" note in the panel.

/** overlap ratio a layout may have and still count as clean (center-sampled raster noise) */
export const CLEAN_OVERLAP = 0.01;
/** a chart's triangles must all face within this of the chart normal (cos 70°) */
const PLANAR_MIN_DOT = 0.34;
/** two flat charts across a shared edge merge when their normals are this close (cos ~5°) */
const MERGE_DOT = 0.996;

/** triangle corner list (3 per triangle) @param {ArrayLike<number> | null} index @param {number} vertexCount */
export function triangleList(index, vertexCount) {
	if (index && index.length >= 3) return Uint32Array.from(index).subarray(0, index.length - (index.length % 3));
	const n = vertexCount - (vertexCount % 3);
	const out = new Uint32Array(n);
	for (let i = 0; i < n; i++) out[i] = i;
	return out;
}

/** @param {Int32Array} parent @param {number} a */
function find(parent, a) {
	while (parent[a] !== a) {
		parent[a] = parent[parent[a]];
		a = parent[a];
	}
	return a;
}

/** @param {Float32Array | number[]} p @param {number} a @param {number} b @param {number} c @param {Float64Array} out [nx,ny,nz,area] */
function triNormal(p, a, b, c, out) {
	const e1x = p[b * 3] - p[a * 3], e1y = p[b * 3 + 1] - p[a * 3 + 1], e1z = p[b * 3 + 2] - p[a * 3 + 2];
	const e2x = p[c * 3] - p[a * 3], e2y = p[c * 3 + 1] - p[a * 3 + 1], e2z = p[c * 3 + 2] - p[a * 3 + 2];
	const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
	const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
	out[3] = len / 2;
	if (len > 0) {
		out[0] = nx / len;
		out[1] = ny / len;
		out[2] = nz / len;
	} else out[0] = out[1] = out[2] = 0;
	return out;
}

/** quantized position key so a non-indexed mesh's corners meet (deterministic) @param {Float32Array | number[]} p @param {number} v @param {number} q */
function weldKey(p, v, q) {
	return Math.round(p[v * 3] * q) + ',' + Math.round(p[v * 3 + 1] * q) + ',' + Math.round(p[v * 3 + 2] * q);
}

/**
 * @typedef {{ tris: number[], planar: boolean, nx: number, ny: number, nz: number, area: number }} Chart
 * @typedef {{ ok: true, uv: Float32Array, w: number, h: number, charts: number, area: number }
 *   | { ok: false, reason: string }} Layout
 */

/**
 * Split a mesh into charts: vertices shared by index FORCE one chart (a vertex has one UV), flat
 * charts that meet across a welded edge at (almost) the same angle merge (a non-indexed box's
 * two triangles per side become one chart), and a curved chart is parameterised by its own uv0.
 * @param {Float32Array | number[]} pos object-space positions @param {Uint32Array} tris
 * @param {Float32Array | number[] | null} uv0
 * @returns {{ charts: Chart[], coords: Float64Array } | { error: string }} coords = per-vertex chart-local 2D (object units)
 */
export function buildCharts(pos, tris, uv0) {
	const V = Math.floor(pos.length / 3);
	const T = tris.length / 3;
	if (!T) return { error: 'no triangles' };
	const parent = new Int32Array(V);
	for (let i = 0; i < V; i++) parent[i] = i;
	for (let t = 0; t < T; t++) {
		const a = find(parent, tris[t * 3]);
		const b = find(parent, tris[t * 3 + 1]);
		const c = find(parent, tris[t * 3 + 2]);
		if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
		const r = find(parent, a);
		if (r !== c) parent[Math.max(r, c)] = Math.min(r, c);
	}
	// forced groups, numbered in first-seen triangle order (deterministic)
	/** @type {Map<number, number>} */
	const groupOfRoot = new Map();
	const triGroup = new Int32Array(T);
	/** @type {Chart[]} */
	const groups = [];
	const n = new Float64Array(4);
	const triN = new Float64Array(T * 3);
	for (let t = 0; t < T; t++) {
		const root = find(parent, tris[t * 3]);
		let g = groupOfRoot.get(root);
		if (g === undefined) {
			g = groups.length;
			groupOfRoot.set(root, g);
			groups.push({ tris: [], planar: true, nx: 0, ny: 0, nz: 0, area: 0 });
		}
		triGroup[t] = g;
		const grp = groups[g];
		grp.tris.push(t);
		triNormal(pos, tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2], n);
		triN[t * 3] = n[0];
		triN[t * 3 + 1] = n[1];
		triN[t * 3 + 2] = n[2];
		grp.nx += n[0] * n[3];
		grp.ny += n[1] * n[3];
		grp.nz += n[2] * n[3];
		grp.area += n[3];
	}
	for (const g of groups) planarize(g, triN);
	// merge flat neighbours across welded edges (only between groups that are each flat)
	const q = 1e4;
	const weld = new Array(V);
	for (let v = 0; v < V; v++) weld[v] = weldKey(pos, v, q);
	/** @type {Map<string, number>} */
	const edgeOwner = new Map();
	const gparent = new Int32Array(groups.length);
	for (let i = 0; i < groups.length; i++) gparent[i] = i;
	/** running normal sums per merged set */
	const sum = groups.map((g) => [g.nx * g.area, g.ny * g.area, g.nz * g.area]);
	for (let t = 0; t < T; t++) {
		for (let e = 0; e < 3; e++) {
			const a = weld[tris[t * 3 + e]];
			const b = weld[tris[t * 3 + ((e + 1) % 3)]];
			const key = a < b ? a + '|' + b : b + '|' + a;
			const other = edgeOwner.get(key);
			if (other === undefined) {
				edgeOwner.set(key, triGroup[t]);
				continue;
			}
			const ga = find(gparent, triGroup[t]);
			const gb = find(gparent, other);
			if (ga === gb || !groups[triGroup[t]].planar || !groups[other].planar) continue;
			const sa = sum[ga], sb = sum[gb];
			const la = Math.hypot(sa[0], sa[1], sa[2]) || 1, lb = Math.hypot(sb[0], sb[1], sb[2]) || 1;
			const dot = (sa[0] * sb[0] + sa[1] * sb[1] + sa[2] * sb[2]) / (la * lb);
			if (dot < MERGE_DOT) continue;
			const keep = Math.min(ga, gb), drop = Math.max(ga, gb);
			gparent[drop] = keep;
			sum[keep] = [sa[0] + sb[0], sa[1] + sb[1], sa[2] + sb[2]];
		}
	}
	/** @type {Map<number, Chart>} */
	const merged = new Map();
	/** @type {Chart[]} */
	const charts = [];
	for (let g = 0; g < groups.length; g++) {
		const root = find(gparent, g);
		let chart = merged.get(root);
		if (!chart) {
			chart = { tris: [], planar: groups[g].planar, nx: 0, ny: 0, nz: 0, area: 0 };
			merged.set(root, chart);
			charts.push(chart);
		}
		chart.tris.push(...groups[g].tris);
		chart.planar = chart.planar && groups[g].planar;
		chart.nx += groups[g].nx * groups[g].area;
		chart.ny += groups[g].ny * groups[g].area;
		chart.nz += groups[g].nz * groups[g].area;
		chart.area += groups[g].area;
	}
	/** @type {Chart[]} */
	const final = [];
	for (const chart of charts) {
		const len = Math.hypot(chart.nx, chart.ny, chart.nz);
		if (len > 0) {
			chart.nx /= len;
			chart.ny /= len;
			chart.nz /= len;
		}
		// a long chain of 5° steps can drift round a curve: such a chart falls back to its groups
		if (chart.planar && chart.tris.some((t) => triN[t * 3] * chart.nx + triN[t * 3 + 1] * chart.ny + triN[t * 3 + 2] * chart.nz < PLANAR_MIN_DOT && triN[t * 3] + triN[t * 3 + 1] + triN[t * 3 + 2] !== 0)) {
			const seen = new Set();
			for (const t of chart.tris) {
				const g = triGroup[t];
				if (seen.has(g)) continue;
				seen.add(g);
				final.push(groups[g]);
			}
		} else final.push(chart);
	}
	// chart-local 2D coordinates per vertex
	const coords = new Float64Array(V * 2);
	for (const chart of final) {
		if (chart.planar) {
			const { u, v } = basisFor(chart.nx, chart.ny, chart.nz);
			for (const t of chart.tris) {
				for (let k = 0; k < 3; k++) {
					const vi = tris[t * 3 + k];
					const x = pos[vi * 3], y = pos[vi * 3 + 1], z = pos[vi * 3 + 2];
					coords[vi * 2] = x * u[0] + y * u[1] + z * u[2];
					coords[vi * 2 + 1] = x * v[0] + y * v[1] + z * v[2];
				}
			}
			continue;
		}
		// curved: its own uv0, scaled to object units, when the uv0 is consistently oriented
		if (!uv0) return { error: 'curved surface without UVs' };
		let uvArea = 0;
		let sign = 0;
		for (const t of chart.tris) {
			const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
			const s = (uv0[b * 2] - uv0[a * 2]) * (uv0[c * 2 + 1] - uv0[a * 2 + 1]) - (uv0[c * 2] - uv0[a * 2]) * (uv0[b * 2 + 1] - uv0[a * 2 + 1]);
			if (s === 0) continue;
			const sg = s > 0 ? 1 : -1;
			if (sign && sg !== sign) return { error: 'curved surface with folded UVs' };
			sign = sg;
			uvArea += Math.abs(s) / 2;
		}
		if (!(uvArea > 0)) return { error: 'curved surface with flat UVs' };
		const k = Math.sqrt(chart.area / uvArea);
		for (const t of chart.tris) {
			for (let j = 0; j < 3; j++) {
				const vi = tris[t * 3 + j];
				coords[vi * 2] = uv0[vi * 2] * k * (sign < 0 ? -1 : 1);
				coords[vi * 2 + 1] = uv0[vi * 2 + 1] * k;
			}
		}
	}
	return { charts: final, coords };
}

/** @param {Chart} g @param {Float64Array} triN */
function planarize(g, triN) {
	const len = Math.hypot(g.nx, g.ny, g.nz);
	if (!(len > 0)) {
		g.planar = true; // degenerate: any projection
		g.nx = 0;
		g.ny = 0;
		g.nz = 1;
		return;
	}
	g.nx /= len;
	g.ny /= len;
	g.nz /= len;
	g.planar = g.tris.every((t) => {
		const d = triN[t * 3] * g.nx + triN[t * 3 + 1] * g.ny + triN[t * 3 + 2] * g.nz;
		return d >= PLANAR_MIN_DOT || (triN[t * 3] === 0 && triN[t * 3 + 1] === 0 && triN[t * 3 + 2] === 0);
	});
}

/** a deterministic tangent basis for a normal (no trig) @param {number} nx @param {number} ny @param {number} nz */
export function basisFor(nx, ny, nz) {
	// helper axis: X unless the normal is close to it
	let ax = 1, ay = 0, az = 0;
	if (Math.abs(nx) > 0.9) {
		ax = 0;
		ay = 1;
	}
	// u = normalize(a × n), v = n × u
	let ux = ay * nz - az * ny, uy = az * nx - ax * nz, uz = ax * ny - ay * nx;
	const ul = Math.hypot(ux, uy, uz) || 1;
	ux /= ul;
	uy /= ul;
	uz /= ul;
	const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
	return { u: [ux, uy, uz], v: [vx, vy, vz] };
}

/**
 * Shelf-pack rectangles (tallest first, ties by index — deterministic) into a strip of `width`.
 * @param {{w: number, h: number}[]} rects @param {number} width @param {number} pad gap around each
 * @returns {{ x: number[], y: number[], w: number, h: number }}
 */
export function shelfPack(rects, width, pad) {
	const order = rects.map((_, i) => i).sort((a, b) => rects[b].h - rects[a].h || a - b);
	const x = new Array(rects.length).fill(0);
	const y = new Array(rects.length).fill(0);
	let cx = pad, cy = pad, shelf = 0, usedW = 0;
	for (const i of order) {
		const r = rects[i];
		if (cx + r.w + pad > width && cx > pad) {
			cy += shelf + pad;
			cx = pad;
			shelf = 0;
		}
		x[i] = cx;
		y[i] = cy;
		cx += r.w + pad;
		if (r.h > shelf) shelf = r.h;
		if (cx > usedW) usedW = cx;
	}
	return { x, y, w: usedW, h: cy + shelf + pad };
}

/**
 * The auto-unwrap: charts, each laid flat and turned so its long side runs along x, packed into
 * a near-square with `pad` (object units) between charts. Local coords are object units.
 * @param {Float32Array | number[]} pos @param {Uint32Array} tris @param {Float32Array | number[] | null} uv0 @param {number} pad
 * @param {ReturnType<typeof buildCharts>} [built] reuse charts across pad iterations
 * @returns {Layout}
 */
export function autoUnwrap(pos, tris, uv0, pad, built) {
	const made = built ?? buildCharts(pos, tris, uv0);
	if ('error' in made) return { ok: false, reason: made.error };
	const { charts, coords } = made;
	const V = Math.floor(pos.length / 3);
	const local = new Float64Array(V * 2);
	/** @type {{w: number, h: number, minX: number, minY: number, turn: boolean}[]} */
	const boxes = [];
	let area = 0;
	for (const chart of charts) {
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const t of chart.tris) {
			for (let k = 0; k < 3; k++) {
				const vi = tris[t * 3 + k];
				const cx = coords[vi * 2], cy = coords[vi * 2 + 1];
				if (cx < minX) minX = cx;
				if (cx > maxX) maxX = cx;
				if (cy < minY) minY = cy;
				if (cy > maxY) maxY = cy;
			}
		}
		const w = maxX - minX, h = maxY - minY;
		boxes.push({ w: Math.max(w, h), h: Math.min(w, h), minX, minY, turn: h > w });
		area += chart.area;
	}
	let sum = 0;
	let widest = 0;
	for (const b of boxes) {
		sum += (b.w + pad) * (b.h + pad);
		if (b.w > widest) widest = b.w;
	}
	const width = Math.max(widest + 2 * pad, Math.sqrt(sum) * 1.1);
	const packed = shelfPack(boxes, width, pad);
	charts.forEach((chart, ci) => {
		const b = boxes[ci];
		for (const t of chart.tris) {
			for (let k = 0; k < 3; k++) {
				const vi = tris[t * 3 + k];
				const cx = coords[vi * 2] - b.minX, cy = coords[vi * 2 + 1] - b.minY;
				// turned charts: (x, y) -> (y, w - x) keeps orientation
				local[vi * 2] = packed.x[ci] + (b.turn ? cy : cx);
				local[vi * 2 + 1] = packed.y[ci] + (b.turn ? b.h - cx : cy);
			}
		}
	});
	return { ok: true, uv: Float32Array.from(local), w: packed.w, h: packed.h, charts: charts.length, area };
}

/**
 * An existing UV set as a layout: moved to the origin and scaled to object units so its texel
 * density matches the auto-unwrapped meshes beside it.
 * @param {Float32Array | number[]} pos @param {Uint32Array} tris @param {Float32Array | number[]} uv
 * @returns {Layout}
 */
export function layoutFromUv(pos, tris, uv) {
	const V = Math.floor(pos.length / 3);
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	let uvArea = 0, area = 0;
	const n = new Float64Array(4);
	for (let t = 0; t < tris.length / 3; t++) {
		const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
		for (const vi of [a, b, c]) {
			const x = uv[vi * 2], y = uv[vi * 2 + 1];
			if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: 'UVs are not numbers' };
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
		uvArea += Math.abs((uv[b * 2] - uv[a * 2]) * (uv[c * 2 + 1] - uv[a * 2 + 1]) - (uv[c * 2] - uv[a * 2]) * (uv[b * 2 + 1] - uv[a * 2 + 1])) / 2;
		area += triNormal(pos, a, b, c, n)[3];
	}
	if (!(uvArea > 0) || !(area > 0)) return { ok: false, reason: 'UVs are flat' };
	const k = Math.sqrt(area / uvArea);
	const local = new Float32Array(V * 2);
	for (let v = 0; v < V; v++) {
		local[v * 2] = (uv[v * 2] - minX) * k;
		local[v * 2 + 1] = (uv[v * 2 + 1] - minY) * k;
	}
	return { ok: true, uv: local, w: (maxX - minX) * k, h: (maxY - minY) * k, charts: 1, area };
}

/**
 * Visit every texel whose CENTRE lies inside a triangle of `uv` (texel units already: 0..side).
 * `visit(texel, tri, b0, b1, b2)` gets the barycentrics. Pure; the bake's sample builder and
 * the overlap check both walk triangles through here.
 * @param {ArrayLike<number>} uv per-vertex texel coords @param {Uint32Array} tris @param {number} sideX @param {number} sideY
 * @param {(texel: number, tri: number, b0: number, b1: number, b2: number) => void} visit
 */
export function rasterTriangles(uv, tris, sideX, sideY, visit) {
	for (let t = 0; t < tris.length / 3; t++) {
		let a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
		let det = (uv[b * 2] - uv[a * 2]) * (uv[c * 2 + 1] - uv[a * 2 + 1]) - (uv[c * 2] - uv[a * 2]) * (uv[b * 2 + 1] - uv[a * 2 + 1]);
		if (det === 0 || !Number.isFinite(det)) continue;
		// orient positively so the fill rule below means the same thing for every triangle
		let ib = 1, ic = 2;
		if (det < 0) {
			const s = b;
			b = c;
			c = s;
			det = -det;
			ib = 2;
			ic = 1;
		}
		const ax = uv[a * 2], ay = uv[a * 2 + 1], bx = uv[b * 2], by = uv[b * 2 + 1], cx = uv[c * 2], cy = uv[c * 2 + 1];
		const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(sideX - 1, Math.ceil(Math.max(ax, bx, cx)));
		const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(sideY - 1, Math.ceil(Math.max(ay, by, cy)));
		// TOP-LEFT RULE: a centre exactly on an edge belongs to ONE of the two triangles sharing
		// it (the shared edge runs opposite ways in each), so a clean layout covers every texel once
		const own = (/** @type {number} */ ex, /** @type {number} */ ey) => ey > 0 || (ey === 0 && ex < 0);
		const oA = own(cx - bx, cy - by), oB = own(ax - cx, ay - cy), oC = own(bx - ax, by - ay); // edge opposite each vertex
		const inv = 1 / det;
		for (let y = y0; y <= y1; y++) {
			const py = y + 0.5;
			for (let x = x0; x <= x1; x++) {
				const px = x + 0.5;
				const eA = (bx - px) * (cy - py) - (cx - px) * (by - py); // opposite a
				const eB = (cx - px) * (ay - py) - (ax - px) * (cy - py); // opposite b
				const eC = (ax - px) * (by - py) - (bx - px) * (ay - py); // opposite c
				if (eA < 0 || eB < 0 || eC < 0) continue;
				if ((eA === 0 && !oA) || (eB === 0 && !oB) || (eC === 0 && !oC)) continue;
				const w = [eA * inv, 0, 0];
				w[ib] = eB * inv;
				w[ic] = eC * inv;
				visit(y * sideX + x, t, w[0], w[1], w[2]);
			}
		}
	}
}

/**
 * How much of a layout lands on texels another triangle already took, at `texelsPerUnit`.
 * Center sampling gives each texel to one triangle of a clean layout, so a clean layout reads
 * ~0 and mirrored / tiled / stacked UVs read their real share. Capped at 1024² cells.
 * @param {Layout & {ok: true}} layout @param {Uint32Array} tris @param {number} texelsPerUnit
 * @returns {{ covered: number, overlapped: number, ratio: number }}
 */
export function overlapOf(layout, tris, texelsPerUnit) {
	let tpu = texelsPerUnit;
	const longest = Math.max(layout.w, layout.h) * tpu;
	if (longest > 1024) tpu *= 1024 / longest;
	const sx = Math.max(1, Math.ceil(layout.w * tpu) + 1), sy = Math.max(1, Math.ceil(layout.h * tpu) + 1);
	const scaled = new Float32Array(layout.uv.length);
	for (let i = 0; i < scaled.length; i++) scaled[i] = layout.uv[i] * tpu;
	const owner = new Int32Array(sx * sy).fill(-1);
	const twice = new Uint8Array(sx * sy);
	let covered = 0, overlapped = 0;
	rasterTriangles(scaled, tris, sx, sy, (texel, tri) => {
		const o = owner[texel];
		if (o < 0) {
			owner[texel] = tri;
			covered++;
		} else if (o !== tri && !twice[texel]) {
			twice[texel] = 1;
			overlapped++;
		}
	});
	return { covered, overlapped, ratio: covered ? overlapped / covered : 0 };
}

/**
 * Pick the lightmap layout for one mesh.
 * @param {{ pos: Float32Array | number[], index: ArrayLike<number> | null, uv0?: Float32Array | number[] | null, uv1?: Float32Array | number[] | null }} geo
 * @param {number} pad object units between charts @param {number} texelsPerUnit for the overlap check
 * @returns {{ src: 'uv1' | 'auto' | 'uv0', mode: 'full' | 'ao', layout: Layout & {ok: true}, overlap: number, reason?: string } | { error: string }}
 */
export function chooseUnwrap(geo, pad, texelsPerUnit) {
	const V = Math.floor(geo.pos.length / 3);
	const tris = triangleList(geo.index, V);
	if (!tris.length) return { error: 'no triangles' };
	/** @type {{src: 'uv1' | 'auto' | 'uv0', layout: Layout & {ok: true}, overlap: number}[]} */
	const tried = [];
	/** @type {string[]} */
	const reasons = [];
	/** @param {'uv1' | 'auto' | 'uv0'} src @param {Layout} layout */
	const consider = (src, layout) => {
		if (!layout.ok) {
			reasons.push(src + ': ' + layout.reason);
			return null;
		}
		const overlap = overlapOf(layout, tris, texelsPerUnit).ratio;
		const entry = { src, layout, overlap };
		tried.push(entry);
		return overlap <= CLEAN_OVERLAP ? entry : null;
	};
	const clean =
		(geo.uv1 ? consider('uv1', layoutFromUv(geo.pos, tris, geo.uv1)) : null) ??
		consider('auto', autoUnwrap(geo.pos, tris, geo.uv0 ?? null, pad)) ??
		(geo.uv0 ? consider('uv0', layoutFromUv(geo.pos, tris, geo.uv0)) : null);
	if (clean) return { src: clean.src, mode: 'full', layout: clean.layout, overlap: clean.overlap };
	if (!tried.length) return { error: reasons.join('; ') || 'no usable UVs' };
	const best = tried.reduce((a, b) => (b.overlap < a.overlap ? b : a));
	return { src: best.src, mode: 'ao', layout: best.layout, overlap: best.overlap, reason: 'overlapping UVs' };
}

/**
 * Rebuild a mesh's layout from what a bake record stored (`src`, `pad`) — the apply path on
 * every peer. Deterministic: the same geometry gives the same coordinates.
 * @param {{ pos: Float32Array | number[], index: ArrayLike<number> | null, uv0?: Float32Array | number[] | null, uv1?: Float32Array | number[] | null }} geo
 * @param {'uv1' | 'auto' | 'uv0'} src @param {number} pad @returns {Layout}
 */
export function rebuildLayout(geo, src, pad) {
	const V = Math.floor(geo.pos.length / 3);
	const tris = triangleList(geo.index, V);
	if (src === 'uv1') return geo.uv1 ? layoutFromUv(geo.pos, tris, geo.uv1) : { ok: false, reason: 'no uv1' };
	if (src === 'uv0') return geo.uv0 ? layoutFromUv(geo.pos, tris, geo.uv0) : { ok: false, reason: 'no uv0' };
	return autoUnwrap(geo.pos, tris, geo.uv0 ?? null, pad);
}

/**
 * Atlas UVs for a layout placed at (x, y) with `s` atlas units per object unit.
 * @param {Float32Array} local @param {number} x @param {number} y @param {number} s @returns {Float32Array}
 */
export function atlasUv(local, x, y, s) {
	const out = new Float32Array(local.length);
	for (let i = 0; i < local.length; i += 2) {
		out[i] = x + local[i] * s;
		out[i + 1] = y + local[i + 1] * s;
	}
	return out;
}
