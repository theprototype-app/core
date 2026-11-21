// @ts-nocheck — plain fixtures
// 80a-int: edges of the lock table, the lock mode, the heal answer and the drafts gate.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
// lockControl's scene appliers (runes / the whole selection stack) are not what these cases test
vi.mock('../../src/lib/geometries.svelte', () => ({ lockGeometry: () => {} }));
vi.mock('../../src/lib/objectActions', () => ({ selectObject: () => {}, applySelectionSet: () => {}, deselectObject: () => {} }));
import { get } from 'svelte/store';
import { scrubDrafts } from '../../src/lib/draftGateCore.js';
import { clearInboundDraftFlags, isDraftId, gateDraftsInbound, markLocalOnly } from '../../src/lib/objectPermissions.js';
import { objectsGroup } from '../../src/stores/sceneStore.js';
import { stampRestoredRows, holderOf, sortLockTable, mergeLockRows, acceptedLockRows, LOCK_RACE_MS, LOCK_ROWS_PER_PEER } from '../../src/lib/lockTrust.js';
import { lockMode, applyLockMode, resetLockMode, LOCK_MODE_SKEW_MS } from '../../src/lib/lockMode.js';
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

describe('drafts gate: only object ids count as drafts', () => {
	it('a message word or a short graph id is never a draft id', () => {
		for (const id of ['type', 'move', 'scene', 'G1', '', null]) expect(isDraftId(id)).toBe(false);
		expect(isDraftId('3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b')).toBe(true);
		expect(isDraftId('crate-0001')).toBe(true); // a file's own id
	});
	it('nothing a peer sends touches one of our drafts', () => {
		const group = new THREE.Group();
		const draft = new THREE.Group();
		draft.uuid = 'aaaaaaaa-0000-4000-8000-000000000001';
		const shared = new THREE.Mesh();
		shared.uuid = 'bbbbbbbb-0000-4000-8000-000000000002';
		group.add(draft, shared);
		markLocalOnly(draft);
		objectsGroup.set(group);
		try {
			expect(gateDraftsInbound({ type: 'group', uuid: draft.uuid, userData: { __localOnly: false } })).toBe(null);
			expect(gateDraftsInbound({ type: 'objectfile', uuid: draft.uuid, override: true })).toBe(null);
			expect(gateDraftsInbound({ type: 'group', uuid: shared.uuid, group: draft.uuid })).toBe(null);
			const move = { type: 'move', uuid: shared.uuid, pos: [0, 0, 0] };
			expect(gateDraftsInbound(move)).toBe(move);
		} finally {
			objectsGroup.set(undefined);
		}
	});
	it('a script cannot set or clear the draft flag', async () => {
		const { applyObjectPatch } = await import('../../src/lib/sandbox/scripts.js');
		const a = new THREE.Object3D();
		applyObjectPatch(a, { ud: { __localOnly: true, score: 1 } });
		expect('__localOnly' in a.userData).toBe(false);
		expect(a.userData.score).toBe(1);
		const b = new THREE.Object3D();
		b.userData.__localOnly = true;
		applyObjectPatch(b, { udDel: ['__localOnly'] });
		expect(b.userData.__localOnly).toBe(true);
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
	it("the host's table settles a claim a peer dated back before it arrived", () => {
		// a joiner: mallory's own row came first, on an empty table, so it kept its stamp
		let table = stampRestoredRows([['mallory', 'X', -1e300]], [], () => null, now);
		const hostRows = [['bob', 'X', now - 60000], ['mallory', 'X', now - 1000]];
		const rows = stampRestoredRows(hostRows, table, () => null, now, { from: 'host', fromHost: true });
		table = sortLockTable(mergeLockRows(table, rows, { replace: true }));
		expect(holderOf(table, 'X')).toBe('bob');
	});
	it('a peer names no more of its own locks than one lock set holds', () => {
		const many = Array.from({ length: LOCK_ROWS_PER_PEER + 50 }, (_, i) => ['mallory', 'u' + i]);
		expect(acceptedLockRows(many, { from: 'mallory', selfId: 'me', fromHost: false, mayLock: true }).length).toBe(LOCK_ROWS_PER_PEER);
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
	it('a far-future stamp holds the mode for at most LOCK_MODE_SKEW_MS', () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(1_000_000);
			applyLockMode({ mode: 'edit', at: Number.MAX_VALUE }, 'host-1');
			expect(get(lockMode).mode).toBe('edit');
			expect(get(lockMode).at).toBe(1_000_000 + LOCK_MODE_SKEW_MS);
			vi.setSystemTime(1_000_000 + LOCK_MODE_SKEW_MS + 1000);
			applyLockMode({ mode: 'select', at: Date.now() }, 'host-1');
			expect(get(lockMode).mode).toBe('select');
		} finally {
			vi.useRealTimers();
		}
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
	it('refused flow edits get at most one heal per peer per second', async () => {
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
		myLocks.set(new Map([['G1', 1], ['G2', 1]]));
		// one refused edit every 350 ms (just past LOCK_HEAL_MS), alternating two flows: 20 edits over 7 s
		for (let i = 0; i < 20; i++) {
			const graphId = i % 2 ? 'G2' : 'G1';
			lc.gateLockedEdit('mallory', { type: 'nodemove', graphId, id: 'n' + i, position: { x: 0, y: 0 } }, { runtime: false, replay: () => {}, heal, conn });
			vi.advanceTimersByTime(350);
		}
		vi.advanceTimersByTime(5000);
		// a flow heal sends every flow document: one per peer per LOCK_HEAL_GAP_MS (7 s -> at most 8), never one per edit
		expect(heal.mock.calls.length).toBeGreaterThan(0);
		expect(heal.mock.calls.length).toBeLessThanOrEqual(8);
		lc.dropPeerLockState('mallory');
	});
	it('object heals to one peer are capped per second, and every one still goes', async () => {
		const lc = await import('../../src/lib/lockControl.js');
		const { lockedObjects } = await import('../../src/stores/sceneStore.js');
		const { peers } = await import('../../src/stores/appStore.js');
		const { myLocks } = await import('../../src/lib/lockHeld.js');
		peers.set({ peer: { id: 'me' }, connections: {} });
		lockedObjects.set([]);
		const ids = Array.from({ length: 40 }, (_, i) => 'o' + i);
		myLocks.set(new Map(ids.map((u) => [u, 1])));
		const heal = vi.fn();
		const conn = { open: true, send: () => {} };
		for (const u of ids) lc.gateLockedEdit('mallory', { type: 'move', uuid: u, pos: [0, 0, 0] }, { runtime: false, replay: () => {}, heal, conn });
		vi.advanceTimersByTime(lc.LOCK_HEAL_GAP_MS - 1);
		expect(heal.mock.calls.length).toBeLessThanOrEqual(lc.LOCK_HEAL_PEER_MAX);
		vi.advanceTimersByTime(lc.LOCK_HEAL_GAP_MS * 4);
		expect(new Set(heal.mock.calls.map((c) => c[1])).size).toBe(40);
		lc.dropPeerLockState('mallory');
	});
	it('a lock message carries at most one lock set', async () => {
		const { lockMessage, myLocks } = await import('../../src/lib/lockHeld.js');
		const ids = Array.from({ length: LOCK_ROWS_PER_PEER + 10 }, (_, i) => 'u' + i);
		const msg = lockMessage(ids, 'me');
		expect(msg.uuids.length).toBe(LOCK_ROWS_PER_PEER);
		expect(VALIDATORS.lock(msg)).toBe(true);
		myLocks.set(new Map());
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
