#!/usr/bin/env node
// Scenario 3D Collection — T1 GENERATOR BENCHMARK, headless (no browser, no GPU).
//
//   node tools/bench/wild-assets.mjs [--out <dir>] [--set benchmark|top|all] [--groups 20]
//        [--index <index.json>] [--data <dataset repo>] [--state <state.json>] [--verify] [--limit N]
//
// For every GLB in the set it measures what the app's import pipeline will measure (the SAME units as
// importBudget.modelCost: one draw per primitive per node instance, textures once per image), plus
// what a person tuning a generator wants to know: PBR maps present, texture formats and sizes, nodes,
// skins / clips, bounds + scale class + an up-axis guess, and the mesh's topology health (degenerate
// triangles, open and non-manifold edges after welding by position).
//
// THE SET: the owner's "Benchmark" tags in the tag browser's state.json; with none, the input groups
// (one input image, many generators) with the most distinct generators, every member of each.
// THE UP-AXIS GUESS needs no semantics: a group is one object, so its members should share
// proportions; a member whose box is the group's consensus box with Y and Z swapped was exported
// Z-up (modelSanity's own Z-up rule, against the consensus instead of the replaced model).
//
// Output: bench.json (one row per asset + the run's facts) and bench.md (a table per generator family:
// median and p90 of each measure) in --out. The data is CC BY 4.0, "Scenario"; nothing is copied.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { NodeIO, ImageUtils } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/core';
import { MeshoptDecoder } from 'meshoptimizer';
import { sanityIssues } from '../../src/lib/modelSanity.js';
import {
	familyOf, glbOutputs, groupsOf, sniffMime, round4, scaleClass, requestedFaces, budgetClass, settingsLabel,
	median, quantile, upAxisGuesses, taggedWith, groupMap, topGroups, pickFixtures
} from './wildCore.mjs';

const HOME = os.homedir();
const argv = process.argv.slice(2);
const val = (/** @type {string} */ name, /** @type {string} */ dflt) => {
	const i = argv.indexOf('--' + name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const flag = (/** @type {string} */ name) => argv.includes('--' + name);

export const DEFAULTS = {
	index: path.join(HOME, '.local/share/scenario-browser/public/index.json'),
	state: path.join(HOME, '.local/share/scenario-browser/state.json'),
	data: [process.env.WILD_ASSETS_DIR, path.join(HOME, '.local/share/datasets/scenario-3d-collection/repo'), path.join(HOME, '.cache/tp-wild/assets')]
};


/** the first data root that holds `rel` @param {string[]} roots @param {string} rel */
export function locate(roots, rel) {
	for (const r of roots) if (r && fs.existsSync(path.join(r, rel))) return path.join(r, rel);
	return null;
}

/** @param {string} file */
export function sha256File(file) {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---- the measures ---------------------------------------------------------------------------

const MODE = { POINTS: 0, LINES: 1, LINE_LOOP: 2, LINE_STRIP: 3, TRIANGLES: 4, TRIANGLE_STRIP: 5, TRIANGLE_FAN: 6 };

/** triangles a primitive draws @param {any} prim */
function primTriangles(prim) {
	const n = prim.getIndices()?.getCount() ?? prim.getAttribute('POSITION')?.getCount() ?? 0;
	const mode = prim.getMode();
	if (mode === MODE.TRIANGLES) return Math.floor(n / 3);
	if (mode === MODE.TRIANGLE_STRIP || mode === MODE.TRIANGLE_FAN) return Math.max(0, n - 2);
	return 0;
}

/**
 * Degenerate triangles + open / non-manifold edges of one TRIANGLES primitive, after welding
 * vertices that share a position (a generator splits vertices on every UV seam, which is not a
 * hole). Null for a primitive too large to check here or not a triangle list.
 * @param {any} prim @param {number} cap
 */
function topology(prim, cap) {
	if (prim.getMode() !== MODE.TRIANGLES) return null;
	const pos = prim.getAttribute('POSITION');
	if (!pos) return null;
	const count = pos.getCount();
	const indices = prim.getIndices()?.getArray() ?? null;
	const nIdx = indices ? indices.length : count;
	if (nIdx / 3 > cap) return null;
	// weld by exact position (Float32 bits), the id is the first vertex seen there
	const arr = /** @type {Float32Array} */ (pos.getArray());
	const norm = pos.getNormalized() || !(arr instanceof Float32Array);
	const src = norm ? Float32Array.from({ length: count * 3 }, (_, i) => pos.getElement(Math.floor(i / 3), [0, 0, 0])[i % 3]) : arr;
	const bits = new Uint32Array(src.buffer, src.byteOffset, count * 3);
	/** @type {Map<string, number>} */
	const ids = new Map();
	const weld = new Uint32Array(count);
	for (let v = 0; v < count; v++) {
		const k = bits[v * 3] + ',' + bits[v * 3 + 1] + ',' + bits[v * 3 + 2];
		let id = ids.get(k);
		if (id === undefined) ids.set(k, (id = ids.size));
		weld[v] = id;
	}
	const tri = nIdx / 3;
	const keys = new Float64Array(tri * 3);
	let nKeys = 0;
	let degenerate = 0;
	const at = (/** @type {number} */ i) => weld[indices ? indices[i] : i];
	const p = [0, 0, 0].map(() => new Float64Array(3));
	for (let t = 0; t < tri; t++) {
		const a = at(t * 3), b = at(t * 3 + 1), c = at(t * 3 + 2);
		if (a === b || b === c || a === c) {
			degenerate++;
			continue;
		}
		// zero area with three distinct positions (collinear)
		for (let k = 0; k < 3; k++) {
			const vi = indices ? indices[t * 3 + k] : t * 3 + k;
			p[k][0] = src[vi * 3];
			p[k][1] = src[vi * 3 + 1];
			p[k][2] = src[vi * 3 + 2];
		}
		const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
		const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
		const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
		const len2 = (ux * ux + uy * uy + uz * uz) * (vx * vx + vy * vy + vz * vz);
		if (cx * cx + cy * cy + cz * cz <= len2 * 1e-14) degenerate++;
		for (const [x, y] of [[a, b], [b, c], [c, a]]) keys[nKeys++] = x < y ? x * 4294967296 + y : y * 4294967296 + x;
	}
	const sorted = keys.subarray(0, nKeys).sort();
	let open = 0;
	let nonManifold = 0;
	let edges = 0;
	for (let i = 0; i < nKeys; ) {
		let j = i + 1;
		while (j < nKeys && sorted[j] === sorted[i]) j++;
		const uses = j - i;
		edges++;
		if (uses === 1) open++;
		else if (uses > 2) nonManifold++;
		i = j;
	}
	return { degenerate, open, nonManifold, edges, welded: ids.size, vertices: count };
}

/** what modelSanity checks on the file alone: the root nodes' scale + rotation @param {any} scene */
function topNodesOf(scene) {
	return scene.listChildren().map((/** @type {any} */ n) => ({ scale: n.getScale(), quaternion: n.getRotation() }));
}

/**
 * Measure one GLB. Units follow importBudget.modelCost so the e2e can compare like with like.
 * @param {string} file @param {{topologyCap?: number}} [opts]
 */
export async function measureGlb(file, opts = {}) {
	const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
	await MeshoptDecoder.ready;
	const bytes = fs.statSync(file).size;
	const t0 = performance.now();
	const doc = await io.read(file);
	const parseMs = performance.now() - t0;
	const root = doc.getRoot();
	const scene = root.getDefaultScene() ?? root.listScenes()[0];
	const cost = { meshes: 0, triangles: 0, vertices: 0, draws: 0, maxMeshVertices: 0, maxMeshTriangles: 0, textures: 0, textureBytes: 0, maxTextureSize: 0 };
	let nodes = 0;
	const usedTextures = new Set();
	const usedMaterials = new Set();
	let vertexColors = false;
	let skinnedPrims = 0;
	let morphPrims = 0;
	const topo = { degenerate: 0, open: 0, nonManifold: 0, edges: 0, checked: 0, skipped: 0 };
	/** @type {Map<any, any>} */
	const topoByPrim = new Map();
	const cap = opts.topologyCap ?? 2_500_000;
	scene?.traverse((/** @type {any} */ node) => {
		nodes++;
		const mesh = node.getMesh();
		if (!mesh) return;
		for (const prim of mesh.listPrimitives()) {
			const tris = primTriangles(prim);
			const verts = prim.getAttribute('POSITION')?.getCount() ?? 0;
			cost.meshes++;
			cost.draws++;
			cost.triangles += tris;
			cost.vertices += verts;
			cost.maxMeshVertices = Math.max(cost.maxMeshVertices, verts);
			cost.maxMeshTriangles = Math.max(cost.maxMeshTriangles, tris);
			if (prim.getAttribute('COLOR_0')) vertexColors = true;
			if (node.getSkin() && prim.getAttribute('JOINTS_0')) skinnedPrims++;
			if (prim.listTargets().length) morphPrims++;
			const mat = prim.getMaterial();
			if (mat) {
				usedMaterials.add(mat);
				for (const tex of [mat.getBaseColorTexture(), mat.getNormalTexture(), mat.getMetallicRoughnessTexture(), mat.getOcclusionTexture(), mat.getEmissiveTexture()])
					if (tex) usedTextures.add(tex);
				// extension textures (clearcoat, transmission, sheen …) count too: three loads them
				for (const ext of mat.listExtensions?.() ?? [])
					for (const child of ext.listChildren?.() ?? []) if (child?.propertyType === 'Texture') usedTextures.add(child);
			}
			if (!topoByPrim.has(prim)) {
				const t = topology(prim, cap);
				topoByPrim.set(prim, t);
				if (t) {
					topo.checked++;
					topo.degenerate += t.degenerate;
					topo.open += t.open;
					topo.nonManifold += t.nonManifold;
					topo.edges += t.edges;
				} else topo.skipped++;
			}
		}
	});
	/** @type {Record<string, number>} */
	const formats = {};
	const sizes = [];
	/** @type {number[][]} */
	const dims = [];
	let mimeMismatch = 0;
	for (const tex of usedTextures) {
		const img = tex.getImage();
		const declared = tex.getMimeType() || 'unknown';
		const real = img ? sniffMime(img) : null;
		if (real && real !== declared) mimeMismatch++;
		const mime = real ?? declared;
		formats[mime] = (formats[mime] ?? 0) + 1;
		const size = img ? ImageUtils.getSize(img, mime) : null;
		const [w, h] = size ?? [0, 0];
		sizes.push(Math.max(w, h));
		dims.push([w, h]);
		cost.textures++;
		cost.textureBytes += Math.round(w * h * 4 * (4 / 3));
		cost.maxTextureSize = Math.max(cost.maxTextureSize, w, h);
	}
	const mats = root.listMaterials();
	const has = (/** @type {(m: any) => any} */ get) => [...usedMaterials].some((m) => !!get(m));
	const maps = {
		baseColor: has((m) => m.getBaseColorTexture()),
		normal: has((m) => m.getNormalTexture()),
		metallicRoughness: has((m) => m.getMetallicRoughnessTexture()),
		occlusion: has((m) => m.getOcclusionTexture()),
		emissive: has((m) => m.getEmissiveTexture())
	};
	const pbr = maps.metallicRoughness || maps.normal ? 'pbr' : maps.baseColor ? 'color' : vertexColors ? 'vertex-colour' : 'none';
	let bounds = null;
	try {
		const b = scene ? getBounds(scene) : null;
		if (b && Number.isFinite(b.min[0])) bounds = { min: b.min.map(round4), max: b.max.map(round4) };
	} catch {
		bounds = null;
	}
	const size = bounds ? [0, 1, 2].map((i) => round4(bounds.max[i] - bounds.min[i])) : null;
	const maxDim = size ? Math.max(...size) : 0;
	const topNodes = scene ? topNodesOf(scene) : [];
	const fileIssues = sanityIssues({ newSize: size ?? [0, 0, 0], topNodes, canBake: !skinnedPrims }).map((i) => i.kind);
	return {
		bytes,
		parseMs: Math.round(parseMs),
		cost,
		primitives: cost.draws,
		nodes,
		rootNodes: topNodes.length,
		materials: mats.length,
		materialsUsed: usedMaterials.size,
		textures: { count: usedTextures.size, maxPx: cost.maxTextureSize, sizes: sizes.sort((a, b) => b - a), formats, mimeMismatch, dims },
		maps,
		pbr,
		vertexColors,
		extensions: root.listExtensionsUsed().map((e) => e.extensionName),
		skins: root.listSkins().length,
		skinnedPrims,
		morphPrims,
		animations: root.listAnimations().length,
		bounds,
		size,
		maxDim,
		scaleClass: scaleClass(maxDim),
		topNodes: topNodes.map((n) => ({ scale: n.scale.map(round4), quaternion: n.quaternion.map(round4) })),
		fileIssues,
		topology: topo
	};
}

/** the owner's tags, or an empty state @param {string} file */
export function readState(file) {
	try {
		const s = JSON.parse(fs.readFileSync(file, 'utf8'));
		return { categories: s.categories ?? [], tags: s.tags ?? {} };
	} catch {
		return { categories: [], tags: {} };
	}
}


// ---- the report ---------------------------------------------------------------------------------

const MEASURES = [
	['MB', (/** @type {any} */ r) => r.bytes / 1e6, 1],
	['tris k', (/** @type {any} */ r) => r.cost.triangles / 1e3, 1],
	['verts k', (/** @type {any} */ r) => r.cost.vertices / 1e3, 1],
	['prims', (/** @type {any} */ r) => r.primitives, 0],
	['mats', (/** @type {any} */ r) => r.materialsUsed, 0],
	['tex', (/** @type {any} */ r) => r.textures.count, 0],
	['tex px', (/** @type {any} */ r) => r.textures.maxPx, 0],
	['nodes', (/** @type {any} */ r) => r.nodes, 0],
	['max dim', (/** @type {any} */ r) => r.maxDim, 2],
	['open edges %', (/** @type {any} */ r) => (r.topology.edges ? (100 * r.topology.open) / r.topology.edges : NaN), 2],
	['degen %', (/** @type {any} */ r) => (r.cost.triangles ? (100 * r.topology.degenerate) / r.cost.triangles : NaN), 2]
];

/** @param {number} v @param {number} d */
const fmt = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '–');

/** @param {any[]} rows */
export function familyTables(rows) {
	/** @type {Map<string, any[]>} */
	const byFam = new Map();
	for (const r of rows) if (r.m) (byFam.get(r.family) ?? byFam.set(r.family, []).get(r.family))?.push(r);
	const out = [];
	out.push('| family | n | ' + MEASURES.map(([h]) => h + ' (med / p90)').join(' | ') + ' | PBR maps | formats | up z? | scale classes |');
	out.push('|' + ' --- |'.repeat(MEASURES.length + 6));
	for (const [fam, list] of [...byFam].sort((a, b) => b[1].length - a[1].length)) {
		const cells = MEASURES.map(([, get, d]) => {
			const xs = list.map((r) => /** @type {any} */ (get)(r.m));
			return fmt(median(xs), /** @type {number} */ (d)) + ' / ' + fmt(quantile(xs, 0.9), /** @type {number} */ (d));
		});
		const pbr = countBy(list.map((r) => r.m.pbr));
		const forms = countBy(list.flatMap((r) => Object.keys(r.m.textures.formats).map((f) => f.replace('image/', ''))));
		const zup = list.filter((r) => r.up === 'z?').length;
		const scales = countBy(list.map((r) => r.m.scaleClass.split(' ')[0]));
		out.push(`| ${fam} | ${list.length} | ${cells.join(' | ')} | ${pbr} | ${forms || '–'} | ${zup} | ${scales} |`);
	}
	return out.join('\n');
}

/** @param {string[]} xs */
function countBy(xs) {
	/** @type {Record<string, number>} */
	const c = {};
	for (const x of xs) c[x] = (c[x] ?? 0) + 1;
	return Object.entries(c)
		.sort((a, b) => b[1] - a[1])
		.map(([k, n]) => `${k} ${n}`)
		.join(', ');
}

/** triangles by family × the face budget asked for (median, n) @param {any[]} rows */
export function budgetTable(rows) {
	const classes = ['≤50k', '50k-300k', '>300k', 'unset'];
	/** @type {Map<string, any[]>} */
	const byFam = new Map();
	for (const r of rows) if (r.m) (byFam.get(r.family) ?? byFam.set(r.family, []).get(r.family))?.push(r);
	const out = ['| family | ' + classes.map((c) => `asked ${c}: tris k med (n) · got/asked`).join(' | ') + ' |', '|' + ' --- |'.repeat(classes.length + 1)];
	for (const [fam, list] of [...byFam].sort((a, b) => b[1].length - a[1].length)) {
		const cells = classes.map((c) => {
			const xs = list.filter((r) => budgetClass(r.faces) === c);
			if (!xs.length) return '–';
			const ratio = xs.filter((r) => r.faces).map((r) => r.m.cost.triangles / r.faces);
			return `${fmt(median(xs.map((r) => r.m.cost.triangles / 1e3)), 1)} (${xs.length})` + (ratio.length ? ` · ${fmt(median(ratio), 2)}` : '');
		});
		out.push(`| ${fam} | ${cells.join(' | ')} |`);
	}
	return out.join('\n');
}

/** per model (finer than family) @param {any[]} rows */
export function modelTable(rows) {
	/** @type {Map<string, any[]>} */
	const by = new Map();
	for (const r of rows) if (r.m) (by.get(r.model) ?? by.set(r.model, []).get(r.model))?.push(r);
	const out = ['| model | family | n | MB med | tris k med / max | prims med | tex px med | PBR | file issues | settings seen |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
	for (const [model, list] of [...by].sort((a, b) => (a[1][0].family + a[0] < b[1][0].family + b[0] ? -1 : 1))) {
		const tris = list.map((r) => r.m.cost.triangles / 1e3);
		const issues = countBy(list.flatMap((r) => r.m.fileIssues));
		out.push(
			`| ${model} | ${list[0].family} | ${list.length} | ${fmt(median(list.map((r) => r.m.bytes / 1e6)), 1)} | ${fmt(median(tris), 1)} / ${fmt(Math.max(...tris), 1)} | ${fmt(median(list.map((r) => r.m.primitives)), 0)} | ${fmt(median(list.map((r) => r.m.textures.maxPx)), 0)} | ${countBy(list.map((r) => r.m.pbr))} | ${issues || '–'} | ${countBy(list.map((r) => settingsLabel(r.settings) || 'none')).slice(0, 160)} |`
		);
	}
	return out.join('\n');
}

// ---- main ---------------------------------------------------------------------------------------

async function main() {
	if (argv.includes('--pick')) {
		const bench = JSON.parse(fs.readFileSync(val('pick', ''), 'utf8'));
		const items = JSON.parse(fs.readFileSync(val('index', DEFAULTS.index), 'utf8'));
		const picks = pickFixtures(bench.rows, items, readState(val('state', DEFAULTS.state)));
		const to = val('manifest', path.resolve('tests/fixtures/wild/manifest.json'));
		const manifest = {
			about: 'import-wild fixtures: NOT committed — node scripts/fetch-wild-assets.cjs fetches them. Scenario 3D Collection, CC BY 4.0, Scenario (ATTRIBUTION.md). Written by tools/bench/wild-assets.mjs --pick.',
			at: new Date().toISOString().slice(0, 10),
			bench: bench.facts?.set ?? null,
			...picks
		};
		fs.writeFileSync(to, JSON.stringify(manifest, null, '\t') + '\n');
		console.log(`manifest: ${picks.fixtures.length} fixtures, ${picks.pairs.length} replace pairs → ${to}`);
		return;
	}
	const out = val('out', path.resolve('wild-assets-bench'));
	const indexFile = val('index', DEFAULTS.index);
	const stateFile = val('state', DEFAULTS.state);
	const roots = argv.includes('--data') ? [val('data', '')] : DEFAULTS.data.filter((d) => d && fs.existsSync(/** @type {string} */ (d)));
	const setMode = val('set', 'auto');
	const nGroups = Number(val('groups', '20'));
	const limit = Number(val('limit', '0')) || Infinity;
	const verify = flag('verify');
	if (!fs.existsSync(indexFile)) {
		console.log(`SKIP: no index (${indexFile}) — the Scenario 3D Collection metadata is not on this machine`);
		return;
	}
	const items = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
	const state = readState(stateFile);
	const byGroup = groupMap(items);
	const owner = taggedWith(state, 'Benchmark');
	const reject = new Set(taggedWith(state, 'Reject'));
	/** @type {any[]} */
	let set;
	let setLabel;
	if (setMode === 'all') {
		set = items;
		setLabel = 'every item';
	} else if ((setMode === 'auto' || setMode === 'benchmark') && owner.length) {
		// the owner's picks, plus the rest of each picked item's group (the comparison is the point)
		const ids = new Set(owner);
		for (const it of items) if (ids.has(it.id)) for (const g of groupsOf(it)) for (const m of byGroup.get(g) ?? []) ids.add(m.id);
		set = items.filter((it) => ids.has(it.id));
		setLabel = `the owner's ${owner.length} "Benchmark" tags + their groups`;
	} else {
		const top = topGroups(byGroup, nGroups);
		const ids = new Set(top.flatMap((t) => t.list.map((i) => i.id)));
		set = items.filter((it) => ids.has(it.id));
		setLabel = `the ${top.length} input groups with the most generators (no "Benchmark" tags in state.json)`;
	}
	set = set.filter((it) => !reject.has(it.id));
	fs.mkdirSync(out, { recursive: true });
	const rows = [];
	const missing = [];
	let done = 0;
	for (const it of set) {
		for (const o of glbOutputs(it)) {
			if (done >= limit) break;
			const file = locate(/** @type {string[]} */ (roots), o.path);
			const row = { id: it.id, model: it.model, family: familyOf(it.model), workflow: it.workflow, groups: groupsOf(it), path: o.path, sha256: o.sha256, role: o.role ?? null, settings: it.settings ?? null, faces: requestedFaces(it.settings), owner: state.tags[it.id]?.cats ?? [] };
			if (!file) {
				missing.push(row);
				continue;
			}
			if (verify && sha256File(file) !== o.sha256) {
				missing.push({ ...row, bad: 'sha256 mismatch' });
				continue;
			}
			try {
				const m = await measureGlb(file);
				rows.push({ ...row, m });
			} catch (error) {
				rows.push({ ...row, m: null, error: String(/** @type {any} */ (error)?.message ?? error) });
			}
			done++;
			if (done % 10 === 0) process.stderr.write(`  ${done} measured\n`);
		}
	}
	// up-axis guesses per group
	for (const [g, list] of byGroup) {
		const members = rows.filter((r) => r.m && r.groups.includes(g));
		const guesses = upAxisGuesses(members.map((r) => ({ size: r.m.size })));
		members.forEach((r, i) => {
			if (!r.up || r.up === '-' || guesses[i] === 'z?') r.up = guesses[i];
		});
	}
	const facts = {
		at: new Date().toISOString(),
		set: setLabel,
		items: set.length,
		measured: rows.filter((r) => r.m).length,
		failed: rows.filter((r) => !r.m).length,
		missing: missing.length,
		roots,
		verified: verify,
		attribution: 'Scenario 3D Collection (https://huggingface.co/datasets/scenario-labs/3d-collection), CC BY 4.0, Scenario'
	};
	fs.writeFileSync(path.join(out, 'bench.json'), JSON.stringify({ facts, rows, missing }, null, 1));
	const md = [
		'# Scenario 3D Collection — generator benchmark (headless)',
		'',
		`${facts.at} · set: ${facts.set} · ${facts.measured} GLBs measured, ${facts.failed} failed to parse, ${facts.missing} not on disk yet${verify ? ' · sha256 verified' : ''}.`,
		'Units as importBudget.modelCost (prims = draw calls before shadows; textures once per image). Topology after welding by position.',
		`Data: ${facts.attribution}.`,
		'',
		'## Per generator family (median / p90)',
		'',
		familyTables(rows),
		'',
		'## Triangles by the face budget each row asked for',
		'',
		'The dataset is a showcase, not a controlled run: rows use different settings. "got/asked" = triangles ÷ the requested face count.',
		'',
		budgetTable(rows),
		'',
		'## Per model',
		'',
		modelTable(rows),
		''
	].join('\n');
	fs.writeFileSync(path.join(out, 'bench.md'), md);
	console.log(`bench: ${facts.measured} measured, ${facts.failed} failed, ${facts.missing} missing → ${out}/bench.{json,md}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
