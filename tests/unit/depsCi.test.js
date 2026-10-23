// deps-auto: the Dependabot merge policy (scripts/ci/deps-policy.cjs) and the battery's shard planner
// (scripts/ci/battery.cjs) — both decide what CI does without a person, so both are pinned here.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classify } = require('../../scripts/ci/deps-policy.cjs');
const { assign, shardCount, counts } = require('../../scripts/ci/battery.cjs');

/** @param {string} name @param {string} type @param {string} up @param {string} [dir] @param {string} [eco] */
const dep = (name, type, up, dir = '/', eco = 'npm_and_yarn') => ({
	dependencyName: name,
	dependencyType: type,
	updateType: 'version-update:semver-' + up,
	directory: dir,
	packageEcosystem: eco
});

describe('deps-policy: one class per PR, the most careful part wins', () => {
	it('auto-merges patches, development-only minors and actions', () => {
		expect(classify([dep('three', 'direct:production', 'patch')])).toMatchObject({ cls: 'auto', needsPc: true });
		expect(classify([dep('prettier', 'direct:development', 'minor')])).toMatchObject({ cls: 'auto', needsPc: false });
		expect(classify([dep('actions/checkout', 'direct:production', 'major', '/', 'github_actions')])).toMatchObject({ cls: 'auto', needsPc: false });
	});
	it('holds a runtime minor for a person, and a dev package that ships counts as runtime', () => {
		expect(classify([dep('three', 'direct:production', 'minor')]).cls).toBe('ready');
		expect(classify([dep('svelte', 'direct:development', 'minor')])).toMatchObject({ cls: 'ready', needsPc: true });
		expect(classify([dep('vite', 'direct:development', 'patch')])).toMatchObject({ cls: 'auto', needsPc: true });
	});
	it('never automates Playwright (the e2e hosts pin the browser) or a major', () => {
		expect(classify([dep('playwright', 'direct:development', 'patch')]).cls).toBe('ready');
		expect(classify([dep('@axe-core/playwright', 'direct:development', 'minor')]).cls).toBe('ready');
		expect(classify([dep('@sveltejs/kit', 'direct:development', 'major')]).cls).toBe('major');
	});
	it('a group takes its most careful member; the agent never needs the PC', () => {
		const g = [dep('prettier', 'direct:development', 'patch'), dep('three', 'direct:production', 'minor'), dep('vitest', 'direct:development', 'minor')];
		expect(classify(g)).toMatchObject({ cls: 'ready', reason: 'three minor (ships)' });
		expect(classify([dep('ws', 'direct:production', 'minor', '/tools/agent')])).toMatchObject({ cls: 'ready', needsPc: false });
		expect(classify([dep('ws', 'direct:production', 'patch', '/tools/agent')])).toMatchObject({ cls: 'auto', needsPc: false });
		expect(classify([]).cls).toBe('ready');
	});
});

/** @param {Record<string, number>} suites @param {Record<string, string>} [skip] */
const battery = (suites, skip = {}) => ({ refs: {}, shards: { target_minutes: 10, max: 20, min: 2 }, skip, optional: {}, setup: {}, suites });

describe('battery shards: longest first onto the least-loaded shard', () => {
	it('balances by seconds and is the same on every shard', () => {
		const b = battery({ a: 600, b: 500, c: 400, d: 300, e: 200, f: 100, x: 9999 }, { x: 'signaling box' });
		const s = assign(b, 2);
		expect(s.map((x) => x.suites)).toEqual([['a', 'd', 'e'], ['b', 'c', 'f']]);
		expect(s.map((x) => x.secs)).toEqual([1100, 1000]);
		expect(assign(b, 2)).toEqual(s);
		expect(s.flat().some((x) => x.suites.includes('x'))).toBe(false);
	});
	it('sizes the matrix from the target minutes, clamped', () => {
		expect(shardCount(battery({ a: 600, b: 600, c: 600, d: 600 }))).toBe(4);
		expect(shardCount(battery({ a: 60 }))).toBe(2);
		expect(shardCount(battery(Object.fromEntries(Array.from({ length: 99 }, (_, i) => ['s' + i, 600]))))).toBe(20);
	});
	it('counts pass/fail lines the way the integrators battery does', () => {
		expect(counts('  ✓ one\n  ✗ two\nPASS three\n\nlast line\n')).toEqual({ pass: 2, fail: 1, last: 'last line' });
	});
});
