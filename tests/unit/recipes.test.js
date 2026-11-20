import { describe, it, expect } from 'vitest';
import { RECIPES, recipeAnswer } from '../../src/lib/ai/recipes.js';
import { describeNodeTypes } from '../../src/lib/ai/nodeTypesCore.js';
import { findNodeSpec } from '../../src/lib/nodeCatalog';

// 2.0-n3b step 3: six short recipes behind describe_node_types {recipe}
const src = { vocabulary: [{ group: 'Logic', types: ['latch'] }], match: (/** @type {string} */ t) => t, doc: () => '' };
describe('2.0-n3b recipes', () => {
	it('six, each with a name, a when and steps', () => {
		expect(RECIPES).toHaveLength(6);
		for (const r of RECIPES) expect(r.name && r.when && r.steps.length).toBeTruthy();
	});
	it('describe_node_types: no args names them; recipe "" lists them; a name gives steps; unknown says which exist', () => {
		expect(describeNodeTypes({}, /** @type {any} */ (src)).recipes).toContain('pause-key');
		expect(describeNodeTypes({ recipe: '' }, /** @type {any} */ (src)).recipes).toHaveLength(6);
		expect(describeNodeTypes({ recipe: 'Pickup' }, /** @type {any} */ (src)).steps.join(' ')).toMatch(/kit-pickups-collect/);
		expect(recipeAnswer('nope').error).toMatch(/pause-key/);
	});
	it('every node type a recipe names exists', () => {
		const types = new Set();
		for (const r of RECIPES) for (const step of r.steps.filter((s) => s.includes('create_flow_nodes'))) for (const m of step.matchAll(/= ([a-z][a-z0-9-]+) ?\{?/g)) types.add(m[1]);
		const missing = [...types].filter((t) => !findNodeSpec(t));
		expect(missing).toEqual([]);
		expect(types.size).toBeGreaterThan(8);
	});
	it('edges stay in one graph: a step wiring a (scene) behaviour builds in the scene graph', () => {
		// the N3b gate caught remembered-state wiring On Click in the lantern's graph into a scene behaviour (refused)
		for (const r of RECIPES)
			for (const step of r.steps.filter((s) => s.includes('create_flow_nodes') && s.includes('<behaviour>.')))
				expect(step, r.name).toMatch(/create_flow_nodes scene\b/);
	});
});
