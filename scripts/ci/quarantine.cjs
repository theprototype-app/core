#!/usr/bin/env node
// test-health-1 — THE QUARANTINE: known flaky or known-red e2e checks, by name, with an owner and a date.
//
// The battery (scripts/ci/battery.cjs, and the integrators' battery.sh through `triage`) gates on every
// red EXCEPT one listed in tests/e2e/quarantine.json. It is perf/budgets.json's `allow` list one domain
// over: an entry records a known debt, it is not a place to put a red you have not read. Every entry
// names the suite, optionally ONE check (a substring of its `FAIL <label>` line — the label text a suite
// passes to h.check), why it is there, who owns the fix, when it went in and when to look again.
//
// THE NON-BLOCKING TIER IS PER CHECK. A suite red counts as quarantined only when EVERY failed check of
// its run matches an entry for that suite (or the suite has a whole-suite entry, `check` absent) — so a
// quarantined timing row cannot hide a new red in the same suite. A suite that crashed (`SCRIPT FAILED`,
// no FAIL line, no summary line) or timed out is never covered by a check entry: nothing says the
// quarantined row is what stopped it.
//
// Dates warn, they never fail (the allow-list rule: a date must not turn an unrelated PR red). An entry
// whose review date passed, or whose suite ran fully green, is printed as a warning to act on.
//
//   node scripts/ci/quarantine.cjs check                       # validate the file
//   node scripts/ci/quarantine.cjs triage <summary.txt> [<logdir>]  # split a battery.sh summary's reds
//   node scripts/ci/quarantine.cjs list                        # what is quarantined, by review date

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const QUARANTINE = path.join(ROOT, 'tests', 'e2e', 'quarantine.json');
const REQUIRED = ['suite', 'reason', 'owner', 'since', 'review'];
const KEYS = [...REQUIRED, 'check'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @typedef {{ suite: string, check?: string, reason: string, owner: string, since: string, review: string }} Entry
 * @typedef {{ comment?: string, quarantine: Entry[] }} Quarantine
 * @typedef {{ quarantined: boolean, whole: boolean, failed: string[], unmatched: string[], entries: Entry[] }} Verdict
 */

/** @returns {Quarantine} */
function load(file = QUARANTINE) {
	if (!fs.existsSync(file)) return { quarantine: [] };
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** @param {any} q @returns {string[]} */
function validate(q) {
	/** @type {string[]} */
	const errors = [];
	if (!q || !Array.isArray(q.quarantine)) return ['quarantine must be an array'];
	const seen = new Set();
	q.quarantine.forEach((/** @type {any} */ e, /** @type {number} */ i) => {
		const at = `quarantine[${i}]${e?.suite ? ' (' + e.suite + ')' : ''}`;
		for (const k of REQUIRED) if (typeof e?.[k] !== 'string' || !e[k].trim()) errors.push(`${at}.${k} is required`);
		for (const k of Object.keys(e ?? {})) if (!KEYS.includes(k)) errors.push(`${at}: unknown key ${k}`);
		if ('check' in (e ?? {}) && (typeof e.check !== 'string' || !e.check.trim())) errors.push(`${at}.check must be a non-empty string (omit it for the whole suite)`);
		for (const k of ['since', 'review']) if (e?.[k] && !DATE.test(e[k])) errors.push(`${at}.${k} must be YYYY-MM-DD`);
		if (e?.since && e?.review && e.review <= e.since) errors.push(`${at}: review must be after since`);
		const key = `${e?.suite}\u0000${e?.check ?? '*'}`;
		if (seen.has(key)) errors.push(`${at}: duplicate entry`);
		seen.add(key);
	});
	return errors;
}

/** the labels of the FAIL lines a suite printed (helpers.check) @param {string} log */
function failedChecks(log) {
	return log
		.split('\n')
		.map((l) => /^\s*(?:✗|FAIL|not ok)\s+(.*)$/.exec(l))
		.filter((m) => m !== null)
		.map((m) => /** @type {RegExpExecArray} */ (m)[1].trim());
}

/** did the suite reach helpers.finish (its own verdict line) rather than crash @param {string} log */
function finished(log) {
	return /^(ALL PASS|\d+ FAILURES)\s*$/m.test(log) && !/^SCRIPT FAILED/m.test(log);
}

/**
 * Is this red non-blocking? @param {Quarantine} q @param {string} suite @param {string} log
 * @param {{timedOut?: boolean}} [opts] @returns {Verdict}
 */
function classify(q, suite, log, opts = {}) {
	const mine = (q.quarantine ?? []).filter((e) => e.suite === suite);
	const whole = mine.find((e) => !e.check);
	const failed = failedChecks(log);
	if (whole) return { quarantined: true, whole: true, failed, unmatched: [], entries: [whole] };
	const used = new Set();
	const unmatched = failed.filter((label) => {
		const hit = mine.find((e) => e.check && label.includes(e.check));
		if (hit) used.add(hit);
		return !hit;
	});
	const covered = !opts.timedOut && finished(log) && failed.length > 0 && unmatched.length === 0;
	return { quarantined: covered, whole: false, failed, unmatched, entries: [...used] };
}

/**
 * What to act on: past review dates, entries that saw their suite (or their check) green, and entries
 * for suites the battery no longer has. @param {Quarantine} q
 * @param {{name: string, status: string, log?: string}[]} results @param {string[]} [known] suite names
 * @param {string} [today] YYYY-MM-DD
 */
function warnings(q, results = [], known, today = new Date().toISOString().slice(0, 10)) {
	/** @type {string[]} */
	const out = [];
	const byName = new Map(results.map((r) => [r.name, r]));
	for (const e of q.quarantine ?? []) {
		const tag = `${e.suite}${e.check ? ' "' + e.check + '"' : ''}`;
		if (e.review < today) out.push(`quarantine ${tag}: review date ${e.review} has passed (owner ${e.owner}) — fix it, delete the check, or re-date the entry`);
		const r = byName.get(e.suite);
		if (r && r.status === 'pass') out.push(`quarantine ${tag}: the suite ran green — remove the entry once it holds`);
		else if (r && e.check && r.log != null && !failedChecks(r.log).some((l) => l.includes(/** @type {string} */ (e.check)))) out.push(`quarantine ${tag}: that check did not fail this run`);
		if (known && !known.includes(e.suite)) out.push(`quarantine ${tag}: no such suite in the battery — stale entry`);
	}
	return out;
}

/**
 * Split an integrator battery.sh summary (`<suite> rc=<n> pass~ fail~ <s>s :: <last line>`) into the
 * reds that gate and the ones the quarantine covers. Reads <logdir>/<suite>.log for the check names.
 * @param {string} summaryFile @param {string} [logDir]
 */
function triage(summaryFile, logDir = path.dirname(summaryFile)) {
	const q = load();
	/** @type {{name: string, rc: string, v: Verdict}[]} */
	const blocking = [];
	/** @type {{name: string, rc: string, v: Verdict}[]} */
	const quarantined = [];
	/** @type {{name: string, status: string, log?: string}[]} */
	const results = [];
	for (const line of fs.readFileSync(summaryFile, 'utf8').split('\n')) {
		const m = /^(\S+) rc=(\S+) /.exec(line);
		if (!m || m[1].startsWith('MOD:')) continue;
		const [, name, rc] = m;
		const logFile = path.join(logDir, name + '.log');
		const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
		results.push({ name, status: rc === '0' ? 'pass' : 'fail', log });
		if (rc === '0') continue;
		const v = classify(q, name, log, { timedOut: rc === '124' });
		(v.quarantined ? quarantined : blocking).push({ name, rc, v });
	}
	return { blocking, quarantined, warnings: warnings(q, results) };
}

if (require.main === module) {
	const [cmd, ...argv] = process.argv.slice(2);
	const q = load();
	const errors = validate(q);
	if (cmd === 'check' || !cmd) {
		for (const e of errors) console.error('quarantine.json: ' + e);
		for (const w of warnings(q)) console.log('warning: ' + w);
		console.log(errors.length ? `${errors.length} errors` : `quarantine.json: ${q.quarantine.length} entries OK`);
		process.exit(errors.length ? 1 : 0);
	} else if (cmd === 'list') {
		for (const e of [...q.quarantine].sort((a, b) => (a.review < b.review ? -1 : 1))) console.log(`${e.review}  ${e.suite}${e.check ? ' :: ' + e.check : ' (whole suite)'}  — ${e.owner}`);
	} else if (cmd === 'triage' && argv[0]) {
		if (errors.length) {
			for (const e of errors) console.error('quarantine.json: ' + e);
			process.exit(2);
		}
		const t = triage(argv[0], argv[1]);
		for (const b of t.blocking) console.log(`RED  ${b.name} rc=${b.rc}${b.v.unmatched.length ? ' :: ' + b.v.unmatched.slice(0, 3).join(' | ') : ''}`);
		for (const b of t.quarantined) console.log(`QUAR ${b.name} :: ${b.v.whole ? 'whole suite' : b.v.failed.join(' | ')}`);
		for (const w of t.warnings) console.log('warning: ' + w);
		console.log(`${t.blocking.length} blocking red, ${t.quarantined.length} quarantined`);
		process.exit(t.blocking.length ? 1 : 0);
	} else {
		console.error('usage: quarantine.cjs check | list | triage <summary.txt> [<logdir>]');
		process.exit(2);
	}
}

module.exports = { QUARANTINE, load, validate, failedChecks, finished, classify, warnings, triage };
