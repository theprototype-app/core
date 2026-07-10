import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { RectAreaLightHelper } from 'three/examples/jsm/helpers/RectAreaLightHelper.js';
import { globalScene, objectsGroup } from '../stores/sceneStore';

// Makes lights visible and draggable: a type-specific helper plus a small
// wireframe "bulb" pick proxy per light. Helpers and proxies live at the
// SCENE ROOT (never inside objectsGroup or parented to the light) so they
// stay out of GLTF saves and the peer object sync. Proxies carry the light's
// uuid; Scene.svelte routes clicks on them to selectObject(lightUuid).

export const showLightHelpers = writable(
	typeof localStorage === 'undefined' || localStorage.getItem('showLightHelpers') !== 'false'
);
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
		if (entries.has(light.uuid)) return;
		const helper = helperFor(light);
		if (helper) scene.add(helper);
		const proxy = new THREE.Mesh(
			new THREE.SphereGeometry(0.18, 10, 8),
			new THREE.MeshBasicMaterial({ color: 0xffd54a, wireframe: true })
		);
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
	entries.forEach((entry) => {
		// spot aim (79): userData.spotTarget survives sync — enforce it here so
		// late joiners aim correctly without touching the legacy object loader
		if (entry.light.isSpotLight && entry.light.userData.spotTarget) {
			if (!entry.light.target.parent && scene) scene.add(entry.light.target);
			entry.light.target.position.fromArray(entry.light.userData.spotTarget);
		}
		if (!visible) return;
		entry.light.getWorldPosition(tempVector);
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
