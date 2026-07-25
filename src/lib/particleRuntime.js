// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalRenderer, globalCamera, isVRMode } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { wireframeActive } from './viewMode';
import { particleVertexShader, particleFragmentShader, spriteTexture, wrapTime } from './particleShader';
import { PARTICLE_DEFAULTS } from './particlePresets';

// Particle emitter runtime (PFX-A). flowRuntime hands over the live emitters
// each tick — `particle` NODE pairs (like sound) plus every object carrying
// userData.particles. Lifecycle mirrors soundRuntime: Map-keyed entries, a
// wanted-set diff (emitter gone -> dispose), cheap uniform updates otherwise.
// Each entry owns ONE THREE.Points under the scene-root 'particle-root' group
// (sibling of sceneObjects — NEVER inside it, or the Points would leak into
// GLTF sync). The sim itself is analytic in the vertex shader; see
// particleShader.js for the determinism story.
//
// IMPORTANT (TDZ-cycle family): this module is statically imported by
// flowRuntime, which history.js imports — nothing here may reach history/
// shortcuts/peerHandler statically. Replicating mutators live in
// particleActions.js instead.

export const MAX_EMITTERS = 8; // active emitters (extras hidden + toast)
export const MAX_COUNT = 500; // particles per emitter (desktop)
export const VR_MAX_COUNT = 200; // drawRange cap while presenting

/** @type {Map<string, any>} entry key ('ud:'+uuid or nodeId) -> entry */
const entries = new Map();
/** @type {any} scene-root group the Points live under (set by Scene.svelte) */
let root = null;
/** @type {any} last objectsGroup seen (for applyBurst outside the tick) */
let lastScene = null;
let capToasted = false;

const tempPos = new THREE.Vector3();
const tempQuat = new THREE.Quaternion();

/** Scene.svelte mounts the scene-root holder through this. @param {any} group */
export function setParticleRoot(group) {
	root = group;
}

// deterministic per-particle randoms: same key + index -> same values on every peer
/** @param {string} str */
function hashString(str) {
	let hash = 5381;
	for (let i = 0; i < str.length; i++) hash = ((hash * 33) ^ str.charCodeAt(i)) >>> 0;
	return hash >>> 0;
}
/** @param {number} seed */
function mulberry32(seed) {
	let t = (seed + 0x6d2b79f5) >>> 0;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const SHAPE_INDEX = { cone: 0, sphere: 1, disc: 2 };

/** Effective config: defaults + the emitter's data. @param {any} data */
function configOf(data) {
	return { ...PARTICLE_DEFAULTS, ...(data ?? {}) };
}

/** @param {string} key @param {number} count */
function buildGeometry(key, count) {
	const geometry = new THREE.BufferGeometry();
	const seed = hashString(key);
	const rand = new Float32Array(count * 4);
	const rand2 = new Float32Array(count * 4);
	const index = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		for (let j = 0; j < 4; j++) {
			rand[i * 4 + j] = mulberry32(seed + i * 7919 + j);
			rand2[i * 4 + j] = mulberry32(seed + i * 7919 + j + 4);
		}
		index[i] = i;
	}
	geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
	geometry.setAttribute('aRand', new THREE.BufferAttribute(rand, 4));
	geometry.setAttribute('aRand2', new THREE.BufferAttribute(rand2, 4));
	geometry.setAttribute('aIndex', new THREE.BufferAttribute(index, 1));
	geometry.setAttribute('aOrigin', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
	return geometry;
}

/** @param {string} key @param {number} count */
function buildEntry(key, count) {
	const geometry = buildGeometry(key, count);
	const material = new THREE.ShaderMaterial({
		vertexShader: particleVertexShader,
		fragmentShader: particleFragmentShader,
		transparent: true,
		depthWrite: false,
		uniforms: {
			uTime: { value: 0 },
			uMode: { value: 0 },
			uBurstT: { value: -1 },
			uCount: { value: count },
			uLifetime: { value: 1.5 },
			uLifeJitter: { value: 0.3 },
			uShape: { value: 0 },
			uAngle: { value: 0.4 },
			uRadius: { value: 0.15 },
			uSpeed: { value: 1 },
			uSpeedJitter: { value: 0.4 },
			uGravity: { value: 0 },
			uDrag: { value: 0.2 },
			uTurbulence: { value: 0.2 },
			uSizeStart: { value: 0.1 },
			uSizeEnd: { value: 0.03 },
			uSpin: { value: 0 },
			uSizeScale: { value: 600 },
			uQuat: { value: new THREE.Vector4(0, 0, 0, 1) },
			uWorldSpace: { value: 0 },
			uMap: { value: spriteTexture('dot') },
			uColorStart: { value: new THREE.Color('#ffffff') },
			uColorEnd: { value: new THREE.Color('#8899aa') },
			uColorMode: { value: 0 },
			uOpacity: { value: 0.9 },
			uFadeIn: { value: 0.08 },
			uFadeOut: { value: 0.4 }
		}
	});
	const points = new THREE.Points(geometry, material);
	points.frustumCulled = false; // positions live in the shader — three can't cull them
	points.name = 'particles-' + key;
	root.add(points);
	return {
		key,
		uuid: '',
		count,
		points,
		geometry,
		material,
		space: 'local',
		burstT: -1,
		// CPU mirror of each slot's phase/lifetime (world-space rebirth stamping)
		lifeKey: '',
		phases: new Float32Array(count),
		lives: new Float32Array(count),
		lastCycle: new Int32Array(count).fill(-1e9)
	};
}

/** @param {any} entry */
function dropEntry(entry) {
	if (!entry) return;
	entry.points?.parent?.remove(entry.points);
	entry.geometry?.dispose();
	entry.material?.dispose();
}

/** Recompute the CPU phase/lifetime mirror (matches the shader math). @param {any} entry @param {any} cfg */
function refreshLifeCache(entry, cfg) {
	const lifeKey = [cfg.lifetime, cfg.lifeJitter, cfg.count].join('|');
	if (entry.lifeKey === lifeKey) return;
	entry.lifeKey = lifeKey;
	const rand = entry.geometry.getAttribute('aRand').array;
	const rand2 = entry.geometry.getAttribute('aRand2').array;
	for (let i = 0; i < entry.count; i++) {
		entry.lives[i] = Math.max(cfg.lifetime * (1 + cfg.lifeJitter * (rand[i * 4 + 3] - 0.5)), 0.05);
		entry.phases[i] = (i / Math.max(entry.count, 1)) * cfg.lifetime + rand2[i * 4 + 3] * 0.05;
		entry.lastCycle[i] = -1e9;
	}
}

/** Stamp every slot's world-space origin at the emitter's current position. @param {any} entry @param {any} object */
function stampAllOrigins(entry, object) {
	object.getWorldPosition(tempPos);
	const origin = entry.geometry.getAttribute('aOrigin');
	for (let i = 0; i < entry.count; i++) origin.setXYZ(i, tempPos.x, tempPos.y, tempPos.z);
	origin.needsUpdate = true;
}

/** Push the emitter config into the shader uniforms. @param {any} entry @param {any} cfg */
function applyUniforms(entry, cfg) {
	const u = entry.material.uniforms;
	u.uMode.value = cfg.mode === 'burst' ? 1 : 0;
	u.uLifetime.value = cfg.lifetime;
	u.uLifeJitter.value = cfg.lifeJitter;
	u.uShape.value = SHAPE_INDEX[/** @type {'cone'} */ (cfg.shape)] ?? 0;
	u.uAngle.value = (cfg.angle * Math.PI) / 180;
	u.uRadius.value = cfg.radius;
	u.uSpeed.value = cfg.speed;
	u.uSpeedJitter.value = cfg.speedJitter;
	u.uGravity.value = cfg.gravity;
	u.uDrag.value = cfg.drag;
	u.uTurbulence.value = cfg.turbulence;
	u.uSizeStart.value = cfg.sizeStart;
	u.uSizeEnd.value = cfg.sizeEnd;
	u.uSpin.value = cfg.spin;
	u.uColorMode.value = cfg.colorMode === 'particle' ? 1 : 0;
	u.uOpacity.value = cfg.opacity;
	u.uFadeIn.value = cfg.fadeIn;
	u.uFadeOut.value = cfg.fadeOut;
	if (entry.sprite !== cfg.sprite) {
		entry.sprite = cfg.sprite;
		u.uMap.value = spriteTexture(cfg.sprite);
	}
	if (entry.colorStart !== cfg.colorStart) {
		entry.colorStart = cfg.colorStart;
		u.uColorStart.value.set(cfg.colorStart);
	}
	if (entry.colorEnd !== cfg.colorEnd) {
		entry.colorEnd = cfg.colorEnd;
		u.uColorEnd.value.set(cfg.colorEnd);
	}
	entry.material.blending = cfg.blending === 'normal' ? THREE.NormalBlending : THREE.AdditiveBlending;
}

/**
 * Called by flowRuntime each tick — `particle` node pairs (PFX-B wires these)
 * plus a sweep of sceneObjects for userData.particles emitters.
 * @param {{node: any, uuid: string}[]} pairs @param {any} sceneObjects @param {number} time synced seconds
 */
export function updateParticles(pairs, sceneObjects, time) {
	if (!root || !sceneObjects) return;
	lastScene = sceneObjects;
	root.visible = !wireframeActive(); // scene.overrideMaterial would clobber the Points shader

	/** @type {{key: string, uuid: string, data: any, object: any}[]} */
	const candidates = [];
	for (const { node, uuid } of pairs) {
		const object = sceneObjects.getObjectByProperty('uuid', uuid);
		if (object) candidates.push({ key: node.id, uuid, data: node.data ?? {}, object });
	}
	sceneObjects.traverse((/** @type {any} */ object) => {
		if (object.userData?.particles)
			candidates.push({ key: 'ud:' + object.uuid, uuid: object.uuid, data: object.userData.particles, object });
	});

	// deterministic emitter cap: same order on every peer (visual-only)
	candidates.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	if (candidates.length > MAX_EMITTERS && !capToasted) {
		capToasted = true;
		showToast(`Particle emitter cap (${MAX_EMITTERS}) reached — extra emitters are not rendered`);
	}
	const live = candidates.slice(0, MAX_EMITTERS);

	// px scale for gl_PointSize (world size -> pixels at depth 1)
	const renderer = get(globalRenderer);
	const camera = get(globalCamera);
	const height = renderer?.domElement?.height ?? 600;
	const sizeScale = height / (2 * Math.tan(((camera?.fov ?? 40) * Math.PI) / 360));
	const vr = get(isVRMode);
	const tw = wrapTime(time);

	const wanted = new Set();
	for (const { key, uuid, data, object } of live) {
		wanted.add(key);
		const cfg = configOf(data);
		cfg.count = Math.min(Math.max(Math.round(cfg.count), 1), MAX_COUNT);
		let entry = entries.get(key);
		if (!entry || entry.count !== cfg.count) {
			dropEntry(entry);
			entry = buildEntry(key, cfg.count);
			entries.set(key, entry);
			entry.space = ''; // force the space init below
			// burst emitters idle until triggered, so attaching one would look
			// dead — auto-fire ONCE on (re)build for immediate LOCAL feedback
			// (each peer fires when it builds its own entry; tightly-synced
			// bursts still ride the replicated particleburst timestamp). World
			// origins get stamped in the space-init block below this tick.
			if (cfg.mode === 'burst') entry.burstT = tw;
		}
		entry.uuid = uuid;
		refreshLifeCache(entry, cfg);
		applyUniforms(entry, cfg);
		const u = entry.material.uniforms;
		u.uTime.value = tw;
		u.uSizeScale.value = sizeScale;
		u.uBurstT.value = entry.burstT;
		entry.geometry.setDrawRange(0, vr ? Math.min(cfg.count, VR_MAX_COUNT) : cfg.count);
		entry.points.visible = object.visible !== false;

		// sim space: local = the Points ride the object; world = particles keep
		// their per-birth spawn position (stamped below) and trail behind
		const world = cfg.space === 'world';
		u.uWorldSpace.value = world ? 1 : 0;
		if (entry.space !== cfg.space) {
			entry.space = cfg.space;
			entry.points.position.set(0, 0, 0);
			entry.points.quaternion.identity();
			entry.lastCycle.fill(-1e9);
			if (world) stampAllOrigins(entry, object);
		}
		if (world) {
			object.getWorldQuaternion(tempQuat);
			u.uQuat.value.set(tempQuat.x, tempQuat.y, tempQuat.z, tempQuat.w);
			if (cfg.mode !== 'burst') {
				// stamp each slot's spawn point at its rebirth frame (CPU mirror of
				// the shader's cycle math — N writes/second, not per frame)
				object.getWorldPosition(tempPos);
				const origin = entry.geometry.getAttribute('aOrigin');
				let dirty = false;
				for (let i = 0; i < entry.count; i++) {
					const cycle = Math.floor((tw - entry.phases[i]) / entry.lives[i]);
					if (cycle !== entry.lastCycle[i]) {
						entry.lastCycle[i] = cycle;
						origin.setXYZ(i, tempPos.x, tempPos.y, tempPos.z);
						dirty = true;
					}
				}
				if (dirty) origin.needsUpdate = true;
			}
		} else {
			object.getWorldPosition(entry.points.position);
			object.getWorldQuaternion(entry.points.quaternion);
		}
	}

	for (const [key, entry] of entries)
		if (!wanted.has(key)) {
			dropEntry(entry);
			entries.delete(key);
		}
	if (entries.size <= MAX_EMITTERS) capToasted = false;
}

/**
 * Fire every burst-mode emitter attached to an object. `t` is the SHARED
 * synced timestamp riding the replicated `particleburst` message — every peer
 * seeds the identical burst from it (keypress/nodetrigger precedent).
 * @param {string} uuid @param {number} t synced seconds
 */
export function applyBurst(uuid, t) {
	for (const entry of entries.values()) {
		if (entry.uuid !== uuid) continue;
		entry.burstT = wrapTime(t);
		entry.material.uniforms.uBurstT.value = entry.burstT;
		if (entry.space === 'world') {
			const object = lastScene?.getObjectByProperty('uuid', uuid);
			if (object) stampAllOrigins(entry, object);
		}
	}
}

/** test/debug view of the live emitters */
export function particleEntries() {
	return [...entries.values()].map((entry) => ({
		key: entry.key,
		uuid: entry.uuid,
		count: entry.count,
		space: entry.space,
		sprite: entry.sprite,
		burstT: entry.burstT,
		uTime: entry.material.uniforms.uTime.value,
		visible: entry.points.visible,
		inRoot: entry.points.parent === root
	}));
}
