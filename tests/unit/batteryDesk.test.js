// pipeline-1: the desk battery (scripts/ci/battery-desk.cjs) — check fingerprints, the baseline diff, and
// the guard that every tests/e2e file is in tests/e2e/battery.json or excluded with a reason.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalise, fingerprints, classify, coverage, e2eFiles, half } = require('../../scripts/ci/battery-desk.cjs');
const battery = require('../../tests/e2e/battery.json');

/** @param {string} name @param {'pass'|'flaky'|'red'|'gone'} status @param {string[]} fps */
const res = (name, status, fps = []) => ({ name, status, first: { rc: status === 'pass' ? 0 : 1, secs: 1, pass: 1, fail: fps.length, last: '', fps }, fps });

describe('battery-desk: a failed check is the same check on another run', () => {
	it('drops numbers, JSON details, paths and colour codes', () => {
		expect(normalise('FAIL dock resize widens (320 → 440)')).toBe(normalise('FAIL dock resize widens (318 → 437)'));
		expect(normalise('FAIL an occupied edge takes a tab ({"flow":"right","listShown":false})')).toBe('an occupied edge takes a tab ({…})');
		expect(normalise('    at /home/x/run-50-int/tests/e2e/touch-actions.test.cjs:235:92')).toBe('at touch-actions.test.cjs:#:#');
		expect(normalise('\x1b[31mFAIL\x1b[0m the Cut button could not be clicked')).toBe('the Cut button could not be clicked');
	});
	it('keeps different checks apart', () => {
		expect(normalise('FAIL the Cut button could not be clicked')).not.toBe(normalise('FAIL the Cut button is disabled'));
	});
	it('fingerprints FAIL lines, SCRIPT FAILED and timeouts; a green log has none', () => {
		const log = 'PASS a\nFAIL b took 1200 ms\nSCRIPT FAILED: locator.click: Timeout 30000ms exceeded.\n1 FAILURES\n';
		expect(fingerprints('s', log, 1)).toEqual(['s :: SCRIPT FAILED: locator.click: Timeout #ms exceeded.', 's :: b took # ms']);
		expect(fingerprints('s', log, 0)).toEqual([]);
		expect(fingerprints('s', '✓ a\n✗ b is red\n', 1)).toEqual(['s :: b is red']);
		expect(fingerprints('s', 'PASS a\n[battery] TIMEOUT after 1500s\n', null)).toContain('s :: TIMEOUT');
		expect(fingerprints('s', 'booting\nError: listen EADDRINUSE :5480\n', 1)).toEqual(['s :: rc=1 Error: listen EADDRINUSE :#']);
	});
});

describe('battery-desk: a run against the release baseline', () => {
	const baseline = {
		tag: 'v1.0.0',
		commit: 'abc',
		made: '',
		runs: [],
		suites: { old: { status: 'red', fps: ['old :: x'] }, mixed: { status: 'red', fps: ['mixed :: x'] }, fine: { status: 'pass', fps: [] } }
	};
	it('same checks red on the tag = pre-existing; a new check or a suite green on the tag = NEW', () => {
		const run = {
			name: 'u1A',
			root: '',
			commit: '',
			slot: '',
			started: '',
			secs: 0,
			results: [res('old', 'red', ['old :: x']), res('mixed', 'red', ['mixed :: x', 'mixed :: y']), res('fine', 'red', ['fine :: z']), res('fresh', 'red', ['fresh :: q']), res('wobbly', 'flaky'), res('ok', 'pass')]
		};
		const c = classify(baseline, [run]);
		expect(c.known).toEqual(['old']);
		expect(c.flaky).toEqual(['wobbly']);
		expect(c.green).toEqual(['ok']);
		expect(c.fresh.map((/** @type {{name: string}} */ f) => f.name)).toEqual(['mixed', 'fine', 'fresh']);
		expect(c.fresh[0].fps).toEqual(['mixed :: y']);
		expect(c.fresh[1].why).toBe('green on the baseline');
		expect(c.fresh[2].why).toBe('not in the baseline');
	});
});

describe('battery-desk: every e2e file is in the battery or excluded', () => {
	it('tests/e2e/battery.json lists or excludes every *.test.cjs', () => {
		const c = coverage(battery, e2eFiles());
		expect(c.unlisted, 'add these to tests/e2e/battery.json suites (a measured time) or to exclude with a reason').toEqual([]);
		expect(c.both).toEqual([]);
	});
	it('the guard notices a new file', () => {
		expect(coverage({ ...battery, exclude: {} }, ['brand-new-suite']).unlisted).toEqual(['brand-new-suite']);
	});
	it('the two halves split the desk set (suites + modules flights) with nothing lost', () => {
		const a = half(battery, 'A', 2);
		const b = half(battery, 'B', 2);
		expect(a.length + b.length).toBe(Object.keys(battery.suites).length + Object.keys(battery.modules || {}).length);
		expect(a.filter((/** @type {string} */ n) => b.includes(n))).toEqual([]);
	});
});

describe('battery-desk import: an old battery.sh run', () => {
	it('takes the FAIL lines written under each row, and a rerun as the retry', () => {
		const fs = require('node:fs');
		const os = require('node:os');
		const path = require('node:path');
		const { execFileSync } = require('node:child_process');
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-'));
		fs.writeFileSync(path.join(dir, 'u1.txt'), 'snapshot: x\nok-suite rc=0 pass~3 fail~0 9s :: ALL PASS\nred rc=1 pass~2 fail~1 9s :: 1 FAILURES\n    FAIL the toast hides after 1200 ms\nwobbly rc=1 pass~1 fail~1 5s :: 1 FAILURES\n    FAIL a flaky check\nBATTERY-DONE\n');
		fs.writeFileSync(path.join(dir, 'r2.txt'), 'snapshot: x\nwobbly rc=0 pass~2 fail~0 5s :: ALL PASS\n');
		// a later rerun's green log in the same folder must not hide the red row's own lines
		fs.writeFileSync(path.join(dir, 'red.log'), 'PASS everything\nALL PASS\n');
		const cli = path.resolve('scripts/ci/battery-desk.cjs');
		execFileSync('node', [cli, 'import', path.join(dir, 'u1.txt'), '--logs', dir, '--retry', path.join(dir, 'r2.txt'), '--name', 'u1', '--out', dir]);
		const run = JSON.parse(fs.readFileSync(path.join(dir, 'u1.json'), 'utf8'));
		const by = Object.fromEntries(run.results.map((/** @type {{name: string}} */ r) => [r.name, r]));
		expect(by['ok-suite'].status).toBe('pass');
		expect(by.red.status).toBe('red');
		expect(by.red.fps).toEqual(['red :: the toast hides after # ms']);
		expect(by.wobbly.status).toBe('flaky');
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
