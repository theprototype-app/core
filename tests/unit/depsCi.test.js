// deps-auto: the Dependabot merge policy (scripts/ci/deps-policy.cjs) and the battery's shard planner
// (scripts/ci/battery.cjs) — both decide what CI does without a person, so both are pinned here.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classify } = require('../../scripts/ci/deps-policy.cjs');
const { assign, shardCount, counts, ciEnvError, ciSuiteEnv } = require('../../scripts/ci/battery.cjs');
const batteryJson = require('../../tests/e2e/battery.json');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

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
	it('runs the battery only for a non-major change to the app root', () => {
		expect(classify([dep('three', 'direct:production', 'patch')]).battery).toBe(true);
		expect(classify([dep('prettier', 'direct:development', 'minor')]).battery).toBe(true);
		expect(classify([dep('@sveltejs/kit', 'direct:development', 'major')]).battery).toBe(false);
		expect(classify([dep('actions/checkout', 'direct:production', 'minor', '/', 'github_actions')]).battery).toBe(false);
		expect(classify([dep('ws', 'direct:production', 'minor', '/tools/agent')]).battery).toBe(false);
		expect(classify([dep('ws', 'direct:production', 'patch', '/tools/agent'), dep('three', 'direct:production', 'patch')]).battery).toBe(true);
		expect(classify([]).battery).toBe(true);
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
	it('splits required from optional; a local `all` run queues optional after required', () => {
		const b = { ...battery({ a: 600, b: 500, o1: 900, o2: 100 }), optional: { o1: 'red on the base', o2: 'flaky' } };
		expect(assign(b, 2).map((x) => x.suites)).toEqual([['a'], ['b']]);
		expect(assign(b, 2, 'optional').map((x) => x.suites)).toEqual([['o1'], ['o2']]);
		expect(assign(b, 2, 'all').map((x) => x.suites)).toEqual([['a', 'o1'], ['b', 'o2']]);
		const sized = { ...b, shards: { target_minutes: 10, max: 20, min: 1 } };
		expect([shardCount(sized), shardCount(sized, 'optional')]).toEqual([2, 2]);
		expect(shardCount({ ...sized, optional: {} }, 'optional')).toBe(0);
	});
	it('sizes the matrix from the target minutes, clamped', () => {
		expect(shardCount(battery({ a: 600, b: 600, c: 600, d: 600 }))).toBe(4);
		expect(shardCount(battery({ a: 60 }))).toBe(2);
		expect(shardCount(battery(Object.fromEntries(Array.from({ length: 99 }, (_, i) => ['s' + i, 600]))))).toBe(20);
	});
	it('counts pass/fail lines the way the integrators battery does', () => {
		expect(counts('  ✓ one\n  ✗ two\nPASS three\n\nlast line\n')).toMatchObject({ pass: 2, fail: 1, last: 'last line', slow: false, slowWaits: 0 });
	});
});

describe('BATTERY_CI is GitHub-only (ci-speed): every battery runner refuses it elsewhere', () => {
	it('accepts it on GitHub Actions and accepts its absence anywhere', () => {
		expect(ciEnvError({ BATTERY_CI: '1', GITHUB_ACTIONS: 'true' })).toBe('');
		expect(ciEnvError({})).toBe('');
		expect(ciEnvError({ BATTERY_CI: '', GITHUB_ACTIONS: undefined })).toBe('');
		expect(ciEnvError({ BATTERY_CI: '0' })).toBe('');
	});
	it('refuses it on a local / desk / pc / release run, whatever value it carries', () => {
		expect(ciEnvError({ BATTERY_CI: '1' })).toMatch(/outside GitHub Actions/);
		expect(ciEnvError({ BATTERY_CI: 'true', GITHUB_ACTIONS: 'false' })).toMatch(/CI-only/);
		expect(ciEnvError({ BATTERY_CI: '1', GITHUB_ACTIONS: '1' })).toMatch(/GITHUB_ACTIONS=1/);
	});
	it('the runners exit 2 before doing anything (battery.cjs, battery-desk.cjs) and the e2e helpers refuse to load', () => {
		const root = path.resolve(new URL('.', import.meta.url).pathname, '../..');
		const { GITHUB_ACTIONS: _onGitHub, ...rest } = process.env;
		const env = { ...rest, BATTERY_CI: '1' };
		for (const script of ['scripts/ci/battery.cjs', 'scripts/ci/battery-desk.cjs']) {
			const r = spawnSync(process.execPath, [path.join(root, script), 'plan'], { cwd: root, env, encoding: 'utf8' });
			expect(r.status).toBe(2);
			expect(r.stderr).toMatch(/outside GitHub Actions/);
		}
		const h = spawnSync(process.execPath, ['-e', "require('./tests/e2e/helpers.cjs')"], { cwd: root, env, encoding: 'utf8' });
		expect(h.status).not.toBe(0);
		expect(h.stderr).toMatch(/outside GitHub Actions/);
	});
});

describe('the lean draw opt-out (ci-speed): battery.json ci.fullDraw', () => {
	const b = { ci: { fullDraw: { 'pixel-suite': 'reads frame pixels' } } };
	it('hands E2E_FULL_DRAW=1 to a listed suite on CI, nothing to the rest, nothing off CI', () => {
		expect(ciSuiteEnv(/** @type {any} */ (b), 'pixel-suite', { BATTERY_CI: '1' })).toEqual({ E2E_FULL_DRAW: '1' });
		expect(ciSuiteEnv(/** @type {any} */ (b), 'store-suite', { BATTERY_CI: '1' })).toEqual({});
		expect(ciSuiteEnv(/** @type {any} */ (b), 'pixel-suite', {})).toEqual({});
	});
	it('every listed suite exists and carries its reason', () => {
		const list = Object.entries(batteryJson.ci?.fullDraw ?? {});
		for (const [name, reason] of list) {
			expect(fs.existsSync(new URL(`../e2e/${name}.test.cjs`, import.meta.url)), name).toBe(true);
			expect(typeof reason === 'string' && reason.length > 10, name).toBe(true);
		}
	});
});
