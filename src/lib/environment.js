import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { globalScene, globalRenderer, objectsGroup, backgroundColor, TControls, passthroughActive } from '../stores/sceneStore';
import { peers } from '../stores/appStore';
import { sceneRadius } from './sceneBounds';
import { registerSystemGroup } from './moduleSDK';
import { createLight } from './geometries.svelte';
import { cappedShadowSize, shadowQuality } from './lightParams';
import { wireframeActive } from './viewMode';
import { idbGet, idbPut, idbDelete, idbKeys } from './idb';

// Environment v2 (phase 70). Everything environmental lives under ONE group at
// the scene root: `environment-root` — the preset rig (hemi+sun) plus any
// user-added environment lights. Nothing in it is part of objectsGroup, so it
// never leaks into GLTF saves or object sync. The whole environment state
// (preset | custom payload, exposure, extra lights) replicates through the
// existing `environment` message with a changedAt stamp: latest change wins.

export const ENVIRONMENT_PRESETS = {
	studio: {
		label: 'Studio',
		background: '#363b43',
		fog: null,
		hemi: { sky: '#ffffff', ground: '#4c525c', intensity: 1.1 },
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

/** name-indexable view of the presets @type {Record<string, any>} */
const PRESETS = ENVIRONMENT_PRESETS;

const DEFAULT_STATE = { preset: 'studio', exposure: 1, customPreset: null, lights: [], changedAt: 0 };

function persisted() {
	try {
		const raw = localStorage.getItem('environment');
		if (raw) return { ...DEFAULT_STATE, ...JSON.parse(raw) };
	} catch {}
	return { ...DEFAULT_STATE };
}

/** @type {import('svelte/store').Writable<any>} preset|custom payload + exposure + extra lights */
export const environment = writable(
	typeof localStorage === 'undefined' ? { ...DEFAULT_STATE } : persisted()
);

/** saved custom presets from IndexedDB: [{name, payload}] */
export const envPresets = writable(/** @type {any[]} */ ([]));
/** peers' broadcast preset libraries (86): peerId -> [{name, payload}] */
export const peerEnvPresets = writable(/** @type {Record<string, any[]>} */ ({}));

export const ENV_ROOT = 'environment-root';
const RIG_HEMI = 'env-rig-hemi';
const RIG_SUN = 'env-rig-sun';
const CATCHER = 'env-shadow-catcher';
const EXTRA_PREFIX = 'env-extra-';
let userLightFactor = 1;

/** The payload the current state renders with @param {any=} state */
export function presetPayload(state) {
	state = state ?? get(environment);
	if (state.preset === 'custom' && state.customPreset) return state.customPreset;
	return PRESETS[state.preset] ?? ENVIRONMENT_PRESETS.studio;
}

/** @param {any} scene */
function envRoot(scene) {
	let root = scene.getObjectByName(ENV_ROOT);
	if (!root) {
		root = new THREE.Group();
		root.name = ENV_ROOT;
		scene.add(root);
	}
	return root;
}

/** @param {any} scene @param {boolean} create */
function rigLights(scene, create) {
	const root = envRoot(scene);
	let hemi = scene.getObjectByName(RIG_HEMI);
	let sun = scene.getObjectByName(RIG_SUN);
	if (!hemi && create) {
		hemi = new THREE.HemisphereLight(0xffffff, 0x555b66, 1);
		hemi.name = RIG_HEMI;
		root.add(hemi);
	}
	if (!sun && create) {
		sun = new THREE.DirectionalLight(0xffffff, 1);
		sun.name = RIG_SUN;
		// the rig sun is the default shadow caster (V-1); bias values tuned to
		// avoid acne/peter-panning across the presets, map size under the cap
		sun.castShadow = true;
		sun.shadow.bias = -0.0002;
		sun.shadow.normalBias = 0.02;
		const size = cappedShadowSize(2048);
		sun.shadow.mapSize.set(size, size);
		root.add(sun);
	}
	return { hemi, sun };
}

/** The flat ShadowMaterial disc that catches the rig sun's shadows — the
 * infinite Grid is a shader and can't receive shadows. Lives in ENV_ROOT
 * (scene root) so it never enters GLTF sync. @param {any} scene @param {boolean} create */
function shadowCatcher(scene, create) {
	const root = envRoot(scene);
	let disc = scene.getObjectByName(CATCHER);
	if (!disc && create) {
		disc = new THREE.Mesh(
			new THREE.CircleGeometry(1, 48),
			// depthWrite:false keeps the flat disc OUT of the depth buffer that the
			// N8AO post-pass samples. Otherwise AO treats the scene-span disc (just
			// under the grid) as a solid occluding surface and paints it as a dark
			// circle at the scene centre on far dolly-out (the "far-zoom circle").
			// ShadowMaterial still receives + blends the sun's shadow without it.
			new THREE.ShadowMaterial({ opacity: 0.32, transparent: true, depthWrite: false })
		);
		disc.name = CATCHER;
		disc.rotation.x = -Math.PI / 2;
		disc.position.y = -0.001;
		disc.receiveShadow = true;
		root.add(disc);
	}
	return disc;
}

/** Create/update/remove `env-extra-*` lights to mirror state.lights @param {any} scene @param {any[]} defs */
function reconcileExtraLights(scene, defs) {
	const root = envRoot(scene);
	const wanted = new Set(defs.map((def) => EXTRA_PREFIX + def.id));
	for (const child of [...root.children]) {
		if (child.name.startsWith(EXTRA_PREFIX) && !wanted.has(child.name)) root.remove(child);
	}
	for (const def of defs) {
		let light = root.getObjectByName(EXTRA_PREFIX + def.id);
		if (!light) {
			if (def.kind === 'hemisphere') light = new THREE.HemisphereLight();
			else if (def.kind === 'point') light = new THREE.PointLight();
			else light = new THREE.DirectionalLight();
			light.name = EXTRA_PREFIX + def.id;
			root.add(light);
		}
		light.color.set(def.color ?? '#ffffff');
		if (def.kind === 'hemisphere' && light.groundColor) light.groundColor.set(def.groundColor ?? '#444444');
		light.intensity = def.intensity ?? 1;
		if (def.position) light.position.fromArray(def.position);
	}
}

/**
 * L4: "does the post stack tone-map the frame itself?"
 *
 * A REGISTRATION SEAM rather than an import: this module is reached from the
 * viewMode/scene side, and importing scenePost (which imports history, which
 * imports flowRuntime) to answer one boolean is exactly the kind of edge that
 * TDZ-crashes the SSR prerender. Outline.svelte owns the composer and registers
 * the answer — the registerAnnotationsPersistence pattern.
 * @type {() => boolean}
 */
let toneMappingOwner = () => false;

/** @param {(() => boolean) | null} fn */
export function registerToneMappingOwner(fn) {
	toneMappingOwner = fn ?? (() => false);
	applyEnvironment(); // the answer may have changed since the last apply
}

/** Re-apply the current environment to the scene/renderer */
export function applyEnvironment() {
	const scene = get(globalScene);
	/** @type {any} */
	const renderer = get(globalRenderer);
	if (!scene) return;
	const state = get(environment);
	const preset = presetPayload(state);

	// passthrough (90): local view mode — the room shows through where the sky
	// would render; the replicated env STATE keeps its colors untouched
	if (get(passthroughActive)) {
		scene.background = null;
		scene.fog = null;
	} else {
		scene.background = new THREE.Color(preset.background);
		// fog never swallows a big scene: its reach grows with the scene bounds
		scene.fog = preset.fog
			? new THREE.Fog(
					preset.fog.color,
					preset.fog.near,
					Math.max(preset.fog.far, sceneRadius() * 2.5)
				)
			: null;
	}
	backgroundColor.set(preset.background);

	if (renderer) {
		// L4: the post stack may own tone mapping. A ToneMapping entry maps the same
		// image the renderer would, so leaving the renderer's own pass on grades it
		// TWICE — visibly crushed highlights. The stack says so through the seam
		// below rather than this module importing it, which keeps environment out of
		// the post/history import family entirely.
		const stackTonemaps = toneMappingOwner();
		renderer.toneMapping = stackTonemaps ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
		// exposure is only read by three's tone mapping chunk, so it is inert under
		// NoToneMapping — left as authored so switching back needs no re-apply
		renderer.toneMappingExposure = (preset.exposure ?? 1) * (state.exposure ?? 1);
		// honor a persisted 'off' shadow pref here too: the renderer arrives
		// after lightParams' first subscribe fires (which would no-op on a null
		// renderer), so re-assert it on every apply
		if (renderer.shadowMap) renderer.shadowMap.enabled = get(shadowQuality) !== 'off';
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
			// fit the ortho shadow frustum to the scene: sceneBounds re-calls
			// applyEnvironment when the radius changes by >1, so the frustum
			// tracks scene growth for free
			if (sun.castShadow && sun.shadow) {
				const r = Math.min(Math.max(sceneRadius() * 1.2, 15), 120);
				const cam = sun.shadow.camera;
				cam.left = -r;
				cam.right = r;
				cam.top = r;
				cam.bottom = -r;
				cam.near = 0.5;
				cam.far = r * 4;
				cam.updateProjectionMatrix();
			}
		} else sun.visible = false;
	}

	// shadow catcher: visible only when the sun casts and shadows aren't off
	const shadowsOff = get(shadowQuality) === 'off';
	const catcher = shadowCatcher(scene, !!(preset.sun && !shadowsOff));
	if (catcher) {
		catcher.visible = !!(preset.sun && !shadowsOff) && !get(passthroughActive) && !wireframeActive();
		const span = Math.max(60, sceneRadius() * 2);
		catcher.scale.set(span, span, span);
	}

	reconcileExtraLights(scene, state.lights ?? []);
}

/** Apply a state change locally, persist and replicate @param {any} partial */
function commit(partial) {
	const state = { ...get(environment), ...partial, changedAt: Date.now() };
	environment.set(state);
	applyEnvironment();
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'environment', ...state });
}

/** User action: switch preset/exposure (extra lights survive preset switches)
 * @param {string} preset @param {number=} exposure */
export function setEnvironment(preset, exposure) {
	commit({
		preset: PRESETS[preset] || preset === 'custom' ? preset : 'studio',
		exposure: exposure ?? get(environment).exposure ?? 1
	});
}

/** Apply a full custom payload (replicates the payload itself, not a key) @param {any} payload */
export function applyCustomPreset(payload) {
	commit({
		preset: 'custom',
		customPreset: payload,
		exposure: payload.exposure ?? 1,
		...(payload.lights ? { lights: payload.lights } : {})
	});
}

/**
 * 15-C: the scene inspector's Background / Fog controls wrote the scene (and
 * the backgroundColor store) DIRECTLY, and the next applyEnvironment() restored
 * the preset's values — so the edit looked like it did nothing. (Invisible
 * until the color picker's dead `on:input` was fixed, since the handler never
 * ran at all.) Editing the sky now detaches into a live custom payload, exactly
 * like editRigComponent: it sticks, persists and replicates.
 * @param {{background?: string, fog?: {color?: string, near?: number, far?: number} | null}} patch
 */
export function editEnvSky(patch) {
	const payload = JSON.parse(JSON.stringify(presetPayload()));
	payload.label = 'Custom';
	if (patch.background !== undefined) payload.background = patch.background;
	if (patch.fog !== undefined)
		payload.fog = patch.fog === null ? null : { ...(payload.fog ?? {}), ...patch.fog };
	commit({ preset: 'custom', customPreset: payload });
}

/** Editing a rig component detaches into a live custom payload
 * @param {'hemi'|'sun'} part @param {any} patch */
export function editRigComponent(part, patch) {
	const payload = JSON.parse(JSON.stringify(presetPayload()));
	payload.label = 'Custom';
	payload[part] = { ...(payload[part] ?? {}), ...patch };
	commit({ preset: 'custom', customPreset: payload });
}

// ---- extra environment lights -------------------------------------------

/** @param {'hemisphere'|'directional'|'point'} kind */
export function addEnvLight(kind) {
	const def = {
		id: crypto.randomUUID().slice(0, 8),
		kind,
		color: '#ffffff',
		...(kind === 'hemisphere' ? { groundColor: '#444444' } : {}),
		intensity: 1,
		position: [4, 8, 2]
	};
	commit({ lights: [...(get(environment).lights ?? []), def] });
	return def.id;
}

/** @param {string} id @param {any} patch */
export function updateEnvLight(id, patch) {
	commit({
		lights: (get(environment).lights ?? []).map((/** @type {any} */ def) =>
			def.id === id ? { ...def, ...patch } : def
		)
	});
}

/** @param {string} id */
export function removeEnvLight(id) {
	commit({
		lights: (get(environment).lights ?? []).filter((/** @type {any} */ def) => def.id !== id)
	});
}

/** Move a normal replicated light INTO the environment: it leaves objectsGroup
 * (delete replicates) and its parameters fold into env state. @param {string} uuid */
export function convertToEnvironment(uuid) {
	const group = get(objectsGroup);
	const object = group?.getObjectByProperty('uuid', uuid);
	if (!object || !object.isLight) return null;
	const kind = object.isHemisphereLight
		? 'hemisphere'
		: object.isPointLight
			? 'point'
			: 'directional';
	const def = {
		id: crypto.randomUUID().slice(0, 8),
		kind,
		color: '#' + object.color.getHexString(),
		...(object.groundColor ? { groundColor: '#' + object.groundColor.getHexString() } : {}),
		intensity: object.intensity ?? 1,
		position: object.position.toArray()
	};
	// explicit conversion — remove the replicated object (no undo entry)
	/** @type {any} */
	const controls = get(TControls);
	if (controls?.object?.uuid === uuid) controls.detach();
	object.parent?.remove(object);
	objectsGroup.update((value) => value);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'delete', uuid, peerId: peer.peer.id });
	commit({ lights: [...(get(environment).lights ?? []), def] });
	return def.id;
}

/** Convert an environment light back into a normal replicated object. @param {string} id */
export function convertFromEnvironment(id) {
	const def = (get(environment).lights ?? []).find((/** @type {any} */ entry) => entry.id === id);
	if (!def) return null;
	const command = '/light ' + def.kind;
	const uuid = createLight(command);
	if (!uuid) return null;
	const group = get(objectsGroup);
	const light = group.getObjectByProperty('uuid', uuid);
	light.color.set(def.color ?? '#ffffff');
	if (def.groundColor && light.groundColor) light.groundColor.set(def.groundColor);
	light.intensity = def.intensity ?? 1;
	if (def.position) light.position.fromArray(def.position);
	objectsGroup.update((value) => value);
	/** @type {any} */
	const peer = get(peers);
	if (peer) {
		peer.send({ type: 'light', command, uuid });
		peer.send({ type: 'object', element: light.toJSON(), override: true });
	}
	removeEnvLight(id);
	return uuid;
}

// ---- custom presets (IndexedDB + JSON export/import) ---------------------

const PRESET_KEY = 'envpreset:';

/** Snapshot the current environment as a named payload @param {string} name */
export function snapshotPreset(name) {
	const state = get(environment);
	return {
		...JSON.parse(JSON.stringify(presetPayload(state))),
		label: name,
		exposure: state.exposure ?? 1,
		lights: JSON.parse(JSON.stringify(state.lights ?? []))
	};
}

export async function loadEnvPresets() {
	try {
		const keys = await idbKeys();
		const names = keys.filter((/** @type {any} */ key) => String(key).startsWith(PRESET_KEY));
		const list = [];
		for (const key of names) {
			const payload = await idbGet(String(key));
			if (payload) list.push({ name: String(key).slice(PRESET_KEY.length), payload });
		}
		envPresets.set(list);
	} catch {
		envPresets.set([]);
	}
}

/** @param {string} name */
export async function saveEnvPreset(name) {
	const payload = snapshotPreset(name);
	await idbPut(PRESET_KEY + name, payload);
	await loadEnvPresets();
	broadcastEnvPresets();
	return payload;
}

/** @param {string} name */
export async function deleteEnvPreset(name) {
	await idbDelete(PRESET_KEY + name);
	await loadEnvPresets();
	broadcastEnvPresets();
}

// ---- preset LIBRARY broadcast (86): peers can apply your presets by name ---

const PRESETS_BROADCAST_CAP = 2_000_000; // bytes of JSON, roughly

/** the message carrying this peer's whole preset library */
export function envPresetsState() {
	/** @type {any} */
	const peer = get(peers);
	let presets = get(envPresets);
	while (presets.length && JSON.stringify(presets).length > PRESETS_BROADCAST_CAP)
		presets = presets.slice(0, presets.length - 1);
	return { type: 'envpresets', from: peer?.peer?.id, presets };
}

export function broadcastEnvPresets() {
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send(envPresetsState());
}

/** receiver side @param {any} data */
export function applyRemoteEnvPresets(data) {
	if (!data?.from) return;
	peerEnvPresets.update((map) => ({ ...map, [data.from]: data.presets ?? [] }));
}

/** drop a disconnected peer's library @param {string} peerId */
export function dropPeerEnvPresets(peerId) {
	peerEnvPresets.update((map) => {
		const next = { ...map };
		delete next[peerId];
		return next;
	});
}

/** JSON for a .envpreset.json download @param {any} payload */
export function exportEnvPreset(payload) {
	return JSON.stringify(payload, null, 2);
}

/** Import a payload JSON: saves it under its label and applies it @param {string} json */
export async function importEnvPreset(json) {
	const payload = JSON.parse(json);
	if (!payload || typeof payload !== 'object' || !payload.background) throw new Error('not an environment preset');
	payload.label = payload.label || 'Imported';
	await idbPut(PRESET_KEY + payload.label, payload);
	await loadEnvPresets();
	applyCustomPreset(payload);
	return payload;
}

// ---- replication ----------------------------------------------------------

/** Remote/handshake apply: newest change wins @param {any} data */
export function applyRemoteEnvironment(data) {
	if (!data?.preset) return;
	if ((data.changedAt ?? 0) <= (get(environment).changedAt ?? 0)) return;
	environment.set({
		preset: data.preset,
		exposure: data.exposure ?? 1,
		customPreset: data.customPreset ?? null,
		lights: data.lights ?? [],
		changedAt: data.changedAt
	});
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
	registerSystemGroup(ENV_ROOT); // advanced object-list System filter
	loadEnvPresets();
	environment.subscribe((state) => {
		try {
			localStorage.setItem('environment', JSON.stringify(state));
		} catch {}
	});
	// scene/renderer arrive async at boot
	globalScene.subscribe(() => applyEnvironment());
	globalRenderer.subscribe(() => applyEnvironment());
	// entering/leaving a passthrough session swaps the local sky in and out
	passthroughActive.subscribe(() => applyEnvironment());
	// user lights dim the rig so custom lighting reads properly
	objectsGroup.subscribe((group) => {
		if (!group) return;
		let lights = 0;
		group.traverse((/** @type {any} */ node) => {
			if (node.isLight) lights++;
		});
		const factor = lights > 0 ? 0.25 : 1;
		if (factor !== userLightFactor) {
			userLightFactor = factor;
			applyEnvironment();
		}
	});
}
