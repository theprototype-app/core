// @ts-check
// Roadmap 99 K8 (lane 99-newops): the BISECT tool's plane — the LAZY half. meshBisectTool.js (boot) owns
// everything that must answer at once: the rubber band, Esc / Enter, cancelling; this chunk (loaded when Bisect is
// armed) places the plane, drives it with the gizmo and applies the cut. Armed from the toolbox (faceEditOp 'bisect'):
//   1. two clicks on the viewport draw the cut LINE (the first starts a rubber band, the second ends it — two
//      clicks and not a held drag, because a left drag orbits the camera; touch taps the same two points);
//   2. the line becomes a PLANE through it and the eye (perspective) or the view direction (orthographic), shown
//      as a translucent square on the object with a tick on its OUTER side, and the shared gizmo seats on it
//      (move / rotate, the app's transform mode) to adjust it before anything is cut;
//   3. Apply (the pane's button, Enter) cuts the selection — or the whole mesh — through faceEdit.commitBisect,
//      with the pane's Fill / Clear options; Esc, another tool or leaving the session drops it.
// Nothing here edits geometry, records history or sends a message: only the commit does. The plane square is a
// SCENE-ROOT helper (never inside the replicated, serialized tree) whose raycast is stubbed, so it never swallows
// a pick (the meshPivot marker recipe).

import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalCamera, globalScene, TControls, transformMode } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { canvasRect } from './canvasRect';
import { faceEditObject, setFaceOp, commitBisect, lookupEditable } from './faceEdit';
import { bisectFill, bisectClear } from './meshToolParams';

import { bisectPlaced } from './meshBisectTool';

/** @type {any} */ let proxy = null;
/** @type {string | null} */ let proxyFor = null;

/** the client-pixel point -> a world point at the depth of `anchor` @param {number[]} px @param {any} camera @param {any} anchor */
function unproject(px, camera, anchor) {
	const rect = canvasRect();
	const ndcZ = anchor.clone().project(camera).z;
	return new THREE.Vector3(((px[0] - rect.left) / rect.width) * 2 - 1, -((px[1] - rect.top) / rect.height) * 2 + 1, ndcZ).unproject(camera);
}

/** the edited object, or null @returns {any} */
function edited() {
	const uuid = get(faceEditObject);
	return uuid ? lookupEditable(uuid) : null;
}

/**
 * The second click: the line from..to becomes the plane (the shim drew the band and handles the keys).
 * @param {number[]} from @param {number[]} to client pixels @returns {boolean}
 */
export function finishLine(from, to) {
	const object = edited();
	if (!object) return false;
	return placePlane(object, from, to);
}

/**
 * The plane through the screen line a-b: it holds the line and the view ray, so it looks edge-on — the cut is
 * exactly the line drawn. The square sits on the object (centred on the plane point nearest its centre).
 * @param {any} object @param {number[]} a @param {number[]} b @returns {boolean}
 */
function placePlane(object, a, b) {
	/** @type {any} */
	const camera = get(globalCamera);
	/** @type {any} */
	const scene = get(globalScene);
	if (!camera || !scene) return false;
	object.updateMatrixWorld(true);
	if (!object.geometry.boundingSphere) object.geometry.computeBoundingSphere();
	const sphere = object.geometry.boundingSphere.clone().applyMatrix4(object.matrixWorld);
	const pa = unproject(a, camera, sphere.center);
	const pb = unproject(b, camera, sphere.center);
	const along = pb.clone().sub(pa);
	const view = camera.isOrthographicCamera
		? camera.getWorldDirection(new THREE.Vector3())
		: pa.clone().sub(camera.getWorldPosition(new THREE.Vector3()));
	const normal = along.clone().cross(view).normalize();
	if (normal.lengthSq() < 0.5) return false;
	const centre = sphere.center.clone().sub(normal.clone().multiplyScalar(sphere.center.clone().sub(pa).dot(normal)));
	ensureProxy(scene, Math.max(sphere.radius * 2.4, 0.05));
	proxy.position.copy(centre);
	proxy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
	proxy.scale.setScalar(1);
	proxyFor = object.uuid;
	seatGizmo();
	bisectPlaced.set(true);
	showToast('Bisect: drag the gizmo to adjust the plane, then Apply (Enter) — Esc cancels');
	return true;
}

/** @param {any} scene @param {number} size */
function ensureProxy(scene, size) {
	if (!proxy) {
		proxy = new THREE.Group();
		proxy.name = 'mesh-bisect-plane';
		proxy.userData.isBisectProxy = true;
		// tokens-ok-begin: three.js materials (meshes cannot read CSS var()); the edit overlays' orange
		const sheet = new THREE.Mesh(
			new THREE.PlaneGeometry(1, 1),
			new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false })
		);
		const rim = new THREE.LineSegments(
			new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
			new THREE.LineBasicMaterial({ color: 0xff7a1a })
		);
		// the OUTER side's tick (+normal): "clear outer" removes what it points at
		const tick = new THREE.Line(
			new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 0.25)]),
			new THREE.LineBasicMaterial({ color: 0xff7a1a })
		);
		// tokens-ok-end
		for (const part of [sheet, rim, tick]) {
			part.raycast = () => {};
			part.renderOrder = 999;
			proxy.add(part);
		}
		proxy.userData.parts = { sheet, rim, tick };
	}
	const { sheet, rim, tick } = proxy.userData.parts;
	sheet.scale.set(size, size, 1);
	rim.scale.set(size, size, 1);
	tick.scale.setScalar(size);
	if (proxy.parent !== scene) scene.add(proxy);
	proxy.visible = true;
}

function seatGizmo() {
	/** @type {any} */
	const controls = get(TControls);
	if (!controls || !proxy) return;
	const mode = get(transformMode);
	controls.setMode(mode === 'scale' ? 'translate' : mode); // a plane has no size to scale
	controls.setSpace?.('local');
	controls.attach(proxy);
}

/** the gizmo moved the plane (Scene's onchange for the proxy): nothing to recompute, the square IS the preview */
export function onBisectPlaneMoved() {
	if (proxy) proxy.scale.setScalar(1);
}

/** Apply: cut with the plane as placed. @returns {boolean} */
export function applyBisect() {
	const object = edited();
	if (!object || !proxy || proxyFor !== object.uuid) {
		showToast('Bisect: draw the cut line first (two clicks)');
		return false;
	}
	object.updateMatrixWorld(true);
	const worldNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(proxy.getWorldQuaternion(new THREE.Quaternion()));
	const worldPoint = proxy.getWorldPosition(new THREE.Vector3());
	const point = object.worldToLocal(worldPoint.clone());
	// a normal goes to local space by the TRANSPOSE of the world matrix (right under non-uniform scale)
	const normal = worldNormal.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(object.matrixWorld).transpose()).normalize();
	const clear = get(bisectClear);
	const ok = commitBisect(
		{ point: [point.x, point.y, point.z], normal: [normal.x, normal.y, normal.z] },
		{ clear: clear === 'inner' || clear === 'outer' ? clear : null, fill: get(bisectFill) }
	);
	if (ok) {
		dropPlane();
		setFaceOp('move'); // a one-shot tool, like the knife
	}
	return ok;
}

/** forget the plane (the gizmo leaves it); the shim calls it on cancel */
export function dropPlane() {
	/** @type {any} */
	const controls = get(TControls);
	if (proxy && controls?.object === proxy) controls.detach();
	if (proxy) {
		proxy.visible = false;
		proxy.parent?.remove(proxy);
	}
	proxyFor = null;
	if (get(bisectPlaced)) bisectPlaced.set(false);
}

