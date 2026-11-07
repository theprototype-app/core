// 98 P1 — the BAKE RECORD (scene data) and the per-tier BAKE BUDGET. ZERO IMPORTS.
//
// The record is the whole of what a bake leaves in a scene: two Explorer content hashes (the
// atlas PNG and its phone / Quest copy) and, per baked object, where it sits in the atlas and how
// its lightmap UVs are rebuilt. It replicates latest-wins (`scenebake`), saves in the .tpscene as
// `bake` (absent when there is none, so an old scene and a scene saved without a bake are
// byte-identical to what 1.62 wrote) and undoes as ONE `bake` history step. The pixels ride the
// content-hash push / pull every other scene asset uses.

export const BAKE_VERSION = 1;
const MAX_OBJECTS = 4000;

/**
 * PER-TIER BUDGET. `atlas` = the side baked on this device; `rays` per texel; `timeCapMs` = the
 * bake stops sampling (and keeps what it has) past this; `maxDensity` texels per world metre;
 * `downloadBytes` = the most a device of this tier fetches for baked maps (it takes the full map
 * when it fits, else the small copy, else shows the scene unbaked with a note); `maxSide` = the
 * largest map it will put on its GPU.
 */
export const BAKE_TIERS = Object.freeze({
	pc: Object.freeze({ atlas: 1024, maxAtlas: 2048, rays: 64, timeCapMs: 120000, maxDensity: 64, workers: 4, downloadBytes: 16 * 1024 * 1024, maxSide: 2048 }),
	phone: Object.freeze({ atlas: 512, maxAtlas: 1024, rays: 32, timeCapMs: 60000, maxDensity: 32, workers: 2, downloadBytes: 2 * 1024 * 1024, maxSide: 1024 }),
	quest: Object.freeze({ atlas: 512, maxAtlas: 512, rays: 24, timeCapMs: 45000, maxDensity: 24, workers: 2, downloadBytes: 1024 * 1024, maxSide: 512 })
});
/** the small copy every bake also writes, for phones and Quest */
export const LITE_SIDE = 512;

export const BAKE_QUALITIES = /** @type {const} */ (['draft', 'normal', 'high']);

/** @param {{ quest?: boolean, phone?: boolean }} d @returns {'pc' | 'phone' | 'quest'} */
export function bakeTierOf(d) {
	return d?.quest ? 'quest' : d?.phone ? 'phone' : 'pc';
}

/**
 * The settings a bake runs with on this tier at this quality.
 * @param {'pc' | 'phone' | 'quest'} tier @param {string} [quality] @param {number} [cores] navigator.hardwareConcurrency
 */
export function bakeBudget(tier, quality = 'normal', cores = 4) {
	const t = BAKE_TIERS[tier] ?? BAKE_TIERS.pc;
	const q = BAKE_QUALITIES.includes(/** @type {any} */ (quality)) ? quality : 'normal';
	const atlas = q === 'draft' ? Math.max(256, t.atlas / 2) : q === 'high' ? Math.min(t.maxAtlas, t.atlas * 2) : t.atlas;
	const rays = q === 'draft' ? Math.max(8, t.rays / 2) : q === 'high' ? t.rays * 2 : t.rays;
	const workers = Math.max(1, Math.min(t.workers, Math.floor(Number(cores) || 2) - 1 || 1));
	// pad in FULL texels so the small copy still has >= 1 texel between charts
	const pad = Math.max(2, Math.ceil((2 * atlas) / LITE_SIDE));
	return { tier, quality: q, atlas, rays, timeCapMs: t.timeCapMs, maxDensity: t.maxDensity, workers, pad };
}

/** @param {unknown} v @param {number} lo @param {number} hi @param {number} dflt */
function num(v, lo, hi, dflt) {
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}
/** @param {unknown} v */
function hashOk(v) {
	return typeof v === 'string' && v.length > 0 && v.length <= 128 && /^[\w:.-]+$/.test(v);
}
/** @param {any} m */
function mapOf(m) {
	if (!m || !hashOk(m.hash)) return null;
	return { hash: m.hash, side: Math.round(num(m.side, 1, 8192, 512)), bytes: Math.round(num(m.bytes, 0, 1e9, 0)) };
}

/**
 * ONE boundary for every record: wire, save, undo. Anything unusable becomes null (= no bake).
 * Unknown fields on the record are KEPT (a newer peer's additions survive our round trip).
 * @param {any} raw @returns {any | null}
 */
export function normalizeBakeRecord(raw) {
	if (!raw || typeof raw !== 'object') return null;
	const full = mapOf(raw.full);
	if (!full) return null;
	const objects = (Array.isArray(raw.objects) ? raw.objects : [])
		.slice(0, MAX_OBJECTS)
		.filter((o) => o && typeof o.uuid === 'string' && o.uuid.length > 0 && o.uuid.length <= 64)
		.map((o) => ({
			...o,
			uuid: o.uuid,
			src: o.src === 'uv1' || o.src === 'uv0' ? o.src : 'auto',
			mode: o.mode === 'ao' ? 'ao' : 'full',
			pad: num(o.pad, 0, 1e6, 0),
			x: num(o.x, 0, 1, 0),
			y: num(o.y, 0, 1, 0),
			s: num(o.s, 0, 1e6, 0),
			ch: o.ch === 3 ? 3 : 2,
			sig: typeof o.sig === 'string' ? o.sig.slice(0, 32) : ''
		}));
	if (!objects.length) return null;
	const intensity = raw.intensity && typeof raw.intensity === 'object' ? raw.intensity : {};
	return {
		...raw,
		v: BAKE_VERSION,
		full,
		lite: mapOf(raw.lite),
		lightScale: num(raw.lightScale, 0, 1e6, 0),
		intensity: { light: num(intensity.light, 0, 10, 1), ao: num(intensity.ao, 0, 1, 1) },
		objects,
		lightsSig: typeof raw.lightsSig === 'string' ? raw.lightsSig.slice(0, 32) : '',
		bakedAt: num(raw.bakedAt, 0, 1e15, 0),
		changedAt: num(raw.changedAt, 0, 1e15, 0)
	};
}

/** a short stable hash of a string (FNV-1a, hex) @param {string} s */
export function shortHash(s) {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * An object's bake signature: its world matrix (to the millimetre / 0.001) and its vertex count.
 * Moving, turning, scaling or reshaping a baked object changes it — that is the stale chip.
 * @param {ArrayLike<number>} matrixWorld 16 floats @param {number} vertexCount
 */
export function objectSig(matrixWorld, vertexCount) {
	let s = String(vertexCount);
	for (let i = 0; i < 16; i++) s += ',' + Math.round(Number(matrixWorld[i]) * 1000);
	return shortHash(s);
}

/** the lights' signature (every BakeLight field, rounded) @param {any[]} lights */
export function lightsSig(lights) {
	return shortHash(
		(lights ?? [])
			.map((l) => Object.keys(l).sort().map((k) => k + ':' + (typeof l[k] === 'number' ? Math.round(l[k] * 1000) : l[k])).join(','))
			.join(';')
	);
}

/**
 * Is the bake stale? `sigs` maps uuid -> the object's current signature (missing = deleted).
 * @param {any} record @param {Map<string, string>} sigs @param {string} [lightsNow]
 * @returns {{ stale: boolean, moved: string[], missing: string[], lights: boolean }}
 */
export function staleOf(record, sigs, lightsNow) {
	/** @type {string[]} */ const moved = [];
	/** @type {string[]} */ const missing = [];
	if (!record) return { stale: false, moved, missing, lights: false };
	for (const o of record.objects) {
		const now = sigs.get(o.uuid);
		if (now === undefined) missing.push(o.uuid);
		else if (o.sig && now !== o.sig) moved.push(o.uuid);
	}
	const lights = !!(lightsNow && record.lightsSig && lightsNow !== record.lightsSig);
	return { stale: moved.length > 0 || missing.length > 0 || lights, moved, missing, lights };
}

/**
 * Which copy of the maps this device loads: the full map when it fits the tier's download and
 * side budget, else the small copy, else none (the scene shows unbaked, with a note).
 * @param {any} record @param {'pc' | 'phone' | 'quest'} tier @returns {'full' | 'lite' | null}
 */
export function mapChoice(record, tier) {
	if (!record?.full) return null;
	const t = BAKE_TIERS[tier] ?? BAKE_TIERS.pc;
	const fits = (/** @type {any} */ m) => m && m.side <= t.maxSide && (!m.bytes || m.bytes <= t.downloadBytes);
	if (fits(record.full)) return 'full';
	if (fits(record.lite)) return 'lite';
	return null;
}
