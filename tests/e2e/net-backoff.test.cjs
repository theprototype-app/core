// Phase 172: unit test for the pure reconnect-backoff helper. No browser — the
// runner just `node`s this file, so we dynamically import the ESM module and
// assert the deterministic schedule. Self-contained check/exit (no browser to
// hand to helpers.finish).
const { pathToFileURL } = require('url');
const path = require('path');

let failures = 0;
function check(ok, label) {
	console.log((ok ? 'PASS ' : 'FAIL ') + label);
	if (!ok) failures++;
}

(async () => {
	const mod = await import(pathToFileURL(path.join(__dirname, '..', '..', 'src', 'lib', 'netBackoff.js')).href);
	const { backoffDelay, backoffSchedule } = mod;

	// default schedule: 500 / 1000 / 2000 / 4000, then exhausted
	const sched = backoffSchedule();
	check(JSON.stringify(sched) === JSON.stringify([500, 1000, 2000, 4000]), `default schedule is 500/1000/2000/4000 (${sched.join('/')})`);
	check(backoffDelay(1) === 500, 'attempt 1 = 500ms');
	check(backoffDelay(4) === 4000, 'attempt 4 = 4000ms');
	check(backoffDelay(5) === null, 'attempt past max returns null (exhausted)');
	check(backoffDelay(0) === null, 'attempt 0 is invalid (null)');

	// cap clamps the exponential growth
	const capped = backoffSchedule({ base: 1000, factor: 3, cap: 5000, max: 5 });
	check(capped.every((d) => d <= 5000), `cap clamps every delay to <= 5000 (${capped.join('/')})`);
	check(capped[capped.length - 1] === 5000, 'later attempts saturate at the cap');

	// monotonic non-decreasing (never schedules a shorter wait than the prior try)
	const mono = backoffSchedule({ max: 6, cap: 100000 });
	check(mono.every((d, i) => i === 0 || d >= mono[i - 1]), 'schedule is monotonic non-decreasing');

	// deterministic: same inputs -> identical output (no Date/random)
	check(JSON.stringify(backoffSchedule()) === JSON.stringify(backoffSchedule()), 'schedule is deterministic across calls');

	console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
	process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
	console.error('SCRIPT FAILED:', e.message);
	process.exit(1);
});
