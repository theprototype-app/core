// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalScene } from '../stores/sceneStore';
import { proportionalRadius, proportionalAnchor } from './proportional';

// 19-A P4: the proportional-editing RADIUS RING — a scene-root viewport helper
// showing how far the falloff reaches. Scene root, NEVER objectsGroup (it would
// enter GLTF sync/export); raycast stubbed so it can never swallow a pick — the
// terrainSculpt cursor recipe. Shown during any proportional drag (meshEdit's
// beginFalloff, faceEdit's beginFaceGrab) and while the radius row is being
// scrubbed; hidden on commit/cancel/drag-end.
//
// This is NOT a section of proportional.js by design: that module is a
// svelte/store-only LEAF both meshEdit and faceEdit import for state, while this
// one needs three + sceneStore. Keeping the leaf pure keeps the cycle analysis
// trivial (nothing here is imported by anything that history imports).

/** @type {any} */ let ring = null;
/** the anchor of the current showing — re-placed live when the radius scrubs
 * @type {{point: any, normal: any, object: any}|null} */
let anchorState = null;

const Z_AXIS = new THREE.Vector3(0, 0, 1);

/** Average of the object's world-scale components. The proportional radius is
 * OBJECT-LOCAL units, the ring lives in world space — under a NON-UNIFORM scale
 * the true iso-distance contour is an ellipse, so the circle at the mean is an
 * approximation (documented; the falloff math itself is exact, only the viz
 * rounds). @param {any} object @returns {number} */
function meanWorldScale(object) {
	if (!object?.getWorldScale) return 1;
	const s = object.getWorldScale(new THREE.Vector3());
	return (Math.abs(s.x) + Math.abs(s.y) + Math.abs(s.z)) / 3 || 1;
}

/** @param {any} scene @returns {any} */
function ensureRing(scene) {
	if (ring) {
		if (!ring.parent) scene.add(ring);
		return ring;
	}
	ring = new THREE.Mesh(
		new THREE.RingGeometry(0.94, 1, 48),
		new THREE.MeshBasicMaterial({
			color: 0x5fd0ff,
			transparent: true,
			opacity: 0.6,
			depthTest: false,
			side: THREE.DoubleSide // visible from either side of the surface, like the sculpt cursor
		})
	);
	ring.name = 'proportional-ring';
	ring.renderOrder = 997;
	ring.raycast = () => {}; // a viewport helper must never be a pick target
	scene.add(ring);
	return ring;
}

/** Position/orient/scale the ring from the current anchor + radius. */
function place() {
	if (!ring || !anchorState) return;
	ring.position.copy(anchorState.point).addScaledVector(anchorState.normal, 0.02);
	ring.quaternion.setFromUnitVectors(Z_AXIS, anchorState.normal);
	const s = Math.max(get(proportionalRadius), 1e-4) * meanWorldScale(anchorState.object);
	ring.scale.setScalar(s);
}

/**
 * Show the ring at an explicit WORLD anchor — the drag paths call this with the
 * exact point/normal the grab captured. `object` = the edited mesh (its world
 * scale converts the local radius); a unit normal is not required (normalized here).
 * @param {{point: any, normal: any, object?: any}|null} anchor
 */
export function showProportionalRingAt(anchor) {
	if (!anchor?.point || !anchor.normal) return;
	const scene = get(globalScene);
	if (!scene) return;
	anchorState = {
		point: anchor.point.clone(),
		normal: anchor.normal.clone().normalize(),
		object: anchor.object ?? null
	};
	const mesh = ensureRing(scene);
	mesh.visible = true;
	place();
}

/**
 * Show the ring at the CURRENT selection of an element mode, via the provider
 * meshEdit/faceEdit registered — the radius DragRow's scrub preview. No
 * provider or nothing selected -> the ring hides instead of lying.
 * @param {'vertices'|'edges'|'faces'} mode
 */
export function showRadiusPreview(mode) {
	const anchor = proportionalAnchor(mode);
	if (!anchor) {
		hideProportionalRing();
		return;
	}
	showProportionalRingAt(anchor);
}

/** Hide the ring (kept for reuse — it is one tiny mesh). */
export function hideProportionalRing() {
	if (ring) ring.visible = false;
	anchorState = null;
}

// live radius while the row scrubs (or anything else writes the store mid-show).
// Declared BELOW `ring`/`anchorState`/place — the callback runs synchronously at
// module eval (the store-subscriber TDZ gotcha).
proportionalRadius.subscribe(() => {
	if (ring && ring.visible && anchorState) place();
});
