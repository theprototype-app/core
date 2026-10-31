// battery-tiers: tier 1 picked by COVERAGE (tests/e2e/coverage-map.json), not by names — the map's boot floor,
// the selection rules (a)-(e) of scripts/ci/battery-desk.cjs selectTiers, the lockfile diff and the release gate.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildMap, formatMap, parseMap, selectTiers, lockChanges, suiteRequires, releaseCheck, half } = require('../../scripts/ci/battery-desk.cjs');
const battery = require('../../tests/e2e/battery.json');

/** a desk battery of the named suites at 60 s each, plus the tier keys @param {string[]} names @param {object} [extra] */
const desk = (names, extra = {}) => ({ refs: {}, shards: { target_minutes: 36, max: 20, min: 4 }, skip: {}, optional: {}, setup: {}, suites: Object.fromEntries(names.map((n) => [n, 60])), ...extra });
/** @param {Partial<Record<'src'|'added'|'changedSuites'|'support'|'packages'|'other', string[]>>} c */
const change = (c) => ({ src: [], added: [], changedSuites: [], support: [], packages: [], other: [], ...c });
const names = (/** @type {{name: string}[]} */ l) => l.map((p) => p.name);

describe('battery-tiers: the coverage map keeps what a suite ran beyond the boot floor', () => {
	// ten suites boot App.svelte the same way (3 functions); two of them do more with it, one opens a lazy window
	/** @type {{ suite: string, files: Record<string, number> }[]} */
	const records = Array.from({ length: 10 }, (_, i) => ({ suite: `s${i}`, files: { 'src/App.svelte': i < 8 ? 3 : 7, 'src/lib/boot.js': 2 } }));
	records[4].files['src/components/StatsOverlay.svelte'] = 1;
	records.push({ suite: 'node-only', files: {} });
	const map = buildMap(records, { commit: 'abc' });
	it('the floor is the quietest tenth: a file every suite boots maps to the suites that ran more of it', () => {
		expect(map.floor).toEqual({ 'src/App.svelte': 3, 'src/lib/boot.js': 2 });
		expect(map.suites.s9).toEqual(['src/App.svelte']);
		expect(map.suites.s0).toEqual([]);
	});
	it('a file only some suites load has floor 0: loading it is using it', () => {
		expect(map.suites.s4).toEqual(['src/components/StatsOverlay.svelte']);
	});
	it('a record with no app file is no evidence: the suite stays unmapped', () => {
		expect('node-only' in map.suites).toBe(false);
	});
	it('the same suite in two runs (a retry, two halves) takes the larger count', () => {
		const m = buildMap([...records, { suite: 's0', files: { 'src/App.svelte': 9 } }]);
		expect(m.suites.s0).toEqual(['src/App.svelte']);
	});
	it('--merge adds suites against the committed floor and keeps the others', () => {
		const m = buildMap([{ suite: 'fresh', files: { 'src/App.svelte': 3, 'src/lib/new.js': 1 } }], { base: map });
		expect(m.suites.fresh).toEqual(['src/lib/new.js']);
		expect(m.suites.s9).toEqual(['src/App.svelte']);
		expect(m.floor).toEqual(map.floor);
	});
	it('the committed format is one suite per line, names files by index into one table, and parses back', () => {
		const text = formatMap(map);
		expect(parseMap(text)).toEqual(map);
		expect(JSON.parse(text).files).toEqual(['src/App.svelte', 'src/components/StatsOverlay.svelte']);
		expect(text).toContain('"s4": [1]');
		expect(text.split('\n').filter((l) => /^\t\t"s\d": /.test(l)).length).toBe(10);
	});
	it('a file run past the floor by many suites names its heaviest users (ties kept, a saturated tie dropped)', () => {
		/** @type {{ suite: string, files: Record<string, number> }[]} */
		const many = Array.from({ length: 30 }, (_, i) => ({ suite: `m${String(i).padStart(2, '0')}`, files: { 'src/lib/menu.js': i < 3 ? 1 : 30 - i, 'src/lib/flat.js': i < 3 ? 1 : 5 } }));
		const m = buildMap(many);
		expect(m.heavy?.['src/lib/menu.js']).toEqual(['m03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09', 'm10']);
		expect(m.heavy?.['src/lib/flat.js']).toBeUndefined();
		expect(parseMap(formatMap(m)).heavy).toEqual(m.heavy);
	});
	it('a bundler chunk an older record names (npm:client-Cqw3l5wU) is no package and is dropped', () => {
		const m = buildMap([{ suite: 'x', files: { 'npm:client-Cqw3l5wU': 9, 'npm:three': 4 } }, { suite: 'y', files: { 'src/App.svelte': 1 } }]);
		expect(m.suites.x).toEqual(['npm:three']);
	});
});

describe('battery-tiers: selection by coverage', () => {
	const map = {
		comment: '',
		made: '',
		commit: '',
		floor_pct: 10,
		records: 6,
		floor: { 'src/App.svelte': 3 },
		suites: {
			'window-body-drag': ['src/components/StatsOverlay.svelte', 'src/lib/dragWindow.js'],
			'context-menu-redesign': ['src/lib/objectMenu.js', 'src/App.svelte'],
			'ui-fixes-15lmno': ['src/lib/githubStars.js', 'src/App.svelte'],
			'net-mesh': ['src/lib/peerHandler.svelte.js'],
			'paint': ['src/lib/paint.js', 'npm:three'],
			'quiet': []
		}
	};
	const b = desk(['window-body-drag', 'context-menu-redesign', 'ui-fixes-15lmno', 'net-mesh', 'paint', 'quiet', 'brand-new'], { tier1_always: ['net-mesh'], tier1_always_files: ['src/App.svelte'], tier1_cap: 0.5 });
	it('(a) the three old-suite catches the name match missed are tier 1 when their files change', () => {
		for (const [file, suite] of [
			['src/components/StatsOverlay.svelte', 'window-body-drag'],
			['src/lib/objectMenu.js', 'context-menu-redesign'],
			['src/lib/githubStars.js', 'ui-fixes-15lmno']
		]) {
			const t = selectTiers(b, map, change({ src: [file] }));
			expect(names(t.tier1)).toContain(suite);
			expect(t.tier1.find((p) => p.name === suite)?.why).toEqual([`covers ${file}`]);
		}
	});
	it('(b) an added or changed suite, and a suite requiring a changed support file', () => {
		const t = selectTiers(b, map, change({ added: ['brand-new'], changedSuites: ['paint'], support: ['tests/e2e/paint.shared.cjs'] }), { requires: { quiet: ['tests/e2e/paint.shared.cjs'] } });
		expect(t.tier1.find((p) => p.name === 'paint')?.why).toContain('changed');
		expect(t.tier1.find((p) => p.name === 'quiet')?.why).toEqual(['requires paint.shared.cjs']);
	});
	it('(c) the always-set and --also; (d) a suite with no map entry; the rest is tier 2', () => {
		const t = selectTiers(b, map, change({}), { also: ['paint'] });
		expect(names(t.tier1).sort()).toEqual(['brand-new', 'net-mesh', 'paint']);
		expect(t.tier1.find((p) => p.name === 'brand-new')?.why).toEqual(['unmapped']);
		expect(names(t.tier2)).toEqual(['window-body-drag', 'context-menu-redesign', 'ui-fixes-15lmno', 'quiet']);
		expect(t.secs).toEqual({ tier1: 180, tier2: 240 });
	});
	it('(e) a shared file pulls its suites in while tier 1 stays under the cap, and is reported when it would not', () => {
		// net-mesh (always) + brand-new (unmapped) = 2 of 7 suites; App.svelte's 2 more make 4 of 7
		const under = selectTiers({ ...b, tier1_cap: 0.6 }, map, change({ src: ['src/App.svelte'] }));
		expect(under.shared).toEqual([{ file: 'src/App.svelte', suites: 2, taken: true }]);
		expect(names(under.tier1)).toContain('context-menu-redesign');
		const tight = selectTiers(b, map, change({ src: ['src/App.svelte'] }));
		expect(tight.shared).toEqual([{ file: 'src/App.svelte', suites: 2, taken: false }]);
		expect(names(tight.tier1)).not.toContain('context-menu-redesign');
	});
	it('a file run past the floor by more than tier1_shared_suites suites is shared without being listed', () => {
		const wide = { ...map, suites: Object.fromEntries(Object.entries(map.suites).map(([s, f]) => [s, s === 'quiet' ? f : [...f, 'src/lib/everywhere.js']])) };
		const t = selectTiers({ ...b, tier1_cap: 0.2, tier1_shared_suites: 4 }, wide, change({ src: ['src/lib/everywhere.js'] }));
		expect(t.shared[0]).toMatchObject({ file: 'src/lib/everywhere.js', taken: false });
		// its heaviest users come along whatever the cap
		const heavy = selectTiers({ ...b, tier1_cap: 0.2, tier1_shared_suites: 4 }, { ...wide, heavy: { 'src/lib/everywhere.js': ['paint'] } }, change({ src: ['src/lib/everywhere.js'] }));
		expect(heavy.tier1.find((p) => p.name === 'paint')?.why).toEqual(['heavy src/lib/everywhere.js']);
	});
	it('a changed package pulls the suites that ran it; boot-only and uncovered files are reported, not guessed', () => {
		const t = selectTiers(b, map, change({ packages: ['npm:three'], src: ['src/App.svelte', 'src/lib/nobody.js'] }), {});
		expect(t.tier1.find((p) => p.name === 'paint')?.why).toEqual(['covers npm:three']);
		expect(t.uncovered).toEqual(['src/lib/nobody.js']);
		const boot = selectTiers(b, { ...map, floor: { 'src/lib/boot.js': 2 } }, change({ src: ['src/lib/boot.js'] }));
		expect(boot.bootOnly).toEqual(['src/lib/boot.js']);
	});
	it('without a map every suite is tier 1 (the safe default)', () => {
		const t = selectTiers(b, null, change({ src: ['src/lib/objectMenu.js'] }));
		expect(t.tier2).toEqual([]);
	});
	it('--half splits a tier with nothing lost', () => {
		const tier = Object.keys(battery.suites).slice(0, 41);
		const a = half(battery, 'A', 2, tier);
		const c = half(battery, 'B', 2, tier);
		expect([...a, ...c].sort()).toEqual([...tier].sort());
	});
	it('every tier1_always suite is a desk suite', () => {
		expect((battery.tier1_always || []).filter((/** @type {string} */ n) => !(n in battery.suites))).toEqual([]);
	});
});

describe('battery-tiers: the diff helpers', () => {
	it('lockChanges names the top-level packages whose locked version moved', () => {
		const a = JSON.stringify({ packages: { '': {}, 'node_modules/three': { version: '0.170.0' }, 'node_modules/@threlte/core': { version: '8.0.1' }, 'node_modules/x/node_modules/y': { version: '1' } } });
		const z = JSON.stringify({ packages: { '': {}, 'node_modules/three': { version: '0.171.0' }, 'node_modules/@threlte/core': { version: '8.0.1' }, 'node_modules/x/node_modules/y': { version: '2' }, 'node_modules/new': { version: '1' } } });
		expect(lockChanges(a, z)).toEqual(['npm:new', 'npm:three']);
	});
	it('suiteRequires follows require chains (lock-settings-b runs lock-settings.test.cjs)', () => {
		const r = suiteRequires(process.cwd());
		expect(r['lock-settings-b']).toContain('tests/e2e/lock-settings.test.cjs');
		expect(r['lock-settings-b']).toContain('tests/e2e/helpers.cjs');
	});
});

describe('battery-tiers: the next release gate', () => {
	const row = (/** @type {object} */ x) => ({ version: '1.45.0', base: 'v1.44.0', escapes: [], date: '', tier1: { suites: 1, suite_min: 1, wall_min: 1, reds: 0, new: 0 }, ...x });
	const t2 = (/** @type {string[]} */ fresh) => ({ suites: 9, suite_min: 9, wall_min: 9, reds: fresh.length, new: fresh.length, new_suites: fresh });
	it('an unrecorded tier 2 or an unclassified NEW tier-2 red holds the next union', () => {
		expect(releaseCheck([row({})])[0]).toMatch(/tier 2 not recorded/);
		expect(releaseCheck([row({ tier2: t2(['dock-tabs']) })])[0]).toMatch(/not classified: dock-tabs/);
		expect(releaseCheck([row({ tier2: t2(['dock-tabs']), escapes: [{ suite: 'dock-tabs', check: 'x', real: false, severity: 'none' }] })])).toEqual([]);
	});
	it('two real escapes in the last five releases say WIDEN TIER 1', () => {
		const esc = (/** @type {string} */ s) => ({ suite: s, check: '', real: true, severity: 'minor' });
		const rows = [row({ version: '1.41.0', tier2: t2([]), escapes: [esc('a')] }), row({ version: '1.42.0', tier2: t2([]) }), row({ tier2: t2(['b']), escapes: [esc('b')] })];
		expect(releaseCheck(rows).pop()).toMatch(/^WIDEN TIER 1: tier 2 found 2 real bugs/);
	});
});
