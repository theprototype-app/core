import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { RectAreaLightHelper } from 'three/addons/helpers/RectAreaLightHelper.js';
import { globalScene, objectsGroup } from '../stores/sceneStore';
// 24-E2: helpers + proxies live on the helper layer (the editor camera enables it)
import { markHelper } from './helperLayer';

// Makes lights visible and draggable: a type-specific helper plus a small
// wireframe "bulb" pick proxy per light. Helpers and proxies live at the
// SCENE ROOT (never inside objectsGroup or parented to the light) so they
// stay out of GLTF saves and the peer object sync. Proxies carry the light's
// uuid; Scene.svelte routes clicks on them to selectObject(lightUuid).

export const showLightHelpers = writable(
	typeof localStorage === 'undefined' || localStorage.getItem('showLightHelpers') !== 'false'
);
/** 24-E1: how far along its forward a directional/spot light's target sits (the
 * helper's line length; display only — the direction is what shadows read, and the
 * distance changes nothing for either light type). LOCAL pref, Settings ▸ Scene. */
export const lightHelperLength = writable(
	typeof localStorage === 'undefined' ? 2 : Math.max(0.2, Number(localStorage.getItem('lightHelperLength')) || 2)
);
lightHelperLength.subscribe((value) => {
	if (typeof localStorage !== 'undefined') localStorage.setItem('lightHelperLength', String(value));
});
const forward = new THREE.Vector3();
const worldQuat = new THREE.Quaternion();

/**
 * 24-E1: the ONE-TIME migration of the old spot model. A spot used to persist an aim
 * point (`userData.spotTarget`) enforced per frame; under the rotation model the same
 * numbers become a `lookAt` once and the key goes. Runs on every peer for every spot
 * that still carries it (sessions, prefabs, `.tpscene` files, an older peer's object
 * sync) — the rotation is derived from the same numbers everywhere, so no format bump
 * and no message. @param {any} light @returns {boolean} migrated
 */
export function migrateSpotTarget(light) {
	if (!light?.isSpotLight || !Array.isArray(light.userData?.spotTarget)) return false;
	const point = new THREE.Vector3().fromArray(light.userData.spotTarget.map(Number));
	delete light.userData.spotTarget;
	light.updateMatrixWorld?.(true);
	light.lookAt(point);
	light.updateMatrixWorld?.(true);
	return true;
}
/** the proxies group, registered for Scene raycasts */
/** @type {import('svelte/store').Writable<any>} */
export const lightProxiesGroup = writable(null);

/** @type {Map<string, {light: any, helper: any, proxy: any}>} */
const entries = new Map();
/** @type {any} */ let proxyRoot = null;
let visible = true;
let started = false;
const tempVector = new THREE.Vector3();

/** @param {any} light */
function helperFor(light) {
	if (light.isPointLight) return new THREE.PointLightHelper(light, 0.4);
	if (light.isDirectionalLight) return new THREE.DirectionalLightHelper(light, 0.6);
	if (light.isSpotLight) return new THREE.SpotLightHelper(light);
	if (light.isHemisphereLight) return new THREE.HemisphereLightHelper(light, 0.4);
	if (light.isRectAreaLight) return new RectAreaLightHelper(light);
	return null; // AmbientLight: pick proxy only
}

function applyVisibility() {
	entries.forEach((entry) => {
		if (entry.helper) entry.helper.visible = visible;
		entry.proxy.visible = visible;
	});
}

function sync() {
	const scene = get(globalScene);
	const group = get(objectsGroup);
	if (!scene || !group) return;
	if (!proxyRoot) {
		proxyRoot = new THREE.Group();
		proxyRoot.name = 'light-proxies';
		scene.add(proxyRoot);
		lightProxiesGroup.set(proxyRoot);
	}
	/** @type {any[]} */
	const lights = [];
	group.traverse((/** @type {any} */ object) => {
		if (object.isLight) lights.push(object);
	});

	lights.forEach((light) => {
		migrateSpotTarget(light); // 24-E1: an old spot aims by rotation from here on
		if (entries.has(light.uuid)) return;
		const helper = helperFor(light);
		if (helper) scene.add(markHelper(helper));
		const proxy = new THREE.Mesh(
			new THREE.SphereGeometry(0.18, 10, 8),
			new THREE.MeshBasicMaterial({ color: 0xffd54a, wireframe: true })
		);
		markHelper(proxy);
		proxy.name = 'light-proxy';
		proxy.userData.lightUuid = light.uuid;
		proxyRoot.add(proxy);
		entries.set(light.uuid, { light, helper, proxy });
	});

	[...entries.entries()].forEach(([uuid, entry]) => {
		if (lights.some((light) => light.uuid === uuid)) return;
		if (entry.helper) {
			scene.remove(entry.helper);
			entry.helper.dispose?.();
		}
		proxyRoot.remove(entry.proxy);
		entry.proxy.geometry.dispose();
		entry.proxy.material.dispose();
		entries.delete(uuid);
	});
	applyVisibility();
}

/** Per-frame from Scene's useTask: follow lights, refresh helpers */
export function updateLightHelpers() {
	if (entries.size === 0) return;
	const scene = get(globalScene);
	const length = get(lightHelperLength);
	entries.forEach((entry) => {
		const light = entry.light;
		// 24-E1: DIRECTION FROM ROTATION. A directional/spot light shines from its
		// position toward `light.target`, a detached Object3D nobody moved — every
		// directional light pointed at the world origin and rotating it changed nothing
		// (reported). The target now rides the light's own forward (-Z, the camera
		// convention `lookAt` shares) at the helper length, on the scene ROOT (golden
		// rule 5 — never objectsGroup), so the rotate gizmo aims the light and the shadow
		// camera (it reads `target.matrixWorld`) follows. Runs whether or not helpers
		// are visible: shadows need it either way.
		if (light.isDirectionalLight || light.isSpotLight) {
			if (light.userData.spotTarget) migrateSpotTarget(light);
			if (!light.target.parent && scene) scene.add(light.target);
			light.getWorldPosition(tempVector);
			light.getWorldQuaternion(worldQuat);
			forward.set(0, 0, -1).applyQuaternion(worldQuat).multiplyScalar(length);
			light.target.position.copy(tempVector).add(forward);
			light.target.updateMatrixWorld(true);
		}
		if (!visible) return;
		light.getWorldPosition(tempVector);
		entry.proxy.position.copy(tempVector);
		entry.helper?.update?.();
	});
}

/** @type {any} */ let syncTimer = null;

export function startLightHelpers() {
	if (started || typeof window === 'undefined') return;
	started = true;
	objectsGroup.subscribe(() => {
		clearTimeout(syncTimer);
		syncTimer = setTimeout(sync, 100);
	});
	showLightHelpers.subscribe((value) => {
		visible = value;
		localStorage.setItem('showLightHelpers', String(value));
		applyVisibility();
	});
}
