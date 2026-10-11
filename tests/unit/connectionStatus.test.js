// 41-modals G21: the ONE connection status the Connect pill and the phone chip draw as a dot
import { describe, it, expect } from 'vitest';
import { connectionStatusOf, GIVE_UP_ATTEMPTS } from '../../src/lib/connectionStatus.js';

const base = { open: 0, pending: null, signalingOpen: true, retrying: false, attempt: 0, hosting: true };

describe('connectionStatusOf', () => {
	it('is grey and says "Not connected" with nobody connected and the link up', () => {
		expect(connectionStatusOf(base)).toEqual({ tone: 'idle', words: 'Not connected' });
	});
	it('is yellow while the peer server is not open yet, while dialling, and while reconnecting', () => {
		expect(connectionStatusOf({ ...base, signalingOpen: false }).tone).toBe('connecting');
		expect(connectionStatusOf({ ...base, pending: 'AB12C' })).toEqual({ tone: 'connecting', words: 'Connecting… waiting for AB12C to approve' });
		expect(connectionStatusOf({ ...base, retrying: true, attempt: 1 }).words).toMatch(/Reconnecting/);
	});
	it('turns red past the give-up threshold, and only then', () => {
		expect(connectionStatusOf({ ...base, retrying: true, attempt: GIVE_UP_ATTEMPTS - 1 }).tone).toBe('connecting');
		expect(connectionStatusOf({ ...base, retrying: true, attempt: GIVE_UP_ATTEMPTS }).tone).toBe('failed');
	});
	it('stays green with live peers through a signaling outage, and says so in words', () => {
		expect(connectionStatusOf({ ...base, open: 2 })).toEqual({ tone: 'connected', words: 'Hosting 2 peers' });
		expect(connectionStatusOf({ ...base, open: 1, hosting: false }).words).toBe('Connected to 1 peer');
		const s = connectionStatusOf({ ...base, open: 2, retrying: true, attempt: GIVE_UP_ATTEMPTS + 3 });
		expect(s.tone).toBe('connected');
		expect(s.words).toMatch(/can't reach the peer server/);
	});
});
