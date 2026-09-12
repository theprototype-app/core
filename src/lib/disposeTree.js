// 27-G (audit H6, M13) — GIVING GPU MEMORY BACK.
//
// Removing an object from the scene drops the JS reference and NOTHING else: its
// geometry, its materials and every texture they hold stay resident on the GPU until the
// context dies. `deleteObject` has always been `parent.remove(object)` and no more, so a
// session that imports and deletes the same model ten times pays for ten copies. That is
// audit H6.
//
// THE WHOLE DIFFICULTY IS SHARING, not freeing. This codebase shares resources
// deliberately and in several directions: `clone()` shares geometry and material, which
// is why `editOverlays` detaches without disposing; `onionSkin` frees the materials it
// made and never the geometry it borrowed; a duplicated object, a prefab instance and a
// material fanned across a selection can all hold the same texture. Disposing a texture
// that something else still draws with does not throw — it renders BLACK, later, somewhere
// else, with nothing to connect it to the delete that caused it.
//
// So the rule is: work out what the REST of the scene still holds, in one pass, and free
// only what nothing else refers to. `keepSet` answers that question and `disposeTree`
// obeys it. A LEAF (THREE only), so the sharing logic is testable with no renderer.

import * as THREE from 'three';

/** @param {any} material @param {(t: any) => void} visit */
function eachTexture(material, visit) {
	if (!material) return;
	// Scan the material's OWN properties rather than a hardcoded list of map names.
	// three.js grows new map slots release to release, and a list silently stops
	// covering the newest one — a leak that looks exactly like no leak.
	for (const key of Object.keys(material)) {
		const value = /** @type {any} */ (material)[key];
		if (value && value.isTexture) visit(value);
	}
}

/** @param {any} object @param {(r: any) => void} visit */
function eachResource(object, visit) {
	if (!object) return;
	if (object.geometry) visit(object.geometry);
	const material = object.material;
	if (!material) return;
	const list = Array.isArray(material) ? material : [material];
	for (const m of list) {
		if (!m) continue;
		visit(m);
		eachTexture(m, visit);
	}
}

/**
 * Everything the scene still holds OUTSIDE `doomed` — geometries, materials and textures,
 * in ONE traversal. Pass the result to `disposeTree` as its `keep` set.
 *
 * `doomed` may be a single object or an array; anything at or beneath one of them is
 * skipped, because those are precisely the references about to go away.
 * @param {any} scene @param {any | any[]} doomed
 */
export function keepSet(scene, doomed) {
	const roots = Array.isArray(doomed) ? doomed.filter(Boolean) : doomed ? [doomed] : [];
	const dying = new Set();
	for (const root of roots) root.traverse?.((/** @type {any} */ o) => dying.add(o));
	/** @type {Set<any>} */
	const keep = new Set();
	scene?.traverse?.((/** @type {any} */ o) => {
		if (dying.has(o)) return;
		eachResource(o, (r) => keep.add(r));
	});
	return keep;
}

/**
 * Free the GPU resources under `root`, skipping anything in `keep`.
 *
 * Returns what it actually freed, which is what makes this testable and what the suite
 * asserts on — a disposal that silently frees nothing looks identical to one that works
 * until you read `renderer.info.memory`.
 *
 * Deliberately does NOT remove `root` from its parent: callers already do that, and
 * doing it here would make the function's name a lie about half of what it does.
 * @param {any} root
 * @param {{ keep?: Set<any> }} [options]
 */
export function disposeTree(root, options = {}) {
	const keep = options.keep ?? new Set();
	const freed = { geometries: 0, materials: 0, textures: 0 };
	if (!root) return freed;
	// one object can reference the same material twice (an array with repeats); a local
	// seen-set keeps the counts honest
	const seen = new Set();
	root.traverse?.((/** @type {any} */ o) => {
		eachResource(o, (r) => {
			if (!r || keep.has(r) || seen.has(r)) return;
			seen.add(r);
			if (typeof r.dispose !== 'function') return;
			if (r.isTexture) freed.textures++;
			else if (r.isMaterial) freed.materials++;
			else if (r.isBufferGeometry) freed.geometries++;
			else return; // something else entirely: leave it alone
			r.dispose();
		});
	});
	return freed;
}

/**
 * The ordinary call: take the object out of the scene AND free what only it was using.
 * The keep set is computed BEFORE the removal, against the scene it is still part of —
 * `keepSet` excludes the doomed subtree itself, so the order is safe either way, but
 * computing it first means one traversal of a scene that has not been mutated underneath.
 * @param {any} scene @param {any} object
 */
export function removeAndDispose(scene, object) {
	if (!object) return { geometries: 0, materials: 0, textures: 0 };
	const keep = keepSet(scene, object);
	object.parent?.remove(object);
	return disposeTree(object, { keep });
}

export { THREE };
