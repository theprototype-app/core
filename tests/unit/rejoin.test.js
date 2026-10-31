// @ts-nocheck — plain fixtures
// fix-agenttest item 6: a guest's reload goes back to the session it was in (rejoin.js), and the
// restore prompt is offered only when there is no live session to go back to.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { get } from 'svelte/store';

const mem = new Map();
globalThis.sessionStorage = {
	getItem: (k) => (mem.has(k) ? mem.get(k) : null),
	setItem: (k, v) => mem.set(k, String(v)),
	removeItem: (k) => mem.delete(k)
};

/** @type {any} */ let R;
beforeAll(async () => {
	R = await import('../../src/lib/rejoin.js');
});
beforeEach(() => {
	mem.clear();
	R.rejoinState.set('none');
});

describe('rejoin record', () => {
	it('remembers a guest\'s session for this tab, and forgets it when not joined', () => {
		R.rememberRejoin('b0b0b', 'a1a1a', 1000);
		expect(R.peekRejoin(1500)).toEqual({ id: 'b0b0b', host: 'a1a1a', at: 1000 });
		R.rememberRejoin('b0b0b', null, 2000);
		expect(R.peekRejoin(2000)).toBe(null);
		R.rememberRejoin('a1a1a', 'a1a1a', 2000); // the host itself is never "joined"
		expect(R.peekRejoin(2000)).toBe(null);
	});

	it('is fresh only inside the window, and junk reads as nothing', () => {
		R.rememberRejoin('b0b0b', 'a1a1a', 1000);
		expect(R.peekRejoin(1000 + R.REJOIN_WINDOW_MS)).not.toBe(null);
		expect(R.peekRejoin(1001 + R.REJOIN_WINDOW_MS)).toBe(null);
		mem.set(R.REJOIN_KEY, '{nope');
		expect(R.peekRejoin()).toBe(null);
		mem.set(R.REJOIN_KEY, JSON.stringify({ id: '<script>', host: 'a1a1a', at: Date.now() }));
		expect(R.peekRejoin()).toBe(null);
	});

	it('is taken ONCE per page, and marks the rejoin pending', () => {
		R.rememberRejoin('b0b0b', 'a1a1a');
		expect(R.takeRejoin()).toMatchObject({ id: 'b0b0b', host: 'a1a1a' });
		expect(get(R.rejoinState)).toBe('pending');
		expect(R.takeRejoin()).toBe(null);
	});
});

describe('rejoinOutcome (what the restore prompt waits for)', () => {
	it('answers none straight away with nothing to rejoin', async () => {
		expect(await R.rejoinOutcome()).toBe('none');
	});

	it('waits while the dial is pending, then answers joined or failed — settled once', async () => {
		R.rejoinState.set('pending');
		const p = R.rejoinOutcome();
		R.settleRejoin('joined');
		R.settleRejoin('failed'); // a late timeout changes nothing
		expect(await p).toBe('joined');
		expect(get(R.rejoinState)).toBe('joined');
		R.rejoinState.set('pending');
		const q = R.rejoinOutcome();
		R.settleRejoin('failed');
		expect(await q).toBe('failed');
	});
});

describe('the wiring', () => {
	const peer = readFileSync(new URL('../../src/lib/peerHandler.svelte.js', import.meta.url), 'utf8');
	const autosave = readFileSync(new URL('../../src/lib/autosave.js', import.meta.url), 'utf8');

	it('a reload says it is one, and the guest comes back on its id dialling the host', () => {
		expect(peer).toMatch(/broadcast\(\{ type: 'disconnected', peerId: this\.peer\.id, unload: true \}\)/);
		expect(peer).toMatch(/this\.myId = rejoin\?\.id \?\? id;/);
		// 55: the hash is an invite (`#<id>&…`), read through parseInviteHash
		expect(peer).toMatch(/let connect = rejoinHost \?\? parseInviteHash\(window\.location\.hash\)/);
	});

	it('the host re-admits only an UNLOAD goodbye inside the window, never a removed peer', () => {
		expect(peer).toMatch(/data\.unload === true && this\.openedPeers\.has\(data\.peerId\)/);
		const removed = peer.indexOf('if (this.removedPeers.has(conn.peer)) {');
		const readmit = peer.indexOf('const leftAt = this.unloadedPeers.get(conn.peer);');
		expect(removed).toBeGreaterThan(0);
		expect(readmit).toBeGreaterThan(removed);
		expect(peer).toMatch(/Date\.now\(\) - leftAt <= REJOIN_WINDOW_MS && !roomIsFull\(this\)/);
	});

	it('the restore prompt waits for the rejoin and stands down when it joined', () => {
		expect(autosave).toMatch(/if \(\(await rejoinOutcome\(\)\) === 'joined'\) return settleRestore\(\);/);
	});
});
