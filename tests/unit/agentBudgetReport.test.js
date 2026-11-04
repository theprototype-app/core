import { describe, it, expect } from 'vitest';
import { agentBudgetReport } from '../../src/lib/sceneBudget.js';

describe('agentBudgetReport (status sceneBudget, mcp-shapes item 10)', () => {
	it('compact: the numbers, the worst tier and the profile; no over list while green', () => {
		const r = agentBudgetReport({ at: 1, profile: 'desktop', objects: 12, meshes: 10, triangles: 5000, calls: 40, textures: 3, lights: 2, frameP95: 16.66, heap: 1e9, longTasks: null });
		expect(r).toEqual({ tier: 'green', profile: 'desktop', objects: 12, meshes: 10, triangles: 5000, calls: 40, textures: 3, lights: 2, frameP95: 16.7 });
	});
	it('a budget past green says so, judged on the vr profile', () => {
		const r = agentBudgetReport({ at: 1, profile: 'vr', objects: 10, triangles: 700000, calls: 400 });
		expect(r.profile).toBe('vr');
		expect(r.tier).toBe('red');
		expect(r.over).toEqual(['triangles red (700000, green up to 300000)', 'calls amber (400, green up to 300)']);
	});
	it('nothing measured yet = unknown, never a warning', () => {
		expect(agentBudgetReport({ at: 1, profile: 'desktop' })).toEqual({ tier: 'unknown', profile: 'desktop' });
	});
});
