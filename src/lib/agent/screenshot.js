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
import { planShot, viewPose, boundsOf, linearFrameToSrgb } from './screenshotCore.js';
import { postState, renderWithPost } from './postShot.js';
// 55 A7 (union): every peer draws the "AI" camera marker where this shot looked (agentLog is store-only)
import { noteAgentView } from '$lib/agentLog';

/** supersampling factor (the target is not multisampled: an MSAA target reads back as zeros) */
const SUPERSAMPLE = 2;
/** the target's largest side, whatever the request */
const TARGET_CAP = 4096;

/** what the last screenshot used, or why it could not be taken @type {any} */
export let lastShot = null;

/** @param {any[]} objects @returns {{min: number[], max: number[]} | null} one box around them all */
function boxOfAll(objects) {
	const boxes = objects.map(boxOf).filter((b) => !!b);
	if (!boxes.length) return null;
	return {
		min: [0, 1, 2].map((i) => Math.min(...boxes.map((b) => /** @type {any} */ (b).min[i]))),
		max: [0, 1, 2].map((i) => Math.max(...boxes.map((b) => /** @type {any} */ (b).max[i])))
	};
}

/** @param {string} why @returns {never} */
function refuse(why) {
	lastShot = { error: why, at: Date.now() };
	throw new Error(why);
}

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
	lastShot = null;
	if (!renderer || !scene || renderer.xr?.isPresenting) return null;
	const canvas = renderer.domElement;
	const plan = planShot(opts, canvas?.width && canvas?.height ? canvas.width / canvas.height : 16 / 9);
	if (plan.problem !== null) return refuse(plan.problem);
	const { w, h, view } = plan;

	const fov = Number(userCamera?.fov) || 50;
	const camera = new THREE.PerspectiveCamera(fov, w / h, 0.05, 2000);
	/** @type {number[] | null} */
	let aimedAt = null;
	/** @type {{kind: string, uuids?: string[], names?: string[]}} */
	let subject = { kind: 'none' };
	if (plan.free) {
		camera.position.fromArray(plan.free.position);
		// a straight-up or straight-down look has no "up" of its own
		const look = new THREE.Vector3().fromArray(plan.free.target).sub(camera.position).normalize();
		if (Math.abs(look.y) > 0.999) camera.up.set(0, 0, look.y < 0 ? -1 : 1);
		camera.lookAt(new THREE.Vector3().fromArray(plan.free.target));
		camera.zoom = plan.zoom;
		aimedAt = plan.free.target;
	} else if (plan.current) {
		if (!userCamera) return null;
		userCamera.updateMatrixWorld?.();
		camera.position.setFromMatrixPosition(userCamera.matrixWorld);
		camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().extractRotation(userCamera.matrixWorld));
		camera.near = userCamera.near ?? 0.05;
		camera.far = userCamera.far ?? 2000;
		camera.zoom = plan.zoom;
		subject = { kind: 'what the person sees' };
	} else {
		let objects = group ? [group] : [];
		subject = { kind: 'scene' };
		if (plan.uuids.length) {
			objects = plan.uuids.map((uuid) => group?.getObjectByProperty?.('uuid', uuid));
			const gone = plan.uuids.filter((_, i) => !objects[i]);
			if (gone.length) return refuse('not in the scene: ' + gone.join(', '));
			subject = { kind: 'objects', uuids: plan.uuids, names: objects.map((o) => String(o.name ?? '')) };
		}
		const pose = viewPose(/** @type {any} */ (view), boundsOf(boxOfAll(objects)), fov, w / h, plan.margin, plan.dir, plan.zoom);
		camera.position.fromArray(pose.position);
		camera.up.fromArray(pose.up);
		camera.lookAt(new THREE.Vector3().fromArray(pose.target));
		camera.near = pose.near;
		camera.far = pose.far;
		aimedAt = pose.target;
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
	let pixels = float ? new Float32Array(rw * rh * 4) : new Uint8Array(rw * rh * 4);
	let bytes = !float;
	// mcp-diorama2 (item 7): through the post stack this tab draws, when asked and when it draws one
	/** @type {{postEffects: 'applied' | 'unavailable', reason?: string, detail?: string, how?: string | null} | null} */
	let post = null;
	try {
		const wanted = /** @type {any} */ (opts).postEffects === true ? postState() : null;
		if (wanted && !wanted.live) post = { postEffects: 'unavailable', reason: /** @type {string} */ (wanted.reason), detail: wanted.detail ?? undefined, how: wanted.how };
		if (wanted?.live) {
			const shot = await renderWithPost(renderer, scene, camera, rw, rh, wanted.entries);
			if ('error' in shot) post = { postEffects: 'unavailable', reason: 'render failed', detail: shot.error, how: null };
			else {
				pixels = shot.pixels;
				bytes = !shot.float;
				post = { postEffects: 'applied', detail: wanted.entries.map((/** @type {any} */ e) => e.kind).join(', ') };
			}
		}
		if (post?.postEffects !== 'applied') {
			renderer.autoClear = true;
			renderer.setRenderTarget(target);
			renderer.clear();
			renderer.render(scene, camera);
			renderer.readRenderTargetPixels(target, 0, 0, rw, rh, pixels);
		}
	} finally {
		renderer.setRenderTarget(previous);
		renderer.autoClear = autoClear;
		restore();
		target.dispose();
	}
	const rgba = linearFrameToSrgb(pixels, rw, rh, {
		toneMapping: /** @type {any} */ (toneMappingName(renderer)),
		exposure: Number(renderer.toneMappingExposure) || 1,
		bytes
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
		target: aimedAt ?? camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(5).add(camera.position).toArray(),
		fov,
		zoom: camera.zoom,
		width: w,
		height: h,
		view,
		subject,
		...(post ?? {}),
		at: Date.now()
	};
	// 56 C8: a PERSON's "ask about this selection" picture is not where an agent looked
	if (!(/** @type {any} */ (opts).quiet)) noteAgentView(camera);
	return out.toDataURL('image/png');
}
