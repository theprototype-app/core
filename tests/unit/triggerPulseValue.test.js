// 2.0-n3c step 1: animfinished / animmarker / onanimstate / ongrab read their OWN pulse window again.
// Since 36 phase 2 (a271e333, v1.23.0) they fell through evalNodeBody's switch into the hudtimer case
// and returned hudTimerRemaining for a node with no duration: 0 for ever, so a wire from one into a
// value-edge consumer (Play Animation's trigger, Particles, a Math) never went high. Counterfactual:
// on v1.68.0 every "reads 1 inside the pulse" row is red (the eval reaches rt.hudTimerRemaining).
import { describe, test, expect } from 'vitest';
import { nodeEvalOf } from '../../src/lib/nodes/index.js';

const TRIGGERS = ['animfinished', 'animmarker', 'onanimstate', 'ongrab'];
/** the helpers these evals may touch; hudTimerRemaining is the wrong path and says so */
const rt = /** @type {any} */ ({
	num: (/** @type {any} */ v) => (Number.isFinite(Number(v)) ? Number(v) : 0),
	hudTimerRemaining: () => 'HUD-TIMER'
});
/** evaluate `type` at `time` with its trigger stamped at `lastT` (null = never fired) */
function valueOf(/** @type {string} */ type, /** @type {number|null} */ lastT, /** @type {number} */ time, data = {}) {
	const node = { id: 'n1', type, data: { pulse: 0.3, ...data } };
	const ctx = { triggers: lastT === null ? {} : { n1: { lastT, count: 1 } } };
	const ev = nodeEvalOf(type);
	if (!ev) throw new Error(type + ' has no eval');
	return ev(node, /** @type {any} */ ({ d: node.data, input: (/** @type {string} */ _h, /** @type {any} */ f) => f, time, ctx, allNodes: [node], allEdges: [], seen: new Set() }), rt);
}

describe('2.0-n3c: the four local/grab triggers read the pulse window, not the HUD timer', () => {
	for (const type of TRIGGERS) {
		test(type + ': 1 inside the pulse, 0 before, after and when never fired', () => {
			expect(valueOf(type, 10, 10)).toBe(1);
			expect(valueOf(type, 10, 10.29)).toBe(1);
			expect(valueOf(type, 10, 10.3)).toBe(0);
			expect(valueOf(type, 10, 9.99)).toBe(0); // a stamp a frame ahead of this peer's clock
			expect(valueOf(type, null, 10)).toBe(0);
		});
		test(type + ': the pulse length is its own `pulse` param', () => {
			expect(valueOf(type, 10, 10.9, { pulse: 1 })).toBe(1);
			expect(valueOf(type, 10, 11, { pulse: 1 })).toBe(0);
		});
		test(type + ': the same eval as On Click', () => {
			expect(nodeEvalOf(type)).toBe(nodeEvalOf('onclick'));
		});
	}
	test('hudtimer keeps its remaining-time eval (the only user left)', () => {
		expect(valueOf('hudtimer', 10, 10)).toBe('HUD-TIMER');
	});
});
