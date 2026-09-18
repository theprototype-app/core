import { writable, get } from 'svelte/store';
import { objectsGroup, globalRenderer } from '../stores/sceneStore';
import { coarsePointer } from './inputDevice';

// 26-A (roadmap 26 sections 2 and 3) — WHAT THE SCENE COSTS, AND WHETHER THAT IS A LOT.
//
// THE FINDING: there was no scene-level budget anywhere. No object, triangle, draw-call
// or texture ceiling, and `renderer.info` was read by exactly one thing — the VR stats
// plate. So the answer to "how big can a scene be" was nobody's, the answer to "why did
// it get slow" was a guess, and a diagnostics bundle carried no numbers at all.
//
// TIERS WITH ACTIONS, NOT WALLS. Green does nothing, amber shows the meter, red is what
// the ingest fork (26-C) and the auto-stops (26-G) read. Nothing here refuses anything:
// a budget that stops you working is a budget people turn off.
//
// TWO PROFILES, because the same scene is fine on a desktop and fatal on a headset: a
// mobile GPU at 72-90Hz has a third of the frame time and a fraction of the memory, and
// the tab is KILLED rather than slowed when it runs out.
//
// A LEAF: svelte/store, the scene store and `inputDevice` (itself import-free). That is
// deliberate — peerHandler counts wire traffic through here, commandsHandler publishes
// its ingest backlog, and both sit inside the documented import cycles. Anything that
// cannot be reached without an edge REGISTERS instead (`registerMetricSource`).
//
// EVERYTHING HERE IS LOCAL. Not one number replicates, saves or undoes: a budget is a
// fact about THIS machine's GPU and this tab's main thread, and two peers on different
// hardware must be allowed to disagree about it.

/**
 * @typedef {'green'|'amber'|'red'|'unknown'} Tier
 * @typedef {{key: string, label: string, unit: string, desktop: [number, number], vr: [number, number], why: string}} Budget
 */

/**
 * The section-2 table as DATA, so the meter, the overlay and the gateway read ONE
 * source (the `hudKinds` / `SAVE_AS_FORMATS` shape). Each pair is [green ceiling,
 * amber ceiling]; above the second number is red.
 * @type {Budget[]}
 */
export const BUDGETS = [
	{
		key: 'objects',
		label: 'Objects',
		unit: '',
		desktop: [1000, 3000],
		vr: [500, 1500],
		why: 'every object is at least one draw call, one wire message per joiner, one row in the tree and one node in every traversal'
	},
	// 26-E MEASURED the two render axes below (tests/e2e/scene-stress.cjs, Radeon 890M
	// iGPU, 1280x720): they are counted per DISPLAY frame across every render() call now,
	// which the starting numbers never were — a frame is ~13 calls with the composer, and
	// the shadow pass draws each mesh again, so both read about TWICE the naive count.
	// VR/mobile columns are still the starting estimates; they are owed on a headset.
	{
		key: 'triangles',
		label: 'Triangles / frame',
		unit: '',
		// 6.0M/frame (15 x 200k-tri models, shadow pass included) held a locked 60fps on
		// an integrated GPU; the red edge above that is extrapolated, not measured
		desktop: [4000000, 8000000],
		vr: [300000, 600000],
		why: 'vertex and fill cost, at 60Hz on a desktop against 72-90Hz on a headset'
	},
	{
		key: 'calls',
		label: 'Draw calls / frame',
		unit: '',
		// measured: 1,943 calls (1,000 boxes) 60fps p95 16.7 · 2,799-3,625 p95 33 ·
		// 4,446 a steady 30fps · 5,323 p95 50 · 16,342 p95 133. Calls, not triangles, are
		// what binds a many-object scene: it is CPU time per call
		desktop: [2000, 4500],
		vr: [300, 500],
		why: 'there is no instancing or batching in core, so every call is CPU time'
	},
	{
		key: 'textures',
		label: 'Textures',
		unit: '',
		desktop: [300, 600],
		vr: [150, 300],
		why: 'a proxy for GPU bytes: the tab is killed on mobile and the context is lost on desktop'
	},
	{
		key: 'geometries',
		label: 'Geometries',
		unit: '',
		desktop: [1500, 4000],
		vr: [700, 2000],
		why: 'buffers held on the GPU; a leak shows here first (a delete that never disposed)'
	},
	{
		key: 'frameP95',
		label: 'Frame time p95',
		unit: 'ms',
		desktop: [20, 33],
		vr: [11, 13.9],
		why: 'FPS averages a stutter away; p95 is the frame you actually feel'
	},
	{
		key: 'longTasks',
		label: 'Long tasks / min',
		unit: '',
		desktop: [2, 12],
		vr: [1, 6],
		why: 'the direct measure of "the window froze" — a task over 50ms blocks input'
	}
];

/**
 * 26-F — the budgets only an IMPORT is judged against. They are not meter rows: nothing
 * samples "the biggest single mesh" or "the largest texture" every 500ms, and a meter row
 * that always reads "unknown" is noise. They live beside BUDGETS so `tierOf` stays the
 * ONE rule (the import gate asks the same question as the wire gate, about more axes).
 * The two single-item axes have no amber band on purpose — the roadmap states them as
 * ceilings ("Single mesh 500k verts", "Single texture 4k"), and a ceiling is either kept
 * or not. VR/mobile columns are the roadmap's starting numbers, owed on a headset.
 * @type {Budget[]}
 */
export const IMPORT_BUDGETS = [
	{
		key: 'meshVertices',
		label: 'Largest single mesh (vertices)',
		unit: '',
		// the mesh-edit commit ceiling (meshBudget MAX_SNAPSHOT = 1.5M floats = 500k
		// vertices): past it the mesh cannot be edited, undone or streamed as one message
		desktop: [500000, 500000],
		vr: [100000, 100000],
		why: 'commit and undo latency (measured at the meshBudget ceiling), and a headset draws one mesh in one frame'
	},
	{
		key: 'textureSize',
		label: 'Largest texture (px)',
		unit: 'px',
		desktop: [4096, 4096],
		vr: [2048, 2048],
		why: 'an upload stall on first draw, and mipmaps are a third on top of the image'
	},
	{
		key: 'textureMB',
		label: 'Texture memory',
		unit: 'MB',
		desktop: [512, 1024],
		vr: [256, 384],
		why: 'the tab is killed on mobile and the WebGL context lost on desktop'
	}
];

/** @type {Map<string, Budget>} */
const byKey = new Map([...BUDGETS, ...IMPORT_BUDGETS].map((b) => [b.key, b]));

/** The budget row for a key (either table), for callers that must name a ceiling.
 * @param {string} key */
export function budgetFor(key) {
	return byKey.get(key) ?? null;
}

/**
 * Which profile this device is judged against. `renderer.xr.isPresenting` is the true
 * answer while a headset is on; a coarse pointer is the standing one for a phone.
 * @param {any} [renderer]
 * @returns {'desktop'|'vr'}
 */
export function profileFor(renderer) {
	try {
		if (renderer?.xr?.isPresenting) return 'vr';
	} catch {
		/* a disposed renderer */
	}
	return coarsePointer() ? 'vr' : 'desktop';
}

/**
 * The tier one reading falls in. PURE — this is the part that has to be right, and it
 * is testable with no browser and no GPU.
 * @param {string} key @param {number | null | undefined} value @param {'desktop'|'vr'} profile
 * @returns {Tier}
 */
export function tierOf(key, value, profile) {
	const budget = byKey.get(key);
	if (!budget || value == null || !Number.isFinite(value)) return 'unknown';
	const [green, amber] = profile === 'vr' ? budget.vr : budget.desktop;
	if (value <= green) return 'green';
	if (value <= amber) return 'amber';
	return 'red';
}

const ORDER = { unknown: 0, green: 1, amber: 2, red: 3 };

/**
 * The meter's single dot: the worst tier across everything we can read. An UNKNOWN
 * never darkens the dot — "we have not measured it" is not "it is fine", but it is
 * certainly not a warning either.
 * @param {Record<string, any>} metrics @param {'desktop'|'vr'} profile @returns {Tier}
 */
export function worstTier(metrics, profile) {
	/** @type {Tier} */
	let worst = 'unknown';
	for (const budget of BUDGETS) {
		const tier = tierOf(budget.key, metrics?.[budget.key], profile);
		if (ORDER[tier] > ORDER[worst]) worst = tier;
	}
	return worst;
}

/**
 * Every budget with its current reading and tier — what the overlay renders and what a
 * diagnostics bundle carries.
 * @param {Record<string, any>} metrics @param {'desktop'|'vr'} profile
 */
export function budgetRows(metrics, profile) {
	return BUDGETS.map((budget) => {
		const value = metrics?.[budget.key];
		const [green, amber] = profile === 'vr' ? budget.vr : budget.desktop;
		return { ...budget, value: value ?? null, green, amber, tier: tierOf(budget.key, value, profile) };
	});
}

/**
 * 26-C (roadmap 26 Stage 2) — SHOULD THIS MANY MORE OBJECTS BE LET IN?
 *
 * The one question the ingest gate and the file-open ask both need, and it is PURE, so
 * it is answerable with no scene, no wire and no browser.
 *
 * `allowed` is how many of `incoming` fit before the scene crosses into red — the
 * number the "load the first N" fork offers. It is measured against the AMBER ceiling
 * because that is where red begins; offering to fill the scene exactly to the edge of
 * red is the most that can be let in without asking again.
 *
 * @param {number} current objects already in the scene
 * @param {number} incoming objects announced
 * @param {'desktop'|'vr'} profile
 * @returns {{tier: Tier, total: number, current: number, incoming: number, limit: number, allowed: number, gate: boolean}}
 */
export function ingestVerdict(current, incoming, profile) {
	const now = Math.max(0, Number(current) || 0);
	const more = Math.max(0, Number(incoming) || 0);
	const total = now + more;
	const budget = byKey.get('objects');
	const limit = budget ? (profile === 'vr' ? budget.vr[1] : budget.desktop[1]) : Infinity;
	const tier = tierOf('objects', total, profile);
	return {
		tier,
		total,
		current: now,
		incoming: more,
		limit,
		allowed: Math.max(0, Math.min(more, limit - now)),
		// nothing to ask about when the arrival is empty, and nothing to ask about
		// below red — amber warns, red asks (the tiers-with-actions rule)
		gate: more > 0 && tier === 'red'
	};
}

// --- is the scene heavy? (26-G's gate, 26-D's gate) --------------------------------

/** The scene-size axes only — never frame time itself, which would make the rule
 * circular: "slow, therefore heavy, therefore act on the slowness". */
export const HEAVY_AXES = ['objects', 'triangles', 'calls'];

/**
 * The size readings as they were BEFORE the quality governor (26-D) took anything away,
 * or null while nothing is reduced. LOCAL.
 *
 * WHY IT EXISTS: turning shadows off halves the draw calls (26-E measured the shadow pass
 * as the second copy of every mesh). A heaviness rule reading the live calls would then
 * see a lighter scene, so 26-G's freeze streak — which only counts while the scene is
 * heavy — would stand down BECAUSE the governor helped, and the one scene that most needs
 * the last-resort pause could no longer get it. The scene did not get lighter; this
 * device drew less of it.
 * @type {import('svelte/store').Writable<{objects: number, triangles: number, calls: number} | null>}
 */
export const qualityBaseline = writable(null);

/**
 * Heavy = any size axis at amber or worse. While a baseline stands, each axis reads the
 * larger of now and then — unless the scene really did shrink (fewer than 70% of the
 * objects the baseline was taken with), in which case the baseline no longer describes
 * this scene and is ignored. PURE.
 * @param {Record<string, any>} metrics @param {'desktop'|'vr'} profile
 * @param {{objects: number, triangles: number, calls: number} | null} [baseline]
 */
export function isHeavy(metrics, profile, baseline = null) {
	const valid = !!baseline && Number(metrics?.objects) >= 0.7 * Number(baseline.objects);
	return HEAVY_AXES.some((key) => {
		const now = metrics?.[key];
		const then = valid ? /** @type {any} */ (baseline)[key] : null;
		const reading = Number.isFinite(then) && (!Number.isFinite(now) || then > now) ? then : now;
		const tier = tierOf(key, reading, profile);
		return tier === 'amber' || tier === 'red';
	});
}

// --- frame times ------------------------------------------------------------------
// A RING, not an average. p95 is the whole point: a scene that renders 58 of every 60
// frames in 8ms and two in 300ms reads as 60fps and feels broken.

const FRAME_RING = 240;
/** @type {number[]} */
const frames = [];

/** @param {number} ms */
export function noteFrame(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return;
	frames.push(ms);
	if (frames.length > FRAME_RING) frames.shift();
}

/** @param {number[]} sorted @param {number} q */
function percentile(sorted, q) {
	if (!sorted.length) return null;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
	return sorted[index];
}

/** p50 / p95 / p99 over the ring. PURE given the ring. */
export function frameStats() {
	const sorted = [...frames].sort((a, b) => a - b);
	return {
		n: sorted.length,
		p50: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		p99: percentile(sorted, 0.99)
	};
}

// --- long tasks -------------------------------------------------------------------
// `PerformanceObserver('longtask')` is the browser telling us, in its own words, that
// the main thread was blocked past 50ms. Nothing else in this app can say that.

/** @type {{at: number, ms: number}[]} */
let longTasks = [];
/** @type {any} */
let longTaskObserver = null;

/** @type {Set<(ms: number) => void>} */
const longTaskObservers = new Set();

/**
 * Hear every long task as it is observed. 26-D's governor is the reader (more than two
 * in five seconds is "overloaded" whatever the frames say); registered, never imported,
 * for the same reason as `registerFrameObserver`.
 * @param {(ms: number) => void} fn @returns {() => void} unregister
 */
export function registerLongTaskObserver(fn) {
	longTaskObservers.add(fn);
	return () => longTaskObservers.delete(fn);
}

/** @param {number} ms */
export function noteLongTask(ms) {
	const now = Date.now();
	for (const fn of longTaskObservers) {
		try {
			fn(ms);
		} catch {
			/* isolated — one bad observer must not end the observation */
		}
	}
	longTasks.push({ at: now, ms });
	// a rolling minute, which is what the budget is stated in
	longTasks = longTasks.filter((t) => now - t.at < 60000);
}

/** Count in the last minute plus the worst one. */
export function longTaskStats() {
	const now = Date.now();
	const recent = longTasks.filter((t) => now - t.at < 60000);
	return { perMinute: recent.length, longest: recent.reduce((m, t) => Math.max(m, t.ms), 0) };
}

export function startLongTasks() {
	if (longTaskObserver || typeof PerformanceObserver === 'undefined') return false;
	try {
		longTaskObserver = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) noteLongTask(entry.duration);
		});
		longTaskObserver.observe({ entryTypes: ['longtask'] });
		return true;
	} catch {
		// Safari and Firefox do not implement it. The rest of the panel still works,
		// and the row says "not available" rather than lying with a zero.
		longTaskObserver = null;
		return false;
	}
}

export function stopLongTasks() {
	try {
		longTaskObserver?.disconnect();
	} catch {
		/* already gone */
	}
	longTaskObserver = null;
}

// --- wire traffic per type (audit H7's measurement) ---------------------------------
// WHICH STREAM IS CHATTY is the question, and the answer is a COUNT — exact, and free.
// BYTES are sampled: `JSON.stringify` on every message would itself become the cost
// being measured, so one in SAMPLE_EVERY is measured and scaled, and the UI says "≈".

const SAMPLE_EVERY = 16;
/** @type {Map<string, {in: number, out: number, bytes: number, sampled: number}>} */
const wire = new Map();
let wireSince = Date.now();
let wireTick = 0;

/** @param {'in'|'out'} dir @param {any} payload */
export function noteWire(dir, payload) {
	const type = typeof payload?.type === 'string' ? payload.type : 'unknown';
	let row = wire.get(type);
	if (!row) wire.set(type, (row = { in: 0, out: 0, bytes: 0, sampled: 0 }));
	row[dir]++;
	if (++wireTick % SAMPLE_EVERY === 0) {
		try {
			row.bytes += JSON.stringify(payload).length;
			row.sampled++;
		} catch {
			// a payload holding an ArrayBuffer (the raw-bytes channels) — count the
			// message, skip the estimate rather than pretend
		}
	}
}

/** Per-type rows, busiest first, with a per-second rate over the window since the
 * last reset. `bytes` is an ESTIMATE and is labelled as one wherever it is shown. */
export function wireStats() {
	const seconds = Math.max(1, (Date.now() - wireSince) / 1000);
	const rows = [...wire.entries()]
		.map(([type, row]) => ({
			type,
			in: row.in,
			out: row.out,
			perSecond: (row.in + row.out) / seconds,
			bytes: row.sampled ? Math.round((row.bytes / row.sampled) * (row.in + row.out)) : null
		}))
		.sort((a, b) => b.in + b.out - (a.in + a.out));
	return { seconds, rows };
}

export function resetWireStats() {
	wire.clear();
	wireSince = Date.now();
	wireTick = 0;
}

// --- extra sources, registered rather than imported ---------------------------------

/** @type {Map<string, () => any>} */
const sources = new Map();

/**
 * Contribute a reading without this module importing you. The `registerDiagnosticsSection`
 * seam, one domain over — commandsHandler publishes its ingest backlog this way, and
 * physics can publish its body count without sceneBudget reaching into the cycle family.
 * @param {string} key @param {() => any} read @returns {() => void} unregister
 */
export function registerMetricSource(key, read) {
	sources.set(key, read);
	return () => sources.delete(key);
}

// --- the sampler --------------------------------------------------------------------

/** The last sample. Written ~2x/s, never per frame — the panel is DOM. */
/** @type {import('svelte/store').Writable<Record<string, any>>} */
export const sceneMetrics = writable({ at: 0, profile: 'desktop' });

/** The desktop Statistics overlay's open state. LOCAL. */
export const statsOpen = writable(false);

/** How often the reading is recomputed. Anything faster is unreadable and the walk is
 * O(objects); anything slower misses the hitch you opened the panel to find. */
const SAMPLE_MS = 500;

let running = false;
/** @type {any} */
let rafId = null;
let lastFrameAt = 0;
let lastSampleAt = 0;

function walkScene() {
	const group = get(objectsGroup);
	let objects = 0;
	let meshes = 0;
	let hidden = 0;
	group?.traverse?.((/** @type {any} */ o) => {
		if (o === group) return;
		objects++;
		if (o.isMesh) meshes++;
		if (o.visible === false) hidden++;
	});
	return { objects, meshes, hidden };
}

// --- per-frame render totals (26-E) -----------------------------------------------
//
// THE FINDING the stress rig made on its first run: 1,000 boxes on screen, and the meter
// read `triangles: 1, calls: 1`. `renderer.info` is AUTO-RESET at the start of every
// `renderer.render()` call, and a desktop frame is not one call — the EffectComposer
// renders the scene into a target, then N8AO, then the outline, then a fullscreen
// triangle to the canvas, each its own `render()`. Whatever reads `info` afterwards sees
// the LAST pass: one triangle, one call. So the triangle and draw-call budgets could
// never leave green, and 26-G's `sceneIsHeavy` was really asking about objects alone.
//
// The fix counts EVERY `render()` and divides by the display frames the sampler saw.
// Deliberately NOT `info.autoReset = false`: that changes what `info` means for every
// other reader (the VR stats plate, the diagnostics section, a test that resets and
// renders once), and inside a WebXR session `window.requestAnimationFrame` does not run,
// so nothing would ever reset it again and the plate would count up forever. A wrapper
// on the instance leaves `info` byte-identical for everyone and works in XR too.

const renderAcc = { calls: 0, triangles: 0, renders: 0 };
/** Display frames the sampler loop counted since the last sample. */
let renderFrames = 0;

/**
 * Wrap this renderer's `render` so each call adds what it drew to the accumulator. Once
 * per instance (a restored context can hand the store a NEW renderer, which gets its own).
 * @param {any} renderer
 */
export function countRenderCalls(renderer) {
	if (!renderer || typeof renderer.render !== 'function' || renderer.__budgetRender) return false;
	const original = renderer.render;
	renderer.__budgetRender = original;
	renderer.render = function (/** @type {any[]} */ ...args) {
		const info = this.info?.render;
		// with autoReset ON (three's default) render() zeroes the counters itself, so the
		// base is 0; with it OFF somebody is accumulating on purpose and we take the delta
		const baseCalls = info && this.info.autoReset === false ? info.calls : 0;
		const baseTris = info && this.info.autoReset === false ? info.triangles : 0;
		const result = original.apply(this, args);
		if (info) {
			renderAcc.calls += info.calls - baseCalls;
			renderAcc.triangles += info.triangles - baseTris;
			renderAcc.renders++;
		}
		return result;
	};
	return true;
}

/** Undo `countRenderCalls` — the sampler stopping must leave the renderer as it found it.
 * @param {any} renderer */
export function uncountRenderCalls(renderer) {
	if (!renderer?.__budgetRender) return;
	renderer.render = renderer.__budgetRender;
	delete renderer.__budgetRender;
}

/** @type {{calls: number, triangles: number, rendersPerFrame: number} | null} */
let lastTotals = null;

/** Per display frame since the last call, then start a new window. A window with no
 * frame in it (two forced readings back to back, a paused loop) keeps the previous
 * reading rather than inventing a zero — "nothing measured" is not "nothing drawn". */
function takeRenderTotals() {
	const frames = renderFrames;
	if (frames === 0) return lastTotals;
	const out = {
		calls: Math.round(renderAcc.calls / frames),
		triangles: Math.round(renderAcc.triangles / frames),
		rendersPerFrame: Math.round((renderAcc.renders / frames) * 10) / 10
	};
	lastTotals = out;
	renderAcc.calls = 0;
	renderAcc.triangles = 0;
	renderAcc.renders = 0;
	renderFrames = 0;
	return out;
}

function sample() {
	/** @type {any} */
	const renderer = get(globalRenderer);
	if (running) countRenderCalls(renderer);
	const info = renderer?.info;
	const totals = takeRenderTotals();
	const profile = profileFor(renderer);
	const scene = walkScene();
	const fps = frameStats();
	const tasks = longTaskStats();
	/** @type {any} */
	const perf = typeof performance !== 'undefined' ? performance : null;
	const heap = perf?.memory?.usedJSHeapSize ?? null;
	/** @type {Record<string, any>} */
	const extra = {};
	for (const [key, read] of sources) {
		try {
			extra[key] = read();
		} catch {
			extra[key] = null;
		}
	}
	const metrics = {
		at: Date.now(),
		profile,
		objects: scene.objects,
		meshes: scene.meshes,
		hidden: scene.hidden,
		// per DISPLAY frame across every render() call; before the sampler has counted a
		// frame (a forced reading straight after boot) fall back to the raw last pass
		triangles: totals ? totals.triangles : (info?.render?.triangles ?? null),
		calls: totals ? totals.calls : (info?.render?.calls ?? null),
		rendersPerFrame: totals ? totals.rendersPerFrame : null,
		geometries: info?.memory?.geometries ?? null,
		textures: info?.memory?.textures ?? null,
		frameP50: fps.p50,
		frameP95: fps.p95,
		frameP99: fps.p99,
		frameSamples: fps.n,
		fps: fps.p50 ? Math.round(1000 / fps.p50) : null,
		longTasks: tasks.perMinute,
		longestTask: Math.round(tasks.longest),
		longTasksAvailable: !!longTaskObserver,
		heap,
		...extra
	};
	sceneMetrics.set(metrics);
}

/** @type {Set<(ms: number) => void>} */
const frameObservers = new Set();

/**
 * Hear every frame's duration. 26-G's freeze detector is the reader; it registers rather
 * than being imported so this module keeps knowing nothing about pausing. An observer
 * that throws is isolated — one bad observer must not end the sampler for everyone.
 * @param {(ms: number) => void} fn @returns {() => void} unregister
 */
export function registerFrameObserver(fn) {
	frameObservers.add(fn);
	return () => frameObservers.delete(fn);
}

function loop() {
	const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
	if (lastFrameAt) {
		const ms = now - lastFrameAt;
		noteFrame(ms);
		for (const fn of frameObservers) {
			try {
				fn(ms);
			} catch {
				/* isolated — see registerFrameObserver */
			}
		}
	}
	lastFrameAt = now;
	renderFrames++;
	if (now - lastSampleAt >= SAMPLE_MS) {
		lastSampleAt = now;
		sample();
	}
	if (running) rafId = requestAnimationFrame(loop);
}

/**
 * Start sampling. The rAF loop is OUR OWN rather than threlte's task graph, on purpose:
 * frame time measured from the browser's own callback cadence is exactly the quantity
 * "did the window freeze" is asking about, and it keeps this a leaf that Scene.svelte
 * does not have to know exists.
 */
export function startSceneMetrics() {
	if (running || typeof requestAnimationFrame === 'undefined') return;
	running = true;
	lastFrameAt = 0;
	lastSampleAt = 0;
	renderFrames = 0;
	countRenderCalls(get(globalRenderer));
	startLongTasks();
	rafId = requestAnimationFrame(loop);
}

export function stopSceneMetrics() {
	running = false;
	if (rafId != null) cancelAnimationFrame(rafId);
	rafId = null;
	stopLongTasks();
	uncountRenderCalls(get(globalRenderer));
}

/** Force a reading now — the overlay opening, and the suite. */
export function sampleSceneMetrics() {
	sample();
	return get(sceneMetrics);
}

/** One line per budget, for the diagnostics bundle (audit H4). */
export function budgetSummary() {
	const metrics = get(sceneMetrics);
	const profile = metrics.profile === 'vr' ? 'vr' : 'desktop';
	return {
		profile,
		tier: worstTier(metrics, profile),
		metrics,
		budgets: budgetRows(metrics, profile).map((r) => ({ key: r.key, value: r.value, tier: r.tier })),
		wire: wireStats().rows.slice(0, 12)
	};
}
