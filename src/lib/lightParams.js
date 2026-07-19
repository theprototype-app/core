import { writable, get } from 'svelte/store';
import { objectsGroup, globalScene, globalRenderer } from '../stores/sceneStore';

// Light parameter registry (phase 79): type-specific settings the Inspector
// renders (color/intensity/visible are common rows it already has). Values
// apply straight onto the light; replication rides the existing full-object
// resend (`object` + override), which three serializes shadows into.

/** @typedef {{key: string, label: string, kind: 'slider'|'int'|'angle'|'bool', min?: number, max?: number, step?: number}} LightParamSpec */

/** @type {Record<string, LightParamSpec[]>} */
export const LIGHT_PARAMS = {
	PointLight: [
		{ key: 'distance', label: 'Distance', kind: 'slider', min: 0, max: 100, step: 0.5 },
		{ key: 'decay', label: 'Decay', kind: 'slider', min: 0, max: 5, step: 0.05 }
	],
	SpotLight: [
		{ key: 'distance', label: 'Distance', kind: 'slider', min: 0, max: 100, step: 0.5 },
		{ key: 'decay', label: 'Decay', kind: 'slider', min: 0, max: 5, step: 0.05 },
		{ key: 'angle', label: 'Angle', kind: 'angle', min: 0.02, max: Math.PI / 2, step: 0.01 },
		{ key: 'penumbra', label: 'Penumbra', kind: 'slider', min: 0, max: 1, step: 0.02 }
	],
	RectAreaLight: [
		{ key: 'width', label: 'Width', kind: 'slider', min: 0.1, max: 20, step: 0.1 },
		{ key: 'height', label: 'Height', kind: 'slider', min: 0.1, max: 20, step: 0.1 }
	]
};

/** shadow-capable types get the shadow rows */
export const SHADOW_TYPES = ['DirectionalLight', 'SpotLight', 'PointLight'];
export const SHADOW_SIZES = [512, 1024, 2048];

// global shadow quality (quiz: off/low/med/high cap) — a LOCAL render preference.
// 'off' disables the renderer shadow map entirely (V-1 perf escape hatch).
const QUALITY_CAPS = { off: 512, low: 512, medium: 1024, high: 2048 };
export const shadowQuality = writable(
	typeof localStorage !== 'undefined'
		? localStorage.getItem('shadowQuality') ?? 'high'
		: 'high'
);

/** the size a light's shadow map actually uses under the global cap
 * @param {number} wanted */
export function cappedShadowSize(wanted) {
	const cap = QUALITY_CAPS[/** @type {'off'|'low'|'medium'|'high'} */ (get(shadowQuality))] ?? 2048;
	return Math.min(wanted || 1024, cap);
}

/** re-apply the cap to every shadow-casting light (on quality change) —
 * walks both objectsGroup and the scene-root environment rig, and toggles the
 * renderer's shadow map on the 'off' setting */
export function applyShadowQualityCap() {
	const off = get(shadowQuality) === 'off';
	/** @type {any} */
	const renderer = get(globalRenderer);
	if (renderer?.shadowMap) {
		if (renderer.shadowMap.enabled === off) {
			renderer.shadowMap.enabled = !off;
			renderer.shadowMap.needsUpdate = true;
		}
	}
	const apply = (/** @type {any} */ node) => {
		if (!node.isLight || !node.shadow) return;
		const wanted = node.userData.shadowMapSize ?? node.shadow.mapSize.x;
		const size = cappedShadowSize(wanted);
		if (node.shadow.mapSize.x !== size) {
			node.shadow.mapSize.set(size, size);
			node.shadow.map?.dispose();
			node.shadow.map = null;
		}
	};
	get(objectsGroup)?.traverse(apply);
	get(globalScene)?.getObjectByName('environment-root')?.traverse(apply);
	// the shadow catcher's visibility depends on this pref — dynamic import
	// keeps the module graph acyclic (environment imports lightParams)
	import('./environment').then((m) => m.applyEnvironment());
}

/** set a light's WANTED shadow map size (the cap may reduce it locally)
 * @param {any} light @param {number} size */
export function setShadowMapSize(light, size) {
	light.userData.shadowMapSize = size; // rides toJSON → peers keep the wish
	const applied = cappedShadowSize(size);
	light.shadow.mapSize.set(applied, applied);
	light.shadow.map?.dispose();
	light.shadow.map = null;
}

/** receiver side of the spot aim point @param {any} data */
export function applyLightTarget(data) {
	const group = get(objectsGroup);
	const light = group?.getObjectByProperty('uuid', data.uuid);
	if (light?.isSpotLight && Array.isArray(data.pos)) light.userData.spotTarget = [...data.pos];
}

let started = false;
export function startLightParams() {
	if (started || typeof window === 'undefined') return;
	started = true;
	shadowQuality.subscribe((value) => {
		localStorage.setItem('shadowQuality', String(value));
		applyShadowQualityCap();
	});
}
