// 102b-play row 3 — THE SCREEN STAYS AWAKE while it is being used without being touched: playing
// (a game on a gamepad, a phone held as a controller), filming (Film mode, a recording running)
// and a hand-off (watching another player's view — the screen left alone while someone else wears
// the headset). Screen Wake Lock (Chrome 84, Safari 16.4, Firefox 126, Quest Browser); a silent
// no-op where the browser has none or refuses.
//
// REASONS, not a flag: each source holds its own reason and the lock is wanted while any is held,
// so ending a recording does not let the screen sleep under a game still being played. The browser
// drops the lock itself whenever the page is hidden; it is asked for again on the way back while a
// reason still holds. A PAUSED game (gameState 'paused') and leaving play release the 'play' reason.
//
// No imports: each app wires the stores it has (startWakeLock below).

/** @type {Set<string>} */
const reasons = new Set();
/** @type {any} */
let sentinel = null;
let asking = false;
let listening = false;

export function wakeLockSupported() {
	return typeof navigator !== 'undefined' && !!(/** @type {any} */ (navigator).wakeLock?.request) && policyAllows();
}

/**
 * 63 PG1: a game framed by a portal (itch.io, CrazyGames) runs in an iframe whose `allow` list has
 * no screen-wake-lock, and asking there is not just refused: Chromium logs a "Permissions policy
 * violation" console error every time. Ask the frame's policy first (absent API = allowed).
 */
function policyAllows() {
	try {
		const d = /** @type {any} */ (typeof document !== 'undefined' ? document : null);
		const policy = d?.permissionsPolicy || d?.featurePolicy;
		return typeof policy?.allowsFeature !== 'function' || policy.allowsFeature('screen-wake-lock') !== false;
	} catch {
		return true;
	}
}

/** pure: is the lock wanted for these reasons on a page in this state @param {Set<string>|string[]} held @param {boolean} visible */
export function wakeWanted(held, visible) {
	return visible && (Array.isArray(held) ? held.length : held.size) > 0;
}

function visible() {
	return typeof document === 'undefined' || document.visibilityState === 'visible';
}

async function reconcile() {
	if (!wakeLockSupported()) return;
	const want = wakeWanted(reasons, visible());
	if (want && !sentinel && !asking) {
		asking = true;
		try {
			sentinel = await /** @type {any} */ (navigator).wakeLock.request('screen');
			sentinel.addEventListener?.('release', () => {
				sentinel = null;
			});
			// the reasons may have gone while we asked
			if (!wakeWanted(reasons, visible())) await release();
		} catch {
			sentinel = null; // refused (no activation, battery saver, a policy): stay silent
		} finally {
			asking = false;
		}
	} else if (!want && sentinel) await release();
}

async function release() {
	const s = sentinel;
	sentinel = null;
	try {
		await s?.release?.();
	} catch {
		/* already released */
	}
}

/** hold or let go of one reason @param {string} reason @param {boolean} on */
export function holdWake(reason, on) {
	const had = reasons.has(reason);
	if (on === had) return;
	if (on) reasons.add(reason);
	else reasons.delete(reason);
	void reconcile();
}

/**
 * Wire the sources an app has. Each entry: a reason, a store, and when it holds.
 * @param {{reason: string, store: import('svelte/store').Readable<any>, holds: (value: any) => boolean}[]} sources
 * @returns {() => void} stop
 */
export function startWakeLock(sources) {
	if (!wakeLockSupported()) return () => {};
	const stops = sources.map(({ reason, store, holds }) => store.subscribe((value) => holdWake(reason, !!holds(value))));
	if (!listening && typeof document !== 'undefined') {
		listening = true;
		document.addEventListener('visibilitychange', () => void reconcile());
	}
	return () => {
		for (const stop of stops) stop();
		for (const { reason } of sources) holdWake(reason, false);
	};
}

/** test / debug view */
export function wakeLockDebug() {
	return { supported: wakeLockSupported(), reasons: [...reasons], held: !!sentinel && !sentinel.released };
}
