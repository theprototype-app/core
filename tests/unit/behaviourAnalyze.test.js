// 34 R3 (D2) — the static analysis behind the derived node view, the lint, and the knob's
// one-literal write-back. Pure: acorn + the kit specs, no browser.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { analyze, setParamLiteral, formatNumber } from '../../src/lib/behaviours/analyze.js';
import { deriveGraph } from '../../src/lib/behaviours/graph.js';
import { KIT_PIECES } from '../../src/lib/kit/index.js';
import { BEHAVIOUR_STARTER } from '../../src/lib/behaviours/starter.js';

const SPECS = KIT_PIECES.map((r) => r.piece.spec);
const read = (/** @type {string} */ n) => readFileSync(new URL('../../static/behaviours/' + n, import.meta.url), 'utf8');
const WAVES = read('waves-spawner.js');
const REACH = read('towers-reach.js');

describe('analyze — the structure of a behaviour', () => {
	it('the Waves spawner: params with ranges, state, handlers on kit events, the method, kit calls by their spec node', () => {
		const m = analyze(WAVES, SPECS);
		expect(m.ok).toBe(true);
		expect(m.errors).toEqual([]);
		expect(m.name).toBe('Waves spawner');
		expect(m.params.map((/** @type {any} */ p) => p.key)).toEqual(['waves', 'sizeStart', 'sizeStep', 'interval', 'speed', 'hp']);
		expect(m.params[3]).toMatchObject({ key: 'interval', value: 3, min: 0, max: 30, step: 0.5, unit: 's', type: 'number' });
		expect(m.state.map((/** @type {any} */ s) => [s.key, s.init])).toEqual([
			['wave', 0],
			['alive', 0]
		]);
		const go = m.handlers.find((/** @type {any} */ h) => h.name === 'go');
		expect(go.event).toMatchObject({ key: 'round.go', local: false });
		expect(go.calls).toEqual(['startWave']);
		const died = m.handlers.find((/** @type {any} */ h) => h.name === 'died');
		expect(died.event.key).toBe('health.died');
		expect(died.payload).toEqual(['entity']);
		expect(died.writes).toEqual(['alive']);
		expect(died.reads.state.sort()).toEqual(['alive', 'wave']);
		expect(died.reads.params).toEqual(['interval']);
		expect(died.timers).toEqual([{ method: 'startWave', params: ['interval'], line: expect.any(Number) }]);
		const sw = m.methods.find((/** @type {any} */ x) => x.name === 'startWave');
		expect(sw.writes.sort()).toEqual(['alive', 'wave']);
		expect(sw.reads.params.sort()).toEqual(['hp', 'sizeStart', 'sizeStep', 'speed', 'waves']);
		expect(sw.kit.map((/** @type {any} */ k) => [k.type, k.label])).toEqual([
			['kit-round-win', 'Win round'],
			['kit-spawner-spawn', 'Spawn entities'],
			['kit-mover-chase', expect.any(String)]
		]);
	});
	it('the Towers reach: a local grab veto, its param read and its payload action', () => {
		const m = analyze(REACH, SPECS);
		expect(m.ok).toBe(true);
		const h = m.handlers[0];
		expect(h.event).toMatchObject({ name: 'grabRequest', local: true });
		expect(h.reads.params).toEqual(['reach']);
		expect(h.actions).toEqual(['refuse']);
		expect(h.payload.sort()).toEqual(['distance', 'piece', 'refuse']);
	});
	it('the starter template is a clean behaviour', () => {
		const m = analyze(BEHAVIOUR_STARTER, SPECS);
		expect(m.ok).toBe(true);
		expect(m.lint).toEqual([]);
	});
	it('a syntax error is one error with its line', () => {
		const m = analyze('export default behaviour({\n  on: { go() { const = 1; } }\n});', SPECS);
		expect(m.ok).toBe(false);
		expect(m.errors[0].line).toBe(2);
	});
	it('no definition is an error', () => {
		expect(analyze('const x = 1;', SPECS).errors[0].message).toMatch(/export default behaviour/);
	});
});

describe('analyze — the lint', () => {
	const lintOf = (/** @type {string} */ body) =>
		analyze('export default behaviour({ on: { go() { ' + body + ' } } });', SPECS);
	it.each([
		['Math.random()', /Math\.random/],
		['Date.now()', /Date\.now/],
		['new Date()', /Date/],
		['performance.now()', /performance\.now/],
		['localStorage.setItem("a", 1)', /localStorage/],
		['document.body', /document/],
		['window.x = 1', /window/],
		['fetch("/x")', /fetch/],
		['setTimeout(() => {}, 1)', /setTimeout/],
		['eval("1")', /eval/]
	])('%s is an error', (code, re) => {
		const m = lintOf(code);
		expect(m.ok).toBe(false);
		expect(m.errors.map((/** @type {any} */ e) => e.message).join(' ')).toMatch(re);
	});
	it('import is an error', () => {
		expect(analyze("import x from 'y';\nexport default behaviour({});", SPECS).ok).toBe(false);
	});
	it('a local variable named like a banned global is fine; while(true) without break warns', () => {
		const m = lintOf('const document = 1; let i = 0; while (true) { i++; }');
		expect(m.ok).toBe(true);
		expect(m.lint.map((/** @type {any} */ f) => f.level)).toEqual(['warning']);
	});
	it('an unknown event warns (it would never fire)', () => {
		const m = analyze('export default behaviour({ on: { nope() {} } });', SPECS);
		expect(m.ok).toBe(true);
		expect(m.lint[0].message).toMatch(/no such event/);
	});
});

describe('setParamLiteral — the knob writes ONE literal', () => {
	it('rewrites the value and nothing else (comments, formatting, the other params)', () => {
		const r = setParamLiteral(WAVES, 'interval', 4.5);
		expect(r.changed).toBe(true);
		const before = WAVES.split('\n');
		const after = r.source.split('\n');
		const diff = before.map((l, i) => (l !== after[i] ? i : -1)).filter((i) => i >= 0);
		expect(diff.length).toBe(1);
		expect(after[diff[0]]).toBe('\t\tinterval: { value: 4.5, min: 0, max: 30, step: 0.5, unit: \'s\' },');
		expect(analyze(r.source, SPECS).params.find((/** @type {any} */ p) => p.key === 'interval').value).toBe(4.5);
	});
	it('a bare literal param, a negative number, a boolean, a string with the file quote style', () => {
		const src = "export default behaviour({ params: { a: 1, b: -2, c: true, d: 'x' } });";
		expect(setParamLiteral(src, 'a', 7).source).toContain('a: 7,');
		expect(setParamLiteral(src, 'b', -0.25).source).toContain('b: -0.25,');
		expect(setParamLiteral(src, 'c', false).source).toContain('c: false,');
		expect(setParamLiteral(src, 'd', "it's").source).toContain("d: 'it\\'s'");
	});
	it('rounds to the step; refuses what is not a literal', () => {
		expect(formatNumber(1.2999999, 0.1)).toBe('1.3');
		expect(formatNumber(3, 1)).toBe('3');
		const src = 'const R = 2;\nexport default behaviour({ params: { r: R } });';
		expect(setParamLiteral(src, 'r', 3)).toMatchObject({ changed: false, error: expect.stringMatching(/not a literal/) });
		expect(setParamLiteral(src, 'nope', 3).changed).toBe(false);
	});
});

describe('deriveGraph — the read-only node view', () => {
	it('the Waves spawner: events, params, functions, state, kit nodes and the edges between them', () => {
		const g = deriveGraph(analyze(WAVES, SPECS));
		const ids = g.nodes.map((n) => n.id);
		expect(ids).toEqual(
			expect.arrayContaining(['e:go', 'e:died', 'p:interval', 'h:go', 'h:died', 'm:startWave', 's:wave', 's:alive', 'k:spawner.spawn', 'k:round.win', 'k:mover.chase'])
		);
		const has = (/** @type {string} */ s, /** @type {string} */ t) => g.edges.some((e) => e.source === s && e.target === t);
		expect(has('e:died', 'h:died')).toBe(true);
		expect(has('h:died', 's:alive')).toBe(true); // a write
		expect(has('s:wave', 'h:died')).toBe(true); // a read
		expect(has('h:go', 'm:startWave')).toBe(true);
		expect(has('m:startWave', 'k:spawner.spawn')).toBe(true);
		const timer = g.nodes.find((n) => n.data.view.kind === 'timer');
		expect(has('p:interval', timer.id)).toBe(true);
		expect(has(timer.id, 'm:startWave')).toBe(true);
		// read-only, and the kit node is named exactly as the generated kit node (T3)
		expect(g.nodes.every((n) => n.draggable === false && n.connectable === false)).toBe(true);
		expect(g.nodes.find((n) => n.id === 'k:spawner.spawn').data).toMatchObject({ label: 'Spawn entities', nodeType: 'kit-spawner-spawn' });
	});
	it('a behaviour is a FEW nodes, not one per operation (the proposal: ~10-20)', () => {
		expect(deriveGraph(analyze(WAVES, SPECS)).nodes.length).toBeLessThanOrEqual(20);
		expect(deriveGraph(analyze(REACH, SPECS)).nodes.length).toBe(4);
	});
});
