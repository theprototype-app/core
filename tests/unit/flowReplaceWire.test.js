// @ts-nocheck
// 102-int-3 (seam 102b-flows x 71 TR7): giving a flow / updating all copies REPLACES object flow documents with one
// `nodes` message per chunk carrying `replaceGraphs`. A receiver takes those graphs whole (a plain snapshot merges,
// which kept the old nodes running beside the new copies when the per-node deletes were refused by the rate limit),
// and the message costs one edit token.
import { describe, it, expect, beforeEach } from 'vitest';
import { validateWireMessage } from '../../src/lib/wireValidate.js';
import { rateKind } from '../../src/lib/peerRateLimit.js';

const { flowGraphs } = await import('../../src/stores/flowStore.js');
const N = await import('../../src/lib/nodesHandler.js');

const node = (id) => ({ id, type: 'spin', position: { x: 0, y: 0 }, data: {} });
const all = () => {
	let v;
	flowGraphs.subscribe((x) => (v = x))();
	return v;
};

beforeEach(() => {
	flowGraphs.set({ scene: { nodes: [node('s1')], edges: [] }, 'obj-1': { nodes: [node('old1'), node('old2')], edges: [] }, 'obj-2': { nodes: [node('keep')], edges: [] } });
});

describe('replaceGraphs on a nodes snapshot', () => {
	it('a listed object graph is replaced whole; an unlisted one still merges', () => {
		N.applyNodesSnapshot([], [], { 'obj-1': { nodes: [node('new1')], edges: [] }, 'obj-2': { nodes: [node('add')], edges: [] } }, ['obj-1']);
		expect(all()['obj-1'].nodes.map((n) => n.id)).toEqual(['new1']);
		expect(all()['obj-2'].nodes.map((n) => n.id)).toEqual(['keep', 'add']);
	});
	it('without the list the merge is unchanged (old nodes stay)', () => {
		N.applyNodesSnapshot([], [], { 'obj-1': { nodes: [node('new1')], edges: [] } });
		expect(all()['obj-1'].nodes.map((n) => n.id)).toEqual(['old1', 'old2', 'new1']);
	});
	it('never replaces the scene graph', () => {
		N.applyNodesSnapshot([], [], { scene: { nodes: [node('x')], edges: [] } }, ['scene']);
		expect(all().scene.nodes.map((n) => n.id)).toEqual(['s1', 'x']);
	});
	it('the wire shape: a list of up to 64 ids', () => {
		expect(validateWireMessage({ type: 'nodes', nodes: [], edges: [], graphs: {}, replaceGraphs: ['a'] })).toBe(true);
		expect(validateWireMessage({ type: 'nodes', nodes: [], edges: [], graphs: {}, replaceGraphs: 'a' })).toBe(false);
		expect(validateWireMessage({ type: 'nodes', nodes: [], edges: [], graphs: {}, replaceGraphs: [1] })).toBe(false);
		expect(validateWireMessage({ type: 'nodes', nodes: [], edges: [], graphs: {}, replaceGraphs: Array(65).fill('a') })).toBe(false);
		expect(validateWireMessage({ type: 'nodes', nodes: [], edges: [] })).toBe(true);
	});
	it('a replacing nodes message is one edit; a plain one is full state', () => {
		expect(rateKind('nodes', { replaceGraphs: ['a'] })).toBe('edit');
		expect(rateKind('nodes', { graphs: {} })).toBe(null);
	});
});
