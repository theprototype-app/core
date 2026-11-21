import { describe, it, expect } from 'vitest';
import { edgeTypeProblem } from '../../src/lib/ai/edgeHandles.js';
import { isValidFlowConnection } from '../../src/lib/flowSockets';

// 2.0-n3b step 0b (N3a pause-p 0/3): the agent built `k -> latch.toggle; latch -> setgamestate{paused};
// latch -> gate NOT -> setgamestate{playing}`. The editor refuses value -> event drags, the agent tools did not:
// the Gate (a pure value, no pulse) never fired Resume, and the Latch fired Pause on EVERY toggle.
const node = (/** @type {string} */ type, data = {}) => ({ id: type + '-1', type, data });

describe('2.0-n3b edgeTypeProblem: a value into an event input', () => {
	it('a pure value into an event input is refused with what to wire instead', () => {
		const p = edgeTypeProblem(node('gate', { op: 'NOT' }), node('setgamestate'), undefined, 'trigger');
		expect(p?.refuse).toMatch(/gate is a boolean value and setgamestate\.trigger needs an event/);
		expect(p?.refuse).toMatch(/On Key/);
		expect(edgeTypeProblem(node('compare'), node('sound'), undefined, 'trigger')?.refuse).toBeTruthy();
		expect(edgeTypeProblem(node('math'), node('latch'), undefined, 'set')?.refuse).toBeTruthy();
	});

	it('a latch / counter into an event input is accepted with a warning (it fires on every change)', () => {
		const p = edgeTypeProblem(node('latch'), node('setgamestate'), undefined, 'trigger');
		expect(p?.refuse).toBeUndefined();
		expect(p?.warn).toMatch(/EVERY change of the latch/);
		expect(p?.warn).toMatch(/behaviour/);
		expect(edgeTypeProblem(node('counter'), node('sound'), undefined, 'trigger')?.warn).toBeTruthy();
	});

	it('what the editor allows is not judged', () => {
		expect(edgeTypeProblem(node('keypress'), node('setgamestate'), undefined, 'trigger')).toBeNull();
		expect(edgeTypeProblem(node('latch'), node('visibility'), undefined, 'on')).toBeNull();
		expect(edgeTypeProblem(node('onclick'), node('latch'), undefined, 'set')).toBeNull();
		expect(edgeTypeProblem(node('compare'), node('gate'), undefined, 'a')).toBeNull();
		expect(edgeTypeProblem(node('counter'), node('hudtext'), undefined, 'value')).toBeNull();
	});

	it('agrees with the editor drag check on every refusal', () => {
		for (const [s, t, h] of [['gate', 'setgamestate', 'trigger'], ['compare', 'sound', 'trigger'], ['latch', 'setgamestate', 'trigger']]) {
			const src = node(s), dst = { ...node(t), id: 't-1' };
			expect(isValidFlowConnection({ source: src.id, target: dst.id, targetHandle: h }, [src, dst])).toBe(false);
		}
	});
});
