import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { globalScene, objectsGroup, selectedObjects } from '../stores/sceneStore';
import { safeStorage } from './safeStorage';
import { registerBatchPass } from './lod';
import { kitMeshSource, warmPrograms } from './packRefs';
import { cellKey, cellOf, materialSignature, ineligible, MIN_BATCH, CELL_METRES } from './kitInstancingCore';

// 33-scenes — KIT INSTANCING: every pristine copy of one pack piece drawn as ONE call.
//
// THE MEASUREMENT this exists for (scripts/perf-levels.cjs on the 1.18 levels): the Tavern
// Interior drew 394 calls per frame from its spawn and the Castle Courtyard 371 — two and a
// half times the Quest budget of 150 — while their 224 and 210 meshes come from only 45 and
// 44 distinct pack meshes (74 floor tiles, 24 plaster walls, 32 battlements…). A kit level
// IS a few pieces repeated, which is exactly what an InstancedMesh draws in one call.
//
// THE SAME RULE AS LOD (31-perf / 33-lod-editor), for the same reason: objectsGroup is the
// replicated document, so the TREE IS LEFT ALONE. Inside each render call, after the level
// swaps (lod.js registerBatchPass), the pass groups the eligible meshes by (the geometry they
// will draw, their piece's template material, an 8 m column, the shadow flags), hides the
// members of every group of two or more for that call, and shows one scene-root
// InstancedMesh per group holding their world matrices. On the way out the members come
// back. Picking, BVH, physics, the mesh tools and every serializer only ever see the
// ordinary meshes; a peer message landing between frames sees them too.
//
// ELIGIBLE = a placed pack piece (packRefs refilled it, so kitMeshSource knows the template
// mesh it was cloned from) that is still PRISTINE in the ways that change pixels: its own
// geometry, unedited (position version), its own material, not transparent (an instanced
// draw sorts as one object), and a material signature equal to its template's (a recoloured
// wall leaves the batch). A SELECTED piece leaves too — the outline and the gizmo draw the
// mesh itself. A mesh another pass hid (a LOD group's cull) or swapped a material on (the
// "Show LOD level" overlay, a per-level override) is skipped for that call. The geometry a
// member draws is the TEMPLATE's when the mesh shows its own (source) geometry — every copy
// cloned it, so they are equal by construction — or the level geometry a LOD pass put on it,
// which every copy shares (pack level files are fetched once per url, auto levels are cached
// by content). The material is always the template's: equal to the copy's by the signature.
//
// COLUMNS keep culling alive: one batch of every wall in a castle is drawn or skipped as a
// whole, so batches are cut into 8 m columns (kitInstancingCore.CELL_METRES).
//
// LOCAL, like every render decision: nothing here replicates, saves or undoes. The
// `kitInstancingEnabled` pref (default ON, Settings ▸ Performance) is the opt-out.

/** The opt-out. LOCAL, default ON. */
export const kitInstancingEnabled = writable(safeStorage.getItem('kitInstancing') !== 'false');
let enabledSeen = false;
let enabled = true;
kitInstancingEnabled.subscribe((on) => {
	enabled = !!on;
	if (!enabledSeen) {
		enabledSeen = true;
		return;
	}
	safeStorage.setItem('kitInstancing', on ? 'true' : 'false');
});

/** How often the candidate list is rebuilt (a traversal; a poke rebuilds sooner). */
const SCAN_MS = 1000;
const POKE_MS = 250;

/** @typedef {{mesh: any, root: any, source: any}} Candidate */
/** @type {Candidate[]} */
let candidates = [];
/** @type {Set<string>} uuids of the selected pieces */
let selected = new Set();

/**
 * @typedef {{key: number, geometry: any, material: any, members: any[], count: number,
 *   holder: any, capacity: number, drawn: number, signature: number}} Batch
 */
/** geometry -> material -> cell key -> batch. Reused across calls: no allocation per pass
 * once the scene has been seen. @type {Map<any, Map<any, Map<number, Batch>>>} */
const batches = new Map();
/** every batch, for the reset at the top of a pass @type {Batch[]} */
const allBatches = [];
/** members hidden in the current call @type {any[]} */
const hidden = [];
/** holders shown in the current call @type {any[]} */
const shown = [];
/** materials whose instanced program was warmed @type {WeakSet<any>} */
const warmed = new WeakSet();
/** @type {any} */
let holderRoot = null;
// per-member culling temporaries (allocation-free per pass)
const frustum = new THREE.Frustum();
const viewProjection = new THREE.Matrix4();
const sphere = new THREE.Sphere();
const stats = { candidates: 0, batches: 0, members: 0, holders: 0, passes: 0, lastScanMs: 0 };
let statsAt = 0;
/** the column size in use (kitInstancingCore.CELL_METRES; the probe can try others) */
let cellMetres = CELL_METRES;
/** For the probe: re-cut the batches at another column size. @param {number} metres */
export function setKitCellMetres(metres) {
	cellMetres = Number.isFinite(metres) && metres > 0 ? metres : CELL_METRES;
	clearBatches();
}

function holderParent() {
	const scene = get(globalScene);
	if (!scene) return null;
	if (holderRoot && holderRoot.parent === scene) return holderRoot;
	holderRoot = scene.getObjectByName('kit-instancing-root');
	if (!holderRoot) {
		holderRoot = new THREE.Group();
		holderRoot.name = 'kit-instancing-root';
		holderRoot.matrixAutoUpdate = false;
		holderRoot.userData.local = true;
		scene.add(holderRoot);
	}
	return holderRoot;
}

/** the batch for (geometry, material, cell) @param {any} geometry @param {any} material @param {number} key */
function batchFor(geometry, material, key) {
	let byMaterial = batches.get(geometry);
	if (!byMaterial) batches.set(geometry, (byMaterial = new Map()));
	let byCell = byMaterial.get(material);
	if (!byCell) byMaterial.set(material, (byCell = new Map()));
	let batch = byCell.get(key);
	if (!batch) {
		batch = { key, geometry, material, members: [], count: 0, holder: null, capacity: 0, drawn: 0, signature: 0 };
		byCell.set(key, batch);
		allBatches.push(batch);
	}
	return batch;
}

/** an InstancedMesh holder big enough for `n` @param {Batch} batch @param {number} n */
function ensureHolder(batch, n) {
	if (batch.holder && batch.capacity >= n) return batch.holder;
	const parent = holderParent();
	if (!parent) return null;
	if (batch.holder) {
		parent.remove(batch.holder);
		batch.holder.dispose?.();
	}
	let capacity = 8;
	while (capacity < n) capacity *= 2;
	const holder = new THREE.InstancedMesh(batch.geometry, batch.material, capacity);
	holder.name = 'kit-batch';
	holder.matrixAutoUpdate = false;
	holder.visible = false;
	holder.count = 0;
	holder.raycast = () => {}; // never a pick target: the members are
	holder.userData.local = true;
	const { cast, receive } = cellOf(batch.key, cellMetres);
	holder.castShadow = cast;
	holder.receiveShadow = receive;
	parent.add(holder);
	batch.holder = holder;
	batch.capacity = capacity;
	batch.drawn = 0;
	batch.signature = 0;
	stats.holders++;
	return holder;
}

/** is every ancestor of `mesh` up to the piece root visible @param {any} mesh @param {any} root */
function shownToRoot(mesh, root) {
	for (let node = mesh; node; node = node.parent) {
		if (!node.visible) return false;
		if (node === root) return true;
	}
	return true;
}

/**
 * lod.js calls this inside every render call, after its level swaps.
 * @param {any} camera
 */
function before(camera) {
	if (!enabled || !candidates.length) return;
	stats.passes++;
	for (let i = 0; i < allBatches.length; i++) {
		allBatches[i].count = 0;
	}
	// a batch is culled as ONE object, so a member that is off screen must not join it — it
	// would be drawn for every member of its batch that is on screen. Off-screen members stay
	// ordinary meshes, which three culls itself (no call). This is what keeps the triangle
	// count of an instanced level where the frustum puts it, and what lets the columns be wide
	viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
	frustum.setFromProjectionMatrix(viewProjection);
	// 1 group the eligible meshes of this call
	for (let i = 0; i < candidates.length; i++) {
		const c = candidates[i];
		const mesh = c.mesh;
		if (!mesh.parent || mesh.material !== c.source.material) continue; // removed / a pass swapped its material
		if (selected.size && (selected.has(c.root.uuid) || selected.has(mesh.uuid))) continue;
		if (!shownToRoot(mesh, c.root)) continue;
		if ((mesh.layers.mask & camera.layers.mask) === 0) continue;
		const geometry = mesh.geometry === c.source.geometry ? c.source.template.geometry : mesh.geometry;
		if (mesh.frustumCulled !== false) {
			if (!geometry.boundingSphere) geometry.computeBoundingSphere();
			if (!frustum.intersectsSphere(sphere.copy(geometry.boundingSphere).applyMatrix4(mesh.matrixWorld))) continue;
		}
		const e = mesh.matrixWorld.elements;
		const batch = batchFor(geometry, c.source.template.material, cellKey(e[12], e[14], mesh.castShadow, mesh.receiveShadow, cellMetres));
		if (batch.members.length <= batch.count) batch.members.push(mesh);
		else batch.members[batch.count] = mesh;
		batch.count++;
	}
	// 2 draw every group of two or more as one instanced call; the rest draw as themselves
	let drawnBatches = 0;
	let members = 0;
	for (let b = 0; b < allBatches.length; b++) {
		const batch = allBatches[b];
		const n = batch.count;
		if (n < MIN_BATCH) continue;
		const holder = ensureHolder(batch, n);
		if (!holder) continue;
		const array = holder.instanceMatrix.array;
		let changed = n !== batch.drawn;
		let signature = 0;
		for (let i = 0; i < n; i++) {
			const mesh = batch.members[i];
			const e = mesh.matrixWorld.elements;
			const o = i * 16;
			for (let k = 0; k < 16; k++) {
				if (array[o + k] !== e[k]) {
					array[o + k] = e[k];
					changed = true;
				}
			}
			signature = (signature * 31 + mesh.id) | 0;
			mesh.visible = false;
			hidden.push(mesh);
		}
		if (signature !== batch.signature) changed = true;
		if (changed) {
			holder.count = n;
			holder.instanceMatrix.needsUpdate = true;
			holder.computeBoundingSphere();
			batch.drawn = n;
			batch.signature = signature;
		}
		holder.visible = true;
		shown.push(holder);
		drawnBatches++;
		members += n;
	}
	// a frame is several render calls (the composer's passes draw the scene too, some with a
	// layer mask that matches nothing here): report the heaviest call of the last quarter second
	const t = performance.now();
	if (members >= stats.members || t - statsAt > 250) {
		stats.batches = drawnBatches;
		stats.members = members;
		statsAt = t;
	}
}

/** lod.js calls this when the render call is over (and defensively before the next one). */
function after() {
	for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
	hidden.length = 0;
	for (let i = 0; i < shown.length; i++) shown[i].visible = false;
	shown.length = 0;
}

/** Rebuild the candidate list: every eligible mesh of every placed pack piece. Exported for
 * the suite. */
export function scanForKitInstancing() {
	const t0 = performance.now();
	const group = get(objectsGroup);
	/** @type {Candidate[]} */
	const next = [];
	/** @type {Set<any>} */
	const materials = new Set();
	if (group && enabled) {
		for (const root of group.children) {
			if (!root.userData?.packRef || root.userData.packStub) continue;
			root.traverse((/** @type {any} */ mesh) => {
				if (!mesh.isMesh) return;
				const source = kitMeshSource(mesh);
				if (!source) return;
				if (!source.sig) source.sig = materialSignature(source.template.material);
				if (ineligible({ mesh, source })) return;
				next.push({ mesh, root, source });
				materials.add(source.template.material);
			});
		}
	}
	candidates = next;
	stats.candidates = next.length;
	// forget batches whose geometry no candidate can draw any more (a cleared scene)
	if (!next.length) clearBatches();
	stats.lastScanMs = Math.round((performance.now() - t0) * 10) / 10;
	warmInstanced(materials);
}

/** Link each material's INSTANCED program off-frame (the first draw of a batch would
 * otherwise compile inside a render call). Best effort. @param {Set<any>} materials */
function warmInstanced(materials) {
	/** @type {any[]} */
	const cold = [];
	for (const m of materials) if (!warmed.has(m)) cold.push(m);
	if (!cold.length) return;
	const probe = new THREE.Group();
	const box = new THREE.BoxGeometry(0.01, 0.01, 0.01);
	for (const m of cold) {
		warmed.add(m);
		const one = new THREE.InstancedMesh(box, m, 1);
		one.castShadow = true;
		one.receiveShadow = true;
		probe.add(one);
	}
	Promise.resolve(warmPrograms(probe))
		.catch(() => {})
		.finally(() => {
			for (const one of probe.children) /** @type {any} */ (one).dispose?.();
			box.dispose();
		});
}

function clearBatches() {
	after();
	for (const batch of allBatches) {
		if (batch.holder) {
			batch.holder.parent?.remove(batch.holder);
			batch.holder.dispose?.();
		}
	}
	allBatches.length = 0;
	batches.clear();
}

/** @type {ReturnType<typeof setInterval> | null} */
let scanTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let pokeTimer = null;

/** Start the scan + the pass (App boot, after startLod). Idempotent. */
export function startKitInstancing() {
	if (scanTimer || typeof window === 'undefined') return;
	registerBatchPass({ before, after });
	scanTimer = setInterval(scanForKitInstancing, SCAN_MS);
	objectsGroup.subscribe(() => {
		if (pokeTimer) return;
		pokeTimer = setTimeout(() => {
			pokeTimer = null;
			scanForKitInstancing();
		}, POKE_MS);
	});
	selectedObjects.subscribe((/** @type {any} */ list) => {
		selected = new Set(Array.isArray(list) ? list.map((/** @type {any} */ x) => (typeof x === 'string' ? x : x?.uuid)).filter(Boolean) : []);
	});
	kitInstancingEnabled.subscribe((on) => {
		if (!on) clearBatches();
		scanForKitInstancing();
	});
}

/** For the probe, the suite and the stats plate. */
export function kitInstancingStats() {
	return { ...stats, enabled, allBatches: allBatches.length };
}
