// @ts-nocheck — a fake peer instance
// fix-agenttest item 5: a joiner does not pull the graphs twice — a host's nodesync that arrives
// before the handshake's own `nodes` snapshot is held back; drift after it is pulled as before.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { peers } = await import('../../src/stores/appStore.js');
const { flowGraphs } = await import('../../src/stores/flowStore.js');
const N = await import('../../src/lib/nodesHandler.js');
const THREE = await import('three');
const { objectsGroup } = await import('../../src/stores/sceneStore.js');

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

	it("an object graph whose object has not arrived yet is not drift (55 Q1 x the join)", () => {
		vi.useFakeTimers();
		vi.setSystemTime(9_000_000);
		const node = (id) => ({ id, type: 'spin', position: { x: 0, y: 0 }, data: {} });
		const group = new THREE.Group();
		const box = new THREE.Mesh();
		group.add(box);
		objectsGroup.set(group);
		flowGraphs.set({ scene: { nodes: [node('k1')], edges: [] }, [box.uuid]: { nodes: [node('spin1')], edges: [] } });
		const hostHash = N.graphHash(); // the host holds the box
		group.remove(box); // the joiner: the snapshot is here, the box is still on its way
		expect(N.graphHash()).not.toBe(hostHash);
		N.noteNodesSnapshot('host');
		N.applyNodeSync({ type: 'nodesync', peerId: 'host', hash: hostHash, count: 2 });
		expect(sent).toEqual([]);
		// a real difference still pulls
		N.applyNodeSync({ type: 'nodesync', peerId: 'host', hash: hostHash + 1, count: 2 });
		expect(sent.map((m) => m.type)).toEqual(['getnodes']);
		objectsGroup.set(null);
	});

	// 54i row g: a host whose graphs were empty at the join sent no snapshot and no nodesync, so its
	// first nodesync came with its first object graph, minutes later — and was held 15 s as if the
	// join were still on (a new graph reached the peer after ~26 s on a cloud build).
	it('times the join window from the link: a peer that had no graphs at the join is compared at once later', () => {
		vi.useFakeTimers();
		vi.setSystemTime(20_000_000);
		N.noteNodeSyncHandshake?.('host'); // the join: the link opened, the peer had nothing to send
		vi.setSystemTime(20_000_000 + 60_000); // a minute later the peer makes its first graph
		sync();
		expect(sent.map((m) => m.type)).toEqual(['getnodes']);
	});

	it('still holds a nodesync that arrives right after our ask (the join is not drift)', () => {
		vi.useFakeTimers();
		vi.setSystemTime(30_000_000);
		sync(); // through an approval: the host's nodesync beats our ask
		vi.setSystemTime(30_000_000 + N.NODESYNC_HANDSHAKE_MS - 10);
		N.noteNodeSyncHandshake('host'); // our (deferred) ask re-arms the window
		vi.setSystemTime(30_000_000 + N.NODESYNC_HANDSHAKE_MS + 10);
		sync();
		expect(sent).toEqual([]);
		N.noteNodesSnapshot('host');
		N.noteNodeSyncHandshake('host'); // a later ask after the snapshot holds nothing back
		sync();
		expect(sent.map((m) => m.type)).toEqual(['getnodes']);
	});

	it('forgets a departed peer, so its next join is a handshake again', () => {
		N.noteNodesSnapshot('host');
		N.forgetNodeSyncPeer('host');
		expect(N.nodeSyncDebug().snapshotFrom).toEqual([]);
	});
});
