// @ts-nocheck — a fake peer instance
// fix-agenttest item 5: a joiner does not pull the graphs twice — a host's nodesync that arrives
// before the handshake's own `nodes` snapshot is held back; drift after it is pulled as before.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { peers } = await import('../../src/stores/appStore.js');
const { flowGraphs } = await import('../../src/stores/flowStore.js');
const N = await import('../../src/lib/nodesHandler.js');

let sent;
beforeEach(() => {
	sent = [];
	N.forgetNodeSyncPeer();
	vi.useRealTimers();
	peers.set({ peer: { id: 'zz-joiner' }, connections: { host: { open: true, send: (m) => sent.push(m) } } });
	flowGraphs.set({});
});

const sync = (count = 5) => N.applyNodeSync({ type: 'nodesync', peerId: 'host', hash: 123, count });

describe('nodesync during a join', () => {
	it('holds a nodesync back while the first snapshot is on its way, then pulls if it never came', () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		sync();
		expect(sent).toEqual([]);
		vi.setSystemTime(1_000_000 + N.NODESYNC_HANDSHAKE_MS - 1);
		sync();
		expect(sent).toEqual([]);
		vi.setSystemTime(1_000_000 + N.NODESYNC_HANDSHAKE_MS);
		sync();
		expect(sent.map((m) => m.type)).toEqual(['getnodes']);
		expect(N.nodeSyncDebug().handshakeSkips).toBeGreaterThanOrEqual(2);
	});

	it('compares at once after the snapshot arrived (real drift is still pulled)', () => {
		vi.useFakeTimers();
		vi.setSystemTime(5_000_000);
		N.noteNodesSnapshot('host');
		sync();
		expect(sent.map((m) => m.type)).toEqual(['getnodes']);
	});

	it('forgets a departed peer, so its next join is a handshake again', () => {
		N.noteNodesSnapshot('host');
		N.forgetNodeSyncPeer('host');
		expect(N.nodeSyncDebug().snapshotFrom).toEqual([]);
	});
});
