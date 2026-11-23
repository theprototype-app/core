// @ts-check
// Roadmap 99 K8 (lane 99-newops): the BISECT tool's gesture — the LAZY half (meshBisectTool.js is the boot shim
// that holds the stores and loads this when Bisect is armed). Armed from the toolbox (faceEditOp 'bisect'):
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
import { faceEditObject, faceEditOp, setFaceOp, commitBisect, lookupEditable } from './faceEdit';
import { bisectFill, bisectClear } from './meshToolParams';

import { bisectPreview, bisectPlaced } from './meshBisectTool';

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
 * One click of the armed tool. @param {number[]} point client pixels
 * @returns {'started' | 'placed' | 'refused'}
 */
export function bisectClick(point) {
	const object = edited();
	if (!object) return 'refused';
	const pending = get(bisectPreview);
	if (!pending) {
		dropPlane();
		bisectPreview.set({ from: point, to: point });
		showToast('Bisect: click the other end of the cut line — Esc cancels');
		return 'started';
	}
	bisectPreview.set(null);
	if (Math.hypot(point[0] - pending.from[0], point[1] - pending.from[1]) < 6) {
		showToast('Bisect: draw a longer line across the mesh');
		return 'refused';
	}
	return placePlane(object, pending.from, point) ? 'placed' : 'refused';
}

/** the band follows the pointer @param {number[]} point */
export function bisectHover(point) {
	const pending = get(bisectPreview);
	if (pending) bisectPreview.set({ ...pending, to: point });
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

/** forget the line and the plane (the gizmo leaves it) */
function dropPlane() {
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

/** Cancel everything pending (Esc, another tool, the session ending). @returns {boolean} whether anything was */
export function cancelBisect() {
	const had = !!get(bisectPreview) || get(bisectPlaced);
	bisectPreview.set(null);
	dropPlane();
	return had;
}

/**
 * Esc belongs to a pending bisect before it belongs to the session (the knife's event-verdict rule).
 * @param {any} [event] @returns {boolean}
 */
export function escapeConsumedByBisect(event) {
	if (event?.defaultPrevented) return true;
	if (!cancelBisect()) return false;
	event?.preventDefault?.();
	return true;
}

/** Enter applies a placed plane. @param {KeyboardEvent} event @returns {boolean} consumed */
export function bisectKeyConsumed(event) {
	const marked = /** @type {any} */ (event);
	if (marked.__bisectKey || event.key !== 'Enter' || !get(bisectPlaced)) return false;
	marked.__bisectKey = true;
	event.preventDefault();
	applyBisect();
	return true;
}

/** Esc and Enter for a pending bisect, in the CAPTURE phase: it runs before the session's own Escape handlers
 * (faceEdit's window listener, the toolbox's), which already stand down on a `defaultPrevented` event (the
 * knife's rule) — so a pending cut eats one Escape and the next leaves the session. @param {KeyboardEvent} event */
function onKey(event) {
	const t = /** @type {any} */ (event.target);
	if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
	if (event.key === 'Escape') escapeConsumedByBisect(event);
	else bisectKeyConsumed(event);
}
if (typeof window !== 'undefined') window.addEventListener('keydown', onKey, true);

// the tool lives only while it is armed in a session (registered when this chunk first loads: before that
// nothing can be pending)
faceEditOp.subscribe((op) => {
	if (op !== 'bisect') cancelBisect();
});
faceEditObject.subscribe((uuid) => {
	if (!uuid) cancelBisect();
});
