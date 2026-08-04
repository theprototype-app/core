import { get } from 'svelte/store';
import * as THREE from 'three';
import { objectsGroup, globalCamera, orbitControls, globalRenderer, globalScene } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordEntry } from './history';
import { flyTo } from './objectActions';

// Scene CAMERA objects (16-P5). A camera is a normal replicated MARKER MESH
// (`/create Camera` / `/create CameraOrtho`, body from customGeometries) whose
// settings live on `userData.camera` — the same trick as userData.physics /
// particles / terrain, so replication, undo, sessions, autosave, prefabs and
// GLTF extras all work with ZERO new plumbing. Nothing here puts a real THREE
// camera in `objectsGroup`: the preview camera and the frustum viz are built
// FROM this data at the scene root, so they never enter GLTF sync.

export const DEFAULT_CAMERA = {
	/** 'perspective' | 'orthographic' */
	kind: 'perspective',
	/** vertical FOV in degrees (perspective) */
	fov: 50,
	/** half-height in world units (orthographic) */
	orthoSize: 5,
	near: 0.1,
	far: 1000,
	/** framing guide aspect: '16:9' | '4:3' | '1:1' | '2.39:1' | 'free' */
	aspect: '16:9',
	/** show the letterbox guide while previewing */
	guide: true
};

export const ASPECTS = ['16:9', '4:3', '1:1', '2.39:1', 'free'];

/** Numeric aspect for a preset ('free' = follow the viewport) @param {string} aspect */
export function aspectRatio(aspect) {
	if (aspect === '4:3') return 4 / 3;
	if (aspect === '1:1') return 1;
	if (aspect === '2.39:1') return 2.39;
	if (aspect === '16:9') return 16 / 9;
	return 0; // free
}

/** Is this object a camera marker? @param {any} object */
export function isCameraObject(object) {
	return !!object?.userData?.camera;
}

/** Settings for an object, defaults filled in. @param {any} object */
export function cameraSpec(object) {
	return { ...DEFAULT_CAMERA, ...(object?.userData?.camera ?? {}) };
}

/** Every camera object in the scene (top level or nested). */
export function listCameraObjects() {
	/** @type {any[]} */
	const found = [];
	get(objectsGroup)?.traverse((/** @type {any} */ node) => {
		if (isCameraObject(node)) found.push(node);
	});
	return found;
}

/** @param {string} uuid */
export function findCameraObject(uuid) {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', uuid);
	return isCameraObject(object) ? object : null;
}

/**
 * THE write path for camera settings — mirrors `setPhysicsFor` (CL-A): one props
 * history entry, one replicated `objectParameters` message, and a poke so the
 * viz + any live preview rebuild.
 * @param {string} uuid @param {Partial<typeof DEFAULT_CAMERA>} patch
 */
export function setCameraFor(uuid, patch) {
	const object = findCameraObject(uuid);
	if (!object) return null;
	const before = { ...cameraSpec(object) };
	const next = { ...before, ...patch };
	object.userData.camera = next;
	recordEntry({ kind: 'props', uuid, before: { camera: before }, after: { camera: next } });
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'objectParameters', parameter: 'camera', uuid, camera: next });
	// THREE trees are not reactive — poke so the list/viz/preview see it
	objectsGroup.update((value) => value);
	return next;
}

/** Applier for a remote `objectParameters` camera write. @param {any} data */
export function applyRemoteCamera(data) {
	const object = get(objectsGroup)?.getObjectByProperty('uuid', data.uuid);
	if (!object) return;
	object.userData.camera = { ...DEFAULT_CAMERA, ...(data.camera ?? {}) };
	objectsGroup.update((value) => value);
}

/** Build (or update) a real THREE camera from a marker. Used by preview + Capture.
 * @param {any} object @param {number} viewportAspect @param {any} [existing] */
export function buildCamera(object, viewportAspect, existing) {
	const spec = cameraSpec(object);
	const ratio = aspectRatio(spec.aspect) || viewportAspect || 16 / 9;
	/** @type {any} */
	let camera = existing;
	const wantOrtho = spec.kind === 'orthographic';
	if (!camera || camera.isOrthographicCamera !== wantOrtho) {
		camera = wantOrtho
			? new THREE.OrthographicCamera(-1, 1, 1, -1, spec.near, spec.far)
			: new THREE.PerspectiveCamera(spec.fov, ratio, spec.near, spec.far);
	}
	camera.near = spec.near;
	camera.far = spec.far;
	if (wantOrtho) {
		const halfH = Math.max(0.01, spec.orthoSize);
		const halfW = halfH * ratio;
		camera.left = -halfW;
		camera.right = halfW;
		camera.top = halfH;
		camera.bottom = -halfH;
	} else {
		camera.fov = spec.fov;
		camera.aspect = ratio;
	}
	camera.updateProjectionMatrix();
	syncCameraToObject(camera, object);
	return camera;
}

/** Put a camera exactly where the marker is (world space).
 * @param {any} camera @param {any} object */
export function syncCameraToObject(camera, object) {
	if (!camera || !object) return;
	object.updateWorldMatrix(true, false);
	object.matrixWorld.decompose(camera.position, camera.quaternion, new THREE.Vector3());
	camera.updateMatrixWorld();
}

/** Bake the CURRENT editor view into a camera marker (pose + lens). @param {string} uuid */
export function setCameraFromView(uuid) {
	const object = findCameraObject(uuid);
	/** @type {any} */
	const view = get(globalCamera);
	if (!object || !view) return;
	// the marker may be parented — convert the world pose into its parent frame
	const parent = object.parent;
	const position = view.position.clone();
	const quaternion = view.quaternion.clone();
	if (parent) {
		parent.updateWorldMatrix(true, false);
		const inverse = new THREE.Matrix4().copy(parent.matrixWorld).invert();
		position.applyMatrix4(inverse);
		const parentQuat = new THREE.Quaternion();
		parent.matrixWorld.decompose(new THREE.Vector3(), parentQuat, new THREE.Vector3());
		quaternion.premultiply(parentQuat.invert());
	}
	object.position.copy(position);
	object.quaternion.copy(quaternion);
	object.updateMatrix();
	/** @type {any} */
	const peer = get(peers);
	if (peer)
		peer.send({
			type: 'move',
			uuid,
			pos: object.position.toArray(),
			rot: object.rotation.toArray(),
			scale: object.scale.toArray()
		});
	if (typeof view.fov === 'number' && cameraSpec(object).kind === 'perspective')
		setCameraFor(uuid, { fov: Math.round(view.fov) });
	else objectsGroup.update((value) => value);
}

/**
 * Render ONE frame through a camera object and download it (no preview needed).
 * Renders into an offscreen target at the framing aspect, so the file matches
 * what the guide shows rather than the current window shape.
 * @param {string} uuid @param {number} [height] output height in px
 */
export function captureThroughCamera(uuid, height = 1080) {
	const object = findCameraObject(uuid);
	/** @type {any} */
	const renderer = get(globalRenderer);
	/** @type {any} */
	const scene = get(globalScene);
	if (!object || !renderer || !scene) return null;
	const spec = cameraSpec(object);
	const ratio = aspectRatio(spec.aspect) || renderer.domElement.width / renderer.domElement.height || 16 / 9;
	const width = Math.round(height * ratio);
	const camera = buildCamera(object, ratio);
	const target = new THREE.WebGLRenderTarget(width, height, {
		colorSpace: THREE.SRGBColorSpace
	});
	const previousTarget = renderer.getRenderTarget();
	renderer.setRenderTarget(target);
	renderer.render(scene, camera);
	renderer.setRenderTarget(previousTarget);
	const pixels = new Uint8Array(width * height * 4);
	renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
	target.dispose();

	// WebGL rows come bottom-up — flip into a canvas, then download
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d');
	if (!context) return null;
	const image = context.createImageData(width, height);
	const rowBytes = width * 4;
	for (let y = 0; y < height; y++) {
		const source = (height - 1 - y) * rowBytes;
		image.data.set(pixels.subarray(source, source + rowBytes), y * rowBytes);
	}
	context.putImageData(image, 0, 0);
	canvas.toBlob((blob) => {
		if (!blob) return;
		const link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		const name = (object.name || 'camera').replace(/\s+/g, '-');
		link.download = `${name}-${width}x${height}.png`;
		link.click();
		URL.revokeObjectURL(link.href);
	});
	showToast(`Captured ${width}×${height} through "${object.name || 'camera'}"`);
	return { width, height };
}

/** Fly the EDITOR camera to look through a marker (no mode change). @param {string} uuid */
export function alignViewToCamera(uuid) {
	const object = findCameraObject(uuid);
	if (!object) return;
	object.updateWorldMatrix(true, false);
	const position = new THREE.Vector3();
	const quaternion = new THREE.Quaternion();
	object.matrixWorld.decompose(position, quaternion, new THREE.Vector3());
	// orbit needs a TARGET: a point in front of the marker, at a sane distance
	const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
	const controls = /** @type {any} */ (get(orbitControls));
	const distance = controls?.target ? Math.max(2, position.distanceTo(controls.target)) : 6;
	flyTo(position.toArray(), position.clone().add(forward.multiplyScalar(distance)).toArray());
}
