// 102 M7 — THE BOOT-PATH FACE OF CONSTRAINTS. Scene, flowRuntime, the appliers and the GLTF export
// call this tiny module (svelte/store + the objects group, no three) instead of the runtime, so a
// page that never meets a constraint never fetches the solver (boot-size budget). Until the runtime
// is loaded, the hub looks for `userData.constraints` once a second (and at once after a dirty mark:
// an applier, an undo, the Inspector); the first sighting imports constraintRuntime + the viewport
// helpers, and from then on every call forwards. Nothing here changes a pose: before the runtime
// exists no constraint has run, so there is no base to park and nothing to hold.

import { get } from 'svelte/store';
import { objectsGroup } from '../../stores/sceneStore';

const SCAN_MS = 1000;

/** @type {typeof import('./constraintLazy.js') | null} */
let runtime = null;
/** @type {Promise<void> | null} */
let loading = null;
let dirty = false;
let lastScan = -Infinity;

/** load the runtime + helpers (once); resolves when both are in */
export function loadConstraintRuntime() {
	if (!loading)
		loading = import('./constraintLazy.js').then((r) => {
			runtime = r;
			r.markConstraintsDirty();
		});
	return loading;
}

/** @param {any} group */
function anyConstrained(group) {
	let found = false;
	group?.traverse?.((/** @type {any} */ n) => {
		if (!found && Array.isArray(n.userData?.constraints) && n.userData.constraints.length) found = true;
	});
	return found;
}

/** something wrote a constraint list (applier, undo, Inspector) */
export function markConstraintsDirty() {
	if (runtime) runtime.markConstraintsDirty();
	else dirty = true;
}

/**
 * Once a frame (Scene's useTask, after the sequencer). Returns how many constraints ran.
 * @param {{now?: number, physicsRunning?: boolean}} [opts]
 */
export function tickConstraints(opts = {}) {
	if (runtime) return runtime.tickConstraints(opts);
	if (loading) return 0;
	const now = opts.now ?? performance.now();
	if (!dirty && now - lastScan < SCAN_MS) return 0;
	dirty = false;
	lastScan = now;
	if (anyConstrained(get(objectsGroup))) void loadConstraintRuntime();
	return 0;
}

/** @param {any} scene @param {any} group @param {any[]} selected */
export function updateConstraintHelpers(scene, group, selected) {
	runtime?.updateConstraintHelpers(scene, group, selected);
}

/** @param {string} uuid */
export function holdConstraints(uuid) {
	runtime?.holdConstraints(uuid);
}

/** @param {string} uuid */
export function releaseConstraints(uuid) {
	runtime?.releaseConstraints(uuid);
}

/**
 * A flow node's override (re-sent every frame while it runs, so a call before the load is simply
 * the first frame that does nothing). @param {string} uuid @param {string} id @param {{weight?: number, target?: {uuid: string, bone?: string} | null}} patch
 */
export function setConstraintOverride(uuid, id, patch) {
	if (runtime) runtime.setConstraintOverride(uuid, id, patch);
	else void loadConstraintRuntime();
}

/** GLTF "Bake constraints": parks inside `fn` keep constrained poses. @template T @param {() => T} fn @returns {T} */
export function withConstraintsPosed(fn) {
	return runtime ? runtime.withConstraintsPosed(fn) : fn();
}

/** tests: forget the loaded runtime */
export function resetConstraintHubForTest() {
	runtime = null;
	loading = null;
	dirty = false;
	lastScan = -Infinity;
}
