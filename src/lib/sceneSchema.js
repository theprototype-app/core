// 101 F2 — THE SCHEMA FOR OBJECTS AND MATERIALS. Objects and materials are validated on receive and on load.
//
// Every ObjectLoader JSON this app takes from a peer, a file or its own stores passes through
// `validateObjectJson` (via loadGuard.js) before three sees it; a `materials` payload through
// `validateMaterialSet`. The minimum rules every entry shares live in loadGuardCore.js (standard
// material types, embedded images, size caps); this module is the full allowlist on top:
//
//   · OBJECT, MATERIAL and GEOMETRY TYPES come from fixed lists. An unknown object type becomes an
//     `Object3D` (children kept), an unknown material type the standard fallback material, an
//     unknown geometry type an empty BufferGeometry. None of that is silent: every change is a
//     `dropped` row with its path and reason, counted by loadGuard (noteWireError + one toast).
//   · FIELDS: each type has a table of the fields three writes for it, each with a value rule (a
//     finite number, a colour, a uuid, an array of N numbers, ...). An unknown field is stripped;
//     a field whose value breaks its rule is stripped too (three then uses its own default).
//   · IMAGES are embedded only (loadGuardCore) and each one is capped at MAX_IMAGE_CHARS.
//   · userData: the keys the inventory found (scripts/schema-inventory.cjs, the fixture list in
//     tests/fixtures/schema-1.65/inventory.json) keep a per-key JSON kind; every key must be plain
//     JSON (no `__proto__` / `constructor` / `prototype` keys, bounded depth) under a size cap.
//   · CAPS: tree depth, list lengths, and loadGuardCore's number / vertex / node caps.
//
// The input is cleaned IN PLACE (a scene's objects are megabytes; a copy per load would double the
// cost of every join), and the same reference comes back as `json`. Pure: imports only the pure
// loadGuardCore, never three, so the unit test needs no GL context.
//
// EXTENDING IT (a module or a later release that saves a new field): add the field to the type's
// table below with its value rule, and a fixture to tests/unit/sceneSchema.test.js. A new userData
// key needs nothing (plain JSON under the cap always passes); give it a kind in USERDATA_KINDS when
// a wrong kind must not reach its reader. See OPEN-CORE.md "Object schema".

import { guardObjectJson, guardMaterialSet, measureObjectJson, isStandardMaterial, fallbackMaterial, STANDARD_MATERIAL_TYPES, isEmbeddedUrl, MAX_NODES, MAX_NUMBERS, MAX_GENERATED_VERTICES } from './loadGuardCore.js';

/** @typedef {{path: string, reason: string}} Dropped */
/** @typedef {{ok: boolean, json: any, dropped: Dropped[], reason?: string, materials: number, images: number, textures: number}} SchemaResult */

/** Deepest object tree accepted (the shipped scenes are 3 deep; an imported model rarely passes 30). */
export const MAX_DEPTH = 256;
/** Longest resource list (geometries, materials, textures, images) one object may carry. */
export const MAX_LIST = 100_000;
/** Characters in one embedded image (the map-slot cap, materialParamRules MAP_SLOT_MAX_URL). */
export const MAX_IMAGE_CHARS = 24 * 1024 * 1024;
/** Characters of JSON one userData key may hold, and one node's whole userData. */
export const MAX_USERDATA_KEY_CHARS = 2 * 1024 * 1024;
export const MAX_USERDATA_CHARS = 4 * 1024 * 1024;
/** Nesting depth of a plain-JSON value (userData, a curve, an option block). */
export const MAX_JSON_DEPTH = 64;
/** Longest string field (names; a long name is not a reason to drop an object, so it is cut). */
export const MAX_NAME = 1024;
/** How many rows a result lists before it only counts (a hostile object could produce millions). */
const MAX_ROWS = 200;

// ---- value rules ------------------------------------------------------------------------------

/** @typedef {(v: any) => boolean} Rule */
/** @type {Rule} */ const num = (v) => typeof v === 'number' && Number.isFinite(v);
/** @type {Rule} */ const int = (v) => Number.isInteger(v);
/** @type {Rule} */ const nonNegInt = (v) => Number.isInteger(v) && v >= 0;
/** @type {Rule} */ const bool = (v) => typeof v === 'boolean';
/** @type {Rule} */ const str = (v) => typeof v === 'string' && v.length <= 4096;
/** @type {Rule} */ const uuid = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128;
/** @type {Rule} */ const color = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffff;
/** @param {number} n @returns {Rule} */
const nums = (n) => (v) => Array.isArray(v) && (n < 0 || v.length === n) && allFinite(v);
/** @type {Rule} */ const anyNums = nums(-1);
/** an Euler as three writes it: [x, y, z, order] @type {Rule} */
const euler = (v) => Array.isArray(v) && v.length === 4 && allFinite(v.slice(0, 3)) && typeof v[3] === 'string' && /^[XYZ]{3}$/.test(v[3]);
/** a material's map slot / a light's map: a texture uuid @type {Rule} */
const texRef = uuid;
/** small plain JSON (a view block, curve, option block, morph dictionary) @type {Rule} */
const plain = (v) => isPlainJson(v, 0) && jsonChars(v) <= 1024 * 1024;
/** @type {Rule} */ const uuidList = (v) => Array.isArray(v) && v.length <= MAX_LIST && v.every(uuid);
/** a mesh's material: one uuid or an array of them (a multi-slot mesh) @type {Rule} */
const materialRef = (v) => uuid(v) || (Array.isArray(v) && v.length > 0 && v.length <= 1024 && v.every(uuid));
/** a BufferAttribute JSON as InstancedMesh writes it @type {Rule} */
const attributeJson = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.type === 'string' && v.type in TYPED_ARRAYS && Array.isArray(v.array) && allFinite(v.array);
/** @type {Rule} */ const sphere = (v) => !!v && typeof v === 'object' && nums(3)(v.center) && num(v.radius);
/** @type {Rule} */ const box = (v) => !!v && typeof v === 'object' && nums(3)(v.min) && nums(3)(v.max);
/** LOD levels: [{object, distance, hysteresis}] @type {Rule} */
const lodLevels = (v) => Array.isArray(v) && v.length <= 64 && v.every((l) => l && typeof l === 'object' && uuid(l.object) && num(l.distance) && (l.hysteresis === undefined || num(l.hysteresis)));

/** every element a finite number (a loop, not `every`: geometry arrays are millions long) @param {any[]} a */
function allFinite(a) {
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		if (typeof x !== 'number' || x !== x || x === Infinity || x === -Infinity) return false;
	}
	return true;
}

/** three's BufferGeometryLoader builds `new TYPED_ARRAYS[type](array)`; anything else throws inside the parse. */
const TYPED_ARRAYS = Object.freeze(
	Object.assign(Object.create(null), {
		Int8Array: 1, Uint8Array: 1, Uint8ClampedArray: 1, Int16Array: 1, Uint16Array: 1, Int32Array: 1, Uint32Array: 1, Float32Array: 1, Float64Array: 1
	})
);

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** plain JSON: null, booleans, finite numbers, strings, arrays and objects of them, no prototype keys,
 * bounded depth. Walked without recursion past MAX_JSON_DEPTH. @param {any} v @param {number} depth */
export function isPlainJson(v, depth) {
	if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
	if (typeof v === 'number') return Number.isFinite(v);
	if (typeof v !== 'object' || depth >= MAX_JSON_DEPTH) return false;
	if (Array.isArray(v)) {
		for (let i = 0; i < v.length; i++) {
			const x = v[i];
			// the fast path for number arrays (collider hulls, stored face partitions)
			if (typeof x === 'number') {
				if (!Number.isFinite(x)) return false;
			} else if (!isPlainJson(x, depth + 1)) return false;
		}
		return true;
	}
	const proto = Object.getPrototypeOf(v);
	if (proto !== Object.prototype && proto !== null) return false;
	for (const k of Object.keys(v)) {
		if (FORBIDDEN_KEYS.has(k)) return false;
		if (!isPlainJson(v[k], depth + 1)) return false;
	}
	return true;
}

/** @param {any} v */
function jsonChars(v) {
	try {
		return JSON.stringify(v)?.length ?? 0;
	} catch {
		return Infinity;
	}
}

// ---- the tables -------------------------------------------------------------------------------

/** Fields every Object3D carries (Object3D.toJSON, ObjectLoader.parseObject). */
const OBJECT_BASE = {
	uuid,
	type: str,
	name: str,
	castShadow: bool,
	receiveShadow: bool,
	visible: bool,
	frustumCulled: bool,
	renderOrder: num,
	layers: nonNegInt,
	matrix: nums(16),
	matrixAutoUpdate: bool,
	up: nums(3),
	position: nums(3),
	rotation: (/** @type {any} */ v) => nums(3)(v) || euler(v),
	quaternion: nums(4),
	scale: nums(3),
	pivot: nums(3),
	static: bool,
	animations: uuidList,
	userData: () => true, // checked by checkUserData
	children: () => true // walked
};
const DRAWABLE = { geometry: uuid, material: materialRef };
const MORPHS = { morphTargetDictionary: plain, morphTargetInfluences: anyNums };
const LIGHT = { color, intensity: num };
const SHADOWED = { shadow: () => true }; // checked by checkShadow
const PERSPECTIVE = { fov: num, zoom: num, near: num, far: num, focus: num, aspect: num, view: plain, filmGauge: num, filmOffset: num };
const ORTHOGRAPHIC = { left: num, right: num, top: num, bottom: num, zoom: num, near: num, far: num, view: plain };

/** The object types this app writes, each with the fields three writes for it. Scene and BatchedMesh
 * are deliberately absent (nothing here saves a Scene as an object; loadGuardCore refuses BatchedMesh). */
export const OBJECT_FIELDS = /** @type {Record<string, Record<string, Rule>>} */ ({
	Object3D: OBJECT_BASE,
	Group: OBJECT_BASE,
	Bone: OBJECT_BASE,
	Mesh: { ...OBJECT_BASE, ...DRAWABLE, ...MORPHS },
	SkinnedMesh: { ...OBJECT_BASE, ...DRAWABLE, ...MORPHS, bindMode: str, bindMatrix: nums(16), skeleton: uuid },
	InstancedMesh: { ...OBJECT_BASE, ...DRAWABLE, ...MORPHS, count: nonNegInt, instanceMatrix: attributeJson, instanceColor: attributeJson, boundingSphere: sphere, boundingBox: box },
	Line: { ...OBJECT_BASE, ...DRAWABLE },
	LineLoop: { ...OBJECT_BASE, ...DRAWABLE },
	LineSegments: { ...OBJECT_BASE, ...DRAWABLE },
	Points: { ...OBJECT_BASE, ...DRAWABLE },
	Sprite: { ...OBJECT_BASE, material: uuid },
	LOD: { ...OBJECT_BASE, levels: lodLevels, autoUpdate: bool },
	PerspectiveCamera: { ...OBJECT_BASE, ...PERSPECTIVE },
	OrthographicCamera: { ...OBJECT_BASE, ...ORTHOGRAPHIC },
	AmbientLight: { ...OBJECT_BASE, ...LIGHT },
	HemisphereLight: { ...OBJECT_BASE, ...LIGHT, groundColor: color },
	DirectionalLight: { ...OBJECT_BASE, ...LIGHT, ...SHADOWED, target: uuid },
	PointLight: { ...OBJECT_BASE, ...LIGHT, ...SHADOWED, distance: num, decay: num },
	SpotLight: { ...OBJECT_BASE, ...LIGHT, ...SHADOWED, target: uuid, distance: num, decay: num, angle: num, penumbra: num, map: texRef },
	RectAreaLight: { ...OBJECT_BASE, ...LIGHT, width: num, height: num },
	LightProbe: { ...OBJECT_BASE, ...LIGHT, sh: nums(27) }
});

/** A light's shadow block (LightShadow.toJSON). Its camera is checked as a camera object. */
const SHADOW_FIELDS = { intensity: num, bias: num, normalBias: num, radius: num, blurSamples: nonNegInt, focus: num, aspect: num, mapSize: nums(2), camera: () => true };

/** Material fields three writes (Material.toJSON, every subclass), each with its rule. Map slots are
 * texture uuids; program fields are absent on purpose (a material carrying them takes the fallback). */
const MATERIAL_FIELDS = /** @type {Record<string, Rule>} */ ({
	uuid, type: str, name: str, userData: () => true, metadata: plain,
	color, emissive: color, specular: color, sheenColor: color, attenuationColor: color, specularColor: color,
	roughness: num, metalness: num, sheen: num, sheenRoughness: num, emissiveIntensity: num, specularIntensity: num,
	clearcoat: num, clearcoatRoughness: num, dispersion: num, iridescence: num, iridescenceIOR: num, iridescenceThicknessRange: nums(2),
	anisotropy: num, anisotropyRotation: num, shininess: num, reflectivity: num, refractionRatio: num, combine: int,
	transmission: num, thickness: num, attenuationDistance: (/** @type {any} */ v) => num(v) || v === null,
	lightMapIntensity: num, aoMapIntensity: num, bumpScale: num, normalMapType: int, normalScale: nums(2), clearcoatNormalScale: nums(2),
	displacementScale: num, displacementBias: num, envMapRotation: euler, envMapIntensity: num, retroreflectivity: num,
	map: texRef, matcap: texRef, alphaMap: texRef, lightMap: texRef, aoMap: texRef, bumpMap: texRef, normalMap: texRef, displacementMap: texRef,
	roughnessMap: texRef, metalnessMap: texRef, emissiveMap: texRef, specularMap: texRef, specularIntensityMap: texRef, specularColorMap: texRef,
	envMap: texRef, gradientMap: texRef, clearcoatMap: texRef, clearcoatRoughnessMap: texRef, clearcoatNormalMap: texRef, iridescenceMap: texRef,
	iridescenceThicknessMap: texRef, anisotropyMap: texRef, sheenColorMap: texRef, sheenRoughnessMap: texRef, transmissionMap: texRef, thicknessMap: texRef,
	size: num, sizeAttenuation: bool, rotation: num, scale: num, dashSize: num, gapSize: num, linewidth: num, linecap: str, linejoin: str,
	depthPacking: int, blending: int, side: (/** @type {any} */ v) => v === 0 || v === 1 || v === 2, shadowSide: (/** @type {any} */ v) => v === null || v === 0 || v === 1 || v === 2,
	vertexColors: bool, opacity: num, transparent: bool, alphaHash: bool, alphaTest: num, alphaToCoverage: bool, premultipliedAlpha: bool,
	forceSinglePass: bool, allowOverride: bool, visible: bool, toneMapped: bool, fog: bool, flatShading: bool,
	wireframe: bool, wireframeLinewidth: num, wireframeLinecap: str, wireframeLinejoin: str,
	blendSrc: int, blendDst: int, blendEquation: int, blendSrcAlpha: (/** @type {any} */ v) => v === null || int(v), blendDstAlpha: (/** @type {any} */ v) => v === null || int(v),
	blendEquationAlpha: (/** @type {any} */ v) => v === null || int(v), blendColor: color, blendAlpha: num,
	depthFunc: int, depthTest: bool, depthWrite: bool, colorWrite: bool,
	stencilWrite: bool, stencilWriteMask: int, stencilFunc: int, stencilRef: int, stencilFuncMask: int, stencilFail: int, stencilZFail: int, stencilZPass: int,
	polygonOffset: bool, polygonOffsetFactor: num, polygonOffsetUnits: num, dithering: bool, clipIntersection: bool, clipShadows: bool,
	clippingPlanes: plain
});

/** Texture fields ObjectLoader.parseTextures reads. */
const TEXTURE_FIELDS = /** @type {Record<string, Rule>} */ ({
	uuid, name: str, image: uuid, userData: () => true, metadata: plain, mapping: int, channel: nonNegInt, repeat: nums(2), offset: nums(2), center: nums(2), rotation: num,
	wrap: nums(2), format: int, internalFormat: (/** @type {any} */ v) => v === null || str(v), type: int, colorSpace: str, minFilter: int, magFilter: int,
	anisotropy: num, flipY: bool, generateMipmaps: bool, premultiplyAlpha: bool, unpackAlignment: int, compareFunction: (/** @type {any} */ v) => v === null || int(v),
	normalized: bool
});

/** The parametric geometries three rebuilds from parameters (plus the two buffer kinds). */
export const GEOMETRY_TYPES = new Set([
	'BufferGeometry', 'InstancedBufferGeometry',
	'BoxGeometry', 'CapsuleGeometry', 'CircleGeometry', 'ConeGeometry', 'CylinderGeometry', 'DodecahedronGeometry', 'ExtrudeGeometry',
	'IcosahedronGeometry', 'LatheGeometry', 'OctahedronGeometry', 'PlaneGeometry', 'PolyhedronGeometry', 'RingGeometry', 'ShapeGeometry',
	'SphereGeometry', 'TetrahedronGeometry', 'TorusGeometry', 'TorusKnotGeometry', 'TubeGeometry'
]);
/** Structured parameters of the parametric geometries (everything else must be a number or a boolean). */
const GEOMETRY_STRUCTURED = /** @type {Record<string, Rule>} */ ({
	points: (v) => Array.isArray(v) && v.length <= 100_000 && v.every((p) => (p && num(p.x) && num(p.y)) || nums(2)(p)),
	shapes: (v) => uuid(v) || uuidList(v),
	options: plain,
	path: plain,
	vertices: anyNums,
	indices: anyNums
});
/** A BufferGeometry's `data` block. */
const GEOMETRY_DATA_FIELDS = new Set(['attributes', 'index', 'groups', 'boundingSphere', 'morphAttributes', 'morphTargetsRelative', 'interleavedBuffers', 'arrayBuffers', 'drawRange']);
const ATTRIBUTE_FIELDS = /** @type {Record<string, Rule>} */ ({
	itemSize: (v) => Number.isInteger(v) && v >= 1 && v <= 16,
	type: (v) => typeof v === 'string' && v in TYPED_ARRAYS,
	array: (v) => Array.isArray(v) && allFinite(v),
	normalized: bool,
	name: str,
	usage: int,
	gpuType: int,
	updateRanges: plain
});

/** userData keys the inventory found, with the JSON kind each must have (scripts/schema-inventory.cjs).
 * 'object' = a plain object (not an array). A key not listed is plain JSON under the cap. */
export const USERDATA_KINDS = /** @type {Record<'object'|'material'|'geometry'|'texture', Record<string, 'object'|'number'|'boolean'|'string'|'array'>>} */ ({
	object: {
		bubbles: 'object', camera: 'object', checkpoint: 'object', device: 'object', drumPad: 'number', drumStep: 'number', flowPath: 'object',
		fluid: 'object', fluidEmitter: 'object', fluidInteraction: 'string', geometryParams: 'object', lod: 'object', midi: 'number',
		packRef: 'object', packStub: 'boolean', particles: 'object', physics: 'object', pick: 'string', portal: 'object', samplerPad: 'number',
		shadow: 'boolean', shadowMapSize: 'number', spline: 'object', terrain: 'boolean', textPath: 'object', transport: 'string', water: 'object',
		origin: 'array', measure: 'object', character: 'object', attachTo: 'object', clipRefs: 'array', animGraph: 'object', __uuid: 'string', __localOnly: 'boolean'
	},
	material: { mapDataUrl: 'string', mapSource: 'string', fbLit: 'boolean', fbTeam: 'string', tpEdited: 'boolean', wvCore: 'number', __jiggleClone: 'boolean' },
	geometry: { flowLength: 'number', __topo: 'object', shading: 'string' },
	texture: {}
});

/** @param {any} v */
function kindOf(v) {
	if (v === null) return 'null';
	if (Array.isArray(v)) return 'array';
	return typeof v;
}

// ---- the walk ---------------------------------------------------------------------------------

class Report {
	constructor() {
		/** @type {Dropped[]} */
		this.rows = [];
		this.count = 0;
	}
	/** @param {string} path @param {string} reason */
	add(path, reason) {
		this.count++;
		if (this.rows.length < MAX_ROWS) this.rows.push({ path, reason });
	}
}

/** Strip the fields of `obj` the table does not know or whose value breaks its rule.
 * @param {any} obj @param {Record<string, Rule>} table @param {string} at @param {Report} r */
function filterFields(obj, table, at, r) {
	for (const key of Object.keys(obj)) {
		const rule = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
		if (!rule) {
			delete obj[key];
			r.add(at + '.' + key, 'field');
			continue;
		}
		if (key === 'name' && typeof obj.name === 'string' && obj.name.length > MAX_NAME) {
			obj.name = obj.name.slice(0, MAX_NAME);
			r.add(at + '.name', 'value');
			continue;
		}
		let ok;
		try {
			ok = rule(obj[key]);
		} catch {
			ok = false;
		}
		if (!ok) {
			delete obj[key];
			r.add(at + '.' + key, 'value');
		}
	}
}

/** Check a node's userData in place. @param {any} holder @param {'object'|'material'|'geometry'|'texture'} scope @param {string} at @param {Report} r */
function checkUserData(holder, scope, at, r) {
	if (!('userData' in holder)) return;
	const ud = holder.userData;
	if (!ud || typeof ud !== 'object' || Array.isArray(ud) || (Object.getPrototypeOf(ud) !== Object.prototype && Object.getPrototypeOf(ud) !== null)) {
		delete holder.userData;
		r.add(at + '.userData', 'userData');
		return;
	}
	const kinds = USERDATA_KINDS[scope];
	let total = 0;
	for (const key of Object.keys(ud)) {
		const v = ud[key];
		const path = at + '.userData.' + key;
		if (FORBIDDEN_KEYS.has(key)) {
			delete ud[key];
			r.add(path, 'userData');
			continue;
		}
		const want = Object.prototype.hasOwnProperty.call(kinds, key) ? kinds[key] : null;
		if (want && kindOf(v) !== want && v !== null) {
			delete ud[key];
			r.add(path, 'userData kind');
			continue;
		}
		if (!isPlainJson(v, 0)) {
			delete ud[key];
			r.add(path, 'userData');
			continue;
		}
		const chars = jsonChars(v);
		if (chars > MAX_USERDATA_KEY_CHARS || total + chars > MAX_USERDATA_CHARS) {
			delete ud[key];
			r.add(path, 'userData size');
			continue;
		}
		total += chars;
	}
	if (scope === 'material' && typeof ud.mapDataUrl === 'string' && ud.mapDataUrl.length > MAX_IMAGE_CHARS) {
		delete ud.mapDataUrl;
		r.add(at + '.userData.mapDataUrl', 'image size');
	}
}

/** @param {any} list @param {string} name @param {Report} r @returns {any[]|null} */
function listOf(list, name, r) {
	if (list === undefined) return null;
	if (!Array.isArray(list)) return null; // loadGuardCore refuses a non-array list
	if (list.length > MAX_LIST) {
		list.length = MAX_LIST;
		r.add(name, 'count');
	}
	return list;
}

/** @param {any[]} materials @param {string} at @param {Report} r */
function checkMaterials(materials, at, r) {
	for (let i = 0; i < materials.length; i++) {
		const path = `${at}[${i}]`;
		let m = materials[i];
		if (!m || typeof m !== 'object' || Array.isArray(m)) {
			materials[i] = fallbackMaterial(null);
			r.add(path, 'type');
			continue;
		}
		if (!isStandardMaterial(m)) {
			r.add(path, STANDARD_MATERIAL_TYPES.has(m.type) ? 'program' : 'type');
			m = materials[i] = fallbackMaterial(m);
		}
		filterFields(m, MATERIAL_FIELDS, path, r);
		checkUserData(m, 'material', path, r);
	}
}

/** @param {any[]} textures @param {string} at @param {Report} r */
function checkTextures(textures, at, r) {
	for (let i = 0; i < textures.length; i++) {
		const t = textures[i];
		if (!t || typeof t !== 'object' || Array.isArray(t)) continue; // loadGuardCore drops it (no image)
		filterFields(t, TEXTURE_FIELDS, `${at}[${i}]`, r);
		checkUserData(t, 'texture', `${at}[${i}]`, r);
	}
}

/** Drop images over the size cap (the not-embedded ones are loadGuardCore's; their textures follow).
 * @param {any[]} images @param {string} at @param {Report} r */
function checkImages(images, at, r) {
	for (let i = images.length - 1; i >= 0; i--) {
		const image = images[i];
		const urls = Array.isArray(image?.url) ? image.url : [image?.url];
		const tooBig = urls.some((/** @type {any} */ u) => typeof u === 'string' && u.length > MAX_IMAGE_CHARS);
		const notEmbedded = urls.some((/** @type {any} */ u) => typeof u === 'string' && !isEmbeddedUrl(u));
		if (tooBig) {
			images.splice(i, 1);
			r.add(`${at}[${i}]`, 'image size');
		} else if (notEmbedded) r.add(`${at}[${i}]`, 'image');
		else if (image && typeof image === 'object') {
			for (const key of Object.keys(image))
				if (key !== 'uuid' && key !== 'url') {
					delete image[key];
					r.add(`${at}[${i}].${key}`, 'field');
				}
		}
	}
}

/** @param {any} data @param {string} at @param {Report} r */
function checkGeometryData(data, at, r) {
	for (const key of Object.keys(data))
		if (!GEOMETRY_DATA_FIELDS.has(key)) {
			delete data[key];
			r.add(at + '.' + key, 'field');
		}
	/** @param {any} a @param {string} path @returns {boolean} keep */
	const attribute = (a, path) => {
		if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
		if (a.isInterleavedBufferAttribute) return uuid(a.data) && int(a.itemSize) && int(a.offset);
		if (!ATTRIBUTE_FIELDS.type(a.type) || !ATTRIBUTE_FIELDS.array(a.array) || !ATTRIBUTE_FIELDS.itemSize(a.itemSize)) return false;
		filterFields(a, ATTRIBUTE_FIELDS, path, r);
		return true;
	};
	if (data.attributes && typeof data.attributes === 'object' && !Array.isArray(data.attributes)) {
		for (const name of Object.keys(data.attributes))
			if (FORBIDDEN_KEYS.has(name) || !attribute(data.attributes[name], `${at}.attributes.${name}`)) {
				delete data.attributes[name];
				r.add(`${at}.attributes.${name}`, 'value');
			}
	}
	if (data.morphAttributes && typeof data.morphAttributes === 'object' && !Array.isArray(data.morphAttributes)) {
		for (const name of Object.keys(data.morphAttributes)) {
			const list = data.morphAttributes[name];
			if (FORBIDDEN_KEYS.has(name) || !Array.isArray(list) || !list.every((a, i) => attribute(a, `${at}.morphAttributes.${name}[${i}]`))) {
				delete data.morphAttributes[name];
				r.add(`${at}.morphAttributes.${name}`, 'value');
			}
		}
	}
	if (data.index !== undefined && data.index !== null) {
		const ix = data.index;
		const ok = ix && typeof ix === 'object' && (ix.type === 'Uint16Array' || ix.type === 'Uint32Array') && Array.isArray(ix.array) && allFinite(ix.array);
		if (!ok) {
			delete data.index;
			r.add(at + '.index', 'value');
		}
	}
	if (data.groups !== undefined && !(Array.isArray(data.groups) && data.groups.length <= 4096 && data.groups.every((/** @type {any} */ g) => g && num(g.start) && num(g.count) && (g.materialIndex === undefined || nonNegInt(g.materialIndex))))) {
		delete data.groups;
		r.add(at + '.groups', 'value');
	}
	if (data.boundingSphere !== undefined && !sphere(data.boundingSphere)) {
		delete data.boundingSphere;
		r.add(at + '.boundingSphere', 'value');
	}
	if (data.morphTargetsRelative !== undefined && !bool(data.morphTargetsRelative)) {
		delete data.morphTargetsRelative;
		r.add(at + '.morphTargetsRelative', 'value');
	}
	if (data.drawRange !== undefined && !(data.drawRange && num(data.drawRange.start) && num(data.drawRange.count))) {
		delete data.drawRange;
		r.add(at + '.drawRange', 'value');
	}
}

/** @param {any[]} geometries @param {string} at @param {Report} r */
function checkGeometries(geometries, at, r) {
	for (let i = 0; i < geometries.length; i++) {
		const g = geometries[i];
		const path = `${at}[${i}]`;
		if (!g || typeof g !== 'object' || Array.isArray(g)) continue; // loadGuardCore refuses
		if (!GEOMETRY_TYPES.has(g.type)) {
			geometries[i] = { uuid: typeof g.uuid === 'string' ? g.uuid : undefined, type: 'BufferGeometry', data: { attributes: {} } };
			r.add(path, 'type');
			continue;
		}
		const buffer = g.type === 'BufferGeometry' || g.type === 'InstancedBufferGeometry';
		for (const key of Object.keys(g)) {
			const v = g[key];
			if (key === 'uuid' || key === 'type') continue;
			if (key === 'name') {
				if (!str(v)) {
					delete g.name;
					r.add(path + '.name', 'value');
				}
				continue;
			}
			if (key === 'userData') continue;
			const structured = Object.prototype.hasOwnProperty.call(GEOMETRY_STRUCTURED, key) ? GEOMETRY_STRUCTURED[key] : null;
			if (buffer) {
				// a buffer geometry baked from a parametric one keeps its parameters (three ignores them)
				if (key === 'data' && v && typeof v === 'object' && !Array.isArray(v)) checkGeometryData(v, path + '.data', r);
				else if (structured && structured(v)) continue;
				else {
					delete g[key];
					r.add(path + '.' + key, key === 'data' ? 'value' : 'field');
				}
				continue;
			}
			const ok = structured ? structured(v) : num(v) || bool(v);
			if (!ok) {
				delete g[key];
				r.add(path + '.' + key, structured ? 'value' : 'field');
			}
		}
		checkUserData(g, 'geometry', path, r);
	}
}

/** @param {any} shadow @param {string} at @param {Report} r */
function checkShadow(shadow, at, r) {
	filterFields(shadow, SHADOW_FIELDS, at, r);
	const cam = shadow.camera;
	if (cam === undefined) return;
	if (!cam || typeof cam !== 'object' || (cam.type !== 'OrthographicCamera' && cam.type !== 'PerspectiveCamera')) {
		delete shadow.camera;
		r.add(at + '.camera', 'type');
		return;
	}
	filterFields(cam, OBJECT_FIELDS[cam.type], at + '.camera', r);
	// a shadow camera has no children or userData of its own worth carrying
	for (const k of ['children', 'userData'])
		if (k in cam) {
			delete cam[k];
			r.add(at + '.camera.' + k, 'field');
		}
}

/** Walk the object tree (no recursion: a deep chain must not overflow this walk). @param {any} root @param {Report} r */
function checkObjectTree(root, r) {
	/** @type {Array<[any, string, number]>} */
	const stack = [[root, 'object', 1]];
	while (stack.length) {
		const [node, at, depth] = /** @type {[any, string, number]} */ (stack.pop());
		if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
		let table = Object.prototype.hasOwnProperty.call(OBJECT_FIELDS, node.type) ? OBJECT_FIELDS[node.type] : null;
		if (!table) {
			r.add(at, 'type');
			node.type = 'Object3D';
			table = OBJECT_FIELDS.Object3D;
		}
		filterFields(node, table, at, r);
		if (node.shadow !== undefined) {
			if (node.shadow && typeof node.shadow === 'object' && !Array.isArray(node.shadow)) checkShadow(node.shadow, at + '.shadow', r);
			else {
				delete node.shadow;
				r.add(at + '.shadow', 'value');
			}
		}
		checkUserData(node, 'object', at, r);
		if (node.children !== undefined) {
			if (!Array.isArray(node.children)) {
				delete node.children;
				r.add(at + '.children', 'value');
			} else if (depth >= MAX_DEPTH && node.children.length) {
				node.children = [];
				r.add(at + '.children', 'depth');
			} else for (let i = node.children.length - 1; i >= 0; i--) stack.push([node.children[i], `${at}.children[${i}]`, depth + 1]);
		}
	}
}

/** @param {Report} r @param {any} json @param {{ok: boolean, reason?: string, materials: number, images: number, textures: number}} guard
 * @returns {SchemaResult} */
function result(r, json, guard) {
	if (r.count > r.rows.length) r.rows.push({ path: '…', reason: `${r.count - r.rows.length} more` });
	return { ok: guard.ok, json, dropped: guard.ok ? r.rows : [{ path: '', reason: guard.reason ?? 'refused' }, ...r.rows], reason: guard.reason, materials: guard.materials, images: guard.images, textures: guard.textures };
}

/**
 * Validate one ObjectLoader JSON IN PLACE. `ok: false` = do not parse it at all; otherwise `json`
 * (the same reference) is safe to hand to three and `dropped` lists what was changed.
 * @param {any} json @returns {SchemaResult}
 */
export function validateObjectJson(json) {
	const r = new Report();
	// the size and shape rules first: a refused object is not walked at all
	if (!json || typeof json !== 'object' || Array.isArray(json)) return result(r, json, { ok: false, reason: 'shape', materials: 0, images: 0, textures: 0 });
	const sizeOnly = sizeVerdict(json);
	if (!sizeOnly.ok) return result(r, json, sizeOnly);
	for (const key of Object.keys(json))
		if (!TOP_LEVEL.has(key)) {
			delete json[key];
			r.add(key, 'field');
		}
	const geometries = listOf(json.geometries, 'geometries', r);
	if (geometries) checkGeometries(geometries, 'geometries', r);
	const materials = listOf(json.materials, 'materials', r);
	if (materials) checkMaterials(materials, 'materials', r);
	const textures = listOf(json.textures, 'textures', r);
	if (textures) checkTextures(textures, 'textures', r);
	const images = listOf(json.images, 'images', r);
	if (images) checkImages(images, 'images', r);
	// shapes (curves), skeletons (bone uuids + inverse matrices), clips (keyframe tracks): plain JSON entries
	for (const key of ['shapes', 'skeletons', 'animations']) {
		const list = listOf(json[key], key, r);
		if (!list) continue;
		for (let i = list.length - 1; i >= 0; i--)
			if (!list[i] || typeof list[i] !== 'object' || Array.isArray(list[i]) || !isPlainJson(list[i], 0)) {
				list.splice(i, 1);
				r.add(`${key}[${i}]`, 'value');
			}
	}
	if (json.object && typeof json.object === 'object') checkObjectTree(json.object, r);
	// then loadGuardCore's own pass (fallback materials it would make are already made, so it only
	// drops the images that are not embedded and the textures that read them)
	const guard = guardObjectJson(json);
	return result(r, json, guard);
}

/** The keys an ObjectLoader JSON may have at its top. */
const TOP_LEVEL = new Set(['metadata', 'geometries', 'materials', 'textures', 'images', 'shapes', 'skeletons', 'animations', 'object']);

/** loadGuardCore's size and shape verdict, before anything is edited. @param {any} json */
function sizeVerdict(json) {
	const size = measureObjectJson(json);
	const reason = size.bad ?? (size.nodes > MAX_NODES ? 'nodes' : size.numbers > MAX_NUMBERS ? 'size' : size.vertices > MAX_GENERATED_VERTICES ? 'geometry' : null);
	return { ok: !reason, reason: reason ?? undefined, materials: 0, images: 0, textures: 0 };
}

/**
 * Validate a `{materials, textures, images, mapDataUrls?, mapSources?, groups?}` payload (the
 * `objectParameters` materials message) IN PLACE.
 * @param {any} payload @returns {SchemaResult}
 */
export function validateMaterialSet(payload) {
	const r = new Report();
	if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.materials))
		return result(r, payload, { ok: false, reason: 'shape', materials: 0, images: 0, textures: 0 });
	const known = new Set(['materials', 'textures', 'images', 'mapDataUrls', 'mapSources', 'groups']);
	for (const key of Object.keys(payload))
		if (!known.has(key)) {
			delete payload[key];
			r.add(key, 'field');
		}
	checkMaterials(payload.materials, 'materials', r);
	if (Array.isArray(payload.textures)) checkTextures(payload.textures, 'textures', r);
	if (Array.isArray(payload.images)) checkImages(payload.images, 'images', r);
	if (payload.groups !== undefined && !(Array.isArray(payload.groups) && payload.groups.length <= 4096 && payload.groups.every((/** @type {any} */ g) => g && num(g.start) && num(g.count) && nonNegInt(g.materialIndex)))) {
		delete payload.groups;
		r.add('groups', 'value');
	}
	if (Array.isArray(payload.mapSources))
		payload.mapSources = payload.mapSources.map((/** @type {any} */ s, /** @type {number} */ i) => {
			if (s === null || s === undefined || (typeof s === 'string' && s.length <= 128)) return s;
			r.add(`mapSources[${i}]`, 'value');
			return null;
		});
	const guard = guardMaterialSet(payload);
	return result(r, payload, guard);
}

/**
 * The receive-side VERDICT for an ObjectLoader JSON, without editing it (wireValidate's `object` row):
 * false = drop the message before any applier runs. The cleaning itself happens in the applier
 * (loadGuard.parseCheckedObject), where what it changes is counted.
 * @param {any} json @returns {boolean}
 */
export function objectJsonVerdict(json) {
	if (!json || typeof json !== 'object' || Array.isArray(json)) return false;
	if (!json.object || typeof json.object !== 'object' || Array.isArray(json.object)) return false;
	for (const key of ['geometries', 'materials', 'textures', 'images', 'shapes', 'skeletons', 'animations'])
		if (json[key] !== undefined && !(Array.isArray(json[key]) && json[key].length <= MAX_LIST)) return false;
	return sizeVerdict(json).ok;
}

/**
 * The receive-side verdict for a `materials` payload (wireValidate's objectParameters `materials` row).
 * @param {any} payload @returns {boolean}
 */
export function materialSetVerdict(payload) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
	if (!Array.isArray(payload.materials) || payload.materials.length === 0 || payload.materials.length > 1024) return false;
	for (const key of ['textures', 'images', 'mapDataUrls', 'mapSources', 'groups'])
		if (payload[key] !== undefined && payload[key] !== null && !(Array.isArray(payload[key]) && payload[key].length <= MAX_LIST)) return false;
	return payload.materials.every((/** @type {any} */ m) => !!m && typeof m === 'object' && !Array.isArray(m));
}
