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
