// test-health-1: the e2e quarantine (scripts/ci/quarantine.cjs) decides which battery reds gate a PR,
// without a person — so the per-check rule, the crash rule and the file's shape are pinned here.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { load, validate, failedChecks, classify, warnings } = require('../../scripts/ci/quarantine.cjs');

const entry = (/** @type {Record<string, string>} */ over = {}) => ({
	suite: 'ui-fixes',
	check: 'toast burst',
	reason: 'a fixed sleep',
	owner: 'test-health',
	since: '2026-10-24',
	review: '2026-11-07',
	...over
});
const q = (/** @type {any[]} */ ...list) => ({ quarantine: list });
const log = (/** @type {string[]} */ ...lines) => [...lines, lines.some((l) => l.startsWith('FAIL')) ? `${lines.filter((l) => l.startsWith('FAIL')).length} FAILURES` : 'ALL PASS'].join('\n');

describe('quarantine: which reds do not gate', () => {
	it('reads the FAIL labels helpers.check prints', () => {
		expect(failedChecks('PASS a\nFAIL the toast burst moved 8 px\n  ✗ two\nnot ok three\n')).toEqual(['the toast burst moved 8 px', 'two', 'three']);
	});
	it('a red whose every failed check is quarantined is non-blocking', () => {
		const v = classify(q(entry()), 'ui-fixes', log('PASS x', 'FAIL the toast burst moved 8 px'));
		expect(v.quarantined).toBe(true);
		expect(v.entries).toHaveLength(1);
	});
	it('a quarantined row cannot hide a NEW red in the same suite', () => {
		const v = classify(q(entry()), 'ui-fixes', log('FAIL the toast burst moved 8 px', 'FAIL Roughness row'));
		expect(v.quarantined).toBe(false);
		expect(v.unmatched).toEqual(['Roughness row']);
	});
	it('a check entry never covers a crash or a timeout', () => {
		const crash = 'PASS a\nFAIL the toast burst moved 8 px\nSCRIPT FAILED: Timeout 30000ms exceeded';
		expect(classify(q(entry()), 'ui-fixes', crash).quarantined).toBe(false);
		expect(classify(q(entry()), 'ui-fixes', 'PASS a\nFAIL the toast burst\n').quarantined).toBe(false); // no verdict line
		expect(classify(q(entry()), 'ui-fixes', log('FAIL the toast burst'), { timedOut: true }).quarantined).toBe(false);
	});
	it('an entry is per suite: the same label in another suite still gates', () => {
		expect(classify(q(entry()), 'other-suite', log('FAIL the toast burst')).quarantined).toBe(false);
	});
	it('a whole-suite entry (no check) covers any red, crash included', () => {
		const { check, ...whole } = entry();
		expect(classify(q(whole), 'ui-fixes', 'SCRIPT FAILED: boom').quarantined).toBe(true);
	});
});

describe('quarantine.json: the file', () => {
	it('the committed file validates', () => {
		expect(validate(load())).toEqual([]);
	});
	it('every committed entry names a suite that exists', async () => {
		const fs = require('node:fs');
		const path = require('node:path');
		for (const e of load().quarantine) expect(fs.existsSync(path.resolve('tests/e2e', e.suite + '.test.cjs')), e.suite).toBe(true);
	});
	it('refuses a missing field, a bad date, an unknown key and a duplicate', () => {
		const { owner, ...noOwner } = entry();
		expect(validate(q(noOwner))).toEqual([expect.stringContaining('.owner is required')]);
		expect(validate(q(entry({ review: '7 Nov' })))[0]).toContain('review must be YYYY-MM-DD');
		expect(validate(q(entry({ review: '2026-10-01' })))[0]).toContain('review must be after since');
		expect(validate(q({ ...entry(), note: 'x' }))[0]).toContain('unknown key note');
		expect(validate(q(entry(), entry()))[0]).toContain('duplicate');
	});
	it('warns (never fails) on a past review date and on a suite that ran green', () => {
		const w = warnings(q(entry()), [{ name: 'ui-fixes', status: 'pass' }], ['ui-fixes'], '2026-12-01');
		expect(w.some((x) => x.includes('review date 2026-11-07 has passed'))).toBe(true);
		expect(w.some((x) => x.includes('ran green'))).toBe(true);
		expect(warnings(q(entry()), [], ['elsewhere'], '2026-10-25')).toEqual([expect.stringContaining('stale entry')]);
	});
});
