// Scenario 3D Collection — the PURE half of the generator bench (tools/bench/wild-assets.mjs) and the
// import-wild picks: families, settings normalisation, the up-axis guess, the set and the picks.
// Imports nothing but modelSanity (itself a leaf), so tests/unit/wildCore.test.js runs it with no I/O.
import { sanityIssues } from '../../src/lib/modelSanity.js';

/** the tag browser's generator families (scenario-browser/public/app.js FAMILIES) */
const FAMILIES = [
	['Meshy', /meshy/], ['Rodin', /rodin|hyper3d/], ['TRELLIS', /trellis/], ['Tripo', /tripo(?!splat)/], ['Hitem / Sparc', /hitem|sparc/],
	['Direct3D', /direct3d/], ['PartCrafter', /partcrafter/], ['SAM 3D', /sam-3d/], ['GPT', /gpt/], ['Claude', /claude/],
	['Voxels', /voxel/], ['Splat', /splat|marble|world-labs/], ['Pixal3D', /pixal/], ['YVO3D', /yvo/], ['ReconViaGen', /reconviagen/], ['CSM', /csm/]
];
/** @param {string} model */
export const familyOf = (model) => (FAMILIES.find(([, re]) => /** @type {RegExp} */ (re).test(model)) || ['Other'])[0];

/** @param {any} it */
export const mainOutput = (it) => it.outputs.find((/** @type {any} */ o) => o.role === 'output') || it.outputs[0] || {};
/** every GLB an item carries (its output, or a null-role GLB beside a .blend) @param {any} it */
export const glbOutputs = (it) => it.outputs.filter((/** @type {any} */ o) => String(o.format).toLowerCase() === 'glb');
/** @param {any} it */
export const groupsOf = (it) => (it.inputs ?? []).map((/** @type {any} */ i) => i.path).filter(Boolean);

/** the image's real type from its magic bytes (a generator may declare the wrong one) @param {Uint8Array} b */
export function sniffMime(b) {
	if (!b || b.length < 12) return null;
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
	if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
	if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
	if (b[0] === 0xab && b[1] === 0x4b && b[2] === 0x54 && b[3] === 0x58) return 'image/ktx2';
	return null;
}

/** @param {number} n */
export function round4(n) {
	return Math.round(n * 1e4) / 1e4;
}

/** what size a generator hands back, as a class @param {number} maxDim */
export function scaleClass(maxDim) {
	if (!maxDim) return 'empty';
	if (maxDim < 0.05) return 'tiny (<5 cm)';
	if (maxDim > 30) return 'huge (>30 m, cm units?)';
	if (maxDim >= 0.9 && maxDim <= 2.1) return 'unit box (~1-2)';
	return 'metric';
}

// ---- settings: the face budget a row ASKED for --------------------------------------------------

/** "50K Quad" / "500K Triangle" / "150K" → 50000 … @param {any} v */
function countIn(v) {
	const m = /^(\d+(?:\.\d+)?)\s*([kKmM])?/.exec(String(v ?? ''));
	if (!m) return null;
	return Math.round(Number(m[1]) * (m[2] ? (/k/i.test(m[2]) ? 1e3 : 1e6) : 1));
}

/**
 * The polygon budget a generation was run with, in TRIANGLES (a quad option counts twice), from whichever key that provider uses, or null.
 * Rows differ (the dataset is a showcase, not a controlled run), so tables group by this.
 * @param {any} settings
 */
export function requestedFaces(settings) {
	const s = settings ?? {};
	for (const key of ['targetPolycount', 'face', 'faceLimit', 'maxFaceNum', 'faceBudget', 'face_budget']) {
		const n = Number(s[key]);
		if (Number.isFinite(n) && n > 0) return n;
	}
	for (const key of ['qualityMeshOption', 'quality']) {
		const n = countIn(s[key]);
		// a quad budget is twice the triangles
		if (n && n >= 1000) return /quad/i.test(String(s[key])) ? n * 2 : n;
	}
	return null;
}

/** @param {number | null} n */
export function budgetClass(n) {
	if (!n) return 'unset';
	if (n <= 50000) return '≤50k';
	if (n <= 300000) return '50k-300k';
	return '>300k';
}

/** the row's remesh / PBR / texture-size flags, as a short label @param {any} settings */
export function settingsLabel(settings) {
	const s = settings ?? {};
	const parts = [];
	const faces = requestedFaces(s);
	if (faces) parts.push((faces >= 1e6 ? faces / 1e6 + 'M' : Math.round(faces / 1e3) + 'k') + ' faces');
	for (const k of ['shouldRemesh', 'remesh']) if (k in s) parts.push(s[k] ? 'remesh' : 'no remesh');
	for (const k of ['enablePbr', 'pbr']) if (k in s) parts.push(s[k] ? 'PBR' : 'no PBR');
	for (const k of ['topology']) if (k in s) parts.push(String(s[k]));
	if (s.quad === true) parts.push('quad');
	for (const k of ['textureResolution', 'textureSize', 'resolution', 'tier', 'quality']) if (k in s) parts.push(k + ' ' + s[k]);
	return parts.join(', ');
}

// ---- the up-axis guess (group consensus) -------------------------------------------------------

/** @param {number[]} a @param {number[]} b */
export function shapeDistance(a, b) {
	const ma = Math.max(...a) || 1;
	const mb = Math.max(...b) || 1;
	let d = 0;
	for (let i = 0; i < 3; i++) d += Math.abs(Math.log((a[i] / ma + 0.05) / (b[i] / mb + 0.05)));
	return d;
}
/** @param {number[]} xs */
export function median(xs) {
	const s = [...xs].filter(Number.isFinite).sort((a, b) => a - b);
	if (!s.length) return NaN;
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** @param {number[]} xs @param {number} q */
export function quantile(xs, q) {
	const s = [...xs].filter(Number.isFinite).sort((a, b) => a - b);
	if (!s.length) return NaN;
	const i = (s.length - 1) * q;
	const lo = Math.floor(i);
	return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
}

/**
 * Per member: 'y' (agrees with its group), 'z?' (the group's box with Y/Z swapped), 'odd' (neither),
 * or '-' (no group to compare with). The consensus is the median of the members' NORMALISED boxes.
 * @param {{size: number[] | null}[]} members
 */
export function upAxisGuesses(members) {
	const boxes = members.map((m) => m.size).filter((s) => s && Math.max(...s) > 0);
	if (boxes.length < 3) return members.map(() => '-');
	const norm = boxes.map((s) => s.map((v) => v / Math.max(...s)));
	const consensus = [0, 1, 2].map((i) => median(norm.map((n) => n[i])));
	return members.map((m) => {
		if (!m.size || !(Math.max(...m.size) > 0)) return '-';
		const straight = shapeDistance(m.size, consensus);
		const swapped = shapeDistance([m.size[0], m.size[2], m.size[1]], consensus);
		if (straight > 0.7 && swapped < straight * 0.5) return 'z?';
		return straight > 0.9 ? 'odd' : 'y';
	});
}

// ---- the set ------------------------------------------------------------------------------------

/** ids the owner tagged with `use` @param {{tags: Record<string, any>}} state @param {string} use */
export function taggedWith(state, use) {
	return Object.entries(state.tags)
		.filter(([, t]) => (t?.cats ?? []).includes(use))
		.map(([id]) => id);
}

/** input groups by input path → items @param {any[]} items */
export function groupMap(items) {
	/** @type {Map<string, any[]>} */
	const by = new Map();
	for (const it of items) for (const g of groupsOf(it)) (by.get(g) ?? by.set(g, []).get(g))?.push(it);
	return by;
}

/** the n groups with the most distinct generators (ties: more members) @param {Map<string, any[]>} by @param {number} n */
export function topGroups(by, n) {
	return [...by]
		.map(([g, list]) => ({ g, list, models: new Set(list.map((i) => i.model)).size }))
		.filter((x) => x.models > 1)
		.sort((a, b) => b.models - a.models || b.list.length - a.list.length || (a.g < b.g ? -1 : 1))
		.slice(0, n);
}
// ---- T2: the import-wild picks -----------------------------------------------------------------

const HF = 'https://huggingface.co/datasets/scenario-labs/3d-collection/resolve/main/';

/** what the suite needs to know about one measured GLB (the bench's numbers, no judgement) @param {any} r */
export function fixtureOf(r) {
	const m = r.m;
	return {
		id: r.id,
		path: r.path,
		sha256: r.sha256,
		url: HF + r.path,
		format: 'glb',
		model: r.model,
		family: r.family,
		group: r.groups[0] ?? null,
		expect: {
			bytes: m.bytes,
			cost: m.cost,
			nodes: m.nodes,
			materialsUsed: m.materialsUsed,
			pbr: m.pbr,
			skinned: m.skinnedPrims > 0,
			morph: m.morphPrims > 0,
			animations: m.animations,
			size: m.size,
			rootNodes: m.topNodes.length,
			fileIssues: m.fileIssues,
			up: r.up ?? '-',
			mimeMismatch: m.textures.mimeMismatch,
			textureDims: m.textures.dims ?? null
		}
	};
}

/**
 * ~40 extremes for the import-wild suite + Replace pairs, from a bench run over EVERY GLB
 * (`--set all`). Each pick says why it is in. FBX outputs come from the index (the bench cannot
 * read FBX; the suite only asks that they import cleanly). The owner's "Import test" tags come first.
 * @param {any[]} rows @param {any[]} items @param {{tags: Record<string, any>}} state
 */
export function pickFixtures(rows, items, state) {
	const ok = rows.filter((r) => r.m && r.role !== 'native');
	/** @type {Map<string, any>} */
	const picked = new Map();
	const add = (/** @type {any} */ r, /** @type {string} */ why) => {
		if (!r) return;
		const cur = picked.get(r.path) ?? { ...fixtureOf(r), why: [] };
		if (!cur.why.includes(why)) cur.why.push(why);
		picked.set(r.path, cur);
	};
	// n NEW rows per reason (a row already in for another reason is tagged with this one too, if it ranks)
	// `distinct`: one family per reason, so "most triangles" is not four PartCrafter rows
	const top = (/** @type {(r: any) => number} */ key, /** @type {number} */ n, /** @type {string} */ why, list = ok, distinct = true) => {
		let fresh = 0;
		const fams = new Set();
		for (const r of [...list].sort((a, b) => key(b) - key(a) || (a.path < b.path ? -1 : 1))) {
			if (fresh >= n) break;
			if (distinct && fams.has(r.family)) continue;
			fams.add(r.family);
			if (!picked.has(r.path)) fresh++;
			add(r, why);
		}
	};
	const owner = new Set(taggedWith(state, 'Import test'));
	for (const r of ok) if (owner.has(r.id)) add(r, 'owner: Import test');
	top((r) => r.m.bytes, 3, 'largest file');
	top((r) => r.m.cost.triangles, 3, 'most triangles');
	top((r) => r.m.materialsUsed, 3, 'most materials');
	top((r) => r.m.primitives, 2, 'most draw calls');
	top((r) => r.m.textures.maxPx, 2, 'largest texture');
	top((r) => -r.m.bytes, 2, 'no PBR maps', ok.filter((r) => r.m.pbr === 'none'));
	top((r) => -r.m.bytes, 1, 'vertex colours only', ok.filter((r) => r.m.pbr === 'vertex-colour'));
	top((r) => r.m.maxDim, 2, 'odd scale (largest box)');
	top((r) => -r.m.maxDim, 2, 'odd scale (smallest box)', ok.filter((r) => r.m.maxDim > 0));
	top((r) => -r.m.bytes, 3, 'Z-up guess (group consensus)', ok.filter((r) => r.up === 'z?'));
	top((r) => -r.m.bytes, 3, 'unapplied root transform', ok.filter((r) => r.m.fileIssues.includes('transforms')));
	top((r) => r.m.primitives, 3, 'PartCrafter multi-part', ok.filter((r) => r.family === 'PartCrafter'), false);
	top((r) => r.m.primitives, 2, 'voxel GLB', ok.filter((r) => r.family === 'Voxels'), false);
	top((r) => r.m.nodes, 2, 'GPT scene builder', ok.filter((r) => r.family === 'GPT'), false);
	top((r) => r.m.nodes, 2, 'Claude scene builder', ok.filter((r) => r.family === 'Claude'), false);
	top((r) => r.m.textures.count, 2, 'Rodin HighPack', ok.filter((r) => /highpack/.test(r.model)), false);
	top((r) => r.m.animations + r.m.skinnedPrims, 2, 'skinned / animated', ok.filter((r) => r.m.skinnedPrims || r.m.animations));
	top((r) => -r.m.bytes, 1, 'texture MIME type lies', ok.filter((r) => r.m.textures.mimeMismatch));
	top((r) => r.m.topology.nonManifold, 1, 'most non-manifold edges');
	// every family once: its median-size GLB
	/** @type {Map<string, any[]>} */
	const fams = new Map();
	for (const r of ok) (fams.get(r.family) ?? fams.set(r.family, []).get(r.family))?.push(r);
	for (const [fam, list] of fams) {
		if ([...picked.values()].some((f) => f.family === fam)) continue;
		const sorted = [...list].sort((a, b) => a.m.bytes - b.m.bytes);
		add(sorted[Math.floor(sorted.length / 2)], 'family representative');
	}
	// FBX outputs, unmeasured (three's FBXLoader in the app is the only reader here)
	const fbx = [];
	for (const it of items)
		for (const o of it.outputs)
			if (String(o.format).toLowerCase() === 'fbx')
				fbx.push({ id: it.id, path: o.path, sha256: o.sha256, url: HF + o.path, format: 'fbx', model: it.model, family: familyOf(it.model), group: groupsOf(it)[0] ?? null, expect: null, why: ['FBX output'] });
	return { fixtures: [...picked.values(), ...fbx.slice(0, 4)], pairs: pickPairs(ok) };
}

/**
 * Replace-from-file pairs: generator A's mesh replaced by generator B's on the SAME input. The
 * expectation is modelSanity's own rule on the two measured boxes + B's root nodes. One pair per
 * outcome where the data has one: nothing flagged, scale, Z-up, unapplied transforms.
 * @param {any[]} ok
 */
export function pickPairs(ok) {
	const byGroup = new Map();
	for (const r of ok) for (const g of r.groups) (byGroup.get(g) ?? byGroup.set(g, []).get(g)).push(r);
	// two pairs per outcome where the data has one, each a different family pair; the scene
	// builders (GPT / Claude) only when nothing else gives that outcome, and Rodin preferred as the
	// "transforms" B (it is where the data has them: a root quarter turn on most Rodin files)
	/** @type {Record<string, any[]>} */
	const want = { none: [], scale: [], zup: [], transforms: [] };
	const light = (/** @type {any} */ r) => r.m.bytes < 30e6 && !r.m.skinnedPrims && !r.m.animations && r.m.size;
	const builder = (/** @type {any} */ r) => r.family === 'GPT' || r.family === 'Claude';
	/** @type {{a: any, b: any, issues: string[], key: string, g: string}[]} */
	const all = [];
	for (const [g, list] of [...byGroup].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
		const cands = list.filter(light);
		for (const a of cands)
			for (const b of cands) {
				if (a === b || a.family === b.family) continue;
				const issues = sanityIssues({ oldSize: a.m.size, newSize: b.m.size, topNodes: b.m.topNodes, canBake: true }).map((i) => i.kind);
				const key = issues.length === 0 ? 'none' : issues.includes('scale') ? 'scale' : issues.includes('zup') ? 'zup' : 'transforms';
				all.push({ a, b, issues, key, g });
			}
	}
	const rank = (/** @type {any} */ x) => (builder(x.a) || builder(x.b) ? 1e12 : 0) + (x.key === 'transforms' && x.b.family !== 'Rodin' ? 1e11 : 0) + x.a.m.bytes + x.b.m.bytes;
	for (const x of all.sort((p, q) => rank(p) - rank(q) || (p.a.path + p.b.path < q.a.path + q.b.path ? -1 : 1))) {
		const list = want[x.key];
		const fams = (/** @type {any} */ y) => [y.a.family, y.b.family].sort().join('|');
		if (list.length >= 2 || list.some((y) => fams(y) === fams(x))) continue;
		list.push({ group: x.g, a: fixtureOf(x.a), b: fixtureOf(x.b), expectIssues: x.issues, why: 'replace: ' + x.key });
	}
	return Object.values(want).flat();
}
