import { describe, it, expect } from 'vitest';
import { findNodeSpec } from '../../src/lib/nodeCatalog';
import { paramsOf } from '../../src/lib/ai/nodeTypesCore.js';

// 2.0-n3b (G27): Collect pickup gains "Hide when collected": ON for a new node (its spec default, which the
// editor and the agent tools both spread into a new node's data), OFF for a node saved without the key
// (legacy false — the card and describe_node_types read it so, and the runtime acts only on `hide: true`).
describe('G27 Collect pickup: hide when collected', () => {
	const spec = /** @type {any} */ (findNodeSpec('kit-pickups-collect'));
	it('a new node gets hide: true', () => {
		expect(spec.defaults.hide).toBe(true);
		expect(spec.defaults.touch).toBe(true);
	});
	it('the param carries legacy false for saved nodes, and describe_node_types reports it', () => {
		const p = spec.params.find((/** @type {any} */ x) => x.key === 'hide');
		expect(p).toMatchObject({ kind: 'toggle', legacy: false, label: 'Hide when collected' });
		expect(paramsOf(spec).find((/** @type {any} */ x) => x.key === 'hide')).toMatchObject({ type: 'boolean', default: true });
	});
});
