import { tierOf, budgetFor } from './sceneBudget';

// 26-F (roadmap 26 section 4, Stage 2's import bullet) — WHAT A MODEL COSTS, BEFORE IT
// IS IN THE SCENE.
//
// THE FINDING: a model file went from the file dialog straight into the scene. The wire
// gate (26-C) asks before a 4,000-object scene lands and the file-open ask does the same
// for a .tpscene, but ONE model is one object — so a 2.4M-triangle scan passed both gates
// untouched, because neither counted anything but objects. What a model actually costs
// is triangles, draw calls and texture bytes, and every one of them is knowable the
// moment the loader hands back its tree, before a single frame has drawn it.
//
// SAME IDIOM, NOT A SECOND RULE: every axis is judged by sceneBudget's own `tierOf`
// against the SAME table the meter reads, on "what the scene already holds plus this".
// Tiers with actions as everywhere: green and amber do nothing here, red asks.
//
// A LEAF: it imports sceneBudget and nothing else, and it never touches a store — the
// walk takes the tree it is given — so every rule below is testable with no scene, no
// loader and no GPU.

/**
 * How many times each mesh is drawn per display frame. MEASURED (26-E, scene-stress):
 * 1,000 boxes read 1,943 draw calls and one 200k-triangle GLB read 400k triangles a
 * frame — the shadow pass draws every mesh a second time (shadowDefaults turns cast on
 * for everything). Predicting per-frame cost from a model's own counts therefore
 * multiplies by this, which is what makes the prediction the SAME UNIT as the meter's
 * reading and the budget it is compared to.
 */
export const RENDER_PASSES = 2;

const MB = 1024 * 1024;

/**
 * @typedef {{meshes: number, triangles: number, vertices: number, draws: number,
 *   maxMeshVertices: number, maxMeshTriangles: number, textures: number,
 *   textureBytes: number, maxTextureSize: number}} ModelCost
 */

/** @returns {ModelCost} */
export function emptyCost() {
	return {
		meshes: 0,
		triangles: 0,
		vertices: 0,
		draws: 0,
		maxMeshVertices: 0,
		maxMeshTriangles: 0,
		textures: 0,
		textureBytes: 0,
		maxTextureSize: 0
	};
}

/** Triangles one geometry draws (indexed or soup). @param {any} geometry */
export function trianglesOf(geometry) {
	if (!geometry) return 0;
	const index = geometry.index;
	if (index) return Math.floor(index.count / 3);
	const position = geometry.attributes?.position;
	return position ? Math.floor(position.count / 3) : 0;
}

/** Pixel size of a texture's image, whatever decoded it (ImageBitmap, <img>, canvas,
 * a DataTexture's {width, height, data}). Zero while it has not decoded — an OBJ's
 * .mtl textures load after the parse returns, and "not measured" is not "free", but
 * it is certainly not a reason to ask. @param {any} texture */
export function textureSizeOf(texture) {
	const image = texture?.image ?? texture?.source?.data;
	if (!image) return { width: 0, height: 0 };
	const width = Number(image.naturalWidth || image.videoWidth || image.width) || 0;
	const height = Number(image.naturalHeight || image.videoHeight || image.height) || 0;
	return { width, height };
}

/** GPU bytes a texture of this size holds: RGBA8 plus the mip chain (a third again).
 * @param {number} width @param {number} height */
export function textureBytesFor(width, height) {
	return Math.round(width * height * 4 * (4 / 3));
}

/**
 * Every texture a material references, found by VALUE rather than by a list of slot
 * names — a list goes stale the day three adds one, and a module's material can hang a
 * texture anywhere. @param {any} material @returns {any[]}
 */
export function texturesOf(material) {
	/** @type {any[]} */
	const out = [];
	if (!material) return out;
	for (const key of Object.keys(material)) {
		const value = material[key];
		if (value && value.isTexture) out.push(value);
	}
	// a ShaderMaterial carries its samplers in uniforms
	const uniforms = material.uniforms;
	if (uniforms) for (const key of Object.keys(uniforms)) if (uniforms[key]?.value?.isTexture) out.push(uniforms[key].value);
	return out;
}

/**
 * What a tree costs to draw — ONE walk, the numbers the gate needs and nothing else.
 * Textures are counted once per SOURCE (three shares one image between Texture objects
 * that differ only in wrap or offset), so a model that reuses its atlas on every mesh
 * is not charged for it forty times.
 * @param {any} root
 * @param {{skip?: (o: any) => boolean}} [opts] `skip` prunes a subtree (the scene walk
 *   skips nothing today; the hook is for the caller that must exclude one object)
 * @returns {ModelCost}
 */
export function modelCost(root, opts = {}) {
	const cost = emptyCost();
	if (!root?.traverse) return cost;
	/** @type {Set<string>} */
	const seen = new Set();
	/** @param {any} object */
	const visit = (object) => {
		if (opts.skip && object !== root && opts.skip(object)) return;
		const geometry = object.geometry;
		if (geometry && (object.isMesh || object.isLine || object.isPoints)) {
			const instances = object.isInstancedMesh ? Math.max(1, Number(object.count) || 1) : 1;
			const tris = object.isMesh ? trianglesOf(geometry) : 0;
			const verts = geometry.attributes?.position?.count ?? 0;
			cost.meshes++;
			cost.triangles += tris * instances;
			cost.vertices += verts * instances;
			// an array material draws once per GROUP (three walks geometry.groups)
			const groups = Array.isArray(object.material) ? Math.max(1, geometry.groups?.length ?? 0) : 1;
			cost.draws += groups;
			if (verts > cost.maxMeshVertices) cost.maxMeshVertices = verts;
			if (tris > cost.maxMeshTriangles) cost.maxMeshTriangles = tris;
			const materials = Array.isArray(object.material) ? object.material : [object.material];
			for (const material of materials) {
				for (const texture of texturesOf(material)) {
					const id = texture.source?.uuid ?? texture.uuid;
					if (seen.has(id)) continue;
					seen.add(id);
					const { width, height } = textureSizeOf(texture);
					cost.textures++;
					cost.textureBytes += textureBytesFor(width, height);
					cost.maxTextureSize = Math.max(cost.maxTextureSize, width, height);
				}
			}
		}
		for (const child of object.children ?? []) visit(child);
	};
	visit(root);
	return cost;
}

/**
 * @typedef {{key: string, label: string, current: number, incoming: number, total: number,
 *   ceiling: number, tier: import('./sceneBudget').Tier, crosses: boolean, reducible: boolean}} ImportRow
 */

/** The axes, the unit each is stated in, and whether a reduction can move it. Draw calls
 * are NOT reducible: decimation keeps every mesh, and merging meshes changes what the
 * user can select — that is a different operation with a different consent. */
const AXES = [
	{ key: 'triangles', cumulative: true, reducible: true },
	{ key: 'calls', cumulative: true, reducible: false },
	{ key: 'meshVertices', cumulative: false, reducible: true },
	{ key: 'textureSize', cumulative: false, reducible: true },
	{ key: 'textureMB', cumulative: true, reducible: true }
];

/** A cost with every field a finite, non-negative number — nonsense in, zero out, so a
 * verdict can never read NaN (which `tierOf` would call "unknown" and never ask about).
 * @param {any} cost @returns {ModelCost} */
function cleanCost(cost) {
	const out = emptyCost();
	for (const key of /** @type {(keyof ModelCost)[]} */ (Object.keys(out))) {
		const n = Number(cost?.[key]);
		out[key] = Number.isFinite(n) && n > 0 ? n : 0;
	}
	return out;
}

/** The reading one axis takes, in the budget's own unit. @param {string} key @param {ModelCost} c */
function readingOf(key, c) {
	switch (key) {
		case 'triangles':
			return c.triangles * RENDER_PASSES;
		case 'calls':
			return c.draws * RENDER_PASSES;
		case 'meshVertices':
			return c.maxMeshVertices;
		case 'textureSize':
			return c.maxTextureSize;
		case 'textureMB':
			return Math.round((c.textureBytes / MB) * 10) / 10;
		default:
			return 0;
	}
}

/**
 * 26-F — SHOULD THIS MODEL BE LET IN AS IT IS? PURE.
 *
 * Every axis is "what the scene already holds plus this model", judged by `tierOf`. The
 * two single-item axes (largest mesh, largest texture) are judged on the model alone —
 * a scene full of 100k-vertex meshes does not make the next one a 700k one.
 *
 * WHEN IT ASKS — the ingest gate's rule, sharpened for a thing that is added one at a
 * time: an axis asks when it is red AND this model is what took it there (the scene was
 * not already red without it), OR when the model on its own is past that axis's green
 * ceiling. The second clause is what keeps an already-heavy scene from asking about
 * every 12-triangle cube dropped into it — a budget that interrupts you on each small
 * thing is a budget people turn off — while a genuinely heavy model still asks however
 * full the scene already is.
 *
 * @param {ModelCost} current what the scene holds (modelCost(objectsGroup))
 * @param {ModelCost} incoming the parsed model
 * @param {'desktop'|'vr'} profile
 * @returns {{rows: ImportRow[], asking: ImportRow[], gate: boolean, reducible: boolean,
 *   tier: import('./sceneBudget').Tier, profile: 'desktop'|'vr', current: ModelCost, incoming: ModelCost}}
 */
export function importVerdict(current, incoming, profile) {
	const now = cleanCost(current);
	const add = cleanCost(incoming);
	const order = { unknown: 0, green: 1, amber: 2, red: 3 };
	/** @type {import('./sceneBudget').Tier} */
	let worst = 'unknown';
	/** @type {ImportRow[]} */
	const rows = AXES.map((axis) => {
		const budget = budgetFor(axis.key);
		const ceilings = budget ? (profile === 'vr' ? budget.vr : budget.desktop) : [Infinity, Infinity];
		const mine = readingOf(axis.key, add);
		const before = axis.cumulative ? readingOf(axis.key, now) : 0;
		const total = axis.cumulative ? before + mine : mine;
		const tier = tierOf(axis.key, total, profile);
		const wasRed = axis.cumulative && tierOf(axis.key, before, profile) === 'red';
		const heavyAlone = mine > ceilings[0];
		const crosses = tier === 'red' && mine > 0 && (!wasRed || heavyAlone);
		if (order[tier] > order[worst]) worst = tier;
		return {
			key: axis.key,
			label: budget?.label ?? axis.key,
			current: before,
			incoming: mine,
			total,
			ceiling: ceilings[1],
			tier,
			crosses,
			reducible: axis.reducible
		};
	});
	const asking = rows.filter((r) => r.crosses);
	return {
		rows,
		asking,
		gate: asking.length > 0,
		reducible: asking.some((r) => r.reducible),
		tier: worst,
		profile,
		current: now,
		incoming: add
	};
}

/** A count for a sentence: 2,400,000 -> "2.4M", 400,000 -> "400k". @param {number} n */
export function shortCount(n) {
	const v = Number(n) || 0;
	// two decimals in the millions: "8M ... above the 8M recommended" reads as a
	// contradiction when the truth is 8.02M
	if (v >= 1e6) return String(Math.round(v / 1e4) / 100) + 'M';
	if (v >= 1e4) return Math.round(v / 1e3) + 'k';
	return Math.round(v).toLocaleString('en-US');
}

/** One clause per asking axis, in the user's words. PURE. @param {ImportRow} row */
export function describeRow(row) {
	switch (row.key) {
		case 'triangles':
			return (
				'the scene would draw ' + shortCount(row.total) + ' triangles a frame (this model adds ' +
				shortCount(row.incoming) + ' with its shadow pass), above the ' + shortCount(row.ceiling) + ' recommended'
			);
		case 'calls':
			return (
				'the scene would make ' + shortCount(row.total) + ' draw calls a frame, above the ' +
				shortCount(row.ceiling) + ' recommended'
			);
		case 'meshVertices':
			return (
				'its largest mesh has ' + shortCount(row.incoming) + ' vertices, above the ' +
				shortCount(row.ceiling) + ' one mesh should hold'
			);
		case 'textureSize':
			return 'it carries a ' + row.incoming + 'px texture, above the ' + row.ceiling + 'px recommended';
		case 'textureMB':
			return (
				'textures would take ' + Math.round(row.total) + ' MB, above the ' + row.ceiling + ' MB recommended'
			);
		default:
			return row.label;
	}
}

/**
 * @typedef {{room: number | null, meshCap: number | null, textureCap: number | null,
 *   textureBudget: number | null}} ReductionPlan
 */

/**
 * 26-F phase 2 — WHAT A REDUCTION SHOULD AIM AT, from the verdict that asked. PURE.
 *
 * Only the axes that ASKED get a target; a model asked about for its texture is not
 * decimated as well. Each aims at the edge of RED — the most that fits without asking
 * again, the same rule as `ingestVerdict.allowed` — with a 5% margin so the re-check
 * after the reduction lands inside it. A scene that was already red has no room at the
 * edge, so there the model aims at the GREEN ceiling on its own (it is asking only
 * because it is heavy by itself, and that is the thing to fix).
 *  · triangles: the model's share of the frame, divided by RENDER_PASSES back into
 *    triangles of geometry;
 *  · largest mesh: 90% of the single-mesh ceiling (the simplifier's vertex count lands
 *    a little over half its triangle count, and seams add a few);
 *  · textures: the single-texture ceiling, and the byte room left in texture memory.
 * @param {ReturnType<typeof importVerdict>} verdict
 * @returns {ReductionPlan}
 */
export function reductionPlan(verdict) {
	/** @type {ReductionPlan} */
	const plan = { room: null, meshCap: null, textureCap: null, textureBudget: null };
	if (!verdict) return plan;
	const asking = (/** @type {string} */ key) => verdict.asking?.some((r) => r.key === key);
	const ceilings = (/** @type {string} */ key) => {
		const b = budgetFor(key);
		return b ? (verdict.profile === 'vr' ? b.vr : b.desktop) : [Infinity, Infinity];
	};
	if (asking('triangles')) {
		const [green, amber] = ceilings('triangles');
		const current = verdict.current.triangles * RENDER_PASSES;
		const room = current > amber ? green : amber - current;
		plan.room = Math.max(0, Math.floor((0.95 * room) / RENDER_PASSES));
	}
	if (asking('meshVertices')) plan.meshCap = Math.floor(0.9 * ceilings('meshVertices')[0]);
	if (asking('textureSize')) plan.textureCap = ceilings('textureSize')[0];
	if (asking('textureMB')) {
		const [green, amber] = ceilings('textureMB');
		const current = verdict.current.textureBytes / MB;
		const room = current > amber ? green : amber - current;
		plan.textureBudget = Math.max(0, Math.floor(0.95 * room * MB));
	}
	return plan;
}
