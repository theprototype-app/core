import { describe, it, expect } from 'vitest';
import { analyze, nearestName } from '../../src/lib/behaviours/analyze.js';

// 2.0-n3b step 1: the gaps the N3a agents fell into, said by the behaviour lint before the code runs.
const src = (/** @type {string} */ body) => 'export default behaviour({\n  name: "T",\n  state: { n: 0 },\n' + body + '\n});';
const msgs = (/** @type {string} */ s) => analyze(s).lint.map((/** @type {any} */ f) => f.message);

describe('2.0-n3b behaviour lint: the recorded gaps', () => {
	it('kit.pickups.register outside on.load is named, with where it belongs', () => {
		expect(msgs(src('  on: { start() { this.kit.pickups.register({ id: "a" }); } }')).join('\n')).toMatch(/register pickups in on\.load/);
		expect(msgs(src('  on: { load() { this.kit.pickups.register({ id: "a" }); } }')).join('\n')).not.toMatch(/register pickups/);
		expect(msgs(src('  setup() { kit.pickups.register({ id: "a" }); },\n  on: { load() { this.setup(); } }')).join('\n')).toMatch(/in setup: register pickups in on\.load/);
	});

	it('an unknown this.* member names the nearest valid one', () => {
		expect(msgs(src('  on: { start() { this.state.n = this.random(); } }')).join('\n')).toMatch(/this\.random does not exist — did you mean this\.rand\?/);
		expect(msgs(src('  on: { start() { this.emitt("x"); } }')).join('\n')).toMatch(/did you mean this\.emit\?/);
		expect(msgs(src('  bump() {},\n  on: { start() { this.bmup(); } }')).join('\n')).toMatch(/did you mean this\.bump\?/);
		// nothing close: no guess
		expect(msgs(src('  on: { start() { this.setTransform(); } }')).join('\n')).not.toMatch(/did you mean/);
	});

	it('nearestName: aliases, case, distance, nothing', () => {
		expect(nearestName('time', ['now', 'rand'])).toBe('now');
		expect(nearestName('FindAll', ['find', 'findAll'])).toBe('findAll');
		expect(nearestName('aftr', ['after', 'emit'])).toBe('after');
		expect(nearestName('zzzzzz', ['after', 'emit'])).toBe('');
	});
});
