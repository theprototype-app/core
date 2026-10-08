// 37 R5 — MATERIAL PRESETS, the pure half (no THREE, no DOM, no stores — unit-tested).
//
// A preset is a named LOOK: the handful of numbers and colours that make a surface read as
// wood or glass, plus up to two image maps. It is deliberately NOT a THREE material's
// toJSON: that carries a uuid, every default the renderer knows about and per-object state
// (side, wireframe, the D2 share id) that belongs to the object, not the look. A preset is
// what you would write on a swatch card.
//
// THE PAYLOAD (version 1) — every field but `version`, `label` and `type` is optional:
//   { version: 1, label, type: 'MeshStandardMaterial'|…, color: '#rrggbb' (sRGB),
//     roughness, metalness, clearcoat, clearcoatRoughness, transmission, ior, shininess,
//     emissive: '#rrggbb', emissiveIntensity, opacity, transparent, flatShading,
//     map: dataURL|null, normalMap: dataURL|null, normalScale, repeat: [u, v],
//     procedural: 'wood'|'stone'|'scales' }   ← built-ins only: the maps are generated on the device
//   40 F16 adds the THIN-FILM fields (MeshPhysicalMaterial): iridescence, iridescenceIOR,
//     iridescenceThicknessMin/Max (nm — three's iridescenceThicknessRange), thickness (the
//     transmission volume). A device may draw fewer of them than the look asks for: the look
//     TIER (materialTiers.js) drops transmission on a phone and the whole thin-film set in a
//     headset — the preset, the save and the wire always carry the authored numbers.
//
// Applying one goes through the EXISTING `objectParameters / materials` message (UV4's slot
// payload), so the wire gains only the library broadcast (`matpresets`, the `envpresets`
// shape) — an applied preset is an ordinary material replace every peer already understands.

export const PRESET_VERSION = 1;

/** the IndexedDB key prefix (beside `envpreset:`) */
export const MAT_PRESET_KEY = 'matpreset:';

/** a library broadcast is capped like the env library's (bytes of JSON, roughly) */
export const MAT_PRESETS_BROADCAST_CAP = 2_000_000;

/** longest name we keep — a swatch label, not a paragraph */
export const NAME_MAX = 40;

/** The material types a preset may carry: the lit, colourable ones. Normal/Depth/Shadow
 * derive their look from geometry or light, so a "preset" of them would be one bit. */
export const PRESET_TYPES = [
	'MeshStandardMaterial',
	'MeshPhysicalMaterial',
	'MeshPhongMaterial',
	'MeshLambertMaterial',
	'MeshToonMaterial',
	'MeshBasicMaterial'
];

/** numeric look fields, copied where the material type has them */
export const NUMERIC_FIELDS = [
	'roughness',
	'metalness',
	'clearcoat',
	'clearcoatRoughness',
	'transmission',
	'ior',
	'shininess',
	'emissiveIntensity',
	'opacity',
	'iridescence',
	'iridescenceIOR',
	'iridescenceThicknessMin',
	'iridescenceThicknessMax',
	'thickness'
];

/**
 * The starter set. Tuned for this app's lighting, which has NO image-based light until
 * 37-hdri lands — so `metal` stops at 0.8 metalness (a fully metallic surface with nothing
 * to reflect reads black), and `glass` is a clear-coated see-through surface rather than
 * transmission, which costs an extra full-scene render pass the Quest budget cannot pay.
 * `wood` and `stone` carry PROCEDURAL maps (generated on each device, never stored).
 * @type {any[]}
 */
export const STARTER_PRESETS = [
	{
		version: 1,
		id: 'wood',
		label: 'Wood',
		type: 'MeshStandardMaterial',
		color: '#b98352',
		roughness: 0.72,
		metalness: 0,
		procedural: 'wood',
		normalScale: 0.6
	},
	{
		version: 1,
		id: 'metal',
		label: 'Metal',
		type: 'MeshStandardMaterial',
		color: '#d4d8de',
		roughness: 0.32,
		metalness: 0.8
	},
	{
		version: 1,
		id: 'plastic',
		label: 'Plastic',
		type: 'MeshPhysicalMaterial',
		color: '#e0483e',
		roughness: 0.42,
		metalness: 0,
		clearcoat: 0.5,
		clearcoatRoughness: 0.25
	},
	{
		version: 1,
		id: 'glass',
		label: 'Glass',
		type: 'MeshPhysicalMaterial',
		color: '#d8f0ff',
		roughness: 0.05,
		metalness: 0,
		clearcoat: 1,
		clearcoatRoughness: 0.03,
		ior: 1.5,
		opacity: 0.3,
		transparent: true
	},
	{
		version: 1,
		id: 'stone',
		label: 'Stone',
		type: 'MeshStandardMaterial',
		color: '#9b968e',
		roughness: 0.92,
		metalness: 0,
		procedural: 'stone',
		normalScale: 1
	},
	{
		version: 1,
		id: 'rubber',
		label: 'Rubber',
		type: 'MeshStandardMaterial',
		color: '#2d2d31',
		roughness: 0.96,
		metalness: 0
	},
	{
		// 40 F16: FISH SCALES — the look the aquarium's fish wear, for anyone: a thin-film
		// iridescent sheen that shifts with the view (the silver-blue flash of a turning fish),
		// a procedural scale relief, a light clear coat and, where a device can afford the pass,
		// a hint of transmission so a fin reads thin. Recolour it in the Inspector for any fish,
		// snake, dragon or beetle shell.
		version: 1,
		id: 'fishscale',
		label: 'Fish scales',
		type: 'MeshPhysicalMaterial',
		color: '#c9d6dc',
		roughness: 0.32,
		metalness: 0.15,
		clearcoat: 0.5,
		clearcoatRoughness: 0.25,
		iridescence: 0.9,
		iridescenceIOR: 1.6,
		iridescenceThicknessMin: 180,
		iridescenceThicknessMax: 560,
		transmission: 0.12,
		thickness: 0.3,
		procedural: 'scales',
		normalScale: 0.7,
		repeat: [3, 3]
	},
	{
		version: 1,
		id: 'neon',
		label: 'Neon',
		type: 'MeshStandardMaterial',
		color: '#1c1020',
		roughness: 0.5,
		metalness: 0,
		emissive: '#ff2bd6',
		emissiveIntensity: 2.5
	}
];

/** the procedural map kinds a built-in may name (materialPresetMaps generates them) */
export const PROCEDURAL_KINDS = ['wood', 'stone', 'scales'];

/** @param {any} name */
export function cleanName(name) {
	return String(name ?? '')
		.replace(/[\u0000-\u001f]/g, '')
		.trim()
		.slice(0, NAME_MAX);
}

/** '#rrggbb' or null @param {any} value */
function hexOrNull(value) {
	if (typeof value !== 'string') return null;
	const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
	return m ? '#' + m[1].toLowerCase() : null;
}

/** a finite number clamped to [lo, hi], or undefined @param {any} v @param {number} lo @param {number} hi */
function num(v, lo, hi) {
	const n = Number(v);
	if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return undefined;
	return Math.min(hi, Math.max(lo, n));
}

/** @type {Record<string, [number, number]>} */
const RANGES = {
	roughness: [0, 1],
	metalness: [0, 1],
	clearcoat: [0, 1],
	clearcoatRoughness: [0, 1],
	transmission: [0, 1],
	ior: [1, 2.333],
	shininess: [0, 1000],
	emissiveIntensity: [0, 20],
	opacity: [0, 1],
	iridescence: [0, 1],
	iridescenceIOR: [1, 2.333],
	iridescenceThicknessMin: [0, 2000],
	iridescenceThicknessMax: [0, 2000],
	thickness: [0, 10]
};

/** a data:image URL or null — presets never carry a remote URL (a library would fetch it) @param {any} v */
function imageUrlOrNull(v) {
	return typeof v === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(v) ? v : null;
}

/**
 * Validate + normalise a payload from ANYWHERE (IndexedDB, a peer, an imported file).
 * Unknown fields are dropped, numbers clamped, colours canonicalised. Null when it is
 * not a material preset at all.
 * @param {any} input @returns {any|null}
 */
export function normalizePreset(input) {
	if (!input || typeof input !== 'object') return null;
	const type = PRESET_TYPES.includes(input.type) ? input.type : null;
	const label = cleanName(input.label);
	if (!type || !label) return null;
	/** @type {any} */
	const out = { version: PRESET_VERSION, label, type };
	if (typeof input.id === 'string' && STARTER_PRESETS.some((p) => p.id === input.id)) out.id = input.id;
	const color = hexOrNull(input.color);
	if (color) out.color = color;
	const emissive = hexOrNull(input.emissive);
	if (emissive) out.emissive = emissive;
	for (const key of NUMERIC_FIELDS) {
		const [lo, hi] = RANGES[key];
		const value = num(input[key], lo, hi);
		if (value !== undefined) out[key] = value;
	}
	if (input.transparent === true) out.transparent = true;
	if (input.flatShading === true) out.flatShading = true;
	const map = imageUrlOrNull(input.map);
	if (map) out.map = map;
	const normalMap = imageUrlOrNull(input.normalMap);
	if (normalMap) out.normalMap = normalMap;
	const normalScale = num(input.normalScale, 0, 4);
	if (normalScale !== undefined) out.normalScale = normalScale;
	if (Array.isArray(input.repeat) && input.repeat.length === 2) {
		const u = num(input.repeat[0], 0.01, 100);
		const v = num(input.repeat[1], 0.01, 100);
		if (u !== undefined && v !== undefined && (u !== 1 || v !== 1)) out.repeat = [u, v];
	}
	if (PROCEDURAL_KINDS.includes(input.procedural)) out.procedural = input.procedural;
	if (Number.isFinite(input.savedAt)) out.savedAt = input.savedAt;
	return out;
}

/** round to 4 decimals so a slider's float noise does not mint a "different" look @param {number} n */
const r4 = (n) => Math.round(n * 1e4) / 1e4;

/**
 * Snapshot a material-LIKE object (a THREE material, or a plain test double with the same
 * fields) as a preset payload. `mapUrl`/`normalMapUrl` are the data-URLs the caller found
 * for its maps — the material itself only holds GPU textures.
 * @param {any} material @param {string} label
 * @param {{mapUrl?: string|null, normalMapUrl?: string|null, procedural?: string|null}} [maps]
 */
export function snapshotLook(material, label, maps = {}) {
	/** @type {any} */
	const raw = { version: PRESET_VERSION, label, type: material?.type };
	if (!PRESET_TYPES.includes(raw.type)) raw.type = 'MeshStandardMaterial';
	if (material?.color?.getHexString) raw.color = '#' + material.color.getHexString();
	if (material?.emissive?.getHexString) {
		const emissive = '#' + material.emissive.getHexString();
		if (emissive !== '#000000') raw.emissive = emissive;
	}
	for (const key of NUMERIC_FIELDS) {
		if (typeof material?.[key] === 'number') raw[key] = r4(material[key]);
	}
	// 40 F16: three keeps the film thickness as a [min, max] pair
	const range = material?.iridescenceThicknessRange;
	if (Array.isArray(range) && range.length === 2) {
		raw.iridescenceThicknessMin = r4(range[0]);
		raw.iridescenceThicknessMax = r4(range[1]);
	}
	// …and a device drawing a lower look TIER holds the authored numbers beside the material
	const authored = material?.userData?.lookTierAuthored;
	if (authored && typeof authored === 'object')
		for (const [key, value] of Object.entries(authored)) if (typeof value === 'number' && key in raw) raw[key] = r4(value);
	// emissiveIntensity without an emissive colour is noise; opacity 1 is the default
	if (!raw.emissive) delete raw.emissiveIntensity;
	if (raw.opacity === 1) delete raw.opacity;
	if (material?.transparent) raw.transparent = true;
	if (material?.flatShading) raw.flatShading = true;
	if (maps.procedural) raw.procedural = maps.procedural;
	else {
		if (maps.mapUrl) raw.map = maps.mapUrl;
		if (maps.normalMapUrl) raw.normalMap = maps.normalMapUrl;
	}
	if (material?.normalMap && material?.normalScale && typeof material.normalScale.x === 'number')
		raw.normalScale = r4(material.normalScale.x);
	const rep = material?.map?.repeat;
	if (rep && typeof rep.x === 'number' && (rep.x !== 1 || rep.y !== 1)) raw.repeat = [r4(rep.x), r4(rep.y)];
	return normalizePreset(raw);
}

/** the fields that make two looks the same (label/id/version are names, not looks) */
const LOOK_FIELDS = [
	'type',
	'color',
	'emissive',
	...NUMERIC_FIELDS,
	'transparent',
	'flatShading',
	'procedural',
	'map',
	'normalMap',
	'repeat'
];

/**
 * Do two payloads describe the same look? Used to light the swatch the selection wears.
 * A field one side lacks counts as that type's default, so a snapshot (which reads every
 * field its material has) matches a sparse starter preset. The defaults are the ones a
 * fresh THREE material has — applyLook writes them for absent fields, so a just-applied
 * preset always matches its own snapshot.
 * @param {any} a @param {any} b
 */
export function sameLook(a, b) {
	if (!a || !b) return false;
	for (const key of LOOK_FIELDS) {
		const x = withDefault(a, key);
		const y = withDefault(b, key);
		if (Array.isArray(x) || Array.isArray(y)) {
			if (JSON.stringify(x ?? null) !== JSON.stringify(y ?? null)) return false;
		} else if (typeof x === 'number' && typeof y === 'number') {
			if (Math.abs(x - y) > 1e-3) return false;
		} else if ((x ?? null) !== (y ?? null)) return false;
	}
	return true;
}

/** @type {Record<string, any>} the fresh-material defaults applyLook relies on */
export const LOOK_DEFAULTS = {
	color: '#ffffff',
	emissive: '#000000',
	roughness: 1,
	metalness: 0,
	clearcoat: 0,
	clearcoatRoughness: 0,
	transmission: 0,
	ior: 1.5,
	shininess: 30,
	emissiveIntensity: 1,
	opacity: 1,
	iridescence: 0,
	iridescenceIOR: 1.3,
	iridescenceThicknessMin: 100,
	iridescenceThicknessMax: 400,
	thickness: 0,
	transparent: false,
	flatShading: false
};

/** which numeric fields each type actually has (so sameLook ignores the rest) */
const TYPE_FIELDS = {
	MeshStandardMaterial: ['roughness', 'metalness', 'emissiveIntensity', 'opacity'],
	MeshPhysicalMaterial: [
		'roughness',
		'metalness',
		'clearcoat',
		'clearcoatRoughness',
		'transmission',
		'ior',
		'emissiveIntensity',
		'opacity',
		'iridescence',
		'iridescenceIOR',
		'iridescenceThicknessMin',
		'iridescenceThicknessMax',
		'thickness'
	],
	MeshPhongMaterial: ['shininess', 'emissiveIntensity', 'opacity'],
	MeshLambertMaterial: ['emissiveIntensity', 'opacity'],
	MeshToonMaterial: ['emissiveIntensity', 'opacity'],
	MeshBasicMaterial: ['opacity']
};

/** the numeric fields a type has @param {string} type @returns {string[]} */
export function fieldsOf(type) {
	return /** @type {any} */ (TYPE_FIELDS)[type] ?? [];
}

/** @param {any} p @param {string} key */
function withDefault(p, key) {
	if (NUMERIC_FIELDS.includes(key) && !fieldsOf(p.type).includes(key)) return undefined;
	if (key === 'emissive' && p.type === 'MeshBasicMaterial') return undefined;
	if (key === 'emissiveIntensity' && (p.emissive ?? '#000000') === '#000000') return undefined;
	return p[key] ?? LOOK_DEFAULTS[key];
}

/**
 * A name that is free in `taken` — "Wood" → "Wood 2" → "Wood 3".
 * @param {string} name @param {string[]} taken
 */
export function uniqueName(name, taken) {
	const base = cleanName(name) || 'Material';
	const set = new Set(taken.map((t) => t.toLowerCase()));
	if (!set.has(base.toLowerCase())) return base;
	for (let i = 2; i < 1000; i++) {
		const suffix = ' ' + i;
		const candidate = base.slice(0, NAME_MAX - suffix.length) + suffix;
		if (!set.has(candidate.toLowerCase())) return candidate;
	}
	return base;
}

/**
 * Cap a library for the wire: drop presets from the END until the JSON fits.
 * @param {any[]} list @param {number} [cap]
 */
export function capLibrary(list, cap = MAT_PRESETS_BROADCAST_CAP) {
	let out = list;
	while (out.length && JSON.stringify(out).length > cap) out = out.slice(0, out.length - 1);
	return out;
}

/** CSS for a swatch: a lit-sphere look from the numbers alone (no render, no WebGL).
 * Roughness widens and dims the highlight, metalness tints it with the base colour,
 * emissive adds a glow, opacity lets the swatch's own backdrop show through.
 * @param {any} p @returns {string} a `background` value */
export function swatchBackground(p) {
	return swatchLayers(p).join(', ');
}

/** the same, as its layer list (top first; the LAST layer is the base colour)
 * @param {any} p @returns {string[]} */
export function swatchLayers(p) {
	const base = p?.color ?? '#cccccc';
	const rough = typeof p?.roughness === 'number' ? p.roughness : p?.type === 'MeshPhongMaterial' ? 0.4 : 0.6;
	const metal = typeof p?.metalness === 'number' ? p.metalness : 0;
	const spot = Math.round(18 + rough * 40); // highlight radius %
	const shine = Math.round((1 - rough) * 85 + 10); // highlight strength %
	const tint = metal > 0.5 ? base : '#ffffff';
	const glow = p?.emissive && p.emissive !== '#000000' ? p.emissive : null;
	const alpha = typeof p?.opacity === 'number' && p.opacity < 1 ? p.opacity : 1;
	const layers = [
		`radial-gradient(circle at 32% 28%, color-mix(in srgb, ${tint} ${shine}%, transparent) 0%, transparent ${spot}%)`,
		`radial-gradient(circle at 50% 50%, transparent 55%, color-mix(in srgb, #000 ${Math.round(25 + metal * 25)}%, transparent) 100%)`
	];
	if (glow) layers.push(`radial-gradient(circle at 50% 50%, ${glow} 0%, color-mix(in srgb, ${glow} 40%, transparent) 70%)`);
	// 40 F16: a thin film reads as a hue sweep across the sphere
	const irid = typeof p?.iridescence === 'number' ? p.iridescence : 0;
	if (irid > 0)
		layers.push(
			`conic-gradient(from 200deg at 60% 60%, color-mix(in srgb, #ff6ad5 ${Math.round(irid * 35)}%, transparent), color-mix(in srgb, #5ad1ff ${Math.round(irid * 35)}%, transparent), color-mix(in srgb, #8cff8a ${Math.round(irid * 30)}%, transparent), color-mix(in srgb, #ff6ad5 ${Math.round(irid * 35)}%, transparent))`
		);
	layers.push(
		alpha < 1
			? `linear-gradient(color-mix(in srgb, ${base} ${Math.round(alpha * 100)}%, transparent), color-mix(in srgb, ${base} ${Math.round(alpha * 100)}%, transparent))`
			: `linear-gradient(${base}, ${base})`
	);
	return layers;
}
