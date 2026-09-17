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
	{
		key: 'triangles',
		label: 'Triangles / frame',
		unit: '',
		desktop: [1000000, 3000000],
		vr: [300000, 600000],
		why: 'vertex and fill cost, at 60Hz on a desktop against 72-90Hz on a headset'
	},
	{
		key: 'calls',
		label: 'Draw calls / frame',
		unit: '',
		desktop: [1000, 2000],
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

/** @type {Map<string, Budget>} */
const byKey = new Map(BUDGETS.map((b) => [b.key, b]));

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

/** @param {number} ms */
export function noteLongTask(ms) {
	const now = Date.now();
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

function sample() {
	/** @type {any} */
	const renderer = get(globalRenderer);
	const info = renderer?.info;
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
		triangles: info?.render?.triangles ?? null,
		calls: info?.render?.calls ?? null,
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
	startLongTasks();
	rafId = requestAnimationFrame(loop);
}

export function stopSceneMetrics() {
	running = false;
	if (rafId != null) cancelAnimationFrame(rafId);
	rafId = null;
	stopLongTasks();
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
