// @ts-nocheck — plain fixture documents
// 36 B7: the .tpnode file round-trips a group and refuses what is not one.
import { describe, it, expect } from 'vitest';
import { buildTpnode, parseTpnode, tpnodeFileName, TPNODE_VERSION } from '../../src/lib/tpnode.js';
import { copyPayload, instantiatePayload, makeGroup } from '../../src/lib/nodeGroups.js';
import { enabledCatalog } from '../../src/lib/nodeTypePrefs.js';

const ser = (x) => JSON.parse(JSON.stringify(x));
const n = (id, x = 0) => ({ id, type: 'number', position: { x, y: 0 }, data: { label: id } });

describe('.tpnode', () => {
	it('round-trips a group with its members and inner wires', () => {
		const nodes = [n('a'), n('b', 200), n('c', 400)];
		const edges = [{ id: 'e-a-b.a', source: 'a', target: 'b', targetHandle: 'a' }, { id: 'e-b-c.a', source: 'b', target: 'c', targetHandle: 'a' }];
		const g = makeGroup(nodes, edges, ['a', 'b'], 'g', { label: 'Mover' });
		const payload = copyPayload([...nodes, g], edges, ['g'], ser, ser);
		const text = JSON.stringify(buildTpnode(payload, 'Mover'));
		const back = parseTpnode(text);
		expect(back.ok).toBe(true);
		expect(back.name).toBe('Mover');
		expect(back.payload.nodes.map((x) => x.id).sort()).toEqual(['a', 'b', 'g']);
		expect(back.payload.edges.map((e) => e.id)).toEqual(['e-a-b.a']); // the wire OUT was not saved
		let i = 0;
		const placed = instantiatePayload(back.payload, () => 'z' + ++i, { at: { x: 10, y: 10 } });
		expect(placed.nodes.find((x) => x.type === 'group').data.children.length).toBe(2);
	});
	it('refuses a wrong, newer, empty or damaged file', () => {
		expect(parseTpnode('{"version":1}').ok).toBe(false);
		expect(parseTpnode('not json').ok).toBe(false);
		expect(parseTpnode(JSON.stringify({ tpnode: TPNODE_VERSION + 1, nodes: [n('a')] })).error).toMatch(/newer/);
		expect(parseTpnode(JSON.stringify({ tpnode: 1, nodes: [] })).ok).toBe(false);
		expect(parseTpnode(JSON.stringify({ tpnode: 1, nodes: [{ type: 'x' }] })).ok).toBe(false);
		const fixed = parseTpnode(JSON.stringify({ tpnode: 1, nodes: [{ id: 'a', type: 'x', position: { x: 'q' } }] }));
		expect(fixed.ok && fixed.payload.nodes[0].position).toEqual({ x: 0, y: 0 });
	});
	it('names the file safely', () => {
		expect(tpnodeFileName('My <Group>/x')).toBe('My-Groupx.tpnode');
		expect(tpnodeFileName('')).toBe('node-group.tpnode');
	});
});

describe('node manager', () => {
	it('drops disabled types and empty groups from a catalog', () => {
		const cat = [{ group: 'A', items: [{ type: 'x' }, { type: 'y' }] }, { group: 'B', items: [{ type: 'z' }] }];
		expect(enabledCatalog(cat, [])).toBe(cat);
		expect(enabledCatalog(cat, ['y', 'z'])).toEqual([{ group: 'A', items: [{ type: 'x' }] }]);
	});
});
