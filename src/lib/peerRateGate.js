// 71 TR7 — the rate limits, wired: the setting (per device, default Normal), the check peerHandler makes right
// after the capability gate, and the two notices. The session host is exempt: it owns the room, and what it
// sends on a join is what everyone came for. Rules: peerRateLimit.js.
import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';
import { createRateLimiter, RATE_PRESETS, DEFAULT_RATE_PRESET } from './peerRateLimit';
import { showToast } from '../stores/appStore';
import { sessionHost } from './connectionState';
import { canModerate, peerLabel, removePeer } from './peerModeration';

const KEY = 'connect:rateLimits';
const NOTICE_MS = 30000;

const stored = safeStorage.getItem(KEY);
/** @type {import('svelte/store').Writable<string>} */
export const peerRateLimits = writable(stored && stored in RATE_PRESETS ? stored : DEFAULT_RATE_PRESET);
peerRateLimits.subscribe((v) => safeStorage.setItem(KEY, v));

const limiter = createRateLimiter();
/** @type {Map<string, number>} */
const told = new Map();

/** once per 30 s per key @param {string} key */
function sayNow(key) {
	const t = Date.now();
	if (t - (told.get(key) ?? -Infinity) < NOTICE_MS) return false;
	if (told.size > 512) told.clear();
	told.set(key, t);
	return true;
}

/**
 * The receive gate. False = drop it: this peer is over its limit.
 * @param {any} conn @param {any} type @returns {boolean}
 */
export function admitRate(conn, type) {
	const peerId = conn.peer;
	if (get(sessionHost) === peerId) return true;
	const over = limiter.take(peerId, type, get(peerRateLimits));
	if (over === 'ok') return true;
	if (sayNow(peerId + '|' + over)) {
		const what = over === 'chat' ? 'chat messages' : 'edits';
		showToast(`${peerLabel(peerId)} is sending too many ${what}, so some were ignored.`, canModerate() ? [{ label: 'Remove', action: () => removePeer(peerId) }] : undefined);
		try {
			conn.send({ type: 'ratelimited', kind: over });
		} catch {
			/* a link going down has nothing to say it on */
		}
	}
	return false;
}

/** the receiver told us @param {any} data */
export function applyRateNotice(data) {
	const kind = data?.kind === 'chat' ? 'chat' : 'edit';
	if (!sayNow('me|' + kind)) return;
	showToast(`You are sending ${kind === 'chat' ? 'messages' : 'edits'} very fast, so some did not reach everyone. Slow down for a moment.`);
}
