// @ts-nocheck — plain fixtures
// 80a-int: edges of the lock table, the lock mode, the heal answer and the drafts gate.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { get } from 'svelte/store';
import { scrubDrafts } from '../../src/lib/draftGateCore.js';
import { clearInboundDraftFlags } from '../../src/lib/objectPermissions.js';
import { stampRestoredRows, holderOf, sortLockTable, LOCK_RACE_MS } from '../../src/lib/lockTrust.js';
import { lockMode, setLockMode, applyLockMode, resetLockMode } from '../../src/lib/lockMode.js';
import { sessionHost } from '../../src/lib/connectionState.js';
import { VALIDATORS, LOCK_SET_MAX, LOCK_TABLE_MAX_ROWS } from '../../src/lib/wireValidate.js';

describe('drafts gate: a message type is never a draft', () => {
	it('a draft whose uuid reads like a message type does not stop that type', () => {
		const isDraft = (u) => u === 'move' || u === 'lock';
		const move = { type: 'move', uuid: 'shared-1', pos: [0, 0, 0] };
		expect(scrubDrafts(move, isDraft)).toBe(move);
		const lock = { type: 'lock', uuid: 'shared-1', uuids: ['shared-1'] };
		expect(scrubDrafts(lock, isDraft)).toBe(lock);
	});
	it('a message about a real draft still stays home', () => {
		expect(scrubDrafts({ type: 'move', uuid: 'd-1' }, (u) => u === 'd-1')).toBe(null);
	});
	it('an object from a peer carries no draft flag into the scene', () => {
		const root = new THREE.Group();
		root.userData.__localOnly = true;
		const child = new THREE.Mesh();
		child.userData.__localOnly = true;
		root.add(child);
		clearInboundDraftFlags(root);
		expect('__localOnly' in root.userData).toBe(false);
		expect('__localOnly' in child.userData).toBe(false);
	});
});

describe('lock table: restored rows are stamped like a lock set', () => {
	const now = 100000;
	it('a claim on an object someone holds is not dated back past the race window', () => {
		const table = [['alice', 'X', now - 60000]];
		const rows = stampRestoredRows([['mallory', 'X', -1e300]], table, () => null, now);
		expect(rows[0][2]).toBe(now - LOCK_RACE_MS);
		expect(holderOf(sortLockTable([...table, ...rows]), 'X')).toBe('alice');
	});
	it('our own claim counts as held', () => {
		const rows = stampRestoredRows([['mallory', 'Y', -5]], [], (u) => (u === 'Y' ? { self: 'me', at: now - 9000 } : null), now);
		expect(rows[0][2]).toBe(now - LOCK_RACE_MS);
		expect(holderOf(rows, 'Y', { self: 'me', at: now - 9000 })).toBe('me');
	});
	it('an object nobody else holds keeps its stamp (a late joiner learns the real order)', () => {
		expect(stampRestoredRows([['bob', 'Z', now - 60000]], [], () => null, now)[0][2]).toBe(now - 60000);
	});
	it('a row the table already has keeps the stored stamp', () => {
		expect(stampRestoredRows([['bob', 'Z', 1]], [['bob', 'Z', now - 500]], () => null, now)[0][2]).toBe(now - 500);
	});
	it('rows without a stamp pass through', () => {
		expect(stampRestoredRows([['bob', 'Z']], [], () => null, now)[0]).toEqual(['bob', 'Z']);
	});
});

describe('lock mode: a stamp far ahead does not freeze the mode', () => {
	beforeEach(() => {
		sessionHost.set('host-1');
		resetLockMode();
	});
	afterEach(() => sessionHost.set(null));
	it('the host can still change the mode after a far-future stamp', () => {
		applyLockMode({ mode: 'edit', at: Number.MAX_VALUE }, 'host-1');
		expect(get(lockMode).mode).toBe('edit');
		sessionHost.set(null); // we host now
		expect(setLockMode('select')).toBe(true);
		sessionHost.set('host-1');
		applyLockMode({ mode: 'edit', at: get(lockMode).at + 1 }, 'host-1');
		expect(get(lockMode).mode).toBe('edit');
	});
});

describe('wire shapes: lock sets and tables are bounded', () => {
	const many = (n) => Array.from({ length: n }, (_, i) => 'u' + i);
	it('lock', () => {
		expect(VALIDATORS.lock({ uuid: 'u0', uuids: many(LOCK_SET_MAX) })).toBe(true);
		expect(VALIDATORS.lock({ uuid: 'u0', uuids: many(LOCK_SET_MAX + 1) })).toBe(false);
		expect(VALIDATORS.lock({ uuid: 'u0', uuids: ['u0'], ats: new Array(LOCK_SET_MAX + 1).fill(1) })).toBe(false);
	});
	it('locked', () => {
		expect(VALIDATORS.locked({ lockeditems: new Array(LOCK_TABLE_MAX_ROWS).fill(['a', 'b']) })).toBe(true);
		expect(VALIDATORS.locked({ lockeditems: new Array(LOCK_TABLE_MAX_ROWS + 1).fill(['a', 'b']) })).toBe(false);
	});
});

describe('heal answers are paced', () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());
	it('a stream of refused flow edits gets one heal per peer per second', async () => {
		const lc = await import('../../src/lib/lockControl.js');
		const { lockedObjects } = await import('../../src/stores/sceneStore.js');
		const { peers } = await import('../../src/stores/appStore.js');
		const { myLocks } = await import('../../src/lib/lockHeld.js');
		peers.set({ peer: { id: 'me' }, connections: {} });
		myLocks.set(new Map([['G', 1]]));
		lockedObjects.set([]);
		const heal = vi.fn();
		const send = vi.fn();
		const conn = { open: true, send };
		for (let i = 0; i < 40; i++) {
			lc.gateLockedEdit('mallory', { type: 'nodemove', graphId: 'G', id: 'n' + i, position: { x: 0, y: 0 } }, { runtime: false, replay: () => {}, heal, conn });
			vi.advanceTimersByTime(50);
		}
		vi.advanceTimersByTime(5000);
		// 2 s of edits: the heal waits LOCK_HEAL_MS after a pause, and no more than one per LOCK_HEAL_GAP_MS
		expect(heal.mock.calls.length).toBeGreaterThan(0);
		expect(heal.mock.calls.length).toBeLessThanOrEqual(3);
		lc.dropPeerLockState('mallory');
	});
	it('a link that heals again at once does not make us let go twice', async () => {
		const lc = await import('../../src/lib/lockControl.js');
		const { myLocks } = await import('../../src/lib/lockHeld.js');
		const { peers } = await import('../../src/stores/appStore.js');
		peers.set({ peer: { id: 'me' }, connections: {}, send: () => {} });
		myLocks.set(new Map());
		lc.releaseOnHeal('p1'); // first heal: nothing held, still counts
		myLocks.set(new Map([['A', 1]]));
		lc.releaseOnHeal('p1');
		expect(get(myLocks).has('A')).toBe(true);
		vi.advanceTimersByTime(lc.LOCK_HEAL_RELEASE_GAP_MS + 1);
		lc.releaseOnHeal('p1');
		expect(get(myLocks).has('A')).toBe(false);
	});
});
