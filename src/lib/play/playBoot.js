// 94 SP1 — THE PLAY ENTRY'S BOOT API. Started once by src/PlayApp.svelte (never by the editor).
//
//   window.tpPlay = {
//     version: 1,
//     state: 'booting' | 'loading' | 'ready' | 'playing' | 'error',
//     ready: Promise<void>,           // the first frame has rendered (the scene may still be loading)
//     loaded: Promise<boolean>,       // the scene arrived (true) or could not (false)
//     sceneId: string,                // `?s=` ('' when none)
//     openInEditorUrl(): string,      // the same scene in the full app
//     remixUrl(): string,             // …opened as a remix ('' without a scene id)
//     timings: { firstFrameMs, loadedMs, playingMs }   // ms since navigation start (performance.now)
//   }
//
// and, when framed (`window.parent !== window`), one postMessage per transition to the parent:
//   { type: 'tp-play', event: 'first-frame' | 'loaded' | 'playing' | 'stopped' | 'error', detail }
// The parent can be any origin — the events carry no user data (a state, a scene id it already
// has, timings), so `'*'` is the right target. Nothing is read FROM the parent: a framing page
// cannot drive the game through this channel.
//
// `?s=<id>` is loaded by the cloud plugin's deep link (unchanged); `?scene=<url>` (a .tpscene that
// is not a community record) is loaded here through the editor's own `loadRemoteScene`.
import { globalRenderer, isLocked } from '../../stores/sceneStore';
import { sessionHost } from '../connectionState';
import { embedOpenUrl, embedSceneId } from '../playMode';
import { appUrl } from '../playOrigin.js';
import { playEntrySceneUrl } from './playEntry.js';

/** @typedef {'booting'|'loading'|'ready'|'playing'|'error'} PlayState */

/** @type {{ firstFrameMs: number | null, loadedMs: number | null, playingMs: number | null }} */
const timings = { firstFrameMs: null, loadedMs: null, playingMs: null };

/** @param {string} event @param {any} [detail] */
function post(event, detail = {}) {
	try {
		if (typeof window === 'undefined' || window.parent === window) return;
		window.parent.postMessage({ type: 'tp-play', event, detail }, '*');
	} catch {
		/* a detached frame */
	}
}

/** the remix URL for the scene this page plays ('' without an id) */
export function remixUrl() {
	return embedSceneId ? appUrl(`/?s=${encodeURIComponent(embedSceneId)}&remix=1`) : '';
}

let started = false;

export function startPlayEntry() {
	if (started || typeof window === 'undefined') return;
	started = true;
	/** @type {(v: void) => void} */
	let resolveReady = () => {};
	/** @type {(v: boolean) => void} */
	let resolveLoaded = () => {};
	const ready = new Promise((r) => (resolveReady = r));
	const loaded = new Promise((r) => (resolveLoaded = r));
	const api = {
		version: 1,
		/** @type {PlayState} */
		state: /** @type {PlayState} */ ('booting'),
		ready,
		loaded,
		sceneId: embedSceneId,
		openInEditorUrl: () => embedOpenUrl(),
		remixUrl,
		timings
	};
	/** @param {PlayState} s */
	const setState = (s) => {
		api.state = s;
		try {
			document.documentElement.dataset.tpPlay = s;
		} catch {
			/* no document */
		}
	};
	/** @type {any} */ (window).tpPlay = api;
	setState('loading');

	// FIRST FRAME: three counts rendered frames; the first one past 0 is what a player first sees
	const offRenderer = globalRenderer.subscribe((/** @type {any} */ r) => {
		if (!r) return;
		const poll = () => {
			if ((r.info?.render?.frame ?? 0) > 0) {
				timings.firstFrameMs = Math.round(performance.now());
				post('first-frame', { ms: timings.firstFrameMs });
				resolveReady();
				return;
			}
			requestAnimationFrame(poll);
		};
		requestAnimationFrame(poll);
		queueMicrotask(() => offRenderer());
	});

	// PLAYING: the editor's own play state (pointer lock, touch play, XR) — every entry and exit
	let wasPlaying = false;
	isLocked.subscribe((v) => {
		const playing = v === true;
		if (playing === wasPlaying) return;
		wasPlaying = playing;
		if (playing) {
			if (timings.playingMs == null) timings.playingMs = Math.round(performance.now());
			setState('playing');
			post('playing', { ms: Math.round(performance.now()) });
		} else if (api.state === 'playing') {
			setState('ready');
			post('stopped', {});
		}
	});

	// LOADED: every remote load (this entry's `?scene=` and the plugin's `?s=`) goes through
	// sceneTemplates.loadRemoteScene, whose `templateLoaded` fires once the payload applied
	const markLoaded = (/** @type {boolean} */ ok, /** @type {string} */ why = '') => {
		// once — except that a later success (a join after a refused load) lifts an 'error'
		if (timings.loadedMs != null && !(ok && api.state === 'error')) return;
		timings.loadedMs = Math.round(performance.now());
		if (ok) {
			if (api.state !== 'playing') setState('ready');
			post('loaded', { ms: timings.loadedMs, sceneId: embedSceneId });
		} else {
			setState('error');
			post('error', { reason: why || 'load' });
		}
		resolveLoaded(ok);
	};
	// JOINED: a play link with an invite joins a session, and a joiner's world comes from the host,
	// not from a load — a viewer's own `loadRemoteScene` is refused (it may not replace the shared
	// scene), so `templateLoaded` never fires for it. Being let in IS the scene arriving (the host's
	// full state follows on the same ordered connection): the N6 sat at 'loading' after a join.
	const offHost = sessionHost.subscribe((/** @type {string | null} */ host) => {
		if (!host) return;
		markLoaded(true);
		queueMicrotask(() => offHost());
	});

	import('../sceneTemplates').then(({ templateLoaded, loadRemoteScene }) => {
		// fix-play-link: NO first-value skip. The store starts null on this page (nothing loads a
		// scene before this entry), and when the plugin's `?s=` load landed before this import
		// resolved, the skipped first value WAS the load — the state then stayed 'loading' forever
		templateLoaded.subscribe((v) => {
			if (v) markLoaded(true);
		});
		const sceneUrl = playEntrySceneUrl();
		if (sceneUrl) {
			loadRemoteScene({ sceneUrl, title: '', slug: '' }, { origin: 'play' })
				.then((ok) => {
					if (!ok) markLoaded(false, 'scene');
				})
				.catch(() => markLoaded(false, 'scene'));
		} else if (!embedSceneId) {
			// nothing to load (a join-only invite link, or a bare /play): the page is ready as it is
			markLoaded(true);
		}
	});
}
