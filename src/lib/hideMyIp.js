// 71 TR4 — HIDE MY IP: relay-only connections, chosen per device in Settings ▸ Privacy.
//
// A WebRTC peer learns the address of whoever it connects to from the ICE candidates that
// person's browser gathers. `iceTransportPolicy: 'relay'` makes the browser gather only relay
// candidates, so peers see the TURN server's address and never yours.
//
// THE RULES:
//   - The policy sits on the LIVE Peer's `options.config`, because PeerJS builds every
//     RTCPeerConnection (dialled, answered, data, voice) from that object at that moment. It is
//     set on the Peer rather than in resolvePeerOptions, because `options === undefined` there
//     means "PeerJS's own defaults" and any `config` passed in would replace those defaults.
//   - FAIL CLOSED. With no relay server there is nothing to connect through, and the connection
//     fails, with a sentence saying why. It never falls back to a direct connection.
//   - A connection that is already up keeps the route it made: the other person already holds
//     that address, and PeerJS has no renegotiation to move it. The row says so.
//   - A Settings reset does not switch this off: a reset must not quietly drop a protection.
import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';

const KEY = 'hideMyIp';

/** how long a hide-my-IP dial may stay unopened before the toast explains why */
export const RELAY_DIAL_WAIT_MS = 20000;
/** the same, when no relay server was there to start with */
export const NO_RELAY_DIAL_WAIT_MS = 6000;
/** how long a boot-time dial waits for a relay credential (the cloud plugin fetches one) */
export const RELAY_READY_WAIT_MS = 4000;

/** @type {import('svelte/store').Writable<boolean>} */
export const hideMyIp = writable(safeStorage.getItem(KEY) === 'true');
hideMyIp.subscribe((on) => safeStorage.setItem(KEY, on ? 'true' : 'false'));

/**
 * The ICE config with the relay policy on or off, every other key kept. A new object: the plugin
 * and PeerJS may hold the old one.
 * @param {any} config @param {boolean} on @returns {any}
 */
export function withRelayPolicy(config, on) {
	const next = { ...(config || {}) };
	if (on) next.iceTransportPolicy = 'relay';
	else delete next.iceTransportPolicy;
	return next;
}

/** Does this ICE config name a relay? A STUN server cannot carry traffic. @param {any} config */
export function hasRelayServer(config) {
	const list = config?.iceServers;
	if (!Array.isArray(list)) return false;
	return list.some((s) => {
		const urls = Array.isArray(s?.urls) ? s.urls : [s?.urls];
		return urls.some((/** @type {any} */ u) => /^turns?:/i.test(String(u ?? '')));
	});
}

/**
 * What the Settings row says.
 * @param {boolean} on @param {any} config @returns {'off'|'relay'|'no-relay'}
 */
export function relayStatus(on, config) {
	if (!on) return 'off';
	return hasRelayServer(config) ? 'relay' : 'no-relay';
}

/**
 * Put the current choice on a live Peer (idempotent, keeps whatever else is on its config).
 * @param {any} peer @param {boolean} [on]
 */
export function applyHideMyIp(peer, on = get(hideMyIp)) {
	if (!peer?.options) return;
	const has = peer.options.config?.iceTransportPolicy === 'relay';
	if (has === on) return;
	peer.options.config = withRelayPolicy(peer.options.config, on);
}

/**
 * Resolve once this Peer has a relay server, or after `timeoutMs`. Only for a dial made at boot:
 * the cloud plugin puts its TURN credential on the Peer about a second later, and a hide-my-IP
 * dial before that would have nothing to connect through. Answers at once when the setting is off.
 * @param {any} peer @param {{timeoutMs?: number, pollMs?: number}} [opts] @returns {Promise<void>}
 */
export function whenRelayReady(peer, { timeoutMs = RELAY_READY_WAIT_MS, pollMs = 100 } = {}) {
	if (!get(hideMyIp) || hasRelayServer(peer?.options?.config)) return Promise.resolve();
	const t0 = Date.now();
	return new Promise((resolve) => {
		const t = setInterval(() => {
			if (hasRelayServer(peer?.options?.config) || Date.now() - t0 >= timeoutMs) {
				clearInterval(t);
				resolve();
			}
		}, pollMs);
	});
}

/** how long to give this dial, or null with the setting off @param {any} peer @returns {number | null} */
export function relayDialWait(peer) {
	if (!get(hideMyIp)) return null;
	return hasRelayServer(peer?.options?.config) ? RELAY_DIAL_WAIT_MS : NO_RELAY_DIAL_WAIT_MS;
}

export const RELAY_DIAL_FAILED = 'Could not connect through a relay server. Hide my IP is on, so no direct connection was tried. You can change it in Settings ▸ Privacy.';
