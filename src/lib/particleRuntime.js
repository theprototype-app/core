// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { get } from 'svelte/store';
import { globalRenderer, globalCamera, isVRMode } from '../stores/sceneStore';
import { showToast } from '../stores/appStore';
import { wireframeActive } from './viewMode';
import {
	particleVertexShader,
	particleFragmentShader,
	stripVertexShader,
	ribbonVertexShader,
	stripFragmentShader,
	spriteTexture,
	wrapTime
} from './particleShader';
import {
	renderModeOf,
	segmentsOf,
	stripLayout,
	ribbonLayout,
	expandSlots,
	smoothEmitterVelocity
} from './particleStrips';
import { PARTICLE_DEFAULTS } from './particlePresets';
import { qualityOverrides } from './qualityGovernor';

// 26-D: the governor's particle step caps every emitter at the VR count (roadmap 26 Stage 3's
// third bullet). Read through a subscription — this runs per frame per emitter.
let particlesCapped = false;
qualityOverrides.subscribe((o) => (particlesCapped = o.particlesCapped));

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

const SHAPE_INDEX = { cone: 0, sphere: 1, disc: 2, box: 3 };

/** Effective config: defaults + the emitter's data. @param {any} data */
function configOf(data) {
	return { ...PARTICLE_DEFAULTS, ...(data ?? {}) };
}

/** Per-SLOT hashed randoms — the same key + slot index gives the same values on every peer.
 * @param {string} key @param {number} count */
function slotRandoms(key, count) {
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
	return { rand, rand2, index };
}

/**
 * The geometry for one render mode. `points` is one vertex per slot (the slot arrays ARE
 * the attributes); the strip modes expand every slot attribute per vertex through the
 * layout's maps (particleStrips.js), and the ribbon also carries each quad's other slot.
 * @param {{rand: Float32Array, rand2: Float32Array, index: Float32Array}} slots
 * @param {number} count @param {string} render @param {number} segs
 */
function buildGeometry(slots, count, render, segs) {
	const geometry = new THREE.BufferGeometry();
	/** @param {string} name @param {Float32Array} array @param {number} size */
	const attr = (name, array, size) => geometry.setAttribute(name, new THREE.BufferAttribute(array, size));
	if (render === 'points') {
		attr('position', new Float32Array(count * 3), 3);
		attr('aRand', slots.rand, 4);
		attr('aRand2', slots.rand2, 4);
		attr('aIndex', slots.index, 1);
		attr('aOrigin', new Float32Array(count * 3), 3);
		attr('aVel', new Float32Array(count * 3), 3);
		return { geometry, layout: null };
	}
	const layout = render === 'ribbon' ? ribbonLayout(count) : stripLayout(count, segs);
	const n = layout.verts;
	attr('position', new Float32Array(n * 3), 3);
	attr('aRand', expandSlots(slots.rand, 4, layout.slotOf, new Float32Array(n * 4)), 4);
	attr('aRand2', expandSlots(slots.rand2, 4, layout.slotOf, new Float32Array(n * 4)), 4);
	attr('aIndex', expandSlots(slots.index, 1, layout.slotOf, new Float32Array(n)), 1);
	attr('aOrigin', new Float32Array(n * 3), 3);
	attr('aVel', new Float32Array(n * 3), 3);
	attr('aSide', layout.side, 1);
	if ('otherOf' in layout) {
		attr('aRandN', expandSlots(slots.rand, 4, layout.otherOf, new Float32Array(n * 4)), 4);
		attr('aRand2N', expandSlots(slots.rand2, 4, layout.otherOf, new Float32Array(n * 4)), 4);
		attr('aIndexN', expandSlots(slots.index, 1, layout.otherOf, new Float32Array(n)), 1);
		attr('aOriginN', new Float32Array(n * 3), 3);
		attr('aVelN', new Float32Array(n * 3), 3);
		attr('aEnd', layout.end, 1);
	} else {
		attr('aSeg', layout.seg, 1);
	}
	geometry.setIndex(new THREE.BufferAttribute(layout.index, 1));
	return { geometry, layout };
}

const RENDER_INDEX = { points: 0, stretch: 1, trails: 2, ribbon: 3 };

/** @param {string} key @param {number} count @param {string} render @param {number} segs */
function buildEntry(key, count, render = 'points', segs = 1) {
	const slots = slotRandoms(key, count);
	const { geometry, layout } = buildGeometry(slots, count, render, segs);
	const points = render === 'points';
	const material = new THREE.ShaderMaterial({
		vertexShader: points ? particleVertexShader : render === 'ribbon' ? ribbonVertexShader : stripVertexShader,
		fragmentShader: points ? particleFragmentShader : stripFragmentShader,
		transparent: true,
		depthWrite: false,
		// a strip turns its face to the camera, but which face depends on the path's direction
		side: points ? THREE.FrontSide : THREE.DoubleSide,
		uniforms: {
			uTime: { value: 0 },
			uMode: { value: 0 },
			uBurstT: { value: -1 },
			uCount: { value: count },
			uLifetime: { value: 1.5 },
			uLifeJitter: { value: 0.3 },
			uPhaseNoise: { value: 0.05 },
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
			uOffset: { value: new THREE.Vector3() },
			// 36 B3: weather areas (rain / snow)
			uArea: { value: new THREE.Vector2(1, 1) },
			uWind: { value: new THREE.Vector3() },
			uFall: { value: 0 },
			uGround: { value: 0 },
			uQuat: { value: new THREE.Vector4(0, 0, 0, 1) },
			uWorldSpace: { value: 0 },
			// 37-fx: inherit velocity + the strip modes
			uInherit: { value: 0 },
			uRender: { value: RENDER_INDEX[/** @type {'points'} */ (render)] ?? 0 },
			uSegs: { value: segs },
			uTrail: { value: 0.05 },
			uMap: { value: spriteTexture('dot') },
			uColorStart: { value: new THREE.Color('#ffffff') },
			uColorEnd: { value: new THREE.Color('#8899aa') },
			uColorMode: { value: 0 },
			uOpacity: { value: 0.9 },
			uFadeIn: { value: 0.08 },
			uFadeOut: { value: 0.4 }
		}
	});
	const object = points ? new THREE.Points(geometry, material) : new THREE.Mesh(geometry, material);
	object.frustumCulled = false; // positions live in the shader — three can't cull them
	object.name = 'particles-' + key;
	root.add(object);
	return {
		key,
		uuid: '',
		count,
		render,
		segs,
		layout,
		points: object,
		geometry,
		material,
		space: 'local',
		burstT: -1,
		lastTrigger: false,
		// CPU mirror of each slot's phase/lifetime (world-space rebirth stamping)
		lifeKey: '',
		phases: new Float32Array(count),
		lives: new Float32Array(count),
		lastCycle: new Int32Array(count).fill(-1e9),
		// 37-fx: per-SLOT birth stamps (origin + the emitter's velocity then); for points
		// these are the attribute arrays themselves, the strip modes expand them per vertex
		slots,
		slotOrigin: points ? geometry.getAttribute('aOrigin').array : new Float32Array(count * 3),
		slotVel: points ? geometry.getAttribute('aVel').array : new Float32Array(count * 3),
		// 37-fx: the emitter's smoothed world velocity (inherit velocity)
		vel: [0, 0, 0],
		emitPos: [0, 0, 0],
		emitNow: [0, 0, 0],
		emitT: 0,
		emitSeen: false
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
	const jitter = lifeJitterOf(entry, cfg);
	const noise = phaseNoiseOf(entry);
	const lifeKey = [cfg.lifetime, jitter, noise, cfg.count].join('|');
	if (entry.lifeKey === lifeKey) return;
	entry.lifeKey = lifeKey;
	const { rand, rand2 } = entry.slots;
	for (let i = 0; i < entry.count; i++) {
		entry.lives[i] = Math.max(cfg.lifetime * (1 + jitter * (rand[i * 4 + 3] - 0.5)), 0.05);
		entry.phases[i] = (i / Math.max(entry.count, 1)) * cfg.lifetime + rand2[i * 4 + 3] * noise;
		entry.lastCycle[i] = -1e9;
	}
}

/** A ribbon joins slots in birth ORDER, so every slot lives exactly `lifetime` (no
 * jitter) and is born exactly on its phase (no noise) — the CPU mirror and the shader agree.
 * @param {any} entry @param {any} cfg */
function lifeJitterOf(entry, cfg) {
	return entry.render === 'ribbon' ? 0 : cfg.lifeJitter;
}
/** @param {any} entry */
function phaseNoiseOf(entry) {
	return entry.render === 'ribbon' ? 0 : 0.05;
}

/** Stamp one slot's birth: where the emitter was, and how fast it was going.
 * @param {any} entry @param {number} i @param {any} pos */
function stampSlot(entry, i, pos) {
	const k = i * 3;
	entry.slotOrigin[k] = pos.x;
	entry.slotOrigin[k + 1] = pos.y;
	entry.slotOrigin[k + 2] = pos.z;
	entry.slotVel[k] = entry.vel[0];
	entry.slotVel[k + 1] = entry.vel[1];
	entry.slotVel[k + 2] = entry.vel[2];
}

/** Upload the birth stamps. Points read the slot arrays directly; the strip modes copy each
 * slot into every vertex that samples it (and a ribbon into its neighbours' "other" too).
 * @param {any} entry */
function flushStamps(entry) {
	const g = entry.geometry;
	if (entry.layout) {
		const { slotOf } = entry.layout;
		expandSlots(entry.slotOrigin, 3, slotOf, g.getAttribute('aOrigin').array);
		expandSlots(entry.slotVel, 3, slotOf, g.getAttribute('aVel').array);
		if (entry.layout.otherOf) {
			expandSlots(entry.slotOrigin, 3, entry.layout.otherOf, g.getAttribute('aOriginN').array);
			expandSlots(entry.slotVel, 3, entry.layout.otherOf, g.getAttribute('aVelN').array);
			g.getAttribute('aOriginN').needsUpdate = true;
			g.getAttribute('aVelN').needsUpdate = true;
		}
	}
	g.getAttribute('aOrigin').needsUpdate = true;
	g.getAttribute('aVel').needsUpdate = true;
}

/** Stamp every slot's world-space origin at the emitter's current position. @param {any} entry @param {any} object */
function stampAllOrigins(entry, object) {
	object.getWorldPosition(tempPos);
	for (let i = 0; i < entry.count; i++) stampSlot(entry, i, tempPos);
	flushStamps(entry);
}

/** 37-fx: follow the emitter's world velocity (inherit velocity). Each peer measures the
 * motion it SEES — the same stance as the origin stamps: the object's pose is the shared
 * state, the particles are this peer's rendering of it. @param {any} entry @param {any} object */
function trackEmitterVelocity(entry, object) {
	object.getWorldPosition(tempPos);
	const now = performance.now();
	entry.emitNow[0] = tempPos.x;
	entry.emitNow[1] = tempPos.y;
	entry.emitNow[2] = tempPos.z;
	smoothEmitterVelocity(entry.vel, entry.emitSeen ? entry.emitPos : null, entry.emitNow, (now - entry.emitT) / 1000);
	entry.emitPos[0] = tempPos.x;
	entry.emitPos[1] = tempPos.y;
	entry.emitPos[2] = tempPos.z;
	entry.emitT = now;
	entry.emitSeen = true;
}

/** Push the emitter config into the shader uniforms. @param {any} entry @param {any} cfg */
function applyUniforms(entry, cfg) {
	const u = entry.material.uniforms;
	// 'burst' AND 'impact' (PFX-C: fires when physics lands the object) are
	// both one-shot triggered modes in the shader
	u.uMode.value = cfg.mode !== 'continuous' ? 1 : 0;
	entry.mode = cfg.mode; // physics asks hasImpactEmitter() by this
	u.uLifetime.value = cfg.lifetime;
	u.uLifeJitter.value = lifeJitterOf(entry, cfg);
	u.uPhaseNoise.value = phaseNoiseOf(entry);
	// 37-fx: inherit velocity (0..1 of the emitter's speed, world space) and how much path a
	// stretched spark / a trail covers, in seconds
	u.uInherit.value = Math.min(Math.max(Number(cfg.inherit) || 0, 0), 2);
	u.uTrail.value =
		entry.render === 'stretch'
			? Math.min(Math.max(Number(cfg.stretch ?? 0.04) || 0, 0.005), 0.5)
			: Math.min(Math.max(Number(cfg.trail ?? 0.4) || 0, 0.02), 3);
	u.uShape.value = SHAPE_INDEX[/** @type {'cone'} */ (cfg.shape)] ?? 0;
	u.uAngle.value = (cfg.angle * Math.PI) / 180;
	u.uRadius.value = cfg.radius;
	// 36 B3: a box AREA (`area: [w, d]`), constant `wind`, a ground `fall` metres below the
	// emitter where `ground` 'splash' (rain) or 'settle' (snow) happens
	const area = Array.isArray(cfg.area) ? cfg.area : [2, 2];
	u.uArea.value.set((Number(area[0]) || 2) / 2, (Number(area[1]) || 2) / 2);
	const wind = Array.isArray(cfg.wind) ? cfg.wind : [0, 0, 0];
	u.uWind.value.set(Number(wind[0]) || 0, Number(wind[1]) || 0, Number(wind[2]) || 0);
	u.uFall.value = Math.max(0, Number(cfg.fall) || 0);
	u.uGround.value = cfg.ground === 'settle' ? 2 : cfg.ground === 'splash' ? 1 : 0;
	u.uSpeed.value = cfg.speed;
	u.uSpeedJitter.value = cfg.speedJitter;
	u.uGravity.value = cfg.gravity;
	u.uDrag.value = cfg.drag;
	u.uTurbulence.value = cfg.turbulence;
	// PFX-B fix: `size` is an alias for the start size (the wired input handle)
	u.uSizeStart.value = cfg.size ?? cfg.sizeStart;
	u.uSizeEnd.value = cfg.sizeEnd;
	// emission point offset in the object's local frame (vector3 input / Inspector)
	const off = Array.isArray(cfg.offset) ? cfg.offset : [0, 0, 0];
	u.uOffset.value.set(off[0] ?? 0, off[1] ?? 0, off[2] ?? 0);
	u.uSpin.value = cfg.spin;
	u.uColorMode.value = cfg.colorMode === 'particle' ? 1 : 0;
	u.uOpacity.value = cfg.opacity;
	u.uFadeIn.value = cfg.fadeIn;
	u.uFadeOut.value = cfg.fadeOut;
	if (entry.sprite !== cfg.sprite) {
		entry.sprite = cfg.sprite;
		u.uMap.value = spriteTexture(cfg.sprite);
	}
	// PFX-B: a wired `color` input (single value) tints the whole system —
	// it overrides both gradient stops when present
	const cStart = cfg.color ?? cfg.colorStart;
	const cEnd = cfg.color ?? cfg.colorEnd;
	if (entry.colorStart !== cStart) {
		entry.colorStart = cStart;
		u.uColorStart.value.set(cStart);
	}
	if (entry.colorEnd !== cEnd) {
		entry.colorEnd = cEnd;
		u.uColorEnd.value.set(cEnd);
	}
	// Additive (glow) presets — fire, sparkles, sparks — emit from inside the
	// object; depth-testing would hide them behind the mesh, so let them glow
	// through (the standard VFX trick). Normal-blend presets (smoke, confetti,
	// dust) keep depth-testing for correct occlusion.
	const additive = cfg.blending !== 'normal';
	entry.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
	entry.material.depthTest = !additive;
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
	const vr = get(isVRMode) || particlesCapped;
	const tw = wrapTime(time);

	const wanted = new Set();
	for (const { key, uuid, data, object } of live) {
		wanted.add(key);
		const cfg = configOf(data);
		cfg.count = Math.min(Math.max(Math.round(cfg.count), 1), MAX_COUNT);
		const render = renderModeOf(cfg);
		const segs = segmentsOf(cfg, render);
		let entry = entries.get(key);
		if (!entry || entry.count !== cfg.count || entry.render !== render || entry.segs !== segs) {
			dropEntry(entry);
			entry = buildEntry(key, cfg.count, render, segs);
			entries.set(key, entry);
			entry.space = ''; // force the space init below
			// burst/impact emitters idle until triggered, so attaching one would
			// look dead — auto-fire ONCE on (re)build for immediate LOCAL feedback
			// (each peer fires when it builds its own entry; tightly-synced
			// bursts still ride the replicated particleburst timestamp). World
			// origins get stamped in the space-init block below this tick.
			if (cfg.mode !== 'continuous') entry.burstT = tw;
		}
		entry.uuid = uuid;
		refreshLifeCache(entry, cfg);
		applyUniforms(entry, cfg);
		const u = entry.material.uniforms;
		u.uTime.value = tw;
		u.uSizeScale.value = sizeScale;
		// PFX-B: a wired event input fires a burst on its RISING edge (the pulse
		// is high ~0.3s; fire once, not every frame). Each peer sees the pulse
		// via the replicated nodetrigger stamp, so bursts stay ~in sync.
		if (cfg.mode !== 'continuous' && cfg.trigger) {
			if (!entry.lastTrigger) {
				entry.burstT = tw;
				if (cfg.space === 'world') stampAllOrigins(entry, object);
			}
			entry.lastTrigger = true;
		} else {
			entry.lastTrigger = false;
		}
		// Re-fire a burst emitter whenever its LOOK changes (offset, motion,
		// sprite…) so editing — moving the emission origin especially — is visible
		// immediately without a manual trigger. Count changes rebuild the entry
		// (which auto-fires), so they're excluded here.
		if (cfg.mode !== 'continuous') {
			const sig = JSON.stringify([
				cfg.offset, cfg.speed, cfg.gravity, cfg.sizeStart, cfg.size, cfg.lifetime,
				cfg.turbulence, cfg.angle, cfg.radius, cfg.shape, cfg.sprite, cfg.colorStart, cfg.colorEnd,
				cfg.inherit, cfg.stretch, cfg.trail
			]);
			if (entry.cfgSig !== undefined && entry.cfgSig !== sig) {
				entry.burstT = tw;
				if (cfg.space === 'world') stampAllOrigins(entry, object);
			}
			entry.cfgSig = sig;
		}
		u.uBurstT.value = entry.burstT;
		const drawn = vr ? Math.min(cfg.count, VR_MAX_COUNT) : cfg.count;
		entry.geometry.setDrawRange(0, entry.layout ? drawn * entry.layout.indicesPerSlot : drawn);
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
			entry.emitSeen = false;
			entry.vel[0] = entry.vel[1] = entry.vel[2] = 0;
			if (world) stampAllOrigins(entry, object);
		}
		if (world) {
			trackEmitterVelocity(entry, object);
			object.getWorldQuaternion(tempQuat);
			u.uQuat.value.set(tempQuat.x, tempQuat.y, tempQuat.z, tempQuat.w);
			if (cfg.mode !== 'burst') {
				// stamp each slot's spawn point at its rebirth frame (CPU mirror of
				// the shader's cycle math — N writes/second, not per frame)
				object.getWorldPosition(tempPos);
				let dirty = false;
				for (let i = 0; i < entry.count; i++) {
					const cycle = Math.floor((tw - entry.phases[i]) / entry.lives[i]);
					if (cycle !== entry.lastCycle[i]) {
						entry.lastCycle[i] = cycle;
						stampSlot(entry, i, tempPos);
						dirty = true;
					}
				}
				if (dirty) flushStamps(entry);
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

/** PFX-C: does any live emitter on this object fire on physics impact?
 * (covers NODE-based emitters — userData ones are checked directly on the
 * object by physics). @param {string} uuid */
export function hasImpactEmitter(uuid) {
	for (const entry of entries.values())
		if (entry.uuid === uuid && entry.mode === 'impact') return true;
	return false;
}

/** test/debug view of the live emitters */
export function particleEntries() {
	return [...entries.values()].map((entry) => ({
		key: entry.key,
		uuid: entry.uuid,
		count: entry.count,
		render: entry.render,
		segs: entry.segs,
		verts: entry.geometry.getAttribute('position').count,
		drawRange: entry.geometry.drawRange.count,
		vel: [...entry.vel],
		inherit: entry.material.uniforms.uInherit.value,
		trail: entry.material.uniforms.uTrail.value,
		space: entry.space,
		sprite: entry.sprite,
		burstT: entry.burstT,
		uTime: entry.material.uniforms.uTime.value,
		offset: entry.material.uniforms.uOffset.value.toArray(),
		depthTest: entry.material.depthTest,
		visible: entry.points.visible,
		inRoot: entry.points.parent === root
	}));
}
