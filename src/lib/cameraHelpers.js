// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { globalScene, objectsGroup } from '../stores/sceneStore';
import { isCameraObject, cameraSpec, aspectRatio } from './cameraObjects';
import { wireframeActive } from './viewMode';

// 16-P5: frustum visualization for camera OBJECTS — the colliderHelpers pattern.
// One wireframe frustum per camera object, built from `userData.camera` and
// living at the SCENE ROOT (never in objectsGroup) so it stays out of GLTF saves
// and peer sync; it follows its marker per frame from Scene's useTask.
//
// ON by default (the user's call): a camera you cannot see the aim of is not
// much of a camera. `showCameraFrustums` is a LOCAL pref for turning it off.

export const showCameraFrustums = writable(
	typeof localStorage === 'undefined' || localStorage.getItem('showCameraFrustums') !== 'false'
);

/** the camera currently PREVIEWED — its own frustum is pointless (you're inside it)
 * @type {import('svelte/store').Writable<string|null>} */
export const frustumSuppressed = writable(null);

/** @type {Map<string, {object: any, group: any, key: string}>} */
const entries = new Map();
/** @type {any} */ let proxyRoot = null;
let started = false;

const FRUSTUM_COLOR = 0x8ab4f8; // cool blue — distinct from collider green/amber
/** how far down the view direction the drawn frustum reaches (NOT `far`: a 1000
 *  unit box would swallow the scene) */
const DRAW_DEPTH = 3;

/** stable identity of what's drawn — rebuild only when the SHAPE changes
 * @param {any} spec */
function keyOf(spec) {
	return [spec.kind, spec.fov, spec.orthoSize, spec.aspect].join('|');
}

/** Wireframe frustum for one camera spec, in the marker's local frame
 * (-Z forward, matching three's camera convention). @param {any} spec */
function buildFrustum(spec) {
	const ratio = aspectRatio(spec.aspect) || 16 / 9;
	let halfH;
	let halfHNear;
	if (spec.kind === 'orthographic') {
		halfH = Math.max(0.05, spec.orthoSize);
		halfHNear = halfH; // ortho: parallel sides
	} else {
		halfH = Math.tan((Math.max(1, spec.fov) * Math.PI) / 360) * DRAW_DEPTH;
		halfHNear = 0;
	}
	const halfW = halfH * ratio;
	const halfWNear = halfHNear * ratio;
	const z = -DRAW_DEPTH;
	// near rect (at the origin for perspective), far rect, and the four edges
	const points = [
		// far rectangle
		[-halfW, -halfH, z], [halfW, -halfH, z],
		[halfW, -halfH, z], [halfW, halfH, z],
		[halfW, halfH, z], [-halfW, halfH, z],
		[-halfW, halfH, z], [-halfW, -halfH, z],
		// connecting edges from the near rect
		[-halfWNear, -halfHNear, 0], [-halfW, -halfH, z],
		[halfWNear, -halfHNear, 0], [halfW, -halfH, z],
		[halfWNear, halfHNear, 0], [halfW, halfH, z],
		[-halfWNear, halfHNear, 0], [-halfW, halfH, z]
	];
	if (spec.kind === 'orthographic')
		points.push(
			[-halfWNear, -halfHNear, 0], [halfWNear, -halfHNear, 0],
			[halfWNear, -halfHNear, 0], [halfWNear, halfHNear, 0],
			[halfWNear, halfHNear, 0], [-halfWNear, halfHNear, 0],
			[-halfWNear, halfHNear, 0], [-halfWNear, -halfHNear, 0]
		);
	// an "up" tick on the far rect so roll is readable
	points.push([-halfW * 0.35, halfH, z], [0, halfH * 1.35, z], [0, halfH * 1.35, z], [halfW * 0.35, halfH, z]);

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute(
		'position',
		new THREE.Float32BufferAttribute(points.flat(), 3)
	);
	const lines = new THREE.LineSegments(
		geometry,
		new THREE.LineBasicMaterial({ color: FRUSTUM_COLOR, transparent: true, opacity: 0.75 })
	);
	lines.name = 'camera-frustum';
	lines.raycast = () => {}; // never pickable
	return lines;
}

/** @param {string} uuid @param {any} entry */
function disposeEntry(uuid, entry) {
	entry.group.geometry?.dispose?.();
	entry.group.material?.dispose?.();
	proxyRoot?.remove(entry.group);
	entries.delete(uuid);
}

function sync() {
	const scene = get(globalScene);
	const group = get(objectsGroup);
	if (!scene || !group) return;
	if (!proxyRoot) {
		proxyRoot = new THREE.Group();
		proxyRoot.name = 'camera-frustums';
		scene.add(proxyRoot);
	}
	/** @type {Set<string>} */
	const tracked = new Set();
	if (get(showCameraFrustums))
		group.traverse((/** @type {any} */ node) => {
			if (isCameraObject(node)) tracked.add(node.uuid);
		});
	tracked.forEach((uuid) => {
		const object = group.getObjectByProperty('uuid', uuid);
		if (!object) return;
		const spec = cameraSpec(object);
		const key = keyOf(spec);
		const existing = entries.get(uuid);
		if (existing && existing.key === key) {
			existing.object = object; // survives a re-created object (undo/restore)
			return;
		}
		if (existing) disposeEntry(uuid, existing);
		const proxy = buildFrustum(spec);
		proxyRoot.add(proxy);
		entries.set(uuid, { object, group: proxy, key });
	});
	[...entries.entries()].forEach(([uuid, entry]) => {
		if (!tracked.has(uuid) || !group.getObjectByProperty('uuid', uuid)) disposeEntry(uuid, entry);
	});
}

const followPos = new THREE.Vector3();
const followQuat = new THREE.Quaternion();
const followScale = new THREE.Vector3();

/** Per-frame from Scene's useTask — each frustum rides its marker's world pose.
 *  Hidden in wireframe view mode (it would render as junk), and the previewed
 *  camera's own frustum is skipped (you are inside it). */
export function updateCameraHelpers() {
	if (!proxyRoot) return;
	proxyRoot.visible = entries.size > 0 && !wireframeActive();
	if (!proxyRoot.visible) return;
	const hidden = get(frustumSuppressed);
	entries.forEach((entry, uuid) => {
		entry.group.visible = uuid !== hidden;
		if (!entry.group.visible) return;
		entry.object.updateMatrixWorld();
		entry.object.matrixWorld.decompose(followPos, followQuat, followScale);
		entry.group.position.copy(followPos);
		entry.group.quaternion.copy(followQuat);
		entry.group.scale.copy(followScale);
	});
}

/** @type {any} */ let syncTimer = null;

export function startCameraHelpers() {
	if (started || typeof window === 'undefined') return;
	started = true;
	objectsGroup.subscribe(() => {
		clearTimeout(syncTimer);
		syncTimer = setTimeout(sync, 100);
	});
	showCameraFrustums.subscribe((value) => {
		try {
			localStorage.setItem('showCameraFrustums', String(value));
		} catch {}
		sync();
	});
}

/** test/debug view of the live frustum proxies */
export function cameraHelpersDebug() {
	return [...entries.entries()].map(([uuid, entry]) => ({
		uuid,
		key: entry.key,
		visible: !!proxyRoot?.visible && entry.group.visible,
		position: entry.group.position.toArray().map((/** @type {number} */ n) => Math.round(n * 100) / 100)
	}));
}
