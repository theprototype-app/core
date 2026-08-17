// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { objectsGroup, globalScene, globalCamera, globalRenderer } from '../stores/sceneStore';

// A dot for an object you can no longer see.
//
// R2 gave objects animated (or scaled) down to nothing a minimum-size CLICK
// target, and that was only half the fix: the target sits at the object's centre,
// while a user naturally clicks where the shape USED to be — which at any real zoom
// is nowhere near. The report came back unchanged: "still cannot select it from the
// viewport, only from the object list".
//
// So draw the target. Blender's answer to the same problem is the origin dot, which
// is always there and always clickable; this is that, shown only when an object has
// become too small to see. The dot is exactly what `sceneHits({tinyProxies:true})`
// picks, so what you aim at and what you hit are the same point.
//
// SCENE-ROOT and LOCAL: never a child of objectsGroup (golden rule 5 — it would
// enter GLTF sync and duplicate on connect), never replicated, never saved. The
// colliderHelpers / cameraHelpers pattern.

/** projected DIAMETER (css px) below which an object gets a dot — the same
 * threshold scenePick uses to decide an object needs a proxy hit */
const TINY_PX = 4;
const GROUP_NAME = 'tiny-object-markers';

/** @type {any} */
let points = null;
/** @type {any} */
let geometry = null;

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _centre = new THREE.Vector3();

/** Build (once) the scene-root Points layer. @param {any} scene */
function ensurePoints(scene) {
	if (points?.parent === scene) return points;
	geometry = new THREE.BufferGeometry();
	geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
	points = new THREE.Points(
		geometry,
		new THREE.PointsMaterial({
			size: 9,
			sizeAttenuation: false, // a screen-space dot: the object has no size left
			color: 0xffc46b,
			// NOT depthWrite:false-and-forget — these draw on top deliberately (the
			// object is invisible, so there is nothing to be occluded BY), and they
			// are excluded from the postprocessing passes by living at the scene root
			depthTest: false,
			transparent: true,
			opacity: 0.9
		})
	);
	points.name = GROUP_NAME;
	points.renderOrder = 998;
	points.frustumCulled = false;
	scene.add(points);
	return points;
}

/** Per-frame: one dot per top-level object that has become too small to see.
 * Cheap by construction — top-level objects only, and it early-outs when there
 * are none (the normal case). */
export function updateTinyMarkers() {
	/** @type {any} */
	const scene = get(globalScene);
	/** @type {any} */
	const group = get(objectsGroup);
	/** @type {any} */
	const camera = get(globalCamera);
	/** @type {any} */
	const renderer = get(globalRenderer);
	const height = renderer?.domElement?.clientHeight ?? 0;
	if (!scene || !group || !camera?.isPerspectiveCamera || !height) return;

	/** @type {number[]} */
	const spots = [];
	for (const child of group.children) {
		if (child.visible === false) continue;
		_box.setFromObject(child);
		if (_box.isEmpty()) continue;
		_box.getCenter(_centre);
		const distance = _centre.distanceTo(camera.position);
		if (!(distance > 0)) continue;
		const perPixel = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * distance) / height;
		if (!(perPixel > 0)) continue;
		_box.getSize(_size);
		if (Math.max(_size.x, _size.y, _size.z) / perPixel > TINY_PX) continue;
		spots.push(_centre.x, _centre.y, _centre.z);
	}

	if (!spots.length) {
		if (points) points.visible = false;
		return;
	}
	const layer = ensurePoints(scene);
	layer.visible = true;
	const attribute = geometry.getAttribute('position');
	if (attribute.count !== spots.length / 3) {
		geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(spots), 3));
	} else {
		attribute.array.set(spots);
		attribute.needsUpdate = true;
	}
	geometry.computeBoundingSphere();
}

/** Drop the layer (scene teardown). */
export function disposeTinyMarkers() {
	if (!points) return;
	points.parent?.remove(points);
	points.geometry?.dispose?.();
	points.material?.dispose?.();
	points = null;
	geometry = null;
}

/** test hook: how many dots are showing right now */
export function tinyMarkerCount() {
	if (!points?.visible) return 0;
	return points.geometry?.getAttribute('position')?.count ?? 0;
}
