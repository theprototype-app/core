import * as THREE from 'three';
import { createGltfLoader } from './gltfLoader';
import { writable, get } from 'svelte/store';
import { globalScene, objectsGroup } from '../stores/sceneStore';
import { registerLodPass, simplifiedGeometry, swapGeometryForPass, swapMaterialForPass, overlayMaterial } from './lod';
import { normalizeLodGroup, pickGroupLevel, thresholdsOf, groupFromPackLods } from './lodGroupCore';
import { packRefOf, packRefUrl, loadPackFile } from './packRefs';
import { PACKS_BASE } from './packs';
import { fetchIndex } from './contentBase';
import { explorerItems, itemByHash, itemBlob } from './explorer';

// 33 (K2/K6) — LOD GROUPS: a per-object `userData.lod` block, drawn at render time.
//
// THE SHAPE, and why it is not a THREE.LOD (31-perf's argument, and 33-anim-core's ask):
// objectsGroup IS the replicated document. A THREE.LOD root holding three copies would
// change what every serializer writes, what the object list shows and what the mesh tools
// edit — and an animated item's mixer binds by NODE NAME, so the two copies it did not bind
// would sit frozen. So the tree is left alone and a level is applied only while the
// renderer draws, inside lod.js's own onBeforeRender/onAfterRender bracket:
//   SWAP level  — the level file's meshes matched to the object's by NODE NAME (fallback:
//                 traverse order when the counts agree): each matched mesh draws the
//                 level's geometry with ITS OWN material. Shared materials by construction,
//                 animation keeps playing, picking/physics/serializers see LOD0.
//                 Pack `lods` files and generated (meshopt) levels are swap levels.
//   TREE level  — a level replaced by an unrelated model (an Explorer item, another scene
//                 object): a substitute subtree in a scene-root LOCAL holder, drawn at the
//                 object's matrixWorld × the level's offset while the source meshes are
//                 hidden for that render.
//   CULLED      — the source meshes hidden for that render.
//
// WHAT IS LOCAL: everything here. The BLOCK is scene data (it rides userData into every
// save, the wire and undo — lodGroupActions.js writes it); the built levels, the level
// drawn, the edit preview and the overlay are facts about this screen.
//
// LAZY: a level is built the first time it is NEEDED (the pick wants it), never at load,
// so a castle of a hundred kit pieces fetches the LOD files of the pieces that are far
// away, once per file. Until it lands, the nearest finer level that IS built draws.
//
// A pack piece placed before its pack had `lods` (every scene today) gets an IMPLICIT
// block from the pack row at runtime — not saved; the LOD panel's first edit writes it.

/**
 * @typedef {import('./lodGroupCore').LodGroup} LodGroup
 * @typedef {{status: 'loading'} | {status: 'failed', error: string}
 *   | {status: 'ready', kind: 'swap', pairs: any[], tris: number, owned: any[], releases: (() => void)[]}
 *   | {status: 'ready', kind: 'tree', object: any, tris: number}} LevelState
 * @typedef {{root: any, block: LodGroup, sig: string, implicit: boolean, meshes: any[], meshKey: string,
 *   center: any, radius: number, built: Map<string, LevelState>, current: number, autoCurrent: number,
 *   size: number, holder: any, matCache: Map<string, {clone: any, version: number}>, raw: any}} GroupEntry
 */

/** A LOCAL preview: the level selected in the LOD panel draws on this screen until the
 * selection moves on (then the block's own mode again). @type {import('svelte/store').Writable<{uuid: string, level: number} | null>} */
export const lodPreview = writable(null);
/** Poked (at most ~4 Hz) when a level finishes building or a group's drawn level changes,
 * so the panel's readout follows without a per-frame store write. */
export const lodGroupTick = writable(0);

/** @type {Map<any, GroupEntry>} */
const entries = new Map();
/** every mesh some group draws — lod.js's auto scan stands down for these */
/** @type {WeakSet<any>} */
let owned = new WeakSet();
/** pack rows: `<pack>/<item folder>` -> the implicit group (null = the row has no lods) */
/** @type {Map<string, LodGroup | null>} */
const implicitGroups = new Map();
/** @type {Map<string, Promise<any>>} */
const listFetches = new Map();
/** 34 R7: roots OUTSIDE objectsGroup that carry a block (api.loadModel instances a module
 * keeps at the scene root) — scanned beside objectsGroup, never serialized
 * @type {Set<any>} */
const extraRoots = new Set();
/** @type {any} */
let preview = null;
lodPreview.subscribe((p) => (preview = p));

let tickPending = false;
function tick() {
	if (tickPending) return;
	tickPending = true;
	setTimeout(() => {
		tickPending = false;
		lodGroupTick.update((n) => n + 1);
	}, 250);
}

/** @param {any} g */
function trianglesOf(g) {
	if (!g) return 0;
	if (g.index) return Math.floor(g.index.count / 3);
	const p = g.attributes?.position;
	return p ? Math.floor(p.count / 3) : 0;
}

/** The meshes a group draws for: the root's subtree, minus a nested group's subtree and
 * anything the swap cannot carry (a skinned mesh's weights, a mesh with no positions).
 * @param {any} root */
function sourceMeshes(root) {
	/** @type {any[]} */
	const out = [];
	/** @param {any} node */
	const walk = (node) => {
		if (node !== root && node.userData?.lod) return;
		if (node.isMesh && !node.isSkinnedMesh && node.geometry?.attributes?.position) out.push(node);
		for (const c of node.children) walk(c);
	};
	walk(root);
	return out;
}

/** @param {any[]} meshes */
function meshKeyOf(meshes) {
	return meshes.map((m) => m.uuid + ':' + m.geometry.uuid + ':' + m.geometry.attributes.position.version).join(',');
}

const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _box = new THREE.Box3();
const _gb = new THREE.Box3();
const _v = new THREE.Vector3();

/** node's matrix in `root`'s frame. @param {any} node @param {any} root @param {any} [out] */
function relMatrix(node, root, out = new THREE.Matrix4()) {
	root.updateWorldMatrix(true, false);
	node.updateWorldMatrix(true, false);
	_inv.copy(root.matrixWorld).invert();
	return out.multiplyMatrices(_inv, node.matrixWorld);
}

/** The root-local bounding sphere of the source meshes. @param {GroupEntry} entry */
function measure(entry) {
	_box.makeEmpty();
	for (const m of entry.meshes) {
		const g = m.geometry;
		if (!g.boundingBox) g.computeBoundingBox();
		if (!g.boundingBox) continue;
		_gb.copy(g.boundingBox).applyMatrix4(relMatrix(m, entry.root, _m));
		_box.union(_gb);
	}
	if (_box.isEmpty()) {
		entry.center = new THREE.Vector3();
		entry.radius = 0;
		return;
	}
	// centre on the box, radius from each mesh's own bounding SPHERE (the box half-diagonal
	// overstates a round object by up to √3 and would make it read ~1.7x bigger on screen)
	const center = _box.getCenter(new THREE.Vector3());
	let radius = 0;
	for (const m of entry.meshes) {
		const g = m.geometry;
		if (!g.boundingSphere) g.computeBoundingSphere();
		if (!g.boundingSphere) continue;
		const rel = relMatrix(m, entry.root, _m);
		const c = _v.copy(g.boundingSphere.center).applyMatrix4(rel);
		const e = rel.elements;
		const sc = Math.sqrt(Math.max(e[0] * e[0] + e[1] * e[1] + e[2] * e[2], e[4] * e[4] + e[5] * e[5] + e[6] * e[6], e[8] * e[8] + e[9] * e[9] + e[10] * e[10]));
		radius = Math.max(radius, c.distanceTo(center) + g.boundingSphere.radius * sc);
	}
	entry.center = center;
	entry.radius = radius;
}

/** The identity of a level's CONTENT (what has to be rebuilt when it changes). Offsets,
 * material overrides and thresholds are applied per render and invalidate nothing.
 * @param {import('./lodGroupCore').LodLevel} level */
function levelKey(level) {
	return level.source + '|' + (level.ref ?? '') + '|' + (level.ratio ?? '');
}

// ---- resolving where a level's bytes live ---------------------------------------------

/**
 * A pack level's URL: absolute passes through; a path with a '/' is PACKS_BASE-relative
 * (what a placement writes, so an animated item with no pack reference still resolves);
 * a bare file name sits beside the object's own pack file.
 * @param {any} root @param {string} ref @returns {string | null}
 */
export function packLevelUrl(root, ref) {
	// 34 R7: blob:/data: too — api.loadModel's P1 levels of a PACKAGED model are module blobs
	if (/^(https?:\/\/|blob:|data:)/.test(ref)) return ref;
	if (ref.includes('/')) return String(PACKS_BASE).replace(/\/+$/, '') + '/' + ref.replace(/^\/+/, '');
	const pr = packRefOf(root);
	if (!pr) return null;
	const own = packRefUrl(pr);
	return own.slice(0, own.lastIndexOf('/') + 1) + ref;
}

/**
 * The group a pack ITEM row places with (contract P1), its level refs written as
 * PACKS_BASE-relative paths beside `glbUrl` so every peer and every later load resolves
 * them, whatever the placed object turns into (a stub, an animated import).
 * @param {string} glbUrl @param {any} lods the row's `lods` @returns {LodGroup | null}
 */
export function placementGroupFor(glbUrl, lods) {
	if (!glbUrl || !Array.isArray(lods) || !lods.length) return null;
	const group = groupFromPackLods({ lods });
	if (!group) return null;
	const dir = glbUrl.slice(0, glbUrl.lastIndexOf('/') + 1);
	const base = String(PACKS_BASE).replace(/\/+$/, '') + '/';
	for (const level of group.levels) {
		if (level.source !== 'pack' || !level.ref) continue;
		const url = dir + level.ref;
		level.ref = url.startsWith(base) ? url.slice(base.length) : url;
	}
	return group;
}

/** `<pack>/<item folder>` of a relative pack reference, or '' for an absolute one.
 * @param {any} ref */
function rowKeyOf(ref) {
	if (!ref?.path || /^https?:\/\//.test(ref.path)) return '';
	const parts = String(ref.path).replace(/^\/+/, '').split('/');
	return parts.length >= 2 ? parts[0] + '/' + parts[1] : '';
}

/** @param {string} url */
function fetchJson(url) {
	let job = listFetches.get(url);
	if (!job) {
		// the packs index and each pack's item list: LISTS on a branch ref (contentBase.fetchIndex)
		job = fetchIndex(url).then((r) => (r.ok ? r.json() : null));
		listFetches.set(url, job);
		job.catch(() => listFetches.delete(url));
	}
	return job;
}

/** A pack row (`<pack>/<item folder>`) from the pack's own list, or null. @param {string} key */
async function packRowFor(key) {
	const base = String(PACKS_BASE).replace(/\/+$/, '');
	const [packName, folder] = key.split('/');
	const index = await fetchJson(base + '/index.json');
	const row = Array.isArray(index) ? index.find((/** @type {any} */ e) => e?.name === packName) : null;
	if (!row?.value) return null;
	const listUrl = /^https?:\/\//.test(row.value) ? row.value : base + '/' + String(row.value).replace(/^\//, '');
	const list = await fetchJson(listUrl);
	return Array.isArray(list) ? (list.find((/** @type {any} */ o) => o?.name === folder) ?? null) : null;
}

/** Look a piece's pack row up and remember its implicit group. @param {string} key */
async function lookupImplicit(key) {
	if (implicitGroups.has(key)) return;
	implicitGroups.set(key, null); // in flight = nothing, so a scan never asks twice
	try {
		const item = await packRowFor(key);
		const group = item ? groupFromPackLods(item) : null;
		if (group) {
			implicitGroups.set(key, group);
			scheduleScan();
		}
	} catch {
		/* the CDN is unreachable: the piece keeps 31-perf's auto LOD */
	}
}

/**
 * 34 R7: the group a model loaded from `url` takes when that URL is a pack item whose row
 * carries P1 `lods` (null otherwise, or when the CDN cannot be read). Refs come back
 * PACKS_BASE-relative beside the file (placementGroupFor), so any root resolves them.
 * @param {string} url @param {string} rowKey `<pack>/<item folder>` (modelLoaderCore.packRowKeyOf)
 * @returns {Promise<LodGroup | null>}
 */
export async function packLodGroupFor(url, rowKey) {
	if (!rowKey) return null;
	try {
		const item = await packRowFor(rowKey);
		return item?.lods ? placementGroupFor(url, item.lods) : null;
	} catch {
		return null;
	}
}

/** 34 R7: draw `root`'s userData.lod block although it lives outside objectsGroup. LOCAL.
 * @param {any} root */
export function addLodRoot(root) {
	if (!root) return;
	extraRoots.add(root);
	scheduleScan();
}

/** @param {any} root */
export function removeLodRoot(root) {
	if (!extraRoots.delete(root)) return;
	const entry = entries.get(root);
	if (entry) dropEntry(entry);
}

// ---- building levels --------------------------------------------------------------------

const loader = (() => {
	/** @type {any} */
	let l = null;
	return () => (l ??= createGltfLoader());
})();

/** @param {string} a */
const nameKey = (a) => String(a ?? '').replace(/\s+/g, '_');

/**
 * Pair a level file's meshes with the object's, by node name first and traverse order as
 * the fallback when both sides have the same count. A level mesh placed differently from
 * its partner (another node transform in the lod file) is baked into the partner's frame,
 * so the swap draws it where the file meant it.
 * @param {GroupEntry} entry @param {any} levelScene
 * @returns {{pairs: any[], owned: any[], tris: number} | null}
 */
function pairLevel(entry, levelScene) {
	/** @type {any[]} */
	const lvl = [];
	levelScene.traverse((/** @type {any} */ o) => {
		if (o.isMesh && !o.isSkinnedMesh && o.geometry?.attributes?.position) lvl.push(o);
	});
	const used = new Set();
	/** @type {any[]} */
	const pairs = [];
	/** @type {any[]} */
	const ownedGeoms = [];
	let tris = 0;
	const byOrder = lvl.length === entry.meshes.length;
	entry.meshes.forEach((m, i) => {
		let match = lvl.find((l) => !used.has(l) && l.name && nameKey(l.name) === nameKey(m.name));
		if (!match && byOrder && !used.has(lvl[i])) match = lvl[i];
		if (!match) {
			tris += trianglesOf(m.geometry);
			return;
		}
		used.add(match);
		let g = match.geometry;
		const a = relMatrix(m, entry.root, new THREE.Matrix4());
		const b = relMatrix(match, levelScene, new THREE.Matrix4());
		if (!a.equals(b)) {
			g = g.clone();
			g.applyMatrix4(new THREE.Matrix4().copy(a).invert().multiply(b));
			ownedGeoms.push(g);
		}
		// an ARRAY material walks geometry.groups; a level with none would draw nothing
		if (Array.isArray(m.material) && !g.groups.length) {
			if (g === match.geometry) {
				g = g.clone();
				ownedGeoms.push(g);
			}
			g.addGroup(0, g.index ? g.index.count : g.attributes.position.count, 0);
		}
		pairs.push(m, m.geometry, g);
		tris += trianglesOf(g);
	});
	return pairs.length ? { pairs, owned: ownedGeoms, tris } : null;
}

/** A model as a TREE level: the parsed subtree, its root reset to identity (the holder
 * carries the object's placement), never pickable. @param {any} object */
function asTree(object) {
	object.position.set(0, 0, 0);
	object.quaternion.identity();
	object.updateMatrix();
	let tris = 0;
	object.traverse((/** @type {any} */ o) => {
		o.raycast = () => {};
		if (o.isMesh) tris += trianglesOf(o.geometry);
	});
	return { object, tris };
}

/** @param {ArrayBuffer} buffer */
function parseGlb(buffer) {
	return new Promise((resolve, reject) => loader().parse(buffer, '', (/** @type {any} */ g) => resolve(g.scene), reject));
}

/** @type {Map<string, (() => void)[]>} explorer hashes waiting for their bytes */
const awaitingHash = new Map();
let explorerWatch = false;
function watchExplorer() {
	if (explorerWatch) return;
	explorerWatch = true;
	explorerItems.subscribe(() => {
		for (const [hash, waiters] of [...awaitingHash]) {
			if (!itemByHash(hash)) continue;
			awaitingHash.delete(hash);
			for (const w of waiters) w();
		}
	});
}

/** The bytes of an Explorer item by content hash; asks a peer for it when missing and
 * WAITS for it to land (golden rule 9 — an asset that arrives later needs a watch).
 * @param {string} hash @returns {Promise<ArrayBuffer>} */
function explorerBytes(hash) {
	return new Promise((resolve, reject) => {
		const go = async () => {
			const item = itemByHash(hash);
			if (!item) return false;
			const blob = await itemBlob(item.id);
			if (!blob) reject(new Error('no bytes'));
			else resolve(await blob.arrayBuffer());
			return true;
		};
		go().then((done) => {
			if (done) return;
			watchExplorer();
			const list = awaitingHash.get(hash) ?? [];
			list.push(() => go());
			awaitingHash.set(hash, list);
			import('./assetShare').then((m) => m.requestAsset(hash)).catch(() => {});
		});
	});
}

/**
 * Build level `i` of `entry` (async). The state lands in `entry.built` under the level's
 * content key, so a threshold drag or a re-mode never rebuilds it.
 * @param {GroupEntry} entry @param {number} i
 */
function requestLevel(entry, i) {
	const level = entry.block.levels[i];
	if (!level || i === 0) return;
	const key = levelKey(level);
	if (entry.built.has(key)) return;
	entry.built.set(key, { status: 'loading' });
	const meshKey = entry.meshKey;
	/** @param {LevelState} state */
	const land = (state) => {
		// the entry was rebuilt (new meshes, removed) while this ran: drop the result
		if (entries.get(entry.root) !== entry || entry.meshKey !== meshKey || entry.built.get(key)?.status !== 'loading') {
			if (state.status === 'ready' && state.kind === 'swap') {
				for (const g of state.owned) g.dispose();
				for (const r of state.releases) r();
			}
			return;
		}
		entry.built.set(key, state);
		tick();
	};
	/** @param {any} error */
	const fail = (error) => {
		console.log('LOD level could not be built (' + level.source + ' ' + (level.ref ?? level.ratio ?? '') + '):', error?.message ?? error);
		land({ status: 'failed', error: String(error?.message ?? error) });
	};
	if (level.source === 'pack') {
		const url = packLevelUrl(entry.root, /** @type {string} */ (level.ref));
		if (!url) return fail('no pack reference to resolve "' + level.ref + '" against');
		loadPackFile(url)
			.then((scene) => {
				const paired = pairLevel(entry, scene);
				if (!paired) throw new Error('none of its meshes match the object');
				land({ status: 'ready', kind: 'swap', pairs: paired.pairs, tris: paired.tris, owned: paired.owned, releases: [] });
			})
			.catch(fail);
	} else if (level.source === 'generated') {
		const ratio = /** @type {number} */ (level.ratio);
		/** @type {(() => void)[]} */
		const releases = [];
		Promise.all(
			entry.meshes.map((m) => {
				if (trianglesOf(m.geometry) < 64) return Promise.resolve([m, null]);
				const share = simplifiedGeometry(m.geometry, ratio);
				releases.push(share.release);
				return share.geometry.then((g) => [m, g]);
			})
		)
			.then((results) => {
				/** @type {any[]} */
				const pairs = [];
				let tris = 0;
				for (const [m, g] of results) {
					if (g) {
						pairs.push(m, m.geometry, g);
						tris += trianglesOf(g);
					} else tris += trianglesOf(m.geometry);
				}
				if (!pairs.length) throw new Error('the simplifier could not make it coarser');
				land({ status: 'ready', kind: 'swap', pairs, tris, owned: [], releases });
			})
			.catch((error) => {
				for (const r of releases) r();
				fail(error);
			});
	} else if (level.source === 'explorer') {
		explorerBytes(/** @type {string} */ (level.ref))
			.then((buffer) => parseGlb(buffer))
			.then((scene) => land({ status: 'ready', kind: 'tree', ...asTree(scene) }))
			.catch(fail);
	} else if (level.source === 'object') {
		const target = get(objectsGroup)?.getObjectByProperty('uuid', level.ref);
		if (!target) return fail('the object is not in the scene');
		if (target === entry.root || entry.root.getObjectById(target.id)) return fail('an object cannot be its own level');
		// a live share: same geometry and materials, its own placement reset
		land({ status: 'ready', kind: 'tree', ...asTree(target.clone(true)) });
	}
}

/** Free everything an entry built. @param {GroupEntry} entry */
function disposeBuilt(entry) {
	for (const state of entry.built.values()) {
		if (state.status !== 'ready') continue;
		if (state.kind === 'swap') {
			for (const g of state.owned) g.dispose();
			for (const r of state.releases) r();
		} else if (state.kind === 'tree') state.object.removeFromParent();
	}
	entry.built.clear();
}

// ---- the registry -------------------------------------------------------------------------

/** @type {any} */
let holders = null;
function holderRoot() {
	const scene = get(globalScene);
	if (!scene) return null;
	if (holders && holders.parent === scene) return holders;
	holders = new THREE.Group();
	holders.name = 'lod-group-holders';
	holders.matrixAutoUpdate = false;
	holders.matrixWorldAutoUpdate = false;
	scene.add(holders);
	return holders;
}

/** @param {any} root @param {LodGroup} block @param {boolean} implicit */
function ensureEntry(root, block, implicit) {
	const sig = JSON.stringify(block);
	const meshes = sourceMeshes(root);
	const meshKey = meshKeyOf(meshes);
	const existing = entries.get(root);
	if (existing && existing.meshKey === meshKey) {
		if (existing.sig !== sig) {
			// thresholds/mode/offsets/overrides changed: keep every level whose CONTENT stayed
			const keep = new Set(block.levels.map(levelKey));
			for (const [key, state] of [...existing.built]) {
				if (keep.has(key)) continue;
				if (state.status === 'ready' && state.kind === 'swap') {
					for (const g of state.owned) g.dispose();
					for (const r of state.releases) r();
				} else if (state.status === 'ready' && state.kind === 'tree') state.object.removeFromParent();
				existing.built.delete(key);
			}
			existing.block = block;
			existing.sig = sig;
			for (const c of existing.matCache.values()) c.clone.dispose();
			existing.matCache.clear();
			tick();
		}
		existing.implicit = implicit;
		existing.raw = root.userData?.lod;
		return existing;
	}
	if (existing) {
		disposeBuilt(existing);
		for (const c of existing.matCache.values()) c.clone.dispose();
	}
	/** @type {any} */
	const entry = existing ?? { root, current: 0, autoCurrent: 0, size: 0, holder: null, matCache: new Map(), built: new Map() };
	entry.block = block;
	entry.sig = sig;
	entry.implicit = implicit;
	entry.meshes = meshes;
	entry.meshKey = meshKey;
	entry.matCache = new Map();
	entry.raw = root.userData?.lod;
	measure(entry);
	entries.set(root, entry);
	tick();
	return entry;
}

/** @param {GroupEntry} entry */
function dropEntry(entry) {
	disposeBuilt(entry);
	for (const c of entry.matCache.values()) c.clone.dispose();
	entry.holder?.removeFromParent();
	entries.delete(entry.root);
	tick();
}

/** The block a root's group runs on: its own, else an implicit pack one, else null.
 * @param {any} root @returns {{block: LodGroup, implicit: boolean} | null} */
export function effectiveGroupOf(root) {
	if (!root) return null;
	const own = normalizeLodGroup(root.userData?.lod);
	if (own) return { block: own, implicit: false };
	const key = rowKeyOf(packRefOf(root));
	const imp = key ? implicitGroups.get(key) : null;
	return imp ? { block: imp, implicit: true } : null;
}

/** Walk objectsGroup: every root with a block (or an implicit pack one) gets an entry.
 * Exported for the suite. */
export function scanLodGroups() {
	const group = get(objectsGroup);
	/** @type {Set<any>} */
	const seen = new Set();
	for (const root of extraRoots) {
		const block = normalizeLodGroup(root.userData?.lod);
		if (!block) continue;
		seen.add(root);
		ensureEntry(root, block, false);
	}
	group?.traverse((/** @type {any} */ node) => {
		if (node === group || seen.has(node)) return;
		if (node.userData?.lod) {
			const block = normalizeLodGroup(node.userData.lod);
			if (block) {
				seen.add(node);
				ensureEntry(node, block, false);
			}
			return;
		}
		if (node.userData?.packRef && !node.userData.packStub) {
			const key = rowKeyOf(packRefOf(node));
			if (!key) return;
			if (!implicitGroups.has(key)) {
				lookupImplicit(key);
				return;
			}
			const imp = implicitGroups.get(key);
			if (imp) {
				seen.add(node);
				ensureEntry(node, imp, true);
			}
		}
	});
	for (const entry of [...entries.values()]) if (!seen.has(entry.root)) dropEntry(entry);
	/** @type {WeakSet<any>} */
	const next = new WeakSet();
	for (const entry of entries.values()) for (const m of entry.meshes) next.add(m);
	owned = next;
}

/** @type {ReturnType<typeof setTimeout> | null} */
let scanTimer = null;
function scheduleScan() {
	if (scanTimer) return;
	scanTimer = setTimeout(() => {
		scanTimer = null;
		scanLodGroups();
	}, 60);
}

// ---- the render pass --------------------------------------------------------------------

/** meshes hidden for this pass */
/** @type {any[]} */
const hidden = [];
/** [mesh, savedMatrixWorld] for offset levels */
/** @type {any[]} */
const moved = [];
/** @type {any[]} */
const matrixPool = [];
/** holders shown this pass */
/** @type {any[]} */
const shown = [];
const _off = new THREE.Matrix4();
const _rw = new THREE.Matrix4();
const _rwi = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

function restorePass() {
	for (const m of hidden) m.visible = true;
	hidden.length = 0;
	for (let i = 0; i < moved.length; i += 2) {
		moved[i].matrixWorld.copy(moved[i + 1]);
		matrixPool.push(moved[i + 1]);
	}
	moved.length = 0;
	for (const h of shown) h.visible = false;
	shown.length = 0;
}

/** The root-local offset of a level as a matrix (null = none). @param {any} level */
function offsetMatrix(level) {
	const o = level?.offset;
	if (!o) return null;
	_p.fromArray(o.pos ?? [0, 0, 0]);
	const r = o.rot ?? [0, 0, 0];
	_q.setFromEuler(_e.set(r[0], r[1], r[2], 'XYZ'));
	_s.fromArray(o.scale ?? [1, 1, 1]);
	return _off.compose(_p, _q, _s);
}

/** A level's material override for one source material (cloned once, re-cloned when the
 * source material changes, so an LOD0 colour edit still reaches the level).
 * @param {any} entry @param {number} i @param {any} material */
function overrideFor(entry, i, material) {
	const o = entry.block.levels[i]?.material;
	if (!o || !material || Array.isArray(material)) return null;
	const key = i + ':' + material.uuid;
	let c = entry.matCache.get(key);
	if (!c || c.version !== material.version) {
		c?.clone.dispose();
		const clone = material.clone();
		if (o.color && clone.color) clone.color.set(o.color);
		if (o.roughness !== undefined && 'roughness' in clone) clone.roughness = o.roughness;
		if (o.metalness !== undefined && 'metalness' in clone) clone.metalness = o.metalness;
		c = { clone, version: material.version };
		entry.matCache.set(key, c);
	}
	return c.clone;
}

/** The nearest level at or finer than `want` that is built (0 always is). @param {GroupEntry} entry @param {number} want */
function nearestBuilt(entry, want) {
	for (let i = want; i > 0; i--) {
		const state = entry.built.get(levelKey(entry.block.levels[i]));
		if (state?.status === 'ready') return i;
		if (!state) requestLevel(entry, i);
	}
	return 0;
}

/**
 * Called by lod.js's scene.onBeforeRender. Allocation-free on the steady path.
 * @param {any} camera @param {number} qualityBias @param {boolean} enabled @param {boolean} overlay
 */
function before(camera, qualityBias, enabled, overlay) {
	restorePass(); // a render that threw last time left a pass behind
	if (!entries.size) return;
	const P = camera.projectionMatrix?.elements;
	if (!P) return;
	const p5 = Math.abs(P[5]) || 1;
	const ortho = P[15] === 1;
	const ce = camera.matrixWorld.elements;
	for (const entry of entries.values()) {
		const root = entry.root;
		if (!root.parent || !root.visible) continue;
		// a block written since the last scan (the panel, undo, a peer) takes effect THIS frame
		const raw = root.userData?.lod;
		if (raw !== entry.raw) {
			const next = raw ? normalizeLodGroup(raw) : null;
			if (next) ensureEntry(root, next, false);
			else if (!entry.implicit) {
				// removed: the next scan drops it (or puts the pack's implicit group back)
				entry.raw = raw;
				scheduleScan();
				continue;
			}
		}
		const block = entry.block;
		// the screen size of the root's bounding sphere
		const e = root.matrixWorld.elements;
		const c = entry.center;
		const wx = e[0] * c.x + e[4] * c.y + e[8] * c.z + e[12];
		const wy = e[1] * c.x + e[5] * c.y + e[9] * c.z + e[13];
		const wz = e[2] * c.x + e[6] * c.y + e[10] * c.z + e[14];
		const scale = Math.sqrt(Math.max(e[0] * e[0] + e[1] * e[1] + e[2] * e[2], e[4] * e[4] + e[5] * e[5] + e[6] * e[6], e[8] * e[8] + e[9] * e[9] + e[10] * e[10]));
		const radius = entry.radius * scale;
		const dx = wx - ce[12];
		const dy = wy - ce[13];
		const dz = wz - ce[14];
		const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
		const size = ortho ? radius * p5 : d <= radius ? 2 : (radius * p5) / d;
		entry.size = size;
		let auto = 0;
		if (enabled) {
			const t = thresholdsOf(block, qualityBias);
			auto = pickGroupLevel(size, t.thresholds, entry.autoCurrent, { cull: !!block.cull, scale: t.scale });
		}
		entry.autoCurrent = auto;
		let want = auto;
		if (preview && preview.uuid === root.uuid && preview.level < block.levels.length) want = preview.level;
		else if (block.mode === 'forced' && block.forced !== undefined) want = block.forced;
		const drawn = want < 0 ? -1 : nearestBuilt(entry, want);
		if (drawn !== entry.current) {
			entry.current = drawn;
			tick();
		}
		apply(entry, drawn, overlay);
	}
}

/** @param {GroupEntry} entry @param {number} drawn @param {boolean} overlay */
function apply(entry, drawn, overlay) {
	if (drawn < 0) {
		for (const m of entry.meshes) if (m.visible) hideForPass(m);
		return;
	}
	if (drawn === 0) {
		if (overlay) for (const m of entry.meshes) if (m.visible) swapMaterialForPass(m, overlayMaterial(0));
		return;
	}
	const level = entry.block.levels[drawn];
	const state = /** @type {any} */ (entry.built.get(levelKey(level)));
	const off = offsetMatrix(level);
	if (off) {
		_rw.copy(entry.root.matrixWorld);
		_rwi.copy(_rw).invert();
		// R · O · R⁻¹: the offset is in the ROOT's frame, applied to each world matrix
		_off.premultiply(_rw).multiply(_rwi);
	}
	if (state.kind === 'swap') {
		const pairs = state.pairs;
		for (let i = 0; i < pairs.length; i += 3) {
			const m = pairs[i];
			// edited since the level was built (a sculpt, a meshgeo): the level is stale,
			// draw the source until the next scan rebuilds it
			if (m.geometry !== pairs[i + 1] || !m.visible) continue;
			swapGeometryForPass(m, pairs[i + 2]);
			const o = overrideFor(entry, drawn, m.material);
			if (o) swapMaterialForPass(m, o);
			if (overlay) swapMaterialForPass(m, overlayMaterial(drawn));
			if (off) moveForPass(m, _off);
		}
		return;
	}
	// a TREE level: the substitute draws, the source does not
	for (const m of entry.meshes) if (m.visible) hideForPass(m);
	const holders = holderRoot();
	if (!holders) return;
	const object = state.object;
	if (object.parent !== holders) holders.add(object);
	object.matrixAutoUpdate = false;
	object.matrix.copy(entry.root.matrixWorld);
	if (level.offset) object.matrix.multiply(/** @type {any} */ (offsetMatrix(level)));
	object.visible = true;
	object.updateMatrixWorld(true);
	shown.push(object);
	if (overlay || level.material)
		object.traverse((/** @type {any} */ n) => {
			if (!n.isMesh) return;
			const o = overrideFor(entry, drawn, n.material);
			if (o) swapMaterialForPass(n, o);
			if (overlay) swapMaterialForPass(n, overlayMaterial(drawn));
		});
}

/** @param {any} m */
function hideForPass(m) {
	m.visible = false;
	hidden.push(m);
}

/** @param {any} m @param {any} matrix R·O·R⁻¹ */
function moveForPass(m, matrix) {
	const saved = matrixPool.pop() ?? new THREE.Matrix4();
	saved.copy(m.matrixWorld);
	moved.push(m, saved);
	m.matrixWorld.premultiply(matrix);
}

/** Called by lod.js's scene.onAfterRender. */
function after() {
	restorePass();
}

/** @param {any} mesh */
function owns(mesh) {
	return owned.has(mesh);
}

// ---- reads for the panel, the VR panel and the suite --------------------------------------

/**
 * What the LOD panel shows for one object: the block it runs on (own or implicit), and per
 * level its source, build status and triangles; the drawn level and the last screen size.
 * @param {string} uuid
 */
export function lodGroupInfo(uuid) {
	const root = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	const eff = effectiveGroupOf(root);
	if (!root || !eff) return null;
	const entry = entries.get(root);
	const tris0 = (entry?.meshes ?? sourceMeshes(root)).reduce((n, m) => n + trianglesOf(m.geometry), 0);
	return {
		uuid,
		block: eff.block,
		implicit: eff.implicit,
		current: entry?.current ?? 0,
		size: entry?.size ?? 0,
		levels: eff.block.levels.map((level, i) => {
			if (i === 0) return { ...level, status: 'ready', tris: tris0, error: null, kind: null };
			const state = /** @type {any} */ (entry?.built.get(levelKey(level)));
			return { ...level, status: state?.status ?? 'idle', tris: state?.tris ?? null, error: state?.error ?? null, kind: state?.kind ?? null };
		})
	};
}

/** Build every level of one group now (the panel's "Build all", the suite). @param {string} uuid */
export function buildAllLevels(uuid) {
	const root = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	scanLodGroups();
	const entry = root ? entries.get(root) : null;
	if (!entry) return false;
	entry.block.levels.forEach((_, i) => requestLevel(entry, i));
	return true;
}

/** Every group, for the probe and the suite. */
export function lodGroupStats() {
	return [...entries.values()].map((e) => ({
		uuid: e.root.uuid,
		name: e.root.name,
		implicit: e.implicit,
		meshes: e.meshes.length,
		current: e.current,
		size: Number(e.size.toFixed(4)),
		radius: Number(e.radius.toFixed(4)),
		levels: e.block.levels.map((l, i) => {
			const s = /** @type {any} */ (i === 0 ? { status: 'ready' } : e.built.get(levelKey(l)));
			return { source: l.source, status: s?.status ?? 'idle', tris: s?.tris ?? null, kind: s?.kind ?? null, paired: s?.kind === 'swap' ? s.pairs.length / 3 : null, error: s?.error ?? null };
		})
	}));
}

/** Is this mesh drawn by a LOD group? (lod.js asks, the overlay legend reads it) */
export { owns as ownedByLodGroup };

let started = false;
/** Boot (App). Idempotent. */
export function startLodGroups() {
	if (started || typeof window === 'undefined') return;
	started = true;
	registerLodPass({ before, after, owns });
	objectsGroup.subscribe(() => scheduleScan());
	setInterval(scanLodGroups, 2000);
	scheduleScan();
}

/** TEST-ONLY seams. */
export const lodGroupForTest = {
	reset() {
		for (const entry of [...entries.values()]) dropEntry(entry);
		implicitGroups.clear();
		listFetches.clear();
		extraRoots.clear();
	},
	entries: () => entries
};
