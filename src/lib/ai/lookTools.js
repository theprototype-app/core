// Roadmap 85 L1-L5 — MAKE THINGS LOOK FINISHED: the agent / assistant look tools.
//
//   set_material   colour, numbers and the six texture slots from a library hash, an https URL (it becomes a
//                  library item first), a starter preset or a CC0 material by name; many objects, one call
//   list_materials / get_material   what objects wear, with the shader graph and its uniforms
//   create_shader / edit_shader / assign_shader   graph text like flows, on setShaderGraphFor / setShaderParam;
//                  compiler (and driver) errors come back in the result; the params come back as uniform
//                  names a flow's `setuniform` node can drive
//   set_post / create_post_graph / get_post   the look stack; scene-wide, so they ask first (agent/confirmGate)
//   uv_unwrap / set_uv   unwrap (box / planar / smart), tiling + offset + rotation per slot, per-face mapping
//
// Every write is a path a person's edit already takes (materialsHandler, materialPresets, shaderGraph, scenePost,
// postGraphs, uvEditor), so peers, Undo (one step per call: the caller's history batch), the viewer gate and the
// A8 log behave as for the panels. Everything heavy loads on first use: this module sits in the assistant's static
// graph and in the catalog generator's SSR load.
import { get } from 'svelte/store';
import * as THREE from 'three';
import { objectsGroup, pokeScene } from '../../stores/sceneStore.js';
import { toHexColor, checkMaterialParam } from '$lib/materialParamRules.js';
import { lockSkip } from './lockNote.js';
import { textToGraph, graphToText } from '$lib/graphText';
import { parseSelect, facesOf, applySelect } from './meshSelectCore.js';
import {
	SLOT_WORD,
	URL_MAX_BYTES,
	URL_IMAGE_TYPES,
	checkShaderGraph,
	fieldsForMaps,
	isColorSlot,
	mergeShaderGraph,
	parseMaps,
	parseUvTransform,
	payloadTextures,
	planPost,
	projectFaceUvs,
	setPayloadTransform,
	sniffImageType,
	uniformsOf
} from './lookToolsCore.js';

/** the tool names this module answers */
export const LOOK_TOOL_NAMES = [
	'set_material',
	'list_materials',
	'get_material',
	'create_shader',
	'edit_shader',
	'assign_shader',
	'describe_shader_nodes',
	'set_post',
	'get_post',
	'create_post_graph',
	'uv_unwrap',
	'set_uv'
];

/** the ones that only read */
export const LOOK_READ_TOOLS = ['list_materials', 'get_material', 'describe_shader_nodes', 'get_post'];

const MAX_OBJECTS = 200;
/** a CC0 material is megabytes per object on the wire */
const MAX_CC0_OBJECTS = 20;
const MAX_SHADER_OBJECTS = 50;
const MAX_LIST = 200;
const MATERIAL_TYPES = ['MeshBasicMaterial', 'MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshPhongMaterial', 'MeshLambertMaterial', 'MeshToonMaterial'];
const UNWRAP_METHODS = /** @type {Record<string, string>} */ ({ box: 'box', planar: 'planar', smart: 'smart', cylindrical: 'cylindrical', spherical: 'spherical' });

/** @param {number} n */
const r3 = (n) => Math.round(n * 1000) / 1000;

/** @param {string} uuid @returns {any} */
function objectOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid);
}

/** The objects of a call. @param {any} args @param {number} [max] @returns {{uuids: string[], error?: string}} */
function targetsOf(args, max = MAX_OBJECTS) {
	const raw = args?.objects ?? (args?.object !== undefined ? [args.object] : args?.uuid !== undefined ? [args.uuid] : null);
	if (!Array.isArray(raw) || !raw.length || !raw.every((u) => typeof u === 'string' && u)) return { uuids: [], error: 'objects: a list of object uuids (list_scene)' };
	const uuids = [...new Set(raw)];
	if (uuids.length > max) return { uuids: [], error: 'objects: at most ' + max + ' in one call' };
	return { uuids };
}

/** a colour an AI may pass: hex or a CSS name, as '#rrggbb', else null @param {any} v */
function colorOf(v) {
	const hex = toHexColor(v);
	if (hex) return hex;
	const n = typeof v === 'string' ? /** @type {any} */ (THREE.Color).NAMES?.[v.trim().toLowerCase()] : undefined;
	return n === undefined ? null : '#' + n.toString(16).padStart(6, '0');
}

// ---- texture sources ------------------------------------------------------------------------

/**
 * An https image → bytes, by the URL rules: the browser's own CORS check is the fetch, a size cap read
 * as it streams, image types only (the bytes are believed, not the header), SVG never.
 * @param {string} url @param {typeof fetch} [fetcher] @returns {Promise<{bytes: Uint8Array, type: string, name: string} | {error: string}>}
 */
export async function fetchTextureUrl(url, fetcher = fetch) {
	/** @type {Response} */
	let res;
	try {
		res = await fetcher(url, { mode: 'cors', credentials: 'omit', redirect: 'follow' });
	} catch {
		return { error: 'could not fetch it (the server must allow cross-origin requests — CORS — and be reachable)' };
	}
	if (!res.ok) return { error: 'the server answered ' + res.status };
	const declared = Number(res.headers.get('content-length'));
	if (declared > URL_MAX_BYTES) return { error: 'it is ' + Math.round(declared / 1048576) + ' MB — the limit is ' + URL_MAX_BYTES / 1048576 + ' MB' };
	const reader = res.body?.getReader?.();
	/** @type {Uint8Array[]} */
	const parts = [];
	let total = 0;
	if (reader) {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.length;
			if (total > URL_MAX_BYTES) {
				void reader.cancel();
				return { error: 'it is over the ' + URL_MAX_BYTES / 1048576 + ' MB limit' };
			}
			parts.push(value);
		}
	} else {
		const whole = new Uint8Array(await res.arrayBuffer());
		if (whole.length > URL_MAX_BYTES) return { error: 'it is over the ' + URL_MAX_BYTES / 1048576 + ' MB limit' };
		parts.push(whole);
		total = whole.length;
	}
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		bytes.set(part, at);
		at += part.length;
	}
	const type = sniffImageType(bytes);
	if (!type || !URL_IMAGE_TYPES.includes(type)) return { error: 'it is not an image this app reads (PNG, JPEG, WebP, GIF, AVIF)' };
	const tail = new URL(res.url || url).pathname.split('/').pop() || 'texture';
	const name = decodeURIComponent(tail).replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'texture';
	return { bytes, type, name: /\.[a-z0-9]{2,5}$/i.test(name) ? name : name + '.' + type.split('/')[1] };
}

/**
 * One source → a library image + its re-encoded texture, once per call however many slots name it.
 * @param {any} source parseMapSource's result @param {Map<string, any>} seen
 * @returns {Promise<{hash: string, id: string, name: string, blob: Blob, dataUrl: () => Promise<string>, from: string} | {error: string}>}
 */
async function resolveImage(source, seen) {
	const key = source.hash ?? source.url;
	if (seen.has(key)) return seen.get(key);
	const ex = await import('$lib/explorer');
	const mh = await import('$lib/materialsHandler');
	/** @type {any} */
	let item;
	let from = 'library';
	if (source.hash) {
		item = ex.itemByHash(source.hash);
		if (!item || item.kind !== 'image') {
			const out = { error: '"' + source.hash.slice(0, 16) + '…" is not an image in the library' };
			seen.set(key, out);
			return out;
		}
	} else {
		const got = await fetchTextureUrl(source.url);
		if ('error' in got) {
			const out = { error: source.url.slice(0, 60) + ': ' + got.error };
			seen.set(key, out);
			return out;
		}
		// make sure it decodes before it becomes a library item (a truncated file is not a texture)
		try {
			(await createImageBitmap(new Blob([/** @type {any} */ (got.bytes)], { type: got.type }))).close();
		} catch {
			const out = { error: source.url.slice(0, 60) + ': the image could not be decoded' };
			seen.set(key, out);
			return out;
		}
		item = await ex.addItemFromBytes(/** @type {ArrayBuffer} */ (got.bytes.buffer), got.name);
		from = 'url';
		if (!item) {
			const out = { error: source.url.slice(0, 60) + ': the library refused it' };
			seen.set(key, out);
			return out;
		}
	}
	const blob = await ex.itemBlob(item.id);
	if (!blob) {
		const out = { error: '"' + String(item.name).slice(0, 40) + '": the image could not be read' };
		seen.set(key, out);
		return out;
	}
	/** @type {string | null} */
	let encoded = null;
	const out = {
		hash: String(item.hash),
		id: String(item.id),
		name: String(item.name),
		blob,
		from,
		dataUrl: async () => (encoded ??= await mh.downscaleImage(blob, mh.TEXTURE_MAX_SIDE))
	};
	seen.set(key, out);
	return out;
}

/**
 * A CC0 material by name: Poly Haven's texture list (an id or a title), then an ambientCG search. Exact
 * beats a part of the name. The import is the Asset Browser's own (a preset in this person's library).
 * @param {string} wanted @returns {Promise<{preset: any} | {error: string}>}
 */
async function resolveCc0(wanted) {
	const q = wanted.trim().toLowerCase();
	const fetchers = await import('$lib/cc0/cc0Fetch.js');
	const core = await import('$lib/cc0/cc0Core.js');
	/** @type {any[]} */
	let rows = [];
	try {
		rows = core.normalizePolyHaven((await fetchers.phList('textures')).data, 'textures');
	} catch {}
	const pick = (/** @type {any[]} */ list) =>
		list.find((r) => String(r.id).toLowerCase() === q || String(r.name).toLowerCase() === q) ?? list.find((r) => String(r.name).toLowerCase().includes(q));
	let row = pick(rows);
	if (!row) {
		try {
			row = pick(core.normalizeAmbientCg((await fetchers.acgPage({ query: wanted, offset: 0 })).data));
		} catch {}
	}
	if (!row) return { error: 'no CC0 material called "' + wanted.slice(0, 40) + '" on Poly Haven or ambientCG' };
	try {
		const { importCc0 } = await import('$lib/cc0/cc0Import.js');
		const made = await importCc0(row, '1k', {});
		if (!made?.preset?.payload) return { error: 'the CC0 material could not be imported' };
		return { preset: made.preset.payload };
	} catch (e) {
		return { error: 'the CC0 material could not be imported: ' + (e instanceof Error ? e.message : String(e)) };
	}
}

/** a starter preset (id or label) or a saved one (label) @param {string} name */
async function findPreset(name) {
	const mp = await import('$lib/materialPresets');
	const q = name.trim().toLowerCase();
	const starter = mp.starterPresets().find((s) => String(s.id).toLowerCase() === q || String(s.label).toLowerCase() === q);
	if (starter) return starter.preset;
	return get(mp.materialPresets).find((p) => p.name.toLowerCase() === q)?.payload ?? null;
}

// ---- set_material ---------------------------------------------------------------------------

/** the triangles a `faces` selection picks @param {any} object @param {any} faces @returns {Promise<{tris: number[], rows: any[], error?: string}>} */
async function selectFaces(object, faces) {
	const sel = parseSelect(faces);
	if ('error' in sel) return { tris: [], rows: [], error: sel.error.replace(/^select/, 'faces') };
	/** @type {any} */
	const fe = await import('$lib/faceEdit');
	const { readStoredFaces } = await import('$lib/meshTopology');
	const rows = fe.readTriangles(object.geometry);
	// (85-geometry's facePartitionOf when its lane is merged: a box's side is then ONE face)
	const partition = fe.facePartitionOf ? fe.facePartitionOf(object.geometry).partition : (readStoredFaces(object.geometry) ?? rows.map((/** @type {any} */ _, /** @type {number} */ i) => [i]));
	const { picked, outOfRange } = applySelect(facesOf(rows, partition), sel, (f) => f.centroid);
	if (outOfRange.length) return { tris: [], rows, error: 'faces.indices: ' + outOfRange.slice(0, 5).join(', ') + ' out of range (' + partition.length + ' faces)' };
	const tris = picked.flatMap((f) => f.tris);
	if (!tris.length) return { tris, rows, error: 'faces: the selection picks nothing on this object' };
	return { tris, rows };
}

/**
 * The fields of a set_material call.
 * @param {any} args @returns {{fields: Record<string, any>, errors: string[]}}
 */
function parseFields(args) {
	/** @type {Record<string, any>} */
	const fields = {};
	/** @type {string[]} */
	const errors = [];
	for (const key of ['color', 'emissive']) {
		if (args[key] === undefined) continue;
		const hex = colorOf(args[key]);
		if (!hex) errors.push(key + ': a hex colour like "#ff8800" or a CSS name');
		else fields[key] = hex;
	}
	for (const key of ['metalness', 'roughness', 'opacity', 'emissiveIntensity', 'transparent']) if (args[key] !== undefined) fields[key] = args[key];
	if (args.params !== undefined) {
		if (!args.params || typeof args.params !== 'object' || Array.isArray(args.params)) errors.push('params: an object like {"clearcoat": 1}');
		else
			for (const [key, value] of Object.entries(args.params)) {
				if (/map$/i.test(key) || key === 'matcap') errors.push('params.' + key + ': texture slots go in maps');
				else fields[key] = value;
			}
	}
	// a see-through surface that forgets `transparent` draws solid, and nobody can tell why
	if (typeof fields.opacity === 'number' && fields.opacity < 1 && fields.transparent === undefined) fields.transparent = true;
	return { fields, errors };
}

/** Wait until a just-set albedo has landed (TextureLoader is async, and the next call reads the material). @param {any} object @param {number} slot */
async function albedoLanded(object, slot) {
	const { materialAt } = await import('$lib/materialsHandler');
	const t0 = Date.now();
	while (Date.now() - t0 < 5000) {
		const m = materialAt(object, slot);
		const want = m?.userData?.mapDataUrl;
		if (!want || m?.map?.source?.data?.src === want) return;
		await new Promise((r) => setTimeout(r, 20));
	}
}

/** @param {any} args */
async function setMaterialTool(args) {
	const { uuids, error } = targetsOf(args);
	if (error) return { error };
	const { fields, errors } = parseFields(args);
	const maps = parseMaps(args.maps);
	errors.push(...maps.errors);
	let wantType = null;
	if (args.type !== undefined) {
		wantType = MATERIAL_TYPES.find((m) => m.toLowerCase() === String(args.type).toLowerCase());
		if (!wantType) errors.push('type: one of ' + MATERIAL_TYPES.join(', '));
	}
	const baseSlot = args.slot === undefined ? 0 : args.slot;
	if (!Number.isInteger(baseSlot) || baseSlot < 0) errors.push('slot: a whole number from 0');
	if (args.faces !== undefined && args.slot !== undefined) errors.push('faces and slot: give one (faces makes a new slot)');
	if (args.cc0 !== undefined && (typeof args.cc0 !== 'string' || !args.cc0.trim())) errors.push('cc0: a material name, e.g. "Wood051"');
	if (args.preset !== undefined && (typeof args.preset !== 'string' || !args.preset.trim())) errors.push('preset: a preset name');
	if (args.cc0 && args.preset) errors.push('cc0 and preset: give one');
	if (args.cc0 && uuids.length > MAX_CC0_OBJECTS) errors.push('cc0: at most ' + MAX_CC0_OBJECTS + ' objects in one call (each one carries the images)');
	if (!Object.keys(fields).length && !Object.keys(maps.slots).length && !wantType && !args.cc0 && !args.preset && args.faces === undefined)
		errors.push('nothing to set: give color, roughness, metalness, emissive, opacity, params, maps, type, preset or cc0');
	if (errors.length) return { error: errors.join('; ') };

	// sources first: a bad URL changes nothing
	/** @type {Map<string, any>} */
	const seen = new Map();
	/** @type {Record<string, any>} */
	const images = {};
	const assets = new Map();
	for (const [key, source] of Object.entries(maps.slots)) {
		if (source.clear) continue;
		const image = await resolveImage(source, seen);
		if ('error' in image) return { error: 'maps.' + SLOT_WORD[key] + ': ' + image.error };
		images[key] = image;
		assets.set(image.hash, { hash: image.hash, id: image.id, name: image.name, from: image.from });
	}
	/** @type {any} */
	let preset = null;
	if (args.preset) {
		preset = await findPreset(args.preset);
		if (!preset) return { error: 'preset: no preset called "' + String(args.preset).slice(0, 40) + '"' };
	} else if (args.cc0) {
		const found = await resolveCc0(args.cc0);
		if ('error' in found) return { error: 'cc0: ' + found.error };
		preset = found.preset;
	}

	const mh = await import('$lib/materialsHandler');
	const mp = await import('$lib/materialPresets');
	const { isShaderDriven } = await import('$lib/shaderGraph');
	/** @type {any[]} */
	const updated = [];
	/** @type {any[]} */
	const skipped = [];
	/** slot -> uuids whose albedo this call sets @type {Map<number, string[]>} */
	const albedoBySlot = new Map();
	/** @type {any[]} */
	const rows = [];

	for (const uuid of uuids) {
		const object = objectOf(uuid);
		if (!object) {
			skipped.push({ uuid, reason: 'no object with this uuid' });
			continue;
		}
		const locked = lockSkip(uuid, object);
		if (locked) {
			skipped.push({ uuid, reason: locked });
			continue;
		}
		if (!object.material) {
			skipped.push({ uuid, reason: 'it has no material (a group or a light)' });
			continue;
		}
		if (isShaderDriven(uuid)) {
			skipped.push({ uuid, reason: 'it wears a shader graph, which decides its look; remove it first: assign_shader {"objects": ["' + uuid + '"], "shader": null}' });
			continue;
		}
		let slot = baseSlot;
		if (preset || wantType) {
			if (Array.isArray(object.material)) {
				skipped.push({ uuid, reason: 'it has ' + object.material.length + ' material slots: a preset or a type change takes one' });
				continue;
			}
			if (wantType && object.material.type !== wantType) mh.switchMaterialType(uuid, wantType, true);
			if (preset && !mp.applyMaterialPreset(uuid, preset)) {
				skipped.push({ uuid, reason: 'the preset could not be applied' });
				continue;
			}
		}
		if (args.faces !== undefined) {
			const picked = await selectFaces(object, args.faces);
			if (picked.error) {
				skipped.push({ uuid, reason: picked.error });
				continue;
			}
			const made = mh.addMaterialSlot(uuid);
			const { assignTrisToSlot } = await import('$lib/uvEditor');
			if (made < 0 || !assignTrisToSlot(uuid, picked.tris, made)) {
				skipped.push({ uuid, reason: 'those faces could not take their own material' });
				continue;
			}
			slot = made;
		}
		const material = mh.materialAt(object, slot);
		if (!material) {
			skipped.push({ uuid, reason: 'it has no material slot ' + slot });
			continue;
		}
		// a slot this material type does not have is an error, per object (a Basic material has no normal map)
		const missing = Object.keys(maps.slots).filter((key) => !(key in material));
		if (missing.length) {
			skipped.push({ uuid, reason: 'a ' + material.type + ' has no ' + missing.map((k) => SLOT_WORD[k] + ' map').join(', ') + ' (pass type: "MeshStandardMaterial")' });
			continue;
		}
		const added = Object.keys(images);
		const all = { ...fieldsForMaps(added, { metalness: material.metalness, emissive: material.emissive ? '#' + material.emissive.getHexString() : undefined }, fields), ...fields };
		/** @type {string[]} */
		const fieldErrors = [];
		/** @type {Record<string, any>} */
		const checked = {};
		for (const [key, value] of Object.entries(all)) {
			const c = checkMaterialParam(material, key, value);
			if (!c.ok) fieldErrors.push(c.error + (key === 'transmission' || key === 'clearcoat' || key === 'ior' ? ' (pass type: "MeshPhysicalMaterial")' : ''));
			else checked[key] = c.value;
		}
		if (fieldErrors.length) {
			skipped.push({ uuid, reason: fieldErrors.join('; ') });
			continue;
		}
		const single = !Array.isArray(object.material) && slot === 0;
		if (single) {
			for (const [key, value] of Object.entries(checked)) {
				if (key === 'color') mh.setObjectColor(uuid, value);
				else if (!mh.setMaterialParam(uuid, key, value, true)) fieldErrors.push(key + ': not applied');
			}
		} else if (Object.keys(checked).length) {
			mp.replaceMaterials(uuid, (payload) => {
				const m = payload.materials[slot];
				for (const [key, value] of Object.entries(checked))
					m[key] = typeof value === 'string' && value.startsWith('#') ? parseInt(value.slice(1), 16) : value;
				return payload;
			});
		}
		const row = { uuid, slot, object, material: null, errors: fieldErrors };
		rows.push(row);
		if (maps.slots.map?.clear) mh.removeObjectTexture(uuid, slot);
		if (images.map) albedoBySlot.set(slot, [...(albedoBySlot.get(slot) ?? []), uuid]);
	}

	// the albedo goes the Explorer's way: decoded once, one history entry + one `map` message per object
	for (const [slot, list] of albedoBySlot) {
		const image = images.map;
		const file = new File([image.blob], image.name, { type: image.blob.type || 'image/png' });
		await mh.setObjectsTexture(list, file, slot, { source: image.hash });
		for (const uuid of list) await albedoLanded(objectOf(uuid), slot);
	}

	// the other five ride a `materials` replace: three has no other message that carries them
	const otherKeys = Object.keys(maps.slots).filter((k) => k !== 'map');
	/** @type {Record<string, string>} */
	const encoded = {};
	for (const key of otherKeys) if (images[key]) encoded[key] = await images[key].dataUrl();
	for (const row of rows) {
		if (otherKeys.length) {
			mp.replaceMaterials(row.uuid, (payload) => {
				const m = payload.materials[row.slot];
				if (!m) return payload;
				const like = payloadTextures(payload, row.slot, ['map'])[0]?.texture;
				/** @type {Record<string, string>} */
				const sources = { ...(m.userData?.mapSources ?? {}) };
				for (const key of otherKeys) {
					if (maps.slots[key].clear) {
						delete m[key];
						delete sources[key];
						continue;
					}
					const tex = THREE.MathUtils.generateUUID();
					const img = THREE.MathUtils.generateUUID();
					payload.images.push({ uuid: img, url: encoded[key] });
					const json = mp.textureJson(tex, img, isColorSlot(key), like?.repeat);
					// a new map follows the tiling the albedo already has, or the two slide apart
					if (like?.offset) json.offset = [...like.offset];
					if (like?.rotation) {
						json.rotation = like.rotation;
						json.center = [...(like.center ?? [0, 0])];
					}
					payload.textures.push(json);
					m[key] = tex;
					if (key === 'normalMap' && !m.normalScale) m.normalScale = [1, 1];
					sources[key] = images[key].hash;
				}
				m.userData = { ...(m.userData ?? {}), mapSources: sources };
				return payload;
			});
		}
		const mapNames = Object.keys(maps.slots).map((k) => SLOT_WORD[k]);
		updated.push({ uuid: row.uuid, ok: true, slot: row.slot, ...(mapNames.length ? { maps: mapNames } : {}), ...(row.errors.length ? { errors: row.errors } : {}) });
	}
	pokeScene();
	if (!updated.length) return { error: skipped.map((s) => s.reason).join('; ') || 'nothing was changed', skipped };
	return { updated, ...(assets.size ? { assets: [...assets.values()] } : {}), ...(skipped.length ? { skipped } : {}), ...(preset ? { preset: preset.label } : {}) };
}

// ---- reading materials ----------------------------------------------------------------------

/** one texture's facts @param {any} tex @param {string | undefined} source */
function textureFacts(tex, source) {
	/** @type {any} */
	const out = {
		tiling: [r3(tex.repeat?.x ?? 1), r3(tex.repeat?.y ?? 1)],
		offset: [r3(tex.offset?.x ?? 0), r3(tex.offset?.y ?? 0)],
		rotation: r3(tex.rotation ?? 0)
	};
	const image = tex.image ?? tex.source?.data;
	if (image?.width) out.size = [image.width, image.height];
	if (source) out.hash = source;
	return out;
}

/** a material as a person would describe it @param {any} m @param {number} slot @param {boolean} [full] */
function describeMaterial(m, slot, full = false) {
	/** @type {any} */
	const out = { slot, type: m.type };
	if (m.name) out.name = m.name;
	if (m.color) out.color = '#' + m.color.getHexString();
	if (typeof m.roughness === 'number') out.roughness = r3(m.roughness);
	if (typeof m.metalness === 'number') out.metalness = r3(m.metalness);
	if (m.emissive) {
		const e = m.emissive.getHexString();
		if (e !== '000000' || full) out.emissive = '#' + e;
		if (e !== '000000' || full) out.emissiveIntensity = r3(m.emissiveIntensity ?? 1);
	}
	if (m.opacity !== 1 || full) out.opacity = r3(m.opacity);
	if (m.transparent) out.transparent = true;
	/** @type {Record<string, any>} */
	const maps = {};
	for (const [key, word] of Object.entries(SLOT_WORD)) {
		const tex = m[key];
		if (!tex) continue;
		const source = key === 'map' ? m.userData?.mapSource : m.userData?.mapSources?.[key];
		maps[word] = full ? textureFacts(tex, source) : (source ?? true);
	}
	if (Object.keys(maps).length) out.maps = maps;
	if (m.userData?.materialPreset) out.preset = m.userData.materialPreset;
	if (m.userData?.cc0Source) out.cc0 = m.userData.cc0Source;
	if (full) {
		for (const key of ['clearcoat', 'clearcoatRoughness', 'transmission', 'ior', 'thickness', 'sheen', 'iridescence', 'shininess']) if (typeof m[key] === 'number' && m[key] !== 0) out[key] = r3(m[key]);
		if (m.side) out.side = m.side === 2 ? 'double' : 'back';
		if (m.wireframe) out.wireframe = true;
	}
	return out;
}

/** @param {any} args */
async function listMaterialsTool(args) {
	const { materialsOf } = await import('$lib/materialsHandler');
	const sg = await import('$lib/shaderGraph');
	const mp = await import('$lib/materialPresets');
	const only = Array.isArray(args?.objects) ? new Set(args.objects) : null;
	const name = typeof args?.name === 'string' ? args.name.trim().toLowerCase() : '';
	/** @type {any[]} */
	const all = [];
	get(objectsGroup)?.traverse?.((/** @type {any} */ node) => {
		if (!node.material || node.userData?.__helper) return;
		if (only && !only.has(node.uuid)) return;
		if (name && !String(node.name ?? '').toLowerCase().includes(name)) return;
		all.push(node);
	});
	const page = Math.max(0, Number(args?.page) || 0);
	const limit = Math.min(MAX_LIST, Math.max(1, Number(args?.limit) || MAX_LIST));
	const rows = all.slice(page * limit, (page + 1) * limit).map((node) => {
		const driven = sg.isShaderDriven(node.uuid);
		const base = driven ? sg.baseMaterialOf(node.uuid) : null;
		const key = sg.graphKeyFor(node.uuid);
		return {
			uuid: node.uuid,
			name: node.name || node.type,
			slots: (base ? [base] : materialsOf(node)).map((m, slot) => describeMaterial(m, slot)),
			...(key ? { shader: key } : {})
		};
	});
	return {
		objects: rows,
		total: all.length,
		...(all.length > (page + 1) * limit ? { nextPage: page + 1 } : {}),
		presets: [...mp.starterPresets().map((s) => s.label), ...get(mp.materialPresets).map((p) => p.name)],
		shaders: Object.keys(get(sg.shaderGraphs))
	};
}

/** a graph document as a tool answers it @param {string} key @param {any} doc */
async function shaderFacts(key, doc) {
	const { compileShaderGraphToIR, compilePostGraphToIR } = await import('$lib/shaderCompile');
	const sg = await import('$lib/shaderGraph');
	const compiled = doc.domain === 'post' ? compilePostGraphToIR(doc) : compileShaderGraphToIR(doc);
	const errors = compiled.ok ? (get(sg.shaderErrors)[key] ?? []) : (compiled.errors ?? []);
	return {
		shader: key,
		domain: doc.domain,
		nodes: doc.nodes.map((/** @type {any} */ n) => n.id),
		// only what the text form reads: a stored node's key order is the editor's, and the printer falls back to raw JSON on any other
		text: graphToText({ nodes: doc.nodes.map((/** @type {any} */ n) => ({ id: n.id, type: n.type, data: n.data })), edges: doc.edges }, { positions: false }),
		uniforms: uniformsOf(compiled.ir?.uniforms),
		...(errors.length ? { errors } : {})
	};
}

/** @param {any} args */
async function getMaterialTool(args) {
	const uuid = args?.object ?? args?.uuid;
	if (typeof uuid !== 'string') return { error: 'object: an object uuid (list_scene)' };
	const object = objectOf(uuid);
	if (!object) return { error: 'no object with this uuid' };
	if (!object.material) return { error: 'it has no material (a group or a light)' };
	const { materialsOf } = await import('$lib/materialsHandler');
	const sg = await import('$lib/shaderGraph');
	const base = sg.isShaderDriven(uuid) ? sg.baseMaterialOf(uuid) : null;
	const groups = object.geometry?.groups ?? [];
	const list = base ? [base] : materialsOf(object);
	const slots = list.map((m, slot) => {
		const row = describeMaterial(m, slot, true);
		if (list.length > 1) row.triangles = groups.filter((/** @type {any} */ g) => (g.materialIndex || 0) === slot).reduce((/** @type {number} */ n, /** @type {any} */ g) => n + g.count / 3, 0);
		return row;
	});
	const key = sg.graphKeyFor(uuid);
	const doc = key ? sg.shaderGraphOf(key) : null;
	return { uuid, name: object.name || object.type, slots, ...(doc && key ? { shader: await shaderFacts(key, doc) } : {}) };
}

// ---- shaders --------------------------------------------------------------------------------

/**
 * A graph from a call: `text` (the flow text format) or `nodes` + `edges`.
 * @param {any} args @returns {{graph: {nodes: any[], edges: any[]}} | {error: string}}
 */
function graphFromArgs(args, textKey = 'text') {
	const text = args?.[textKey];
	if (typeof text === 'string' && text.trim()) {
		try {
			return { graph: textToGraph(text) };
		} catch (e) {
			return { error: textKey + ': ' + (e instanceof Error ? e.message : String(e)) };
		}
	}
	if (Array.isArray(args?.nodes)) {
		const nodes = args.nodes.map((/** @type {any} */ n) => ({ id: String(n?.id ?? ''), type: String(n?.type ?? ''), data: n?.data && typeof n.data === 'object' ? n.data : (n?.params ?? {}), ...(n?.position ? { position: n.position } : {}) }));
		const edges = (Array.isArray(args.edges) ? args.edges : []).map((/** @type {any} */ e) => {
			const [source, sourceHandle] = String(e?.source ?? e?.from ?? '').split('.');
			const [target, targetHandle] = String(e?.target ?? e?.to ?? '').split('.');
			const sh = e?.sourceHandle ?? sourceHandle;
			const th = e?.targetHandle ?? targetHandle;
			return { id: 'e-' + source + (sh ? '.' + sh : '') + '-' + target + (th ? '.' + th : ''), source, target, ...(sh ? { sourceHandle: sh } : {}), ...(th ? { targetHandle: th } : {}) };
		});
		return { graph: { nodes, edges } };
	}
	return { error: 'give the graph as text, e.g. "c = color {value: \\"#ff8800\\"}\\nout = surface\\nc -> out.emissive"' };
}

/** the node catalog's check + a dry compile: an error here means nothing was written
 * @param {{nodes: any[], edges: any[]}} graph @param {'surface'|'post'} domain @returns {Promise<string[]>} */
async function graphErrors(graph, domain) {
	const cat = await import('$lib/shaderCatalog');
	const { compileShaderGraphToIR, compilePostGraphToIR } = await import('$lib/shaderCompile');
	const errors = checkShaderGraph(graph, (k) => cat.shaderNodeDef(k), cat.shaderNodeDefs().map((d) => d.key));
	if (errors.length) return errors;
	const compiled = domain === 'post' ? compilePostGraphToIR(graph) : compileShaderGraphToIR(graph);
	return compiled.ok ? [] : (compiled.errors ?? ['the graph did not compile']);
}

/**
 * The driver's verdict: the GLSL node is free text, so a graph can pass the IR compile and still fail in
 * the GPU's compiler, where three only logs it. Compile the object's material now and read the program's
 * diagnostics. Best effort: no renderer (a test, SSR) or a lost context answers nothing.
 * @param {any} object @returns {Promise<string[]>}
 */
async function driverErrors(object) {
	try {
		const { globalRenderer, globalScene, globalCamera } = await import('../../stores/sceneStore.js');
		const renderer = /** @type {any} */ (get(globalRenderer));
		const scene = get(globalScene);
		const camera = get(globalCamera);
		if (!renderer?.compile || !scene || !camera || !object?.material) return [];
		renderer.compile(object, camera, scene);
		const program = renderer.properties?.get?.(object.material)?.currentProgram;
		if (!program) return [];
		program.getUniforms?.(); // what makes three run its check and fill the diagnostics
		const d = program.diagnostics;
		if (!d || d.runnable) return [];
		return [String(d.fragmentShader?.log || d.vertexShader?.log || d.programLog || 'the GPU refused this shader').slice(0, 600)];
	} catch {
		return [];
	}
}

/** Write one graph on an object and report what the compiler says; a graph the GPU refuses is taken back.
 * @param {string} uuid @param {any} patch @param {any} before the document before this write */
async function writeObjectGraph(uuid, patch, before) {
	const sg = await import('$lib/shaderGraph');
	const after = sg.setShaderGraphFor(uuid, patch);
	const compiled = await sg.compileAndApply(uuid);
	const errors = [...(compiled.errors ?? [])];
	if (!errors.length) errors.push(...(await driverErrors(objectOf(uuid))));
	if (errors.length) {
		sg.setShaderGraphFor(uuid, before ?? null);
		return { uuid, errors };
	}
	return { uuid, ok: true, ...(await shaderFacts(uuid, after)) };
}

/** @param {any} args */
async function createShaderTool(args) {
	if (args?.confirmId !== undefined) {
		// the answer to a scene-default question: the graph was checked and kept when it was asked
		const { gateScenewide } = await import('$lib/agent/confirmGate');
		return gateScenewide('create_shader', args, { summary: '', apply: () => ({ error: 'no such question' }) });
	}
	const built = graphFromArgs(args);
	if ('error' in built) return { error: built.error };
	const errors = await graphErrors(built.graph, 'surface');
	if (errors.length) return { error: 'the shader was not created', errors };
	const sg = await import('$lib/shaderGraph');
	const name = typeof args?.name === 'string' ? args.name.slice(0, 60) : undefined;
	const patch = { nodes: built.graph.nodes, edges: built.graph.edges, domain: 'surface', ...(name ? { name } : {}) };
	if (args?.scene === true) {
		const { gateScenewide } = await import('$lib/agent/confirmGate');
		return gateScenewide('create_shader', args, {
			summary: 'a default shader on every object' + (name ? ' (' + name + ')' : ''),
			apply: async () => {
				const before = sg.shaderGraphOf(sg.SCENE_GRAPH_KEY);
				const after = sg.setShaderGraphFor(sg.SCENE_GRAPH_KEY, before ? { ...before, ...patch } : patch);
				const compiled = await sg.compileAndApply(sg.SCENE_GRAPH_KEY);
				if (compiled.errors?.length) {
					sg.setShaderGraphFor(sg.SCENE_GRAPH_KEY, before ?? null);
					return { error: 'the shader was not applied', errors: compiled.errors };
				}
				return { created: [{ scene: true, ...(await shaderFacts(sg.SCENE_GRAPH_KEY, after)) }] };
			}
		});
	}
	const { uuids, error } = targetsOf(args, MAX_SHADER_OBJECTS);
	if (error) return { error: error + ', or scene: true for the scene default' };
	/** @type {any[]} */
	const created = [];
	/** @type {any[]} */
	const skipped = [];
	for (const uuid of uuids) {
		const object = objectOf(uuid);
		const refusal = !object ? 'no object with this uuid' : (lockSkip(uuid, object) ?? sg.shaderRefusalReason(object));
		if (refusal) {
			skipped.push({ uuid, reason: refusal });
			continue;
		}
		const before = get(sg.shaderGraphs)[uuid] ? sg.shaderGraphOf(uuid) : null;
		if (before && args.replace !== true) {
			skipped.push({ uuid, reason: 'it already has a shader graph: use edit_shader, or pass replace: true' });
			continue;
		}
		const row = await writeObjectGraph(uuid, structuredClone(patch), before);
		if (row.errors) skipped.push({ uuid, reason: 'the compiler refused it', errors: row.errors });
		else created.push(row);
	}
	if (!created.length) return { error: 'the shader was not created', skipped };
	return { created, ...(skipped.length ? { skipped } : {}) };
}

/** @param {any} args */
async function editShaderTool(args) {
	const sg = await import('$lib/shaderGraph');
	const key = args?.shader ?? args?.object ?? args?.uuid;
	if (typeof key !== 'string' || !key) return { error: 'shader: the key from create_shader or list_materials (an object uuid, "scene" or "post:…")' };
	const doc = sg.shaderGraphOf(key);
	if (!doc) return { error: 'no shader graph "' + key.slice(0, 40) + '" (create_shader makes one)' };
	const object = objectOf(key);
	const locked = object ? lockSkip(key, object) : null;
	if (locked) return { error: locked };
	const params = args?.params;
	if (params !== undefined && (!Array.isArray(params) || params.some((p) => !p || typeof p.node !== 'string' || typeof p.param !== 'string' || p.value === undefined)))
		return { error: 'params: a list of {"node": "<id>", "param": "<name>", "value": …}' };
	/** @type {{nodes: any[], edges: any[]} | null} */
	let next = null;
	if (typeof args?.text === 'string') {
		const built = graphFromArgs(args);
		if ('error' in built) return { error: built.error };
		next = built.graph;
	} else if (typeof args?.add === 'string' || Array.isArray(args?.removeNodes)) {
		/** @type {any} */
		let add = { nodes: [], edges: [] };
		if (typeof args.add === 'string') {
			const built = graphFromArgs(args, 'add');
			if ('error' in built) return { error: built.error };
			add = built.graph;
		}
		next = mergeShaderGraph(doc, add, { nodes: args.removeNodes });
	}
	if (!next && !params?.length) return { error: 'nothing to edit: give text (the whole graph), add, removeNodes or params' };
	const after = next ?? { nodes: doc.nodes, edges: doc.edges };
	/** @type {string[]} */
	const paramErrors = [];
	const withParams = {
		...after,
		nodes: after.nodes.map((/** @type {any} */ n) => ({ ...n, data: { ...(n.data ?? {}) } }))
	};
	const cat = await import('$lib/shaderCatalog');
	for (const p of params ?? []) {
		const node = withParams.nodes.find((/** @type {any} */ n) => n.id === p.node);
		if (!node) {
			paramErrors.push('no node "' + p.node + '"');
			continue;
		}
		const names = (cat.shaderNodeDef(node.type)?.params ?? []).map((/** @type {any} */ r) => r.name);
		if (!names.includes(p.param)) paramErrors.push('a ' + node.type + ' has no param "' + p.param + '" (' + names.join(', ') + ')');
		else node.data[p.param] = p.value;
	}
	if (paramErrors.length) return { error: 'the shader was not changed', errors: paramErrors };
	const errors = await graphErrors(withParams, doc.domain);
	if (errors.length) return { error: 'the shader was not changed', errors };
	if (object) {
		const row = await writeObjectGraph(key, next ? { nodes: withParams.nodes, edges: withParams.edges } : { nodes: withParams.nodes }, doc);
		if (row.errors) return { error: 'the compiler refused it; the shader was not changed', errors: row.errors };
		return { updated: [row] };
	}
	// a scene default or a post graph: only reached by name, and its compile runs on its own domain
	const written = next
		? sg.setShaderGraphFor(key, { nodes: withParams.nodes, edges: withParams.edges })
		: (params.forEach((/** @type {any} */ p) => sg.setShaderParam(key, p.node, p.param, p.value)), sg.shaderGraphOf(key));
	await sg.compileAndApply(key);
	return { updated: [{ ok: true, ...(await shaderFacts(key, written)) }] };
}

/** @param {any} args */
async function assignShaderTool(args) {
	const { uuids, error } = targetsOf(args, MAX_SHADER_OBJECTS);
	if (error) return { error };
	const sg = await import('$lib/shaderGraph');
	const from = args?.shader === null ? null : (args?.shader ?? args?.from);
	if (from !== null && typeof from !== 'string') return { error: 'shader: the key of a graph to copy (an object uuid or "scene"), or null to take it off' };
	const source = from ? sg.shaderGraphOf(from) : null;
	if (from && !source) return { error: 'no shader graph "' + from.slice(0, 40) + '"' };
	if (source?.domain === 'post') return { error: 'that is a post graph: create_post_graph puts those in a look' };
	/** @type {any[]} */
	const updated = [];
	/** @type {any[]} */
	const skipped = [];
	for (const uuid of uuids) {
		const object = objectOf(uuid);
		const locked = object ? lockSkip(uuid, object) : 'no object with this uuid';
		if (locked) {
			skipped.push({ uuid, reason: locked });
			continue;
		}
		if (from === null) {
			if (!get(sg.shaderGraphs)[uuid]) {
				skipped.push({ uuid, reason: sg.graphKeyFor(uuid) ? 'it inherits the scene default, it has no graph of its own' : 'it has no shader graph' });
				continue;
			}
			sg.setShaderGraphFor(uuid, null);
			await sg.compileAndApply(uuid);
			updated.push({ uuid, ok: true, shader: null });
			continue;
		}
		const refusal = sg.shaderRefusalReason(object);
		if (refusal) {
			skipped.push({ uuid, reason: refusal });
			continue;
		}
		if (uuid === from) {
			skipped.push({ uuid, reason: 'it is the graph being copied' });
			continue;
		}
		const before = get(sg.shaderGraphs)[uuid] ? sg.shaderGraphOf(uuid) : null;
		const { changedAt: _stamp, ...copy } = structuredClone(/** @type {any} */ (source));
		const row = await writeObjectGraph(uuid, copy, before);
		if (row.errors) skipped.push({ uuid, reason: 'the compiler refused it', errors: row.errors });
		else updated.push(row);
	}
	if (!updated.length) return { error: skipped.map((s) => s.reason).join('; ') || 'nothing was changed', skipped };
	return { updated, ...(skipped.length ? { skipped } : {}) };
}

/** @param {any} args */
async function describeShaderNodesTool(args) {
	const cat = await import('$lib/shaderCatalog');
	const domain = args?.domain === 'post' ? 'post' : 'surface';
	const wanted = Array.isArray(args?.types) ? new Set(args.types) : null;
	const socket = (/** @type {any} */ s) => s.name + ':' + s.type;
	const rows = cat
		.shaderNodeDefs()
		.filter((d) => (wanted ? wanted.has(d.key) : !d.stages || d.stages.includes(domain === 'post' ? 'post' : 'fragment') || d.stages.includes('vertex')))
		.map((d) => ({
			type: d.key,
			group: d.group,
			doc: cat.shaderNodeDoc(d.key),
			...(d.params?.length ? { params: d.params.map((p) => ({ name: p.name, type: p.type, default: p.default, ...(p.uniform ? { uniform: true } : {}) })) } : {}),
			...(d.inputs?.length ? { inputs: d.inputs.map(socket) } : {}),
			...(d.outputs?.length ? { outputs: d.outputs.map(socket) } : {})
		}));
	return {
		nodes: rows,
		format: 'one line per node: id = type {param: value}; one per edge: source[.output] -> target.input. End at a "' + cat.outputNodeFor(domain) + '" node.',
		uniforms: 'a param marked uniform compiles to u_<nodeId>_<param>; a float one can be driven by a flow "setuniform" node (data.uniform = that name) on the same object.'
	};
}

// ---- the post stack -------------------------------------------------------------------------

/** the look a call addresses @param {any} args @returns {Promise<{key: string, label: string} | {error: string}>} */
async function lookKey(args) {
	const { POST_SCENE_KEY } = await import('$lib/scenePost');
	if (args?.camera === undefined) return { key: POST_SCENE_KEY, label: 'the scene' };
	const camera = typeof args.camera === 'string' ? objectOf(args.camera) : null;
	if (!camera) return { error: 'camera: the uuid of a camera object' };
	return { key: camera.uuid, label: camera.name || 'the camera' };
}

/** the effect registry, loaded: postEffects.js registers the built-ins as it evaluates */
async function postRegistry() {
	await import('$lib/postEffects');
	return import('$lib/scenePost');
}

/** @param {any} args */
async function getPostTool(args) {
	const look = await lookKey(args);
	if ('error' in look) return { error: look.error };
	const sp = await postRegistry();
	const stack = sp.postStackFor(look.key);
	return {
		enabled: stack.enabled,
		...(stack.mode ? { mode: stack.mode } : {}),
		effects: stack.effects.map((e) => ({ id: e.id, kind: e.kind, enabled: e.enabled, params: e.params })),
		kinds: sp.postEffectKinds().map((k) => ({
			kind: k.kind,
			label: k.label,
			params: (k.params ?? []).map((/** @type {any} */ p) => ({
				key: p.key,
				...(p.options ? { options: p.options.map((/** @type {any} */ o) => o.value) } : { min: p.min, max: p.max }),
				default: p.default
			}))
		}))
	};
}

/** @param {any} args */
async function setPostTool(args) {
	const look = await lookKey(args);
	if ('error' in look) return { error: look.error };
	const sp = await postRegistry();
	if (args?.confirmId === undefined) {
		if (args?.enabled === undefined && args?.effects === undefined && args?.mode === undefined) return { error: 'nothing to set: give enabled, effects or mode' };
		if (args?.enabled !== undefined && typeof args.enabled !== 'boolean') return { error: 'enabled: true or false' };
		if (args?.mode !== undefined && (args.mode !== 'append' && args.mode !== 'replace')) return { error: 'mode: append or replace' };
		if (args?.mode !== undefined && args?.camera === undefined) return { error: 'mode: only a camera look has one' };
	}
	const kinds = sp.postEffectKinds().map((k) => k.kind);
	const plan = planPost(sp.postStackFor(look.key), args ?? {}, (k) => sp.postEffectDef(k), kinds);
	if (plan.errors.length && args?.confirmId === undefined) return { error: 'the look was not changed', errors: plan.errors };
	const words = plan.ops.map((op) => (op.op === 'remove' ? 'remove ' : op.op === 'add' ? 'add ' : 'adjust ') + op.kind);
	if (args?.enabled !== undefined) words.push(args.enabled ? 'turn the look on' : 'turn the look off');
	const { gateScenewide } = await import('$lib/agent/confirmGate');
	return gateScenewide('set_post', args, {
		summary: 'post effects on ' + look.label + ': ' + words.join(', '),
		apply: () => {
			// planned again here: the stack may have moved while the host thought about it
			const now = planPost(sp.postStackFor(look.key), args, (k) => sp.postEffectDef(k), kinds);
			if (now.errors.length) return { error: 'the look was not changed', errors: now.errors };
			sp.beginLookGesture(look.key);
			try {
				for (const op of now.ops) {
					if (op.op === 'remove') {
						sp.removePostEffect(op.id, look.key);
						continue;
					}
					const id = op.op === 'add' ? sp.addPostEffect(op.kind, op.at, look.key) : op.id;
					op.id = id;
					if (Object.keys(op.params ?? {}).length) sp.setPostEffectParams(id, op.params, look.key);
					if (op.enabled !== undefined) sp.setPostEffectEnabled(id, op.enabled, look.key);
					if (op.op === 'edit' && op.at !== undefined) sp.movePostEffect(id, op.at, look.key);
				}
				if (args.enabled !== undefined) sp.setScenePostEnabled(args.enabled, look.key);
				if (args.mode !== undefined) sp.setCameraLookMode(look.key, args.mode);
			} finally {
				sp.endLookGesture();
			}
			const stack = sp.postStackFor(look.key);
			return { updated: [{ look: look.key, ok: true }], enabled: stack.enabled, effects: stack.effects.map((e) => ({ id: e.id, kind: e.kind, enabled: e.enabled, params: e.params })) };
		}
	});
}

/** @param {any} args */
async function createPostGraphTool(args) {
	const look = await lookKey(args);
	if ('error' in look) return { error: look.error };
	await postRegistry();
	const pg = await import('$lib/postGraphs');
	const sg = await import('$lib/shaderGraph');
	const name = typeof args?.name === 'string' ? args.name.slice(0, 60) : undefined;
	const presets = pg.postPresets();
	const presetKey = typeof args?.preset === 'string' ? args.preset : undefined;
	if (presetKey && !presets.some((/** @type {any} */ p) => p.key === presetKey || p.id === presetKey)) return { error: 'preset: one of ' + presets.map((/** @type {any} */ p) => p.key).join(', ') };
	/** @type {{nodes: any[], edges: any[]} | null} */
	let graph = null;
	if (typeof args?.text === 'string' || Array.isArray(args?.nodes)) {
		const built = graphFromArgs(args);
		if ('error' in built) return { error: built.error };
		graph = built.graph;
		const errors = await graphErrors(graph, 'post');
		if (errors.length) return { error: 'the post graph was not created', errors };
	} else if (!presetKey && args?.confirmId === undefined) return { error: 'give a preset, or the graph as text ending at a "postOutput" node' };
	const { gateScenewide } = await import('$lib/agent/confirmGate');
	return gateScenewide('create_post_graph', args, {
		summary: 'a custom post effect on ' + look.label + ': ' + (name ?? presetKey ?? 'a graph'),
		apply: async () => {
			const { key, id } = pg.addPostGraphToLook({ preset: presetKey, name, docKey: look.key });
			if (graph) sg.setShaderGraphFor(key, { nodes: graph.nodes, edges: graph.edges });
			await sg.compileAndApply(key);
			const doc = sg.shaderGraphOf(key);
			return { created: [{ look: look.key, effect: id, ...(doc ? await shaderFacts(key, doc) : { shader: key }) }] };
		}
	});
}

// ---- UV -------------------------------------------------------------------------------------

/** @param {any} args */
async function uvUnwrapTool(args) {
	const { uuids, error } = targetsOf(args);
	if (error) return { error };
	const method = UNWRAP_METHODS[String(args?.method ?? 'smart')];
	if (!method) return { error: 'method: box, planar, smart, cylindrical or spherical' };
	const ue = await import('$lib/uvEditor');
	/** @type {any[]} */
	const updated = [];
	/** @type {any[]} */
	const skipped = [];
	for (const uuid of uuids) {
		const object = objectOf(uuid);
		const locked = object ? lockSkip(uuid, object) : 'no object with this uuid';
		const editable = object ? ue.uvEditable(object) : null;
		if (locked || !editable?.ok) {
			skipped.push({ uuid, reason: locked ?? editable?.reason });
			continue;
		}
		/** @type {Set<number> | null} */
		let only = null;
		if (args?.faces !== undefined) {
			const picked = await selectFaces(object, args.faces);
			if (picked.error) {
				skipped.push({ uuid, reason: picked.error });
				continue;
			}
			only = new Set(picked.tris);
		}
		if (await ue.unwrapObject(uuid, method, {}, only)) updated.push({ uuid, ok: true, method });
		else skipped.push({ uuid, reason: 'that unwrap produced nothing' });
	}
	if (!updated.length) return { error: skipped.map((s) => s.reason).join('; ') || 'nothing was unwrapped', skipped };
	return { updated, ...(skipped.length ? { skipped } : {}) };
}

/** per-face mapping: the selected faces re-projected, the rest untouched @param {string} uuid @param {any} object @param {any} args @param {any} t */
async function setFaceUv(uuid, object, args, t) {
	const picked = await selectFaces(object, args.faces);
	if (picked.error) return { error: picked.error };
	const ue = await import('$lib/uvEditor');
	/** @type {any} */
	const fe = await import('$lib/faceEdit');
	const { recordEntry } = await import('$lib/history');
	const editable = ue.uvEditable(object);
	if (!editable.ok) return { error: editable.reason };
	const before = ue.readUvSnapshot(object);
	const tris = picked.rows;
	const uvs = projectFaceUvs(picked.tris.map((i) => [tris[i][0], tris[i][1], tris[i][2]]), t);
	picked.tris.forEach((triIndex, k) => (tris[triIndex].uv = uvs[k]));
	const after = { positions: fe.trisToPositions(tris), groups: fe.trisToGroups(tris), uvs: fe.trisToUVs(tris) };
	fe.applyMeshGeo(uuid, after.positions, after.groups, after.uvs);
	ue.broadcastUvGeo(uuid, after);
	recordEntry({ kind: 'meshgeo', uuid, before, after });
	return { faces: picked.tris.length };
}

/** @param {any} args */
async function setUvTool(args) {
	const { uuids, error } = targetsOf(args);
	if (error) return { error };
	const t = parseUvTransform(args);
	if (t.errors.length) return { error: t.errors.join('; ') };
	if (args?.faces === undefined && t.tiling === undefined && t.offset === undefined && t.rotation === undefined) return { error: 'nothing to set: give tiling, offset, rotation, or faces (a per-face mapping)' };
	const slot = args?.slot === undefined ? 0 : args.slot;
	if (!Number.isInteger(slot) || slot < 0) return { error: 'slot: a whole number from 0' };
	/** @type {string[] | undefined} */
	let only;
	if (args?.maps !== undefined) {
		const parsed = parseMaps(Object.fromEntries((Array.isArray(args.maps) ? args.maps : []).map((/** @type {string} */ w) => [w, null])));
		if (!Array.isArray(args.maps) || parsed.errors.length) return { error: 'maps: a list of albedo, normal, roughness, metalness, emissive, ao' };
		only = Object.keys(parsed.slots);
	}
	const mp = await import('$lib/materialPresets');
	const { materialsOf } = await import('$lib/materialsHandler');
	/** @type {any[]} */
	const updated = [];
	/** @type {any[]} */
	const skipped = [];
	for (const uuid of uuids) {
		const object = objectOf(uuid);
		const locked = object ? lockSkip(uuid, object) : 'no object with this uuid';
		if (locked) {
			skipped.push({ uuid, reason: locked });
			continue;
		}
		if (args?.faces !== undefined) {
			const out = await setFaceUv(uuid, object, args, t);
			if (out.error) skipped.push({ uuid, reason: out.error });
			else updated.push({ uuid, ok: true, triangles: out.faces });
			continue;
		}
		if (!materialsOf(object)[slot]) {
			skipped.push({ uuid, reason: 'it has no material slot ' + slot });
			continue;
		}
		/** @type {string[]} */
		let written = [];
		const applied = mp.replaceMaterials(uuid, (payload) => {
			written = setPayloadTransform(payload, slot, t, only, () => THREE.MathUtils.generateUUID());
			return written.length ? payload : null;
		});
		if (!applied) skipped.push({ uuid, reason: 'that slot has no texture to tile (set_material maps first)' });
		else updated.push({ uuid, ok: true, slot, maps: written.map((k) => SLOT_WORD[k]) });
	}
	if (!updated.length) return { error: skipped.map((s) => s.reason).join('; ') || 'nothing was changed', skipped };
	return { updated, ...(skipped.length ? { skipped } : {}) };
}

// ---- the dispatcher -------------------------------------------------------------------------

/** @param {string} name @param {any} args */
export async function lookTool(name, args) {
	switch (name) {
		case 'set_material':
			return setMaterialTool(args ?? {});
		case 'list_materials':
			return listMaterialsTool(args ?? {});
		case 'get_material':
			return getMaterialTool(args ?? {});
		case 'create_shader':
			return createShaderTool(args ?? {});
		case 'edit_shader':
			return editShaderTool(args ?? {});
		case 'assign_shader':
			return assignShaderTool(args ?? {});
		case 'describe_shader_nodes':
			return describeShaderNodesTool(args ?? {});
		case 'set_post':
			return setPostTool(args ?? {});
		case 'get_post':
			return getPostTool(args ?? {});
		case 'create_post_graph':
			return createPostGraphTool(args ?? {});
		case 'uv_unwrap':
			return uvUnwrapTool(args ?? {});
		case 'set_uv':
			return setUvTool(args ?? {});
		default:
			return { error: 'unknown look tool ' + name };
	}
}

// ---- schemas --------------------------------------------------------------------------------

const OBJECTS_SCHEMA = { type: 'array', items: { type: 'string' }, maxItems: MAX_OBJECTS, description: 'object uuids (list_scene)' };
const FACES_SCHEMA = {
	type: 'object',
	description: 'which faces: {"normal": "up"|"down"|"+x"|"-x"|"+z"|"-z"|[x,y,z], "angle": 30}, {"box": {"min": [..], "max": [..]}} (local space), {"indices": [..]} or {"all": true}; filters AND together'
};
const CONFIRM_SCHEMA = {
	confirmId: { type: 'string', description: 'the id a needsConfirm answer gave: repeat the call with it to get the host\'s answer and apply' },
	wait: { type: 'number', description: 'with confirmId: seconds to wait for the answer (up to 60)' }
};

export const LOOK_AI_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'set_material',
			description:
				'Make objects look finished: colour, roughness, metalness, emissive, opacity and texture maps, on many objects in one call. Maps take a library image hash or an https URL (https only, CORS-enabled, 16 MB, PNG/JPEG/WebP/GIF/AVIF; it becomes a library item first and is re-encoded like an upload; returned in assets). cc0 fetches a free CC0 material by name (Poly Haven / ambientCG); preset applies a named preset. faces gives just those faces their own new material slot. One undo step.',
			parameters: {
				type: 'object',
				properties: {
					objects: OBJECTS_SCHEMA,
					color: { type: 'string', description: 'base colour: hex or a CSS name' },
					roughness: { type: 'number', minimum: 0, maximum: 1 },
					metalness: { type: 'number', minimum: 0, maximum: 1 },
					emissive: { type: 'string', description: 'glow colour: hex or a CSS name' },
					emissiveIntensity: { type: 'number', minimum: 0, maximum: 100 },
					opacity: { type: 'number', minimum: 0, maximum: 1, description: 'below 1 also turns transparent on' },
					transparent: { type: 'boolean' },
					params: { type: 'object', description: 'any other material number, e.g. {"clearcoat": 1, "transmission": 0.9, "ior": 1.5} (those need type MeshPhysicalMaterial)' },
					maps: {
						type: 'object',
						description: 'texture slots, each a library image hash, an https URL, or null to clear',
						properties: {
							albedo: { type: ['string', 'null'] },
							normal: { type: ['string', 'null'] },
							roughness: { type: ['string', 'null'] },
							metalness: { type: ['string', 'null'] },
							emissive: { type: ['string', 'null'] },
							ao: { type: ['string', 'null'] }
						}
					},
					type: { type: 'string', enum: MATERIAL_TYPES, description: 'swap the material class first' },
					preset: { type: 'string', description: 'a preset name from list_materials' },
					cc0: { type: 'string', description: 'a CC0 material by name, e.g. "Wood051" or "brown planks"' },
					slot: { type: 'integer', minimum: 0, description: 'which material slot of a multi-material object (default 0)' },
					faces: FACES_SCHEMA
				},
				required: ['objects']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'list_materials',
			description: 'What objects wear: per object its material slots (type, colour, numbers, which maps) and shader, plus the preset names and shader keys. Read this before editing.',
			parameters: {
				type: 'object',
				properties: {
					objects: OBJECTS_SCHEMA,
					name: { type: 'string', description: 'only objects whose name contains this' },
					page: { type: 'integer', minimum: 0 },
					limit: { type: 'integer', minimum: 1, maximum: MAX_LIST }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'get_material',
			description: 'One object\'s material in full: every slot, each map\'s tiling / offset / rotation / size / hash, and its shader graph as text with the uniforms a flow can drive.',
			parameters: { type: 'object', properties: { object: { type: 'string', description: 'object uuid' } }, required: ['object'] }
		}
	},
	{
		type: 'function',
		function: {
			name: 'create_shader',
			description:
				'Give objects a node shader, written as text like flow graphs: one line per node (id = type {param: value}), one per edge (source[.output] -> target.input), ending at a "surface" node. Example: c = color {value: "#ff8800"}\\nout = surface\\nc -> out.emissive. Call describe_shader_nodes for the types. Each object gets its own copy. Compiler errors come back in the result and nothing is written. Returns the graph key and its uniforms: a float one (u_<nodeId>_<param>) can be driven by a flow "setuniform" node on that object. scene: true makes the default for every object, which asks the host first.',
			parameters: {
				type: 'object',
				properties: {
					objects: { ...OBJECTS_SCHEMA, maxItems: MAX_SHADER_OBJECTS },
					text: { type: 'string', description: 'the graph as text' },
					name: { type: 'string' },
					replace: { type: 'boolean', description: 'replace a graph the object already has' },
					scene: { type: 'boolean', description: 'the scene default instead of objects (asks the host)' },
					...CONFIRM_SCHEMA
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'edit_shader',
			description: 'Change a shader graph: params [{node, param, value}] for values, add (text: new or replaced nodes, new edges), removeNodes, or text for the whole graph. Errors come back and nothing changes.',
			parameters: {
				type: 'object',
				properties: {
					shader: { type: 'string', description: 'the key from create_shader or list_materials' },
					params: { type: 'array', items: { type: 'object', properties: { node: { type: 'string' }, param: { type: 'string' }, value: {} }, required: ['node', 'param', 'value'] } },
					add: { type: 'string', description: 'text: nodes to add or replace and edges to add' },
					removeNodes: { type: 'array', items: { type: 'string' } },
					text: { type: 'string', description: 'the whole graph as text' }
				},
				required: ['shader']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'assign_shader',
			description: 'Copy an existing shader graph onto objects (each gets its own copy), or take a shader off with shader: null.',
			parameters: {
				type: 'object',
				properties: {
					objects: { ...OBJECTS_SCHEMA, maxItems: MAX_SHADER_OBJECTS },
					shader: { type: ['string', 'null'], description: 'the key of the graph to copy, or null to remove' }
				},
				required: ['objects', 'shader']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'describe_shader_nodes',
			description: 'The shader node catalog: each type with what it does, its params (which become uniforms), inputs and outputs.',
			parameters: {
				type: 'object',
				properties: {
					types: { type: 'array', items: { type: 'string' }, description: 'only these' },
					domain: { type: 'string', enum: ['surface', 'post'] }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'set_post',
			description:
				'The scene\'s post effects (bloom, huesaturation, brightnesscontrast, tonemapping, vignette, grain, chromaticaberration, ao, lut, pixelation, scanlines, dotscreen, smaa; get_post lists every param). effects: [{kind, params, enabled, at, remove}], matched to what is there by id or kind, so repeating a call does not stack a second bloom; replace: true drops the rest; the stack order is the order of effect. This changes the whole scene\'s look: the first call returns needsConfirm and the host is asked; repeat it with confirmId. One undo step.',
			parameters: {
				type: 'object',
				properties: {
					enabled: { type: 'boolean', description: 'the whole stack on or off' },
					effects: {
						type: 'array',
						maxItems: 24,
						items: {
							type: 'object',
							properties: {
								id: { type: 'string' },
								kind: { type: 'string' },
								params: { type: 'object' },
								enabled: { type: 'boolean' },
								at: { type: 'integer', minimum: 0, description: 'position in the stack' },
								remove: { type: 'boolean' }
							}
						}
					},
					replace: { type: 'boolean' },
					camera: { type: 'string', description: 'a camera\'s own look instead of the scene\'s' },
					mode: { type: 'string', enum: ['append', 'replace'], description: 'camera look: add to the scene look, or replace it' },
					...CONFIRM_SCHEMA
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'get_post',
			description: 'The look stack as it is (effects with ids and params) and every effect kind with its params and ranges.',
			parameters: { type: 'object', properties: { camera: { type: 'string', description: 'a camera\'s own look instead of the scene\'s' } } }
		}
	},
	{
		type: 'function',
		function: {
			name: 'create_post_graph',
			description: 'A custom post effect: a preset, or a shader graph as text ending at a "postOutput" node (describe_shader_nodes domain post), added to the look. Changes the whole scene\'s look, so it asks the host first like set_post. Compiler errors come back in the result.',
			parameters: {
				type: 'object',
				properties: {
					preset: { type: 'string' },
					text: { type: 'string' },
					name: { type: 'string' },
					camera: { type: 'string' },
					...CONFIRM_SCHEMA
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'uv_unwrap',
			description: 'New texture coordinates: smart (flat islands by surface direction, the default), box, planar, cylindrical, spherical. faces limits it to those faces and leaves the rest. Use it when a texture smears on a model. One undo step.',
			parameters: {
				type: 'object',
				properties: { objects: OBJECTS_SCHEMA, method: { type: 'string', enum: Object.keys(UNWRAP_METHODS) }, faces: FACES_SCHEMA },
				required: ['objects']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'set_uv',
			description:
				'Tile, shift or rotate a material slot\'s textures (tiling: 4 repeats a floor texture four times). maps limits it to some slots. With faces it maps only those faces instead: they are projected flat so the image fills them once (a label on one side of a box), with tiling / offset / rotation on top; pair it with set_material faces for an image only on that face. One undo step.',
			parameters: {
				type: 'object',
				properties: {
					objects: OBJECTS_SCHEMA,
					tiling: { type: ['array', 'number'], items: { type: 'number' }, description: '[u, v] or one number' },
					offset: { type: 'array', items: { type: 'number' }, description: '[u, v]' },
					rotation: { type: 'number', description: 'radians, about the middle of the image' },
					slot: { type: 'integer', minimum: 0, description: 'material slot (default 0)' },
					maps: { type: 'array', items: { type: 'string', enum: ['albedo', 'normal', 'roughness', 'metalness', 'emissive', 'ao'] } },
					faces: FACES_SCHEMA
				},
				required: ['objects']
			}
		}
	}
];

/** what the system prompt says about these tools */
export const LOOK_PROMPT =
	'\n\nMaterials and looks: set_material takes colour, numbers and texture maps (library hash or https URL) on many objects at once; list_materials / get_material read what is there. create_shader writes a node shader as text (describe_shader_nodes lists the nodes) and returns uniforms a flow setuniform node can drive. set_post / create_post_graph change the whole scene\'s look: they answer needsConfirm until the host allows it, then repeat the call with confirmId. uv_unwrap and set_uv fix how a texture sits (tiling, or per-face mapping).';
