// Roadmap 55 A5 — THE AGENT'S EYES. `tpAgent.screenshot({view, uuid, size, grid})` renders one clean
// frame of the shared scene from a TEMPORARY camera and returns a PNG data URL.
//
// Three promises, and how each is kept:
//   · NO PERSON'S VIEW MOVES. The frame goes into an offscreen render target with a camera made for
//     this call; the canvas, the editor camera and its controls are never written. (The checkpoint /
//     gallery thumbnails draw on the live canvas and read it back; an agent may call this often, on
//     a page someone is looking at, so it must not borrow the canvas even for one frame.)
//   · A CLEAN FRAME. A fresh camera sees layer 0 only, so the helper layer (lights, colliders,
//     cameras' frustums) is out by construction; the gizmo and the named editor overlays (grid,
//     edit wireframes, handles — the water pre-pass's list, `isEditorHelper`) are hidden for this one
//     render and put back in `finally`; the selection outline is a post pass, never in the scene.
//   · NULL WHERE THERE IS NOTHING TO SHOW: in VR (the headset owns the renderer) or before the app
//     has a renderer.
//
// The target holds LINEAR light (three converts only when drawing to the canvas), so the readback is
// converted with the renderer's own tone mapping + exposure — screenshotCore.js.

import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalRenderer, globalScene, globalCamera, objectsGroup, TControls } from '../../stores/sceneStore';
import { isEditorHelper } from '$lib/water/waterRuntime.js';
import { normalizeView, clampSize, frameSize, viewPose, boundsOf, linearFrameToSrgb } from './screenshotCore.js';

/** supersampling factor (the target is not multisampled: an MSAA target reads back as zeros) */
const SUPERSAMPLE = 2;
/** the target's largest side, whatever the request */
const TARGET_CAP = 4096;

/** where the last screenshot looked from — A7's "AI camera marker" reads it @type {{position: number[], target: number[], view: string, at: number} | null} */
export let lastShot = null;

/** @param {any} renderer */
function toneMappingName(renderer) {
	const tm = renderer?.toneMapping;
	if (tm === THREE.NoToneMapping || tm == null) return 'none';
	if (tm === THREE.LinearToneMapping) return 'linear';
	// ACES, and the HDRI curves (AgX, Neutral) — close enough for an agent's look
	return 'aces';
}

/** @param {any} object @returns {{min: number[], max: number[]} | null} */
function boxOf(object) {
	if (!object) return null;
	const box = new THREE.Box3();
	object.updateWorldMatrix?.(true, true);
	object.traverse((/** @type {any} */ n) => {
		if (n === object && !n.isMesh) return;
		if (!n.visible || isEditorHelper(n)) return;
		if (n.isMesh || n.isLine || n.isPoints || n.isSprite) box.expandByObject(n, true);
	});
	if (box.isEmpty()) {
		// a light or an empty group: its position is still somewhere worth looking at
		const p = new THREE.Vector3();
		object.getWorldPosition(p);
		if (object === get(objectsGroup)) return null;
		box.setFromCenterAndSize(p, new THREE.Vector3(1, 1, 1));
	}
	return { min: box.min.toArray(), max: box.max.toArray() };
}

/** @param {any} scene @param {any} renderer */
function hideHelpers(scene, renderer, keepGrid = false) {
	/** @type {any[]} */
	const hidden = [];
	const tc = /** @type {any} */ (get(TControls));
	const gizmo = tc?.getHelper?.() ?? tc;
	if (gizmo?.visible) {
		gizmo.visible = false;
		hidden.push(gizmo);
	}
	scene.traverse((/** @type {any} */ n) => {
		if (!n.visible || n === scene) return;
		if (keepGrid && n.name === 'editor-grid') return;
		if (isEditorHelper(n) || n.isTransformControlsRoot || n.isTransformControlsGizmo || n.isTransformControlsPlane) {
			n.visible = false;
			hidden.push(n);
		}
	});
	void renderer;
	return () => {
		for (const n of hidden) n.visible = true;
	};
}

/**
 * @param {import('./contract.js').TpAgentScreenshotOptions} [opts]
 * @returns {Promise<string|null>} a `data:image/png;base64,…` URL
 */
export async function takeScreenshot(opts = {}) {
	/** @type {any} */
	const renderer = get(globalRenderer);
	/** @type {any} */
	const scene = get(globalScene);
	/** @type {any} */
	const userCamera = get(globalCamera);
	const group = get(objectsGroup);
	if (!renderer || !scene || renderer.xr?.isPresenting) return null;
	const view = normalizeView(opts.view);
	const size = clampSize(opts.size);
	const canvas = renderer.domElement;
	const aspect = canvas?.width && canvas?.height ? canvas.width / canvas.height : 16 / 9;
	const { w, h } = frameSize(size, aspect);

	const fov = Number(userCamera?.fov) || 50;
	const camera = new THREE.PerspectiveCamera(fov, w / h, 0.05, 2000);
	if (view === 'current') {
		if (!userCamera) return null;
		userCamera.updateMatrixWorld?.();
		camera.position.setFromMatrixPosition(userCamera.matrixWorld);
		camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().extractRotation(userCamera.matrixWorld));
		camera.near = userCamera.near ?? 0.05;
		camera.far = userCamera.far ?? 2000;
	} else {
		let subject = group;
		if (view === 'focus') {
			subject = opts.uuid ? group?.getObjectByProperty?.('uuid', String(opts.uuid)) : null;
			if (!subject) throw new Error('focus needs the uuid of an object in the scene');
		}
		const pose = viewPose(view, boundsOf(boxOf(subject)), fov, w / h);
		camera.position.fromArray(pose.position);
		camera.up.fromArray(pose.up);
		camera.lookAt(new THREE.Vector3().fromArray(pose.target));
		camera.near = pose.near;
		camera.far = pose.far;
	}
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld();
	// layer 0 only: the helper layer is never in this camera's frame

	const scale = Math.min(SUPERSAMPLE, TARGET_CAP / Math.max(w, h));
	const rw = Math.max(1, Math.round(w * scale));
	const rh = Math.max(1, Math.round(h * scale));
	const float = !!renderer.extensions?.has?.('EXT_color_buffer_float');
	const target = new THREE.WebGLRenderTarget(rw, rh, {
		type: float ? THREE.FloatType : THREE.UnsignedByteType,
		depthBuffer: true
	});
	const restore = hideHelpers(scene, renderer, !!opts.grid);
	const previous = renderer.getRenderTarget();
	const autoClear = renderer.autoClear;
	/** @type {Float32Array|Uint8Array} */
	const pixels = float ? new Float32Array(rw * rh * 4) : new Uint8Array(rw * rh * 4);
	try {
		renderer.autoClear = true;
		renderer.setRenderTarget(target);
		renderer.clear();
		renderer.render(scene, camera);
		renderer.readRenderTargetPixels(target, 0, 0, rw, rh, pixels);
	} finally {
		renderer.setRenderTarget(previous);
		renderer.autoClear = autoClear;
		restore();
		target.dispose();
	}
	const rgba = linearFrameToSrgb(pixels, rw, rh, {
		toneMapping: /** @type {any} */ (toneMappingName(renderer)),
		exposure: Number(renderer.toneMappingExposure) || 1,
		bytes: !float
	});
	const big = document.createElement('canvas');
	big.width = rw;
	big.height = rh;
	big.getContext('2d')?.putImageData(new ImageData(/** @type {Uint8ClampedArray<ArrayBuffer>} */ (rgba), rw, rh), 0, 0);
	const out = document.createElement('canvas');
	out.width = w;
	out.height = h;
	const ctx = out.getContext('2d');
	if (!ctx) return null;
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(big, 0, 0, w, h);
	lastShot = {
		position: camera.position.toArray(),
		target: camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(5).add(camera.position).toArray(),
		view,
		at: Date.now()
	};
	return out.toDataURL('image/png');
}
