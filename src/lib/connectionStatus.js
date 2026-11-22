// 41-modals G21 — ONE connection status, read by the Connect pill (desktop) and the phone chip.
//
// The pill shows NO text: a status dot (grey idle · yellow pulsing connecting/reconnecting · green
// connected · red failed) + chevron (+ mic in a call). The WORDS ride the tooltip and aria-label, so a
// pill that sits beside the bell and the peers fits at any width (space-connect-svelte.jpg) and a tab
// switch on a phone, which drops and re-opens the signaling socket, says nothing out loud
// (reconnect.jpg: three toasts). "Failed" is the one state that needs the person: the retry never
// gives up (27-F), but past GIVE_UP_ATTEMPTS it is red and ONE notification-centre entry says so.
//
// A LEAF: svelte/store + two store-only modules, so the UI and peerHandler both import it freely.
import { derived } from 'svelte/store';
import { peers, waitingForApproval, userdata } from '../stores/appStore';
import { signalingRetry, sessionHost } from './connectionState';

/** attempts after which a signaling outage counts as failed (~1 min on the 27-F backoff) */
export const GIVE_UP_ATTEMPTS = 6;

/**
 * @typedef {'idle'|'connecting'|'connected'|'failed'} ConnTone
 * @param {{open: number, pending: string|null, signalingOpen: boolean, retrying: boolean, attempt: number,
 *   hosting: boolean, hostLabel?: string}} s
 * @returns {{tone: ConnTone, words: string}}
 */
export function connectionStatusOf(s) {
	const peersWord = (/** @type {number} */ n) => n + ' peer' + (n === 1 ? '' : 's');
	const server = s.retrying
		? s.attempt >= GIVE_UP_ATTEMPTS
			? "can't reach the peer server — still retrying"
			: 'reconnecting to the peer server…'
		: '';
	if (s.open > 0) {
		// live peers are unaffected by a signaling outage, so the dot stays green and says so
		const who = s.hosting ? 'Hosting ' + peersWord(s.open) : 'Connected to ' + peersWord(s.open);
		return { tone: 'connected', words: who + (server ? ' — ' + server : '') };
	}
	if (s.retrying && s.attempt >= GIVE_UP_ATTEMPTS) return { tone: 'failed', words: "Can't reach the peer server — still retrying" };
	if (s.retrying) return { tone: 'connecting', words: 'Reconnecting to the peer server…' };
	if (s.pending) return { tone: 'connecting', words: 'Connecting… waiting for ' + s.pending + ' to approve' };
	if (!s.signalingOpen) return { tone: 'connecting', words: 'Connecting to the peer server…' };
	return { tone: 'idle', words: 'Not connected' };
}

/**
 * 41b H4 (refines G21): the SHORT state word the phone chip shows beside its dot when the top bar
 * has room for it — the chip drops back to dot-only only when it is crowded (container width, not
 * device). The full sentence stays the tooltip and the accessible name.
 * @param {ConnTone} tone @returns {string}
 */
export function connectionLabel(tone) {
	if (tone === 'connected') return 'Connected';
	if (tone === 'connecting') return 'Connecting…';
	// 94 SP6: a fresh page is not "offline" — it simply has not connected yet, and the desktop pill
	// says Connect for the same state, so the phone chip says the same one word. A peer server
	// that keeps failing still says Offline: that one IS a fault.
	if (tone === 'idle') return 'Connect';
	return 'Offline';
}

/** the live status: {tone, words} */
export const connectionStatus = derived([peers, waitingForApproval, signalingRetry, sessionHost, userdata], ([$peers, $waiting, $retry, $host]) => {
	const pc = /** @type {any} */ ($peers);
	const pending = (/** @type {any[]} */ ($waiting ?? [])).find((w) => w?.[1] === 'pending');
	return connectionStatusOf({
		open: pc?.openedPeers?.size ?? 0,
		pending: pending ? String(pending[0]).toUpperCase() : null,
		signalingOpen: !!pc?.peer?.open,
		retrying: !!$retry?.retrying,
		attempt: Number($retry?.attempt) || 0,
		hosting: !$host
	});
});
