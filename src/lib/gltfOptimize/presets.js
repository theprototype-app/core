// 46 P1 — THE OPTIMIZER'S NUMBERS. PURE and import-free (the lodCore.js shape): the import
// thresholds and defaults Settings ▸ Import starts from, the two export presets, how one set of
// import settings becomes the engine's options, and the GPU-memory estimate the report and the
// docs quote. The engine (core.js) runs in a Worker; the UI and the import path read this file,
// so nothing here may pull glTF-Transform into the main bundle.
//
// WHERE THE NUMBERS COME FROM (the user's "follow DCC best practices", 2026-10-15): Unity's model
// importer generates an LOD chain and its texture importer caps the size and picks a GPU format;
// Unreal's defaults are the same shape. The thresholds are the decision's own — models over 50k
// triangles and textures over 2048 px are optimized on import. The ratios are lodCore's
// (31-perf's auto LOD, measured on this app's packs), so a generated chain and an imported one
// step down alike.

/**
 * @typedef {{
 *   dedup: boolean, prune: boolean, weld: boolean, reorder: boolean,
 *   reduce: number | null,
 *   lods: number[], embedLods: boolean,
 *   maxTextureSize: number,
 *   textures: 'keep' | 'ktx2' | 'ktx2+fallback',
 *   meshopt: boolean
 * }} OptimizeOptions
 *   `reduce`: LOD0 keeps this share of its triangles (null = full detail, the DCC default).
 *   `lods`: the chain's ratios. Embedded as MSFT_lod only when `embedLods` (an export); an import
 *   stamps them as a generated LOD group instead (built per peer, nothing travels).
 *   `maxTextureSize`: 0 = keep every size. `textures`: 'ktx2+fallback' writes KHR_texture_basisu
 *   beside the (resized) plain image — what an import keeps, so the scene still has an ordinary
 *   texture for every serializer; 'ktx2' drops the plain image (the export preset).
 *   `meshopt`: quantize + EXT_meshopt_compression — export only (it rewrites node transforms).
 */

/** @type {Readonly<OptimizeOptions>} */
export const OPTIMIZE_DEFAULTS = Object.freeze({
	dedup: true,
	prune: true,
	weld: true,
	reorder: true,
	reduce: null,
	lods: [],
	embedLods: false,
	maxTextureSize: 0,
	textures: 'keep',
	meshopt: false
});

/**
 * @typedef {{auto: boolean, triangleThreshold: number, textureThreshold: number, maxTextureSize: number,
 *   compress: boolean, lodLevels: number, lodRatios: number[]}} ImportSettings
 */

/** What Settings ▸ Import holds (LOCAL, per device — the user's defaults for new imports).
 * @type {Readonly<ImportSettings>} */
export const IMPORT_DEFAULTS = Object.freeze({
	/** optimize models / textures automatically when either threshold is crossed */
	auto: true,
	/** a model above this many triangles gets its LOD chain */
	triangleThreshold: 50000,
	/** a texture above this many pixels on its long side is resized + compressed */
	textureThreshold: 2048,
	/** the long side a resized texture gets */
	maxTextureSize: 2048,
	/** KTX2 / Basis GPU compression of the textures */
	compress: true,
	/** how many coarser levels the chain has (0 = no LOD) */
	lodLevels: 3,
	/** share of the triangles each level keeps */
	lodRatios: [0.5, 0.25, 0.1]
});

/** The bounds the settings UI and the per-asset override clamp to. */
export const IMPORT_LIMITS = Object.freeze({
	triangleThreshold: [1000, 5000000],
	textureThreshold: [256, 8192],
	maxTextureSize: [256, 4096],
	lodLevels: [0, 4],
	ratio: [0.02, 0.9]
});

/** The texture sizes offered (a power of two keeps every GPU and mip chain happy). */
export const TEXTURE_SIZES = Object.freeze([512, 1024, 2048, 4096]);

/**
 * The export presets. `full` is today's output, untouched; `quest` is the "For Quest / web" file:
 * KTX2/Basis textures at most 2048 px, meshopt compression and the LOD chain.
 */
export const EXPORT_PRESETS = Object.freeze({
	full: Object.freeze({ id: 'full', label: 'Full quality', options: null }),
	quest: Object.freeze({
		id: 'quest',
		label: 'For Quest / web',
		options: Object.freeze({
			...OPTIMIZE_DEFAULTS,
			lods: [0.5, 0.25, 0.1],
			embedLods: true,
			maxTextureSize: 2048,
			textures: /** @type {'ktx2'} */ ('ktx2'),
			meshopt: true
		})
	})
});

/** @param {any} value @param {number} lo @param {number} hi @param {number} fallback */
function clampNum(value, lo, hi, fallback) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(hi, Math.max(lo, n));
}

/**
 * Settings (stored, a per-asset override, or nothing) normalised onto IMPORT_DEFAULTS: every
 * number clamped, the ratio list strictly decreasing and exactly `lodLevels` long.
 * @param {any} [raw] @returns {ImportSettings}
 */
export function normalizeImportSettings(raw) {
	const r = raw && typeof raw === 'object' ? raw : {};
	const d = IMPORT_DEFAULTS;
	const L = IMPORT_LIMITS;
	const lodLevels = Math.round(clampNum(r.lodLevels, L.lodLevels[0], L.lodLevels[1], d.lodLevels));
	/** @type {number[]} */
	const ratios = [];
	const given = Array.isArray(r.lodRatios) ? r.lodRatios : d.lodRatios;
	for (let i = 0; i < lodLevels; i++) {
		const prev = ratios.length ? ratios[ratios.length - 1] : 1;
		// a missing ratio continues the halving the defaults follow
		const want = Number.isFinite(Number(given[i])) ? Number(given[i]) : prev / 2;
		const ratio = clampNum(want, L.ratio[0], L.ratio[1], prev / 2);
		// strictly coarser than the level before, or the level is pointless
		ratios.push(Math.round(Math.min(ratio, prev * 0.9) * 1000) / 1000);
	}
	return {
		auto: r.auto === undefined ? d.auto : !!r.auto,
		triangleThreshold: Math.round(
			clampNum(
				r.triangleThreshold,
				L.triangleThreshold[0],
				L.triangleThreshold[1],
				d.triangleThreshold
			)
		),
		textureThreshold: Math.round(
			clampNum(r.textureThreshold, L.textureThreshold[0], L.textureThreshold[1], d.textureThreshold)
		),
		maxTextureSize: Math.round(
			clampNum(r.maxTextureSize, L.maxTextureSize[0], L.maxTextureSize[1], d.maxTextureSize)
		),
		compress: r.compress === undefined ? d.compress : !!r.compress,
		lodLevels,
		lodRatios: ratios
	};
}

/**
 * 48 F4: is a model under BOTH import thresholds? Then no setting of this device and no asset override except
 * `always` can optimize it (the thresholds are device-wide; an override only changes what an optimize DOES), so
 * the import places it as parsed — without loading the optimizer or hashing the file to find its override.
 * @param {{triangles: number, maxTextureSide: number}} facts
 * @param {ImportSettings} settings
 */
export function underImportThresholds(facts, settings) {
	return facts.triangles <= settings.triangleThreshold && facts.maxTextureSide <= settings.textureThreshold;
}

/**
 * Would an import of a model this heavy be optimized? `facts` are what a parse measured.
 * @param {{triangles: number, maxTextureSide: number}} facts
 * @param {ImportSettings} settings
 * @returns {{optimize: boolean, lod: boolean, textures: boolean}}
 */
export function importDecision(facts, settings) {
	const lod = settings.lodLevels > 0 && facts.triangles > settings.triangleThreshold;
	const textures = facts.maxTextureSide > settings.textureThreshold;
	return { optimize: settings.auto && (lod || textures), lod, textures };
}

/**
 * The engine options for an IMPORT under `settings`: textures resized past the threshold and
 * (when `compress`) given KTX2 twins beside the plain image; geometry deduplicated and welded,
 * LOD0 left at full detail unless the per-asset `reduce` asks. The LOD chain is NOT embedded —
 * the import stamps a generated LOD group (lodGroup.js builds it on every peer).
 * @param {ImportSettings} settings @param {{reduce?: number | null}} [extra]
 * @returns {OptimizeOptions}
 */
export function importOptions(settings, extra = {}) {
	return {
		...OPTIMIZE_DEFAULTS,
		reduce: extra.reduce ?? null,
		lods: [],
		embedLods: false,
		maxTextureSize: settings.maxTextureSize,
		textures: settings.compress ? 'ktx2+fallback' : 'keep',
		meshopt: false
	};
}

/** Bytes per pixel a transcoded Basis texture takes on the GPU, by mode and alpha: ETC1S lands
 * as ETC2 RGB / BC1 (4 bpp) opaque and ETC2 RGBA / BC3 (8 bpp) with alpha; UASTC as ASTC 4×4 /
 * BC7 (8 bpp). An RGBA8 texture is 4 bytes. Mips add a third. */
export const GPU_BYTES_PER_PIXEL = Object.freeze({
	rgba8: 4,
	etc1sOpaque: 0.5,
	etc1sAlpha: 1,
	uastc: 1
});

/**
 * GPU bytes of one texture of `w`×`h` with mips. @param {number} w @param {number} h
 * @param {'rgba8' | 'etc1sOpaque' | 'etc1sAlpha' | 'uastc'} kind
 */
export function gpuBytes(w, h, kind) {
	return Math.round(w * h * GPU_BYTES_PER_PIXEL[kind] * (4 / 3));
}

/** The long side of `w`×`h` brought within `max` (0 = no limit), aspect kept, at least 1.
 * @param {number} w @param {number} h @param {number} max @returns {[number, number]} */
export function fitSize(w, h, max) {
	if (!max || Math.max(w, h) <= max) return [w, h];
	const s = max / Math.max(w, h);
	return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

/** "12.3 MB" / "840 KB" for a report sentence. @param {number} bytes */
export function shortBytes(bytes) {
	if (!Number.isFinite(bytes)) return '?';
	if (bytes >= 1024 * 1024) return Math.round((bytes / (1024 * 1024)) * 10) / 10 + ' MB';
	if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
	return bytes + ' B';
}

/** "−63%" for before → after (never "−0%"; growth reads "+N%"). @param {number} before @param {number} after */
export function percentChange(before, after) {
	if (!before) return '';
	const p = Math.round((1 - after / before) * 100);
	return p > 0 ? '−' + p + '%' : p < 0 ? '+' + -p + '%' : '±0%';
}

/**
 * The Basis encoder options for one texture (ktx2-encoder's option names). ONE place, so the
 * Worker and the unit suite encode alike. ETC1S at quality 128 / effort 1 is the gltf-transform
 * CLI's default; UASTC (normal maps) takes Zstandard supercompression, or it would be the
 * largest thing in the file. Mipmaps always: a KTX2 without them shimmers at a distance.
 * @param {{mode: 'etc1s' | 'uastc', srgb: boolean, normal: boolean}} t
 */
export function ktx2EncodeOptions(t) {
	return {
		isUASTC: t.mode === 'uastc',
		isNormalMap: !!t.normal,
		isSetKTX2SRGBTransferFunc: !!t.srgb,
		isPerceptual: !!t.srgb,
		generateMipmap: true,
		needSupercompression: t.mode === 'uastc',
		qualityLevel: 128,
		compressionLevel: 1,
		isYFlip: false
	};
}
