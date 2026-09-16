import { writable, get } from 'svelte/store';
import { objectsGroup, globalRenderer, pokeScene } from '../stores/sceneStore';
import { BUDGETS, profileFor, registerFrameObserver } from './sceneBudget';

// 26-G (roadmap 26 section 4, Stages 3 and 4) — WHEN THE SCENE IS TOO HEAVY TO RUN.
//
// Stages 0-2 stop the app freezing on the way IN. This is what happens once a heavy
// scene is already here and the device cannot keep up: a simulation that takes longer
// to step than a frame lasts, or a render loop so slow the window stops answering.
//
// THE PRINCIPLE, the roadmap's: the main thread must never run an unbounded loop in
// response to input it did not schedule. Every stop here is ONCE per streak, REVERSIBLE,
// and SAYS SO — an automatic action the user cannot see and cannot undo is just a
// different kind of broken.
//
// The context-loss half of Stage 4 already shipped in 27-G (`ContextLostOverlay`, the
// canvas listeners, the recompile sweep). This does not rebuild it: a lost context is
// shown by that overlay, and the paused overlay stands down whenever it is up.
//
// A LEAF over svelte/store, the scene store and sceneBudget. physics.js imports the
// streak watch from here, which is why nothing here may reach the history family.

/**
 * A "N bad samples IN A ROW" detector that fires ONCE per streak. PURE given its inputs,
 * so the rule is provable with no GPU and no physics world.
 *
 * Consecutive, not cumulative: one 300ms hitch while a texture uploads is not a scene
 * that is too heavy, and a trigger that fired on it would stop somebody's simulation
 * because they imported a picture.
 * @param {{overMs: number, count: number}} opts
 */
export function createStreakWatch({ overMs, count }) {
	let streak = 0;
	let fired = false;
	return {
		/** @param {number} ms @returns {boolean} true exactly once, on the sample that completes a streak */
		note(ms) {
			if (!(ms > overMs)) {
				streak = 0;
				fired = false;
				return false;
			}
			streak++;
			if (streak >= count && !fired) {
				fired = true;
				return true;
			}
			return false;
		},
		reset() {
			streak = 0;
			fired = false;
		},
		streak: () => streak
	};
}

// --- Stage 3: the physics budget -------------------------------------------------

/** Step time past which a simulation is not keeping up: a 24ms step on a 16.7ms frame
 * means every frame is late before rendering even starts. */
export const PHYSICS_SLOW_MS = 24;
/** …for this many steps in a row (half a second at 60Hz). */
export const PHYSICS_SLOW_STEPS = 30;

// --- Stage 4: the render freeze ---------------------------------------------------

/** A frame that takes this long is the window visibly not answering. */
export const FREEZE_FRAME_MS = 250;
/** …for this many frames in a row, i.e. at least 2.5 seconds of a frozen tab. */
export const FREEZE_FRAMES = 10;

/** The pause, or null. `reason` says which trigger fired. LOCAL — a pause is about THIS
 * device's GPU, so it never replicates. */
/** @type {import('svelte/store').Writable<{reason: string, at: number} | null>} */
export const renderPaused = writable(null);

const freezeWatch = createStreakWatch({ overMs: FREEZE_FRAME_MS, count: FREEZE_FRAMES });
/** After a resume the next few frames are expected to be slow (the first composer frame
 * recompiles) — a grace window stops Resume from immediately re-pausing. */
const RESUME_GRACE_MS = 3000;
let graceUntil = 0;
let wasHidden = false;

/**
 * Fed every frame by sceneBudget's loop. Three things are NOT a frozen scene and must
 * never trip it: a backgrounded tab (the browser throttles rAF to ~1Hz on purpose), the
 * first frame after the tab comes back (its delta spans the whole absence), and the
 * seconds straight after a resume.
 * @param {number} ms
 */
export function noteFrameForFreeze(ms) {
	if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
		wasHidden = true;
		freezeWatch.reset();
		return false;
	}
	if (wasHidden) {
		wasHidden = false;
		freezeWatch.reset();
		return false;
	}
	if (get(renderPaused) || Date.now() < graceUntil) return false;
	if (freezeWatch.note(ms)) {
		pauseRendering('frozen');
		return true;
	}
	return false;
}

/** @param {string} reason */
export function pauseRendering(reason) {
	if (get(renderPaused)) return;
	renderPaused.set({ reason, at: Date.now() });
}

export function resumeRendering() {
	renderPaused.set(null);
	freezeWatch.reset();
	graceUntil = Date.now() + RESUME_GRACE_MS;
}

// --- Reduce: take the scene down to the budget, LOCALLY ----------------------------
//
// "Hiding the newest objects" — but NOT with `visible = false`. Autosave exports the
// scene through GLTFExporter with no options, and `onlyVisible` DEFAULTS TO TRUE, so a
// hidden object is silently DROPPED from the recovery snapshot. Reducing a scene would
// then quietly delete its newest objects from the one copy meant to survive a crash —
// and the overlay promises autosave keeps running.
//
// A render LAYER is invisible to every serializer (GLTFExporter never reads layers,
// toJSON writes the mask but nothing reads it back as visibility), never replicates, and
// is honoured by the camera's cull and the raycaster alike. So a reduced object is still
// in the scene, in the save, on the wire and in the undo stack — it is simply not drawn
// or picked HERE. The original masks live in a WeakMap, never on userData, so they cannot
// leak into a file.

/** The layer reduced objects are moved to. 31 is the last of three's 32 layers and
 * nothing in this app enables it on a camera. */
export const REDUCED_LAYER = 31;

/** @type {Map<string, WeakMap<any, number>>} per reduced ROOT uuid, each node's mask */
const reduced = new Map();
export const reducedObjects = writable(0);

/** @param {any} node */
function countNodes(node) {
	let n = 0;
	node.traverse((/** @type {any} */ o) => {
		n++;
	});
	return n;
}

/**
 * Stop drawing the newest top-level objects until what is still drawn is inside the
 * object budget for this device. Returns how many were set aside.
 * @param {'desktop'|'vr'} [profile]
 */
export function reduceScene(profile) {
	const group = get(objectsGroup);
	if (!group) return 0;
	const which = profile ?? profileFor(get(globalRenderer));
	const budget = BUDGETS.find((b) => b.key === 'objects');
	const limit = budget ? (which === 'vr' ? budget.vr[1] : budget.desktop[1]) : Infinity;
	let drawn = 0;
	for (const child of group.children) if (!reduced.has(child.uuid)) drawn += countNodes(child);
	let setAside = 0;
	// NEWEST FIRST: children are in append order, so the end of the list is what arrived
	// last — most likely whatever tipped the scene over
	for (let i = group.children.length - 1; i >= 0 && drawn > limit; i--) {
		const root = group.children[i];
		if (reduced.has(root.uuid)) continue;
		/** @type {WeakMap<any, number>} */
		const masks = new WeakMap();
		root.traverse((/** @type {any} */ node) => {
			masks.set(node, node.layers.mask);
			node.layers.set(REDUCED_LAYER);
		});
		reduced.set(root.uuid, masks);
		drawn -= countNodes(root);
		setAside++;
	}
	reducedObjects.set(reduced.size);
	if (setAside) pokeScene();
	return setAside;
}

/** Draw everything `reduceScene` set aside again, exactly as it was. */
export function restoreReduced() {
	const group = get(objectsGroup);
	let restored = 0;
	for (const [uuid, masks] of reduced) {
		const root = group?.getObjectByProperty?.('uuid', uuid);
		if (root) {
			root.traverse((/** @type {any} */ node) => {
				const mask = masks.get(node);
				// a node added under a reduced root since (a child attached later) had no
				// saved mask — give it the default layer rather than leaving it stranded
				node.layers.mask = mask ?? 1;
			});
			restored++;
		}
	}
	reduced.clear();
	reducedObjects.set(0);
	if (restored) pokeScene();
	return restored;
}

/** Is this object set aside? For the suite and any list that wants to say so. @param {string} uuid */
export function isReduced(uuid) {
	return reduced.has(uuid);
}

// The frame observer. Registered here, not imported by sceneBudget, so the budget
// module stays a leaf that knows nothing about pausing.
registerFrameObserver(noteFrameForFreeze);
