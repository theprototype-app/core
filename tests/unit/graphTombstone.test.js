// @ts-nocheck
// fix-late-joiners row 4 (102b-flows' note): a nodes snapshot MERGE never deletes, so a snapshot from a peer that has
// not applied a graphdelete yet put the deleted object graph back. A deleted graph is tombstoned for a minute;
// any ordinary creation lifts it. Counterfactual: on v1.74.0 the "stale snapshot" case resurrects the graph.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { flowGraphs, removeGraphDocument, updateGraph, graphTombstoned, restoreGraphs } = await import('../../src/stores/flowStore.js');
const N = await import('../../src/lib/nodesHandler.js');

const doc = (id) => ({ nodes: [{ id, type: 'spin', position: { x: 0, y: 0 }, data: {} }], edges: [] });
const has = (id) => {
	let all;
	flowGraphs.subscribe((v) => (all = v))();
	return !!all[id];
};

beforeEach(() => {
	vi.useRealTimers();
	flowGraphs.set({ scene: { nodes: [], edges: [] }, 'obj-1': doc('n1') });
});

describe('graph tombstones', () => {
	it('a stale snapshot does not bring back a graph deleted here', () => {
		removeGraphDocument('obj-1');
		expect(has('obj-1')).toBe(false);
		N.applyNodesSnapshot(undefined, undefined, { 'obj-1': doc('n1') });
		expect(has('obj-1')).toBe(false);
		expect(graphTombstoned('obj-1')).toBe(true);
	});

	it('a graph made again (graphcreate / undo) takes snapshots as before', () => {
		removeGraphDocument('obj-1');
		updateGraph('obj-1', (g) => g); // applyGraphCreate's shape
		expect(graphTombstoned('obj-1')).toBe(false);
		N.applyNodesSnapshot(undefined, undefined, { 'obj-1': doc('n2') });
		let all;
		flowGraphs.subscribe((v) => (all = v))();
		expect(all['obj-1'].nodes.map((n) => n.id)).toEqual(['n2']);
	});

	it('the tombstone runs out after a minute (a missed graphcreate heals on a later resync)', () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		removeGraphDocument('obj-1');
		vi.setSystemTime(1_000_000 + 60_001);
		N.applyNodesSnapshot(undefined, undefined, { 'obj-1': doc('n1') });
		expect(has('obj-1')).toBe(true);
	});

	it('a new world forgets every tombstone, and graphs never deleted merge as always', () => {
		removeGraphDocument('obj-1');
		restoreGraphs({});
		expect(graphTombstoned('obj-1')).toBe(false);
		N.applyNodesSnapshot(undefined, undefined, { 'obj-9': doc('n9') });
		expect(has('obj-9')).toBe(true);
	});
});
