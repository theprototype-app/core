// Material parameters: which keys may be set, and what value each one takes. A LEAF (no three, no
// stores) shared by the one write path (materialsHandler.setMaterialParam — local edits, undo, and every
// replicated `materialParam` message), the AI tools' update_objects, and wireValidate. A material key
// written with the wrong kind of value (a texture slot handed a string, a colour handed an object)
// breaks the renderer on every peer that applies it, so the value is checked and coerced here, once.

/** numbers, with the range each is clamped into */
export const NUMBER_PARAMS = /** @type {Record<string, [number, number]>} */ ({
	roughness: [0, 1],
	metalness: [0, 1],
	opacity: [0, 1],
	clearcoat: [0, 1],
	clearcoatRoughness: [0, 1],
	transmission: [0, 1],
	ior: [1, 2.333],
	shininess: [0, 1000],
	emissiveIntensity: [0, 100],
	reflectivity: [0, 1],
	refractionRatio: [0, 1],
	sheen: [0, 1],
	sheenRoughness: [0, 1],
	iridescence: [0, 1],
	anisotropy: [0, 1],
	specularIntensity: [0, 1],
	thickness: [0, 100],
	alphaTest: [0, 1],
	envMapIntensity: [0, 100],
	aoMapIntensity: [0, 10],
	lightMapIntensity: [0, 10],
	bumpScale: [-10, 10],
	displacementScale: [-100, 100],
	displacementBias: [-100, 100],
	dispersion: [0, 10],
	attenuationDistance: [0, 1e6],
	wireframeLinewidth: [0, 10]
});

/** booleans */
export const BOOL_PARAMS = new Set(['wireframe', 'transparent', 'flatShading', 'vertexColors', 'fog', 'depthTest', 'depthWrite', 'toneMapped', 'dithering']);

/** colours (sent as '#rrggbb') */
export const COLOR_PARAMS = new Set(['color', 'emissive', 'specular', 'sheenColor', 'attenuationColor', 'specularColor']);

/** `side`: FrontSide 0 · BackSide 1 · DoubleSide 2 */
const SIDES = /** @type {Record<string, number>} */ (Object.assign(Object.create(null), { front: 0, back: 1, double: 2 }));

/** texture slots: a Texture (a local caller), or null to clear — never anything else */
export const TEXTURE_PARAMS = new Set([
	'map', 'emissiveMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap', 'bumpMap', 'displacementMap',
	'envMap', 'lightMap', 'specularMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'transmissionMap',
	'thicknessMap', 'sheenColorMap', 'sheenRoughnessMap', 'iridescenceMap', 'iridescenceThicknessMap', 'anisotropyMap',
	'specularIntensityMap', 'specularColorMap', 'gradientMap', 'matcap'
]);

/** own keys only — `'__proto__' in NUMBER_PARAMS` is true @param {string} key */
const isNumberKey = (key) => Object.prototype.hasOwnProperty.call(NUMBER_PARAMS, key);

/** @param {string} key */
export function isMaterialParamKey(key) {
	return typeof key === 'string' && (isNumberKey(key) || BOOL_PARAMS.has(key) || COLOR_PARAMS.has(key) || key === 'side' || TEXTURE_PARAMS.has(key));
}

/** '#rgb' / '#rrggbb' / 'rrggbb' / 0xrrggbb → '#rrggbb', else null @param {any} value */
export function toHexColor(value) {
	if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff) return '#' + value.toString(16).padStart(6, '0');
	if (typeof value !== 'string') return null;
	const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
	if (!m) return null;
	const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
	return '#' + h.toLowerCase();
}

/**
 * Check one material parameter against a material. `material` may be null (the wire check, which
 * has no object): then only the key and the value's kind are judged.
 * @param {any} material @param {any} key @param {any} value
 * @param {{texture?: boolean}} [opts] `texture: true` = a LOCAL caller handing over a THREE.Texture
 * @returns {{ok: true, value: any} | {ok: false, error: string}}
 */
export function checkMaterialParam(material, key, value, opts = {}) {
	if (!isMaterialParamKey(key)) return { ok: false, error: 'unknown material parameter "' + String(key).slice(0, 40) + '"' };
	if (material && !(key in material)) return { ok: false, error: '"' + key + '" is not a parameter of a ' + String(material.type ?? 'material') };
	if (isNumberKey(key)) {
		const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
		if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false, error: '"' + key + '" takes a number' };
		const [lo, hi] = NUMBER_PARAMS[key];
		return { ok: true, value: Math.min(hi, Math.max(lo, n)) };
	}
	if (BOOL_PARAMS.has(key)) {
		if (value === true || value === 'true' || value === 1) return { ok: true, value: true };
		if (value === false || value === 'false' || value === 0) return { ok: true, value: false };
		return { ok: false, error: '"' + key + '" takes true or false' };
	}
	if (COLOR_PARAMS.has(key)) {
		const hex = toHexColor(value);
		return hex ? { ok: true, value: hex } : { ok: false, error: '"' + key + '" takes a hex colour like "#ff8800"' };
	}
	if (key === 'side') {
		const n = typeof value === 'string' ? SIDES[value.trim().toLowerCase()] ?? Number(value) : value;
		return n === 0 || n === 1 || n === 2 ? { ok: true, value: n } : { ok: false, error: '"side" takes front, back or double (0, 1, 2)' };
	}
	// a texture slot
	if (value === null) return { ok: true, value: null };
	if (opts.texture && value && value.isTexture === true) return { ok: true, value };
	return { ok: false, error: '"' + key + '" is a texture slot: it takes a library image (its hash, on "map"), not ' + (typeof value === 'string' ? 'a string' : typeof value) };
}

// ---- 72 LK1: the Inspector's texture map slots -------------------------------------------------
// The base colour map keeps its own older `map` message; these five travel as `mapSlot`.

/** the slots, in the order the Inspector lists them. `srgb` = colour data; the rest are read as numbers */
export const MAP_SLOTS = Object.freeze([
	{ key: 'normalMap', label: 'Normal', srgb: false, hint: 'Surface detail from a normal map' },
	{ key: 'roughnessMap', label: 'Roughness', srgb: false, hint: 'Where the surface is rough or shiny (reads the green channel)' },
	{ key: 'metalnessMap', label: 'Metalness', srgb: false, hint: 'Where the surface is metal (reads the blue channel)' },
	{ key: 'emissiveMap', label: 'Emission', srgb: true, hint: 'Where the surface glows' },
	{ key: 'aoMap', label: 'AO', srgb: false, hint: 'Ambient occlusion: darkens creases (reads the red channel)' }
]);
const MAP_SLOT_KEYS = new Set(MAP_SLOTS.map((slot) => slot.key));

/** @param {any} key */
export const isMapSlotKey = (key) => typeof key === 'string' && MAP_SLOT_KEYS.has(key);

/** the longest image a `mapSlot` message may carry (a 1024 px image encodes far below this) */
export const MAP_SLOT_MAX_URL = 24 * 1024 * 1024;

/** A slot image is an inline PNG, JPEG or WebP, or null to clear. Never a URL: a peer must not be
 * able to make this machine fetch something. @param {any} value */
export function isMapSlotImage(value) {
	if (value === null) return true;
	return typeof value === 'string' && value.length <= MAP_SLOT_MAX_URL && /^data:image\/(png|jpeg|webp);base64,/.test(value);
}

export const IDENTITY_TEX_TRANSFORM = Object.freeze({ repeat: Object.freeze([1, 1]), offset: Object.freeze([0, 0]), rotation: 0 });

/** @param {any} pair @returns {pair is [number, number]} */
const isFinitePair = (pair) => Array.isArray(pair) && pair.length === 2 && pair.every((n) => typeof n === 'number' && Number.isFinite(n));

const TILING_LIMIT = 1000;
const OFFSET_LIMIT = 1000;

/**
 * Check a material's tiling / offset / rotation. Tiling keeps its sign (a negative value mirrors) but
 * never reaches 0, where every texel would collapse to one colour.
 * @param {any} raw @returns {{repeat: number[], offset: number[], rotation: number} | null}
 */
export function normalizeTexTransform(raw) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const repeat = raw.repeat === undefined ? [1, 1] : raw.repeat;
	const offset = raw.offset === undefined ? [0, 0] : raw.offset;
	const rotation = raw.rotation === undefined ? 0 : raw.rotation;
	if (!isFinitePair(repeat) || !isFinitePair(offset) || typeof rotation !== 'number' || !Number.isFinite(rotation)) return null;
	const tile = (/** @type {number} */ n) => {
		const size = Math.min(TILING_LIMIT, Math.max(0.001, Math.abs(n)));
		return n < 0 ? -size : size;
	};
	const shift = (/** @type {number} */ n) => Math.min(OFFSET_LIMIT, Math.max(-OFFSET_LIMIT, n));
	return { repeat: [tile(repeat[0]), tile(repeat[1])], offset: [shift(offset[0]), shift(offset[1])], rotation };
}

/** @param {any} t */
export function isIdentityTexTransform(t) {
	return !t || (t.repeat[0] === 1 && t.repeat[1] === 1 && t.offset[0] === 0 && t.offset[1] === 0 && t.rotation === 0);
}

export const NORMAL_STRENGTH_MAX = 10;

/** the words a texture file name uses for each map, as the common PBR exporters write them */
const MAP_NAME_WORDS = /** @type {Record<string, string>} */ (
	Object.assign(Object.create(null), {
		normal: 'normalMap', normals: 'normalMap', nor: 'normalMap', norm: 'normalMap', nrm: 'normalMap', normalgl: 'normalMap', normaldx: 'normalMap',
		roughness: 'roughnessMap', rough: 'roughnessMap', rgh: 'roughnessMap',
		metalness: 'metalnessMap', metallic: 'metalnessMap', metal: 'metalnessMap', mtl: 'metalnessMap',
		emissive: 'emissiveMap', emission: 'emissiveMap', glow: 'emissiveMap', emit: 'emissiveMap',
		ao: 'aoMap', occlusion: 'aoMap', ambientocclusion: 'aoMap',
		basecolor: 'map', basecolour: 'map', albedo: 'map', diffuse: 'map', diff: 'map', color: 'map', colour: 'map', col: 'map'
	})
);

/** the slot a file name says it is, for a set of maps picked together (a PBR export, an AI tool's
 * output): 'map' for base colour, a slot key, or null when the name says nothing. Whole words only:
 * "chaos_color" must not read as AO through the "ao" inside a longer word.
 * @param {any} name @returns {string | null} */
export function guessMapSlot(name) {
	if (typeof name !== 'string') return null;
	const stem = name.replace(/\.[a-zA-Z0-9]+$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
	const words = stem.split(/[^a-z0-9]+/).filter(Boolean);
	// the LAST word that names a map decides: in "metal_plate_diff_1k" the material is metal, the map is colour
	for (let i = words.length - 1; i >= 0; i--) {
		const slot = MAP_NAME_WORDS[words[i]];
		if (slot) return slot;
	}
	return null;
}
