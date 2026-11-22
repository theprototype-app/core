// 93 LP2 — LOADING SCREENS. One per game (the Levels table's `loading`), a portal may override it. Shown while
// a level's scene loads; LOCAL to the loading player.
//
//   presets     fade (no screen, the transition's cover only) · bar (a minimal progress bar) · logo (logo +
//               spinner) · image (a background image + rotating tips) · item (a game item turning)
//   customise   background colour / image (a library image), logo, text colour, bar style (thin / thick,
//               colour), tips, the item, a title
//   progress    REAL: the scene file's bytes (preload.js, while the player stood near the portal), the
//               objects the load builds (sceneLoader), then the bytes of the pack files the scene places
//               (loadStates, per file) — 0..100 %
//   never flickers: shown only when the hop is still running after SHOW_AFTER_MS, then for at least MIN_MS;
//               SKIPPED when the target is already loaded (a second trip: preload.js says ready)
//   exports     the same screen covers an exported game's first load (exportRuntime), the author's look, no
//               "Made with" line (the export's corner logo already says it)
//   VR          no head-locked UI: a dim panel placed in the world in front of the player (LevelLoadingVr)
//   a11y        reduced motion = a static bar and no spinner; progress announced at 25 % steps; text colour
//               falls back to a contrasting one
import { writable, get } from 'svelte/store';
import { sceneLoad } from '../sceneLoader';
import { allLoads } from '../loadStates';
import { sceneLevelsTable } from './runtime.js';
import { preloadProgress, sceneReady, noteSceneLoaded } from './preload.js';
import { normalizeLoading } from './loadingConfig.js';

export { LOADING_PRESETS, BAR_STYLES, normalizeLoading } from './loadingConfig.js';

/** a screen shown is shown at least this long (ms) */
export const MIN_MS = 400;
/** a hop that finishes faster than this shows no screen at all (ms) */
export const SHOW_AFTER_MS = 150;
/** pack files still arriving after the scene is built: wait at most this long for them (ms) */
const PACK_WAIT_MS = 8000;

/**
 * Progress 0..1 from the three real sources. Pure (the sampler feeds it). @param {{preload: {bytes: number,
 * total: number} | null, job: {done: number, total: number} | null, built: boolean, packs: {loaded: number,
 * total: number, pending: number}}} s
 */
export function loadingProgress(s) {
	// the scene file: 0..0.3 (all of it at once when it was local already)
	let p = s.preload?.total ? 0.3 * Math.min(1, s.preload.bytes / s.preload.total) : 0;
	if (s.job || s.built) p = 0.3;
	// the objects the load builds: 0.3..0.7
	if (s.job?.total) p = 0.3 + 0.4 * Math.min(1, s.job.done / s.job.total);
	if (s.built) p = 0.7;
	// the pack files the scene places, by bytes: 0.7..1
	if (s.built) {
		if (s.packs.total > 0) p = 0.7 + 0.3 * Math.min(1, s.packs.loaded / s.packs.total);
		if (!s.packs.pending) p = 1;
	}
	return Math.max(0, Math.min(1, p));
}

/** @typedef {{active: boolean, config: ReturnType<typeof normalizeLoading>, scene: string, progress: number, startedAt: number}} LoadingState */
/** @type {import('svelte/store').Writable<LoadingState>} */
export const levelLoading = writable({ active: false, config: normalizeLoading(null), scene: '', progress: 0, startedAt: 0 });

/** the config a hop uses: the portal's own, else the game's, else the neutral bar @param {any} override */
export function loadingConfigFor(override) {
	return normalizeLoading(override ?? sceneLevelsTable()?.loading ?? null);
}

/** @param {number} ms */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A tracker of the pack files loading since a hop began (loadStates, per file). loadStates FORGETS a file once
 * it is parsed, so the tracker remembers every file it saw: one that disappears counts as fully loaded.
 */
export function packTracker() {
	/** url -> {loaded, total, done} @type {Map<string, {loaded: number, total: number, done: boolean}>} */
	const seen = new Map();
	return {
		/** @param {any[]} [now] the current loadStates records (tests pass their own) */
		sample(now = allLoads()) {
			const live = new Set();
			for (const l of now) {
				if (l.phase === 'failed') continue;
				live.add(l.url);
				const prev = seen.get(l.url);
				const total = l.total || prev?.total || 0;
				const loaded = l.phase === 'parsing' ? total || l.loaded : l.loaded || 0;
				seen.set(l.url, { loaded: Math.max(prev?.loaded ?? 0, loaded), total, done: false });
			}
			for (const [url, row] of seen) if (!live.has(url) && !row.done) seen.set(url, { loaded: row.total || row.loaded, total: row.total || row.loaded, done: true });
			let loaded = 0;
			let total = 0;
			let pending = 0;
			for (const row of seen.values()) {
				loaded += row.loaded;
				total += row.total;
				if (!row.done) pending++;
			}
			return { loaded, total, pending };
		}
	};
}

/**
 * Run a scene hop under the loading screen. @param {string} scene the target scene's name
 * @param {() => Promise<boolean>} hop @param {any} [override] a portal's own config
 * @returns {Promise<boolean>} the hop's answer
 */
export async function withLoadingScreen(scene, hop, override = null) {
	const config = loadingConfigFor(override);
	// fade only, or the target is already loaded: the transition's cover is enough
	if (config.preset === 'fade' || sceneReady(scene)) {
		const ok = await hop();
		if (ok) noteSceneLoaded(scene);
		return ok;
	}
	const packs = packTracker();
	let built = false;
	let done = false;
	/** @type {boolean} */
	let result = false;
	const running = hop().then(
		(ok) => {
			result = ok;
			built = true;
		},
		() => {
			built = true;
		}
	);
	await Promise.race([running, wait(SHOW_AFTER_MS)]);
	if (built) {
		if (result) noteSceneLoaded(scene);
		return result;
	}
	const shownAt = Date.now();
	levelLoading.set({ active: true, config, scene, progress: 0, startedAt: shownAt });
	const sample = () => {
		const job = /** @type {any} */ (get(sceneLoad));
		const progress = loadingProgress({ preload: preloadProgress(scene), job: job ? { done: job.done, total: job.total } : null, built, packs: packs.sample() });
		levelLoading.update((s) => ({ ...s, progress: Math.max(s.progress, progress) }));
		return progress;
	};
	// every progress the load publishes (the object build reports ~10 times a second), plus a 100 ms poll for
	// the sources with no store (the preload's bytes, the pack files)
	const unsub = sceneLoad.subscribe(() => sample());
	const timer = setInterval(sample, 100);
	try {
		await running;
		// the scene is built; its pack files may still be arriving (their placeholders are what the author's
		// screen hides) — wait for them, bounded
		const packDeadline = Date.now() + PACK_WAIT_MS;
		while (!done && Date.now() < packDeadline) {
			if (sample() >= 1) break;
			await wait(100);
		}
		done = true;
		levelLoading.update((s) => ({ ...s, progress: 1 }));
		const shown = Date.now() - shownAt;
		if (shown < MIN_MS) await wait(MIN_MS - shown);
	} finally {
		unsub();
		clearInterval(timer);
		levelLoading.update((s) => ({ ...s, active: false }));
	}
	if (result) noteSceneLoaded(scene);
	return result;
}

/** the export's first load: show the author's screen over the boot until `until` settles (exportRuntime)
 * @param {any} config @param {Promise<any>} until */
export async function coverFirstLoad(config, until) {
	const c = normalizeLoading(config);
	if (c.preset === 'fade') c.preset = 'bar';
	const t0 = Date.now();
	const packs = packTracker();
	let built = false;
	levelLoading.set({ active: true, config: c, scene: '', progress: 0, startedAt: t0 });
	const timer = setInterval(() => {
		const job = /** @type {any} */ (get(sceneLoad));
		const p = loadingProgress({ preload: null, job: job ? { done: job.done, total: job.total } : null, built, packs: packs.sample() });
		levelLoading.update((s) => ({ ...s, progress: Math.max(s.progress, p) }));
	}, 100);
	try {
		await until;
		built = true;
		const deadline = Date.now() + PACK_WAIT_MS;
		while (Date.now() < deadline && packs.sample().pending) await wait(100);
		levelLoading.update((s) => ({ ...s, progress: 1 }));
		const shown = Date.now() - t0;
		if (shown < MIN_MS) await wait(MIN_MS - shown);
	} finally {
		clearInterval(timer);
		levelLoading.update((s) => ({ ...s, active: false }));
	}
}
