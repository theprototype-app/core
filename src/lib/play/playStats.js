// playStats.js — roadmap 102 M4: ANONYMOUS PLAY STATISTICS for a published game, the wiring.
// Started (lazily) by App.svelte and PlayApp.svelte only when the page was opened with a published
// scene id (`?s=<id>` — play links, embeds, Open in ThePrototype), so every other page never loads it.
//
// What it watches: Play on / off (`isLocked`), the game state (`gameState`), the level (the kit's
// current level, else the scene's name) and whether the page is visible. What it sends, through the
// cloud plugin only (`cloudHooks.notifyPlayStats` — an engine with no plugin sends nothing): a `start`
// and the play's `end` when the page is hidden or left (pagehide), batched into one beacon, capped
// per play (playStatsCore.js). Never: an id of the player, the tab, the account or the device.
//
// NOTHING is collected or sent when the browser says Do Not Track or Global Privacy Control, when
// Settings ▸ Privacy ▸ "Count my visits anonymously" is off (the same switch as the usage counts),
// or under test (`debugStores`) unless `playStatsUnderTest` is 'true'.
import { get } from 'svelte/store';
import { safeStorage } from '../safeStorage';
import { coarsePointer } from '../inputDevice';
import { isLocked } from '../../stores/sceneStore';
import { gameState } from '../gameState';
import { currentLevel } from '../levels';
import { kit } from '../kit/runtime';
import { funnelOn } from '../onboarding/funnel';
import { notifyPlayStats, playStatsListening } from '../cloudHooks';
import { createPlayTracker, playDeviceOf, playStateOf } from './playStatsCore.js';

/** may this page count a play? (the funnel's rule, plus its own under-test key) */
export function playStatsAllowed() {
	const nav = typeof navigator === 'undefined' ? /** @type {any} */ ({}) : /** @type {any} */ (navigator);
	if (nav.doNotTrack === '1' || nav.globalPrivacyControl === true) return false;
	if (typeof window !== 'undefined' && /** @type {any} */ (window).doNotTrack === '1') return false;
	if (!get(funnelOn)) return false;
	if (!safeStorage.getItem('debugStores')) return true;
	return safeStorage.getItem('playStatsUnderTest') === 'true';
}

/** the level to report: the kit's current level (a Levels table), else the scene's own name */
function levelNow() {
	try {
		const k = /** @type {any} */ (kit).impls?.levels;
		const id = k?.current?.();
		if (id) return String(id);
	} catch {
		/* no kit levels here */
	}
	return get(currentLevel)?.name || '';
}

/** @type {null | { tracker: ReturnType<typeof createPlayTracker>, stop: () => void }} */
let running = null;

/**
 * Start counting this page's play of `scene`. Idempotent; returns a stop function.
 * @param {string} scene the published scene id the page was opened with
 */
export function startPlayStats(scene) {
	if (running) return running.stop;
	if (!scene || typeof window === 'undefined' || typeof document === 'undefined') return () => {};
	const tracker = createPlayTracker({
		scene,
		device: playDeviceOf({ ua: typeof navigator === 'undefined' ? '' : navigator.userAgent, coarse: coarsePointer() })
	});
	const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
	let visible = document.visibilityState !== 'hidden';
	let locked = false;
	/** @type {(() => void)[]} */
	const offs = [];
	const syncPlaying = () => tracker.playing(locked && visible && playStatsAllowed(), now());
	offs.push(
		isLocked.subscribe((v) => {
			locked = v === true;
			syncPlaying();
		})
	);
	offs.push(
		gameState.subscribe((g) => {
			tracker.state(playStateOf(g, !!g?.changedAt));
			tracker.level(levelNow());
		})
	);
	offs.push(currentLevel.subscribe(() => tracker.level(levelNow())));

	/** hand what is new to the plugin — a no-op unless something listens and counting is allowed */
	const flush = () => {
		if (!playStatsAllowed() || !get(playStatsListening)) return;
		tracker.level(levelNow());
		tracker.flush(now(), (body) => notifyPlayStats(body));
	};
	const onVisibility = () => {
		visible = document.visibilityState !== 'hidden';
		syncPlaying();
		if (!visible) flush();
	};
	const onPageHide = () => {
		visible = false;
		syncPlaying();
		flush();
	};
	document.addEventListener('visibilitychange', onVisibility);
	window.addEventListener('pagehide', onPageHide);

	const stop = () => {
		for (const off of offs.splice(0)) off();
		document.removeEventListener('visibilitychange', onVisibility);
		window.removeEventListener('pagehide', onPageHide);
		running = null;
	};
	running = { tracker, stop };
	return stop;
}

/** test seam: the running tracker's view (no beacon sent) */
export function playStatsDebug() {
	return running ? running.tracker.peek(typeof performance !== 'undefined' ? performance.now() : Date.now()) : null;
}
/** test seam: flush as a hide would */
export function playStatsFlushForTest() {
	if (!running) return null;
	if (!playStatsAllowed() || !get(playStatsListening)) return null;
	return running.tracker.flush(typeof performance !== 'undefined' ? performance.now() : Date.now(), (body) => notifyPlayStats(body));
}
