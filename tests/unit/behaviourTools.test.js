import { describe, it, expect, afterEach } from 'vitest';
import { registerBehaviourHost, behaviourHost, registerAiReference, aiReferences } from '../../src/lib/ai/aiExtensions.js';
import { behaviourToolSchemas, behaviourTool, lintBehaviour, summarizeBehaviours } from '../../src/lib/ai/behaviourTools.js';

// 34 D5: the assistant's half of code behaviours, against a FAKE host — the real one is
// 34-behaviours' (proposal D1), and this lane must work whether it has landed or not.

/** a host that records what reached it */
function fakeHost(extra = {}) {
	/** @type {Record<string, string>} */
	const store = {};
	/** @type {any[]} */
	const calls = [];
	const host = {
		format: 'behaviour/1',
		reference: () => 'behaviour({params, state, on})',
		list: () => Object.keys(store).map((name) => ({ name, summary: 'test' })),
		read: (/** @type {string} */ name) => store[name] ?? null,
		create: async (/** @type {string} */ name, /** @type {string} */ source, /** @type {any} */ opts) => {
			calls.push(['create', name, opts?.target]);
			if (store[name]) return { error: 'exists' };
			store[name] = source;
			return { ok: true, name };
		},
		edit: (/** @type {string} */ name, /** @type {string} */ source) => {
			calls.push(['edit', name]);
			store[name] = source;
			return { ok: true };
		},
		...extra
	};
	return { host, store, calls };
}

const GOOD = `export default behaviour({
  params: { reach: { value: 1.2, min: 0.5, max: 3 } },
  on: { grabRequest({ hand, piece, refuse }) { if (dist(hand, piece) > this.params.reach) refuse('Too far'); } }
});`;

let off = () => {};
afterEach(() => off());

describe('feature detection', () => {
	it('no host = no tools, and the tools say why if called anyway', async () => {
		expect(behaviourHost()).toBeNull();
		expect(behaviourToolSchemas()).toEqual([]);
		expect((await behaviourTool('create_behaviour', { name: 'a', source: GOOD })).error).toMatch(/not available/);
		expect(summarizeBehaviours()).toBeUndefined();
	});
	it('a host makes both tools appear', () => {
		off = registerBehaviourHost(fakeHost().host);
		expect(behaviourToolSchemas().map((t) => t.function.name)).toEqual(['create_behaviour', 'edit_behaviour']);
	});
	it('refuses a host without create/edit, and an unregister only removes its own host', () => {
		expect(() => registerBehaviourHost(/** @type {any} */ ({ create() {} }))).toThrow();
		const a = registerBehaviourHost(fakeHost().host);
		const second = fakeHost().host;
		const b = registerBehaviourHost(second);
		a();
		expect(behaviourHost()).toBe(second);
		b();
		expect(behaviourHost()).toBeNull();
	});
	it('reference blocks are resolved per call, and a throwing one is skipped', () => {
		let n = 0;
		const u1 = registerAiReference('kit', () => 'kit.round.start() ' + ++n);
		const u2 = registerAiReference('bad', () => {
			throw new Error('nope');
		});
		expect(aiReferences()).toEqual([{ id: 'kit', text: 'kit.round.start() 1' }]);
		expect(aiReferences()[0].text).toBe('kit.round.start() 2');
		u1();
		u2();
		expect(aiReferences()).toEqual([]);
	});
});

describe('the lint runs before apply', () => {
	it('a clean behaviour reaches the host', async () => {
		const f = fakeHost();
		off = registerBehaviourHost(f.host);
		expect(await behaviourTool('create_behaviour', { name: 'reach', source: GOOD, target: 'u-1' })).toEqual({ created: [{ name: 'reach' }] });
		expect(f.calls).toEqual([['create', 'reach', 'u-1']]);
		expect(f.store.reach).toBe(GOOD);
	});
	it('a nondeterministic behaviour never reaches the host, and every issue comes back with its line', async () => {
		const f = fakeHost();
		off = registerBehaviourHost(f.host);
		const bad = 'export default behaviour({\n  on: { tick() { this.state.r = Math.random(); localStorage.x = 1; } }\n});';
		const res = await behaviourTool('create_behaviour', { name: 'bad', source: bad });
		expect(res.error).toMatch(/NOT applied: 2 lint issue/);
		expect(res.issues.map((/** @type {any} */ i) => [i.line, i.rule])).toEqual([[2, 'nondeterministic'], [2, 'storage']]);
		expect(f.calls).toEqual([]);
	});
	it("the host's own lint is added to core's", async () => {
		const f = fakeHost({ lint: () => [{ line: 1, message: 'no export default' }] });
		off = registerBehaviourHost(f.host);
		const res = await behaviourTool('edit_behaviour', { name: 'x', source: 'behaviour({})' });
		expect(res.issues).toEqual([{ line: 1, message: 'no export default' }]);
		expect(await lintBehaviour(GOOD)).toHaveLength(1); // the host's rule fires on GOOD too
	});
	it('validates the name and size, and passes the host error through', async () => {
		const f = fakeHost();
		off = registerBehaviourHost(f.host);
		expect((await behaviourTool('create_behaviour', { name: '1 bad', source: GOOD })).error).toMatch(/name must/);
		expect((await behaviourTool('create_behaviour', { name: 'ok', source: '   ' })).error).toMatch(/empty/);
		expect((await behaviourTool('create_behaviour', { name: 'ok', source: 'x'.repeat(40_001) })).error).toMatch(/limit/);
		await behaviourTool('create_behaviour', { name: 'dup', source: GOOD });
		expect((await behaviourTool('create_behaviour', { name: 'dup', source: GOOD })).error).toBe('exists');
	});
	it('the scene summary lists behaviours, with a short source attached', async () => {
		const f = fakeHost();
		off = registerBehaviourHost(f.host);
		await behaviourTool('create_behaviour', { name: 'reach', source: GOOD });
		expect(summarizeBehaviours()).toEqual([{ name: 'reach', summary: 'test', source: GOOD }]);
	});
});
