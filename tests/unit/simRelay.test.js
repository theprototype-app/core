import { describe, it, expect } from 'vitest';
import { simRefusal, SIM_ACTIONS } from '../../src/lib/agent/simRelay.js';

// 55 (41's physics research): an agent's control_simulation runs on the host; the host decides.
describe('simRefusal (the host verdict on an agent sim request)', () => {
	it('runs an agent editor request for every action', () => {
		for (const action of SIM_ACTIONS) expect(simRefusal({ agent: true, role: 'editor', action })).toBeNull();
		expect(simRefusal({ agent: true, role: null, action: 'start' })).toBeNull();
	});
	it('refuses a person (they run the sim themselves), a viewer, and an unknown action', () => {
		expect(simRefusal({ agent: false, role: 'editor', action: 'start' })).toMatch(/AI agent/);
		expect(simRefusal({ agent: true, role: 'viewer', action: 'start' })).toMatch(/view-only/);
		expect(simRefusal({ agent: true, role: 'editor', action: 'explode' })).toMatch(/unknown action/);
	});
});
