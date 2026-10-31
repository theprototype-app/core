// 46 B1/B2 — WHAT THIS SCENE COSTS ON A GIVEN DEVICE, judged against the perf gate's own budgets.
//
// THE QUESTION the chip answers is "will this scene fit on a Quest (a phone, a desktop)?" while you
// build it on something else. The live per-frame counter (sceneBudget) cannot answer it: it counts
// what THIS editor draws from THIS view — the composer passes, the outline, the grid, the gizmo and a
// shadow pass the headset may not have — so a scene that passes the gate reads red in the editor and
// changes colour as you orbit. This is the CONTENT estimate instead (Mozilla Spoke's "performance
// check" model): draw calls, triangles, texture memory, lights and shadow casters counted from the
// scene graph as the target would draw it, whole scene, LOD 0 (the worst case), per object — so the
// heaviest list adds up to the total and the reading only moves when the scene does.
//
// COUNTED THE GATE'S WAY where the two overlap (scripts/perfProbe.cjs readScene): only VISIBLE
// subtrees; a light is any light but ambient / hemisphere; texture memory is one upload per image
// SOURCE (clones share it), w x h x 4 bytes per face, x 4/3 when mipmapped. Calls are the MAIN pass
// (the gate's profile has shadows off); what shadows add is its own row — every caster is drawn again
// per shadow-casting light.
//
// PURE: duck-typed three objects in, plain numbers out. No store, no THREE import, no DOM — the
// runtime (budgetMeter.js) hands it the roots and the two facts it cannot know (which meshes batch as
// kit instances, which already have a LOD). Unit-tested in tests/unit/budgetMeterCore.test.js.

import { IMPORT_DEFAULTS } from './gltfOptimize/presets.js';

/** @typedef {'quest'|'phone'|'desktop'} TargetId */
/** @typedef {'calls'|'triangles'|'textureMB'|'lights'|'shadowLights'|'shadowCasters'} Metric */
/** @typedef {'green'|'amber'|'red'} Tier */
/**
 * @typedef {{id: TargetId, label: string, short: string, calls: number, triangles: number,
 *   textureMB: number, lights: number, shadowLights: number, shadowCasters: number}} Target
 */

export const TARGET_IDS = /** @type {TargetId[]} */ (['quest', 'phone', 'desktop']);
/** table order: what the Budget section lists and the chip's tooltip walks */
export const METRICS = /** @type {Metric[]} */ (['calls', 'triangles', 'textureMB', 'lights', 'shadowLights', 'shadowCasters']);
/** the four the perf gate holds (scripts/perfBudget.cjs METRICS) — Quest's come from `defaults` */
export const GATED = /** @type {Metric[]} */ (['calls', 'triangles', 'lights', 'textureMB']);

export const METRIC_LABELS = /** @type {Record<Metric, string>} */ ({
	calls: 'Draw calls',
	triangles: 'Triangles',
	textureMB: 'Texture memory',
	lights: 'Lights',
	shadowLights: 'Shadow-casting lights',
	shadowCasters: 'Shadow draws'
});
export const METRIC_WHY = /** @type {Record<Metric, string>} */ ({
	calls: 'Separately drawn meshes (main pass). Each is CPU time per frame; kit pieces that instance count once.',
	triangles: 'Triangles drawn at full detail (LOD 0, the closest view). Vertex and fill cost.',
	textureMB: 'GPU memory for the textures in use, uncompressed (one upload per image). A headset or phone tab is killed when it runs out.',
	lights: 'Real-time lights (ambient and hemisphere not counted). Every light adds shading cost to every pixel it reaches.',
	shadowLights: 'Lights that cast shadows. Each one draws every shadow caster again.',
	shadowCasters: 'Shadow-casting meshes drawn again, once per shadow-casting light (0 with no shadow light). Every mesh casts by default — turn Cast shadow off on small props.'
});

/** amber from this share of the budget; red past the budget itself (the gate's line) */
export const AMBER_FROM = 0.8;
/** small whole-number budgets (2 lights, 1 shadow light): AT the budget is fine, not a warning — the
 * default sun alone is 1 of 1 shadow lights, and an empty scene must not read amber */
export const DISCRETE = /** @type {Metric[]} */ (['lights', 'shadowLights']);

// What the 46 import/export pipeline does to a heavy asset: the shipped Settings ▸ Import defaults
// (gltfOptimize/presets.js). measureScene takes this device's settings as `optimize` (budgetMeter.js
// passes the Settings ▸ Import store), so the estimate follows the thresholds and ratios an import uses.
export const OPTIMIZE_TRIANGLES = IMPORT_DEFAULTS.triangleThreshold;
export const OPTIMIZE_TEXTURE_PX = IMPORT_DEFAULTS.textureThreshold;
/** KTX2/Basis stays compressed on the GPU (BC7/ASTC/ETC: 1 byte per texel or less) against RGBA8's 4 */
export const KTX2_RATIO = 0.25;
/** the coarser levels a LOD chain adds, as a share of LOD 0's triangles */
export const LOD_RATIOS = IMPORT_DEFAULTS.lodRatios;

/** @typedef {{triangleThreshold?: number, textureThreshold?: number, maxTextureSize?: number,
 *   compress?: boolean, lodRatios?: readonly number[]}} OptimizeSettings */

/**
 * The three targets from perf/budgets.json: Quest = the gate's `defaults` + Quest's meter-only rows,
 * phone/desktop as written. A missing number reads as Infinity (never a false red).
 * @param {{defaults: Record<string, number>, targets?: Record<string, any>}} budgets
 * @returns {Record<TargetId, Target>}
 */
export function resolveTargets(budgets) {
	const t = budgets?.targets ?? {};
	/** @type {any} */
	const out = {};
	for (const id of TARGET_IDS) {
		const own = t[id] ?? {};
		const src = id === 'quest' ? { ...own, ...pick(budgets?.defaults ?? {}, GATED) } : own;
		/** @type {any} */
		const target = { id, label: own.label || id, short: own.short || own.label || id };
		for (const m of METRICS) target[m] = Number.isFinite(src[m]) && src[m] > 0 ? src[m] : Infinity;
		out[id] = target;
	}
	return out;
}

/** @param {Record<string, any>} obj @param {string[]} keys */
function pick(obj, keys) {
	/** @type {Record<string, any>} */
	const out = {};
	for (const k of keys) if (k in obj) out[k] = obj[k];
	return out;
}

/** @param {number} value @param {number} limit @param {boolean} [discrete] no amber band @returns {Tier} */
export function tierOfShare(value, limit, discrete = false) {
	if (!Number.isFinite(limit) || limit <= 0) return 'green';
	const share = value / limit;
	if (share > 1) return 'red';
	return !discrete && share >= AMBER_FROM ? 'amber' : 'green';
}

/** the share a metric contributes to a HEADLINE: a small count within its budget says nothing
 * (1 of 1 shadow lights is not "100 %") @param {Metric} key @param {number} share */
function headShare(key, share) {
	return DISCRETE.includes(key) && share <= 1 ? 0 : share;
}

const ORDER = { green: 0, amber: 1, red: 2 };

/**
 * Every metric against the target, plus the verdict the chip shows: the worst tier, and the metric
 * that takes the largest share of its budget.
 * @param {Record<Metric, number>} totals @param {Target} target
 */
export function judgeCost(totals, target) {
	const rows = METRICS.map((key) => {
		const value = totals?.[key] ?? 0;
		const limit = target[key];
		const share = Number.isFinite(limit) && limit > 0 ? value / limit : 0;
		return { key, label: METRIC_LABELS[key], why: METRIC_WHY[key], value, limit, share, tier: tierOfShare(value, limit, DISCRETE.includes(key)) };
	});
	let worst = rows[0];
	/** @type {Tier} */
	let tier = 'green';
	for (const r of rows) {
		if (headShare(r.key, r.share) > headShare(worst.key, worst.share)) worst = r;
		if (ORDER[r.tier] > ORDER[tier]) tier = r.tier;
	}
	return { tier, rows, worst, percent: Math.round(headShare(worst.key, worst.share) * 100) };
}

/**
 * Texture bytes the gate's way: w x h x 4 per face, x 4/3 when mipmapped.
 * @param {any} texture
 */
export function textureBytes(texture) {
	const img = texture?.image;
	const one = Array.isArray(img) ? img[0] : img;
	const w = one?.naturalWidth || one?.videoWidth || one?.width || 0;
	const h = one?.naturalHeight || one?.videoHeight || one?.height || 0;
	const faces = Array.isArray(img) ? img.length : 1;
	return w * h * 4 * faces * (texture?.generateMipmaps === false ? 1 : 4 / 3);
}

/** the largest side of a texture's image (px) @param {any} texture */
function textureSide(texture) {
	const img = texture?.image;
	const one = Array.isArray(img) ? img[0] : img;
	return Math.max(one?.naturalWidth || one?.videoWidth || one?.width || 0, one?.naturalHeight || one?.videoHeight || one?.height || 0);
}

/**
 * What optimizing this texture would leave on the GPU (past the threshold: resize to the max size;
 * then KTX2 when compression is on). Already compressed = nothing to win.
 * @param {any} texture @param {OptimizeSettings} [opt]
 */
export function optimizedTextureBytes(texture, opt = IMPORT_DEFAULTS) {
	const bytes = textureBytes(texture);
	if (texture?.isCompressedTexture) return bytes;
	const side = textureSide(texture);
	const over = opt.textureThreshold ?? OPTIMIZE_TEXTURE_PX;
	const max = opt.maxTextureSize ?? over;
	const scale = side > over && side > max ? (max / side) ** 2 : 1;
	return bytes * scale * (opt.compress === false ? 1 : KTX2_RATIO);
}

/** @param {any} geometry @returns {number} */
export function trianglesOf(geometry) {
	if (!geometry) return 0;
	const count = geometry.index ? geometry.index.count : (geometry.attributes?.position?.count ?? 0);
	const range = geometry.drawRange;
	const drawn = range && Number.isFinite(range.count) ? Math.min(count, range.count) : count;
	return Math.floor(drawn / 3);
}

/** a mesh's draw calls in one pass: one per material GROUP when it carries a material array @param {any} node */
export function callsOf(node) {
	const mats = node.material;
	const groups = node.geometry?.groups;
	if (Array.isArray(mats) && groups?.length) {
		let n = 0;
		for (const g of groups) if (mats[g.materialIndex ?? 0]) n++;
		return Math.max(1, n);
	}
	return 1;
}

/** @param {any} node */
function drawsOnLayer0(node) {
	// a helper (light helper, camera frustum, a hidden marker) lives on HELPER_LAYER only: the camera a
	// game renders through sees layer 0, so it never draws it
	const mask = node?.layers?.mask;
	return mask === undefined || (mask & 1) === 1;
}

/** @param {any} mat @param {(t: any) => void} add */
function texturesOf(mat, add) {
	if (!mat) return;
	for (const k in mat) if (mat[k]?.isTexture) add(mat[k]);
	for (const k in mat.uniforms ?? {}) if (mat.uniforms[k]?.value?.isTexture) add(mat.uniforms[k].value);
}

/**
 * @typedef {{uuid: string, name: string, kind: 'object'|'environment'|'module', selectable: boolean,
 *   calls: number, triangles: number, textureMB: number, lights: number, shadowLights: number,
 *   shadowCasters: number, instancedCopies: number,
 *   save: {textureMB: number, lodTriangles: number, heavyMeshes: number, bigTextures: number}}} CostRow
 */

/**
 * Walk the scene's drawn content and cost it.
 *
 * `roots`: what a game draws — the objects group (one row per top-level object), the environment rig
 * and module content (one row each). Anything else at the scene root (grid, gizmo, helpers, kit
 * placeholders, edit overlays) is the editor's and is not passed in.
 * `kitSourceOf(mesh)`: the template a placed kit piece was cloned from (packRefs.kitMeshSource) — when
 * kit instancing is on, every pristine copy of one (geometry, material) pair draws as ONE instanced
 * call, so only the first copy counts a call. `hasLod(mesh)`: the mesh already switches detail by
 * distance, so a LOD chain saves nothing more. `attachedOf(node)`: content drawn FOR a node that lives
 * elsewhere in the scene graph (47 T2: a terrain's scatter instances sit in a scene-root holder) —
 * walked as part of that node's row.
 *
 * @param {{roots: {object: any, kind: 'objects'|'environment'|'module', label?: string}[],
 *   background?: any, environment?: any, kitInstancing?: boolean,
 *   kitSourceOf?: (mesh: any) => any, hasLod?: (mesh: any) => boolean, optimize?: OptimizeSettings,
 *   attachedOf?: (node: any) => any[] | null | undefined}} input
 */
export function measureScene(input) {
	const { roots = [], kitInstancing = false, kitSourceOf = () => null, hasLod = () => false, attachedOf = () => null } = input ?? {};
	const optimize = { ...IMPORT_DEFAULTS, ...(input?.optimize ?? {}) };
	const farRatio = optimize.lodRatios?.length ? optimize.lodRatios[optimize.lodRatios.length - 1] : 1;
	/** @type {CostRow[]} */
	const rows = [];
	/** every texture source counted so far (the scene total is deduped; a row counts its own) */
	const sources = new Set();
	let totalTextureBytes = 0;
	/** (geometry, material) pairs of kit copies already drawn — the instancing batches */
	const kitBatches = new Map();

	/** @param {any} t */
	const addSceneTexture = (t) => {
		const key = t.source ?? t.image ?? t;
		if (sources.has(key)) return;
		sources.add(key);
		totalTextureBytes += textureBytes(t);
	};

	/** @param {any} root @param {string} uuid @param {string} name @param {CostRow['kind']} kind @param {boolean} selectable */
	const costOf = (root, uuid, name, kind, selectable) => {
		/** @type {CostRow} */
		const row = {
			uuid,
			name,
			kind,
			selectable,
			calls: 0,
			triangles: 0,
			textureMB: 0,
			lights: 0,
			shadowLights: 0,
			shadowCasters: 0,
			instancedCopies: 0,
			save: { textureMB: 0, lodTriangles: 0, heavyMeshes: 0, bigTextures: 0 }
		};
		const own = new Set();
		let bytes = 0;
		let optimized = 0;
		/** @param {any} node */
		const visit = (node) => {
			if (!node || node.visible === false) return;
			if (drawsOnLayer0(node)) {
				if (node.isLight && !node.isAmbientLight && !node.isHemisphereLight) {
					row.lights++;
					if (node.castShadow) row.shadowLights++;
				}
				if (node.isMesh || node.isPoints || node.isLine || node.isSprite) {
					// 51: a thinned scatter mesh counts every instance (the content, not this device's draw)
					const tris = node.isMesh ? trianglesOf(node.geometry) * (node.isInstancedMesh ? Math.max(0, node.userData?.instanceTotal ?? node.count ?? 0) : 1) : 0;
					row.triangles += tris;
					let calls = callsOf(node);
					if (kitInstancing && node.isMesh && !node.isInstancedMesh) {
						const src = kitSourceOf(node);
						const mat = node.material;
						if (src && !Array.isArray(mat) && !mat?.transparent) {
							let byMat = kitBatches.get(node.geometry);
							if (!byMat) kitBatches.set(node.geometry, (byMat = new Set()));
							if (byMat.has(mat)) {
								calls = 0;
								row.instancedCopies++;
							} else byMat.add(mat);
						}
					}
					row.calls += calls;
					if (node.isMesh && node.castShadow) row.shadowCasters++;
					if (node.isMesh && !node.isInstancedMesh && tris > optimize.triangleThreshold && !hasLod(node)) {
						row.save.heavyMeshes++;
						// the coarser levels draw lodRatios of LOD 0: what the farthest one saves
						row.save.lodTriangles += Math.round(tris * (1 - farRatio));
					}
					const mats = Array.isArray(node.material) ? node.material : [node.material];
					for (const m of mats)
						texturesOf(m, (t) => {
							addSceneTexture(t);
							const key = t.source ?? t.image ?? t;
							if (own.has(key)) return;
							own.add(key);
							const b = textureBytes(t);
							bytes += b;
							optimized += optimizedTextureBytes(t, optimize);
							if (textureSide(t) > optimize.textureThreshold) row.save.bigTextures++;
						});
				}
			}
			for (const child of node.children ?? []) visit(child);
			for (const extra of attachedOf(node) ?? []) visit(extra);
		};
		visit(root);
		row.textureMB = round1(bytes / 1048576);
		row.save.textureMB = round1(Math.max(0, bytes - optimized) / 1048576);
		return row;
	};

	for (const entry of roots) {
		const root = entry?.object;
		if (!root || root.visible === false) continue;
		if (entry.kind === 'objects') {
			for (const child of root.children ?? []) rows.push(costOf(child, child.uuid, child.name || child.type || 'Object', 'object', true));
		} else rows.push(costOf(root, root.uuid, entry.label || root.name || entry.kind, entry.kind, false));
	}
	// the sky / environment map are textures the scene uploads too (the gate counts them)
	for (const tex of [input?.background, input?.environment]) if (tex?.isTexture) addSceneTexture(tex);

	/** @type {Record<Metric, number>} */
	const totals = { calls: 0, triangles: 0, textureMB: round1(totalTextureBytes / 1048576), lights: 0, shadowLights: 0, shadowCasters: 0 };
	for (const r of rows) {
		totals.calls += r.calls;
		totals.triangles += r.triangles;
		totals.lights += r.lights;
		totals.shadowLights += r.shadowLights;
	}
	// a caster is drawn again once per shadow-casting light, and not at all with none: rows count their
	// casters, so turn them into DRAWS with the scene's shadow lights (a row's shadow draws add up too)
	for (const r of rows) {
		r.shadowCasters *= totals.shadowLights;
		totals.shadowCasters += r.shadowCasters;
	}
	return { totals, rows, objects: rows.filter((r) => r.kind === 'object').length };
}

/** @param {number} n */
function round1(n) {
	return Math.round(n * 10) / 10;
}

/**
 * The heaviest rows against a target: ranked by the largest share of any one budget the row takes
 * (an object that is half the Quest's triangles outranks one with a few textures), ties by triangles.
 * Rows that cost nothing are left out.
 * @param {CostRow[]} rows @param {Target} target @param {number} [limit]
 */
export function heaviest(rows, target, limit = 8) {
	return rows
		.map((r) => {
			let share = 0;
			/** @type {Metric} */
			let by = 'triangles';
			for (const m of METRICS) {
				const l = target[m];
				const s = headShare(m, Number.isFinite(l) && l > 0 ? r[m] / l : 0);
				if (s > share) {
					share = s;
					by = m;
				}
			}
			return { ...r, share, by, percent: Math.round(share * 100) };
		})
		.filter((r) => r.share > 0)
		.sort((a, b) => b.share - a.share || b.triangles - a.triangles || a.uuid.localeCompare(b.uuid))
		.slice(0, limit);
}

/** A compact number for a chip or a table cell. @param {number} n */
export function formatCount(n) {
	if (!Number.isFinite(n)) return '—';
	if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
	if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
	return String(Math.round(n * 10) / 10);
}

/** @param {Metric} metric @param {number} n */
export function formatMetric(metric, n) {
	if (!Number.isFinite(n)) return '—';
	return metric === 'textureMB' ? (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10) + ' MB' : formatCount(n);
}
