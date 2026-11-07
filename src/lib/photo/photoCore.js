// Roadmap 98 P2 (lane 98-photo) — PHOTO MODE, the pure half: every decision Photo mode makes that does not
// need a GPU, so the unit layer covers it. Imports NOTHING.
//
//   photoPlace     WHERE a path-traced still can be made: here, on a PC peer (Quest / weak phone hand-off),
//                  or nowhere (the best raster still + a plain "not on this device")
//   photoPlan      the samples / time budget, clamped (the slider's two ends and what a peer may ask of us)
//   photoDone      when the progressive loop stops: samples reached, time up, or Stop
//   meshKind       what the tracer does with one scene object (traced / per-instance proxies / left out)
//   materialKind   what it does with one material (as is / translated to a standard material / base only)
//   PHOTO_PARITY   the materials parity table the docs and the panel's "what this photo cannot show" read
//   photoRequest / photoResult   the hand-off wire shapes, validated (wireValidate reads them)
//
// TSL-portable (roadmap 2.0 S1): nothing here is renderer-specific. The tracer itself is three-gpu-pathtracer's
// WebGLPathTracer today; its `three-gpu-pathtracer/webgpu` WebGPUPathTracer is the S2 twin (photoRender.js).

/** the samples slider's ends; 1 sample is a noisy preview, 2048 is a clean interior on a 4090 */
export const PHOTO_SAMPLES = { min: 1, max: 2048, default: 256 };
/** the time slider's ends (seconds) — whichever of samples / time comes first stops the render */
export const PHOTO_SECONDS = { min: 2, max: 600, default: 60 };
/** what a PEER may ask of this machine: smaller, so a Quest cannot park someone's GPU for ten minutes */
export const PEER_LIMITS = { samples: 512, seconds: 90, maxSide: 2048 };
/** the longest side of the still (the canvas size is the default; 4K is the cap) */
export const MAX_SIDE = 4096;
/** a hand-off answer's PNG may not exceed this (peerjs carries 12 MB messages; leave headroom) */
export const MAX_RESULT_BYTES = 10 * 1024 * 1024;
/** the most instances one InstancedMesh contributes as proxies before the rest are left out */
export const INSTANCE_PROXY_CAP = 4000;

/**
 * Where can a path-traced still of this view be made?
 * @param {{
 *   xr?: boolean,          // presenting in a headset now
 *   quest?: boolean,       // a Quest browser (in or out of a session)
 *   phone?: boolean,       // the quality governor's phone verdict
 *   floatTargets?: boolean,// WebGL2 + EXT_color_buffer_float (the tracer's accumulation target)
 *   force?: boolean,       // the person pressed "Try here anyway" (phones only; never a Quest)
 *   peers?: {id: string, device?: string, name?: string}[]  // connected peers in this room, with peerFacts' device word
 * }} f
 * @returns {{place: 'here'|'peer'|'raster', peer?: string, peerName?: string, why: string}}
 */
export function photoPlace(f) {
	const pc = (f.peers ?? []).find((p) => p && p.device === 'desktop');
	const weak = !!(f.xr || f.quest || (f.phone && !f.force) || f.floatTargets === false);
	if (!weak) return { place: 'here', why: '' };
	const reason = f.floatTargets === false
		? "This device's graphics cannot path-trace."
		: f.xr || f.quest
			? 'Path tracing is too heavy for a headset.'
			: 'Path tracing is too heavy for this phone.';
	if (pc) return { place: 'peer', peer: pc.id, peerName: pc.name || 'a PC', why: reason + ' ' + (pc.name || 'A PC') + ' in this session renders it and sends it back.' };
	return { place: 'raster', why: reason + ' Not on this device: here is the best normal still. Join from a PC to render a photo.' };
}

/** @param {any} v @param {number} lo @param {number} hi @param {number} d */
function clampNum(v, lo, hi, d) {
	const n = Number(v);
	if (!Number.isFinite(n)) return d;
	return Math.min(hi, Math.max(lo, n));
}

/**
 * The budget for one render, clamped. `peer` = a request from someone else (tighter limits).
 * @param {{samples?: any, seconds?: any, width?: any, height?: any, denoise?: any}} req
 * @param {{peer?: boolean, canvas?: {width: number, height: number}}} [opts]
 * @returns {{samples: number, seconds: number, width: number, height: number, denoise: boolean}}
 */
export function photoPlan(req, opts = {}) {
	const peer = !!opts.peer;
	const samples = Math.round(clampNum(req?.samples, PHOTO_SAMPLES.min, peer ? PEER_LIMITS.samples : PHOTO_SAMPLES.max, PHOTO_SAMPLES.default));
	const seconds = clampNum(req?.seconds, PHOTO_SECONDS.min, peer ? PEER_LIMITS.seconds : PHOTO_SECONDS.max, PHOTO_SECONDS.default);
	const cap = peer ? PEER_LIMITS.maxSide : MAX_SIDE;
	let w = Math.round(clampNum(req?.width, 16, 16384, opts.canvas?.width ?? 1280));
	let h = Math.round(clampNum(req?.height, 16, 16384, opts.canvas?.height ?? 720));
	const big = Math.max(w, h);
	if (big > cap) {
		w = Math.max(16, Math.round((w * cap) / big));
		h = Math.max(16, Math.round((h * cap) / big));
	}
	return { samples, seconds, width: w, height: h, denoise: req?.denoise !== false };
}

/**
 * Stop the progressive loop?
 * @param {{samples: number, elapsedMs: number, stopped?: boolean}} s @param {{samples: number, seconds: number}} plan
 * @returns {'' | 'samples' | 'time' | 'stopped'}
 */
export function photoDone(s, plan) {
	if (s.stopped) return 'stopped';
	if (s.samples >= plan.samples) return 'samples';
	if (s.elapsedMs >= plan.seconds * 1000) return 'time';
	return '';
}

/**
 * What the tracer does with one visible scene object.
 * @param {any} o a three Object3D (duck-typed)
 * @param {{helper?: (o: any) => boolean}} [opts] the editor-helper test (grid, gizmo, edit wireframes)
 * @returns {'trace'|'instances'|'skip-helper'|'skip-text'|'skip-kind'|'skip-shader'|'other'}
 */
export function meshKind(o, opts = {}) {
	if (!o) return 'other';
	if (opts.helper?.(o)) return 'skip-helper';
	// the helper layer (lights' icons, colliders, camera frustums) lives on layers 1+ only
	if (o.layers && typeof o.layers.mask === 'number' && (o.layers.mask & 1) === 0) return 'skip-helper';
	if (o.isPoints || o.isLine || o.isSprite) return 'skip-kind';
	if (!o.isMesh) return 'other';
	// troika flat text: one instanced glyph quad per letter, drawn by its SDF shader — the tracer would see quads
	if (o.isTroikaText || o.geometry?.isInstancedBufferGeometry) return 'skip-text';
	if (o.isInstancedMesh) return 'instances';
	const mats = Array.isArray(o.material) ? o.material : [o.material];
	if (mats.some((m) => m?.isShaderMaterial || m?.isRawShaderMaterial)) return 'skip-shader';
	return 'trace';
}

/**
 * What the tracer does with one material.
 * @param {any} m
 * @returns {'standard'|'translate'|'graph-base'|'none'}
 */
export function materialKind(m) {
	if (!m) return 'none';
	if (m.isShaderMaterial || m.isRawShaderMaterial) return 'none';
	// shaderGraph.js stamps these on a graph-compiled clone (inject backend: a standard material + onBeforeCompile)
	const graph = !!(m.userData?.shaderUniforms || m.userData?.shaderTextureRefs);
	if (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) return graph ? 'graph-base' : 'standard';
	// basic / lambert / phong / toon / matcap: colour, map, emissive and opacity carry over to a standard twin
	return 'translate';
}

/**
 * The standard-material parameters a non-standard material translates to (photoRender builds the twin).
 * @param {any} m @returns {Record<string, any>}
 */
export function translateParams(m) {
	/** @type {Record<string, any>} */
	const p = {};
	for (const k of ['color', 'map', 'emissive', 'emissiveMap', 'emissiveIntensity', 'opacity', 'transparent', 'alphaMap', 'side', 'normalMap', 'aoMap'])
		if (m?.[k] !== undefined && m[k] !== null) p[k] = m[k];
	// a basic (unlit) material reads as self-lit: its colour becomes emission so it is not darker than on screen
	if (m?.isMeshBasicMaterial) {
		p.emissive = m.color;
		p.emissiveMap = m.map ?? null;
		p.emissiveIntensity = 1;
	}
	p.roughness = m?.isMeshPhongMaterial ? Math.max(0.05, 1 - Math.min(1, (m.shininess ?? 30) / 100)) : 0.9;
	p.metalness = 0;
	return p;
}

/**
 * The materials parity table: what a photo shows for each material / object kind in this app, and the
 * fallback. ONE list for the panel's note, the docs page and the int's parity row.
 */
export const PHOTO_PARITY = Object.freeze([
	{ kind: 'pbr', label: 'PBR materials (standard / physical)', shows: 'yes', fallback: '' },
	{ kind: 'emissive', label: 'Emissive surfaces', shows: 'yes', fallback: 'they glow and light the scene, but converge more slowly than lamps' },
	{ kind: 'glass', label: 'Glass (transmission, thickness, IOR)', shows: 'yes', fallback: '' },
	{ kind: 'basic', label: 'Basic, Lambert, Phong, Toon materials', shows: 'approx', fallback: 'drawn as a matte standard material with the same colour and texture; Basic counts as self-lit' },
	{ kind: 'text3d', label: '3D text (extruded)', shows: 'yes', fallback: '' },
	{ kind: 'text-flat', label: 'Flat text (labels, signs)', shows: 'no', fallback: 'left out of the photo' },
	{ kind: 'graph', label: 'Shader-graph materials', shows: 'approx', fallback: "the object's base material; the graph's colours, patterns and movement are not drawn" },
	{ kind: 'code', label: 'Your own GLSL shaders', shows: 'no', fallback: 'left out of the photo' },
	{ kind: 'instances', label: 'Scattered and instanced objects', shows: 'yes', fallback: 'up to ' + INSTANCE_PROXY_CAP + ' copies per batch; more are left out' },
	{ kind: 'points', label: 'Particles, lines, sprites', shows: 'no', fallback: 'left out of the photo' },
	{ kind: 'post', label: 'Post effects (bloom, grade, vignette …)', shows: 'no', fallback: 'the photo is the clean render with tone mapping and exposure; add the look afterwards' },
	{ kind: 'water', label: 'Water surfaces', shows: 'approx', fallback: 'a still glassy surface; no waves or foam' },
	{ kind: 'hemi', label: 'Hemisphere and ambient light', shows: 'approx', fallback: 'replaced by the sky / environment light' }
]);

/** the parity rows to name for a render that met these kinds (skip counts from photoRender) @param {Record<string, number>} met */
export function parityNotes(met) {
	const map = /** @type {Record<string, string>} */ ({ 'skip-text': 'text-flat', 'skip-shader': 'code', 'skip-kind': 'points', translate: 'basic', 'graph-base': 'graph', 'instances-cut': 'instances' });
	const out = [];
	for (const [k, n] of Object.entries(met ?? {})) {
		const row = PHOTO_PARITY.find((r) => r.kind === map[k]);
		if (row && n > 0) out.push({ kind: row.kind, count: n, note: row.label + ': ' + row.fallback });
	}
	return out;
}

// ---------------------------------------------------------------- the hand-off wire (Quest / phone -> PC peer)

/** @param {any} v @param {number} n */
const isNums = (v, n) => Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * `photoreq` — {id, pos[3], quat[4], fov, near, far, width, height, samples, seconds, denoise}
 * @param {any} d @returns {boolean}
 */
export function validPhotoRequest(d) {
	return (
		!!d &&
		typeof d.id === 'string' &&
		d.id.length > 0 &&
		d.id.length <= 64 &&
		isNums(d.pos, 3) &&
		isNums(d.quat, 4) &&
		typeof d.fov === 'number' &&
		d.fov > 1 &&
		d.fov < 179 &&
		[d.width, d.height, d.samples, d.seconds].every((x) => x === undefined || (typeof x === 'number' && Number.isFinite(x)))
	);
}

/**
 * `photores` — {id, png?: bytes, error?: string, samples?, ms?, progress?}; a progress ping carries neither png nor error
 * @param {any} d @returns {boolean}
 */
export function validPhotoResult(d) {
	if (!d || typeof d.id !== 'string' || d.id.length > 64) return false;
	if (d.error !== undefined && (typeof d.error !== 'string' || d.error.length > 300)) return false;
	if (d.png !== undefined) {
		const n = d.png?.byteLength;
		if (typeof n !== 'number' || n <= 0 || n > MAX_RESULT_BYTES) return false;
	}
	for (const k of ['samples', 'ms', 'progress']) if (d[k] !== undefined && !(typeof d[k] === 'number' && Number.isFinite(d[k]))) return false;
	return true;
}

/** does a PNG start with the PNG signature? (a peer's bytes are untrusted) @param {Uint8Array} b */
export function isPng(b) {
	const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	return !!b && b.length > 8 && sig.every((x, i) => b[i] === x);
}

/** a file name for a still: "photo-<scene>-<yyyy-mm-dd-hhmm>.png" @param {string} scene @param {Date} [d] */
export function photoFileName(scene, d = new Date()) {
	const slug = String(scene || 'scene').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'scene';
	const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
	return 'photo-' + slug + '-' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.png';
}

/** is this a Quest browser? @param {string} ua */
export function isQuestUa(ua) {
	return /OculusBrowser|Quest/i.test(String(ua || ''));
}
