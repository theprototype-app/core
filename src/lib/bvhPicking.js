import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

// 17-D3: BVH-accelerated viewport picking.
//
// Every pick in the app was a brute-force `Raycaster` walk over each triangle of
// each mesh, so clicking in a scene with an imported model tested hundreds of
// thousands of triangles. three-mesh-bvh replaces `Mesh.raycast` with a version
// that uses a per-geometry bounds tree WHEN ONE EXISTS and otherwise calls the
// original three implementation — which is what makes this safe to switch on
// globally: a geometry with no tree behaves exactly as it did before. Building
// the tree is the only decision we own, and it happens here.
//
// Trees are built INDIRECT (`{ indirect: true }`), and that is not optional: the
// default build REORDERS the geometry's index buffer for spatial locality, which
// silently renumbers every triangle. `faceIndex` is how the mesh tools address
// triangles (Face/Triangle/Shell granularity, the welded-shell sets), so a
// default build would hand the same hit point a different face id and invalidate
// any triangle set captured before it. The indirect build keeps its own mapping
// and leaves the geometry untouched — proven by the faceIndex parity check in
// tests/e2e/bvh-picking.test.cjs, which fails against a default build.
//
// Two more rules keep the trees honest:
//  * A tree is stamped with the position attribute it was built from AND that
//    attribute's `version`. Setting `needsUpdate` bumps the version, so an
//    IN-PLACE edit (a sculpt stroke, a vertex drag) invalidates the tree instead
//    of silently picking against stale triangles. Whole-geometry swaps
//    (applyMeshGeo) are safe for free: the new geometry simply has no tree yet.
//  * The object of an ACTIVE edit/sculpt session never gets a tree — its
//    geometry changes every frame, so a rebuild per stroke would cost more than
//    the brute-force ray it replaces, and the edit tools' own raycasts keep
//    exactly the stock code path they were written against.
//
// Trees are only worth building past a triangle count; below it the build costs
// more than the walk it saves.

const MIN_TRIANGLES = 1000;

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** @type {WeakMap<any, {attribute: any, version: number}>} geometry -> what its tree was built from */
const stamps = new WeakMap();

let built = 0;
let rebuilt = 0;

/** @param {any} geometry */
function triangleCount(geometry) {
	const count = geometry?.index?.count ?? geometry?.attributes?.position?.count ?? 0;
	return count / 3;
}

/** Drop a geometry's tree (and its stamp) @param {any} geometry */
export function dropBoundsTree(geometry) {
	if (!geometry?.boundsTree) return;
	geometry.disposeBoundsTree();
	stamps.delete(geometry);
}

/**
 * Make sure every mesh worth accelerating under `root` has a CURRENT bounds tree.
 * Cheap to call before a pick: geometries that already have a valid tree are a
 * WeakMap lookup each.
 * @param {any} root
 * @param {string[]} [skipUuids] objects in a live edit/sculpt session
 */
export function ensureBoundsTrees(root, skipUuids = []) {
	if (!root) return;
	root.traverse((/** @type {any} */ object) => {
		if (!object?.isMesh || !object.geometry) return;
		const geometry = object.geometry;
		if (skipUuids.includes(object.uuid)) {
			dropBoundsTree(geometry); // a live session mutates it in place
			return;
		}
		const position = geometry.attributes?.position;
		if (!position || triangleCount(geometry) < MIN_TRIANGLES) return;
		const stamp = stamps.get(geometry);
		if (
			geometry.boundsTree &&
			stamp &&
			stamp.attribute === position &&
			stamp.version === position.version
		)
			return;
		if (geometry.boundsTree) {
			geometry.disposeBoundsTree();
			rebuilt++;
		} else {
			built++;
		}
		try {
			geometry.computeBoundsTree({ indirect: true }); // never renumber triangles
			stamps.set(geometry, { attribute: position, version: position.version });
		} catch (error) {
			// a degenerate geometry keeps the stock raycast rather than breaking picks
			console.log('bvh build skipped', error);
			stamps.delete(geometry);
		}
	});
}

/** debugStores probe (opt-in, like colliderHelpersDebug) */
export function bvhDebug() {
	return { built, rebuilt, minTriangles: MIN_TRIANGLES };
}
