// 100-int — THE MEMORY SLOPE, JUDGED ACROSS RUNS: does a candidate build grow the heap per Cinematic-view trip
// faster than its base? One run's tail slope (cinematic-memory-100.cjs, trips 16-25) swings 24-107 KB/trip on
// unchanged code (100-int QUESTIONS 2), so a fixed line flips at random. This compares two SERIES of runs instead,
// made interleaved (B U B U ...) on one machine and scene, with the rule the orchestrator fixed on 2026-11-20:
//   PASS = the candidate median is within DELTA_KB (30) of the base median, OR the series overlap (not every
//          candidate run is above every base run): the growth is the base's own.
//   FAIL = every candidate run above every base run AND the median delta over DELTA_KB.
// The 5 % gate on the last ten trips is each run's own verdict; a run that FAILED it fails this check too.
//
//   node tests/e2e/cinematic-memory-ab.cjs --base <dir> [<dir> …] --cand <dir> [<dir> …]
//   (each <dir> holds memory-*-t25.json files, searched recursively)
const fs = require('fs');
const path = require('path');

const DELTA_KB = Number(process.env.DELTA_KB || 30);

/** @param {string} dir @returns {string[]} */
function jsons(dir) {
	/** @type {string[]} */
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...jsons(p));
		else if (/^memory-.*-t\d+\.json$/.test(e.name)) out.push(p);
	}
	return out;
}

/** @param {number[]} a */
const median = (a) => {
	const s = [...a].sort((x, y) => x - y);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** @param {string[]} dirs */
function series(dirs) {
	const runs = dirs.flatMap(jsons).map((f) => ({ f, r: JSON.parse(fs.readFileSync(f, 'utf8')) }));
	return runs.filter(({ r }) => typeof r.tailSlopeKB === 'number');
}

/**
 * The rule, pure (exported for the unit test).
 * @param {number[]} base @param {number[]} cand
 */
function judge(base, cand, delta = DELTA_KB) {
	if (!base.length || !cand.length) return { ok: false, why: 'a series is empty' };
	const mb = median(base);
	const mc = median(cand);
	const allAbove = Math.min(...cand) > Math.max(...base);
	const ok = mc - mb <= delta || !allAbove;
	return { ok, mb, mc, d: +(mc - mb).toFixed(1), allAbove, why: ok ? (mc - mb <= delta ? 'within the delta' : 'the series overlap') : 'every candidate run above every base run, median over the delta' };
}

module.exports = { judge, median };

if (require.main === module) {
	const argv = process.argv.slice(2);
	const pick = (/** @type {string} */ flag) => {
		const i = argv.indexOf(flag);
		if (i < 0) return [];
		const out = [];
		for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]);
		return out;
	};
	const B = series(pick('--base'));
	const C = series(pick('--cand'));
	const show = (/** @type {any[]} */ s) => s.map(({ r }) => r.tailSlopeKB).join(', ');
	console.log(`base slopes KB/trip: ${show(B)}`);
	console.log(`cand slopes KB/trip: ${show(C)}`);
	const failed5 = C.filter(({ r }) => r.verdict === 'FAIL' && r.heapPct > (r.gatePct ?? 5));
	const v = judge(B.map(({ r }) => r.tailSlopeKB), C.map(({ r }) => r.tailSlopeKB));
	console.log(`median base ${v.mb} cand ${v.mc} (delta ${v.d}, line ${DELTA_KB}); every cand run above every base run: ${v.allAbove}`);
	if (failed5.length) console.log(`FAIL ${failed5.length} candidate run(s) over the 5 % gate: ${failed5.map(({ f }) => f).join(', ')}`);
	console.log(`${v.ok && !failed5.length ? 'PASS' : 'FAIL'} memory slope, union vs base: ${v.why}`);
	process.exit(v.ok && !failed5.length ? 0 : 1);
}
