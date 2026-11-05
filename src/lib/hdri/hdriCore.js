// 37-hdri — the PURE half of HDRI environments (no three, no stores: unit-tested in node).
//
// An environment payload (a stock preset or a customPreset) may carry ONE additive field:
//
//   hdri: {
//     src: 'bundled:<id>' | 'hash:<sha256>',  where the pixels come from (a bundled sky — 59 T3:
//                                             the packs CDN, skyFetch.js — or an Explorer item by content hash —
//                                             a peer without the bytes pulls them, golden rule 9)
//     name?: string,                          the file name a custom upload had (for the UI)
//     rotation: degrees 0..360,               turns the sky AND the IBL (and the rig sun with them)
//     intensity: 0..4,                        the image-based light's strength (scene.environmentIntensity)
//     background: boolean,                    show it as the sky (false = light only, the payload's colour sky shows)
//     blur: 0..1,                             softens the sky (scene.backgroundBlurriness)
//     toneMapping: 'aces' | 'agx' | 'neutral' the curve the frame is mapped with while an HDRI shows
//     quality: 'auto'|'standard'|'high'|'max',   72 LK2: how sharp the visible sky is (a bundled sky)
//     minQuality: 'standard'|'high'|'max'        72 LK2: the floor under Auto and a player's pick
//   }
//
// Every field is optional and read through `hdriOf` only, so a malformed value reads as
// absent and an older peer, which ignores the field, renders the payload's flat colours.

export const HDRI_TONE_MAPPINGS = /** @type {const} */ (['aces', 'agx', 'neutral']);

/** the visible sky's quality names, lowest first @type {readonly string[]} */
export const SKY_QUALITIES = /** @type {const} */ (['standard', 'high', 'max']);

/** @typedef {{src: string, name: string, rotation: number, intensity: number, background: boolean, blur: number, toneMapping: string, quality: string, minQuality: string}} Hdri */

/** @param {any} v @param {number} lo @param {number} hi @param {number} fallback */
function clampNum(v, lo, hi, fallback) {
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** @param {any} src */
export function validSrc(src) {
	return typeof src === 'string' && /^(bundled:[a-z0-9-]{1,40}|hash:[0-9a-f]{16,128})$/.test(src);
}

/**
 * The normalized hdri of a payload, or null.
 * @param {any} payload @returns {Hdri | null}
 */
export function hdriOf(payload) {
	const h = payload?.hdri;
	if (!h || typeof h !== 'object' || !validSrc(h.src)) return null;
	const rot = Number(h.rotation);
	return {
		src: h.src,
		name: typeof h.name === 'string' ? h.name.slice(0, 120) : '',
		rotation: Number.isFinite(rot) ? ((rot % 360) + 360) % 360 : 0,
		intensity: clampNum(h.intensity, 0, 4, 1),
		background: h.background !== false,
		blur: clampNum(h.blur, 0, 1, 0),
		toneMapping: HDRI_TONE_MAPPINGS.includes(h.toneMapping) ? h.toneMapping : 'aces',
		quality: SKY_QUALITIES.includes(h.quality) ? h.quality : 'auto',
		minQuality: SKY_QUALITIES.includes(h.minQuality) ? h.minQuality : 'standard'
	};
}

/**
 * Merge an edit into a payload's hdri (the editEnvSky patch). `null` removes it; a patch with
 * a new `src` starts from that source with the old knobs kept (rotation etc. survive a swap).
 * @param {any} current the payload's hdri (raw) @param {any} patch
 * @returns {any} the new raw hdri, or null
 */
export function mergeHdriPatch(current, patch) {
	if (patch === null) return null;
	if (!patch || typeof patch !== 'object') return current ?? null;
	const next = { ...(current && typeof current === 'object' ? current : {}), ...patch };
	if (!validSrc(next.src)) return null;
	// drop a stale custom file name when the source changed to something that is not a file
	if (patch.src && patch.src !== current?.src && patch.name === undefined) delete next.name;
	const norm = hdriOf({ hdri: next });
	if (!norm) return null;
	// keep the payload compact: only what differs from the defaults travels
	/** @type {any} */
	const out = { src: norm.src };
	if (norm.name) out.name = norm.name;
	if (norm.rotation) out.rotation = Math.round(norm.rotation * 10) / 10;
	if (norm.intensity !== 1) out.intensity = norm.intensity;
	if (!norm.background) out.background = false;
	if (norm.blur) out.blur = norm.blur;
	if (norm.toneMapping !== 'aces') out.toneMapping = norm.toneMapping;
	if (norm.quality !== 'auto') out.quality = norm.quality;
	if (norm.minQuality !== 'standard') out.minQuality = norm.minQuality;
	return out;
}

/**
 * Which resolution this device renders an HDRI at. 'low' = the Quest tier: a 512-wide source,
 * a 128 px PMREM, and the sky drawn FROM the prefiltered PMREM (no separate equirect texture).
 * @param {{presenting?: boolean, headset?: boolean, pref?: string, postOff?: boolean}} s
 * @returns {'full' | 'low'}
 */
export function resolveHdriTier(s) {
	if (s.pref === 'low') return 'low';
	if (s.pref === 'full') return 'full';
	if (s.presenting || s.headset || s.postOff) return 'low';
	return 'full';
}

/**
 * 72 LK2 — HOW SHARP THE VISIBLE SKY IS HERE. Each peer resolves this for itself from the replicated
 * scene settings and its own device, so a phone and a desktop in one session show one sky at two
 * sizes. In order:
 *   1. a device pinned to Low stays Low (the way out for a machine that cannot afford more);
 *   2. a scene that names a quality gets it;
 *   3. a scene on Auto: the player's pick (this game's menu, else this device's Settings), else
 *      Standard where memory or data is short (headset, phone, the governor past post-off, a slow
 *      or metered connection) and High elsewhere. Auto never reaches Max on its own: 4K is ten
 *      times the download for a difference most views never show;
 *   4. the scene's minimum raises the result (a showcase can refuse a blurry sky);
 *   5. a headset never goes past High, whatever was asked: the Quest budget is not negotiable.
 * @param {{scene?: string, minimum?: string, gamePref?: string, devicePref?: string, presenting?: boolean,
 *   headset?: boolean, phone?: boolean, postOff?: boolean, slowNet?: boolean}} s
 * @returns {'standard'|'high'|'max'}
 */
export function resolveSkyQuality(s) {
	/** @param {any} q */
	const rank = (q) => SKY_QUALITIES.indexOf(q);
	if (s.devicePref === 'low') return 'standard';
	const inHeadset = !!(s.presenting || s.headset);
	/** @type {any} */
	let pick;
	if (rank(s.scene) >= 0) pick = s.scene;
	else if (rank(s.gamePref) >= 0) pick = s.gamePref;
	else if (rank(s.devicePref) >= 0) pick = s.devicePref;
	else pick = inHeadset || s.phone || s.postOff || s.slowNet ? 'standard' : 'high';
	if (rank(s.minimum) > rank(pick)) pick = s.minimum;
	if (inHeadset && rank(pick) > rank('high')) pick = 'high';
	return pick;
}

/** the pixel width of a sky file tier @param {string} tier '1k'... */
export function skyTierWidth(tier) {
	return 1024 * Number(String(tier).replace('k', ''));
}

/**
 * Which file a quality means on this machine. Max is 4K, or 8K on the sky that has one when the
 * machine can plainly take it (a whole 8K sky is 200 MB of GPU memory). A tier the GPU cannot hold
 * steps down: the cube's face is a quarter of the file's width.
 * @param {string} quality @param {string[]} tiers what the sky offers
 * @param {{maxTexture?: number, maxCube?: number, memoryGB?: number, phone?: boolean}} caps
 * @returns {string} '1k'|'2k'|'4k'|'8k'
 */
export function skyFileTier(quality, tiers, caps = {}) {
	const want = quality === 'max' ? (caps.memoryGB && caps.memoryGB >= 8 && !caps.phone ? '8k' : '4k') : quality === 'high' ? '2k' : '1k';
	const fits = (/** @type {string} */ t) =>
		tiers.includes(t) && skyTierWidth(t) <= (caps.maxTexture ?? Infinity) && skyTierWidth(t) / 4 <= (caps.maxCube ?? Infinity);
	for (const t of ['8k', '4k', '2k', '1k']) if (skyTierWidth(t) <= skyTierWidth(want) && fits(t)) return t;
	return '1k';
}

/**
 * fix-play-link (r1590-09): the Max option's label says what Max LOADS here — the same rule as
 * `skyFileTier`: 8K on a machine with >= 8 GB that is not a phone (on a sky that has an 8K file;
 * the others top out at 4K, hence "up to"), else 4K. The picker said "Max (4K)" while the PC
 * loaded the 8192 Meadow cube.
 * @param {{memoryGB?: number, phone?: boolean}} facts
 */
export function skyMaxLabel(facts = {}) {
	return facts.memoryGB && facts.memoryGB >= 8 && !facts.phone ? 'Max (up to 8K)' : 'Max (4K)';
}

/** this device's facts for `skyMaxLabel` (navigator.deviceMemory + a coarse pointer = a phone) */
export function skyMaxLabelHere() {
	try {
		const nav = /** @type {any} */ (globalThis.navigator);
		const phone = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
		return skyMaxLabel({ memoryGB: Number(nav?.deviceMemory) || 0, phone });
	} catch {
		return skyMaxLabel();
	}
}

/** A headset browser by its user agent (Quest, Pico, Vive Focus) @param {string} ua */
export function isHeadsetUA(ua) {
	return /OculusBrowser|Quest|Pico|VRShell|Wolvic|Vive/i.test(String(ua ?? ''));
}

/** The source width each tier caps at (an upload bigger than this is box-filtered down) */
export const TIER_MAX_WIDTH = { full: 1024, low: 512 };

/**
 * Box-filter an RGBA float image down by an integer power of two until it is at most
 * `maxWidth` wide. Returns the input when it already fits.
 * @param {Float32Array} data @param {number} width @param {number} height @param {number} maxWidth
 * @returns {{data: Float32Array, width: number, height: number}}
 */
export function downsampleRGBA(data, width, height, maxWidth) {
	let f = 1;
	while (width / f > maxWidth && height / f >= 2) f *= 2;
	if (f === 1) return { data, width, height };
	const w = Math.floor(width / f);
	const h = Math.floor(height / f);
	const out = new Float32Array(w * h * 4);
	const inv = 1 / (f * f);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			for (let yy = y * f; yy < y * f + f; yy++) {
				let o = (yy * width + x * f) * 4;
				for (let xx = 0; xx < f; xx++, o += 4) {
					r += data[o];
					g += data[o + 1];
					b += data[o + 2];
					a += data[o + 3];
				}
			}
			const p = (y * w + x) * 4;
			out[p] = r * inv;
			out[p + 1] = g * inv;
			out[p + 2] = b * inv;
			out[p + 3] = a * inv;
		}
	return { data: out, width: w, height: h };
}

/**
 * Turn a position about +Y by `degrees` — the rig sun follows the HDRI's rotation so the
 * shadows keep pointing away from the sun painted in the sky. three's scene.backgroundRotation
 * turns the LOOKUP direction; a positive y rotation of the sky moves its content the other way
 * round, which is what the sign here matches (checked by the hdri suite's sun-alignment probe).
 * @param {number[]} p @param {number} degrees @returns {number[]}
 */
export function rotateAboutY(p, degrees) {
	if (!degrees) return [p[0], p[1], p[2]];
	const a = (degrees * Math.PI) / 180;
	const c = Math.cos(a);
	const s = Math.sin(a);
	return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
}

/** Explorer kind for an HDRI file name @param {string} name */
export function isHdriFileName(name) {
	return /\.(hdr|exr)$/i.test(String(name ?? ''));
}
