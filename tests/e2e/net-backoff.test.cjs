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

	// ---- 27-F: jitter and an unbounded retry (hardening audit H2) ----------------
	// The signaling reconnect used to stop after 5 attempts and tell the user to reload,
	// which drops every live DataConnection AND the invite id. Unbounded is the fix; the
	// CAP is what protects the server, and jitter stops a room of tabs returning together.
	check(backoffDelay(1, { base: 1000 }) === 1000, 'jitter defaults to OFF (defaults byte-identical)');
	check(
		JSON.stringify(backoffSchedule()) === JSON.stringify([500, 1000, 2000, 4000]),
		'the default schedule is unchanged by the new options'
	);

	// injectable rng = the schedule stays testable; +/-25% of 1000 is 750..1250
	check(backoffDelay(1, { base: 1000, jitter: 0.25, rng: () => 0 }) === 750, 'jitter at rng 0 is -25%');
	check(backoffDelay(1, { base: 1000, jitter: 0.25, rng: () => 0.5 }) === 1000, 'jitter at rng 0.5 is the plain delay');
	check(backoffDelay(1, { base: 1000, jitter: 0.25, rng: () => 1 }) === 1250, 'jitter at rng 1 is +25%');
	check(
		backoffDelay(1, { base: 100, jitter: 4, rng: () => 0 }) === 0,
		'a jitter big enough to go negative CLAMPS at 0 (a negative wait would hammer the server)'
	);

	// unbounded: every attempt has a delay, saturated at the cap
	const unbounded = { base: 800, cap: 8000, max: Infinity };
	check(backoffDelay(5, unbounded) !== null, 'attempt 5 still has a delay when max is Infinity');
	check(backoffDelay(99, unbounded) === 8000, 'attempt 99 saturates at the cap instead of giving up');
	check(backoffDelay(1, unbounded) === 800, 'the first unbounded attempt is the base');

	// ...and the schedule helper must TERMINATE on an unbounded max
	const un = backoffSchedule(unbounded);
	check(un.length === 10, `an unbounded schedule is bounded by \`limit\` (${un.length} entries)`);
	check(backoffSchedule({ ...unbounded, limit: 3 }).length === 3, 'limit is honoured');

	console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILURES');
	process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
	console.error('SCRIPT FAILED:', e.message);
	process.exit(1);
});
