// Roadmap 85b lane 85-world — the PURE half of the world tools (imports nothing; the unit layer runs it).
//
//   patternCanvas      L7: a procedural texture BY NAME (wood, brick, marble, tiles …) as a canvas spec for
//                      85-assist's generators (imageToolCore parseCanvas / drawCanvas): nothing new is drawn
//                      here, a preset is only a recipe of the ops add_image already takes
//   catmullClark       G9: create_shape {mesh, subdivide: 1-2} — real smoothing, on the polygon mesh the call
//                      gives (vertices + faces), before meshFromData splits it into triangles
//   scoreAsset         W1: search_assets ranking over library / pack / prefab / CC0 rows
//   parseSculptOps     W2: terrain {ops: [{op: raise|lower|smooth|flatten|paint, at, radius, strength}]}
//   scatterSetOf       W3: scatter's rules → one 51 seeded set (gen + masks)
//   sniffAudio         W6: a sound's bytes are believed, not its header
//   placementPoints    W1 / W7: count + spacing → a row of points

// ---------------------------------------------------------------- L7 procedural textures

/** the names patternCanvas knows, with the words the tool text says about them */
export const TEXTURE_PATTERNS = Object.freeze({
	wood: 'wood grain',
	planks: 'wooden planks with seams',
	brick: 'red brick in running bond',
	tiles: 'square tiles with grout',
	marble: 'white marble with veins',
	stone: 'cobbles / round stones',
	concrete: 'grey concrete',
	metal: 'brushed metal',
	grass: 'grass',
	sand: 'sand',
	fabric: 'woven fabric',
	checker: 'a checkerboard',
	stripes: 'stripes',
	noise: 'soft noise'
});

/** each pattern's default colours (dark first) */
const PATTERN_COLORS = /** @type {Record<string, string[]>} */ ({
	wood: ['#6b4423', '#9c6b3f'],
	planks: ['#6e4a2a', '#a8784a', '#3a2614'],
	brick: ['#8e3b2a', '#b5543a', '#cfc6b8'],
	tiles: ['#d9d4cc', '#f2efe9', '#9a948b'],
	marble: ['#c9c9cc', '#f7f6f2', '#8d8f96'],
	stone: ['#6f6a63', '#9b958c', '#3d3a36'],
	concrete: ['#86888a', '#a9abad'],
	metal: ['#8c9196', '#b7bcc1'],
	grass: ['#2f5d1f', '#5c9a33'],
	sand: ['#c9a96b', '#e6cf98'],
	fabric: ['#2f4a6b', '#46668f'],
	checker: ['#222222', '#eeeeee'],
	stripes: ['#223355', '#ddccaa'],
	noise: ['#333333', '#bbbbbb']
});

export const PATTERN_SIZES = Object.freeze([128, 256, 512, 1024]);

/** a small seeded generator (mulberry32): the same seed draws the same texture on every machine @param {number} seed */
function rand(seed) {
	let a = seed >>> 0 || 1;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** '#rrggbb' mixed toward '#rrggbb' by t (a colour jitter); anything else comes back as it was @param {string} a @param {string} b @param {number} t */
function mix(a, b, t) {
	const hex = (/** @type {string} */ c) => (/^#[0-9a-f]{6}$/i.test(c) ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : null);
	const x = hex(a);
	const y = hex(b);
	if (!x || !y) return a;
	return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

/** @param {any} v @param {number} d @param {number} lo @param {number} hi */
const clampNum = (v, d, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/**
 * A procedural texture as a canvas spec. `pattern` is a name of TEXTURE_PATTERNS or {name, colors, scale, seed,
 * size}; `scale` = how many repeats of the motif across the image (1 = the preset's own), `colors` replaces the
 * preset's (dark first; a missing one keeps the preset's). Every op is one add_image already draws, and every
 * motif is laid out so the texture TILES (noise wraps; rows and columns divide the edge).
 * @param {any} pattern @returns {{name: string, canvas: any} | {error: string}}
 */
export function patternCanvas(pattern) {
	const spec = typeof pattern === 'string' ? { name: pattern } : pattern && typeof pattern === 'object' && !Array.isArray(pattern) ? pattern : null;
	if (!spec) return { error: 'pattern: a name (' + Object.keys(TEXTURE_PATTERNS).join(', ') + ') or {name, colors, scale, seed, size}' };
	const name = String(spec.name ?? '').trim().toLowerCase();
	if (!(name in TEXTURE_PATTERNS)) return { error: 'pattern: unknown "' + name.slice(0, 30) + '" — one of ' + Object.keys(TEXTURE_PATTERNS).join(', ') };
	const base = PATTERN_COLORS[name];
	if (spec.colors !== undefined && (!Array.isArray(spec.colors) || spec.colors.length > base.length || !spec.colors.every((/** @type {any} */ c) => typeof c === 'string' && /^#?[0-9a-f]{6}$/i.test(c.trim()))))
		return { error: 'pattern.colors: up to ' + base.length + ' hex colours for ' + name + ' (dark first), e.g. ["' + base.join('", "') + '"]' };
	const c = base.map((d, i) => (spec.colors?.[i] ? '#' + spec.colors[i].trim().replace(/^#/, '').toLowerCase() : d));
	const size = PATTERN_SIZES.includes(spec.size) ? spec.size : 512;
	const scale = clampNum(spec.scale, 1, 0.25, 8);
	const seed = Math.floor(clampNum(spec.seed, 1, 0, 2 ** 31));
	const r = rand(seed * 7919 + 17);
	const W = size;
	const H = size;
	/** @type {any[]} */
	const ops = [];
	const n = (/** @type {number} */ k) => Math.max(1, Math.round(k * scale));
	const fine = (/** @type {number} */ k, /** @type {number} */ opacity, /** @type {string[]} */ cols, octaves = 4) =>
		ops.push({ op: 'noise', scale: Math.min(256, n(k)), octaves, seed: seed + ops.length, opacity, colors: cols });
	let background = c[0];
	switch (name) {
		case 'wood':
			ops.push({ op: 'stripes', count: n(18), vertical: true, colors: [c[0], c[1]] });
			fine(3, 0.45, [c[0], c[1]], 5);
			fine(48, 0.18, [mix(c[0], '#000000', 0.3), c[1]], 2);
			break;
		case 'planks': {
			const rows = n(6);
			const h = H / rows;
			ops.push({ op: 'stripes', count: n(30), vertical: true, colors: [c[0], c[1]] });
			fine(4, 0.4, [c[0], c[1]], 5);
			for (let i = 0; i < rows; i++) {
				ops.push({ op: 'rect', x: 0, y: Math.round(i * h), w: W, h: Math.max(1, Math.round(size / 256)), fill: c[2] });
				const x = Math.round(r() * W);
				ops.push({ op: 'rect', x, y: Math.round(i * h), w: Math.max(1, Math.round(size / 256)), h: Math.round(h), fill: c[2] });
			}
			break;
		}
		case 'brick': {
			background = c[2];
			const rows = n(8) * 2 > 64 ? 64 : n(8) * 2 > 1 ? n(8) * 2 : 2;
			const cols = Math.max(2, Math.round(rows / 2));
			const bh = H / rows;
			const bw = W / cols;
			const gap = Math.max(1, Math.round(size / 128));
			for (let y = 0; y < rows && ops.length < 440; y++) {
				const shift = y % 2 ? bw / 2 : 0;
				for (let x = -1; x < cols; x++) {
					const x0 = x * bw + shift;
					if (x0 + bw <= 0) continue;
					ops.push({ op: 'rect', x: Math.round(x0 + gap / 2), y: Math.round(y * bh + gap / 2), w: Math.round(bw - gap), h: Math.round(bh - gap), fill: mix(c[0], c[1], r()) });
				}
			}
			fine(16, 0.22, ['#000000', '#ffffff'], 3);
			break;
		}
		case 'tiles': {
			background = c[2];
			const k = Math.min(32, n(4));
			const t = W / k;
			const gap = Math.max(1, Math.round(size / 96));
			for (let y = 0; y < k; y++)
				for (let x = 0; x < k; x++) ops.push({ op: 'rect', x: Math.round(x * t + gap / 2), y: Math.round(y * t + gap / 2), w: Math.round(t - gap), h: Math.round(t - gap), fill: mix(c[0], c[1], r() * 0.6 + 0.2) });
			fine(24, 0.12, ['#000000', '#ffffff'], 2);
			break;
		}
		case 'marble': {
			background = c[1];
			fine(2, 0.55, [c[0], c[1]], 6);
			const veins = Math.min(14, n(5));
			for (let v = 0; v < veins; v++) {
				let x = r() * W;
				let y = 0;
				const step = H / 24;
				/** @type {number[][]} */
				const pts = [];
				for (let i = 0; i <= 24; i++, y += step) {
					pts.push([Math.round(x), Math.round(y)]);
					x += (r() - 0.5) * W * 0.12;
				}
				ops.push({ op: 'line', points: pts, stroke: c[2], lineWidth: Math.max(1, (size / 512) * (0.6 + r() * 1.6)) });
			}
			break;
		}
		case 'stone': {
			background = c[2];
			const k = Math.min(16, n(6));
			const t = W / k;
			for (let y = 0; y < k; y++)
				for (let x = 0; x < k; x++)
					ops.push({ op: 'circle', x: Math.round(x * t + t / 2 + (r() - 0.5) * t * 0.2), y: Math.round(y * t + t / 2 + (r() - 0.5) * t * 0.2), r: Math.max(1, Math.round(t * (0.38 + r() * 0.1))), fill: mix(c[0], c[1], r()) });
			fine(20, 0.25, ['#000000', '#ffffff'], 3);
			break;
		}
		case 'concrete':
			fine(6, 1, [c[0], c[1]], 5);
			fine(64, 0.3, [mix(c[0], '#000000', 0.2), mix(c[1], '#ffffff', 0.2)], 2);
			break;
		case 'metal':
			ops.push({ op: 'stripes', count: Math.min(512, n(160)), vertical: false, colors: [c[0], c[1]] });
			fine(64, 0.15, [c[0], c[1]], 2);
			break;
		case 'grass':
			fine(8, 1, [c[0], c[1]], 5);
			fine(96, 0.35, [mix(c[0], '#000000', 0.3), mix(c[1], '#ffffff', 0.15)], 2);
			break;
		case 'sand':
			fine(5, 1, [c[0], c[1]], 4);
			fine(128, 0.3, [mix(c[0], '#000000', 0.15), mix(c[1], '#ffffff', 0.2)], 1);
			break;
		case 'fabric':
			ops.push({ op: 'checker', cols: Math.min(512, n(64)), rows: Math.min(512, n(64)), colors: [c[0], c[1]] });
			fine(32, 0.2, ['#000000', '#ffffff'], 2);
			break;
		case 'checker':
			ops.push({ op: 'checker', cols: Math.min(512, n(8)), rows: Math.min(512, n(8)), colors: [c[0], c[1]] });
			break;
		case 'stripes':
			ops.push({ op: 'stripes', count: Math.min(512, n(8)), vertical: spec.vertical === true, colors: [c[0], c[1]] });
			break;
		case 'noise':
			fine(8, 1, [c[0], c[1]], 4);
			break;
	}
	return { name, canvas: { width: W, height: H, background, ops } };
}

// ---------------------------------------------------------------- G9 Catmull-Clark subdivision

/**
 * Catmull-Clark on a polygon mesh: every face → one quad per corner, face / edge / vertex points by the usual
 * rules, so a cube of six quads comes out a rounded box and a level more nearly a sphere. Open borders keep their
 * shape (the crease rule: an edge point is the midpoint, a border vertex (6v + its two border neighbours) / 8).
 * uvs and colors (per vertex) are carried by the SAME averages as the positions use for face and edge points and
 * kept at the old vertices (a texture does not slide); faceMaterials go to every child of a face.
 * @param {{vertices: number[][], faces: number[][], uvs?: number[][], colors?: number[][], faceMaterials?: number[]}} mesh
 * @param {number} levels 1 or 2
 * @returns {{vertices: number[][], faces: number[][], uvs?: number[][], colors?: number[][], faceMaterials?: number[]}}
 */
export function catmullClark(mesh, levels) {
	let cur = mesh;
	for (let l = 0; l < levels; l++) cur = ccOnce(cur);
	return cur;
}

/** @param {{vertices: number[][], faces: number[][], uvs?: number[][], colors?: number[][], faceMaterials?: number[]}} m */
function ccOnce(m) {
	const V = m.vertices;
	const attrs = /** @type {('uvs'|'colors')[]} */ (['uvs', 'colors']).filter((k) => Array.isArray(m[k]));
	/** @param {number[][]} list @returns {number[]} */
	const avg = (list) => list[0].map((_, i) => list.reduce((s, p) => s + p[i], 0) / list.length);
	/** per vertex: positions + each carried attribute, as one row of arrays */
	const row = (/** @type {number} */ i) => [V[i], ...attrs.map((k) => /** @type {number[][]} */ (m[k])[i])];
	/** @param {number[][][]} rows */
	const avgRows = (rows) => rows[0].map((_, a) => avg(rows.map((r) => r[a])));
	const facePts = m.faces.map((f) => avgRows(f.map(row)));
	/** edge key → {a, b, faces[]} */
	const edges = new Map();
	const key = (/** @type {number} */ a, /** @type {number} */ b) => (a < b ? a + '_' + b : b + '_' + a);
	m.faces.forEach((f, fi) => {
		for (let k = 0; k < f.length; k++) {
			const a = f[k];
			const b = f[(k + 1) % f.length];
			const id = key(a, b);
			const e = edges.get(id) ?? { a: Math.min(a, b), b: Math.max(a, b), faces: [] };
			e.faces.push(fi);
			edges.set(id, e);
		}
	});
	/** @type {number[][][]} the new points, as rows (position + attributes) */
	const out = [];
	/** vertex i → new index */
	const vIndex = new Map();
	/** edge key → new index */
	const eIndex = new Map();
	/** face index → new index */
	const fIndex = facePts.map((p) => out.push(p) - 1);
	for (const [id, e] of edges) {
		const ends = [row(e.a), row(e.b)];
		// the position takes the faces' points too (smoothing); attributes stay on the edge (no sliding)
		const mid = avgRows(ends);
		if (e.faces.length === 2) mid[0] = avg([V[e.a], V[e.b], facePts[e.faces[0]][0], facePts[e.faces[1]][0]]);
		eIndex.set(id, out.push(mid) - 1);
	}
	/** per vertex: its faces and edges */
	const vFaces = V.map(() => /** @type {number[]} */ ([]));
	const vEdges = V.map(() => /** @type {any[]} */ ([]));
	m.faces.forEach((f, fi) => f.forEach((v) => vFaces[v].push(fi)));
	for (const e of edges.values()) {
		vEdges[e.a].push(e);
		vEdges[e.b].push(e);
	}
	for (let i = 0; i < V.length; i++) {
		if (!vFaces[i].length) continue; // a vertex no face uses is dropped
		const r = row(i);
		const border = vEdges[i].filter((e) => e.faces.length === 1);
		/** @type {number[]} */
		let p;
		if (border.length >= 2) {
			// the crease rule: a border vertex follows its two border neighbours only
			const nb = border.slice(0, 2).map((e) => V[e.a === i ? e.b : e.a]);
			p = V[i].map((x, k) => (6 * x + nb[0][k] + nb[1][k]) / 8);
		} else {
			const n = vFaces[i].length;
			const F = avg(vFaces[i].map((fi) => facePts[fi][0]));
			const R = avg(vEdges[i].map((e) => avg([V[e.a], V[e.b]])));
			p = V[i].map((x, k) => (F[k] + 2 * R[k] + (n - 3) * x) / n);
		}
		vIndex.set(i, out.push([p, ...r.slice(1)]) - 1);
	}
	/** @type {number[][]} */
	const faces = [];
	/** @type {number[]} */
	const faceMaterials = [];
	m.faces.forEach((f, fi) => {
		for (let k = 0; k < f.length; k++) {
			const v = f[k];
			const next = f[(k + 1) % f.length];
			const prev = f[(k - 1 + f.length) % f.length];
			// the same winding as the source face: corner, edge to next, centre, edge from prev
			faces.push([vIndex.get(v), eIndex.get(key(v, next)), fIndex[fi], eIndex.get(key(prev, v))]);
			if (m.faceMaterials) faceMaterials.push(m.faceMaterials[fi]);
		}
	});
	/** @type {any} */
	const res = { vertices: out.map((p) => p[0]), faces };
	attrs.forEach((k, a) => (res[k] = out.map((p) => p[a + 1])));
	if (m.faceMaterials) res.faceMaterials = faceMaterials;
	return res;
}

/** how many vertices / faces a subdivision makes, BEFORE doing it (the cap is checked first) @param {{vertices: any[], faces: number[][]}} m @param {number} levels */
export function subdivisionSize(m, levels) {
	let v = m.vertices.length;
	let corners = m.faces.reduce((s, f) => s + f.length, 0);
	let f = m.faces.length;
	for (let l = 0; l < levels; l++) {
		const e = corners / 2; // a closed mesh; an open one has a little more — an upper bound either way is fine
		v = v + Math.ceil(e) + f;
		f = corners;
		corners = f * 4;
	}
	return { vertices: v, faces: f };
}

// ---------------------------------------------------------------- W1 asset search

export const ASSET_KINDS = Object.freeze(['model', 'material', 'hdri', 'sound', 'image', 'prefab']);

/** the words of a query (lower case, at most 8) @param {any} q */
export function queryWords(q) {
	return String(q ?? '')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length > 1)
		.slice(0, 8);
}

/**
 * How well a row matches: every word must appear in its name or tags (a word in the name counts more), else 0.
 * An empty query lists everything at 1. @param {{name: string, tags?: string[]}} row @param {string[]} words
 */
export function scoreAsset(row, words) {
	if (!words.length) return 1;
	const name = String(row.name ?? '').toLowerCase();
	const tags = (row.tags ?? []).map((t) => String(t).toLowerCase()).join(' ');
	let score = 0;
	for (const w of words) {
		if (name === w) score += 6;
		else if (new RegExp('\\b' + w).test(name)) score += 4;
		else if (name.includes(w)) score += 2;
		else if (tags.includes(w)) score += 1;
		else return 0;
	}
	return score;
}

/**
 * An asset id of search_assets → its parts: `lib:<hash>`, `pack:<pack>/<item>`, `prefab:<id>`, `cc0:<source>/<id>`.
 * @param {any} id @returns {{source: 'lib'|'pack'|'prefab'|'cc0', ref: string, item?: string} | {error: string}}
 */
export function parseAssetId(id) {
	const s = typeof id === 'string' ? id.trim() : '';
	const m = /^(lib|pack|prefab|cc0):(.{1,300})$/.exec(s);
	if (!m) return { error: 'asset: an id from search_assets ("lib:…", "pack:…/…", "prefab:…", "cc0:…")' };
	const source = /** @type {'lib'|'pack'|'prefab'|'cc0'} */ (m[1]);
	if (source === 'pack' || source === 'cc0') {
		const at = m[2].indexOf('/');
		if (at < 1 || at === m[2].length - 1) return { error: 'asset: "' + source + ':<' + (source === 'pack' ? 'pack' : 'source') + '>/<item>"' };
		return { source, ref: m[2].slice(0, at), item: m[2].slice(at + 1) };
	}
	return { source, ref: m[2] };
}

// ---------------------------------------------------------------- W2 terrain sculpt ops

export const SCULPT_OPS = Object.freeze(['raise', 'lower', 'smooth', 'flatten', 'paint']);
export const MAX_SCULPT_OPS = 64;

/**
 * terrain's `ops`: each {op, at: [x, z] (terrain-local metres, the centre is 0, 0), radius, strength, layer (paint),
 * passes}. Raise / lower move by `height` metres at the centre when given (else strength), smooth / flatten pull
 * toward their neighbours / the centre's height.
 * @param {any} ops @param {number} size the terrain's edge length (metres) @returns {{ops: any[]} | {error: string}}
 */
export function parseSculptOps(ops, size) {
	if (ops === undefined) return { ops: [] };
	if (!Array.isArray(ops) || ops.length > MAX_SCULPT_OPS) return { error: 'ops: a list of up to ' + MAX_SCULPT_OPS + ' {op, at: [x, z], radius}' };
	const half = size / 2;
	/** @type {any[]} */
	const out = [];
	for (let i = 0; i < ops.length; i++) {
		const o = ops[i];
		const at = 'ops[' + i + ']';
		if (!o || typeof o !== 'object' || !SCULPT_OPS.includes(o.op)) return { error: at + '.op: one of ' + SCULPT_OPS.join(', ') };
		const p = o.at ?? o.position;
		const xz = Array.isArray(p) && p.length === 2 ? p : Array.isArray(p) && p.length === 3 ? [p[0], p[2]] : null;
		if (!xz || !xz.every((/** @type {any} */ v) => typeof v === 'number' && Number.isFinite(v))) return { error: at + '.at: [x, z] on the terrain (metres from its centre)' };
		if (Math.abs(xz[0]) > half * 1.5 || Math.abs(xz[1]) > half * 1.5) return { error: at + '.at: [' + xz.join(', ') + '] is off a terrain ' + size + ' m wide (its centre is [0, 0])' };
		const radius = clampNum(o.radius, Math.max(1, size / 8), 0.1, size);
		const strength = clampNum(o.strength, 0.5, 0, 1);
		/** @type {any} */
		const op = { op: o.op, x: xz[0], z: xz[1], radius, strength };
		if (o.op === 'raise' || o.op === 'lower') {
			if (o.height !== undefined) {
				if (typeof o.height !== 'number' || !Number.isFinite(o.height) || o.height <= 0 || o.height > 100) return { error: at + '.height: metres at the centre, above 0 and at most 100' };
				op.height = o.height;
			}
		} else if (o.op === 'paint') {
			const layer = o.layer;
			if (!Number.isInteger(layer) || layer < 0 || layer > 3) return { error: at + '.layer: the paint layer 0-3 (terrain layers)' };
			op.layer = layer;
		}
		op.passes = Math.floor(clampNum(o.passes, 1, 1, 20));
		out.push(op);
	}
	return { ops: out };
}

/** how many 1/60 s brush steps raise / lower a column by `height` metres at full weight (applyBrushAt moves strength × 8 × dt) @param {number} height @param {number} strength */
export function stepsForHeight(height, strength) {
	const per = Math.max(0.01, strength) * 8 * (1 / 60);
	return Math.min(4000, Math.max(1, Math.round(height / per)));
}

// ---------------------------------------------------------------- W3 scatter rules

/**
 * scatter's arguments → one 51 seeded set ({gen, seed, source(s), tint, sink}). `asset` is a primitive name, a
 * `lib:<hash>` model or a `pack:` id resolved by the caller into a source; `rules` holds the masks.
 * @param {any} args @param {any[]} sources resolved 51 sources (1..8) @returns {{set: any} | {error: string}}
 */
export function scatterSetOf(args, sources) {
	if (!sources.length) return { error: 'asset: what to scatter' };
	const density = args.density;
	const count = args.count;
	if (density !== undefined && count !== undefined) return { error: 'give density (per m²) or count, not both' };
	/** @type {any} */
	const gen = { rot: args.randomRotation !== false };
	if (count !== undefined) {
		if (!Number.isInteger(count) || count < 1 || count > 8000) return { error: 'count: 1-8000 instances' };
		gen.count = count;
	} else {
		const d = density ?? 0.2;
		if (typeof d !== 'number' || !Number.isFinite(d) || d < 0.01 || d > 4) return { error: 'density: 0.01-4 per square metre' };
		gen.density = d;
	}
	const sc = args.scale ?? [0.8, 1.2];
	const range = typeof sc === 'number' ? [sc, sc] : sc;
	if (!Array.isArray(range) || range.length !== 2 || !range.every((v) => typeof v === 'number' && v >= 0.05 && v <= 20) || range[0] > range[1])
		return { error: 'scale: [min, max] factors 0.05-20 (or one number)' };
	gen.scaleMin = range[0];
	gen.scaleMax = range[1];
	if (args.spacing !== undefined) {
		if (typeof args.spacing !== 'number' || args.spacing < 0 || args.spacing > 50) return { error: 'spacing: metres 0-50 between instances' };
		gen.spacing = args.spacing;
	}
	const rules = args.rules ?? {};
	if (typeof rules !== 'object' || Array.isArray(rules)) return { error: 'rules: {slope: [min°, max°], height: [min, max], layer: {i, min}, avoid: [...]}' };
	// rules.avoid is read by the tool (it needs the scene); mcp-diorama2 (23)
	for (const k of Object.keys(rules)) if (!['slope', 'height', 'layer', 'avoid'].includes(k)) return { error: 'rules.' + k + ': not a rule — slope, height, layer or avoid' };
	const pair = (/** @type {any} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && n >= lo && n <= hi) && v[0] <= v[1];
	if (rules.slope !== undefined) {
		if (!pair(rules.slope, 0, 180)) return { error: 'rules.slope: [min, max] degrees from flat (0 = level ground, 90 = a wall)' };
		gen.slope = rules.slope;
	}
	if (rules.height !== undefined) {
		if (!pair(rules.height, -1e5, 1e5)) return { error: 'rules.height: [min, max] metres (the surface\'s own height)' };
		gen.height = rules.height;
	}
	if (rules.layer !== undefined) {
		const l = rules.layer;
		if (!l || !Number.isInteger(l.i) || l.i < 0 || l.i > 3) return { error: 'rules.layer: {i: paint layer 0-3, min: 0-1}' };
		gen.layer = { i: l.i, min: clampNum(l.min, 0.5, 0, 1) };
	}
	/** @type {any} */
	const set = { gen, seed: Number.isInteger(args.seed) ? args.seed >>> 0 : undefined, source: sources[0] };
	if (set.seed === undefined) delete set.seed;
	if (sources.length > 1) set.sources = sources.map((source) => ({ source, w: 1 }));
	if (args.tint !== undefined) {
		if (typeof args.tint !== 'number' || args.tint < 0 || args.tint > 1) return { error: 'tint: 0-1 colour variation' };
		set.tint = args.tint;
	}
	if (args.sink !== undefined) {
		if (typeof args.sink !== 'number' || args.sink < -2 || args.sink > 5) return { error: 'sink: metres -2..5 pushed into the ground' };
		set.sink = args.sink;
	}
	if (args.collider !== undefined) {
		if (!['none', 'box', 'sphere', 'hull'].includes(args.collider)) return { error: 'collider: none, box, sphere or hull' };
		set.collider = args.collider;
	}
	return { set };
}

// ---------------------------------------------------------------- W6 audio

export const AUDIO_MAX_BYTES = 16 * 1024 * 1024;

/** what audio bytes ARE (never what a header or a name says) @param {Uint8Array} b @returns {{mime: string, ext: string} | null} */
export function sniffAudio(b) {
	const at = (/** @type {number} */ i, /** @type {string} */ s) => [...s].every((ch, k) => b[i + k] === ch.charCodeAt(0));
	if (b.length < 12) return null;
	if (at(0, 'RIFF') && at(8, 'WAVE')) return { mime: 'audio/wav', ext: 'wav' };
	if (at(0, 'OggS')) return { mime: 'audio/ogg', ext: 'ogg' };
	if (at(0, 'fLaC')) return { mime: 'audio/flac', ext: 'flac' };
	if (at(0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { mime: 'audio/mpeg', ext: 'mp3' };
	if (at(4, 'ftyp')) return { mime: 'audio/mp4', ext: 'm4a' };
	if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: 'audio/webm', ext: 'webm' };
	return null;
}

/**
 * mcp-diorama2 (24a, owner): a zip pack's SOUNDS as search rows, from the manifest.json beside its zip on the CDN —
 * so an agent finds "fire crackle" before anyone installed the pack. The id `pack:<name>/<file>` is what
 * place_sound / set_music take; only a file the manifest lists is ever fetched (no path from an agent reaches a URL).
 * @param {any} manifest @param {{name: string, title?: string, license?: string}} pack
 * @returns {{id: string, name: string, kind: 'sound', source: string, licence: string, credit?: string, tags: string[]}[]}
 */
export function packSoundRows(manifest, pack) {
	const items = Array.isArray(manifest?.items) ? manifest.items : [];
	return items
		.filter((/** @type {any} */ it) => typeof it?.file === 'string' && SOUND_FILE.test(it.file) && safePackFile(it.file))
		.map((/** @type {any} */ it) => ({
			id: 'pack:' + pack.name + '/' + it.file,
			name: String(it.name || it.file.split('/').pop()).slice(0, 120),
			kind: /** @type {'sound'} */ ('sound'),
			source: 'pack ' + (pack.title || pack.name),
			licence: String(it.license || manifest.license || pack.license || 'see the pack'),
			...(it.author ? { credit: String(it.author).slice(0, 120) } : {}),
			tags: [it.file, pack.name, String(pack.title ?? ''), ...String(it.name ?? '').split(/\s+/), /loop/i.test(it.file) ? 'loop ambience ambient' : '']
		}));
}

/** a sound file a pack may hold @type {RegExp} */
export const SOUND_FILE = /\.(ogg|wav|mp3|flac|m4a|webm)$/i;

/** a manifest file path we will put after the pack's base URL: relative, no `..`, no scheme @param {string} file */
export function safePackFile(file) {
	return typeof file === 'string' && file.length <= 200 && !/^[a-z]+:|^\/|\\|(^|\/)\.\.(\/|$)/i.test(file);
}

/** `pack:<name>/<file>` → its parts, or null @param {string} id */
export function parsePackSoundId(id) {
	const m = /^pack:([a-z0-9][a-z0-9_-]{0,63})\/(.+)$/i.exec(String(id ?? ''));
	if (!m || !SOUND_FILE.test(m[2]) || !safePackFile(m[2])) return null;
	return { pack: m[1], file: m[2] };
}

/** the flow node a sound's `on` names → its catalog type */
export const SOUND_TRIGGERS = Object.freeze({ click: 'onclick', enter: 'onenter', exit: 'onexit', grab: 'ongrab', hit: 'onhit' });

// ---------------------------------------------------------------- placement

/**
 * count copies from a point, `spacing` apart along +X turned by `yaw` (radians), centred on the point.
 * @param {number[]} at [x, y, z] @param {number} count @param {number} spacing @param {number} yaw @returns {number[][]}
 */
export function placementPoints(at, count, spacing, yaw = 0) {
	const out = [];
	const dx = Math.cos(yaw) * spacing;
	const dz = -Math.sin(yaw) * spacing;
	for (let i = 0; i < count; i++) {
		const k = i - (count - 1) / 2;
		out.push([at[0] + dx * k, at[1], at[2] + dz * k]);
	}
	return out;
}

/**
 * mcp-diorama2 (22): a terrain's paint BY HEIGHT — the splat that puts layer 0 in the low ground and the last given
 * layer on the peaks (sand → grass → rock → snow), soft across each band edge. Pure: the terrain's LOCAL vertex
 * positions + its bounds in, RGBA splat bytes out (each texel's four weights sum to 255, the terrainPaintCore rule).
 * Heights are read off the vertex grid by nearest-cell binning, then sampled bilinearly per texel.
 * @param {ArrayLike<number>} positions xyz triples @param {{minX: number, minZ: number, sizeX: number, sizeZ: number}} b
 * @param {number} res splat texels per side @param {number} layers 2..4 @returns {Uint8Array}
 */
export function heightSplat(positions, b, res, layers) {
	const n = Math.max(2, Math.min(4, layers | 0));
	const count = Math.floor(positions.length / 3);
	const seg = Math.max(1, Math.round(Math.sqrt(count)) - 1);
	const grid = new Float32Array((seg + 1) * (seg + 1)).fill(NaN);
	let lo = Infinity;
	let hi = -Infinity;
	for (let i = 0; i < count; i++) {
		const x = positions[i * 3];
		const y = positions[i * 3 + 1];
		const z = positions[i * 3 + 2];
		const c = Math.min(seg, Math.max(0, Math.round(((x - b.minX) / b.sizeX) * seg)));
		const r = Math.min(seg, Math.max(0, Math.round(((z - b.minZ) / b.sizeZ) * seg)));
		const k = r * (seg + 1) + c;
		grid[k] = Number.isNaN(grid[k]) ? y : Math.max(grid[k], y);
		if (y < lo) lo = y;
		if (y > hi) hi = y;
	}
	for (let k = 0; k < grid.length; k++) if (Number.isNaN(grid[k])) grid[k] = lo;
	const span = hi - lo > 1e-6 ? hi - lo : 1;
	const at = (/** @type {number} */ c, /** @type {number} */ r) => grid[Math.min(seg, r) * (seg + 1) + Math.min(seg, c)];
	const edge = 0.25 / n;
	const bytes = new Uint8Array(res * res * 4);
	const w = [0, 0, 0, 0];
	for (let j = 0; j < res; j++) {
		for (let i = 0; i < res; i++) {
			const gx = ((i + 0.5) / res) * seg;
			const gz = ((j + 0.5) / res) * seg;
			const c0 = Math.floor(gx);
			const r0 = Math.floor(gz);
			const fx = gx - c0;
			const fz = gz - r0;
			const h = (at(c0, r0) * (1 - fx) + at(c0 + 1, r0) * fx) * (1 - fz) + (at(c0, r0 + 1) * (1 - fx) + at(c0 + 1, r0 + 1) * fx) * fz;
			const t = hi - lo > 1e-6 ? (h - lo) / span : 0;
			let sum = 0;
			for (let k = 0; k < 4; k++) {
				if (k >= n) {
					w[k] = 0;
					continue;
				}
				const bandLo = k === 0 ? -Infinity : k / n;
				const bandHi = k === n - 1 ? Infinity : (k + 1) / n;
				const d = Math.max(bandLo - t, t - bandHi, 0);
				w[k] = Math.max(0, 1 - d / edge);
				sum += w[k];
			}
			const o = (j * res + i) * 4;
			let given = 0;
			let top = 0;
			for (let k = 0; k < 4; k++) {
				bytes[o + k] = Math.round((w[k] / sum) * 255);
				given += bytes[o + k];
				if (w[k] > w[top]) top = k;
			}
			bytes[o + top] += 255 - given; // the rounding goes to the strongest layer, so every texel sums to 255
		}
	}
	return bytes;
}
