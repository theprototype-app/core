// VR controls — the module VR hook registries (K1): nav suppressors, panel providers, trigger/grip/frame hooks, world-grab divert.
// 34 R4 (A5): one concern of src/lib/vrControls.js, which re-exports the public names unchanged.

// ---- K1: module VR hooks — feature packs (the vrsleeve core module) plug
// into the VR interaction loop without vrControls importing them (no cycles).
// Each registry returns an unregister fn; callbacks are guarded so a broken
// hook can never take down the frame loop. ----
/** @type {(() => boolean)[]} extra vrNavigationSuppressed() sources */
export const navSuppressors = [];
/** @param {() => boolean} fn @returns {() => void} */
export function registerNavSuppressor(fn) {
	navSuppressors.push(fn);
	return () => {
		const i = navSuppressors.indexOf(fn);
		if (i >= 0) navSuppressors.splice(i, 1);
	};
}
/** @type {(() => any)[]} extra beam-terminating groups (openPanelGroups family) */
export const panelGroupProviders = [];
/** @param {() => any} fn returns a THREE.Group or null @returns {() => void} */
export function registerPanelGroupProvider(fn) {
	panelGroupProviders.push(fn);
	return () => {
		const i = panelGroupProviders.indexOf(fn);
		if (i >= 0) panelGroupProviders.splice(i, 1);
	};
}
/** @type {{start?: (i: number) => boolean, end?: (i: number) => boolean, swallow?: () => boolean}[]} */
const triggerHooks = [];
/** Trigger (select) hooks: `start` may consume a selectstart, `end` a
 * selectend, `swallow` eats the trailing 'select' click (Scene.svelte calls
 * these). @param {{start?: any, end?: any, swallow?: any}} hooks @returns {() => void} */
export function registerVRTriggerHooks(hooks) {
	triggerHooks.push(hooks);
	return () => {
		const i = triggerHooks.indexOf(hooks);
		if (i >= 0) triggerHooks.splice(i, 1);
	};
}
/** 30b (C3): did SOME hook take the last trigger press on each slot? The sweep starts
 * from a non-consuming hook, so it reads this on its next frame to stand down under a
 * gesture another feature claimed (a knob drag, a cable, the sleeve). */
const triggerClaims = [false, false];
/** @param {number} index */
export function triggerClaimed(index) {
	return !!triggerClaims[index];
}
/** @param {number} index @returns {boolean} */
export function vrModuleTriggerStart(index) {
	const claimed = triggerHooks.some((h) => {
		try {
			return !!h.start?.(index);
		} catch (error) {
			console.log('VR trigger hook failed', error);
			return false;
		}
	});
	triggerClaims[index] = claimed;
	return claimed;
}
/** @param {number} index @returns {boolean} */
export function vrModuleTriggerEnd(index) {
	return triggerHooks.some((h) => {
		try {
			return !!h.end?.(index);
		} catch (error) {
			console.log('VR trigger hook failed', error);
			return false;
		}
	});
}
/** @returns {boolean} */
export function vrModuleSelectSwallowed() {
	return triggerHooks.some((h) => {
		try {
			return !!h.swallow?.();
		} catch {
			return false;
		}
	});
}
/** @type {((object: any, before: any) => boolean)[]} K2: grip-release interceptors */
export const gripDropHooks = [];
/** A hook may CONSUME a grip-grab release (e.g. dropping an object onto the
 * sleeve captures a slot instead of committing the move). It must restore the
 * object itself; return true to skip the normal endGrab commit.
 * @param {(object: any, before: any) => boolean} fn @returns {() => void} */
export function registerGripDropHook(fn) {
	gripDropHooks.push(fn);
	return () => {
		const i = gripDropHooks.indexOf(fn);
		if (i >= 0) gripDropHooks.splice(i, 1);
	};
}
/** @type {(() => void)[]} per-frame hooks (run inside updateVRControls) */
export const vrFrameHooks = [];
/** @param {() => void} fn @returns {() => void} */
export function registerVRFrameHook(fn) {
	vrFrameHooks.push(fn);
	return () => {
		const i = vrFrameHooks.indexOf(fn);
		if (i >= 0) vrFrameHooks.splice(i, 1);
	};
}
/** @type {{active?: () => boolean, apply?: (grab: {start: {a: number[], b: number[]}, now: {a: number[], b: number[]}, rig0: any}) => boolean}[]} */
export const worldGrabDiverts = [];
/** CO2: a hook may take over the WORLD gestures. `apply` receives the live two-grip
 * grab (start/now hand positions + the rig's start state) each frame and returns true
 * to CONSUME it — colocation diverts the gesture into the replicated roomAnchor
 * instead of bending the local rig. `active` answers "does a divert currently claim
 * the world?", which is what stops the single-grip world PAN from starting: the pan
 * offsets the XR reference space, a rig-free way to silently break a colocated
 * alignment. @param {{active?: any, apply?: any}} hooks @returns {() => void} */
export function registerWorldGrabDivert(hooks) {
	worldGrabDiverts.push(hooks);
	return () => {
		const i = worldGrabDiverts.indexOf(hooks);
		if (i >= 0) worldGrabDiverts.splice(i, 1);
	};
}
/** @returns {boolean} */
export function worldGestureDiverted() {
	return worldGrabDiverts.some((h) => {
		try {
			return !!h.active?.();
		} catch {
			return false;
		}
	});
}
