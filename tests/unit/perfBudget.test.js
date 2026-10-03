// 34 B2 — the budget gate's RULE (scripts/perfBudget.cjs): what passes, what is red, what an
// allow-list entry buys and what it never does. The browser half (perf-games.cjs --check) only
// produces the rows judged here.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { judge, validateBudgets, limitsFor, loadBudgets, METRICS } = require('../../scripts/perfBudget.cjs');

const base = () => ({
	version: 1,
	defaults: { calls: 150, triangles: 300000, lights: 2, textureMB: 64 },
	games: {},
	levels: {},
	allow: []
});
const row = (over = {}) => ({ kind: 'game', slug: 'towers', calls: 40, triangles: 9000, lights: 2, textureMB: 1, ...over });
const allow = (over = {}) => ({
	target: 'game:jam-room',
	metric: 'calls',
	max: 950,
	measured: 910,
	since: '2026-10-03',
	review: '2026-12-01',
	owner: 'jam-room (music-lab)',
	note: 'one mesh per pad',
	...over
});

describe('the committed perf/budgets.json', () => {
	it('is valid and holds the Quest budget as its defaults', () => {
		const b = loadBudgets();
		expect(b.defaults.calls).toBe(150);
		expect(b.defaults.triangles).toBe(300000);
		expect(b.defaults.lights).toBe(2);
		expect(Number.isFinite(b.defaults.textureMB)).toBe(true);
	});
	it('every allow entry is dated, owned and explained', () => {
		for (const a of loadBudgets().allow) {
			expect(a.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(a.review > a.since).toBe(true);
			expect(String(a.owner).length).toBeGreaterThan(2);
			expect(String(a.note).length).toBeGreaterThan(10);
			expect(a.max).toBeGreaterThanOrEqual(a.measured);
		}
	});
});

describe('judge', () => {
	it('a scene within every budget is green', () => {
		const v = judge(base(), [row()], { today: '2026-10-03' });
		expect(v.ok).toBe(true);
		expect(v.failures).toEqual([]);
		expect(v.checks.map((c) => c.metric)).toEqual(METRICS);
	});
	it('one count over the budget is red, and says which and by how much', () => {
		const v = judge(base(), [row({ calls: 151 })], { today: '2026-10-03' });
		expect(v.ok).toBe(false);
		expect(v.failures[0]).toMatch(/game:towers: calls 151 > 150 \(the budget\)/);
	});
	it('the budget is inclusive: exactly 150 calls passes', () => {
		expect(judge(base(), [row({ calls: 150 })]).ok).toBe(true);
	});
	it('a target that could not be measured is RED, never a silent pass', () => {
		const v = judge(base(), [{ kind: 'game', slug: 'waves', error: 'no zip for waves' }]);
		expect(v.ok).toBe(false);
		expect(v.failures[0]).toMatch(/NOT MEASURED/);
		expect(judge(base(), [row({ calls: undefined })]).ok).toBe(false);
	});
	it('an allow entry lets a known offender ship up to its ceiling', () => {
		const b = { ...base(), allow: [allow()] };
		const v = judge(b, [row({ slug: 'jam-room', calls: 910 })], { today: '2026-10-03' });
		expect(v.ok).toBe(true);
		expect(v.checks.find((c) => c.metric === 'calls').status).toBe('allowed');
	});
	it('a regression PAST the allow ceiling is red (the planted-regression case)', () => {
		const b = { ...base(), allow: [allow()] };
		const v = judge(b, [row({ slug: 'jam-room', calls: 951 })], { today: '2026-10-03' });
		expect(v.ok).toBe(false);
		expect(v.failures[0]).toMatch(/calls 951 > 950 \(the allow-list ceiling of 2026-10-03/);
	});
	it('an allow entry covers ONE metric: the same scene over on another count is still red', () => {
		const b = { ...base(), allow: [allow()] };
		expect(judge(b, [row({ slug: 'jam-room', calls: 910, lights: 4 })]).ok).toBe(false);
	});
	it('an allow entry covers ONE target', () => {
		const b = { ...base(), allow: [allow()] };
		expect(judge(b, [row({ slug: 'waves', calls: 910 })]).ok).toBe(false);
	});
	it('a view-specific entry wins over a level-wide one, and only for that view', () => {
		const b = {
			...base(),
			allow: [
				allow({ target: 'level:tavern-interior', metric: 'triangles', max: 330000, measured: 326574 }),
				allow({ target: 'level:tavern-interior', metric: 'triangles', view: 'spawn', max: 321000, measured: 319650 })
			]
		};
		const lvl = (view, triangles) => ({ kind: 'level', slug: 'tavern-interior', view, calls: 100, triangles, lights: 1, textureMB: 10 });
		expect(judge(b, [lvl('spawn', 320000), lvl('back corner', 329000)]).ok).toBe(true);
		const v = judge(b, [lvl('spawn', 325000)]);
		expect(v.ok).toBe(false);
		expect(v.failures[0]).toMatch(/@ spawn: triangles 325000 > 321000/);
	});
	it('an entry no longer needed is a WARNING, not a failure', () => {
		const b = { ...base(), allow: [allow()] };
		const v = judge(b, [row({ slug: 'jam-room', calls: 120 })], { today: '2026-10-03' });
		expect(v.ok).toBe(true);
		expect(v.warnings.join('\n')).toMatch(/now within the budget .* remove the entry/);
	});
	it('a passed review date is a WARNING (a calendar must not turn an unrelated PR red)', () => {
		const b = { ...base(), allow: [allow({ review: '2026-10-02' })] };
		const v = judge(b, [row({ slug: 'jam-room', calls: 910 })], { today: '2026-10-03' });
		expect(v.ok).toBe(true);
		expect(v.warnings.join('\n')).toMatch(/review date 2026-10-02 has passed/);
	});
	it('a per-target budget override replaces the default for that target only', () => {
		const b = { ...base(), games: { football: { textureMB: 8 } } };
		expect(limitsFor(b, 'game', 'football').textureMB).toBe(8);
		expect(limitsFor(b, 'game', 'towers').textureMB).toBe(64);
		expect(judge(b, [row({ slug: 'football', textureMB: 9 })]).ok).toBe(false);
	});
});

describe('validateBudgets', () => {
	it('accepts the minimal file', () => {
		expect(validateBudgets(base())).toEqual([]);
	});
	it('an allow entry without a date, owner or reason is rejected', () => {
		for (const k of ['since', 'review', 'owner', 'note', 'max', 'measured']) {
			const a = allow();
			delete a[k];
			expect(validateBudgets({ ...base(), allow: [a] }).join('\n')).toMatch(new RegExp(`allow\\[0\\]\\.${k} is required`));
		}
	});
	it('rejects a malformed date, an unknown metric, a bad target and duplicates', () => {
		expect(validateBudgets({ ...base(), allow: [allow({ since: '3 Oct' })] }).join()).toMatch(/since must be YYYY-MM-DD/);
		expect(validateBudgets({ ...base(), allow: [allow({ metric: 'fps' })] }).join()).toMatch(/metric must be one of/);
		expect(validateBudgets({ ...base(), allow: [allow({ target: 'jam-room' })] }).join()).toMatch(/target must be game:<slug>/);
		expect(validateBudgets({ ...base(), allow: [allow(), allow()] }).join()).toMatch(/duplicates/);
		expect(validateBudgets({ ...base(), games: { towers: { fps: 60 } } }).join()).toMatch(/not a gated metric/);
	});
	it('frame time is NOT a gated metric (a runner cannot reproduce it)', () => {
		expect(METRICS).not.toContain('p95');
		expect(METRICS).not.toContain('ms');
	});
});
