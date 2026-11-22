// showhide-v8: the svelte-check ratchet refuses a COLLAPSED run (the TS service switched off by the 20 MB
// non-TS size limit reads as "0 errors") instead of calling it an improvement.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { parseCounts, collapsedRun } = require('../../scripts/check-ratchet.cjs');

const HEALTHY = '1794246567742 COMPLETED 7551 FILES 280 ERRORS 37 WARNINGS 45 FILES_WITH_PROBLEMS';
const COLLAPSED = '1794246365704 COMPLETED 663 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS';
const base = { errors: 278, warnings: 39 };
/** @param {string} t */
const counts = (t) => parseCounts(t) ?? { errors: -1, warnings: -1 };

describe('check-ratchet collapsedRun', () => {
	it('trusts a healthy run (the counterfactual)', () => {
		expect(collapsedRun(HEALTHY, counts(HEALTHY), base)).toBeNull();
	});
	it('refuses a run that checked a few hundred files', () => {
		expect(collapsedRun(COLLAPSED, counts(COLLAPSED), base)).toMatch(/663 files/);
	});
	it('refuses 0/0 against a large baseline even without a file count (the TTY shape)', () => {
		const tty = 'svelte-check found 0 errors and 0 warnings';
		expect(collapsedRun(tty, counts(tty), base)).toMatch(/0 errors against a baseline of 278/);
		expect(collapsedRun(tty, counts(tty), { errors: 3 })).toBeNull();
	});
});
