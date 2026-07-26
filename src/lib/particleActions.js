import { get } from 'svelte/store';
import { objectsGroup, selectedObject } from '../stores/sceneStore';
import { peers } from '../stores/appStore';
import { recordEntry } from './history';
import { particlePreset, PARTICLE_DEFAULTS } from './particlePresets';
import { applyBurst } from './particleRuntime';

// Replicating particle-emitter mutators (PFX-A). Config lives on
// userData.particles (plain JSON -> replicates via objectParameters, rides
// GLTF extras / sessions / autosave like userData.physics). Each edit records
// a 'props' undo entry (the handler in objectActions replays it) and the
// runtime picks the change up on its next tick sweep — no poke needed for
// rendering, only for the UI lists.
//
// This module reaches history — it must NEVER be imported by particleRuntime
// (flowRuntime's subtree) or the history TDZ-cycle family bites.

/** @param {string} uuid */
function objectOf(uuid) {
	return get(objectsGroup)?.getObjectByProperty('uuid', uuid);
}

/** poke the stores so the Inspector/object list re-render */
function poke() {
	objectsGroup.update((v) => v);
	selectedObject.update((v) => v);
}

/**
 * Set (or clear, with null) an object's emitter config — local apply +
 * objectParameters replication + one undoable props entry.
 * @param {string} uuid @param {any} config
 */
export function setObjectParticles(uuid, config) {
	const object = objectOf(uuid);
	if (!object) return;
	const before = object.userData.particles ? { ...object.userData.particles } : null;
	if (config) object.userData.particles = config;
	else delete object.userData.particles;
	recordEntry({ kind: 'props', uuid, before: { particles: before }, after: { particles: config ?? null } });
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'objectParameters', parameter: 'particles', uuid, particles: config ?? null });
	poke();
}

/** Attach a preset emitter. @param {string} uuid @param {string} presetKey */
export function addParticlesPreset(uuid, presetKey) {
	setObjectParticles(uuid, particlePreset(presetKey));
}

/** Merge a patch into the existing emitter config. @param {string} uuid @param {any} patch */
export function updateObjectParticles(uuid, patch) {
	const object = objectOf(uuid);
	if (!object) return;
	setObjectParticles(uuid, { ...PARTICLE_DEFAULTS, ...(object.userData.particles ?? {}), ...patch });
}

/** Remove the emitter. @param {string} uuid */
export function removeObjectParticles(uuid) {
	setObjectParticles(uuid, null);
}

/**
 * Fire the object's burst-mode emitters NOW for every peer: apply locally and
 * replicate the shared timestamp (receivers apply without re-broadcast).
 * PFX-C's ground-impact detection reuses this exact message.
 * @param {string} uuid
 */
export function burstObjectParticles(uuid) {
	const t = (Date.now() % 86400000) / 1000; // same formula as the flow tick clock
	applyBurst(uuid, t);
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send({ type: 'particleburst', uuid, t });
}
