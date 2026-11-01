// 34 R3 ↔ D5: the real behaviour host behind 34-graph-ai's create_behaviour / edit_behaviour seam —
// its reference text, its lint (the same analyze() the loader runs), and the tools gate on it.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { registerBehaviourHost } from '../../src/lib/ai/aiExtensions.js';
import { behaviourTool, lintBehaviour, behaviourToolSchemas } from '../../src/lib/ai/behaviourTools.js';
import { makeBehaviourHost, behaviourReference, behaviourLint, BEHAVIOUR_EXAMPLE } from '../../src/lib/behaviours/aiHost.js';

const WAVES = readFileSync(new URL('../../static/behaviours/waves-spawner.js', import.meta.url), 'utf8');
let off = () => {};
afterEach(() => off());

describe('the behaviour host (aiHost.js)', () => {
	it('the reference is short and names the format, this, the events and the lint', () => {
		const r = behaviourReference();
		// 55: +inputs/outputs, no per-frame hook, no object moves (the rules a model guessed wrong) — 2000 → 2300
		expect(r.length).toBeLessThan(2300);
		for (const word of ['export default behaviour', 'after(seconds', 'grabRequest', 'died', 'Math.random']) expect(r).toContain(word);
	});
	it('lint: a clean file has no issues; Math.random and an unknown event are reported with lines', () => {
		expect(behaviourLint(WAVES)).toEqual([]);
		const issues = behaviourLint('export default behaviour({\n on: { nope() {}, go() { this.x = Math.random(); } }\n});');
		// 55: `this.x` is flagged too — `this` is not a place to keep anything (state is)
		expect(issues.map((i) => i.line)).toEqual([2, 2, 2]);
		expect(issues.some((i) => /this\.x does not exist/.test(i.message))).toBe(true);
		expect(issues.map((i) => i.message).join(' ')).toMatch(/Math\.random.*|no such event/);
	});
	it('the tools refuse a bad file before it reaches the scene (core lint + the host lint)', async () => {
		/** @type {any[]} */
		const created = [];
		const host = { ...makeBehaviourHost(() => ({})), create: async (/** @type {string} */ n) => (created.push(n), { ok: true, name: n }) };
		off = registerBehaviourHost(host);
		const bad = await behaviourTool('create_behaviour', { name: 'dice', source: 'export default behaviour({ on: { go() { const t = new Date(); } } });' });
		expect(bad.error).toMatch(/NOT applied/);
		expect(created).toEqual([]);
		const issues = await lintBehaviour(WAVES);
		expect(issues).toEqual([]);
		const good = await behaviourTool('create_behaviour', { name: 'waves', source: WAVES });
		expect(good).toEqual({ created: [{ name: 'waves' }] });
		expect(created).toEqual(['waves']);
	});
});

// 55 (41's voice session #2): claude.ai drops server instructions, so create_behaviour's own description carries
// the format, the rules a model gets wrong, and one example that really passes
describe('create_behaviour carries its own manual', () => {
	it('the example passes the whole lint (core + host)', async () => {
		expect(await lintBehaviour(BEHAVIOUR_EXAMPLE)).toEqual([]);
	});
	it('the description states the format, the sockets, no per-frame hook, no object moves, and holds the example', () => {
		off = registerBehaviourHost(makeBehaviourHost(() => ({})));
		const create = behaviourToolSchemas().find((t) => t.function.name === 'create_behaviour');
		const d = create?.function.description ?? '';
		expect(d).toContain(BEHAVIOUR_EXAMPLE);
		expect(d).toMatch(/input "x" runs on\.x/);
		expect(d).toMatch(/this\.emit/);
		expect(d).toMatch(/NO per-frame hook.*this\.after/);
		expect(d).toMatch(/does NOT move, rotate, recolour or hide objects/);
		expect(d).toMatch(/load \(runs on EVERY peer/);
	});
});
