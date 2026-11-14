// THE CHECK IN FRONT OF THREE'S GENERIC LOADERS — pure, imports nothing (so a unit test needs no GL
// and every module can reach it without a cycle). `loadGuard.js` is the reporting half.
//
// three's ObjectLoader / MaterialLoader rebuild whatever their JSON names: any material type the
// library knows (custom GPU programs included) and any image `url` (which the browser then
// requests). Objects reach those loaders from other people (the `object` and `materials`
// messages), from files (a .tpscene's `objects[]`, prefabs, a .tp project) and from this
// device's own stores. This app never saves either of those things into an object — runtime
// effects that use their own programs (water, particles, placeholders, shader graphs, custom
// code) build them on the receiving device through their own checked paths — so the rules
// below cost legitimate content nothing:
//   1. a material whose type is not one of the standard ones (or that carries program fields)
//      becomes a plain standard material keeping its uuid, name and colour;
//   2. an image must be embedded (a `data:` URL, or raw pixel data); anything else is dropped
//      together with the textures that read it;
//   3. an object whose size cannot be legitimate is refused whole.
// The full schema for scene content comes later; this is the minimum every entry shares.

/** The material types an object may carry. three's MaterialLoader also knows ShaderMaterial,
 * RawShaderMaterial and the bare base Material, and builds a bare Material for any type it
 * does not know — none of which this app writes into a saved object. */
export const STANDARD_MATERIAL_TYPES = new Set([
	'MeshStandardMaterial',
	'MeshPhysicalMaterial',
	'MeshPhongMaterial',
	'MeshLambertMaterial',
	'MeshBasicMaterial',
	'MeshToonMaterial',
	'MeshNormalMaterial',
	'MeshMatcapMaterial',
	'MeshDepthMaterial',
	'MeshDistanceMaterial',
	'ShadowMaterial',
	'SpriteMaterial',
	'PointsMaterial',
	'LineBasicMaterial',
	'LineDashedMaterial'
]);

/** Fields only a program material reads; a standard type carrying them was not written by three. */
const PROGRAM_FIELDS = ['vertexShader', 'fragmentShader', 'glslVersion', 'defines', 'extensions', 'uniforms'];

/** How many numbers (vertex data, indices, pixels, keyframes) one object may carry. The largest
 * object in the shipped scenes is ~1.9 MB of JSON; an imported 25 MB model is ~6 M floats. */
export const MAX_NUMBERS = 32_000_000;
/** How many vertices the parametric geometries of one object may ask three to generate. */
export const MAX_GENERATED_VERTICES = 16_000_000;
/** How many nodes one object tree may hold. */
export const MAX_NODES = 200_000;

/** @param {unknown} url */
export function isEmbeddedUrl(url) {
	return typeof url === 'string' && /^[\x00-\x20]*data:/i.test(url);
}

/** An address the UI may show as an image or hand to an image loader: an embedded image or one of
 * this page's own blob: URLs, nothing that would make the browser ask somebody else.
 * @param {unknown} url */
export function isLocalImageUrl(url) {
	if (typeof url !== 'string') return false;
	if (isImageDataUrl(url)) return true;
	const origin = typeof location !== 'undefined' ? location.origin : '';
	return !!origin && url.startsWith('blob:' + origin + '/') && /^[\w-]+$/.test(url.slice(origin.length + 6));
}

/** A WHOLE embedded image: `data:image/<type>[;params],<data>` where the data holds nothing that could
 * end a CSS url() or an attribute (no quotes, brackets, backslashes or white space). Such strings go
 * into <img src> and into style attributes, so the whole value is checked, not just its start.
 * @param {unknown} url */
export function isImageDataUrl(url) {
	return typeof url === 'string' && /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+=-]+)*,[^"'()\\\s<>]*$/i.test(url);
}

/** A style value (a colour, a font, a keyword) that cannot make the page fetch anything or end its
 * declaration: no functions that load (url, image, image-set, cross-fade, element, src, paint), no
 * escapes, comments, braces or semicolons. Style values arrive with scenes and from peers.
 * @param {unknown} value */
export function isSafeCssValue(value) {
	if (typeof value === 'number') return Number.isFinite(value);
	if (typeof value !== 'string') return false;
	if (value.length > 200) return false;
	return !/url\s*\(|image(-set)?\s*\(|cross-fade\s*\(|element\s*\(|src\s*\(|paint\s*\(|[;{}\\<>@]|\/\*|[\x00-\x1f]/i.test(value);
}

/** A stored thumbnail, when it is one this page may show (see isLocalImageUrl); else null.
 * @param {unknown} url @returns {string|null} */
export function localThumb(url) {
	return isLocalImageUrl(url) ? /** @type {string} */ (url) : null;
}

/** Is this one image entry's source embedded? A string must be a data URL; an object is raw pixel
 * data (or a size-only record, which three turns into an empty image) and never fetches.
 * @param {unknown} source */
function embeddedSource(source) {
	if (typeof source === 'string') return isEmbeddedUrl(source);
	return !!source && typeof source === 'object' && !Array.isArray(source);
}

/** @param {any} image */
function imageIsEmbedded(image) {
	if (!image || typeof image !== 'object') return false;
	const url = image.url;
	if (Array.isArray(url)) return url.every(embeddedSource);
	// (a missing url is not "nothing to fetch": three reads `.data` off it and the parse throws)
	return embeddedSource(url);
}

/** @param {any} material */
export function isStandardMaterial(material) {
	if (!material || typeof material !== 'object') return false;
	if (!STANDARD_MATERIAL_TYPES.has(material.type)) return false;
	return !PROGRAM_FIELDS.some((key) => key in material);
}

/** A colour worth keeping from a material we replace: its own `color`, else a colour uniform.
 * @param {any} material @returns {number|undefined} */
function colourOf(material) {
	if (Number.isFinite(material?.color)) return material.color;
	const uniforms = material?.uniforms;
	if (uniforms && typeof uniforms === 'object') {
		for (const key of ['diffuse', 'color', 'uColor', 'baseColor']) {
			const u = uniforms[key];
			if (u && u.type === 'c' && Number.isFinite(u.value)) return u.value;
		}
	}
	return undefined;
}

/** The standard material that stands in for one we do not load.
 * @param {any} material */
export function fallbackMaterial(material) {
	/** @type {any} */
	const out = { type: 'MeshStandardMaterial' };
	if (typeof material?.uuid === 'string') out.uuid = material.uuid;
	if (typeof material?.name === 'string') out.name = material.name;
	const colour = colourOf(material);
	if (colour !== undefined) out.color = colour;
	if (material?.userData && typeof material.userData === 'object' && !Array.isArray(material.userData))
		out.userData = material.userData;
	return out;
}

/** @typedef {{materials: number, images: number, textures: number}} GuardCounts */

/** The resource lists of an ObjectLoader JSON. three walks each by `.length` and index, so anything
 * that is not a real array (an object with a `length`) would reach it unchecked. */
const LIST_KEYS = ['geometries', 'materials', 'textures', 'images', 'shapes', 'skeletons', 'animations'];

/** A preview address the UI shows as an image: only an embedded image may stay. @param {unknown} url */
const embeddedImageUrl = (url) => isImageDataUrl(url);

/** Keep a material's app data, minus a preview address that is not an embedded image.
 * @param {any} material @param {GuardCounts} counts */
function guardMaterialUserData(material, counts) {
	const ud = material?.userData;
	if (!ud || typeof ud !== 'object' || Array.isArray(ud)) return;
	if ('mapDataUrl' in ud && !embeddedImageUrl(ud.mapDataUrl)) {
		delete ud.mapDataUrl;
		counts.images++;
	}
}

/**
 * Check a material set in place: `{materials, textures, images}` (the `materials` message and the
 * resource arrays of an ObjectLoader JSON share these three keys). Lists are known to be arrays
 * (or absent) by now.
 * @param {any} set @param {GuardCounts} counts
 */
function guardResources(set, counts) {
	if (Array.isArray(set.images)) {
		/** @type {Set<string>} */
		const droppedImages = new Set();
		set.images = set.images.filter((/** @type {any} */ image) => {
			if (imageIsEmbedded(image)) return true;
			if (typeof image?.uuid === 'string') droppedImages.add(image.uuid);
			counts.images++;
			return false;
		});
		if (Array.isArray(set.textures)) {
			const known = new Set(set.images.map((/** @type {any} */ i) => i?.uuid));
			set.textures = set.textures.filter((/** @type {any} */ texture) => {
				// three reads `images[texture.image].data` with no guard, so a texture whose image is
				// gone (dropped here, or never there) must go too or the whole parse throws
				if (texture && known.has(texture.image) && !droppedImages.has(texture.image)) return true;
				counts.textures++;
				return false;
			});
		}
	} else if (Array.isArray(set.textures) && set.textures.length) {
		counts.textures += set.textures.length;
		set.textures = [];
	}
	if (Array.isArray(set.materials)) {
		set.materials = set.materials.map((/** @type {any} */ material) => {
			// (three 0.186 has no MultiMaterial: such an entry, like any other unknown type, would come
			// back as a bare base Material — so it takes the fallback too)
			if (isStandardMaterial(material)) {
				guardMaterialUserData(material, counts);
				return material;
			}
			counts.materials++;
			const fallback = fallbackMaterial(material);
			guardMaterialUserData(fallback, counts);
			return fallback;
		});
	}
}

/** A numeric payload three turns into a typed array: a real array or a typed view, nothing else
 * (`new Float32Array(n)` from a NUMBER, or from `{length: n}`, allocates n). -1 = not one.
 * @param {unknown} value @returns {number} */
function numericLength(value) {
	if (Array.isArray(value)) return value.length;
	if (ArrayBuffer.isView(value)) return /** @type {any} */ (value).byteLength / (/** @type {any} */ (value).BYTES_PER_ELEMENT || 1);
	return -1;
}

/** Size walk state. @typedef {{numbers: number, vertices: number, nodes: number, bad: string|null}} Size */

/** Count a REQUIRED numeric payload. @param {Size} size @param {unknown} value */
function countRequired(size, value) {
	const n = numericLength(value);
	if (n < 0) size.bad ??= 'shape';
	else size.numbers += n;
	return Math.max(n, 0);
}
/** Count an OPTIONAL numeric payload. @param {Size} size @param {unknown} value */
function countOptional(size, value) {
	return value === undefined || value === null ? 0 : countRequired(size, value);
}

/** Segment-like fields of a parametric geometry, which three floors into loop counts. */
const SEGMENT_KEY = /segments$|^steps$|^detail$/i;

/** Parametric geometry: how many vertices three would generate. Over-estimates on purpose (the
 * product of every segment count, times the points, faces and curves it sweeps), which is still
 * far under the cap for anything an editor makes. A segment field that is not a plain finite
 * number is refused (three would `Math.floor` a string into a count).
 * @param {any} geometry @param {number} shapeCurves @param {Size} size */
function generatedVertices(geometry, shapeCurves, size) {
	let total = 1;
	let any = false;
	/** @param {string} key @param {unknown} value */
	const take = (key, value) => {
		if (value === undefined) return;
		if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
			size.bad ??= 'geometry';
			return;
		}
		total *= key === 'detail' ? 60 * (value + 1) ** 2 : value + 1;
		any = true;
	};
	for (const [key, value] of Object.entries(geometry)) if (SEGMENT_KEY.test(key)) take(key, value);
	const options = geometry.options;
	if (options !== undefined && (options === null || typeof options !== 'object')) size.bad ??= 'shape';
	if (options && typeof options === 'object')
		for (const [key, value] of Object.entries(options)) if (SEGMENT_KEY.test(key)) take(key, value);
	// what the segments are multiplied over: a lathe's profile, a polyhedron's faces, a shape's curves
	if (geometry.points !== undefined) {
		if (!Array.isArray(geometry.points)) size.bad ??= 'shape';
		else total *= geometry.points.length + 1;
	}
	if (geometry.indices !== undefined) {
		if (!Array.isArray(geometry.indices)) size.bad ??= 'shape';
		else total *= geometry.indices.length / 3 + 1;
	}
	if (geometry.shapes !== undefined) total *= shapeCurves + 1;
	if (!Number.isFinite(total)) return Infinity;
	return any ? total : 0;
}

/** Numbers carried by one buffer geometry's data block. @param {any} data @param {Size} size */
function geometryNumbers(data, size) {
	if (data === undefined) return;
	if (!data || typeof data !== 'object') return void (size.bad ??= 'shape');
	/** @param {any} attribute */
	const attribute = (attribute) => {
		if (!attribute || typeof attribute !== 'object') return void (size.bad ??= 'shape');
		// an interleaved attribute names its buffer by uuid; the buffer is counted below
		if (attribute.isInterleavedBufferAttribute) return;
		countRequired(size, attribute.array);
	};
	if (data.attributes !== undefined) {
		if (!data.attributes || typeof data.attributes !== 'object') size.bad ??= 'shape';
		else for (const a of Object.values(data.attributes)) attribute(a);
	}
	if (data.morphAttributes !== undefined) {
		if (!data.morphAttributes || typeof data.morphAttributes !== 'object') size.bad ??= 'shape';
		else
			for (const list of Object.values(data.morphAttributes)) {
				if (!Array.isArray(list)) size.bad ??= 'shape';
				else for (const a of list) attribute(a);
			}
	}
	if (data.index !== undefined && data.index !== null) {
		if (typeof data.index !== 'object') size.bad ??= 'shape';
		else countRequired(size, data.index.array);
	}
	if (data.arrayBuffers !== undefined) {
		if (!data.arrayBuffers || typeof data.arrayBuffers !== 'object') size.bad ??= 'shape';
		else for (const b of Object.values(data.arrayBuffers)) countRequired(size, b);
	}
}

/** One image entry's pixel data. Raw pixels must be an array whose size covers width x height
 * (three uploads width x height from the record, whatever the array holds).
 * @param {any} source @param {Size} size */
function imageNumbers(source, size) {
	if (!source || typeof source !== 'object' || Array.isArray(source)) return;
	const { width, height } = source;
	for (const v of [width, height])
		if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 16384)) size.bad ??= 'size';
	if (source.data === undefined) return;
	const n = countRequired(size, source.data);
	if (Number.isInteger(width) && Number.isInteger(height) && width * height > n) size.bad ??= 'size';
}

/**
 * Size facts of one ObjectLoader JSON, walked without recursion (a deep chain must not overflow
 * this walk before three's own recursion gets the chance). `bad` names the first shape problem.
 * @param {any} json @returns {Size}
 */
export function measureObjectJson(json) {
	/** @type {Size} */
	const size = { numbers: 0, vertices: 0, nodes: 0, bad: null };
	for (const key of LIST_KEYS) if (json?.[key] !== undefined && !Array.isArray(json[key])) size.bad ??= 'shape';
	let shapeCurves = 0;
	for (const shape of Array.isArray(json?.shapes) ? json.shapes : []) {
		const paths = [shape, ...(Array.isArray(shape?.holes) ? shape.holes : [])];
		for (const path of paths) {
			if (path?.curves === undefined) continue;
			if (!Array.isArray(path.curves)) size.bad ??= 'shape';
			else
				for (const curve of path.curves) {
					// three divides a spline by its point count too, so each point weighs like a curve
					const points = curve?.points;
					if (points !== undefined && !Array.isArray(points)) size.bad ??= 'shape';
					const weight = 1 + (Array.isArray(points) ? points.length : 0);
					shapeCurves += weight;
					size.numbers += weight * 8;
				}
		}
	}
	for (const g of Array.isArray(json?.geometries) ? json.geometries : []) {
		if (!g || typeof g !== 'object') {
			size.bad ??= 'shape';
			continue;
		}
		geometryNumbers(g.data, size);
		size.vertices += generatedVertices(g, shapeCurves, size);
	}
	for (const image of Array.isArray(json?.images) ? json.images : []) {
		const urls = Array.isArray(image?.url) ? image.url : [image?.url];
		for (const u of urls) imageNumbers(u, size);
	}
	for (const clip of Array.isArray(json?.animations) ? json.animations : []) {
		if (clip?.tracks === undefined) continue;
		if (!Array.isArray(clip.tracks)) size.bad ??= 'shape';
		else
			for (const track of clip.tracks) {
				countRequired(size, track?.times);
				countRequired(size, track?.values);
			}
	}
	for (const skeleton of Array.isArray(json?.skeletons) ? json.skeletons : []) {
		countOptional(size, skeleton?.bones);
		size.numbers += countOptional(size, skeleton?.boneInverses) * 15;
	}
	if (json?.object !== undefined && (!json.object || typeof json.object !== 'object')) size.bad ??= 'shape';
	const stack = json?.object ? [json.object] : [];
	while (stack.length) {
		const node = stack.pop();
		size.nodes++;
		if (size.nodes > MAX_NODES) break;
		if (!node || typeof node !== 'object') continue;
		if (node.type === 'InstancedMesh') {
			const count = node.count;
			const matrices = countRequired(size, node.instanceMatrix?.array);
			countOptional(size, node.instanceColor?.array);
			// three allocates count x 16 floats from `count` alone, whatever the array holds
			if (!Number.isInteger(count) || count < 0 || count * 16 > matrices) size.bad ??= 'count';
		}
		// nothing in this app makes one, and three sizes it from six counts it never checks
		if (node.type === 'BatchedMesh') size.bad ??= 'count';
		// a light's shadow map is a GPU texture of mapSize squared; the app's own lights stay far under this
		const mapSize = node.shadow?.mapSize;
		if (mapSize !== undefined && !(Array.isArray(mapSize) && mapSize.length === 2 && mapSize.every((v) => Number.isInteger(v) && v >= 0 && v <= MAX_SHADOW_MAP)))
			size.bad ??= 'count';
		if (node.children !== undefined) {
			if (!Array.isArray(node.children)) size.bad ??= 'shape';
			else for (const child of node.children) stack.push(child);
		}
	}
	return size;
}

/** @typedef {{ok: boolean, reason?: string, materials: number, images: number, textures: number}} GuardResult */

/**
 * Check one ObjectLoader JSON IN PLACE before it is parsed. `ok: false` = do not parse it at all.
 * @param {any} json @returns {GuardResult}
 */
export function guardObjectJson(json) {
	/** @type {GuardCounts} */
	const counts = { materials: 0, images: 0, textures: 0 };
	if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, reason: 'shape', ...counts };
	const size = measureObjectJson(json);
	if (size.bad) return { ok: false, reason: size.bad, ...counts };
	if (size.nodes > MAX_NODES) return { ok: false, reason: 'nodes', ...counts };
	if (size.numbers > MAX_NUMBERS) return { ok: false, reason: 'size', ...counts };
	if (size.vertices > MAX_GENERATED_VERTICES) return { ok: false, reason: 'geometry', ...counts };
	guardResources(json, counts);
	return { ok: true, ...counts };
}

/**
 * Check a `{materials, textures, images}` set IN PLACE (the `materials` message payload), and the
 * per-slot preview addresses that ride beside it.
 * @param {any} payload @returns {GuardResult}
 */
export function guardMaterialSet(payload) {
	/** @type {GuardCounts} */
	const counts = { materials: 0, images: 0, textures: 0 };
	if (!payload || typeof payload !== 'object' || !Array.isArray(payload.materials))
		return { ok: false, reason: 'shape', ...counts };
	for (const key of ['textures', 'images', 'mapDataUrls', 'mapSources'])
		if (payload[key] !== undefined && payload[key] !== null && !Array.isArray(payload[key]))
			return { ok: false, reason: 'shape', ...counts };
	/** @type {Size} */
	const size = { numbers: 0, vertices: 0, nodes: 0, bad: null };
	for (const image of Array.isArray(payload.images) ? payload.images : []) {
		const urls = Array.isArray(image?.url) ? image.url : [image?.url];
		for (const u of urls) imageNumbers(u, size);
	}
	if (size.bad) return { ok: false, reason: size.bad, ...counts };
	if (size.numbers > MAX_NUMBERS || payload.materials.length > 1024) return { ok: false, reason: 'size', ...counts };
	guardResources(payload, counts);
	if (Array.isArray(payload.mapDataUrls))
		payload.mapDataUrls = payload.mapDataUrls.map((/** @type {unknown} */ u) => {
			if (u === null || u === undefined || embeddedImageUrl(u)) return u;
			counts.images++;
			return null;
		});
	return { ok: true, ...counts };
}

/** Did a check change or refuse anything? @param {GuardResult} r */
export function guardChanged(r) {
	return !r.ok || r.materials > 0 || r.images > 0 || r.textures > 0;
}

// ---- glTF (the `object` message's other form: a glTF the sender's exporter wrote) ------------
// A glTF names its resources by `uri`; three resolves anything that is not embedded against the
// page and fetches it. The sender's exporter embeds every buffer and image, so a uri that is not a
// data URL is never legitimate there, and neither is a document far larger than any export. For
// model bytes from elsewhere (a library file, a scene's animated piece) the loader's own manager
// refuses the fetch, and the size half of this check still applies.

/** Characters of embedded data one glTF may carry (an import is capped at 25 MB, ~34 M chars of
 * base64; four times that). */
export const MAX_GLTF_DATA_CHARS = 128 * 1024 * 1024;

const GLB_MAGIC = 0x46546c67; // 'glTF'
const GLB_JSON = 0x4e4f534a; // 'JSON'

/** The largest shadow map a light from a message or a file may ask for (the app caps its own at 4096). */
export const MAX_SHADOW_MAP = 8192;

/** Components per element for each glTF accessor type. */
const ACCESSOR_SIZE = /** @type {Record<string, number>} */ ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 });

/**
 * The JSON document of a glTF element as three's GLTFLoader.parse would read it: an object, a
 * JSON string, or the bytes of a .glb. Null = not readable, or a .glb with more than one JSON
 * chunk (three keeps the LAST one; a checker reading the first would check the wrong document).
 * @param {any} element @returns {any|null}
 */
export function gltfJsonOf(element) {
	try {
		if (typeof element === 'string') return JSON.parse(element);
		/** @type {Uint8Array|null} */
		let bytes = null;
		if (element instanceof ArrayBuffer) bytes = new Uint8Array(element);
		else if (ArrayBuffer.isView(element)) bytes = new Uint8Array(element.buffer, element.byteOffset, element.byteLength);
		if (bytes) {
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			if (bytes.byteLength >= 12 && view.getUint32(0, true) === GLB_MAGIC) {
				// three's chunk walk: from byte 12 to the header's length, the LAST JSON chunk wins
				const end = Math.min(view.getUint32(8, true), bytes.byteLength);
				let offset = 12;
				/** @type {Uint8Array|null} */
				let json = null;
				let jsonChunks = 0;
				while (offset < end) {
					if (offset + 8 > end) return null;
					const length = view.getUint32(offset, true);
					const type = view.getUint32(offset + 4, true);
					offset += 8;
					if (offset + length > end) return null;
					if (type === GLB_JSON) {
						json = bytes.subarray(offset, offset + length);
						jsonChunks++;
					}
					offset += length;
				}
				if (jsonChunks !== 1 || !json) return null;
				return JSON.parse(new TextDecoder().decode(json));
			}
			// three treats bytes without the magic as a JSON text
			return JSON.parse(new TextDecoder().decode(bytes));
		}
		if (element && typeof element === 'object' && !Array.isArray(element)) return element;
	} catch {
		return null;
	}
	return null;
}

/**
 * Check one glTF element (not changed: a refusal means do not parse it at all).
 * `uris: false` checks sizes only (bytes whose loader refuses fetches anyway).
 * @param {any} element @param {{uris?: boolean}} [opts] @returns {{ok: boolean, reason?: string}}
 */
export function guardGltfElement(element, opts = {}) {
	const checkUris = opts.uris !== false;
	const json = gltfJsonOf(element);
	if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, reason: 'shape' };
	let chars = 0;
	for (const key of ['buffers', 'images', 'accessors', 'bufferViews']) {
		if (json[key] !== undefined && !Array.isArray(json[key])) return { ok: false, reason: 'shape' };
	}
	for (const key of ['buffers', 'images']) {
		for (const entry of json[key] ?? []) {
			if (!entry || typeof entry !== 'object') return { ok: false, reason: 'shape' };
			if (entry.uri === undefined) continue;
			if (typeof entry.uri !== 'string') return { ok: false, reason: 'shape' };
			if (checkUris && !isEmbeddedUrl(entry.uri)) return { ok: false, reason: 'uri' };
			if (isEmbeddedUrl(entry.uri)) chars += entry.uri.length;
		}
	}
	if (chars > MAX_GLTF_DATA_CHARS) return { ok: false, reason: 'size' };
	// an accessor with no bufferView makes three allocate count x components zeroes, from the count
	// alone; one with a view reads it, so the view must hold what the count claims
	let numbers = 0;
	if (json.accessors !== undefined && !Array.isArray(json.accessors)) return { ok: false, reason: 'shape' };
	if (json.bufferViews !== undefined && !Array.isArray(json.bufferViews)) return { ok: false, reason: 'shape' };
	// a compressed view decodes to count x byteStride bytes, whatever its stored length
	for (const view of json.bufferViews ?? []) {
		const ext = view?.extensions;
		if (!ext || typeof ext !== 'object') continue;
		for (const key of Object.keys(ext)) {
			if (!/meshopt/i.test(key)) continue;
			const mo = ext[key];
			if (!mo || !Number.isInteger(mo.count) || !Number.isInteger(mo.byteStride) || mo.count < 0 || mo.byteStride < 0)
				return { ok: false, reason: 'shape' };
			numbers += (mo.count * mo.byteStride) / 4;
		}
	}
	for (const accessor of json.accessors ?? []) {
		if (!accessor || typeof accessor !== 'object') return { ok: false, reason: 'shape' };
		const components = typeof accessor.type === 'string' && Object.hasOwn(ACCESSOR_SIZE, accessor.type) ? ACCESSOR_SIZE[accessor.type] : 0;
		const count = accessor.count;
		if (!components || !Number.isInteger(count) || count < 0) return { ok: false, reason: 'shape' };
		numbers += count * components;
		const sparse = accessor.sparse;
		if (sparse !== undefined) {
			if (!sparse || typeof sparse !== 'object' || !Number.isInteger(sparse.count) || sparse.count < 0 || sparse.count > count)
				return { ok: false, reason: 'shape' };
		}
		if (accessor.bufferView !== undefined) {
			const view = json.bufferViews?.[accessor.bufferView];
			if (!view || !Number.isInteger(view.byteLength) || view.byteLength < 0) return { ok: false, reason: 'shape' };
			// at least one byte per component (the smallest component type)
			if (count * components > view.byteLength) return { ok: false, reason: 'size' };
		}
	}
	if (!Number.isFinite(numbers) || numbers > MAX_NUMBERS) return { ok: false, reason: 'size' };
	return { ok: true };
}


/**
 * Does an STL keep its triangle count within its own bytes? three decides binary vs text the
 * way this does, and a binary file's header count sizes two arrays of count x 9 floats
 * whatever the file holds, so the count must fit the file. A text STL passes (its size is
 * its text).
 * @param {ArrayBuffer | ArrayBufferView} input @returns {boolean}
 */
export function stlWithinLimits(input) {
	const bytes =
		input instanceof ArrayBuffer ? new Uint8Array(input) : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : null;
	if (!bytes) return false;
	if (bytes.length < 84) return false;
	const faces = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
	const fits = 84 + faces * 50 <= bytes.length;
	if (84 + faces * 50 === bytes.length) return faces * 9 <= MAX_NUMBERS;
	// three's text test: 'solid' within the first five offsets
	for (let off = 0; off < 5; off++) {
		if (bytes[off] === 115 && bytes[off + 1] === 111 && bytes[off + 2] === 108 && bytes[off + 3] === 105 && bytes[off + 4] === 100) return true;
	}
	return fits && faces * 9 <= MAX_NUMBERS;
}
