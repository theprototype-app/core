// 105-slot-save-fix: ONE rule for writing a mesh's material-slot groups, used by every serializer, plus the load-side
// repair for files written before it. A leaf: three only (history.js, sessions.js, autosave.js and the peer sync all
// import it, and nothing in history's import subtree may grow an edge back into the app).
//
// THE BUG (shipped through 1.74.0): three's toJSON writes a PARAMETRIC geometry (BoxGeometry, SphereGeometry, ...) as
// its parameters, and ObjectLoader RE-RUNS the generator, so the loaded mesh gets the generator's default groups. A
// primitive with an added material slot has custom groups (one group covering every face, on slot 0): after a save +
// reopen, a box came back with six groups for two materials, so 8 of 12 triangles pointed at slots that do not exist
// and drew nothing; a sphere (no default groups) drew nothing at all. Scene save, the selection .tpscene, undo of a
// delete, prefabs and the VR sleeve all used plain toJSON. Autosave and the peer sync had their own copy of the fix
// (serializeMeshWithGroups); this module is that fix, once.
//
// THE RULE: a mesh is written as its parameters only when the loader would rebuild the SAME groups; otherwise its
// geometry is written as plain data (attributes + index + groups). Single-material meshes, and slot lists whose groups
// the generator makes itself, are written byte-identically to before.
import * as THREE from 'three';

/** @param {any[] | undefined} groups */
function groupsKey(groups) {
	return (groups ?? []).map((g) => g.start + ',' + g.count + ',' + (g.materialIndex || 0)).join(';');
}

/** the regenerated groups' key per geometry instance (parameters never change on one instance)
 * @type {WeakMap<object, string | null>} */
const regenerated = new WeakMap();

/**
 * What ObjectLoader would give back for this geometry's groups: the key, or null when it cannot rebuild it.
 * Calls the same `fromJSON` the loader calls (so a patched one, e.g. the rounded box, is honoured) without a generic
 * loader (check-loaders: those live in loadGuard.js only).
 * @param {any} geometry @returns {string | null}
 */
function loaderGroupsKey(geometry) {
	if (regenerated.has(geometry)) return /** @type {string | null} */ (regenerated.get(geometry));
	/** @type {string | null} */
	let key = null;
	try {
		const Ctor = /** @type {any} */ (THREE)[geometry.type];
		if (typeof Ctor?.fromJSON === 'function') {
			/** @type {Record<string, any>} */
			const shapes = {};
			const own = geometry.parameters.shapes;
			for (const shape of own === undefined ? [] : Array.isArray(own) ? own : [own]) shapes[shape.uuid] = shape;
			const copy = Ctor.fromJSON(geometry.toJSON(), shapes);
			key = groupsKey(copy?.groups);
			copy?.dispose?.();
		}
	} catch {
		key = null;
	}
	regenerated.set(geometry, key);
	return key;
}

/**
 * Would a plain toJSON of this mesh lose its slot groups? True only for a slot list on a parametric geometry whose
 * groups the generator would not rebuild.
 * @param {any} mesh @returns {boolean}
 */
export function losesSlotGroups(mesh) {
	const geometry = mesh?.geometry;
	if (!Array.isArray(mesh?.material) || !geometry?.isBufferGeometry || !geometry.parameters) return false;
	return loaderGroupsKey(geometry) !== groupsKey(geometry.groups);
}

/**
 * A plain BufferGeometry copy (attributes, index, groups, userData) under the SAME uuid, so anything keyed by the
 * geometry uuid (shared geometries in one JSON) still resolves.
 * @param {any} geometry
 */
function plainCopy(geometry) {
	const flat = new THREE.BufferGeometry().copy(geometry);
	flat.uuid = geometry.uuid;
	return flat;
}

/**
 * `object.toJSON()` with every mesh in its subtree that would lose its slot groups written as plain geometry. The
 * ONE serializer for an object's JSON: scene saves, the selection .tpscene, undo snapshots, prefabs, the peer sync.
 * Pure: the live objects are not touched.
 * @param {any} object @param {any} [meta] passed through to toJSON (rarely needed)
 */
export function objectToJSON(object, meta) {
	const json = object.toJSON(meta);
	/** @type {Map<string, any>} */
	const swaps = new Map();
	object.traverse?.((/** @type {any} */ node) => {
		if (node.isMesh && !swaps.has(node.geometry?.uuid) && losesSlotGroups(node)) swaps.set(node.geometry.uuid, node.geometry);
	});
	if (!swaps.size || !Array.isArray(json?.geometries)) return json;
	json.geometries = json.geometries.map((/** @type {any} */ entry) => {
		const geometry = swaps.get(entry?.uuid);
		if (!geometry) return entry;
		const flat = plainCopy(geometry);
		const out = flat.toJSON();
		delete out.metadata; // Object3D.toJSON strips it from its geometry list too
		flat.dispose();
		return out;
	});
	return json;
}

/**
 * Swap a parametric geometry that carries custom slot groups for a plain copy IN PLACE, so every later toJSON (any
 * call site, any module) writes the groups. The parametric rows keep working: they read `userData.geometryParams`.
 * Call after writing groups onto a mesh. Returns whether it swapped.
 * @param {any} mesh @returns {boolean}
 */
export function settleSlotGroups(mesh) {
	if (!losesSlotGroups(mesh)) return false;
	const old = mesh.geometry;
	mesh.geometry = plainCopy(old);
	old.dispose();
	return true;
}

/**
 * Does every triangle of this slot-list mesh draw? (Each one inside a group whose slot exists.)
 * @param {any} mesh @returns {boolean}
 */
function everyFaceDraws(mesh) {
	const geometry = mesh.geometry;
	const count = geometry.index ? geometry.index.count : geometry.attributes?.position?.count ?? 0;
	const slots = mesh.material.length;
	const spans = (geometry.groups ?? [])
		.filter((/** @type {any} */ g) => (g.materialIndex || 0) < slots && g.count > 0)
		.map((/** @type {any} */ g) => [g.start, Math.min(count, g.start + g.count)])
		.sort((/** @type {number[]} */ a, /** @type {number[]} */ b) => a[0] - b[0]);
	let covered = 0;
	for (const [start, end] of spans) {
		if (start > covered) return false;
		covered = Math.max(covered, end);
	}
	return covered >= count;
}

/**
 * LOAD-SIDE REPAIR for a scene written before this fix. A primitive with a slot list whose generator-rebuilt groups
 * leave faces drawing nothing lost its groups in the save. Those groups can be rebuilt exactly: the only way such a
 * file was written is "Add material slot" with no faces assigned yet (assigning faces rebuilds the mesh as plain
 * geometry, which always saved correctly), and that state is ONE group covering every face, on slot 0. The geometry
 * is also made plain so the repaired object saves correctly from then on.
 * Only parametric geometry is touched: a plain geometry's groups are what its author wrote.
 * @param {any} root @returns {number} meshes repaired
 */
export function healSlotGroups(root) {
	let n = 0;
	root?.traverse?.((/** @type {any} */ node) => {
		const geometry = node.geometry;
		if (!node.isMesh || !Array.isArray(node.material) || !node.material.length || !geometry?.parameters) return;
		// a rounded box still waiting for its chunk is a square stand-in: restoreRoundedBoxes heals it after the swap
		const gp = node.userData?.geometryParams;
		if (gp?.gtype === 'Box' && Number(gp.params?.radius) > 0 && !(Number(geometry.parameters.radius) > 0)) return;
		if (everyFaceDraws(node)) return;
		const count = geometry.index ? geometry.index.count : geometry.attributes?.position?.count ?? 0;
		geometry.clearGroups();
		geometry.addGroup(0, count, 0);
		settleSlotGroups(node);
		n++;
	});
	return n;
}
