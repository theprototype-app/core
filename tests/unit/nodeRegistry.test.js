// 2.0 N1 — the node definition registry: one definition per core node type, the four places a node
// used to live (palette, card map, socket tables, evalNodeBody) generated from it, and the check that
// fails the build when a definition is missing a half.
import { describe, test, expect } from 'vitest';
import { NODE_FAMILIES, coreNodeTypes, coreCatalogGroups, coreCardKeys, coreSocketTables, coreRegistryErrors, nodeDef, nodeEvalOf } from '../../src/lib/nodes/index.js';
import { registryErrors, specOf, HALVES, CARD_KEYS } from '../../src/lib/nodes/registry.js';
import { nodeCatalog, findNodeSpec, groupOf } from '../../src/lib/nodeCatalog.js';
import { outputType, inputType, inputHandles, outputHandleNames } from '../../src/lib/flowSockets.js';
import { kitNodeTypes } from '../../src/lib/kit/catalog.js';

/** a whole, minimal definition to break one half at a time @param {any} [over] */
const whole = (over = {}) => ({ type: 'probe', label: 'Probe', defaults: {}, sockets: { out: 'number' }, card: 'NumberNode', eval: () => 1, ...over });

describe('2.0 N1: every core node type has exactly one definition', () => {
	test('the core families are whole (the build check reads the same list)', () => {
		expect(coreRegistryErrors()).toEqual([]);
	});
	test('148 core types, each defined once, in palette order', () => {
		const all = NODE_FAMILIES.flatMap((f) => f.nodes.map((n) => n.type));
		expect(all.length).toBe(148);
		expect(new Set(all).size).toBe(all.length);
		expect(coreNodeTypes()).toEqual(all);
	});
	test('the palette is the definitions (core groups) followed by the kit', () => {
		const core = nodeCatalog.slice(0, NODE_FAMILIES.length);
		expect(core.map((g) => g.group)).toEqual(NODE_FAMILIES.map((f) => f.group));
		expect(core).toEqual(coreCatalogGroups);
		const kit = nodeCatalog.slice(NODE_FAMILIES.length).flatMap((g) => g.items.map((i) => i.type));
		expect(kit).toEqual(kitNodeTypes());
	});
	test('a palette spec carries no runtime half', () => {
		for (const group of coreCatalogGroups)
			for (const spec of group.items) for (const half of HALVES) expect(Object.keys(spec)).not.toContain(half);
	});
	test('findNodeSpec / groupOf answer from the definitions', () => {
		const specs = new Map(coreCatalogGroups.flatMap((g) => g.items.map((i) => [i.type, i])));
		for (const family of NODE_FAMILIES)
			for (const def of family.nodes) {
				expect(findNodeSpec(def.type)).toBe(specs.get(def.type));
				expect(findNodeSpec(def.type)).toEqual(specOf(def));
				expect(groupOf(def.type)).toBe(family.group);
			}
	});
	test('every card key is one Nodes.svelte renders', () => {
		for (const key of Object.values(coreCardKeys())) expect(CARD_KEYS).toContain(key);
	});
	test('the socket lookups read the definitions', () => {
		const { OUTPUT, INPUT, OUTPUT_HANDLES } = coreSocketTables();
		for (const type of coreNodeTypes()) {
			const s = /** @type {any} */ (nodeDef(type)).sockets;
			expect(outputType(type)).toBe(s.out);
			expect(OUTPUT[type]).toBe(s.out);
			expect(INPUT[type]).toBe(s.in);
			expect(OUTPUT_HANDLES[type]).toBe(s.outHandles);
			for (const [h, t] of Object.entries(s.in ?? {})) if (h !== '_default') expect(inputType(type, h)).toBe(t);
			expect(inputHandles(type)).toEqual(Object.keys(s.in ?? {}).filter((h) => h !== '_default'));
			expect(outputHandleNames(type)).toEqual(Object.keys(s.outHandles ?? {}));
		}
	});
	test('evalNodeBody dispatches a value node through its definition', () => {
		expect(typeof nodeEvalOf('math')).toBe('function');
		expect(nodeEvalOf('spin')).toBeUndefined(); // an effect: applied by the tick, no pulled value
		expect(nodeEvalOf('onrest')).toBeUndefined(); // eval: null — a stamp-edge source
		expect(nodeEvalOf('constructor')).toBeUndefined();
	});
});

describe('2.0 N1: a definition missing a half is an error (what fails the build)', () => {
	const errs = (/** @type {any} */ def) => registryErrors([{ group: 'Probe', nodes: [def] }]);
	test('a whole definition passes (counterfactual base)', () => {
		expect(errs(whole())).toEqual([]);
	});
	test('no card, an unknown card', () => {
		expect(errs(whole({ card: undefined })).join()).toMatch(/card/);
		expect(errs(whole({ card: 'NoSuchCard' })).join()).toMatch(/card "NoSuchCard"/);
	});
	test('no sockets, an unknown socket type', () => {
		expect(errs(whole({ sockets: undefined })).join()).toMatch(/no sockets/);
		expect(errs(whole({ sockets: { out: 'string' } })).join()).toMatch(/not a socket type/);
		expect(errs(whole({ sockets: { out: 'number', in: { a: 'text' } } })).join()).toMatch(/input a/);
	});
	test('a value output with no eval; eval: null said on purpose passes; an effect needs none', () => {
		expect(errs(whole({ eval: undefined })).join()).toMatch(/needs an eval/);
		expect(errs(whole({ eval: null }))).toEqual([]);
		expect(errs(whole({ eval: undefined, sockets: { out: 'effect' } }))).toEqual([]);
	});
	test('no palette spec (label / defaults)', () => {
		expect(errs(whole({ label: '' })).join()).toMatch(/no label/);
		expect(errs(whole({ defaults: undefined })).join()).toMatch(/no defaults/);
	});
	test('a type defined twice', () => {
		const e = registryErrors([
			{ group: 'A', nodes: [/** @type {any} */ (whole())] },
			{ group: 'B', nodes: [/** @type {any} */ (whole())] }
		]);
		expect(e.join()).toMatch(/defined twice \(also in A\)/);
	});
});
