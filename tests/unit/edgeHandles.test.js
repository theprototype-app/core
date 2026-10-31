import { describe, it, expect } from 'vitest';
import { handleProblem, knownInputs, knownMapOutputs, edgeHandleProblems } from '../../src/lib/ai/edgeHandles.js';

// 55 (41's voice-Claude finding): create_flow_nodes accepted any fromHandle/toHandle, so a wrong name made
// a wire that did nothing. A bad handle is now an error naming the valid ones.
const node = (/** @type {string} */ type, data = {}) => ({ id: type + '-1', type, data });

describe('edge handles', () => {
	it('the logic nodes the system prompt teaches declare the inputs it names', () => {
		expect(knownInputs(node('latch'))).toEqual(expect.arrayContaining(['set', 'reset', 'toggle']));
		expect(knownInputs(node('counter'))).toEqual(expect.arrayContaining(['pulse', 'reset']));
		expect(knownInputs(node('once'))).toEqual(expect.arrayContaining(['rearm']));
		expect(knownInputs(node('delay'))).toEqual(expect.arrayContaining(['cancel']));
		expect(knownInputs(node('visibility'))).toEqual(expect.arrayContaining(['on']));
		expect(knownMapOutputs(node('sequence'))).toEqual(['step1', 'step2', 'step3', 'step4']);
	});
	it('a wrong input or map output is named with the valid ones; a plain output is not judged', () => {
		const bad = edgeHandleProblems(node('onclick'), node('latch'), undefined, 'sett');
		expect(bad).toHaveLength(1);
		expect(bad[0]).toMatch(/toHandle "sett".*latch.*set, /);
		expect(edgeHandleProblems(node('sequence'), node('counter'), 'step9', 'pulse')[0]).toMatch(/fromHandle "step9".*step1, step2/);
		// `a.out -> b.in` is how graph text spells a plain output: the runtime ignores sourceHandle there
		expect(edgeHandleProblems(node('onclick'), node('counter'), 'out', 'pulse')).toEqual([]);
		expect(edgeHandleProblems(node('onclick'), node('counter'), undefined, undefined)).toEqual([]);
	});
	it('data-declared sockets: script, variadic, switcher', () => {
		const script = node('script', { inputs: [{ name: 'speed', type: 'number' }], outputs: [{ name: 'out2', type: 'number' }] });
		expect(knownInputs(script)).toEqual(['speed']);
		expect(knownMapOutputs(script)).toEqual(['out2']);
		expect(edgeHandleProblems(script, script, 'nope', undefined)[0]).toMatch(/out2/);
		expect(knownInputs(node('math', { sockets: 3 }))).toEqual(['a', 'b', 'c']);
		expect(knownInputs(node('switcher', { items: [{}, {}] }))?.[0]).toBe('index');
	});
	it('not knowable = not judged (a module node, a behaviour before the behaviours load)', () => {
		expect(knownInputs(node('mod-zzz-thing'))).toBeNull();
		expect(knownInputs(node('behaviour'))).toBeNull();
		expect(handleProblem('x', 'anything', 'input', null)).toBeNull();
		expect(knownInputs(node('objectselector'))).toBeNull(); // it reads its wires whatever they name
		expect(handleProblem('onclick', 'go', 'input', [])).toMatch(/no named inputs/);
		// every data key is wireable (flowRuntime injects a wired value into data[handle])
		expect(edgeHandleProblems(node('number'), node('spin'), undefined, 'speed')).toEqual([]);
		expect(edgeHandleProblems(node('number'), node('spin'), undefined, 'speeed')[0]).toMatch(/speed/);
	});
});
