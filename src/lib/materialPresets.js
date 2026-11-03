// 37 R5 — MATERIAL PRESETS, the runtime half: the library (IndexedDB), the per-peer library
// broadcast, and APPLY.
//
// THE SHAPE IS THE ENVIRONMENT PRESETS' (86), on purpose: a person's library lives in
// IndexedDB under `matpreset:<name>`, is broadcast whole as `{type: 'matpresets', from,
// presets}` on connect and on every change, and a peer's library is shown beside yours until
// they leave. It is mesh-wide (a PERSON's library, not the scene's look — the `envpresets`
// row in peerScenes' list), never saved into a scene and never undone.
//
// APPLYING ONE IS NOT A NEW MESSAGE. A preset becomes an ordinary material replace through
// UV4's `objectParameters / materials` payload — the slot list as three's own material JSON,
// textures riding as data-URLs — so the receiver, undo (the `material` history kind's
// 'materials' param), a late joiner (the object sync carries the material) and an older peer
// all already understand it. ONE undo entry per object, ONE message per object (plus the D2
// share fan, which `broadcast` in materialsHandler does for every material message).

import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { idbGet, idbPut, idbDelete, idbKeys } from './idb';
import { recordEntry } from './history';
import { applyMaterials, materialsPayload } from './materialsHandler';
import { fanTargets } from './materialSharing';
import {
	MAT_PRESET_KEY,
	STARTER_PRESETS,
	normalizePreset,
	snapshotLook,
	sameLook,
	uniqueName,
	cleanName,
	fieldsOf,
	planBroadcast,
	splitParts,
	presetKey,
	isPresetRef,
	PRESET_MAX_PARTS,
	LOOK_DEFAULTS
} from './materialPresetsCore';
import { proceduralMaps } from './materialPresetMaps';

// PRIMED dynamic import (the materialsHandler/animationPreview pattern): objectActions holds the
// selection-tint memory, and a static edge from here would put this module (reached from
// peerHandler at boot) on a cycle through objectActions' own import tree.
/** @type {any} */
let actionsRef = null;
import('./objectActions')
	.then((module) => (actionsRef = module))
	.catch(() => {});

/** this person's saved presets: [{name, payload}] */
export const materialPresets = writable(/** @type {{name: string, payload: any}[]} */ ([]));
/** each connected peer's library, by peer id */
export const peerMaterialPresets = writable(/** @type {Record<string, any[]>} */ ({}));

/** @param {string} uuid */
function objectOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid);
}

// ---- resolving a preset into a concrete look ------------------------------------------------

/**
 * A preset with its procedural maps filled in (a starter's wood/stone), ready to compare or
 * apply. Absent maps stay absent. Never mutates the input.
 * @param {any} preset
 */
export function resolvePreset(preset) {
	const p = normalizePreset(preset);
	if (!p) return null;
	if (p.procedural) {
		const maps = proceduralMaps(p.procedural);
		delete p.procedural;
		if (maps) {
			p.map = maps.map;
			p.normalMap = maps.normalMap;
		}
	}
	return p;
}

/** the starter set, resolved (maps generated once per session) */
export function starterPresets() {
	return STARTER_PRESETS.map((p) => ({ id: p.id, label: p.label, preset: p }));
}

/** three's texture JSON for a data-URL image (the ObjectLoader input shape)
 * @param {string} uuid @param {string} image @param {boolean} color @param {number[]|undefined} repeat */
export function textureJson(uuid, image, color, repeat) {
	return {
		uuid,
		name: '',
		image,
		mapping: THREE.UVMapping,
		channel: 0,
		repeat: repeat ?? [1, 1],
		offset: [0, 0],
		center: [0, 0],
		rotation: 0,
		// REPEAT, because a preset map is a TILE (and `repeat` would do nothing under clamp)
		wrap: [THREE.RepeatWrapping, THREE.RepeatWrapping],
		format: THREE.RGBAFormat,
		type: THREE.UnsignedByteType,
		colorSpace: color ? THREE.SRGBColorSpace : THREE.NoColorSpace,
		minFilter: THREE.LinearMipmapLinearFilter,
		magFilter: THREE.LinearFilter,
		anisotropy: 4,
		flipY: true,
		generateMipmaps: true,
		premultiplyAlpha: false,
		unpackAlignment: 4
	};
}

/**
 * The UV4 `materials` wire payload for a preset worn by `object`. The LOOK comes from the
 * preset; what belongs to the OBJECT is kept from its current material: which side renders
 * (a double-sided leaf stays double-sided), wireframe, and the D2 share id (on userData of the
 * object, not the material, so it is untouched by construction).
 * @param {any} preset a RESOLVED preset @param {any} [current] the material being replaced
 */
export function presetWirePayload(preset, current) {
	/** @type {any} */
	const material = new (/** @type {any} */ (THREE))[preset.type]();
	const fields = fieldsOf(preset.type);
	for (const key of fields) {
		const value = preset[key] ?? LOOK_DEFAULTS[key];
		if (key in material && typeof value === 'number') material[key] = value;
	}
	// 40 F16: the film thickness is one [min, max] pair on the material
	if ('iridescenceThicknessRange' in material)
		material.iridescenceThicknessRange = [
			preset.iridescenceThicknessMin ?? LOOK_DEFAULTS.iridescenceThicknessMin,
			preset.iridescenceThicknessMax ?? LOOK_DEFAULTS.iridescenceThicknessMax
		];
	if (material.color) material.color.set(preset.color ?? LOOK_DEFAULTS.color);
	if (material.emissive) material.emissive.set(preset.emissive ?? LOOK_DEFAULTS.emissive);
	material.transparent = !!preset.transparent;
	if ('flatShading' in material) material.flatShading = !!preset.flatShading;
	if (current && typeof current.side === 'number') material.side = current.side;
	if (current && 'wireframe' in material && current.wireframe) material.wireframe = true;
	material.name = preset.label;
	material.userData.materialPreset = preset.label;
	if (preset.normalMap) material.userData.normalMapDataUrl = preset.normalMap;
	// 47-cc0: the CC0 credit rides the material JSON, so a peer's Inspector can name it too
	if (preset.source) material.userData.cc0Source = preset.source;
	const json = material.toJSON();
	delete json.metadata;
	material.dispose();
	/** @type {any[]} */
	const textures = [];
	/** @type {any[]} */
	const images = [];
	if (preset.map && 'map' in material) {
		const tex = THREE.MathUtils.generateUUID();
		const img = THREE.MathUtils.generateUUID();
		images.push({ uuid: img, url: preset.map });
		textures.push(textureJson(tex, img, true, preset.repeat));
		json.map = tex;
	}
	if (preset.normalMap && 'normalMap' in material) {
		const tex = THREE.MathUtils.generateUUID();
		const img = THREE.MathUtils.generateUUID();
		images.push({ uuid: img, url: preset.normalMap });
		textures.push(textureJson(tex, img, false, preset.repeat));
		json.normalMap = tex;
		const s = preset.normalScale ?? 1;
		json.normalScale = [s, s];
	}
	return {
		materials: [json],
		textures,
		images,
		mapDataUrls: [preset.map && 'map' in material ? preset.map : null]
	};
}

/**
 * Put a preset on ONE object: one undo entry, one `materials` message, and the same new
 * instance handed to every object sharing its material (D2 — the receivers get the fanned
 * message and re-unify by id). Refuses a material ARRAY (the Inspector's rule: presets edit
 * single-material objects; a slot array is the UV editor's business).
 * @param {string} uuid @param {any} preset any preset payload (starter or saved)
 * @returns {boolean}
 */
export function applyMaterialPreset(uuid, preset) {
	const object = objectOf(uuid);
	const resolved = resolvePreset(preset);
	if (!object?.material || Array.isArray(object.material) || !resolved) return false;
	return replaceMaterials(uuid, () => presetWirePayload(resolved, object.material));
}

/**
 * THE one material replace (a preset, and 85 L1 / L4's texture slots + sampler state): a `materials`
 * payload built from the current one, applied here, ONE undo entry, one message — and on a shared
 * material (D2) the new instance handed to every object sharing it.
 * @param {string} uuid @param {(before: any) => any} build gets a private copy of the current payload
 * @returns {boolean}
 */
export function replaceMaterials(uuid, build) {
	const object = objectOf(uuid);
	if (!object?.material) return false;
	const before = materialsPayload(object);
	// a tinted member's material carries the selection highlight in `emissive`: the undo
	// snapshot must hold the author's emissive, or undo restores the highlight as the look
	const tinted = actionsRef?.selectionTintOriginals?.(uuid)?.[object.uuid];
	if (typeof tinted === 'number' && before.materials?.[0] && 'emissive' in before.materials[0]) before.materials[0].emissive = tinted;
	const after = build(structuredClone(before));
	if (!after?.materials?.length) return false;
	applyMaterials(object, after, false);
	const fresh = object.material;
	if (!Array.isArray(fresh))
		for (const other of fanTargets(uuid)) {
			const node = objectOf(other);
			if (node && !Array.isArray(node.material)) node.material = fresh;
		}
	// a multi-select member wears the selection tint: the new material takes it too, and the
	// tint memory now restores THIS material's emissive on deselect (not the replaced one's)
	actionsRef?.refreshMemberTint?.(uuid);
	recordEntry({ kind: 'material', uuid, param: 'materials', before: { value: before }, after: { value: after } });
	/** @type {any} */
	const peer = get(peers);
	if (peer) {
		const message = { type: 'objectParameters', parameter: 'materials', uuid, payload: after };
		peer.send(message);
		for (const other of fanTargets(uuid)) peer.send({ ...message, uuid: other });
	}
	pokeScene();
	return true;
}

// ---- reading what an object wears ------------------------------------------------------------

/**
 * The look an object's material has now, as a preset payload (the "Save current" source and
 * the active-swatch test). Maps are read from the data-URLs the app keeps beside them; a map
 * the app cannot name (an imported GLB's texture) is left out rather than re-encoded.
 * @param {any} material @param {string} [label]
 */
export function lookOfMaterial(material, label = 'Material') {
	if (!material || Array.isArray(material)) return null;
	return snapshotLook(material, label, {
		mapUrl: material.userData?.mapDataUrl ?? null,
		normalMapUrl: material.normalMap ? (material.userData?.normalMapDataUrl ?? null) : null
	});
}

/**
 * The look an OBJECT wears — its material's look with the selection tint taken back out (a
 * multi-select member's emissive is the highlight, not the author's).
 * @param {string} uuid @param {string} [label]
 */
export function lookOfObject(uuid, label = 'Material') {
	const object = objectOf(uuid);
	const look = lookOfMaterial(object?.material, label);
	if (!look) return null;
	const original = actionsRef?.selectionTintOriginals?.(uuid)?.[object.uuid];
	if (typeof original === 'number') {
		const hex = '#' + original.toString(16).padStart(6, '0');
		if (hex === '#000000') {
			delete look.emissive;
			delete look.emissiveIntensity;
		} else {
			look.emissive = hex;
			if (typeof object.material.emissiveIntensity === 'number') look.emissiveIntensity = object.material.emissiveIntensity;
		}
	}
	return look;
}

/** Does this material wear this preset? @param {any} material @param {any} preset */
export function wearsPreset(material, preset) {
	const look = lookOfMaterial(material);
	const resolved = resolvePreset(preset);
	return !!look && !!resolved && sameLook(look, resolved);
}

// ---- the library (IndexedDB) -----------------------------------------------------------------

export async function loadMaterialPresets() {
	try {
		const keys = await idbKeys();
		const names = keys.filter((/** @type {any} */ key) => String(key).startsWith(MAT_PRESET_KEY));
		const list = [];
		for (const key of names) {
			const payload = normalizePreset(await idbGet(String(key)));
			if (payload) list.push({ name: String(key).slice(MAT_PRESET_KEY.length), payload });
		}
		list.sort((a, b) => (a.payload.savedAt ?? 0) - (b.payload.savedAt ?? 0) || a.name.localeCompare(b.name));
		materialPresets.set(list);
	} catch {
		materialPresets.set([]);
	}
}

/** names in use (yours and the starter set's) @returns {string[]} */
export function takenNames() {
	return [...get(materialPresets).map((p) => p.name), ...STARTER_PRESETS.map((p) => p.label)];
}

/**
 * Save a payload under a name. A name already in your library is REPLACED only with
 * `overwrite`; otherwise the next free name is used ("Wood" -> "Wood 2"), so saving never
 * silently loses a preset.
 * @param {string} name @param {any} payload @param {{overwrite?: boolean}} [opts]
 * @returns {Promise<string|null>} the name it was saved under
 */
export async function saveMaterialPreset(name, payload, opts = {}) {
	const clean = cleanName(name);
	if (!clean) return null;
	const final = opts.overwrite ? clean : uniqueName(clean, takenNames());
	const stored = normalizePreset({ ...payload, label: final });
	if (!stored) return null;
	stored.savedAt = Date.now();
	await idbPut(MAT_PRESET_KEY + final, stored);
	// 48 F2: the store takes the one record that changed — re-reading the whole library from IndexedDB
	// (every record a few MB of data-URLs once CC0 materials are in it) is what made a save take seconds
	putInStore(final, stored);
	broadcastMaterialPresets();
	return final;
}

/** 48 F2: replace / add one entry in the library store, in the order loadMaterialPresets keeps
 * @param {string} name @param {any} payload @param {string} [dropName] an entry to remove (a rename's old name) */
function putInStore(name, payload, dropName) {
	materialPresets.update((list) => {
		const next = list.filter((p) => p.name !== name && p.name !== dropName);
		next.push({ name, payload });
		next.sort((a, b) => (a.payload.savedAt ?? 0) - (b.payload.savedAt ?? 0) || a.name.localeCompare(b.name));
		return next;
	});
}

/** Snapshot an object's material and save it. @param {string} uuid @param {string} name */
export async function saveObjectMaterialAsPreset(uuid, name) {
	const look = lookOfObject(uuid, name);
	if (!look) {
		showToast('This object has no single material to save');
		return null;
	}
	return saveMaterialPreset(name, look);
}

/**
 * Rename one of YOUR presets. Refuses a name already taken (yours or a starter's).
 * @param {string} from @param {string} to @returns {Promise<string|null>}
 */
export async function renameMaterialPreset(from, to) {
	const clean = cleanName(to);
	const entry = get(materialPresets).find((p) => p.name === from);
	if (!entry || !clean) return null;
	if (clean === from) return from;
	if (takenNames().some((n) => n.toLowerCase() === clean.toLowerCase() && n !== from)) return null;
	const payload = { ...entry.payload, label: clean };
	await idbPut(MAT_PRESET_KEY + clean, payload);
	await idbDelete(MAT_PRESET_KEY + from);
	putInStore(clean, payload, from);
	broadcastMaterialPresets();
	return clean;
}

/** @param {string} name */
export async function deleteMaterialPreset(name) {
	await idbDelete(MAT_PRESET_KEY + name);
	materialPresets.update((list) => list.filter((p) => p.name !== name));
	broadcastMaterialPresets();
}

/** JSON for a .matpreset.json download @param {any} payload */
export function exportMaterialPreset(payload) {
	const out = normalizePreset(payload);
	if (out) delete out.savedAt;
	return JSON.stringify(out, null, 2);
}

/** Import a .matpreset.json: saved under its label (next free name) @param {string} json */
export async function importMaterialPreset(json) {
	const payload = normalizePreset(JSON.parse(json));
	if (!payload) throw new Error('not a material preset');
	return saveMaterialPreset(payload.label, payload);
}

// ---- the library broadcast (the envpresets shape) --------------------------------------------
// 48 F2: the list names every preset; a big one is a REFERENCE the receiver pulls once, in parts
// (materialPresetsCore's planBroadcast). The sender keeps the JSON of its last plan to answer.

/** each payload's JSON, computed once per payload object (a broadcast follows every save) */
const jsonOf = new WeakMap();
/** @param {any} p */
function stringifyPreset(p) {
	let s = jsonOf.get(p);
	if (s === undefined) jsonOf.set(p, (s = JSON.stringify(p)));
	return s;
}
/** each referenced payload's hash, once (hashing a few MB of data-URL costs ~20 ms a preset) */
const keyCache = new WeakMap();
/** @param {any} p @param {string} json */
function keyOfPreset(p, json) {
	let k = keyCache.get(p);
	if (k === undefined) keyCache.set(p, (k = presetKey(json)));
	return k;
}
/** wire payloads (no `savedAt`), one object per stored payload so the JSON cache holds */
const wireOf = new WeakMap();
/** @param {any} payload */
function wirePayload(payload) {
	let w = wireOf.get(payload);
	if (!w) {
		const { savedAt, ...rest } = payload;
		wireOf.set(payload, (w = rest));
	}
	return w;
}
/** my referenced presets' JSON, by ref (the last plan) @type {Map<string, string>} */
let outgoing = new Map();

/** the message carrying this peer's whole library (small presets inline, big ones by reference) */
export function materialPresetsState() {
	/** @type {any} */
	const peer = get(peers);
	const plan = planBroadcast(get(materialPresets).map((p) => wirePayload(p.payload)), { stringify: stringifyPreset, keyOf: keyOfPreset });
	outgoing = plan.json;
	return { type: 'matpresets', from: peer?.peer?.id, presets: plan.presets };
}

export function broadcastMaterialPresets() {
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send(materialPresetsState());
}

/** each peer's list as it arrived (inline presets, normalised, and refs), in order @type {Map<string, any[]>} */
const remoteOrder = new Map();
/** referenced presets this device holds, by ref (bounded: the oldest go first) @type {Map<string, any>} */
const refCache = new Map();
const REF_CACHE_MAX = 48;
/** reassembly buffers, by `from|ref` @type {Map<string, {n: number, parts: string[], got: number, at: number}>} */
const incoming = new Map();
/** asks in flight, by `from|ref` → when asked @type {Map<string, number>} */
const asked = new Map();
const PART_TIMEOUT_MS = 60_000;

/** @param {string} peerId @param {any} payload */
function sendTo(peerId, payload) {
	/** @type {any} */
	const peer = get(peers);
	const conn = peer?.connections?.[peerId];
	if (!conn?.open) return null;
	conn.send(payload);
	return conn;
}

/** a peer's swatch list = its arrived order with every resolved reference filled in @param {string} from */
function rebuildPeer(from) {
	const order = remoteOrder.get(from);
	if (!order) return;
	const list = order.map((it) => (isPresetRef(it) ? refCache.get(it.ref) ?? null : it)).filter(Boolean);
	peerMaterialPresets.update((map) => ({ ...map, [from]: list.slice(0, 200) }));
}

/** receiver side: every entry is re-validated (a peer's bytes are never trusted) @param {any} data */
export function applyRemoteMaterialPresets(data) {
	if (!data?.from || typeof data.from !== 'string') return;
	const from = data.from;
	const items = (Array.isArray(data.presets) ? data.presets : [])
		.slice(0, 200)
		.map((/** @type {any} */ it) => (isPresetRef(it) ? { ref: it.ref, label: String(it.label ?? '') } : normalizePreset(it)))
		.filter(Boolean);
	remoteOrder.set(from, items);
	rebuildPeer(from);
	const now = Date.now();
	for (const it of items) {
		if (!isPresetRef(it) || refCache.has(it.ref)) continue;
		const k = from + '|' + it.ref;
		if (now - (asked.get(k) ?? -Infinity) < PART_TIMEOUT_MS) continue;
		asked.set(k, now);
		sendTo(from, { type: 'getmatpreset', ref: it.ref });
	}
}

/** wait for a channel's send buffer to drain (the assetShare rule) @param {any} conn */
async function pace(conn) {
	const ch = conn?.dataChannel;
	if (!ch || typeof ch.bufferedAmount !== 'number') return;
	for (let i = 0; i < 600 && ch.bufferedAmount > 1_000_000; i++) await new Promise((r) => setTimeout(r, 25));
}

/** sender side: a peer asked for one of my referenced presets — send it in parts @param {any} data @param {string} peerId */
export async function answerMaterialPresetRequest(data, peerId) {
	const ref = typeof data?.ref === 'string' ? data.ref : '';
	if (!outgoing.has(ref)) materialPresetsState(); // a save since the last plan: re-plan before refusing
	const json = outgoing.get(ref);
	if (!json) return;
	/** @type {any} */
	const me = get(peers)?.peer?.id;
	const parts = splitParts(json);
	for (let i = 0; i < parts.length; i++) {
		/** @type {any} */
		const conn = get(peers)?.connections?.[peerId];
		if (!conn?.open) return;
		await pace(conn);
		conn.send({ type: 'matpresetpart', from: me, ref, i, n: parts.length, data: parts[i] });
	}
}

/** receiver side: one part of a referenced preset; the last one reassembles, checks and files it @param {any} data */
export function applyMaterialPresetPart(data) {
	const from = typeof data?.from === 'string' ? data.from : '';
	const ref = typeof data?.ref === 'string' ? data.ref : '';
	const n = Number(data?.n);
	const i = Number(data?.i);
	if (!from || !ref || !Number.isInteger(n) || !Number.isInteger(i) || n < 1 || n > PRESET_MAX_PARTS || i < 0 || i >= n || typeof data.data !== 'string') return;
	const now = Date.now();
	for (const [k, buf] of incoming) if (now - buf.at > PART_TIMEOUT_MS) incoming.delete(k); // a stalled transfer is reaped
	const k = from + '|' + ref;
	let buf = incoming.get(k);
	if (!buf || buf.n !== n) incoming.set(k, (buf = { n, parts: new Array(n), got: 0, at: now }));
	if (buf.parts[i] === undefined) buf.got++;
	buf.parts[i] = data.data;
	buf.at = now;
	if (buf.got < n) return;
	incoming.delete(k);
	asked.delete(k);
	const json = buf.parts.join('');
	if (presetKey(json) !== ref) return; // torn or tampered: the next list asks again
	let preset = null;
	try {
		preset = normalizePreset(JSON.parse(json));
	} catch {
		preset = null;
	}
	if (!preset) return;
	refCache.set(ref, preset);
	while (refCache.size > REF_CACHE_MAX) refCache.delete(/** @type {string} */ (refCache.keys().next().value));
	for (const [peerId, order] of remoteOrder) if (order.some((it) => it.ref === ref)) rebuildPeer(peerId);
}

/** drop a disconnected peer's library @param {string} peerId */
export function dropPeerMaterialPresets(peerId) {
	remoteOrder.delete(peerId);
	for (const k of [...incoming.keys(), ...asked.keys()]) {
		if (!k.startsWith(peerId + '|')) continue;
		incoming.delete(k);
		asked.delete(k);
	}
	peerMaterialPresets.update((map) => {
		if (!(peerId in map)) return map;
		const next = { ...map };
		delete next[peerId];
		return next;
	});
}

/** test/debug view */
export function materialPresetsDebug() {
	return {
		mine: get(materialPresets).map((p) => p.name),
		peers: Object.fromEntries(Object.entries(get(peerMaterialPresets)).map(([id, list]) => [id, list.map((p) => p.label)])),
		starters: STARTER_PRESETS.map((p) => p.label)
	};
}

// Boot: load the library once in a browser. peerHandler imports this module at boot, so the
// library is (normally) in the store before the first handshake; a load that lands later
// announces itself, so a peer that connected first still hears it.
if (typeof window !== 'undefined' && typeof indexedDB !== 'undefined') {
	loadMaterialPresets().then(() => {
		if (get(materialPresets).length) broadcastMaterialPresets();
	});
}
