// 80a K6: an object we hold and stopped editing is let go after LOCK_IDLE_MS, so a selection left
// behind (a coffee break, a tab in the background) does not block everyone else. LOCK_ASK_MS before
// that the holder is asked: "Still editing Crate?" Keep holding / Release. No answer = let go, and
// the toast says so. Runs only while we hold something (a 15 s check, cheap).
import { get } from 'svelte/store';
import { myLocks, myLockIdle, touchMyLock } from './lockHeld';

export const LOCK_IDLE_MS = 5 * 60 * 1000;
export const LOCK_ASK_MS = 30 * 1000;
const CHECK_MS = 15 * 1000;

/**
 * Pure: what to do about each held object given how long it has been idle.
 * @param {[string, number][]} idle uuid -> ms since last edit
 * @param {Set<string>} asked the objects we already asked about
 * @param {{idleMs?: number, askMs?: number}} [opts]
 * @returns {{ask: string[], release: string[]}}
 */
export function idleVerdict(idle, asked, opts = {}) {
	const idleMs = opts.idleMs ?? LOCK_IDLE_MS;
	const askMs = opts.askMs ?? LOCK_ASK_MS;
	/** @type {string[]} */ const ask = [];
	/** @type {string[]} */ const release = [];
	for (const [u, ms] of idle) {
		if (ms >= idleMs) release.push(u);
		else if (ms >= idleMs - askMs && !asked.has(u)) ask.push(u);
	}
	return { ask, release };
}

/** @type {Set<string>} */
const asked = new Set();
/** @type {any} */
let timer = null;
/** test hook: shorter windows @type {{idleMs?: number, askMs?: number}} */
let windows = {};

/**
 * @param {{
 *   say: (text: string, actions?: {label: string, action: () => void}[]) => void,
 *   letGo: (uuids: string[]) => void,
 *   nameOf: (uuid: string) => string,
 *   alone: () => boolean
 * }} hooks
 */
export function startLockIdle(hooks) {
	const check = () => {
		const held = get(myLocks);
		for (const u of [...asked]) if (!held.has(u)) asked.delete(u);
		// alone, a held object blocks nobody: the count starts when somebody is here to be blocked
		if (hooks.alone()) {
			for (const u of held.keys()) touchMyLock(u);
			return;
		}
		const { ask, release } = idleVerdict(myLockIdle(), asked, windows);
		if (release.length) {
			for (const u of release) asked.delete(u);
			hooks.letGo(release);
			hooks.say(
				release.length === 1
					? `You let go of "${hooks.nameOf(release[0])}" after ${minutes()} without an edit`
					: `You let go of ${release.length} objects after ${minutes()} without an edit`
			);
		}
		if (ask.length) {
			for (const u of ask) asked.add(u);
			const label = ask.length === 1 ? `"${hooks.nameOf(ask[0])}"` : `${ask.length} objects`;
			hooks.say(`Still editing ${label}? Others can't change it while you hold it.`, [
				{
					label: 'Keep holding',
					action: () => {
						for (const u of ask) (touchMyLock(u), asked.delete(u));
					}
				},
				{ label: 'Release', action: () => hooks.letGo(ask.filter((u) => get(myLocks).has(u))) }
			]);
		}
	};
	const arm = () => {
		const any = get(myLocks).size > 0;
		if (any && !timer) timer = setInterval(check, windows.idleMs && windows.idleMs < 60000 ? 1000 : CHECK_MS);
		if (!any && timer) (clearInterval(timer), (timer = null), asked.clear());
	};
	const stop = myLocks.subscribe(arm);
	return () => {
		stop();
		if (timer) clearInterval(timer);
		timer = null;
	};
}

function minutes() {
	const m = Math.round((windows.idleMs ?? LOCK_IDLE_MS) / 60000);
	return m >= 1 ? `${m} minute${m === 1 ? '' : 's'}` : `${Math.round((windows.idleMs ?? 0) / 1000)} seconds`;
}

/** test seam (debug hook): shorter windows, e.g. {idleMs: 6000, askMs: 3000}; {} restores @param {{idleMs?: number, askMs?: number}} w */
export function setLockIdleWindows(w) {
	windows = { ...w };
}
