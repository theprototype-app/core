// Roadmap 85b lane 85-world — FURNISH A WORLD: the agent / assistant tools for assets, terrain, scatter, water,
// particles and sound (W1-W6, W5b, W7, L7). The connector lists them as two families (tools/agent/src/catalog.js):
//
//   assets  {search, place, prefab}         search_assets / place_asset / prefab
//   effects {particles, scatter, terrain, water, sound, music}
//                                           create_particles / scatter / terrain / water / place_sound / set_music
//
// Every write is a path a person's edit already takes — the Asset Browser's drop (explorerDrop.placeFromGhost), the
// Effects / Water menus' mutators (particleActions, waterActions), the Inspector's terrain writes (set_geometry's
// geometry message, the sculpt brush + one meshgeo snapshot, terrainPaint's layers / splat / scatter sets), the
// node editor's flow-node path for a sound, sceneMusic for the track — so peers, the viewer gate and the A8 log
// behave as for the panels, and ONE undo takes a call back (the caller's history batch). Everything heavy loads on
// first use: this module is reached from tools.js by a dynamic import.
import { get } from 'svelte/store';
import * as THREE from 'three';
import { objectsGroup, pokeScene } from '../../stores/sceneStore.js';
import { peers } from '../../stores/appStore.js';
import { recordEntry, registerHistoryKind } from '$lib/history';
import { lockSkip } from './lockNote.js';
import { sessionNow } from '$lib/sessionClock';
import {
	TEXTURE_PATTERNS,
	patternCanvas,
	ASSET_KINDS,
	queryWords,
	scoreAsset,
	parseAssetId,
	parseSculptOps,
	scatterSetOf,
	sniffAudio,
	AUDIO_MAX_BYTES,
	SOUND_TRIGGERS,
	placementPoints
} from './worldToolsCore.js';
import { PARTICLE_PRESETS, PARTICLE_DEFAULTS, particlePreset } from '$lib/particlePresets';

/** the tool names this module answers */
export const WORLD_TOOL_NAMES = ['search_assets', 'place_asset', 'prefab', 'create_particles', 'scatter', 'terrain', 'water', 'place_sound', 'set_music'];
/** the ones that only read */
export const WORLD_READ_TOOLS = ['search_assets'];

const MAX_RESULTS = 40;
const MAX_PLACE = 50;
const MAX_COORD = 1e5;

/** @param {number} n */
const r3 = (n) => Math.round(n * 1000) / 1000;
/** @param {string} uuid @returns {any} */
const objectOf = (uuid) => /** @type {any} */ (get(objectsGroup))?.getObjectByProperty?.('uuid', uuid);
/** @param {any} v @returns {number[] | null} */
const vec3 = (v) => (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORD) ? v : null);
/** @param {any} data */
function send(data) {
	/** @type {any} */
	const peer = get(peers);
	peer?.send?.(data);
}

/**
 * @typedef {(spec: any, extraTypes?: string[]) => any} CreateBase create_objects' createOne
 */

/** an object made by a tool that must be scenery (an emitter marker, a sound holder): no physics body, no shadow.
 * The Effects menu's own steps, each recorded so the call's ONE undo takes them back with the create. @param {any} object */
function makeScenery(object) {
	const before = object.userData.physics ? { ...object.userData.physics } : null;
	if (before) {
		delete object.userData.physics;
		recordEntry({ kind: 'props', uuid: object.uuid, before: { physics: before }, after: { physics: null } });
		send({ type: 'objectParameters', parameter: 'physics', uuid: object.uuid, physics: null });
	}
	if (object.isMesh) {
		object.castShadow = false;
		object.userData.shadow = false;
		send({ type: 'objectParameters', parameter: 'castShadow', uuid: object.uuid, castShadow: false });
	}
}

// ---------------------------------------------------------------- L7 procedural textures

/**
 * A procedural texture by name → a library image (add_image's canvas path: drawn, encoded, hashed, shared with every
 * peer), once per call however many slots name it. @param {any} pattern @param {Map<string, any>} [seen]
 * @returns {Promise<{hash: string, name: string} | {error: string}>}
 */
export async function patternImage(pattern, seen = new Map()) {
	const made = patternCanvas(pattern);
	if ('error' in made) return made;
	const key = JSON.stringify(made.canvas);
	if (seen.has(key)) return seen.get(key);
	const { addImageTool } = await import('./imageTool.js');
	const done = /** @type {any} */ (await addImageTool({ canvas: made.canvas, name: 'pattern ' + made.name, source: 'procedural ' + made.name }));
	const out = done.error ? { error: 'pattern ' + made.name + ': ' + done.error } : { hash: String(done.hash), name: String(done.name) };
	seen.set(key, out);
	return out;
}

/**
 * set_material's `pattern` (L7) and `maps.<slot>: {pattern}` → library hashes, before the look tool reads the call.
 * `pattern` alone is the albedo; `patternScale` tiles it (the caller runs set_uv with `tiling`). @param {any} args
 * @returns {Promise<{args: any, patterns?: string[], tiling?: number[]} | {error: string}>}
 */
export async function resolvePatterns(args) {
	const hasTop = args?.pattern !== undefined;
	const maps = args?.maps && typeof args.maps === 'object' && !Array.isArray(args.maps) ? args.maps : null;
	const inMaps = maps ? Object.entries(maps).filter(([, v]) => v && typeof v === 'object' && !Array.isArray(v) && v.pattern !== undefined) : [];
	if (!hasTop && !inMaps.length) return { args };
	const seen = new Map();
	const next = { ...args, maps: { ...(maps ?? {}) } };
	/** @type {string[]} */
	const patterns = [];
	if (hasTop) {
		if (maps?.albedo !== undefined) return { error: 'give pattern or maps.albedo, not both' };
		const got = await patternImage(args.pattern, seen);
		if ('error' in got) return got;
		next.maps.albedo = got.hash;
		patterns.push(typeof args.pattern === 'string' ? args.pattern : String(args.pattern?.name ?? ''));
		delete next.pattern;
	}
	for (const [slot, v] of inMaps) {
		const got = await patternImage(/** @type {any} */ (v).pattern, seen);
		if ('error' in got) return { error: 'maps.' + slot + ': ' + got.error };
		next.maps[slot] = got.hash;
		patterns.push(String(/** @type {any} */ (v).pattern?.name ?? /** @type {any} */ (v).pattern));
	}
	if (args.patternScale !== undefined) {
		const s = args.patternScale;
		if (typeof s !== 'number' || !(s > 0) || s > 1000) return { error: 'patternScale: how many times the pattern repeats across each face, above 0 (e.g. 4)' };
		delete next.patternScale;
		return { args: next, patterns, tiling: [s, s] };
	}
	return { args: next, patterns };
}

// ---------------------------------------------------------------- W1 search_assets

/** library rows @param {string[]} kinds */
async function libraryRows(kinds) {
	const ex = await import('$lib/explorer');
	const kindOf = (/** @type {any} */ it) => (it.kind === 'object' ? 'model' : it.kind === 'audio' ? 'sound' : it.kind === 'image' ? 'image' : it.kind === 'hdri' || /\.(hdr|exr)$/i.test(it.name) ? 'hdri' : '');
	return /** @type {any[]} */ (get(ex.explorerItems))
		.map((it) => ({ it, kind: kindOf(it) }))
		.filter((r) => r.kind && kinds.includes(r.kind))
		.map(({ it, kind }) => ({
			id: 'lib:' + it.hash,
			name: String(it.name),
			kind,
			source: 'library',
			licence: String(it.licence ?? it.license ?? '') || 'your library',
			bytes: Number(it.size) || undefined,
			tags: [...(Array.isArray(it.tags) ? it.tags : []), String(it.source ?? '')]
		}));
}

/** pack rows (models; a zip pack's sounds land in the library when installed) @param {string[]} kinds @param {string[]} notes */
async function packRows(kinds, notes) {
	if (!kinds.includes('model')) return [];
	const pk = await import('$lib/packs');
	if (!(/** @type {any[]} */ (get(pk.packs)).length)) await pk.loadPacks();
	/** @type {any[]} */
	const rows = [];
	for (const pack of /** @type {any[]} */ (get(pk.packs))) {
		if (pack.source === 'imported') continue; // its items ARE library items, listed there
		if (!pack.listUrl) continue;
		let items = [];
		try {
			items = await pk.listPackItems(pack);
		} catch {
			notes.push('the pack "' + pack.title + '" could not be read');
			continue;
		}
		for (const it of items)
			rows.push({
				id: 'pack:' + pack.name + '/' + it.name,
				name: String(it.label || it.name),
				kind: 'model',
				source: 'pack ' + pack.title,
				licence: pack.license || 'see the pack',
				bytes: it.dims?.bytes || undefined,
				size: Array.isArray(it.dims?.size) ? it.dims.size.map(r3) : undefined,
				tags: [it.name, pack.name, pack.title, ...(it.behavior ? ['functional', String(it.behavior.kind ?? '')] : [])]
			});
	}
	return rows;
}

/** prefab rows @param {string[]} kinds */
async function prefabRows(kinds) {
	if (!kinds.includes('prefab')) return [];
	const pf = await import('$lib/prefabs');
	await pf.loadPrefabs();
	return /** @type {any[]} */ (get(pf.prefabs)).map((p) => ({ id: 'prefab:' + p.id, name: String(p.name), kind: 'prefab', source: 'your prefabs', licence: 'your library', tags: Array.isArray(p.tags) ? p.tags : [] }));
}

/** CC0 rows: Poly Haven's materials and HDRIs (ambientCG is searched by name when set_material {cc0} asks) @param {string[]} kinds @param {string[]} notes */
async function cc0Rows(kinds, notes) {
	/** @type {('textures' | 'hdris')[]} */
	const want = [...(kinds.includes('material') ? /** @type {const} */ (['textures']) : []), ...(kinds.includes('hdri') ? /** @type {const} */ (['hdris']) : [])];
	if (!want.length) return [];
	const fetchers = await import('$lib/cc0/cc0Fetch.js');
	const core = await import('$lib/cc0/cc0Core.js');
	/** @type {any[]} */
	const rows = [];
	for (const t of want) {
		try {
			for (const r of core.normalizePolyHaven((await fetchers.phList(t)).data, t))
				rows.push({
					id: 'cc0:polyhaven/' + r.id,
					name: r.name,
					kind: t === 'hdris' ? 'hdri' : 'material',
					source: 'Poly Haven',
					licence: 'CC0',
					tags: [r.id, ...r.categories, ...r.tags],
					popularity: r.popularity
				});
		} catch {
			notes.push('Poly Haven could not be reached for ' + (t === 'hdris' ? 'HDRIs' : 'materials'));
		}
	}
	return rows;
}

/** @param {any} args */
async function searchAssetsTool(args) {
	const words = queryWords(args.query);
	let kinds = ASSET_KINDS.slice();
	if (args.kinds !== undefined || args.kind !== undefined) {
		const raw = args.kinds ?? [args.kind];
		if (!Array.isArray(raw) || !raw.length || !raw.every((k) => ASSET_KINDS.includes(k))) return { error: 'kinds: some of ' + ASSET_KINDS.join(', ') };
		kinds = raw;
	}
	const sources = args.sources ?? ['library', 'packs', 'prefabs', 'cc0'];
	if (!Array.isArray(sources) || !sources.every((s) => ['library', 'packs', 'prefabs', 'cc0'].includes(s))) return { error: 'sources: some of library, packs, prefabs, cc0' };
	const limit = Math.min(MAX_RESULTS, Math.max(1, Number.isInteger(args.limit) ? args.limit : 12));
	/** @type {string[]} */
	const notes = [];
	const all = [
		...(sources.includes('library') ? await libraryRows(kinds) : []),
		...(sources.includes('prefabs') ? await prefabRows(kinds) : []),
		...(sources.includes('packs') ? await packRows(kinds, notes) : []),
		...(sources.includes('cc0') ? await cc0Rows(kinds, notes) : [])
	];
	const ranked = all
		.map((row, i) => ({ row, i, score: scoreAsset(row, words) }))
		.filter((r) => r.score > 0)
		.sort((a, b) => b.score - a.score || (b.row.popularity ?? 0) - (a.row.popularity ?? 0) || a.i - b.i);
	const results = ranked.slice(0, limit).map(({ row }) => {
		const { tags: _t, popularity: _p, ...out } = row;
		out.use =
			row.kind === 'model' || row.kind === 'prefab'
				? "assets {action: 'place', place: {asset: id, position}}"
				: row.kind === 'material'
					? 'set_look {action: \'material\', material: {objects, cc0: "' + row.name + '"}}'
					: row.kind === 'sound'
						? "effects {action: 'sound', sound: {asset: id, position}}"
						: row.kind === 'image'
							? 'a texture: set_look material maps {albedo: hash}'
							: 'the sky / environment light (85-scene)';
		return out;
	});
	return { query: words.join(' '), found: ranked.length, results, ...(notes.length ? { notes } : {}) };
}

// ---------------------------------------------------------------- W1 place_asset

/**
 * An asset id → the Asset Browser's drop payload + its size when known.
 * @param {any} id @returns {Promise<{payload: any, dims: any, name: string} | {error: string}>}
 */
async function payloadOf(id) {
	const ref = parseAssetId(id);
	if ('error' in ref) return ref;
	if (ref.source === 'lib') {
		const ex = await import('$lib/explorer');
		const item = ex.itemByHash(ref.ref);
		if (!item) return { error: 'asset: nothing in the library has that hash' };
		if (item.kind !== 'object') return { error: 'asset: "' + item.name + '" is a ' + item.kind + ', not a model — ' + (item.kind === 'audio' ? "use effects {action: 'sound'}" : item.kind === 'image' ? 'use it as a texture (set_look material)' : 'it cannot be placed') };
		return { payload: { id: item.id, name: item.name }, dims: null, name: String(item.name).replace(/\.\w+$/, '') };
	}
	if (ref.source === 'prefab') {
		const pf = await import('$lib/prefabs');
		await pf.loadPrefabs();
		const p = pf.prefabById(ref.ref) ?? /** @type {any[]} */ (get(pf.prefabs)).find((e) => String(e.name).toLowerCase() === ref.ref.toLowerCase());
		if (!p) return { error: 'asset: no prefab with that id or name (search_assets kinds: ["prefab"])' };
		return { payload: { prefabId: p.id }, dims: null, name: String(p.name) };
	}
	if (ref.source === 'pack') {
		const pk = await import('$lib/packs');
		if (!(/** @type {any[]} */ (get(pk.packs)).length)) await pk.loadPacks();
		const pack = pk.packByName(ref.ref);
		if (!pack) return { error: 'asset: no pack called "' + ref.ref.slice(0, 40) + '"' };
		const items = await pk.listPackItems(pack);
		const it = items.find((/** @type {any} */ i) => i.name === ref.item);
		if (!it?.glbUrl) return { error: 'asset: the pack "' + pack.title + '" has no item "' + String(ref.item).slice(0, 40) + '"' };
		return { payload: { url: it.glbUrl, name: it.name, packName: pack.name, lods: it.lods, behavior: it.behavior ?? null }, dims: it.dims ?? null, name: String(it.label || it.name) };
	}
	return { error: 'asset: a CC0 ' + (String(ref.item ?? '').length ? 'material or HDRI' : 'asset') + ' is not placed as an object — a material goes on objects with set_look {action: "material", material: {cc0: name}}' };
}

/** @param {any} args */
async function placeAssetTool(args) {
	const got = await payloadOf(args.asset ?? args.id);
	if ('error' in got) return got;
	const at = args.position === undefined ? [0, 0, 0] : vec3(args.position);
	if (!at) return { error: 'position: [x, y, z] metres (world)' };
	const count = args.count ?? 1;
	if (!Number.isInteger(count) || count < 1 || count > MAX_PLACE) return { error: 'count: 1-' + MAX_PLACE };
	const spacing = args.spacing ?? 2;
	if (typeof spacing !== 'number' || !Number.isFinite(spacing) || spacing < 0 || spacing > 100) return { error: 'spacing: metres between copies (0-100)' };
	const yaw = args.yaw ?? 0;
	if (typeof yaw !== 'number' || !Number.isFinite(yaw)) return { error: 'yaw: radians about the up axis' };
	const scale = args.scale;
	if (scale !== undefined && !(typeof scale === 'number' && scale > 0 && scale <= 100)) return { error: 'scale: a factor above 0 (at most 100)' };
	const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw).toArray();
	const { placeFromGhost } = await import('$lib/explorerDrop');
	/** @type {any[]} */
	const created = [];
	// one item per placeFromGhost: a many-item placement opens a history batch of its own, which would end the call's
	for (const position of placementPoints(at, count, spacing, yaw)) {
		const uuids = await placeFromGhost([{ payload: got.payload, dims: got.dims }], [{ position, quaternion }]);
		for (const uuid of uuids) {
			const o = objectOf(uuid);
			if (o && scale !== undefined) {
				// the transform path create_objects / update_objects take (a move + one transform entry)
				const { applyAiTransform } = await import('./tools.js');
				applyAiTransform(o, { scale: [o.scale.x * scale, o.scale.y * scale, o.scale.z * scale] });
			}
			if (args.name && o) {
				const { renameObject } = await import('$lib/objectActions');
				renameObject(uuid, count > 1 ? args.name + ' ' + (created.length + 1) : String(args.name).slice(0, 120));
			}
			created.push({ uuid, name: o?.name ?? got.name, position: position.map(r3) });
		}
	}
	if (!created.length) return { error: 'the asset could not be placed (a pack item needs the network; the library file may be unreadable)' };
	pokeScene();
	return { created, asset: String(args.asset ?? args.id), note: 'Placed the way a drag from the Asset Browser places it; one undo step.' };
}

// ---------------------------------------------------------------- W7 prefab

/** @param {any} args */
async function prefabTool(args) {
	const mode = args.mode ?? (args.objects ? 'save' : 'place');
	if (mode === 'save') {
		const uuids = Array.isArray(args.objects) ? [...new Set(args.objects)] : [];
		if (!uuids.length || uuids.length > 200 || !uuids.every((u) => typeof u === 'string' && objectOf(u))) return { error: 'objects: 1-200 uuids of objects in the scene (list_scene)' };
		const pf = await import('$lib/prefabs');
		await pf.loadPrefabs();
		const entry = /** @type {any} */ (await pf.savePrefabSelection(uuids, typeof args.name === 'string' ? args.name.slice(0, 80) : undefined));
		if (!entry) return { error: 'the prefab could not be saved (over 5 MB?)' };
		return { saved: { id: 'prefab:' + entry.id, name: entry.name }, note: 'Kept in this person\'s prefab library (not a scene change). Place copies with mode "place".' };
	}
	if (mode === 'place') {
		const id = typeof args.prefab === 'string' ? (args.prefab.startsWith('prefab:') ? args.prefab : 'prefab:' + args.prefab) : '';
		if (!id) return { error: 'prefab: the id (prefab:…) or name of a saved prefab' };
		return placeAssetTool({ ...args, asset: id });
	}
	return { error: 'mode: save (objects → a prefab) or place (copies of one)' };
}

// ---------------------------------------------------------------- W5 particles

/** the fields an override may set, with their kinds */
const PARTICLE_ENUMS = /** @type {Record<string, string[]>} */ ({
	mode: ['continuous', 'burst'],
	shape: ['cone', 'sphere', 'disc', 'box'],
	colorMode: ['life', 'particle'],
	sprite: ['dot', 'streak', 'puff', 'star', 'square'],
	blending: ['additive', 'normal'],
	space: ['local', 'world'],
	aim: ['emitter', 'world'],
	render: ['points', 'stretch', 'trails', 'ribbon'],
	ground: ['splash', 'settle']
});

/** @param {any} o @returns {{patch: any} | {error: string}} */
function particleOverrides(o) {
	if (o === undefined) return { patch: {} };
	if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: 'overrides: {count, lifetime, colorStart, …}' };
	/** @type {any} */
	const patch = {};
	for (const [k, v] of Object.entries(o)) {
		if (!(k in PARTICLE_DEFAULTS) && !['area', 'wind', 'fall', 'ground'].includes(k)) return { error: 'overrides.' + k + ': not a particle field — ' + Object.keys(PARTICLE_DEFAULTS).join(', ') };
		if (PARTICLE_ENUMS[k]) {
			if (!PARTICLE_ENUMS[k].includes(/** @type {any} */ (v))) return { error: 'overrides.' + k + ': one of ' + PARTICLE_ENUMS[k].join(', ') };
		} else if (k === 'colorStart' || k === 'colorEnd') {
			if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) return { error: 'overrides.' + k + ': a hex colour like "#ffaa00"' };
		} else if (k === 'offset' || k === 'wind') {
			if (!vec3(v)) return { error: 'overrides.' + k + ': [x, y, z]' };
		} else if (k === 'area') {
			if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && n > 0 && n <= 500)) return { error: 'overrides.area: [width, depth] metres' };
		} else if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e4) return { error: 'overrides.' + k + ': a number' };
		if (k === 'count' && (/** @type {number} */ (v) < 1 || /** @type {number} */ (v) > 2000)) return { error: 'overrides.count: 1-2000 particles' };
		patch[k] = v;
	}
	return { patch };
}

/** @param {any} args @param {CreateBase} createBase */
async function createParticlesTool(args, createBase) {
	const pa = await import('$lib/particleActions');
	if (args.remove === true) {
		const object = objectOf(String(args.object ?? ''));
		if (!object) return { error: 'object: the uuid of an object with particles' };
		if (!object.userData.particles) return { error: 'that object has no particles' };
		pa.removeObjectParticles(object.uuid);
		return { updated: [{ uuid: object.uuid, ok: true, removed: true }] };
	}
	const key = args.preset ?? (args.object && objectOf(String(args.object))?.userData?.particles?.preset) ?? 'sparkles';
	const preset = PARTICLE_PRESETS.find((p) => p.key === key || p.name.toLowerCase() === String(key).toLowerCase());
	if (!preset) return { error: 'preset: one of ' + PARTICLE_PRESETS.map((p) => p.key).join(', ') };
	const over = particleOverrides(args.overrides);
	if ('error' in over) return over;
	/** @type {any} */
	let object;
	let made = false;
	if (args.object !== undefined) {
		object = objectOf(String(args.object));
		if (!object) return { error: 'object: no object with that uuid' };
		const lock = lockSkip(object.uuid, object);
		if (lock) return { error: String(lock) };
	} else {
		const at = args.position === undefined ? [0, 0, 0] : vec3(args.position);
		if (!at) return { error: 'position: [x, y, z] metres' };
		// the Effects menu's marker: a small sphere, scenery; a weather preset hangs at cloud height over the point
		const fall = Number(/** @type {any} */ (preset.config).fall) || 0;
		const r = createBase({ kind: 'primitive', primitive: 'Sphere', params: [0.15], name: String(args.name ?? preset.name + ' emitter').slice(0, 120), position: [at[0], at[1] + fall, at[2]] });
		if (r.error) return { error: r.error };
		object = objectOf(r.uuid);
		if (!object) return { error: 'the emitter could not be made' };
		makeScenery(object);
		made = true;
	}
	const current = object.userData.particles;
	const keep = !made && current && current.preset === preset.key && args.preset === undefined;
	const config = keep ? { ...PARTICLE_DEFAULTS, ...current, ...over.patch } : { ...particlePreset(preset.key), ...over.patch };
	pa.setObjectParticles(object.uuid, config);
	const row = { uuid: object.uuid, name: object.name, preset: preset.key };
	return made ? { created: [row] } : { updated: [{ ...row, ok: true }] };
}

// ---------------------------------------------------------------- W2 terrain

const TERRAIN_FIELDS = /** @type {Record<string, string>} */ ({ size: 'size', segments: 'segments', seed: 'seed', height: 'amplitude', amplitude: 'amplitude', detail: 'frequency', frequency: 'frequency', octaves: 'octaves', ridged: 'ridged', warp: 'warp', edges: 'falloff', falloff: 'falloff', offsetX: 'offsetX', offsetZ: 'offsetZ' });

/** @param {any} args @param {CreateBase} createBase */
async function terrainTool(args, createBase) {
	/** @type {any} */
	const params = {};
	for (const [k, v] of Object.entries(args)) if (TERRAIN_FIELDS[k]) params[TERRAIN_FIELDS[k]] = v;
	/** @type {any} */
	let object;
	let made = false;
	/** @type {string[]} */
	const warnings = [];
	if (args.uuid !== undefined) {
		object = objectOf(String(args.uuid));
		if (!object?.userData?.terrain) return { error: 'uuid: no terrain with that uuid (make one: leave uuid out)' };
		const lock = lockSkip(object.uuid, object);
		if (lock) return { error: String(lock) };
	} else {
		const at = args.position === undefined ? [0, 0, 0] : vec3(args.position);
		if (!at) return { error: 'position: [x, y, z] metres' };
		const size = typeof params.size === 'number' && params.size >= 1 && params.size <= 200 ? params.size : 24;
		const r = createBase({ kind: 'primitive', primitive: 'Terrain', params: [size, 48], name: String(args.name ?? 'Terrain').slice(0, 120), position: at }, ['Terrain']);
		if (r.error) return { error: r.error };
		object = objectOf(r.uuid);
		if (!object) return { error: 'the terrain could not be made' };
		made = true;
		delete params.size;
	}
	const uuid = object.uuid;
	// 1. the shape (the geometry message + history kind — set_geometry's path), BEFORE any sculpting
	if (Object.keys(params).length) {
		const { geometryTool } = await import('./geometryTools.js');
		const done = /** @type {any} */ (await geometryTool('set_geometry', { updates: [{ uuid, params, ...(args.force ? { force: true } : {}) }] }, createBase));
		const row = done.updated?.[0];
		if (!row?.ok) return { error: 'the terrain shape: ' + (row?.error ?? done.error ?? 'not changed'), ...(made ? { created: [{ uuid, name: object.name }] } : {}) };
		if (row.warnings) warnings.push(...row.warnings);
	}
	// 2. paint layers (the Inspector's one write path), a pattern by name becoming a library texture
	if (args.layers !== undefined) {
		if (!Array.isArray(args.layers) || args.layers.length > 4) return { error: 'layers: up to 4 {color, texture (a library hash or a pattern name), tiling}' };
		const tp = await import('$lib/terrainPaint');
		const cur = tp.layersOf(uuid);
		const next = [];
		for (let i = 0; i < 4; i++) {
			const l = args.layers[i];
			if (l == null) {
				next.push(cur[i]);
				continue;
			}
			/** @type {any} */
			const out = { ...cur[i] };
			if (l.color !== undefined) out.color = String(l.color).toLowerCase();
			if (l.tiling !== undefined) out.tiling = l.tiling;
			if (l.texture !== undefined || l.pattern !== undefined) {
				const t = l.pattern ?? l.texture;
				if (t === null || t === '') out.texture = '';
				else if (typeof t === 'string' && /^[0-9a-z_-]{16,128}$/i.test(t)) out.texture = t;
				else {
					const img = await patternImage(t);
					if ('error' in img) return { error: 'layers[' + i + ']: ' + img.error };
					out.texture = img.hash;
				}
			}
			next.push(out);
		}
		tp.setTerrainLayers(uuid, next);
	}
	// 3. sculpt + paint ops: the brush the Sculpt toolbar runs, then ONE meshgeo snapshot (+ one splat entry)
	object.geometry?.computeBoundingBox?.();
	const bb = object.geometry?.boundingBox;
	const size = bb ? Math.max(1, bb.max.x - bb.min.x) : 24;
	const parsed = parseSculptOps(args.ops, size);
	if ('error' in parsed) return parsed;
	let sculpted = 0;
	let painted = 0;
	if (parsed.ops.length) {
		const ts = await import('$lib/terrainSculpt');
		const tp = await import('$lib/terrainPaint');
		const before = object.geometry.attributes.position.array.slice();
		const paints = parsed.ops.filter((o) => o.op === 'paint');
		for (const o of parsed.ops.filter((o) => o.op !== 'paint')) {
			for (let p = 0; p < o.passes; p++) {
				const dt = o.height ? o.height / (Math.max(0.01, o.strength) * 8) : 1 / 6;
				if (ts.applyBrushAt(uuid, o.x, o.z, o.op, o.radius, o.strength, dt)) sculpted++;
			}
		}
		if (sculpted) {
			const after = object.geometry.attributes.position.array;
			const { commitMeshGeoSnapshot } = await import('$lib/faceEdit');
			commitMeshGeoSnapshot(uuid, Array.from(before), Array.from(after));
		}
		if (paints.length) {
			if (!tp.beginPaintStroke(uuid)) return { error: 'this terrain cannot be painted here' };
			for (const o of paints) for (let p = 0; p < o.passes; p++) if (tp.paintStrokeAt(uuid, o.x, o.z, o.layer, o.radius, o.strength, 1 / 6)) painted++;
			// the stroke's ONE commit + undo entry; a paint that touched nothing records nothing
			tp.endPaintStroke();
		}
		pokeScene();
	}
	const row = { uuid, name: object.name, ...(sculpted ? { sculpted } : {}), ...(painted ? { painted } : {}), ...(warnings.length ? { warnings } : {}) };
	return made ? { created: [row] } : { updated: [{ ...row, ok: true }] };
}

// ---------------------------------------------------------------- W3 scatter

/** an asset of scatter → a 51 source @param {any} a @returns {Promise<any | {error: string}>} */
async function scatterSourceOf(a) {
	const { SCATTER_PRIMITIVES } = await import('$lib/terrainScatterCore');
	if (typeof a === 'string' && SCATTER_PRIMITIVES.map((p) => p.toLowerCase()).includes(a.toLowerCase()))
		return { kind: 'primitive', type: SCATTER_PRIMITIVES.find((p) => p.toLowerCase() === a.toLowerCase()) };
	const ref = parseAssetId(a);
	if ('error' in ref) return { error: 'asset: a primitive (' + SCATTER_PRIMITIVES.join(', ') + ') or a model id from search_assets (lib:… or pack:…)' };
	if (ref.source === 'lib') {
		const ex = await import('$lib/explorer');
		const item = ex.itemByHash(ref.ref);
		if (!item || item.kind !== 'object') return { error: 'asset: no model in the library has that hash' };
		return { kind: 'library', hash: item.hash, name: String(item.name) };
	}
	if (ref.source === 'pack') {
		const got = await payloadOf(a);
		if ('error' in got) return got;
		const { packRefFromUrl } = await import('$lib/packRefs');
		const pr = packRefFromUrl(got.payload.url, { pack: got.payload.packName, item: got.payload.name });
		if (!pr) return { error: 'asset: that pack item cannot be scattered' };
		return { kind: 'pack', path: pr.path, pack: pr.pack, item: pr.item };
	}
	return { error: 'asset: a prefab or CC0 asset cannot be scattered — a primitive, a library model or a pack model' };
}

/** @param {any} args */
async function scatterTool(args) {
	const object = objectOf(String(args.surface ?? args.object ?? ''));
	if (!object) return { error: 'surface: the uuid of a terrain or any mesh to scatter on' };
	const lock = lockSkip(object.uuid, object);
	if (lock) return { error: String(lock) };
	const tp = await import('$lib/terrainPaint');
	if (args.remove !== undefined) {
		if (typeof args.remove !== 'string' || !tp.editScatterSet(object.uuid, args.remove, null)) return { error: 'remove: the id of a scatter set on this surface (list_scene shows them)' };
		return { updated: [{ uuid: object.uuid, ok: true, removed: args.remove }] };
	}
	const list = args.assets ?? (args.asset !== undefined ? [args.asset] : null);
	if (!Array.isArray(list) || !list.length || list.length > 8) return { error: 'asset: what to scatter (or assets: up to 8, mixed evenly)' };
	/** @type {any[]} */
	const sources = [];
	for (const a of list) {
		const s = await scatterSourceOf(a);
		if (s.error) return s;
		sources.push(s);
	}
	const made = scatterSetOf(args, sources);
	if ('error' in made) return made;
	const id = tp.addScatterSet(object.uuid, made.set);
	if (!id) return { error: 'the scatter set was refused (a surface holds up to 8 sets; it must be a terrain or a mesh)' };
	const instances = tp.scatterInstancesOf(object.uuid, id);
	return { updated: [{ uuid: object.uuid, ok: true, set: id, instances: Array.isArray(instances) ? instances.length : undefined }] };
}

// ---------------------------------------------------------------- W4 water

const WATER_SHAPES = /** @type {Record<string, {primitive: string, params: number[], shape: string}>} */ ({
	tank: { primitive: 'Box', params: [2, 1.2, 1], shape: 'box' },
	pool: { primitive: 'Box', params: [6, 1.5, 4], shape: 'box' },
	ocean: { primitive: 'Box', params: [80, 2, 80], shape: 'plane' },
	lake: { primitive: 'Box', params: [20, 1, 20], shape: 'plane' },
	round: { primitive: 'Cylinder', params: [1.5, 1.5, 1.2], shape: 'cylinder' }
});

/** @param {any} args @param {CreateBase} createBase */
async function waterTool(args, createBase) {
	const wa = await import('$lib/water/waterActions.js');
	const { WATER_PRESETS } = await import('$lib/water/presets.js');
	if (args.preset !== undefined && !WATER_PRESETS.some((p) => p.key === args.preset)) return { error: 'preset: one of ' + WATER_PRESETS.map((p) => p.key).join(', ') };
	/** @type {any} */
	let object;
	let made = false;
	if (args.uuid !== undefined) {
		object = objectOf(String(args.uuid));
		if (!object) return { error: 'uuid: no object with that uuid' };
		const lock = lockSkip(object.uuid, object);
		if (lock) return { error: String(lock) };
		if (args.remove === true) {
			if (!object.userData.water) return { error: 'that object is not water' };
			wa.removeObjectWater(object.uuid);
			return { updated: [{ uuid: object.uuid, ok: true, removed: true }] };
		}
		if (!object.userData.water && args.preset === undefined) return { error: 'that object is not water yet: give a preset to make it water' };
	} else {
		const kind = args.kind ?? 'pool';
		const k = WATER_SHAPES[kind];
		if (!k) return { error: 'kind: one of ' + Object.keys(WATER_SHAPES).join(', ') };
		const at = args.position === undefined ? [0, 0, 0] : vec3(args.position);
		if (!at) return { error: 'position: [x, y, z] metres (the bottom centre of the water)' };
		let params = k.params;
		if (args.size !== undefined) {
			const s = args.size;
			if (!Array.isArray(s) || !(s.length === 3 || (kind === 'round' && s.length === 2)) || !s.every((n) => typeof n === 'number' && n > 0 && n <= 2000)) return { error: 'size: [width, depth (height), length] metres' + (kind === 'round' ? ' — or [radius, height] for round' : '') };
			params = kind === 'round' ? [s[0], s[0], s[s.length - 1]] : s;
		}
		const h = kind === 'round' ? params[2] : params[1];
		const r = createBase({ kind: 'primitive', primitive: k.primitive, params, name: String(args.name ?? (kind === 'ocean' ? 'Ocean' : kind === 'lake' ? 'Lake' : 'Water')).slice(0, 120), position: [at[0], at[1] + h / 2, at[2]] });
		if (r.error) return { error: r.error };
		object = objectOf(r.uuid);
		if (!object) return { error: 'the water could not be made' };
		// makeWater's steps, each recorded: a STATIC SENSOR body (bodies fall in, buoyancy floats them), no shadow
		object.castShadow = false;
		object.userData.shadow = false;
		send({ type: 'objectParameters', parameter: 'castShadow', uuid: object.uuid, castShadow: false });
		const { setPhysicsFor } = await import('$lib/physics');
		setPhysicsFor(object.uuid, { mode: 'static', sensor: true });
		const { waterPreset } = await import('$lib/water/presets.js');
		wa.setObjectWater(object.uuid, waterPreset(args.preset ?? (kind === 'ocean' ? 'ocean' : kind === 'lake' ? 'lake' : kind === 'tank' ? 'aquarium' : 'pool'), { shape: k.shape }));
		made = true;
	}
	if (!made && args.preset !== undefined) wa.applyWaterPreset(object.uuid, args.preset);
	/** @type {any} */
	const patch = {};
	if (args.level !== undefined) {
		if (typeof args.level !== 'number' || args.level < 0 || args.level > 1) return { error: 'level: how full, 0-1' };
		patch.level = args.level;
	}
	for (const k of ['look', 'waves', 'flow']) {
		if (args[k] === undefined) continue;
		if (!args[k] || typeof args[k] !== 'object' || Array.isArray(args[k])) return { error: k + ': an object of ' + k + ' fields' };
		patch[k] = args[k];
	}
	if (args.color !== undefined) patch.look = { ...(patch.look ?? {}), shallowColor: args.color };
	if (Object.keys(patch).length) wa.updateObjectWater(object.uuid, patch, { immediate: true });
	const water = object.userData.water;
	const row = { uuid: object.uuid, name: object.name, preset: water?.preset ?? args.preset, level: water?.level };
	return made ? { created: [row] } : { updated: [{ ...row, ok: true }] };
}

// ---------------------------------------------------------------- W6 sound + music

/**
 * A sound source → a library audio item. A library hash, a `lib:` id or an https URL (fetched by the texture URL
 * rules, the bytes sniffed — WAV / OGG / MP3 / FLAC / M4A / WebM only — and decoded once to prove they ARE audio;
 * nothing is executed). @param {any} source @returns {Promise<{hash: string, name: string, from: string} | {error: string}>}
 */
export async function soundItem(source) {
	const ex = await import('$lib/explorer');
	const s = typeof source === 'string' ? source.trim() : '';
	if (!s) return { error: 'asset: a library sound (its hash or lib: id) or an https URL of a sound file' };
	if (/^https?:/i.test(s)) {
		const { checkTextureUrl } = await import('./lookToolsCore.js');
		const checked = checkTextureUrl(s);
		if (!checked.ok) return { error: 'asset: ' + checked.error };
		const { readHttpsBytes } = await import('./lookTools.js');
		const { FETCH_TIMEOUT_MS } = await import('./imageToolCore.js');
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
		/** @type {any} */
		let got;
		try {
			got = await readHttpsBytes(checked.url, fetch, abort.signal, AUDIO_MAX_BYTES);
		} catch {
			got = { error: 'it took over ' + FETCH_TIMEOUT_MS / 1000 + ' s' };
		} finally {
			clearTimeout(timer);
		}
		if (got.error) return { error: s.slice(0, 60) + ': ' + got.error };
		const type = sniffAudio(got.bytes);
		if (!type) return { error: s.slice(0, 60) + ': it is not a sound file this app plays (WAV, OGG, MP3, FLAC, M4A, WebM)' };
		const Ctx = /** @type {any} */ (globalThis).OfflineAudioContext;
		if (Ctx) {
			try {
				await new Ctx(1, 1, 44100).decodeAudioData(got.bytes.slice().buffer);
			} catch {
				return { error: s.slice(0, 60) + ': the file does not decode as audio' };
			}
		}
		const base = String(got.name || 'sound').replace(/\.[a-z0-9]{2,5}$/i, '') || 'sound';
		const item = await ex.addItemFromBytes(/** @type {ArrayBuffer} */ (got.bytes.slice().buffer), base + '.' + type.ext);
		if (!item) return { error: s.slice(0, 60) + ': the library refused it' };
		return { hash: String(item.hash), name: String(item.name), from: 'url' };
	}
	const hash = s.startsWith('lib:') ? s.slice(4) : s;
	const item = ex.itemByHash(hash);
	if (!item || item.kind !== 'audio') return { error: 'asset: no sound in the library has that hash (search_assets kinds: ["sound"])' };
	return { hash: String(item.hash), name: String(item.name), from: 'library' };
}

/** @param {any} args @param {CreateBase} createBase */
async function placeSoundTool(args, createBase) {
	const snd = await soundItem(args.asset ?? args.url ?? args.hash);
	if ('error' in snd) return snd;
	const volume = args.volume ?? 0.8;
	const radius = args.radius ?? 5;
	if (typeof volume !== 'number' || volume < 0 || volume > 1) return { error: 'volume: 0-1' };
	if (typeof radius !== 'number' || radius <= 0 || radius > 500) return { error: 'radius: metres it is heard at full volume (above 0)' };
	const on = args.on;
	if (on !== undefined && !(on in SOUND_TRIGGERS)) return { error: 'on: what plays it — one of ' + Object.keys(SOUND_TRIGGERS).join(', ') + ' (leave it out to play all the time)' };
	if (on !== undefined && args.object === undefined) return { error: 'on: give object too — the thing that is clicked, entered or hit plays the sound' };
	const loop = args.loop ?? on === undefined;
	/** @type {any} */
	let owner;
	let made = false;
	if (args.object !== undefined) {
		owner = objectOf(String(args.object));
		if (!owner) return { error: 'object: no object with that uuid' };
		const lock = lockSkip(owner.uuid, owner);
		if (lock) return { error: String(lock) };
	} else {
		const at = args.position === undefined ? [0, 1, 0] : vec3(args.position);
		if (!at) return { error: 'position: [x, y, z] metres' };
		const r = createBase({ kind: 'group', name: String(args.name ?? 'Sound ' + snd.name.replace(/\.\w+$/, '')).slice(0, 120), position: at });
		if (r.error) return { error: r.error };
		owner = objectOf(r.uuid);
		if (!owner) return { error: 'the sound holder could not be made' };
		made = true;
	}
	// the Explorer asset first (above), then the node in the owner's graph — the node editor's path, one undo step
	const { createFlowNodesTool } = await import('./flowTools.js');
	const nodes = [{ type: 'sound', ref: 'snd', data: { hash: snd.hash, file: snd.name, volume, radius, rolloff: 1, loop, playing: on === undefined } }];
	const edges = [];
	if (on !== undefined) {
		nodes.push({ type: /** @type {any} */ (SOUND_TRIGGERS)[on], ref: 'on', data: /** @type {any} */ ({}) });
		edges.push({ from: 'on', to: 'snd', toHandle: 'trigger' });
	}
	const done = /** @type {any} */ (createFlowNodesTool({ graph: owner.uuid, nodes, edges }, { allow: ['sound'] }));
	if (done.error) return { error: 'the sound node: ' + done.error, ...(made ? { created: [{ uuid: owner.uuid, name: owner.name }] } : {}) };
	// the bytes reach every peer the way the Inspector's sound pick sends them
	try {
		const { sendAsset } = await import('$lib/assetShare');
		sendAsset(snd.hash);
	} catch {
		/* peers pull a missing hash themselves */
	}
	const row = { uuid: owner.uuid, name: owner.name, sound: snd.hash, file: snd.name, node: done.created?.[0]?.id, ...(on ? { on } : {}), ...(snd.from === 'url' ? { addedToLibrary: true } : {}) };
	return made ? { created: [row] } : { updated: [{ ...row, ok: true }] };
}

/** the music track had no undo (the Inspector's pick is a plain write): the kind is registered when the tool first
 * runs — before any entry of it can exist — so this module's body stays free of side effects (it is in the
 * assistant's static graph and the catalog generator's SSR load) @type {any} */
let musicModule = null;

/** @returns {Promise<any>} sceneMusic, with the 'music' history kind registered */
async function musicWithUndo() {
	if (musicModule) return musicModule;
	const sm = await import('$lib/sceneMusic');
	registerHistoryKind('music', (/** @type {any} */ _entry, /** @type {any} */ state) => {
		sm.commitMusic({ hash: state.hash, name: state.name, playing: state.playing, volume: state.volume, startedAt: state.playing ? sessionNow() : 0 });
		return true;
	});
	return (musicModule = sm);
}

/** @param {any} args */
async function setMusicTool(args) {
	const sm = await musicWithUndo();
	const before = { ...get(sm.music) };
	const pick = (/** @type {any} */ m) => ({ hash: m.hash ?? null, name: m.name ?? '', playing: !!m.playing, volume: m.volume ?? 0.6 });
	if (args.asset === null || args.stop === true) {
		if (args.asset === null) sm.setMusicTrack(null);
		else sm.setMusicPlaying(false);
	} else {
		if (args.asset !== undefined) {
			const snd = await soundItem(args.asset);
			if ('error' in snd) return snd;
			sm.setMusicTrack(snd.hash, snd.name);
		} else if (!before.hash) return { error: 'asset: the track (a library sound or an https URL), or null to clear it' };
		if (args.volume !== undefined) {
			if (typeof args.volume !== 'number' || args.volume < 0 || args.volume > 1) return { error: 'volume: 0-1' };
			sm.setMusicVolume(args.volume);
		}
		if (args.play === true && !get(sm.music).playing) sm.setMusicPlaying(true);
	}
	const after = get(sm.music);
	recordEntry({ kind: 'music', before: pick(before), after: pick(after) });
	return { updated: [{ uuid: 'scene', ok: true, music: after.name || after.hash || null, playing: !!after.playing, volume: after.volume }] };
}

// ---------------------------------------------------------------- the dispatch

/**
 * @param {string} name one of WORLD_TOOL_NAMES @param {any} args @param {CreateBase} createBase
 * @returns {Promise<any>}
 */
export async function worldTool(name, args, createBase) {
	const a = args && typeof args === 'object' ? args : {};
	switch (name) {
		case 'search_assets':
			return searchAssetsTool(a);
		case 'place_asset':
			return placeAssetTool(a);
		case 'prefab':
			return prefabTool(a);
		case 'create_particles':
			return createParticlesTool(a, createBase);
		case 'scatter':
			return scatterTool(a);
		case 'terrain':
			return terrainTool(a, createBase);
		case 'water':
			return waterTool(a, createBase);
		case 'place_sound':
			return placeSoundTool(a, createBase);
		case 'set_music':
			return setMusicTool(a);
		default:
			return { error: 'unknown world tool ' + name };
	}
}

// ---------------------------------------------------------------- schemas

const V3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const PATTERN_LIST = Object.entries(TEXTURE_PATTERNS)
	.map(([k, v]) => k + ' (' + v + ')')
	.join(', ');
/** the `pattern` schema set_material and terrain layers share (L7) */
export const PATTERN_SCHEMA = {
	description:
		'a procedural texture by name — ' + PATTERN_LIST + ' — or {name, colors: [dark, light, …], scale: repeats of the motif (1 = its own), seed, size: 128|256|512|1024}. It becomes a library image, shared with every peer.'
};

export const WORLD_AI_TOOLS = [
	{
		type: 'function',
		function: {
			name: 'search_assets',
			description:
				'Find assets to build with, by words and kind: models and prefabs to place, sounds, images, CC0 materials and HDRIs. Searches the shared library, the model packs, your prefabs and Poly Haven. Each result has an id, name, kind, source, licence, size when known, and how to use it. Read-only.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'words, e.g. "pine tree", "wooden crate", "campfire crackle"; empty lists everything of the kinds' },
					kinds: { type: 'array', items: { type: 'string', enum: [...ASSET_KINDS] }, description: 'default all' },
					sources: { type: 'array', items: { type: 'string', enum: ['library', 'packs', 'prefabs', 'cc0'] }, description: 'default all' },
					limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS, description: 'default 12' }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'place_asset',
			description:
				'Place a model or prefab found with search_assets, the way dragging it from the Asset Browser does (replicated, one undo step). count + spacing make a row; yaw turns it. Returns the new uuids. A model by URL goes through import_model instead.',
			parameters: {
				type: 'object',
				properties: {
					asset: { type: 'string', description: 'an id from search_assets: lib:<hash>, pack:<pack>/<item> or prefab:<id>' },
					position: { ...V3, description: 'world metres; the model stands on this point' },
					yaw: { type: 'number', description: 'radians about the up axis' },
					scale: { type: 'number', description: 'a size factor (1 = as authored)' },
					count: { type: 'integer', minimum: 1, maximum: MAX_PLACE, description: 'copies in a row (default 1)' },
					spacing: { type: 'number', description: 'metres between copies (default 2)' },
					name: { type: 'string' }
				},
				required: ['asset']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'prefab',
			description:
				'Prefabs (stamps): mode "save" keeps objects (with their materials, flows and behaviours) as a prefab in this person\'s library and returns its id; mode "place" puts copies of a prefab into the scene with fresh ids (count + spacing for a row), one undo step.',
			parameters: {
				type: 'object',
				properties: {
					mode: { type: 'string', enum: ['save', 'place'] },
					objects: { type: 'array', items: { type: 'string' }, maxItems: 200, description: 'save: the uuids to keep together' },
					name: { type: 'string' },
					prefab: { type: 'string', description: 'place: the prefab id (prefab:…) or its name' },
					position: V3,
					yaw: { type: 'number' },
					count: { type: 'integer', minimum: 1, maximum: MAX_PLACE },
					spacing: { type: 'number' }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'create_particles',
			description:
				'Particles by preset name: ' +
				PARTICLE_PRESETS.map((p) => p.key).join(', ') +
				'. Without object it places a small emitter at position (rain and snow hang at cloud height over it); with object it attaches to that object (a torch, a campfire log). overrides tune any field (count, lifetime, speed, gravity, sizeStart, colorStart, colorEnd, opacity, …). remove: true takes them off. One undo step.',
			parameters: {
				type: 'object',
				properties: {
					preset: { type: 'string', enum: PARTICLE_PRESETS.map((p) => p.key) },
					object: { type: 'string', description: 'attach to this object (uuid) instead of placing an emitter' },
					position: V3,
					name: { type: 'string' },
					overrides: { type: 'object', description: 'particle fields: ' + Object.keys(PARTICLE_DEFAULTS).join(', ') },
					remove: { type: 'boolean' }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'scatter',
			description:
				'Scatter many instances over a terrain or any mesh (a forest on hills, rocks on a beach, flowers on a slope): asset = a primitive (Box, Sphere, Cone, Cylinder, Capsule, Dodecahedron) or a model id from search_assets, or assets = up to 8 mixed evenly. density per m² (or count), scale range, rules {slope: [min°, max°], height: [min, max] m, layer: {i, min}} keep them where they belong. Cheap instancing, seeded (the same on every peer). Returns the set id; remove: <set id> deletes a set. One undo step.',
			parameters: {
				type: 'object',
				properties: {
					surface: { type: 'string', description: 'the terrain or mesh uuid' },
					asset: { type: 'string' },
					assets: { type: 'array', items: { type: 'string' }, maxItems: 8 },
					density: { type: 'number', description: 'instances per square metre, 0.01-4 (default 0.2)' },
					count: { type: 'integer', description: 'or an exact count, 1-8000' },
					scale: { description: '[min, max] size factors (default [0.8, 1.2]) or one number' },
					spacing: { type: 'number', description: 'minimum metres between instances' },
					randomRotation: { type: 'boolean', description: 'default true' },
					rules: { type: 'object', description: '{slope: [0, 25] degrees from flat, height: [min, max] metres, layer: {i: paint layer 0-3, min: 0-1}}' },
					seed: { type: 'integer' },
					tint: { type: 'number', description: '0-1 colour variation' },
					sink: { type: 'number', description: 'metres pushed into the ground' },
					collider: { type: 'string', enum: ['none', 'box', 'sphere', 'hull'], description: 'physics for the instances (default none)' },
					remove: { type: 'string', description: 'a set id to delete instead' }
				},
				required: ['surface']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'terrain',
			description:
				'Make or change a terrain. Without uuid it makes one (size metres, at position); with uuid it changes that one. Shape by noise: height (metres), detail (0.005-0.6), octaves, ridged, warp, edges (flat|island|bowl), seed. Sculpt with ops [{op: raise|lower|smooth|flatten, at: [x, z] from the terrain\'s centre, radius, strength 0-1, height (metres, raise/lower), passes}] and paint with {op: "paint", at, radius, layer 0-3, strength}. layers: up to 4 {color, texture (a library hash or a pattern name like grass, sand, stone), tiling}. One undo step.',
			parameters: {
				type: 'object',
				properties: {
					uuid: { type: 'string' },
					name: { type: 'string' },
					position: V3,
					size: { type: 'number', minimum: 1, maximum: 200 },
					height: { type: 'number', minimum: 0, maximum: 40 },
					detail: { type: 'number' },
					octaves: { type: 'integer', minimum: 1, maximum: 6 },
					ridged: { type: 'boolean' },
					warp: { type: 'number' },
					edges: { type: 'string', enum: ['flat', 'island', 'bowl'] },
					seed: { type: 'integer' },
					ops: { type: 'array', maxItems: 64, items: { type: 'object' } },
					layers: { type: 'array', maxItems: 4, items: { type: 'object', properties: { color: { type: 'string' }, texture: { type: 'string' }, pattern: PATTERN_SCHEMA, tiling: { type: 'number' } } } },
					force: { type: 'boolean', description: 'reshape even though it was hand-sculpted (the sculpting is lost)' }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'water',
			description:
				'Water: without uuid it makes a body of water — kind tank, pool, round, lake or ocean, size [w, h, d], at position (its bottom centre). With uuid it changes one (or makes an object water with a preset). preset: pool, aquarium, ocean, lake, river, lava, swamp, toxic, ice. level 0-1 (how full), color, look {shallowColor, deepColor, clarity, foam, …}, waves {count, amplitude, wavelength, speed, direction}, flow. Things float in it in Play. remove: true makes it a plain object again. One undo step.',
			parameters: {
				type: 'object',
				properties: {
					uuid: { type: 'string' },
					kind: { type: 'string', enum: Object.keys(WATER_SHAPES) },
					preset: { type: 'string' },
					size: { type: 'array', items: { type: 'number' } },
					position: V3,
					name: { type: 'string' },
					level: { type: 'number' },
					color: { type: 'string' },
					look: { type: 'object' },
					waves: { type: 'object' },
					flow: { type: 'object' },
					remove: { type: 'boolean' }
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'place_sound',
			description:
				'A sound in the world: asset = a library sound (search_assets kinds ["sound"]) or an https URL of a sound file (it is checked and added to the library first). Positional: heard near position (or on object), radius metres. Without on it loops all the time (a campfire crackle, a river); on: click | enter | exit | grab | hit plays it once when that happens on the object. One undo step for the file\'s node and its wiring.',
			parameters: {
				type: 'object',
				properties: {
					asset: { type: 'string', description: 'lib:<hash>, a library hash, or https://…' },
					object: { type: 'string', description: 'put the sound on this object (uuid) instead of at position' },
					position: V3,
					name: { type: 'string' },
					volume: { type: 'number', minimum: 0, maximum: 1 },
					radius: { type: 'number' },
					loop: { type: 'boolean' },
					on: { type: 'string', enum: Object.keys(SOUND_TRIGGERS) }
				},
				required: ['asset']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'set_music',
			description:
				'The scene\'s background music, heard by everyone in sync: asset = a library sound or an https URL (null clears it), volume 0-1, play / stop. One undo step.',
			parameters: {
				type: 'object',
				properties: {
					asset: { type: ['string', 'null'] },
					volume: { type: 'number', minimum: 0, maximum: 1 },
					play: { type: 'boolean' },
					stop: { type: 'boolean' }
				}
			}
		}
	}
];

export const WORLD_PROMPT =
	'World tools: search_assets then place_asset for models; terrain (noise + sculpt ops + paint layers), scatter on it, water, create_particles by preset, place_sound (looping or on click / enter) and set_music. set_material takes pattern: wood, brick, marble, tiles, grass … for a procedural texture.';
