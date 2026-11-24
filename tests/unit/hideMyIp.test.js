// 71 TR4: the relay policy on a Peer's ICE config, and the fail-closed status.
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import {
	hideMyIp,
	withRelayPolicy,
	hasRelayServer,
	relayStatus,
	applyHideMyIp,
	relayDialWait,
	whenRelayReady,
	RELAY_DIAL_WAIT_MS,
	NO_RELAY_DIAL_WAIT_MS
} from '../../src/lib/hideMyIp.js';

const stun = { urls: 'stun:example.org:3478' };
const turn = { urls: ['turn:example.org:3478?transport=udp'], username: 'u', credential: 'c' };

describe('hideMyIp', () => {
	beforeEach(() => hideMyIp.set(false));

	it('is off by default, and the policy keeps every other key', () => {
		expect(get(hideMyIp)).toBe(false);
		const on = withRelayPolicy({ iceServers: [turn], sdpSemantics: 'unified-plan' }, true);
		expect(on).toEqual({ iceServers: [turn], sdpSemantics: 'unified-plan', iceTransportPolicy: 'relay' });
		expect(withRelayPolicy(on, false)).toEqual({ iceServers: [turn], sdpSemantics: 'unified-plan' });
		expect(withRelayPolicy(undefined, true)).toEqual({ iceTransportPolicy: 'relay' });
	});

	it('a STUN server is not a relay', () => {
		expect(hasRelayServer({ iceServers: [stun] })).toBe(false);
		expect(hasRelayServer({ iceServers: [stun, turn] })).toBe(true);
		expect(hasRelayServer({ iceServers: [{ urls: 'turns:example.org:5349' }] })).toBe(true);
		expect(hasRelayServer({})).toBe(false);
		expect(hasRelayServer(undefined)).toBe(false);
		expect(hasRelayServer({ iceServers: [null, { urls: null }] })).toBe(false);
	});

	it('the status fails closed: on with no relay is its own state', () => {
		expect(relayStatus(false, { iceServers: [] })).toBe('off');
		expect(relayStatus(false, { iceServers: [turn] })).toBe('off');
		expect(relayStatus(true, { iceServers: [turn] })).toBe('relay');
		expect(relayStatus(true, { iceServers: [stun] })).toBe('no-relay');
	});

	it('goes on a live Peer without losing what the cloud plugin put there', () => {
		const peer = /** @type {any} */ ({ options: { config: { iceServers: [stun] } } });
		applyHideMyIp(peer, true);
		expect(peer.options.config.iceTransportPolicy).toBe('relay');
		// the plugin's own rewrite (turn.js): Object.assign over the config
		peer.options.config = Object.assign({}, peer.options.config, { iceServers: [stun, turn] });
		expect(peer.options.config.iceTransportPolicy).toBe('relay');
		const same = peer.options.config;
		applyHideMyIp(peer, true);
		expect(peer.options.config).toBe(same);
		applyHideMyIp(peer, false);
		expect(peer.options.config).toEqual({ iceServers: [stun, turn] });
		expect(() => applyHideMyIp(null, true)).not.toThrow();
		expect(() => applyHideMyIp({}, true)).not.toThrow();
	});

	it('a dial is only watched with the setting on, and sooner with no relay', () => {
		const withRelay = { options: { config: { iceServers: [turn] } } };
		const without = { options: { config: { iceServers: [stun] } } };
		expect(relayDialWait(withRelay)).toBe(null);
		hideMyIp.set(true);
		expect(relayDialWait(withRelay)).toBe(RELAY_DIAL_WAIT_MS);
		expect(relayDialWait(without)).toBe(NO_RELAY_DIAL_WAIT_MS);
	});

	it('a boot dial waits for the relay, and not for ever', async () => {
		const peer = /** @type {any} */ ({ options: { config: { iceServers: [] } } });
		await whenRelayReady(peer); // off: at once
		hideMyIp.set(true);
		let done = false;
		const p = whenRelayReady(peer, { timeoutMs: 5000, pollMs: 5 }).then(() => (done = true));
		await new Promise((r) => setTimeout(r, 30));
		expect(done).toBe(false);
		peer.options.config = { iceServers: [turn] };
		await p;
		expect(done).toBe(true);
		const t0 = Date.now();
		await whenRelayReady({ options: {} }, { timeoutMs: 40, pollMs: 5 });
		expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
	});
});
