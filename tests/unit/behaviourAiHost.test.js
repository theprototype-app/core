// 34 R3 ↔ D5: the real behaviour host behind 34-graph-ai's create_behaviour / edit_behaviour seam —
// its reference text, its lint (the same analyze() the loader runs), and the tools gate on it.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { registerBehaviourHost } from '../../src/lib/ai/aiExtensions.js';
import { behaviourTool, lintBehaviour } from '../../src/lib/ai/behaviourTools.js';
import { makeBehaviourHost, behaviourReference, behaviourLint } from '../../src/lib/behaviours/aiHost.js';

const WAVES = readFileSync(new URL('../../static/behaviours/waves-spawner.js', import.meta.url), 'utf8');
let off = () => {};
afterEach(() => off());

describe('the behaviour host (aiHost.js)', () => {
	it('the reference is short and names the format, this, the events and the lint', () => {
		const r = behaviourReference();
		expect(r.length).toBeLessThan(2000);
		for (const word of ['export default behaviour', 'after(seconds', 'grabRequest', 'died', 'Math.random']) expect(r).toContain(word);
	});
	it('lint: a clean file has no issues; Math.random and an unknown event are reported with lines', () => {
		expect(behaviourLint(WAVES)).toEqual([]);
		const issues = behaviourLint('export default behaviour({\n on: { nope() {}, go() { this.x = Math.random(); } }\n});');
		expect(issues.map((i) => i.line)).toEqual([2, 2]);
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
