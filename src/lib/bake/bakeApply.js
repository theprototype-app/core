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
import { rebuildLayout, atlasUv } from './bakeUnwrapCore.js';
import { kitMeshSource } from '../packRefs';
import { registerKitBakeHook, kitBakeChanged, BAKE_ST } from '../kitInstancing';
import { halves } from './bakeAtlasCore.js';
import { mapChoice, objectSig, staleOf, lightsSig, isNewerBakeRecord } from './bakeRecordCore.js';
import { showToast } from '../../stores/appStore';
import { settleQuality } from '../qualityGovernor';
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

// ---- 98-int T1b: baked kit pieces stay instanced (kitInstancing.js, the bake hook) -------------
/** a baked kit copy -> what its batch draws @type {Map<any, { geometry: any, material: any, st: number[] }>} */
const kitInfo = new Map();
/** template geometry -> 'src|pad|ch' -> the layout geometry every copy of it shares
 * @type {Map<any, Map<string, { geometry: any, base: Float32Array }>>} */
const kitLayouts = new Map();
/** template material -> its baked batch material @type {Map<any, any>} */
const kitMaterials = new Map();
registerKitBakeHook({ infoFor: (mesh) => kitInfo.get(mesh) ?? null });

/** @param {Float32Array} a @param {Float32Array} b */
function sameArray(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * Remember how a baked kit copy batches: the layout geometry of its piece (made by the first
 * copy) and its place in the atlas. A copy whose layout differs (cannot happen for an unedited
 * clone, but the guard is one pass over the array) stays out of the batch and draws itself.
 * @param {any} mesh @param {any} entry @param {Float32Array} local @param {number} ch
 */
function noteKitCopy(mesh, entry, local, ch) {
	const source = kitMeshSource(mesh);
	if (!source || Array.isArray(mesh.material) || mesh.geometry !== source.geometry || !textures || !current) return;
	const tg = source.template.geometry;
	// the pad only shapes an AUTO unwrap (a uv0/uv1 layout ignores it), and copies placed at
	// different densities get different pads — keying on it there would split a batch for nothing
	const key = entry.src + '|' + (entry.src === 'auto' ? entry.pad : '') + '|' + ch;
	let byKey = kitLayouts.get(tg);
	if (!byKey) kitLayouts.set(tg, (byKey = new Map()));
	let lay = byKey.get(key);
	if (!lay) {
		const geometry = new THREE.BufferGeometry();
		for (const name in tg.attributes) geometry.setAttribute(name, tg.attributes[name]);
		if (tg.index) geometry.setIndex(tg.index);
		for (const g of tg.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
		if (!tg.boundingSphere) tg.computeBoundingSphere();
		if (!tg.boundingBox) tg.computeBoundingBox();
		geometry.boundingSphere = tg.boundingSphere;
		geometry.boundingBox = tg.boundingBox;
		geometry.setAttribute('uv' + ch, new THREE.BufferAttribute(local, 2));
		geometry.userData.kitBakeLayout = true;
		lay = { geometry, base: local };
		byKey.set(key, lay);
	} else if (!sameArray(lay.base, local)) return;
	kitInfo.set(mesh, { geometry: lay.geometry, material: kitMaterialFor(source.template.material), st: [entry.x, entry.y, entry.s] });
}

/** the baked clone of a template material that a baked batch draws with @param {any} template */
function kitMaterialFor(template) {
	let m = kitMaterials.get(template);
	if (m) return m;
	m = template.clone();
	const ownAo = !!(template.aoMap && !template.aoMap.userData?.bake);
	setKitMaterial(m, ownAo);
	// the copy's atlas UV is x + base·s: the per-instance placement scales and moves the shared
	// layout (the bake channel of the layout geometry) before the half's own offset/repeat
	const ao = ownAo ? '' : `
		#ifdef USE_AOMAP
			vAoMapUv = ( aoMapTransform * vec3( AOMAP_UV * ${BAKE_ST}.z + ${BAKE_ST}.xy, 1 ) ).xy;
		#endif`;
	m.onBeforeCompile = (/** @type {any} */ shader) => {
		shader.vertexShader = shader.vertexShader
			.replace('#include <common>', `#include <common>
#ifdef USE_INSTANCING
	attribute vec3 ${BAKE_ST};
#endif`)
			.replace(
				'#include <uv_vertex>',
				`#include <uv_vertex>
	#ifdef USE_INSTANCING
		#ifdef USE_LIGHTMAP
			vLightMapUv = ( lightMapTransform * vec3( LIGHTMAP_UV * ${BAKE_ST}.z + ${BAKE_ST}.xy, 1 ) ).xy;
		#endif${ao}
	#endif`
			);
	};
	m.customProgramCacheKey = () => 'tp-kit-bake:' + (ownAo ? 0 : 1);
	m.userData.kitBake = { ownAo };
	kitMaterials.set(template, m);
	return m;
}

/** @param {any} m @param {boolean} ownAo */
function setKitMaterial(m, ownAo) {
	if (!textures || !current) return;
	m.lightMap = textures.light;
	m.lightMapIntensity = current.lightScale * current.intensity.light;
	if (!ownAo) {
		m.aoMap = textures.ao;
		m.aoMapIntensity = current.intensity.ao;
	}
}

/** forget every baked batch (a bake came off or was replaced) */
function dropKitBatches() {
	if (!kitInfo.size && !kitMaterials.size) return;
	kitInfo.clear();
	for (const m of kitMaterials.values()) m.dispose();
	kitMaterials.clear();
	// the layout geometries share the templates' attributes: dropped, never disposed (a dispose
	// would free the templates' GPU buffers too)
	kitLayouts.clear();
	kitBakeChanged();
}

/** one walk of the scene: uuid -> object (the 1 s watcher looked every baked uuid up with its
 * own tree search — 400 searches a second on the Tavern) */
function indexObjects() {
	/** @type {Map<string, any>} */
	const index = new Map();
	/** @type {any} */
	const group = get(objectsGroup);
	group?.traverse?.((/** @type {any} */ o) => index.set(o.uuid, o));
	return index;
}
/** @type {any} */
let tick = null;
let tier = /** @type {'pc' | 'phone' | 'quest' | null} */ (null);
let applying = Promise.resolve();

/** the newer-version notice shows once per tab */
let newerNoticed = false;

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
	if (!newerNoticed && isNewerBakeRecord(record)) {
		// 98-int (old-scene rule): drawn with what this build knows; the newer fields stay in the record
		newerNoticed = true;
		showToast('The baked light in this scene was made with a newer version of theprototype.app — it may look different here. Reload to update.');
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
		for (const m of kitMaterials.values()) setKitMaterial(m, m.userData.kitBake.ownAo);
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
	// 98-int: every baked material recompiles (a lightMap define) and the maps upload — device-lab-3 measured a 0.7 s
	// stall on the HONOR right after a bake; that hitch is not the scene's cost (the F27 settle)
	settleQuality();
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
function refresh(index = indexObjects()) {
	if (!current || !textures) return;
	let applied = 0, pending = 0, fresh = 0;
	for (const entry of current.objects) {
		if (meshes.has(entry.uuid)) {
			applied++;
			continue;
		}
		const mesh = index.get(entry.uuid);
		if (!mesh?.isMesh) {
			pending++;
			continue;
		}
		if (applyTo(mesh, entry)) {
			applied++;
			fresh++;
		}
	}
	bakeShown.update((s) => (s.applied === applied && s.pending === pending ? s : { ...s, applied, pending }));
	updateStale(index);
	// only when something new was baked (a poke every second re-ran every scene watcher, kit
	// instancing's rescan among them)
	if (fresh) pokeScene();
}

/** @param {any} mesh @param {any} entry */
function applyTo(mesh, entry) {
	if (whyNotReceiver(mesh) && !meshes.has(mesh.uuid)) return false;
	const geometry = mesh.geometry;
	// ONE channel for the whole bake (the atlas textures carry it): the bake picked it
	const ch = entry.ch;
	if (geometry.attributes['uv' + ch] && geometry.userData.__bakeCh !== ch) return false;
	const layout = rebuildLayout(geometryArrays(geometry), entry.src, entry.pad);
	if (!layout.ok) return false;
	const uv = atlasUv(layout.uv, entry.x, entry.y, entry.s); // = bakeUvFor, keeping the layout
	const attr = 'uv' + ch;
	geometry.setAttribute(attr, new THREE.BufferAttribute(uv, 2));
	geometry.userData.__bakeCh = ch;
	guardGeometry(geometry, attr);
	const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
	for (const m of list) bakeMaterial(m, ch, entry.mode);
	meshes.set(mesh.uuid, { mesh, geometry, attr });
	noteKitCopy(mesh, entry, layout.uv, ch);
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
	dropKitBatches();
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
		const index = indexObjects();
		// a baked object that was deleted and re-created (undo) is a new mesh: re-apply
		for (const [uuid, rec] of meshes) {
			if (index.get(uuid) !== rec.mesh) {
				meshes.delete(uuid);
				kitInfo.delete(rec.mesh);
			}
		}
		refresh(index);
	}, 1000);
}

function stopWatching() {
	clearInterval(tick);
	tick = null;
	unwatch?.();
	unwatch = null;
}

/** @param {Map<string, any>} index */
function updateStale(index) {
	if (!current) return;
	/** @type {Map<string, string>} */
	const sigs = new Map();
	for (const entry of current.objects) {
		const o = index.get(entry.uuid);
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
		channels: [...meshes.values()].map((m) => m.attr),
		kitBaked: kitInfo.size,
		kitLayouts: [...kitLayouts.values()].reduce((n, m) => n + m.size, 0),
		kitMaterials: kitMaterials.size
	};
}
