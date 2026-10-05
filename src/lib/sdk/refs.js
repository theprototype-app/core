// Module SDK — the primed dynamic-import refs (live bindings — read them, never assign them outside this file).

// input/physics are reached via primed DYNAMIC imports: static edges would close
// cycles back into this module (flowRuntime -> moduleSDK; physics -> flowRuntime)
// — the vite-dev TDZ trap. The refs resolve at boot, long before any module
// frame task polls them; the fallbacks cover the first few frames.
/** @type {any} */ export let inputRuntimeRef = null;
/** @type {any} */ export let physicsRef = null;
/** @type {any} */ export let possessRef = null;
/** @type {any} */ export let vrControlsRef = null;
/** @type {any} */ export let addObjectsRef = null;
/** @type {any} */ export let jointsRef = null;
/** @type {any} */ export let objectActionsRef = null;
/** @type {any} */ export let pingAudioRef = null;
/** @type {any} */ export let packBehaviorRef = null; // 33 P2 (api.behavior)
/** @type {any} */ export let audioEngineRef = null;
/** @type {any} */ export let musicClockRef = null;
/** @type {any} */ export let audioDevicesRef = null;
/** @type {any} */ export let audioPatchRef = null;
/** @type {any} */ export let soundRuntimeRef = null;
/** 21-E7.1: primed for api.hud.rows — a fresh import().then() per push drops the first
 * seconds of them (the DEVX #8 family). @type {any} */
export let flowRuntimeRef = null;
/** R3a: primed for api.flow.addNodes — flowGraphs' BODY calls registerHistoryKind, so a
 * static edge from here (which history reaches through flowRuntime) TDZ-crashes the SSR
 * prerender. @type {any} */
export let flowGraphsRef = null;
/** R3a: primed for api.flow.addNodes' spec defaults — nodeCatalog statically imports
 * THIS module, so a static edge back is a direct cycle. @type {any} */
export let nodeCatalogRef = null;
/** 24-A A2: primed for api.onHit / api.hitLog — knock.js imports physics, which imports
 * flowRuntime, which imports THIS module (the same cycle as the refs above). The promise
 * is kept as well as the ref, because a listener registered at module boot must not be
 * dropped for arriving before the import settles (the DEVX #8 family). @type {any} */
export let knockRef = null;
/** @type {Promise<any>} */
export let knockReady = Promise.resolve(null);
/** 30b: primed for api.effects (effectsBurst imports moduleFrameTasks from here) @type {any} */
export let effectsRef = null;
/** 36-water: primed for api.water (waterActions reaches the history family) @type {any} */
export let waterActionsRef = null;
if (typeof window !== 'undefined') {
	knockReady = import('../knock').then((m) => (knockRef = m));
	import('../inputRuntime').then((m) => (inputRuntimeRef = m));
	import('../physics').then((m) => (physicsRef = m));
	import('../possess').then((m) => (possessRef = m));
	import('../vrControls').then((m) => (vrControlsRef = m));
	import('../addObjects').then((m) => (addObjectsRef = m));
	import('../joints').then((m) => (jointsRef = m));
	import('../objectActions').then((m) => (objectActionsRef = m));
	import('../pingAudio').then((m) => (pingAudioRef = m));
	import('../packBehavior').then((m) => (packBehaviorRef = m));
	// 23-A5: the audio stack — engine (a leaf, but kept dynamic with its siblings so the
	// four resolve together), clock, devices, patch, and the sample loader
	import('../audioEngine').then((m) => (audioEngineRef = m));
	import('../musicClock').then((m) => (musicClockRef = m));
	import('../audioDevices').then((m) => (audioDevicesRef = m));
	import('../audioPatch').then((m) => (audioPatchRef = m));
	import('../soundRuntime').then((m) => (soundRuntimeRef = m));
	import('../flowRuntime').then((m) => (flowRuntimeRef = m));
	import('../flowGraphs').then((m) => (flowGraphsRef = m));
	import('../nodeCatalog').then((m) => (nodeCatalogRef = m));
	// 30b (C6): the burst pool reads moduleFrameTasks from here, so the edge back is dynamic
	import('../effectsBurst').then((m) => (effectsRef = m));
	import('../water/waterActions.js').then((m) => (waterActionsRef = m));
}

export function inputApi() {
	return (
		inputRuntimeRef ?? {
			getInput: () => ({ codes: new Set(), axes: { lx: 0, ly: 0, rx: 0, ry: 0 }, vrButtons: {} })
		}
	);
}
export function physicsApi() {
	return physicsRef;
}
