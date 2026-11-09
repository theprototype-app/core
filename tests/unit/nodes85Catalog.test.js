// 85-nodes: every new node is in the palette, the runtime list, the manual, the socket table — and
// describe_node_types (built from the same tables flowTools.describeNodeTypesTool reads) shows an
// agent its inputs, units and doc.
import { describe, it, expect } from 'vitest';
import { findNodeSpec, animationTypes, nodeCatalog } from '../../src/lib/nodeCatalog.js';
import { nodeDoc } from '../../src/lib/nodeDocs.js';
import { inputType, outputType } from '../../src/lib/flowSockets.js';
import { describeNodeTypes, paramsOf } from '../../src/lib/ai/nodeTypesCore.js';

/** the 85-nodes types; true = an effect the runtime applies each frame */
const NODES_85 = /** @type {Record<string, boolean>} */ ({
	oscillate: true,
	moveto: true,
	rotateto: true,
	scaleto: true,
	lightswitch: true,
	lightintensity: true,
	lightcycle: true
});

const SRC = {
	vocabulary: nodeCatalog.map((g) => ({ group: g.group, types: g.items.map((i) => i.type) })),
	spec: (/** @type {string} */ t) => findNodeSpec(t),
	doc: (/** @type {string} */ t) => nodeDoc(t),
	inputs: (/** @type {string} */ t) => {
		const spec = /** @type {any} */ (findNodeSpec(t));
		const params = new Set(paramsOf(spec).map((p) => p.key));
		return (spec?.inputs ?? []).filter((/** @type {string} */ n) => !params.has(n)).map((/** @type {string} */ name) => ({ name, type: inputType(t, name) }));
	},
	output: (/** @type {string} */ t) => outputType(t),
	namedOutputs: () => [],
	match: (/** @type {any} */ raw) => String(raw)
};

describe('85-nodes catalog', () => {
	for (const [type, effect] of Object.entries(NODES_85)) {
		it(`${type}: palette, runtime, manual, typed sockets`, () => {
			const spec = /** @type {any} */ (findNodeSpec(type));
			expect(spec, type).toBeTruthy();
			expect(animationTypes.includes(type)).toBe(effect);
			expect(nodeDoc(type).length).toBeGreaterThan(60);
			for (const input of spec.inputs ?? []) expect(['number', 'vector3', 'boolean', 'color', 'object', 'event'], `${type}.${input}`).toContain(inputType(type, input));
			// event / boolean sockets are declared (an undeclared handle types as a number)
			for (const input of ['trigger', 'back', 'toggle']) if ((spec.inputs ?? []).includes(input)) expect(inputType(type, input)).toBe('event');
			if ((spec.inputs ?? []).includes('open')) expect(inputType(type, 'open')).toBe('boolean');
		});
	}
	it('describe_node_types: the tween card names its sockets, units and doc', () => {
		const r = describeNodeTypes({ types: ['rotateto', 'oscillate', 'lightswitch'] }, SRC);
		const rot = r.types.find((/** @type {any} */ c) => c.type === 'rotateto');
		expect(rot.doc).toMatch(/door/);
		expect(rot.inputs.map((/** @type {any} */ i) => i.name)).toEqual(['trigger', 'back', 'toggle', 'open', 'amount', 'to']);
		expect(rot.params.find((/** @type {any} */ p) => p.key === 'pivot').options).toContain('left');
		const osc = r.types.find((/** @type {any} */ c) => c.type === 'oscillate');
		expect(osc.params.find((/** @type {any} */ p) => p.key === 'amplitude').doc).toMatch(/degrees/);
		const sw = r.types.find((/** @type {any} */ c) => c.type === 'lightswitch');
		expect(sw.inputs.map((/** @type {any} */ i) => i.type)).toEqual(['event', 'event', 'event']);
		// `on` is a param AND a socket: listed once, as the boolean param a wire drives
		expect(sw.params.find((/** @type {any} */ p) => p.key === 'on').type).toBe('boolean');
	});
});
