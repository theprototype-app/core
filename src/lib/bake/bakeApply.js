// 98 P1 — APPLY a bake record to the live scene, on every peer (and in /play). Loaded by dynamic
// import from sceneBake.js only when a scene has a bake.
//
// What it does per baked mesh: rebuild its bake UVs from its own geometry (bakeUvFor —
// deterministic, so no UV array ever travels) into its own attribute (uv2 / uv3), and point its
// materials at the ONE atlas: `lightMap` (the light half) and `aoMap` (the AO half), both reading
// that channel. Nothing else about the object changes.
//
// KEEPING THE BAKE OUT OF EVERY SAVE AND SYNC: the maps and the UV attribute are RUNTIME
// decoration of scene data that already travels as the `bake` record. Two guards:
//   · a park hook (parkHooks, run by flowRuntime.parkAnimatedAtBase, the ritual every GLTF export
//     and session snapshot performs) takes them off for the duration and puts them back;
//   · an own `toJSON` on each baked material and geometry, because many paths call
//     `object.toJSON()` without parking (undo snapshots, duplicate, the override sends) — and
//     three's Material.toJSON would embed the whole atlas image per material.
// A material we did not bake that already had its OWN aoMap keeps it: the bake then adds light only.

import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../../stores/sceneStore';
import { explorerItems, itemByHash, itemBlob } from '../explorer';
import { requestAsset } from '../assetShare';
import { registerParkHook } from '../parkHooks';
import { bakeStale, bakeShown } from '../sceneBake';
import { bakeUvFor } from './bakePlanCore.js';
import { halves } from './bakeAtlasCore.js';
import { mapChoice, objectSig, staleOf, lightsSig } from './bakeRecordCore.js';
import { geometryArrays, collectLights, deviceBakeTier, whyNotReceiver } from './bakeScene.js';

/** @typedef {{ lightMap: any, lightMapIntensity: number, aoMap: any, aoMapIntensity: number, ownAo: boolean }} MaterialWas */

/** the record now on screen @type {any} */
let current = null;
/** which map hash the textures were made from */
let textureHash = '';
/** @type {{ light: any, ao: any } | null} */
let textures = null;
/** baked meshes: uuid -> { mesh, geometry, attr } @type {Map<string, { mesh: any, geometry: any, attr: string }>} */
const meshes = new Map();
/** baked materials -> what they had before @type {Map<any, MaterialWas>} */
const materials = new Map();
/** @type {(() => void) | null} */
let unwatch = null;
/** @type {any} */
let tick = null;
let tier = /** @type {'pc' | 'phone' | 'quest' | null} */ (null);
let applying = Promise.resolve();

/** @param {string} uuid */
function objectOf(uuid) {
	/** @type {any} */
	const group = get(objectsGroup);
	return group?.getObjectByProperty?.('uuid', uuid) ?? null;
}

/**
 * Apply (or, with null, remove) a record. Serialized: a second call waits for the first.
 * @param {any} record
 */
export function applyBakeRecord(record) {
	applying = applying.then(() => applyNow(record)).catch((error) => console.warn('bake apply', error));
	return applying;
}

/** @param {any} record */
async function applyNow(record) {
	if (!tier) tier = await deviceBakeTier();
	if (!record) {
		removeAll();
		current = null;
		stopWatching();
		bakeShown.set({ map: 'none', applied: 0, pending: 0, note: '' });
		bakeStale.set({ stale: false, moved: 0, missing: 0, lights: false });
		return;
	}
	const choice = mapChoice(record, tier);
	if (!choice) {
		removeAll();
		current = record;
		bakeShown.set({ map: 'none', applied: 0, pending: 0, note: 'The baked light is too big for this device, so the scene shows without it here.' });
		startWatching();
		return;
	}
	const map = record[choice];
	// only the strength changed: no rebuild
	if (current && textures && textureHash === map.hash && JSON.stringify(current.objects) === JSON.stringify(record.objects)) {
		current = record;
		for (const [m, was] of materials) {
			m.lightMapIntensity = record.lightScale * record.intensity.light;
			if (!was.ownAo) m.aoMapIntensity = record.intensity.ao;
		}
		refresh();
		return;
	}
	if (textureHash !== map.hash || !textures) {
		const loaded = await loadTextures(map);
		if (!loaded) {
			// the bytes are on their way: keep what is shown, try again when they land
			current = record;
			bakeShown.set({ map: 'none', applied: 0, pending: record.objects.length, note: 'Waiting for the baked light from a peer…' });
			waitForBytes(map.hash, record);
			return;
		}
		removeAll();
		disposeTextures();
		textures = loaded;
		textureHash = map.hash;
	} else if (current && current !== record) removeAll();
	current = record;
	refresh();
	startWatching();
	bakeShown.update((s) => ({ ...s, map: choice, note: choice === 'lite' ? 'This device shows the small copy of the baked light.' : '' }));
}

/** @param {{ hash: string, side: number }} map @returns {Promise<{ light: any, ao: any } | null>} */
async function loadTextures(map) {
	const item = itemByHash(map.hash);
	if (!item) return null;
	const blob = await itemBlob(item.id);
	if (!blob) return null;
	const bitmap = await createImageBitmap(blob, { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
	const h = halves(map.side);
	/** @param {string} colorSpace @param {{ offset: number, repeat: number }} half */
	const make = (colorSpace, half) => {
		const t = new THREE.Texture(bitmap);
		t.flipY = false; // row 0 of the image is v = 0
		t.colorSpace = colorSpace;
		t.generateMipmaps = false;
		t.minFilter = THREE.LinearFilter;
		t.magFilter = THREE.LinearFilter;
		t.wrapS = THREE.ClampToEdgeWrapping;
		t.wrapT = THREE.ClampToEdgeWrapping;
		t.offset.set(half.offset, 0);
		t.repeat.set(half.repeat, 1);
		t.userData.bake = true;
		t.needsUpdate = true;
		return t;
	};
	return { light: make(THREE.SRGBColorSpace, h.light), ao: make(THREE.NoColorSpace, h.ao) };
}

/** @param {string} hash @param {any} record */
function waitForBytes(hash, record) {
	requestAsset(hash);
	unwatch?.();
	unwatch = explorerItems.subscribe(() => {
		if (!itemByHash(hash)) return;
		unwatch?.();
		unwatch = null;
		if (current === record) applyBakeRecord(record);
	});
}

function disposeTextures() {
	if (!textures) return;
	const image = textures.light.image;
	textures.light.dispose();
	textures.ao.dispose();
	image?.close?.();
	textures = null;
	textureHash = '';
}

/** put the bake on every recorded object that is here and not yet baked (objects arrive late) */
function refresh() {
	if (!current || !textures) return;
	let applied = 0, pending = 0;
	for (const entry of current.objects) {
		if (meshes.has(entry.uuid)) {
			applied++;
			continue;
		}
		const mesh = objectOf(entry.uuid);
		if (!mesh?.isMesh) {
			pending++;
			continue;
		}
		if (applyTo(mesh, entry)) applied++;
	}
	bakeShown.update((s) => ({ ...s, applied, pending }));
	updateStale();
	if (applied) pokeScene();
}

/** @param {any} mesh @param {any} entry */
function applyTo(mesh, entry) {
	if (whyNotReceiver(mesh) && !meshes.has(mesh.uuid)) return false;
	const geometry = mesh.geometry;
	// ONE channel for the whole bake (the atlas textures carry it): the bake picked it
	const ch = entry.ch;
	if (geometry.attributes['uv' + ch] && geometry.userData.__bakeCh !== ch) return false;
	const uv = bakeUvFor(geometryArrays(geometry), entry);
	if (!uv) return false;
	const attr = 'uv' + ch;
	geometry.setAttribute(attr, new THREE.BufferAttribute(uv, 2));
	geometry.userData.__bakeCh = ch;
	guardGeometry(geometry, attr);
	const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
	for (const m of list) bakeMaterial(m, ch, entry.mode);
	meshes.set(mesh.uuid, { mesh, geometry, attr });
	return true;
}

/** @param {any} m @param {number} ch @param {string} mode */
function bakeMaterial(m, ch, mode) {
	if (!m || !textures || !current) return;
	if (!materials.has(m)) {
		const ownAo = !!(m.aoMap && !m.aoMap.userData?.bake);
		materials.set(m, { lightMap: m.lightMap ?? null, lightMapIntensity: m.lightMapIntensity ?? 1, aoMap: m.aoMap ?? null, aoMapIntensity: m.aoMapIntensity ?? 1, ownAo });
		guardMaterial(m);
	}
	const was = /** @type {MaterialWas} */ (materials.get(m));
	textures.light.channel = ch;
	textures.ao.channel = ch;
	m.lightMap = textures.light;
	m.lightMapIntensity = current.lightScale * current.intensity.light;
	if (!was.ownAo) {
		m.aoMap = textures.ao;
		m.aoMapIntensity = current.intensity.ao;
	}
	void mode; // an AO-only mesh's texels hold no light (the kernel wrote none), so the same maps serve it
	m.needsUpdate = true;
}

/** take everything off, restore materials and geometry */
function removeAll() {
	for (const [m, was] of materials) {
		m.lightMap = was.lightMap;
		m.lightMapIntensity = was.lightMapIntensity;
		if (!was.ownAo) {
			m.aoMap = was.aoMap;
			m.aoMapIntensity = was.aoMapIntensity;
		}
		delete m.toJSON;
		m.needsUpdate = true;
	}
	materials.clear();
	for (const { geometry, attr } of meshes.values()) {
		geometry.deleteAttribute(attr);
		delete geometry.userData.__bakeCh;
		delete geometry.toJSON;
	}
	if (meshes.size) pokeScene();
	meshes.clear();
}

// ---- keeping the bake out of saves and syncs ---------------------------------------------------

/** @param {any} m */
function guardMaterial(m) {
	const proto = Object.getPrototypeOf(m).toJSON;
	m.toJSON = function (/** @type {any} */ meta) {
		const was = materials.get(this);
		if (!was) return proto.call(this, meta);
		const light = this.lightMap, ao = this.aoMap, li = this.lightMapIntensity, ai = this.aoMapIntensity;
		this.lightMap = was.lightMap;
		this.lightMapIntensity = was.lightMapIntensity;
		if (!was.ownAo) {
			this.aoMap = was.aoMap;
			this.aoMapIntensity = was.aoMapIntensity;
		}
		try {
			return proto.call(this, meta);
		} finally {
			this.lightMap = light;
			this.aoMap = ao;
			this.lightMapIntensity = li;
			this.aoMapIntensity = ai;
		}
	};
}

/** @param {any} g @param {string} attr */
function guardGeometry(g, attr) {
	if (Object.prototype.hasOwnProperty.call(g, 'toJSON')) return;
	const proto = Object.getPrototypeOf(g).toJSON;
	g.toJSON = function () {
		const a = this.attributes[attr];
		const ch = this.userData.__bakeCh;
		if (a) delete this.attributes[attr];
		delete this.userData.__bakeCh;
		try {
			return proto.call(this);
		} finally {
			if (a) this.attributes[attr] = a;
			if (ch) this.userData.__bakeCh = ch;
		}
	};
}

// every serializer parks first (GLTF export, session snapshot, autosave): strip, then put back
registerParkHook(() => {
	if (!materials.size && !meshes.size) return null;
	/** @type {(() => void)[]} */
	const undo = [];
	for (const [m, was] of materials) {
		const light = m.lightMap, ao = m.aoMap;
		m.lightMap = was.lightMap;
		if (!was.ownAo) m.aoMap = was.aoMap;
		undo.push(() => {
			m.lightMap = light;
			if (!was.ownAo) m.aoMap = ao;
		});
	}
	for (const { geometry, attr } of meshes.values()) {
		const a = geometry.attributes[attr];
		const ch = geometry.userData.__bakeCh;
		if (a) geometry.deleteAttribute(attr);
		delete geometry.userData.__bakeCh;
		undo.push(() => {
			if (a) geometry.setAttribute(attr, a);
			if (ch) geometry.userData.__bakeCh = ch;
		});
	}
	return () => {
		for (const u of undo) u();
	};
});

// ---- objects arriving late + the stale chip -----------------------------------------------------

function startWatching() {
	if (tick) return;
	tick = setInterval(() => {
		if (!current) return;
		// a baked object that was deleted and re-created (undo) is a new mesh: re-apply
		for (const [uuid, rec] of meshes) {
			if (objectOf(uuid) !== rec.mesh) meshes.delete(uuid);
		}
		refresh();
	}, 1000);
}

function stopWatching() {
	clearInterval(tick);
	tick = null;
	unwatch?.();
	unwatch = null;
}

function updateStale() {
	if (!current) return;
	/** @type {Map<string, string>} */
	const sigs = new Map();
	for (const entry of current.objects) {
		const o = objectOf(entry.uuid);
		if (!o?.isMesh) continue;
		o.updateWorldMatrix?.(true, false);
		sigs.set(entry.uuid, objectSig(o.matrixWorld.elements, o.geometry.attributes.position.count));
	}
	const s = staleOf(current, sigs, lightsSig(collectLights()));
	bakeStale.set({ stale: s.stale, moved: s.moved.length, missing: s.missing.length, lights: s.lights });
}

/** test / debug view */
export function bakeApplyDebug() {
	return {
		tier,
		textureHash,
		meshes: [...meshes.keys()],
		materials: materials.size,
		channels: [...meshes.values()].map((m) => m.attr)
	};
}
