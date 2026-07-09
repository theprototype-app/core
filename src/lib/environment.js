import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { globalScene, globalRenderer, objectsGroup, backgroundColor } from '../stores/sceneStore';
import { peers } from '../stores/appStore';

// Environment presets + a default light rig. The rig lives at the SCENE root
// with fixed names — it is never part of objectsGroup, so connecting peers
// can't duplicate it (the old default-light-per-user problem). Preset changes
// replicate with a changedAt stamp: latest change wins, so two customized
// peers converge instead of swapping.

export const ENVIRONMENT_PRESETS = {
	studio: {
		label: 'Studio',
		background: '#3b4048',
		fog: null,
		hemi: { sky: '#ffffff', ground: '#565d68', intensity: 1.1 },
		sun: { color: '#ffffff', intensity: 1.8, position: [6, 10, 4] },
		exposure: 1
	},
	daylight: {
		label: 'Daylight',
		background: '#8db8dd',
		fog: { color: '#a9c8e4', near: 60, far: 220 },
		hemi: { sky: '#cfe6ff', ground: '#8c8073', intensity: 1.3 },
		sun: { color: '#fff4dd', intensity: 2.4, position: [8, 14, 6] },
		exposure: 1.05
	},
	sunset: {
		label: 'Sunset',
		background: '#33202f',
		fog: { color: '#4a2c3f', near: 30, far: 140 },
		hemi: { sky: '#ff9d6b', ground: '#3a2b3d', intensity: 0.9 },
		sun: { color: '#ff7b3d', intensity: 1.8, position: [12, 4, -6] },
		exposure: 1.1
	},
	night: {
		label: 'Night',
		background: '#0b0e1a',
		fog: { color: '#0e1322', near: 25, far: 120 },
		hemi: { sky: '#33405e', ground: '#0c0f18', intensity: 0.55 },
		sun: { color: '#a9c0ff', intensity: 0.5, position: [-6, 12, -4] },
		exposure: 0.95
	},
	classic: {
		label: 'Classic',
		background: '#ffffff',
		fog: null,
		hemi: null, // rig off — the pre-rig look, bring your own lights
		sun: null,
		exposure: 1
	}
};

function persisted() {
	try {
		const raw = localStorage.getItem('environment');
		if (raw) return JSON.parse(raw);
	} catch {}
	return { preset: 'studio', exposure: 1, changedAt: 0 };
}

/** @type {import('svelte/store').Writable<{preset: string, exposure: number, changedAt: number}>} */
export const environment = writable(
	typeof localStorage === 'undefined' ? { preset: 'studio', exposure: 1, changedAt: 0 } : persisted()
);

const RIG_HEMI = 'env-rig-hemi';
const RIG_SUN = 'env-rig-sun';
let userLightFactor = 1;

function rigLights(scene, create) {
	let hemi = scene.getObjectByName(RIG_HEMI);
	let sun = scene.getObjectByName(RIG_SUN);
	if (!hemi && create) {
		hemi = new THREE.HemisphereLight(0xffffff, 0x555b66, 1);
		hemi.name = RIG_HEMI;
		scene.add(hemi);
	}
	if (!sun && create) {
		sun = new THREE.DirectionalLight(0xffffff, 1);
		sun.name = RIG_SUN;
		scene.add(sun);
	}
	return { hemi, sun };
}

/** Re-apply the current environment to the scene/renderer */
export function applyEnvironment() {
	const scene = get(globalScene);
	/** @type {any} */
	const renderer = get(globalRenderer);
	if (!scene) return;
	const state = get(environment);
	const preset = ENVIRONMENT_PRESETS[state.preset] ?? ENVIRONMENT_PRESETS.studio;

	scene.background = new THREE.Color(preset.background);
	backgroundColor.set(preset.background);
	scene.fog = preset.fog ? new THREE.Fog(preset.fog.color, preset.fog.near, preset.fog.far) : null;

	if (renderer) {
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = preset.exposure * (state.exposure ?? 1);
	}

	const { hemi, sun } = rigLights(scene, !!preset.hemi);
	if (hemi) {
		if (preset.hemi) {
			hemi.visible = true;
			hemi.color.set(preset.hemi.sky);
			hemi.groundColor.set(preset.hemi.ground);
			hemi.intensity = preset.hemi.intensity * userLightFactor;
		} else hemi.visible = false;
	}
	if (sun) {
		if (preset.sun) {
			sun.visible = true;
			sun.color.set(preset.sun.color);
			sun.intensity = preset.sun.intensity * userLightFactor;
			sun.position.fromArray(preset.sun.position);
		} else sun.visible = false;
	}
}

/** User action: switch preset/exposure, persist and replicate @param {string} preset @param {number=} exposure */
export function setEnvironment(preset, exposure) {
	const state = {
		preset: ENVIRONMENT_PRESETS[preset] ? preset : 'studio',
		exposure: exposure ?? get(environment).exposure ?? 1,
		changedAt: Date.now()
	};
	environment.set(state);
	applyEnvironment();
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'environment', ...state });
}

/** Remote/handshake apply: newest change wins @param {any} data */
export function applyRemoteEnvironment(data) {
	if (!data?.preset) return;
	if ((data.changedAt ?? 0) <= (get(environment).changedAt ?? 0)) return;
	environment.set({ preset: data.preset, exposure: data.exposure ?? 1, changedAt: data.changedAt });
	applyEnvironment();
}

/** Handshake payload */
export function environmentState() {
	return { type: 'environment', ...get(environment) };
}

let started = false;

export function startEnvironment() {
	if (started || typeof window === 'undefined') return;
	started = true;
	environment.subscribe((state) => {
		try {
			localStorage.setItem('environment', JSON.stringify(state));
		} catch {}
	});
	// scene/renderer arrive async at boot
	globalScene.subscribe(() => applyEnvironment());
	globalRenderer.subscribe(() => applyEnvironment());
	// user lights dim the rig so custom lighting reads properly
	objectsGroup.subscribe((group) => {
		if (!group) return;
		let lights = 0;
		group.traverse((node) => {
			if (node.isLight) lights++;
		});
		const factor = lights > 0 ? 0.25 : 1;
		if (factor !== userLightFactor) {
			userLightFactor = factor;
			applyEnvironment();
		}
	});
}
