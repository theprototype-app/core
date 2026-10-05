import { writable, get } from 'svelte/store';

// 33 L1 — A SCENE LOAD MAY TAKE TIME; IT MAY NOT TAKE THE WINDOW.
//
// THE REPORT: on a phone, Restore after a reload with Castle Courtyard open hung the whole
// window, and so did opening other scenes. Every load path ran its object loop in ONE task
// (parse every element, add it, broadcast its toJSON), and every kit piece refilled in one
// more burst when its pack file resolved — all copies of a wall continue in the same task.
// The measurement is in the 33-scene-load handover; this leaf is the answer to it:
//
//   * `slice()` — a cooperative yield for a LOOP: returns at once while the current slice is
//     under budget, otherwise gives the event loop a turn (input, paint, the progress bar)
//     before the loop continues. A load is therefore many ~10 ms tasks instead of one long one.
//   * `schedule(fn)` — the same budget for work that arrives as MANY independent promise
//     continuations (twelve walls waiting on one pack file): each becomes a queue item and one
//     pump runs them a slice at a time, because N continuations that each check a clock all
//     run inside the one task that resolved their promise.
//   * `sceneLoad` — the job being loaded ({name, total, done, phase}), rendered by
//     SceneLoadBar.svelte as a non-modal bar with Cancel. ONE job at a time: starting a load
//     supersedes the previous one, whose loop sees `cancelled` at its next slice and stops.
//
// A LEAF: svelte/store only. sessions, autosave and packRefs import it; it imports nothing
// back, so it can sit under any of the documented cycles.

/** Work budget per slice. 10 ms leaves a 60 Hz frame room to paint and take input. */
export const SLICE_MS = 10;

/**
 * @typedef {{id: number, name: string, verb: string, total: number, done: number, phase: string,
 *   cancellable: boolean, startedAt: number, cancelled: boolean, interrupted: boolean,
 *   orphaned: (() => void)[]}} LoadJob
 * `interrupted`: this load superseded one that was still BUILDING its scene — what is on
 * screen is half of somebody else's load, not the user's work (no backup is owed for it).
 */

/** The load in progress, or null. LOCAL — never replicated, saved or undone.
 * @type {import('svelte/store').Writable<LoadJob | null>} */
export const sceneLoad = writable(/** @type {LoadJob | null} */ (null));

/** Thrown out of `slice(job)` when that job was cancelled or superseded. */
export class LoadCancelled extends Error {
	constructor() {
		super('scene load cancelled');
		this.name = 'LoadCancelled';
	}
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** @type {MessageChannel | null} */
let channel = null;
/** @type {(() => void)[]} */
const waiting = [];

/**
 * Give the event loop one turn. `scheduler.yield()` where it exists (it keeps our
 * continuation ahead of other queued work); otherwise a MessageChannel message, which —
 * unlike setTimeout — carries no 4 ms clamp and is not stretched to 1 s in a background tab.
 * @returns {Promise<void>}
 */
export function yieldToEventLoop() {
	const g = /** @type {any} */ (globalThis);
	if (g.scheduler?.yield) return g.scheduler.yield();
	if (typeof MessageChannel === 'undefined') return new Promise((r) => setTimeout(r, 0));
	if (!channel) {
		channel = new MessageChannel();
		channel.port1.onmessage = () => waiting.shift()?.();
	}
	return new Promise((resolve) => {
		waiting.push(resolve);
		/** @type {MessageChannel} */ (channel).port2.postMessage(0);
	});
}

let sliceStart = now();

/**
 * Inside a load loop: return immediately while the slice has budget left, else yield and
 * start a new slice. With a job, a cancelled/superseded job throws `LoadCancelled` here, so
 * a loop stops at a clean point between two objects.
 * @param {LoadJob | null} [job]
 */
export async function slice(job = null) {
	if (job?.cancelled) throw new LoadCancelled();
	if (now() - sliceStart < SLICE_MS) return;
	await yieldToEventLoop();
	sliceStart = now();
	if (job?.cancelled) throw new LoadCancelled();
}

/** Start a fresh slice clock (call before a loop that must not inherit a spent budget). */
export function resetSlice() {
	sliceStart = now();
}

/** @type {{fn: () => any, resolve: (v: any) => void, reject: (e: any) => void}[]} */
const queue = [];
let pumping = false;

async function pump() {
	if (pumping) return;
	pumping = true;
	try {
		while (queue.length) {
			// the budget is SHARED with every other pump run and every `slice()`: a loop that
			// awaits one scheduled item at a time starts a fresh pump per item, chained through
			// microtasks — with a per-run budget that whole loop was ONE task (measured: an 881 ms
			// task of program warm-up items, each well under the budget on its own)
			if (now() - sliceStart >= SLICE_MS) {
				await yieldToEventLoop();
				sliceStart = now();
			}
			const item = /** @type {any} */ (queue.shift());
			try {
				item.resolve(item.fn());
			} catch (error) {
				item.reject(error);
			}
		}
	} finally {
		pumping = false;
	}
}

/**
 * Run a piece of SYNCHRONOUS work inside the shared slice budget. Items run in arrival
 * order, as many per task as fit in `SLICE_MS` — the same clock `slice()` keeps — so a burst
 * of continuations, or a loop awaiting one item at a time, spreads over several tasks.
 * @template T @param {() => T} fn @returns {Promise<T>}
 */
export function schedule(fn) {
	return new Promise((resolve, reject) => {
		queue.push({ fn, resolve, reject });
		// a microtask, so a burst that queues in one task pumps once
		queueMicrotask(pump);
	});
}

/** How many scheduled items wait (the suite and the bar read it). */
export function scheduledCount() {
	return queue.length;
}

/** Pokes the scene at most every this many ms while a load builds it. Every poke re-runs
 * every objectsGroup subscriber (the object list re-renders the whole tree), so a poke per
 * object turned the list into the load's biggest cost; four a second still shows it grow. */
export const LOAD_POKE_MS = 250;

/**
 * A throttle for a load loop's scene pokes: call it per object, it calls `poke` at most
 * every LOAD_POKE_MS. The loop pokes once more when it ends.
 * @param {() => void} poke @returns {() => void}
 */
export function throttledPoke(poke) {
	let last = 0;
	return () => {
		const t = now();
		if (t - last < LOAD_POKE_MS) return;
		last = t;
		poke();
	};
}

/** The longest the viewport may hold its last frame, whatever asked. */
export const HOLD_MAX_MS = 2000;
let holdUntil = 0;

/**
 * Hold the viewport on its last frame for a moment (bounded by HOLD_MAX_MS): a scene replace
 * changes the environment — fog, light count — which re-keys EVERY material's program, and the
 * first frame after it linked them all inside one render call (the last long task of a load).
 * While held, Outline.svelte skips its render; the canvas keeps what it showed (a frame that
 * draws nothing is not composited), and the DOM — the load bar, menus — carries on.
 * @param {number} [ms]
 */
export function holdFrames(ms = HOLD_MAX_MS) {
	holdUntil = Math.max(holdUntil, now() + Math.min(ms, HOLD_MAX_MS));
}

/** Let the viewport draw again. */
export function releaseFrames() {
	holdUntil = 0;
}

/** Is the viewport being held? Read per frame by Outline.svelte. */
export function framesHeld() {
	return holdUntil > 0 && now() < holdUntil;
}

/**
 * Wait for `n` frames to be drawn (or ~100 ms each where rAF does not run — a background tab).
 * A load applies the scene's LOOK first and lets a frame or two of the near-empty scene absorb
 * the program changes it causes (the post stack's composite shader, the re-keyed helpers), so
 * that work is not stacked onto the first frame of the full scene.
 * @param {number} [n]
 */
export async function nextFrames(n = 2) {
	for (let i = 0; i < n; i++)
		await new Promise((resolve) => {
			const timer = setTimeout(resolve, 100);
			if (typeof requestAnimationFrame === 'function')
				requestAnimationFrame(() => {
					clearTimeout(timer);
					resolve(true);
				});
		});
}

/** How long a load waits for a program warm-up before going on regardless. */
export const WARM_WAIT_MS = 1200;

/**
 * Wait for `promise`, but never longer than `ms`: the work it stands for carries on either way.
 * A program warm-up on a slow driver (software GL links a program in hundreds of ms) must
 * delay a load by a bounded moment, never by however long the driver takes.
 * @param {Promise<any>} promise @param {number} ms
 */
export function within(promise, ms) {
	return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
}

/** @type {(() => Promise<any>) | null} */
let composerWarm = null;

/**
 * The post-processing composer's warm-up, registered by Outline.svelte (which owns the
 * composer — a seam, the registerToneMappingOwner shape, so no module imports the component).
 * @param {(() => Promise<any>) | null} fn
 */
export function registerComposerWarm(fn) {
	composerWarm = fn;
}

/** Compile the composer's pass shaders off-frame (a no-op with no composer registered). */
export function warmComposer() {
	return composerWarm ? composerWarm().catch(() => {}) : Promise.resolve();
}

let nextId = 0;
/** @type {LoadJob | null} */
let current = null;
/** @type {Set<() => void>} */
const cancelHooks = new Set();

function publish() {
	sceneLoad.set(current ? { ...current } : null);
}

/**
 * Begin a load. A load already running is SUPERSEDED (cancelled) — starting another scene
 * cancels the first one cleanly, at its next slice.
 * @param {string} name what the bar says ("Loading <name>")
 * @param {number} total objects this load will bring
 * @param {{cancellable?: boolean, phase?: string, verb?: string}} [opts]
 * @returns {LoadJob}
 */
export function beginLoad(name, total, opts = {}) {
	// only the BUILDING phase leaves a half scene behind ('fetching'/'preparing'/'reading'
	// have not touched the scene yet; 'models' means it is whole)
	// (or a claim that superseded such a load and had not cleared it yet — 36 F20)
	const interrupted = !!current && (current.phase === 'objects' || current.orphaned?.length > 0);
	// 36 F20: a CLAIM (a click whose file is still downloading) supersedes a load that is
	// building, but it has not cleared anything yet: if the claim is then dropped (a declined
	// dialog, a failed fetch), the half scene it stopped is taken back by that load's own
	// Cancel — see `endLoad`. A load that applies takes it over by clearing (`adoptLoad`).
	const orphaned = !current ? [] : current.phase === 'objects' ? [...cancelHooks] : [...(current.orphaned ?? [])];
	if (current) cancelLoad({ superseded: true });
	current = {
		interrupted,
		orphaned,
		id: ++nextId,
		name: String(name || 'scene'),
		verb: opts.verb ?? 'Loading',
		total: Math.max(0, total | 0),
		done: 0,
		phase: opts.phase ?? 'objects',
		cancellable: opts.cancellable !== false,
		startedAt: Date.now(),
		cancelled: false
	};
	resetSlice();
	publish();
	return current;
}

/** Throttled progress publication: the bar is DOM, so ~10 updates a second is plenty. */
let publishTimer = /** @type {any} */ (null);
function publishSoon() {
	if (publishTimer) return;
	publishTimer = setTimeout(() => {
		publishTimer = null;
		publish();
	}, 100);
}

/** @param {LoadJob} job @param {number} [n] */
export function progress(job, n = 1) {
	if (job !== current) return;
	job.done = Math.min(job.total, job.done + n);
	publishSoon();
}

/** @param {LoadJob} job @param {{total?: number, phase?: string, cancellable?: boolean}} patch */
export function updateLoad(job, patch) {
	if (job !== current) return;
	if (patch.total != null) job.total = Math.max(job.done, patch.total | 0);
	if (patch.phase != null) job.phase = patch.phase;
	if (patch.cancellable != null) job.cancellable = patch.cancellable;
	publish();
}

/** @param {LoadJob | null} job */
export function endLoad(job) {
	if (!job || job !== current) return;
	current = null;
	cancelHooks.clear();
	clearTimeout(publishTimer);
	publishTimer = null;
	publish();
	// 36 F20: a claim that ends WITHOUT having replaced the scene, over the half scene of
	// the load it superseded — that load's own Cancel takes its half back
	runHooks(job.orphaned);
	job.orphaned = [];
}

/** @param {(() => void)[]} hooks */
function runHooks(hooks) {
	for (const hook of hooks) {
		try {
			hook();
		} catch {}
	}
}

// ---- 36 F20: A LOAD BELONGS TO THE CLICK THAT ASKED FOR IT -------------------------------
//
// THE REPORT (1.23, production): open Island Ocean (a slow first load), open another level
// meanwhile — and later the island finished and REPLACED the level the user had opened.
// Every person-facing route into a scene replace awaits something BEFORE `applySession`
// began its job (the template's download, the unzip, the format / module / size dialogs,
// the keep-or-unload ask, an idb read), and during that wait the click owned no job: the
// second scene began, loaded and ended, and then the first one's `applySession` started
// as the newest load of all and won.
//
// So the job begins AT THE CLICK. `claimLoad` opens it in the 'fetching' phase (the bar
// says so at once — 36 F21), supersedes whatever was loading, and every await on the way
// to the apply is followed by `isLive(job)`; `applySession(payload, {job})` adopts the claim
// instead of beginning a new job. A claim superseded by a newer click is simply never
// applied — the newer click is the user's answer.

/**
 * Begin a load for a click whose payload is not here yet (download, unzip, dialogs).
 * @param {string} name @param {{verb?: string}} [opts]
 */
export function claimLoad(name, opts = {}) {
	return beginLoad(name, 0, { phase: 'fetching', verb: opts.verb });
}

/**
 * The claim reached its apply: true when it is still the load to run (then it is renamed
 * to the payload and counted from now), false when a newer load or Cancel took over.
 * @param {LoadJob} job @param {{name?: string, total?: number}} patch
 */
export function adoptLoad(job, patch = {}) {
	if (!isLive(job)) return false;
	if (patch.name) job.name = String(patch.name);
	if (patch.total != null) job.total = Math.max(0, patch.total | 0);
	job.done = 0;
	job.phase = 'preparing';
	publish();
	return true;
}

/** The apply has cleared the scene: a superseded load's half is gone with it.
 * @param {LoadJob} job */
export function scenesCleared(job) {
	job.orphaned = [];
}

/** Is THIS job still the one loading (not cancelled, not superseded)? @param {LoadJob} job */
export function isLive(job) {
	return job === current && !job.cancelled;
}

/** Is any load running? Autosave and the bar read it. */
export function loading() {
	return current !== null;
}

/**
 * Register what Cancel must undo for the running load (the caller's own cleanup — a
 * session load clears what it had added). Hooks run once, on cancel only.
 * @param {() => void} fn
 */
export function onCancel(fn) {
	cancelHooks.add(fn);
	return () => cancelHooks.delete(fn);
}

/**
 * Cancel the running load: the bar's Cancel, or a newer load SUPERSEDING it. Only a user
 * cancel runs the load's undo hooks — a superseding load clears the scene itself.
 * @param {{superseded?: boolean}} [opts]
 */
export function cancelLoad(opts = {}) {
	const job = current;
	if (!job) return;
	job.cancelled = true;
	const hooks = opts.superseded ? [] : [...cancelHooks];
	current = null;
	cancelHooks.clear();
	clearTimeout(publishTimer);
	publishTimer = null;
	publish();
	// a user Cancel of a CLAIM over a half scene takes that half back too (36 F20)
	runHooks(opts.superseded ? [] : [...hooks, ...(job.orphaned ?? [])]);
	if (!opts.superseded) job.orphaned = [];
}

/** For the suite: the job object itself (not the published copy). */
export function currentJob() {
	return current;
}

/** Resolve when no load is running. */
export function loadSettled() {
	return new Promise((resolve) => {
		if (!get(sceneLoad)) return resolve(true);
		/** @type {any} */
		let off = null;
		off = sceneLoad.subscribe((v) => {
			if (v) return;
			queueMicrotask(() => off?.());
			resolve(true);
		});
	});
}
