import { describe, it, expect } from 'vitest';
import { hashWantsAgent, agentRequested, AGENT_API_KEY } from '../../src/lib/agent/agentMode.js';
import { TP_AGENT_VERSION, TP_AGENT_METHODS, SCREENSHOT_VIEWS } from '../../src/lib/agent/contract.js';

// 55 A2: when the page exposes window.tpAgent. A flag SEGMENT of the hash, never a substring.

describe('hashWantsAgent', () => {
	it('reads the flag as a segment after the peer id', () => {
		expect(hashWantsAgent('#F0FD3&agent')).toBe(true);
		expect(hashWantsAgent('#f0fd3&agent&invite=abc')).toBe(true);
		expect(hashWantsAgent('#f0fd3&invite=abc&agent')).toBe(true);
		expect(hashWantsAgent('#f0fd3&agent~srv=peer.example')).toBe(true);
		expect(hashWantsAgent('#agent')).toBe(true);
	});
	it('is not fooled by ids, values or the server tail', () => {
		expect(hashWantsAgent('')).toBe(false);
		expect(hashWantsAgent('#f0fd3')).toBe(false);
		expect(hashWantsAgent('#agentsmith')).toBe(false);
		expect(hashWantsAgent('#f0fd3&invite=agent')).toBe(false);
		expect(hashWantsAgent('#f0fd3&agents')).toBe(false);
		expect(hashWantsAgent('#f0fd3~srv=agent')).toBe(false);
	});
	it('accepts a flag written with a value', () => {
		expect(hashWantsAgent('#f0fd3&agent=1')).toBe(true);
	});
});

describe('agentRequested', () => {
	it('is off in a plain node run (no hash, no storage key)', () => {
		expect(AGENT_API_KEY).toBe('agentApi');
		expect(agentRequested()).toBe(false);
	});
});

describe('contract', () => {
	it('is semver and names every method once', () => {
		expect(TP_AGENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
		expect(new Set(TP_AGENT_METHODS).size).toBe(TP_AGENT_METHODS.length);
		for (const m of ['tools', 'systemPrompt', 'exec', 'snapshot', 'status', 'waitForEdit', 'screenshot'])
			expect(TP_AGENT_METHODS).toContain(m);
		expect(SCREENSHOT_VIEWS).toEqual(['current', 'top', 'front', 'iso', 'focus']);
	});
});
