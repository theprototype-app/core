// 37-hdri — the PURE half of HDRI environments (no three, no stores: unit-tested in node).
//
// An environment payload (a stock preset or a customPreset) may carry ONE additive field:
//
//   hdri: {
//     src: 'bundled:<id>' | 'hash:<sha256>',  where the pixels come from (a bundled file under
//                                             static/hdri/, or an Explorer item by content hash —
//                                             a peer without the bytes pulls them, golden rule 9)
//     name?: string,                          the file name a custom upload had (for the UI)
//     rotation: degrees 0..360,               turns the sky AND the IBL (and the rig sun with them)
//     intensity: 0..4,                        the image-based light's strength (scene.environmentIntensity)
//     background: boolean,                    show it as the sky (false = light only, the payload's colour sky shows)
//     blur: 0..1,                             softens the sky (scene.backgroundBlurriness)
//     toneMapping: 'aces' | 'agx' | 'neutral' the curve the frame is mapped with while an HDRI shows
//   }
//
// Every field is optional and read through `hdriOf` only, so a malformed value reads as
// absent and an older peer, which ignores the field, renders the payload's flat colours.

export const HDRI_TONE_MAPPINGS = /** @type {const} */ (['aces', 'agx', 'neutral']);

/** @typedef {{src: string, name: string, rotation: number, intensity: number, background: boolean, blur: number, toneMapping: string}} Hdri */

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
		toneMapping: HDRI_TONE_MAPPINGS.includes(h.toneMapping) ? h.toneMapping : 'aces'
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
