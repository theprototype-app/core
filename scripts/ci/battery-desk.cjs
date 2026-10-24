#!/usr/bin/env node
// THE INTEGRATORS' BATTERY ON A DESK, AGAINST A BASELINE OF THE LAST RELEASE.
//
// battery.cjs runs tests/e2e/battery.json in shards on GitHub runners. This is the same list run the
// way an integrator runs it before a release: one half at a time on an e2e slot, against a dev server
// the slot started, with the suites a public runner skips (the self-hosted signaling box, the
// production hostname mapped here, the modules repo's flights). What it adds over a plain loop:
//
//  - EVERY RED RUNS ONCE MORE, AT THE END OF THE HALF, not straight after. A red that came from the
//    moment (a sibling's build filling the box, a cold vite pre-bundle) meets a different moment the
//    second time. Green then = flaky: logged with its checks, never handed to the integrator.
//  - EVERY FAILED CHECK GETS A FINGERPRINT (suite + the FAIL line with numbers, JSON and paths taken
//    out), so "the same red as on the release" is a set lookup, not an A/B run.
//  - A BASELINE per release tag: the battery once on the tag right after the release (`baseline`).
//    `diff` sorts a run's reds into pre-existing (every check red in both runs is red on the tag too),
//    flaky (no check red twice) and NEW — the only ones that need the integrator.
//  - ONE SUMMARY LINE at the end (stdout, and <out>/<name>.done), so a lane that started this in the
//    background is woken by the exit, not by polling.
//
//   node scripts/ci/battery-desk.cjs run --half A [--of 2] [--out dir] [--name u1A] [--root tree] [--no-retry]
//   node scripts/ci/battery-desk.cjs run --only a,b,MOD:untangle ...
//   node scripts/ci/battery-desk.cjs baseline save <tag> <out-dir>...      # record a tag's runs
//   node scripts/ci/battery-desk.cjs diff [--baseline tag|file] <out-dir>...  # exit 1 when anything is NEW
//   node scripts/ci/battery-desk.cjs flakes [--days 30]                    # flake rate per suite
//   node scripts/ci/battery-desk.cjs coverage                              # every e2e file listed or excluded
//   node scripts/ci/battery-desk.cjs import u1A.txt --logs e2e/ [--retry r2.txt]  # an old battery.sh run, for diff
//
// State (baselines, the outcome log) lives in $BATTERY_STATE, default ~/.local/state/theprototype/battery.
// The environment a suite reads (APP_URL, MODULES_REPO, the *_TPSCENE paths, PEER_CONFIG_SELF) is the
// caller's: source the integrator's env file first, exactly as for the old battery.sh.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { load, assign, counts } = require('./battery.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const STATE = process.env.BATTERY_STATE || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'theprototype', 'battery');

/**
 * @typedef {import('./battery.cjs').Battery & { modules?: Record<string, number>, desk?: { 'prod-host'?: string[], 'peer-self'?: string[], gpu?: string[] },
 *   exclude?: Record<string, string[]> }} DeskBattery
 * @typedef {{ rc: number|null, secs: number, pass: number, fail: number, last: string, fps: string[] }} Attempt
 * @typedef {{ name: string, status: 'pass'|'flaky'|'red'|'gone', first: Attempt, retry?: Attempt, fps: string[] }} DeskResult
 * @typedef {{ name: string, root: string, commit: string, slot: string, started: string, secs: number, results: DeskResult[] }} DeskRun
 * @typedef {{ tag: string, commit: string, made: string, runs: string[], suites: Record<string, { status: string, fps: string[] }> }} Baseline
 */

// ---------------------------------------------------------------- fingerprints

/**
 * One failed check as a stable key: the line a suite printed for it, without what changes from run to
 * run — numbers (ms, px, counts, line:col), JSON details, absolute paths, colour codes. "dock resize
 * widens (320 → 440)" and "(318 → 437)" are the same check failing; "the Cut button could not be
 * clicked" and "the Cut button is disabled" are not.
 * @param {string} line
 */
function normalise(line) {
	return line
		.replace(/\x1b\[[0-9;]*m/g, '')
		.replace(/^\s*(✗|FAIL|not ok)\s*:?\s*/, '')
		.replace(/\{.*\}/g, '{…}')
		.replace(/(?:\/[\w.@+-]+)+\/([\w.@+-]+)/g, '$1')
		.replace(/0x[0-9a-f]+/gi, '#')
		.replace(/\d+(?:\.\d+)?/g, '#')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 200);
}

/**
 * The fingerprints of one suite's log: one per FAIL line, the SCRIPT FAILED message, a timeout, and —
 * when a red log names none of those (a crash before the first check) — its last line.
 * @param {string} suite @param {string} log @param {number|null} rc
 * @returns {string[]}
 */
function fingerprints(suite, log, rc) {
	if (rc === 0) return [];
	const out = new Set();
	for (const l of log.split('\n')) {
		if (/^\s*(?:✗|FAIL\b|not ok\b)/.test(l)) out.add(`${suite} :: ${normalise(l)}`);
		else if (/^\s*SCRIPT FAILED/.test(l)) out.add(`${suite} :: ${normalise(l)}`);
	}
	if (/\[battery\] TIMEOUT/.test(log)) out.add(`${suite} :: TIMEOUT`);
	if (!out.size) out.add(`${suite} :: rc=${rc} ${normalise((log.split('\n').filter((l) => l.trim()).pop() || '').slice(0, 200))}`);
	return [...out].sort();
}

// ---------------------------------------------------------------- the run

/** the desk set: every listed suite (skip is about public runners) and the modules flights @param {DeskBattery} b */
function deskEntries(b) {
	return /** @type {[string, number][]} */ ([...Object.entries(b.suites), ...Object.entries(b.modules || {}).map(([m, s]) => [`MOD:${m}`, s])]);
}

/** @param {DeskBattery} b @param {string} half @param {number} of */
function half(b, half, of) {
	const i = half.toUpperCase().charCodeAt(0) - 65;
	const shards = assign({ ...b, skip: {}, suites: Object.fromEntries(deskEntries(b)) }, of);
	if (!(i >= 0 && i < of)) throw new Error(`--half ${half}: there are ${of} halves (A..${String.fromCharCode(64 + of)})`);
	return shards[i].suites;
}

/**
 * the dev server answers. `vite --host localhost` may listen on ::1 only while node resolves localhost
 * to 127.0.0.1, so both loopbacks are asked (battery.cjs's reachable, with the request's own host header).
 * @param {string} url @returns {Promise<boolean>}
 */
async function reachable(url) {
	const u = new URL(url);
	/** @param {string} host @returns {Promise<boolean>} */
	const ask = (host) =>
		new Promise((resolve) => {
			const req = require('https').get({ host, port: u.port, path: u.pathname, headers: { host: u.host }, servername: u.hostname, rejectUnauthorized: false, timeout: 300000 }, (res) => {
				res.resume();
				res.on('end', () => resolve((res.statusCode || 0) < 500));
			});
			req.on('timeout', () => req.destroy());
			req.on('error', () => resolve(false));
		});
	if (u.hostname !== 'localhost') return ask(u.hostname);
	return (await ask('::1')) || (await ask('127.0.0.1'));
}

/**
 * One suite, the way battery.sh ran it: node in the tree, the caller's environment, the per-suite
 * cases the list names (desk.prod-host: APP_URL on the production hostname, which /etc/hosts maps
 * here; desk.peer-self: the self-hosted signaling box; MOD:x: the modules repo's runner, GPU ones
 * with E2E_GPU=1).
 * @param {DeskBattery} b @param {string} name @param {string} root @param {string} logFile
 * @returns {Promise<Attempt>}
 */
function attempt(b, name, root, logFile) {
	const env = { ...process.env };
	let cmd = ['node', path.join(root, 'tests', 'e2e', `${name}.test.cjs`)];
	let cwd = root;
	let limit = 1500;
	if (name.startsWith('MOD:')) {
		const m = name.slice(4);
		cwd = process.env.MOD_REPO || process.env.MODULES_REPO || '';
		cmd = ['node', 'tests/run.cjs', m];
		if (b.desk?.gpu?.includes(name)) env.E2E_GPU = '1';
		else limit = 1200;
	} else if (b.desk?.['prod-host']?.includes(name)) env.APP_URL = (env.APP_URL || '').replace('localhost', 'theprototype.app');
	else if (b.desk?.['peer-self']?.includes(name)) env.PEER_CONFIG = env.PEER_CONFIG_SELF || '';
	const fd = fs.openSync(logFile, 'w');
	const t0 = Date.now();
	return new Promise((resolve) => {
		const child = spawn(cmd[0], cmd.slice(1), { cwd: cwd || root, env, stdio: ['ignore', fd, fd], detached: true });
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-(child.pid || 0), 'SIGKILL');
			} catch {}
		}, limit * 1000);
		const done = (/** @type {number|null} */ code) => {
			clearTimeout(timer);
			fs.closeSync(fd);
			if (timedOut) fs.appendFileSync(logFile, `\n[battery] TIMEOUT after ${limit}s\n`);
			const text = fs.readFileSync(logFile, 'utf8');
			const rc = timedOut ? null : code;
			resolve({ rc, secs: Math.round((Date.now() - t0) / 1000), ...counts(text), fps: fingerprints(name, text, rc) });
		};
		child.on('exit', done);
		child.on('error', () => done(127));
	});
}

/** battery.sh's summary line, so the integrators' greps and `battery.cjs refresh --summary` still read it @param {string} name @param {Attempt} a */
function line(name, a) {
	return `${name} rc=${a.rc} pass~${a.pass} fail~${a.fail} ${a.secs}s :: ${a.last.slice(0, 140)}`;
}

/** @param {string} root */
function commitOf(root) {
	// a snapshot (rsync of a checkout, no .git) says what it is through the environment
	if (process.env.BATTERY_COMMIT) return process.env.BATTERY_COMMIT;
	try {
		return require('child_process').execFileSync('git', ['-C', root, 'describe', '--tags', '--always', '--dirty'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return '?';
	}
}

/** @param {object} row */
function logOutcome(row) {
	try {
		fs.mkdirSync(STATE, { recursive: true });
		fs.appendFileSync(path.join(STATE, 'outcomes.jsonl'), JSON.stringify(row) + '\n');
	} catch {}
}

/** @param {string[]} argv @param {string} flag */
function opt(argv, flag) {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
}

/** @param {string[]} argv */
async function run(argv) {
	const b = /** @type {DeskBattery} */ (load(opt(argv, '--battery')));
	const root = path.resolve(opt(argv, '--root') || ROOT);
	const of = Number(opt(argv, '--of') || 2);
	const h = opt(argv, '--half');
	const only = opt(argv, '--only');
	const list = opt(argv, '--list');
	const names = only ? only.split(',') : list ? fs.readFileSync(list, 'utf8').split(/\s+/).filter(Boolean) : h ? half(b, h, of) : deskEntries(b).map(([n]) => n);
	const name = opt(argv, '--name') || (h ? `half${h.toUpperCase()}` : 'run');
	const out = path.resolve(opt(argv, '--out') || process.env.BATTERY_OUT || path.join(root, 'test-results', 'battery'));
	const retry = !argv.includes('--no-retry');
	const url = process.env.APP_URL || '';
	fs.mkdirSync(path.join(out, 'logs'), { recursive: true });
	const sumFile = path.join(out, `${name}.txt`);
	const slot = process.env.E2E_SLOT_PC ? `pc:${process.env.E2E_SLOT_PC}` : process.env.E2E_SLOT_REMOTE ? 'remote' : process.env.E2E_SLOT ? 'local' : 'none';
	const commit = commitOf(root);
	const started = new Date().toISOString();
	const t0 = Date.now();
	fs.writeFileSync(sumFile, `snapshot: ${commit} root=${root} url=${url} slot=${slot} suites=${names.length}\n`);
	const say = (/** @type {string} */ s) => {
		console.log(s);
		fs.appendFileSync(sumFile, s + '\n');
	};
	/** @type {Map<string, DeskResult>} */
	const results = new Map();
	// the dev server's first SSR + client graph is the slow load; one warm-up so the first suite does not pay it
	if (url) await reachable(url);
	for (const n of names) {
		if (!n.startsWith('MOD:') && !fs.existsSync(path.join(root, 'tests', 'e2e', `${n}.test.cjs`))) {
			const a = { rc: null, secs: 0, pass: 0, fail: 0, last: 'no such suite in this tree', fps: [] };
			results.set(n, { name: n, status: 'gone', first: a, fps: [] });
			say(`${n} rc=gone :: no such suite in this tree`);
			continue;
		}
		// a dead dev server turns every later suite red for the wrong reason: wait for it, say so
		if (url && !n.startsWith('MOD:') && !(await reachable(url))) say(`[battery] dev server unreachable before ${n}`);
		const a = await attempt(b, n, root, path.join(out, 'logs', `${n.replace(':', '-')}.log`));
		results.set(n, { name: n, status: a.rc === 0 ? 'pass' : 'red', first: a, fps: a.fps });
		say(line(n, a));
		for (const f of a.fps) fs.appendFileSync(sumFile, `    ${f.split(' :: ')[1]}\n`);
	}
	const reds = [...results.values()].filter((r) => r.status === 'red');
	if (retry && reds.length) {
		say(`[battery] retry: ${reds.length} red suite(s) once more, at the end of the half`);
		for (const r of reds) {
			const a = await attempt(b, r.name, root, path.join(out, 'logs', `${r.name.replace(':', '-')}.retry.log`));
			r.retry = a;
			if (a.rc === 0) {
				r.status = 'flaky';
				r.fps = [];
			} else {
				// a check red in BOTH runs is the real one; checks red once are the moment's
				const both = r.first.fps.filter((f) => a.fps.includes(f));
				r.fps = both.length ? both : a.fps;
			}
			say(`retry ${line(r.name, a)}${a.rc === 0 ? ' -> FLAKY' : ''}`);
		}
	}
	for (const r of results.values()) {
		logOutcome({ t: started, commit, slot, suite: r.name, status: r.status, first: r.first.fps, retry: r.retry?.fps });
	}
	/** @type {DeskRun} */
	const rec = { name, root, commit, slot, started, secs: Math.round((Date.now() - t0) / 1000), results: [...results.values()] };
	fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(rec, null, 1));
	const all = [...results.values()];
	const n = (/** @type {string} */ s) => all.filter((r) => r.status === s).length;
	const redNames = all.filter((r) => r.status === 'red').map((r) => r.name);
	const summary = `BATTERY-DONE ${name} @${commit} ${slot}: ${all.length} suites, ${n('pass')} green, ${n('flaky')} flaky, ${redNames.length} red${redNames.length ? ` (${redNames.join(' ')})` : ''}, ${n('gone')} gone, ${Math.round(rec.secs / 60)} min -> ${path.join(out, name + '.json')}`;
	say(summary);
	fs.writeFileSync(path.join(out, `${name}.done`), summary + '\n');
	process.exit(redNames.length ? 1 : 0);
}

// ---------------------------------------------------------------- baselines and the diff

/** @param {string[]} dirs @returns {DeskRun[]} */
function readRuns(dirs) {
	/** @type {DeskRun[]} */
	const runs = [];
	for (const d of dirs) {
		const st = fs.statSync(d);
		const files = st.isDirectory() ? fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => path.join(d, f)) : [d];
		for (const f of files) {
			const j = JSON.parse(fs.readFileSync(f, 'utf8'));
			if (Array.isArray(j.results) && j.started) runs.push(j);
		}
	}
	return runs;
}

/** @param {string} tag @param {string[]} dirs */
function baselineSave(tag, dirs) {
	const runs = readRuns(dirs);
	if (!runs.length) throw new Error(`no desk runs (<name>.json) in ${dirs.join(' ')}`);
	/** @type {Baseline} */
	const bl = { tag, commit: runs[0].commit, made: new Date().toISOString(), runs: runs.map((r) => `${r.name} ${r.slot} ${r.started}`), suites: {} };
	for (const r of runs) {
		for (const s of r.results) {
			// a baseline remembers EVERY check it saw red, on either attempt: a flaky check on the tag is
			// a known one on the union too
			const fps = [...new Set([...s.first.fps, ...(s.retry?.fps || [])])].sort();
			bl.suites[s.name] = { status: s.status, fps };
		}
	}
	const dir = path.join(STATE, 'baselines');
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${tag}.json`);
	fs.writeFileSync(file, JSON.stringify(bl, null, 1));
	const by = (/** @type {string} */ s) => Object.values(bl.suites).filter((v) => v.status === s).length;
	console.log(`baseline ${tag} @${bl.commit}: ${Object.keys(bl.suites).length} suites (${by('pass')} green, ${by('flaky')} flaky, ${by('red')} red, ${by('gone')} gone) -> ${file}`);
}

/** the newest saved baseline, by file time, when the caller names none */
function latestBaseline() {
	const dir = path.join(STATE, 'baselines');
	const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
	files.sort((x, y) => fs.statSync(path.join(dir, y)).mtimeMs - fs.statSync(path.join(dir, x)).mtimeMs);
	return files[0] ? path.join(dir, files[0]) : '';
}

/**
 * @param {Baseline} bl @param {DeskRun[]} runs
 * @returns {{ green: string[], flaky: string[], known: string[], fresh: { name: string, fps: string[], why: string }[], gone: string[] }}
 */
function classify(bl, runs) {
	/** @type {ReturnType<typeof classify>} */
	const out = { green: [], flaky: [], known: [], fresh: [], gone: [] };
	for (const r of runs) {
		for (const s of r.results) {
			if (s.status === 'pass') out.green.push(s.name);
			else if (s.status === 'flaky') out.flaky.push(s.name);
			else if (s.status === 'gone') out.gone.push(s.name);
			else {
				const base = bl.suites[s.name];
				const unknown = s.fps.filter((f) => !base?.fps.includes(f));
				if (!unknown.length) out.known.push(s.name);
				else out.fresh.push({ name: s.name, fps: unknown, why: !base ? 'not in the baseline' : base.status === 'pass' ? 'green on the baseline' : 'a check the baseline did not fail' });
			}
		}
	}
	return out;
}

/** @param {string[]} argv */
function diff(argv) {
	const named = opt(argv, '--baseline');
	const file = !named ? latestBaseline() : named.endsWith('.json') ? named : path.join(STATE, 'baselines', `${named}.json`);
	if (!file || !fs.existsSync(file)) throw new Error(`no baseline ${named || '(none saved)'} — run the battery on the release tag and \`baseline save\` it`);
	const dirs = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--baseline');
	/** @type {Baseline} */
	const bl = JSON.parse(fs.readFileSync(file, 'utf8'));
	const c = classify(bl, readRuns(dirs));
	console.log(`vs baseline ${bl.tag} @${bl.commit}: ${c.green.length} green, ${c.flaky.length} flaky (green on the retry), ${c.known.length} pre-existing, ${c.fresh.length} NEW, ${c.gone.length} gone`);
	if (c.flaky.length) console.log(`  flaky: ${c.flaky.join(' ')}`);
	if (c.known.length) console.log(`  pre-existing (same checks red on ${bl.tag}; no A/B needed): ${c.known.join(' ')}`);
	for (const f of c.fresh) {
		console.log(`  NEW ${f.name} — ${f.why}`);
		for (const fp of f.fps) console.log(`      ${fp.split(' :: ')[1]}`);
	}
	process.exit(c.fresh.length ? 1 : 0);
}

/** @param {string[]} argv */
function flakes(argv) {
	const days = Number(opt(argv, '--days') || 30);
	const since = Date.now() - days * 86400e3;
	const file = path.join(STATE, 'outcomes.jsonl');
	/** @type {Record<string, { runs: number, flaky: number, red: number }>} */
	const per = {};
	const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
	for (const l of rows) {
		const r = JSON.parse(l);
		if (Date.parse(r.t) < since || r.status === 'gone') continue;
		const p = (per[r.suite] ||= { runs: 0, flaky: 0, red: 0 });
		p.runs++;
		if (r.status === 'flaky') p.flaky++;
		if (r.status === 'red') p.red++;
	}
	const list = Object.entries(per).filter(([, p]) => p.flaky).sort((x, y) => y[1].flaky / y[1].runs - x[1].flaky / x[1].runs || (x[0] < y[0] ? -1 : 1));
	const runs = Object.values(per).reduce((t, p) => t + p.runs, 0);
	const flaky = Object.values(per).reduce((t, p) => t + p.flaky, 0);
	console.log(`last ${days} days: ${runs} suite runs, ${flaky} flaky (${runs ? ((100 * flaky) / runs).toFixed(1) : 0} %), ${list.length} suites ever flaky`);
	for (const [n, p] of list) console.log(`  ${((100 * p.flaky) / p.runs).toFixed(0).padStart(3)} %  ${n}  (${p.flaky} of ${p.runs} runs flaky, ${p.red} red twice)`);
}

// ---------------------------------------------------------------- import (an old battery.sh run)

/**
 * A run of the integrators' old battery.sh (its summary lines + one <suite>.log each) as a desk run, so it can
 * be diffed against a baseline. battery.sh never retried, so a red stays red unless `--retry <summary>` names a
 * later rerun of the same suites (green there = flaky; red there = the checks red in both).
 * @param {string[]} argv
 */
function importRun(argv) {
	const logs = path.resolve(opt(argv, '--logs') || '.');
	const retryFile = opt(argv, '--retry');
	const summary = argv.filter((a, i) => !a.startsWith('--') && !['--logs', '--retry', '--name', '--out'].includes(argv[i - 1]))[0];
	if (!summary) throw new Error('import: name the summary file');
	const name = opt(argv, '--name') || path.basename(summary, '.txt');
	/** @param {string} file @param {string} dir */
	const parse = (file, dir) => {
		/** @type {Map<string, Attempt>} */
		const m = new Map();
		// battery.sh writes the run's own FAIL / SCRIPT FAILED lines indented under its row: those are the evidence.
		// A <suite>.log is read only when the row has none AND the log is not newer than the summary -- a later
		// rerun into the same folder overwrites the log (MEASURED: 51-int's r2-r7 rewrote half its u1 logs).
		const lines = fs.readFileSync(file, 'utf8').split('\n');
		const when = fs.statSync(file).mtimeMs;
		lines.forEach((l, i) => {
			const r = /^(\S+) rc=(\S+) pass~(\d+) fail~(\d+) (\d+)s :: ?(.*)$/.exec(l);
			if (!r) return;
			const rc = r[2] === 'gone' ? null : Number(r[2]);
			/** @type {string[]} */
			const under = [];
			for (let j = i + 1; j < lines.length && /^\s{4}\S/.test(lines[j]); j++) under.push(lines[j].trim());
			const logFile = path.join(dir, `${r[1].startsWith('MOD:') ? 'mod-' + r[1].slice(4) : r[1]}.log`);
			const fresh = fs.existsSync(logFile) && fs.statSync(logFile).mtimeMs <= when + 60000;
			const log = under.length ? under.join('\n') : fresh ? fs.readFileSync(logFile, 'utf8') : r[6];
			m.set(r[1], { rc, secs: Number(r[5]), pass: Number(r[3]), fail: Number(r[4]), last: r[6], fps: fingerprints(r[1], log, rc) });
		});
		return m;
	};
	const first = parse(summary, logs);
	const again = retryFile ? parse(retryFile, path.resolve(opt(argv, '--retry-logs') || path.dirname(retryFile))) : new Map();
	/** @type {DeskResult[]} */
	const results = [];
	for (const [n, a] of first) {
		const r = again.get(n);
		if (a.rc === 0) results.push({ name: n, status: 'pass', first: a, fps: [] });
		else if (r && r.rc === 0) results.push({ name: n, status: 'flaky', first: a, retry: r, fps: [] });
		else {
			const both = r ? a.fps.filter((f) => r.fps.includes(f)) : a.fps;
			results.push({ name: n, status: 'red', first: a, retry: r, fps: both.length ? both : r ? r.fps : a.fps });
		}
	}
	const out = path.resolve(opt(argv, '--out') || path.dirname(summary));
	/** @type {DeskRun} */
	const rec = { name, root: '', commit: (fs.readFileSync(summary, 'utf8').split('\n')[0] || '').replace(/^snapshot: /, ''), slot: 'imported', started: fs.statSync(summary).mtime.toISOString(), secs: 0, results };
	fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(rec, null, 1));
	console.log(`imported ${results.length} suites (${results.filter((r) => r.status === 'red').length} red, ${results.filter((r) => r.status === 'flaky').length} flaky) -> ${path.join(out, name + '.json')}`);
}

// ---------------------------------------------------------------- coverage

/**
 * Every tests/e2e/*.test.cjs is in the battery or excluded with a reason, and nothing listed is
 * missing. A suite nobody listed is a suite no release ever runs — the reason this check exists.
 * @param {DeskBattery} b @param {string[]} files suite names on disk
 */
function coverage(b, files) {
	const excluded = new Set(Object.values(b.exclude || {}).flat());
	const listed = new Set([...Object.keys(b.suites), ...excluded]);
	return {
		unlisted: files.filter((f) => !listed.has(f)),
		missing: [...listed].filter((n) => !files.includes(n)),
		both: Object.keys(b.suites).filter((n) => excluded.has(n))
	};
}

function e2eFiles(root = ROOT) {
	return fs
		.readdirSync(path.join(root, 'tests', 'e2e'))
		.filter((f) => f.endsWith('.test.cjs'))
		.map((f) => f.slice(0, -'.test.cjs'.length))
		.sort();
}

if (require.main === module) {
	const [cmd, ...argv] = process.argv.slice(2);
	try {
		if (cmd === 'run') run(argv);
		else if (cmd === 'baseline' && argv[0] === 'save' && argv[1]) baselineSave(argv[1], argv.slice(2));
		else if (cmd === 'diff') diff(argv);
		else if (cmd === 'flakes') flakes(argv);
		else if (cmd === 'import') importRun(argv);
		else if (cmd === 'coverage') {
			const c = coverage(/** @type {DeskBattery} */ (load()), e2eFiles());
			for (const n of c.unlisted) console.log(`unlisted: ${n} — add it to tests/e2e/battery.json suites, or to exclude with a reason`);
			// listed-but-absent is information, not a failure: a feat branch carries the list of a
			// release whose suites have not merged into it yet, and both runners report them as gone
			for (const n of c.missing) console.log(`(listed, no file here: ${n})`);
			for (const n of c.both) console.log(`both: ${n} is a suite AND excluded`);
			process.exit(c.unlisted.length + c.both.length ? 1 : 0);
		} else {
			console.error('usage: battery-desk.cjs run --half A|B [--of N] [--only a,b] [--list f] [--out d] [--name n] [--root tree] [--no-retry]\n' + '       | baseline save <tag> <out-dir>... | diff [--baseline tag|file] <out-dir>... | flakes [--days N] | coverage\n' +
					'       | import <battery.sh summary.txt> --logs <dir> [--retry <summary.txt> [--retry-logs dir]] [--name n] [--out dir]');
			process.exit(2);
		}
	} catch (e) {
		console.error(`battery-desk: ${/** @type {Error} */ (e).message}`);
		process.exit(2);
	}
}

module.exports = { normalise, fingerprints, classify, coverage, e2eFiles, deskEntries, half };
