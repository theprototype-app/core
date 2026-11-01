// pc-speed: the desk battery's shared queue (scripts/ci/battery-desk.cjs `queue`) — who runs what next, what a
// lost worker means, what a resume skips, and one real run with two workers against fake suites.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const TOOL = path.resolve('scripts/ci/battery-desk.cjs');
const { makeQueue, longestFirst, treeId, linkTree, resumeFrom } = require(TOOL);

/** @param {number|null} rc @param {string[]} [fps] */
const att = (rc, fps = []) => ({ rc, secs: 1, pass: 1, fail: rc === 0 ? 0 : 1, last: '', fps });

describe('battery queue: the list', () => {
	it('hands out suites in order, one per worker, then says wait until the last one is back', () => {
		const q = makeQueue(['long', 'short']);
		expect(q.claim('a')).toEqual({ name: 'long', kind: 'first' });
		expect(q.claim('b')).toEqual({ name: 'short', kind: 'first' });
		q.report('b', 'short', 'first', att(0));
		expect(q.claim('b')).toEqual({ wait: true });
		q.report('a', 'long', 'first', att(0));
		expect(q.claim('b')).toEqual({ done: true });
		expect(q.finished()).toBe(true);
	});
	it('orders longest first by the times in the list, an unknown suite counted as long', () => {
		const b = { suites: { a: 10, b: 900, c: 50 }, modules: { m: 400 } };
		expect(longestFirst(b, ['a', 'c', 'MOD:m', 'b', 'new'])).toEqual(['b', 'MOD:m', 'new', 'c', 'a']);
	});
	it('retries a red only when no first attempt is left, on another worker while there is one', () => {
		const q = makeQueue(['red', 'x']);
		q.hello('b');
		expect(q.claim('a').name).toBe('red');
		q.report('a', 'red', 'first', att(1, ['red :: one']));
		expect(q.claim('a')).toEqual({ name: 'x', kind: 'first' });
		expect(q.claim('b')).toEqual({ name: 'red', kind: 'retry' });
		q.report('b', 'red', 'retry', att(0));
		expect(q.results.get('red').status).toBe('flaky');
		expect(q.results.get('red').fps).toEqual([]);
	});
	it('runs the retry on the same worker when it is the only one left', () => {
		const q = makeQueue(['red']);
		q.hello('b');
		q.claim('a');
		q.report('a', 'red', 'first', att(1, ['red :: one']));
		expect(q.claim('a')).toEqual({ wait: true });
		q.gone('b');
		expect(q.claim('a')).toEqual({ name: 'red', kind: 'retry' });
	});
	it('keeps the checks red both times, as `run` does', () => {
		const q = makeQueue(['red']);
		q.claim('a');
		q.report('a', 'red', 'first', att(1, ['red :: one', 'red :: two']));
		q.claim('a');
		q.report('a', 'red', 'retry', att(1, ['red :: two', 'red :: three']));
		expect(q.results.get('red').status).toBe('red');
		expect(q.results.get('red').fps).toEqual(['red :: two']);
	});
	it('without retries a red is final', () => {
		const q = makeQueue(['red'], new Map(), false);
		q.claim('a');
		q.report('a', 'red', 'first', att(1, ['red :: one']));
		expect(q.claim('a')).toEqual({ done: true });
	});
	it('a lost worker puts its suite back at the front; lost twice it is red and runs no more', () => {
		const q = makeQueue(['killer', 'next']);
		q.claim('a');
		expect(q.gone('a')).toEqual({ name: 'killer', requeued: true });
		expect(q.claim('b').name).toBe('killer');
		expect(q.gone('b')).toEqual({ name: 'killer', requeued: false });
		expect(q.results.get('killer').status).toBe('red');
		expect(q.claim('c').name).toBe('next');
		q.report('c', 'next', 'first', att(0));
		expect(q.claim('c')).toEqual({ done: true });
	});
	it('ignores a late answer for a suite already run elsewhere', () => {
		const q = makeQueue(['s']);
		q.claim('a');
		q.gone('a');
		q.claim('b');
		q.report('b', 's', 'first', att(0));
		expect(q.report('a', 's', 'first', att(1, ['s :: late']))).toBe(null);
		expect(q.results.get('s').status).toBe('pass');
	});
	it('a worker that asks again has lost what it held', () => {
		const q = makeQueue(['s', 't']);
		q.claim('a');
		expect(q.claim('a').name).toBe('s');
	});
});

describe('battery queue: trees and resume', () => {
	const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bq-'));
	it('treeId sees a changed file, not outputs or installs', () => {
		const d = tmp();
		fs.writeFileSync(path.join(d, 'a.js'), '1');
		const id = treeId(d);
		fs.mkdirSync(path.join(d, 'node_modules'));
		fs.writeFileSync(path.join(d, 'node_modules', 'x'), 'y');
		fs.mkdirSync(path.join(d, 'test-results'));
		fs.writeFileSync(path.join(d, 'test-results', 'r'), 'y');
		expect(treeId(d)).toBe(id);
		fs.writeFileSync(path.join(d, 'a.js'), '2');
		expect(treeId(d)).not.toBe(id);
	});
	it('linkTree copies the tree by hard links, without outputs or the vite cache', () => {
		const d = tmp();
		fs.mkdirSync(path.join(d, 'src'));
		fs.writeFileSync(path.join(d, 'src', 'a.js'), '1');
		fs.mkdirSync(path.join(d, 'node_modules', '.vite'), { recursive: true });
		fs.writeFileSync(path.join(d, 'node_modules', 'p'), '1');
		fs.writeFileSync(path.join(d, 'node_modules', '.vite', 'q'), '1');
		fs.mkdirSync(path.join(d, 'test-results'));
		const w = `${d}-w1`;
		linkTree(d, w);
		expect(fs.statSync(path.join(w, 'src', 'a.js')).ino).toBe(fs.statSync(path.join(d, 'src', 'a.js')).ino);
		expect(fs.existsSync(path.join(w, 'node_modules', 'p'))).toBe(true);
		expect(fs.existsSync(path.join(w, 'node_modules', '.vite'))).toBe(false);
		expect(fs.existsSync(path.join(w, 'test-results'))).toBe(false);
		expect(treeId(w)).toBe(treeId(d));
	});
	it('resume keeps what was green on this tree, not reds, not another tree, not a cut line', () => {
		const f = path.join(tmp(), 'j.jsonl');
		const row = (/** @type {string} */ name, /** @type {string} */ kind, /** @type {number} */ rc, tree = 'T') => JSON.stringify({ tree, name, kind, attempt: att(rc, rc ? [`${name} :: x`] : []) });
		fs.writeFileSync(f, [row('ok', 'first', 0), row('flaky', 'first', 1), row('flaky', 'retry', 0), row('red', 'first', 1), row('red', 'retry', 1), row('old', 'first', 0, 'OTHER'), '{"cut'].join('\n'));
		const { green, other } = resumeFrom(f, 'T');
		expect([...green.keys()].sort()).toEqual(['flaky', 'ok']);
		expect(green.get('flaky').status).toBe('flaky');
		expect(other).toBe('OTHER');
	});
});

describe('battery queue: a real run', () => {
	// fake suites in a throwaway tree, two workers with no slot booking; `bad` writes FAIL until the marker exists
	const setup = () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bq-run-'));
		const root = path.join(d, 'tree');
		fs.mkdirSync(path.join(root, 'tests/e2e'), { recursive: true });
		fs.mkdirSync(path.join(root, 'scripts/ci'), { recursive: true });
		for (const f of ['battery-desk.cjs', 'battery.cjs', 'quarantine.cjs']) fs.copyFileSync(path.resolve('scripts/ci', f), path.join(root, 'scripts/ci', f));
		const marks = path.join(d, 'marks');
		fs.mkdirSync(marks);
		for (const n of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(root, `tests/e2e/${n}.test.cjs`), `require('fs').appendFileSync(${JSON.stringify(path.join(marks, n))}, 'x\\n'); console.log('PASS ${n}');\n`);
		fs.writeFileSync(path.join(root, 'tests/e2e/flaky.test.cjs'), `const fs=require('fs');const m=${JSON.stringify(path.join(marks, 'flaky'))};if(fs.existsSync(m)){console.log('PASS f')}else{fs.writeFileSync(m,'x');console.log('FAIL f');process.exit(1)}\n`);
		const bj = { suites: { a: 10, b: 400, c: 30, d: 20, flaky: 5 }, modules: {}, desk: {}, shards: 1, skip: {}, optional: {}, exclude: {} };
		fs.writeFileSync(path.join(root, 'tests/e2e/battery.json'), JSON.stringify(bj));
		fs.writeFileSync(path.join(root, 'tests/e2e/quarantine.json'), '{}');
		const out = path.join(d, 'out');
		const go = (/** @type {string[]} */ extra = [], slot = '') =>
			spawnSync('node', [path.join(root, 'scripts/ci/battery-desk.cjs'), 'queue', '--workers', '2', '--slot', slot, '--port', '5999', '--battery', path.join(root, 'tests/e2e/battery.json'), '--root', root, '--out', out, '--name', 'q', ...extra], {
				encoding: 'utf8',
				env: { ...process.env, BATTERY_QUEUE_HOST: '127.0.0.1', BATTERY_STATE: path.join(d, 'state'), APP_URL: '', BATTERY_COMMIT: 'test', BATTERY_QUEUE_RESPAWN_S: '1' },
				timeout: 60000
			});
		return { root, out, marks, go, d };
	};
	it('finishes every suite once, writes what `diff` reads, and a resume runs nothing green again', () => {
		const { root, out, marks, go, d } = setup();
		const r = go();
		expect(r.stdout).toContain('BATTERY-DONE q');
		expect(r.status).toBe(0);
		const rec = JSON.parse(fs.readFileSync(path.join(out, 'q.json'), 'utf8'));
		expect(rec.results.map((/** @type {any} */ x) => x.name)).toEqual(['b', 'c', 'd', 'a', 'flaky']);
		expect(rec.results.find((/** @type {any} */ x) => x.name === 'flaky').status).toBe('flaky');
		expect(fs.readFileSync(path.join(marks, 'a'), 'utf8')).toBe('x\n');
		expect(fs.existsSync(path.join(out, 'logs', 'flaky.retry.log'))).toBe(true);
		expect(fs.existsSync(`${root}-w1`)).toBe(false);

		// the tool's own `diff` takes it: nothing is NEW against a baseline of the same run
		const tool = path.join(root, 'scripts/ci/battery-desk.cjs');
		const env = { ...process.env, BATTERY_STATE: path.join(d, 'state') };
		expect(spawnSync('node', [tool, 'baseline', 'save', 'v0', out], { encoding: 'utf8', env }).status).toBe(0);
		const diff = spawnSync('node', [tool, 'diff', '--baseline', 'v0', out], { encoding: 'utf8', env });
		expect(diff.stdout).toContain('0 NEW');

		const again = go(['--resume']);
		expect(again.stdout).toContain('resume: 5 suite(s) already green');
		expect(again.status).toBe(0);
		expect(fs.readFileSync(path.join(marks, 'a'), 'utf8')).toBe('x\n');
	}, 90000);
	it('a resume on a changed tree runs everything again', () => {
		const { root, marks, go } = setup();
		expect(go().status).toBe(0);
		fs.writeFileSync(path.join(root, 'tests/e2e/c.test.cjs'), `require('fs').appendFileSync(${JSON.stringify(path.join(marks, 'c'))}, 'y\\n'); console.log('PASS c');\n`);
		const again = go(['--resume']);
		expect(again.stdout).toContain('another tree');
		expect(fs.readFileSync(path.join(marks, 'a'), 'utf8')).toBe('x\nx\n');
	}, 90000);
	it('a worker with nowhere to run ends as INCOMPLETE, no .json for `diff` to read', () => {
		const { out, go } = setup();
		const bad = go([], 'false');
		expect(bad.stdout).toContain('BATTERY-INCOMPLETE');
		expect(bad.status).toBe(2);
		expect(fs.existsSync(path.join(out, 'q.json'))).toBe(false);
		expect(fs.existsSync(path.join(out, 'q.partial'))).toBe(true);
	}, 150000);
});
