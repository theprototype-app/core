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
//   node scripts/ci/battery-desk.cjs queue --workers 4 --port 5600 --out dir --name u1 [--resume] [--slot prefix] [--local-workers M]
//   node scripts/ci/battery-desk.cjs baseline save <tag> <out-dir>...      # record a tag's runs
//   node scripts/ci/battery-desk.cjs diff [--baseline tag|file] <out-dir>...  # exit 1 when anything is NEW
//   node scripts/ci/battery-desk.cjs flakes [--days 30]                    # flake rate per suite
//   node scripts/ci/battery-desk.cjs coverage                              # every e2e file listed or excluded
//   node scripts/ci/battery-desk.cjs import u1A.txt --logs e2e/ [--retry r2.txt]  # an old battery.sh run, for diff
//
// THE QUEUE (`queue`). Fixed halves finish when their slowest half does: one slot idles while the other works
// through hours of suites, and a lost slot loses its whole half. In a queue run one process here holds the list,
// longest suite first, and N workers -- each on its own slot, its own tree and its own dev server, any kind of
// slot on any machine -- pull the next suite over HTTP and send each result back the moment it ends. So:
//  - no slot idles while a suite waits, and the long suites never pile up at the end;
//  - nothing is lost with a slot: its one running suite goes back in the list, a new worker takes the slot's
//    place, and every finished suite is already here;
//  - --resume after an interrupted run skips what was already green FOR THE SAME TREE (a hash of its files);
//  - <name>.json / .txt / .done / logs/ are what `run` writes, so `diff` and `baseline save` read it unchanged.
//    An interrupted run writes <name>.partial instead of <name>.json, so `diff` can never read half a battery.
// --slot is the command prefix that books a slot, with {dir} and {port} (default below; '' = no booking, one
// local worker per process). Retries run once the list is empty, on another worker than the first attempt's.
// Suites in desk.local (they need this machine's own GPU: real WebGPU, a measured frame rate) only go to workers on
// this machine's own slots: --local-workers M (default 1 when the run has any, 0 = they run like the others) with
// --local-slot (default below). Such a worker gives its slot back when its suites are done.
// On pc and remote slots a queue run renders on the machine's GPU (E2E_GPU_ALL, default on here), except desk.software.
//
// TIERS (battery-tiers, owner decision 2026-10-26: tier 1 -> release -> tier 2):
//   E2E_COVERAGE=1 node scripts/ci/battery-desk.cjs run --half A ...       # + <out>/coverage/<suite>.json per suite
//   node scripts/ci/battery-desk.cjs map build <out-A> <out-B>             # -> tests/e2e/coverage-map.json (committed)
//   node scripts/ci/battery-desk.cjs tiers --base v1.44.0 [--also a,b]     # tier 1 / tier 2 counts + suite-minutes
//   node scripts/ci/battery-desk.cjs run --tier 1 --base v1.44.0 --half A  # gates the release; --tier 2 after the tag
//   node scripts/ci/battery-desk.cjs record --version 1.45.0 --base v1.44.0 --tier1 dA,dB  # $BATTERY_STATE/releases.jsonl
//   node scripts/ci/battery-desk.cjs record --check                        # the next union's gate: tier 2 classified?
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
 * @typedef {import('./battery.cjs').Battery & { modules?: Record<string, number>, desk?: { 'prod-host'?: string[], 'peer-self'?: string[], gpu?: string[], software?: string[], local?: string[] },
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

/** @param {DeskBattery} b @param {string} half @param {number} of @param {string[]} [subset] split only these (a tier) */
function half(b, half, of, subset) {
	const i = half.toUpperCase().charCodeAt(0) - 65;
	const entries = subset ? deskEntries(b).filter(([n]) => subset.includes(n)) : deskEntries(b);
	// the desk runs every suite the same way: `optional` is a GitHub-runner property, so it is not a set here
	const shards = assign({ ...b, skip: {}, optional: {}, suites: Object.fromEntries(entries) }, of);
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
 * The suite running now. It has its own process group (a timeout kills its browser with it), so a signal to
 * this process does not reach it: a worker stopped by its slot passes the signal on, or the suite and its
 * browser would run on with the slot already given to someone else.
 * @type {import('child_process').ChildProcess | null}
 */
let running = null;

/**
 * One suite, the way battery.sh ran it: node in the tree, the caller's environment, the per-suite
 * cases the list names (desk.prod-host: APP_URL on the production hostname, which /etc/hosts maps
 * here; desk.peer-self: the self-hosted signaling box; desk.software: stays on software GL where
 * a slot gives other suites the GPU; MOD:x: the modules repo's runner, GPU ones with E2E_GPU=1).
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
	if (b.desk?.software?.includes(name)) env.PW_GPU_ALL = '0';
	const fd = fs.openSync(logFile, 'w');
	const t0 = Date.now();
	return new Promise((resolve) => {
		const child = spawn(cmd[0], cmd.slice(1), { cwd: cwd || root, env, stdio: ['ignore', fd, fd], detached: true });
		running = child;
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-(child.pid || 0), 'SIGKILL');
			} catch {}
		}, limit * 1000);
		const done = (/** @type {number|null} */ code) => {
			clearTimeout(timer);
			running = null;
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

/**
 * The suites a command line names: --only, --list, or the tier/whole battery (`split` takes a half of it).
 * @param {DeskBattery} b @param {string[]} argv @param {((subset?: string[]) => string[])|null} split
 */
function pickSuites(b, argv, split) {
	const only = opt(argv, '--only');
	const list = opt(argv, '--list');
	// --tier 1|2 --base <previous tag>: the tier's suites (battery-tiers), from git here or from a `tiers --save` file
	// (--selection: a snapshot or a pc slot has no .git); --half splits the tier the way it splits the battery
	const tier = opt(argv, '--tier');
	const selFile = opt(argv, '--selection');
	const sel = tier ? (selFile ? JSON.parse(fs.readFileSync(selFile, 'utf8')) : tiersOf(argv)) : null;
	const tierNames = sel ? /** @type {Pick[]} */ (tier === '2' ? sel.tier2 : sel.tier1).map((p) => p.name) : null;
	const names = only
		? only.split(',')
		: list
			? fs.readFileSync(list, 'utf8').split(/\s+/).filter(Boolean)
			: split
				? split(tierNames || undefined)
				: tierNames || deskEntries(b).map(([n]) => n);
	return { names, sel };
}

/** @param {string[]} argv */
async function run(argv) {
	const b = /** @type {DeskBattery} */ (load(opt(argv, '--battery')));
	const root = path.resolve(opt(argv, '--root') || ROOT);
	const of = Number(opt(argv, '--of') || 2);
	const h = opt(argv, '--half');
	const tier = opt(argv, '--tier');
	const { names, sel } = pickSuites(b, argv, h ? (subset) => half(b, h, of, subset) : null);
	const name = opt(argv, '--name') || `${tier ? `t${tier}` : h ? 'half' : 'run'}${h ? h.toUpperCase() : ''}`;
	const out = path.resolve(opt(argv, '--out') || process.env.BATTERY_OUT || path.join(root, 'test-results', 'battery'));
	if (sel) {
		fs.mkdirSync(out, { recursive: true });
		fs.writeFileSync(path.join(out, `${name}.tiers.json`), JSON.stringify(sel, null, 1));
	}
	const retry = !argv.includes('--no-retry');
	const url = process.env.APP_URL || '';
	fs.mkdirSync(path.join(out, 'logs'), { recursive: true });
	// E2E_COVERAGE=1: every suite writes the app files it ran to <out>/coverage/<suite>.json (helpers.cjs), the input of `map build`
	if (process.env.E2E_COVERAGE === '1') process.env.E2E_COVERAGE_OUT ||= path.join(out, 'coverage');
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
	// a tier run says at once what is NEW against the base tag's baseline (tier 2 runs detached: this line is its report)
	const blFile = sel ? path.join(STATE, 'baselines', `${sel.base}.json`) : '';
	const fresh = blFile && fs.existsSync(blFile) ? classify(JSON.parse(fs.readFileSync(blFile, 'utf8')), [rec]).fresh.map((f) => f.name) : null;
	const vs = sel ? ` · tier ${tier} vs ${sel.base}: ${fresh ? `${fresh.length} NEW${fresh.length ? ` (${fresh.join(' ')})` : ''}` : 'no baseline saved here'}` : '';
	const summary = `BATTERY-DONE ${name} @${commit} ${slot}: ${all.length} suites, ${n('pass')} green, ${n('flaky')} flaky, ${redNames.length} red${redNames.length ? ` (${redNames.join(' ')})` : ''}, ${n('gone')} gone, ${Math.round(rec.secs / 60)} min${vs} -> ${path.join(out, name + '.json')}`;
	say(summary);
	fs.writeFileSync(path.join(out, `${name}.done`), summary + '\n');
	process.exit(redNames.length ? 1 : 0);
}

// ---------------------------------------------------------------- the queue

/**
 * What the list says at any moment. No clock, no I/O: `queue` drives it, and the tests drive it directly.
 * A suite's worker lost mid-suite: back in the list, front first (it already waited its turn); lost twice it
 * counts as red, because a suite that takes its worker down every time must not take them all.
 * @param {string[]} names longest first
 * @param {Map<string, DeskResult>} [done] green results of an interrupted run
 * @param {boolean} [retry] a red gets its second attempt
 * @param {Set<string>} [here] suites only this machine's own workers may run (desk.local)
 */
function makeQueue(names, done = new Map(), retry = true, here = new Set()) {
	const todo = names.filter((n) => !done.has(n));
	const results = new Map(done);
	/** @type {Map<string, { name: string, kind: 'first'|'retry', since: number }>} */
	const busy = new Map();
	/** @type {Map<string, number>} */
	const lost = new Map();
	/** @type {string[]} reds waiting for their second attempt */
	const again = [];
	/** @type {Map<string, string>} */
	const firstOn = new Map();
	/** @type {Set<string>} */
	const alive = new Set();
	/** @type {Set<string>} workers on this machine's own slots */
	const ownWorkers = new Set();
	/** @param {string} name @param {string} worker */
	const take = (name, worker, /** @type {'first'|'retry'} */ kind, /** @type {number} */ now) => {
		busy.set(worker, { name, kind, since: now });
		return { name, kind };
	};
	return {
		results,
		busy,
		/** @param {string} w */ hello(w) {
			alive.add(w);
		},
		/** @param {string} worker @param {number} [now] @param {boolean} [own] on this machine's own slot @returns {{ name: string, kind: 'first'|'retry' } | { wait: true } | { done: true }} */
		claim(worker, now = 0, own = false) {
			alive.add(worker);
			if (own) ownWorkers.add(worker);
			const mine = (/** @type {string} */ n) => here.has(n) === own;
			// a worker asking again has nothing running: what it held is not coming back
			if (busy.has(worker)) this.gone(worker);
			alive.add(worker);
			const at = todo.findIndex(mine);
			if (at >= 0) return take(todo.splice(at, 1)[0], worker, 'first', now);
			// retries only once no first attempt is left to run, and on another worker than the first attempt's
			// while there is one: a red from one server or one slot should meet a different one
			const others = [...alive].some((w) => w !== worker && ownWorkers.has(w) === own);
			const i = again.findIndex((n) => mine(n) && (!others || firstOn.get(n) !== worker));
			if (i >= 0) return take(again.splice(i, 1)[0], worker, 'retry', now);
			// nothing left that this worker may run: it gives its slot back, whatever the other kind still has to do
			return !todo.some(mine) && !again.some(mine) && ![...busy.values()].some((v) => mine(v.name)) ? { done: true } : { wait: true };
		},
		/** @param {string} worker @param {string} name @param {'first'|'retry'} kind @param {Attempt} a */
		report(worker, name, kind, a) {
			if (busy.get(worker)?.name === name) busy.delete(worker);
			const had = results.get(name);
			if (kind === 'first') {
				if (had) return null; // a late answer for a suite already run elsewhere
				/** @type {DeskResult} */
				const r = { name, status: a.rc === 0 ? 'pass' : 'red', first: a, fps: a.fps };
				results.set(name, r);
				if (r.status === 'red' && retry) {
					firstOn.set(name, worker);
					again.push(name);
				}
				return r;
			}
			if (!had || had.retry) return null;
			had.retry = a;
			if (a.rc === 0) {
				had.status = 'flaky';
				had.fps = [];
			} else {
				const both = had.first.fps.filter((f) => a.fps.includes(f));
				had.fps = both.length ? both : a.fps;
			}
			return had;
		},
		/** a worker is gone: what it held goes back @param {string} worker */
		gone(worker) {
			alive.delete(worker);
			const b = busy.get(worker);
			if (!b) return null;
			busy.delete(worker);
			const times = (lost.get(b.name) || 0) + 1;
			lost.set(b.name, times);
			if (times >= 2) {
				const a = { rc: null, secs: 0, pass: 0, fail: 0, last: 'its worker was lost twice', fps: [`${b.name} :: worker lost`] };
				if (b.kind === 'retry') this.report(worker, b.name, 'retry', a);
				else {
					// not run a third time, not even as a retry
					results.delete(b.name);
					results.set(b.name, { name: b.name, status: 'red', first: a, fps: a.fps });
				}
				return { name: b.name, requeued: false };
			}
			if (b.kind === 'first') todo.unshift(b.name);
			else again.unshift(b.name);
			return { name: b.name, requeued: true };
		},
		/** every suite is settled @returns {boolean} */
		finished() {
			return !todo.length && !again.length && !busy.size;
		},
		left() {
			return todo.length + again.length + busy.size;
		}
	};
}

/** names longest first, by the times in the list; an unknown suite counts as a long one @param {DeskBattery} b @param {string[]} names */
function longestFirst(b, names) {
	/** @type {Record<string, number>} */
	const secs = Object.fromEntries(deskEntries(b));
	return [...names].sort((x, y) => (secs[y] ?? 300) - (secs[x] ?? 300) || (x < y ? -1 : 1));
}

// what is not the tree's own: installs, builds, outputs, this tool's markers. .git is not there in a snapshot or a mirror.
const NOT_THE_TREE = new Set(['node_modules', '.git', '.svelte-kit', 'build', 'test-results', 'coverage', '.vite', '.muxtopus-mirror', '.snap']);

// written by the dev server's own start, so a tree that has served differs from one that has not
const GENERATED = new Set(['static/version.json', 'static/third-party-notices.html', 'static/third-party-notices.json']);

/** A hash of a tree's files, the same in a checkout, a snapshot and a mirror of either. @param {string} root */
function treeId(root) {
	const hash = require('crypto').createHash('sha256');
	/** @param {string} dir @param {string} rel */
	const walk = (dir, rel) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
			if (NOT_THE_TREE.has(e.name)) continue;
			const r = rel ? `${rel}/${e.name}` : e.name;
			const full = path.join(dir, e.name);
			if (GENERATED.has(r)) continue;
			if (e.isDirectory()) walk(full, r);
			else if (e.isFile()) hash.update(r + '\0').update(fs.readFileSync(full)).update('\0');
		}
	};
	walk(root, '');
	return hash.digest('hex').slice(0, 16);
}

/** A worker's own copy of the tree: hard links (no disk, under a minute), minus outputs and vite's cache. @param {string} from @param {string} to */
function linkTree(from, to) {
	fs.rmSync(to, { recursive: true, force: true });
	/** @param {string} a @param {string} b @param {boolean} top */
	const walk = (a, b, top) => {
		fs.mkdirSync(b, { recursive: true });
		for (const e of fs.readdirSync(a, { withFileTypes: true })) {
			if ((top && ['.svelte-kit', 'test-results', '.git'].includes(e.name)) || e.name === '.vite') continue;
			const x = path.join(a, e.name);
			const y = path.join(b, e.name);
			if (e.isDirectory()) walk(x, y, false);
			else if (e.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(x), y);
			else if (e.isFile()) fs.linkSync(x, y);
		}
	};
	walk(from, to, true);
}

/** The finished, green part of an interrupted run on this tree. @param {string} file @param {string} tree @returns {{ green: Map<string, DeskResult>, other: string|null }} */
function resumeFrom(file, tree) {
	/** @type {Map<string, DeskResult>} */
	const all = new Map();
	const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
	let other = null;
	for (const l of rows) {
		let r;
		try {
			r = JSON.parse(l);
		} catch {
			continue; // the line the interruption cut short
		}
		if (r.tree !== tree) {
			other = r.tree;
			continue;
		}
		if (r.kind === 'first') all.set(r.name, { name: r.name, status: r.attempt.rc === 0 ? 'pass' : 'red', first: r.attempt, fps: r.attempt.fps });
		else {
			const had = all.get(r.name);
			if (had) {
				had.retry = r.attempt;
				if (r.attempt.rc === 0) {
					had.status = 'flaky';
					had.fps = [];
				}
			}
		}
	}
	return { green: new Map([...all].filter(([, r]) => r.status === 'pass' || r.status === 'flaky')), other };
}

/** the address the workers reach this machine on (BATTERY_QUEUE_HOST beats it) */
function ownAddress() {
	if (process.env.BATTERY_QUEUE_HOST) return process.env.BATTERY_QUEUE_HOST;
	for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal && !/^(172\.1[6-9]|172\.2\d|172\.3[01])\./.test(i.address)) return i.address;
	return '127.0.0.1';
}

const DEFAULT_SLOT = 'e2e-slot --pc-first 1800 --wait 36000 --dev {dir} {port} --';
const DEFAULT_LOCAL_SLOT = 'e2e-slot --local --wait 36000 --dev {dir} {port} --';
const RESPAWNS = 3;
const RESPAWN_S = Number(process.env.BATTERY_QUEUE_RESPAWN_S || 30);
const LEASE_MS = 1700 * 1000; // past the longest suite limit: a worker this quiet is not coming back

/** @param {string[]} argv */
async function queueCmd(argv) {
	const b = /** @type {DeskBattery} */ (load(opt(argv, '--battery')));
	const root = path.resolve(opt(argv, '--root') || ROOT);
	const nWorkers = Number(opt(argv, '--workers') || 2);
	const firstPort = Number(opt(argv, '--port') || 5600);
	const slotCmd = opt(argv, '--slot') ?? process.env.BATTERY_SLOT_CMD ?? DEFAULT_SLOT;
	const tier = opt(argv, '--tier');
	const { names: picked, sel } = pickSuites(b, argv, null);
	const name = opt(argv, '--name') || (tier ? `t${tier}` : 'queue');
	const out = path.resolve(opt(argv, '--out') || process.env.BATTERY_OUT || path.join(root, 'test-results', 'battery'));
	fs.mkdirSync(path.join(out, 'logs'), { recursive: true });
	if (sel) fs.writeFileSync(path.join(out, `${name}.tiers.json`), JSON.stringify(sel, null, 1));
	const retry = !argv.includes('--no-retry');
	// a suite's coverage file is written where the suite runs, which here is another tree and maybe another machine
	if (process.env.E2E_COVERAGE === '1') throw new Error('E2E_COVERAGE=1 needs `run`: a queue run cannot collect the files');
	// by run name: two runs of one tree must not share (or remove) each other's worker trees
	const workerTree = (/** @type {number} */ i) => `${root}-${name}-w${i}`;
	const tree = treeId(root);
	const journal = path.join(out, `${name}.journal.jsonl`);
	const sumFile = path.join(out, `${name}.txt`);
	const commit = commitOf(root);
	const started = new Date().toISOString();
	const t0 = Date.now();
	const resuming = argv.includes('--resume');
	const { green, other } = resuming ? resumeFrom(journal, tree) : { green: new Map(), other: null };
	if (!resuming) fs.writeFileSync(journal, '');
	fs.writeFileSync(sumFile, `snapshot: ${commit} tree=${tree} root=${root} slot=queue workers=${nWorkers} suites=${picked.length}\n`, { flag: resuming ? 'a' : 'w' });
	const say = (/** @type {string} */ s) => {
		console.log(s);
		fs.appendFileSync(sumFile, s + '\n');
	};
	if (other) say(`[battery] the journal also holds a run of another tree (${other}): not skipping its suites`);
	if (resuming) say(`[battery] resume: ${green.size} suite(s) already green on tree ${tree}`);

	// suites with no file here settle at once, as `run` does
	const absent = picked.filter((n) => !n.startsWith('MOD:') && !fs.existsSync(path.join(root, 'tests', 'e2e', `${n}.test.cjs`)));
	for (const n of absent) {
		green.set(n, { name: n, status: 'gone', first: { rc: null, secs: 0, pass: 0, fail: 0, last: 'no such suite in this tree', fps: [] }, fps: [] });
		say(`${n} rc=gone :: no such suite in this tree`);
	}
	const ownSuites = new Set(picked.filter((n) => b.desk?.local?.includes(n)));
	const ownWorkers = slotCmd.trim() ? Number(opt(argv, '--local-workers') ?? (ownSuites.size ? 1 : 0)) : 0;
	const ownSlot = opt(argv, '--local-slot') ?? process.env.BATTERY_LOCAL_SLOT_CMD ?? DEFAULT_LOCAL_SLOT;
	const q = makeQueue(longestFirst(b, picked), green, retry, ownWorkers ? ownSuites : new Set());
	const token = require('crypto').randomBytes(12).toString('hex');
	/** @type {Record<string, string>} worker -> what its slot is */
	const slots = {};
	/** @type {Map<string, number>} */
	const lastHeard = new Map();
	let stop = /** @type {(() => void) | null} */ (null);
	const ended = new Promise((/** @type {(v?: unknown) => void} */ resolve) => (stop = resolve));
	const settle = () => {
		if (q.finished()) stop?.();
	};
	const http = require('http');
	const server = http.createServer((req, res) => {
		/** @type {Buffer[]} */
		const chunks = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			const send = (/** @type {unknown} */ o, code = 200) => {
				res.writeHead(code, { 'content-type': 'application/json' });
				res.end(JSON.stringify(o));
			};
			if (!(req.url || '').startsWith(`/${token}/`)) return send({ error: 'no' }, 403);
			let m;
			try {
				m = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
			} catch {
				return send({ error: 'bad json' }, 400);
			}
			const what = (req.url || '').slice(token.length + 2);
			lastHeard.set(m.worker, Date.now());
			if (what === 'hello') {
				q.hello(m.worker);
				slots[m.worker] = m.slot;
				say(`[battery] worker ${m.worker} on ${m.slot}${m.tree === tree ? '' : ` — ITS TREE DIFFERS (${m.tree}, this run is ${tree})`}`);
				return send({ tree });
			}
			if (what === 'claim') {
				const c = q.claim(m.worker, Date.now(), !!m.own);
				settle();
				return send(c);
			}
			if (what === 'report') {
				if (!picked.includes(m.name)) return send({ error: 'not on the list' }, 400);
				const kind = m.kind === 'retry' ? 'retry' : 'first';
				/** @type {Attempt} */
				const a = m.attempt;
				fs.writeFileSync(path.join(out, 'logs', `${m.name.replace(':', '-')}${kind === 'retry' ? '.retry' : ''}.log`), m.log || '');
				const r = q.report(m.worker, m.name, kind, a);
				if (r) {
					fs.appendFileSync(journal, JSON.stringify({ t: new Date().toISOString(), tree, commit, name: m.name, kind, worker: m.worker, slot: slots[m.worker], attempt: a }) + '\n');
					if (kind === 'retry') say(`retry ${line(m.name, a)}${a.rc === 0 ? ' -> FLAKY' : ''}`);
					else {
						say(line(m.name, a));
						for (const f of a.fps) fs.appendFileSync(sumFile, `    ${f.split(' :: ')[1]}\n`);
					}
				}
				settle();
				return send({ ok: true });
			}
			return send({ error: 'what' }, 404);
		});
	});
	server.requestTimeout = 0;
	await new Promise((resolve) => server.listen(Number(opt(argv, '--queue-port') || 0), '0.0.0.0', () => resolve(undefined)));
	const addr = /** @type {import('net').AddressInfo} */ (server.address());
	const base = `http://${ownAddress()}:${addr.port}/${token}`;

	/** @type {Map<number, import('child_process').ChildProcess>} */
	const kids = new Map();
	let finishing = false;
	let respawning = 0;
	/** @param {number} i @param {number} tries */
	const start = (i, tries) => {
		const dir = workerTree(i);
		const port = firstPort + i - 1;
		const worker = `w${i}`;
		const log = fs.openSync(path.join(out, `${name}.worker-${i}.log`), 'a');
		const own = i > nWorkers;
		const prefix = (own ? ownSlot : slotCmd).split(/\s+/).filter(Boolean).map((t) => t.replace('{dir}', dir).replace('{port}', String(port)));
		const cmd = [...prefix, 'node', path.join(dir, 'scripts', 'ci', 'battery-desk.cjs'), 'queue-worker', '--queue', base, '--id', worker, '--root', dir, ...(own ? ['--own'] : [])];
		/** @type {NodeJS.ProcessEnv} */
		const env = { ...process.env, APP_URL: (process.env.APP_URL || '').replace(/:\d+\//, `:${port}/`), BATTERY_COMMIT: commit };
		if (own) Object.assign(env, { E2E_PC: '', E2E_REMOTE: '' });
		// the queue knows desk.software, so it asks for the GPU on pc and remote slots (E2E_GPU_ALL=off in the caller's environment says no)
		else env.E2E_GPU_ALL = process.env.E2E_GPU_ALL || 'on';
		const kid = spawn(cmd[0], cmd.slice(1), { cwd: dir, env, stdio: ['ignore', log, log], detached: true });
		kids.set(i, kid);
		const gone = (/** @type {number|null} */ code) => {
			fs.closeSync(log);
			kids.delete(i);
			if (finishing) return;
			const back = q.gone(worker);
			if (back) say(`[battery] worker ${worker} gone (rc=${code}) while running ${back.name}: ${back.requeued ? 'back in the list' : 'lost twice, counted red'}`);
			settle();
			if (q.finished()) return;
			if (code === 0) {
				// told it was done: the other kind of worker still has suites, this one has none to run
				if (!kids.size && !respawning) stop?.();
				return;
			}
			if (tries < RESPAWNS) {
				say(`[battery] worker ${worker} ended rc=${code} with ${q.left()} suite(s) left: a new one in ${RESPAWN_S} s`);
				respawning++;
				setTimeout(() => {
					respawning--;
					if (!finishing) start(i, tries + 1);
				}, RESPAWN_S * 1000);
			} else {
				say(`[battery] worker ${worker} ended rc=${code}, ${RESPAWNS} times over: not starting it again`);
				if (!kids.size && !respawning) stop?.();
			}
		};
		kid.on('exit', gone);
		kid.on('error', () => gone(127));
	};
	const lease = setInterval(() => {
		for (const [w, b2] of q.busy) {
			if (Date.now() - (lastHeard.get(w) || b2.since) > LEASE_MS) {
				const back = q.gone(w);
				if (back) say(`[battery] worker ${w} silent for ${LEASE_MS / 60000} min on ${back.name}: back in the list`);
				settle();
			}
		}
	}, 30000);
	const stopAll = () => {
		for (const k of kids.values()) {
			try {
				process.kill(-(k.pid || 0), 'SIGTERM');
			} catch {}
		}
	};
	for (const sig of /** @type {NodeJS.Signals[]} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
		process.on(sig, () => {
			finishing = true;
			stopAll();
			process.exit(130);
		});
	}
	if (!q.finished()) {
		for (let i = 1; i <= nWorkers + ownWorkers; i++) {
			linkTree(root, workerTree(i));
			start(i, 0);
		}
		await ended;
	}
	finishing = true;
	clearInterval(lease);
	stopAll();
	server.close();
	// a pc slot copies its files back as it ends: the trees go only after that (not forever: a stuck ssh must not hold the summary)
	for (let i = 0; kids.size && i < 240; i++) await new Promise((res) => setTimeout(res, 500));

	const all = longestFirst(b, picked).map((n) => q.results.get(n)).filter((r) => !!r);
	const complete = q.finished();
	if (complete) for (const r of all) logOutcome({ t: started, commit, slot: 'queue', suite: r.name, status: r.status, first: r.first.fps, retry: r.retry?.fps });
	const slotList = [...new Set(Object.values(slots))].join(',') || '-';
	/** @type {DeskRun} */
	const rec = { name, root, commit, slot: `queue:${slotList}`, started, secs: Math.round((Date.now() - t0) / 1000), results: all };
	if (!argv.includes('--keep-trees')) for (let i = 1; i <= nWorkers + ownWorkers; i++) fs.rmSync(workerTree(i), { recursive: true, force: true });
	if (!complete) fs.writeFileSync(path.join(out, `${name}.partial`), JSON.stringify(rec, null, 1));
	else {
		fs.rmSync(path.join(out, `${name}.partial`), { force: true });
		fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(rec, null, 1));
	}
	const n = (/** @type {string} */ s) => all.filter((r) => r.status === s).length;
	const reds = all.filter((r) => r.status === 'red').map((r) => r.name);
	const blFile = sel ? path.join(STATE, 'baselines', `${sel.base}.json`) : '';
	const fresh = complete && blFile && fs.existsSync(blFile) ? classify(JSON.parse(fs.readFileSync(blFile, 'utf8')), [rec]).fresh.map((f) => f.name) : null;
	const vs = sel ? ` · tier ${tier} vs ${sel.base}: ${fresh ? `${fresh.length} NEW${fresh.length ? ` (${fresh.join(' ')})` : ''}` : 'no baseline saved here'}` : '';
	const head = complete ? 'BATTERY-DONE' : `BATTERY-INCOMPLETE (${q.left()} left; the same command with --resume goes on)`;
	const summary = `${head} ${name} @${commit} queue x${nWorkers} (${slotList}): ${all.length} suites, ${n('pass')} green, ${n('flaky')} flaky, ${reds.length} red${reds.length ? ` (${reds.join(' ')})` : ''}, ${n('gone')} gone, ${Math.round(rec.secs / 60)} min${vs} -> ${path.join(out, `${name}.${complete ? 'json' : 'partial'}`)}`;
	say(summary);
	fs.writeFileSync(path.join(out, `${name}.done`), summary + '\n');
	process.exit(!complete ? 2 : reds.length ? 1 : 0);
}

/** One worker, on its slot: asks for a suite, runs it, sends the result and the log back. @param {string[]} argv */
async function queueWorker(argv) {
	const b = /** @type {DeskBattery} */ (load(opt(argv, '--battery')));
	const base = opt(argv, '--queue') || '';
	const worker = opt(argv, '--id') || `w${process.pid}`;
	const own = argv.includes('--own');
	const root = path.resolve(opt(argv, '--root') || ROOT);
	const url = process.env.APP_URL || '';
	// the machine as well: a whole-run slot on another host reads as `local` from inside (its own slot lock there)
	const kind = process.env.E2E_SLOT_PC ? `pc:${process.env.E2E_SLOT_PC}` : process.env.E2E_SLOT_REMOTE ? 'remote' : process.env.E2E_SLOT ? 'local' : 'none';
	const slot = `${kind}@${os.hostname()}`;
	const logs = path.join(root, 'test-results', 'queue-worker');
	fs.mkdirSync(logs, { recursive: true });
	for (const sig of /** @type {NodeJS.Signals[]} */ (['SIGTERM', 'SIGINT', 'SIGHUP'])) {
		process.on(sig, () => {
			try {
				if (running) process.kill(-(running.pid || 0), 'SIGKILL');
			} catch {}
			process.exit(143);
		});
	}
	/** a POST that survives a blip of the network: the list is on another machine @param {string} what @param {object} body */
	const post = async (what, body) => {
		for (let i = 0; ; i++) {
			try {
				const r = await fetch(`${base}/${what}`, { method: 'POST', body: JSON.stringify({ worker, ...body }) });
				return await r.json();
			} catch (e) {
				if (i >= 40) throw e;
				await new Promise((res) => setTimeout(res, 15000));
			}
		}
	};
	await post('hello', { slot, tree: treeId(root) });
	if (url) await reachable(url); // the first SSR + client graph is the slow load: not on the first suite's clock
	for (;;) {
		// BEFORE asking: a dead server is this worker's trouble, and a suite it had claimed would be charged with it
		if (url && !(await reachable(url))) {
			console.error(`[battery] worker ${worker}: dev server unreachable`);
			process.exit(4);
		}
		const c = await post('claim', { own });
		if (c.done) process.exit(0);
		if (c.wait) {
			await new Promise((res) => setTimeout(res, 5000));
			continue;
		}
		const n = c.name;
		const logFile = path.join(logs, `${n.replace(':', '-')}${c.kind === 'retry' ? '.retry' : ''}.log`);
		const a = await attempt(b, n, root, logFile);
		await post('report', { name: n, kind: c.kind, attempt: a, log: fs.readFileSync(logFile, 'utf8') });
	}
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

// ---------------------------------------------------------------- the coverage map (battery-tiers)

/**
 * WHICH SUITES RUN WHICH APP FILES. A run with E2E_COVERAGE=1 leaves <out>/coverage/<suite>.json: every app
 * file (src/… path, or npm:<package>) the suite's pages executed, with how many of its functions ran.
 * Nearly every suite boots the whole app, so "executed" alone maps App.svelte and three hundred stores to
 * every suite. The map keeps, per suite, only the files it ran MORE of than the FLOOR — the count the
 * quietest tenth of suites (`--floor-pct`, default 10) reached for that file, 0 when they never loaded it.
 * A file only some suites load (a lazy window, a module) has floor 0, so loading it is using it; a file every
 * suite boots counts for the suites that ran past its boot work. A change to a boot-only path breaks every
 * suite, which the tier-1 always-set sees.
 * HEAVY: a file more than HEAVY_K * 2 suites run past the floor (objectMenu.js, DockTabs.svelte) is shared, and
 * a change to it pulls all of them only under the tier-1 cap — so the map also names its HEAVIEST users: the
 * suites at or above the HEAVY_K-th largest count (ties included), or only those strictly above it when the
 * ties alone would pass HEAVY_K * 2 (a saturated count says nothing). Those come along whatever the cap.
 * @typedef {{ suite: string, files: Record<string, number>, pages?: number, uncollected?: number }} CoverageRecord
 * @typedef {{ comment: string, made: string, commit: string, floor_pct: number, records: number,
 *   floor: Record<string, number>, suites: Record<string, string[]>, heavy?: Record<string, string[]> }} CoverageMap
 */

const MAP_FILE = path.join(ROOT, 'tests', 'e2e', 'coverage-map.json');
const HEAVY_K = 8;
const MAP_COMMENT =
	'battery-tiers: suite -> the app files (src/ paths, npm:<package>) it executes beyond the boot floor (floor = per file, the function count the quietest floor_pct % of suites reached). Read by `battery-desk.cjs tiers` to pick tier 1 by coverage. REGENERATE after a release whose union added suites or moved files (every few releases, or when `tiers` reports many unmapped suites): both halves with E2E_COVERAGE=1 on pc slots (RELEASING.md / lanes rules, the battery section), then `node scripts/ci/battery-desk.cjs map build <out-A> <out-B>`; `--merge` adds suites from a focused run to the committed map without rebuilding the floor.';

/** every coverage record under the given run folders (a folder, its coverage/ subfolder, or one file) @param {string[]} dirs @returns {CoverageRecord[]} */
function readCoverage(dirs) {
	/** @type {CoverageRecord[]} */
	const out = [];
	for (const d of dirs) {
		const sub = path.join(d, 'coverage');
		const dir = fs.existsSync(sub) ? sub : d;
		const files = fs.statSync(dir).isDirectory() ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f)) : [dir];
		for (const f of files) {
			try {
				const j = JSON.parse(fs.readFileSync(f, 'utf8'));
				if (j && typeof j.suite === 'string' && j.files && typeof j.files === 'object') out.push(j);
			} catch {}
		}
	}
	return out;
}

/** a src/ path, or npm:<a package installed here> — not a bundler chunk an older record still names (npm:client-Cqw3l5wU) @param {string} f */
function isFileKey(f) {
	return !f.startsWith('npm:') || fs.existsSync(path.join(ROOT, 'node_modules', f.slice(4), 'package.json'));
}

/**
 * @param {CoverageRecord[]} records @param {{ floorPct?: number, base?: CoverageMap|null, commit?: string }} [o]
 * @returns {CoverageMap}
 */
function buildMap(records, o = {}) {
	const floorPct = o.floorPct ?? o.base?.floor_pct ?? 10;
	/** @type {Map<string, Record<string, number>>} the same suite in several runs (a retry, two halves): the larger count */
	const per = new Map();
	for (const r of records) {
		const m = per.get(r.suite) || {};
		for (const [f, n] of Object.entries(r.files)) if (isFileKey(f)) m[f] = Math.max(m[f] || 0, n);
		per.set(r.suite, m);
	}
	// a record with no app file at all (a node-only suite, a page that crashed before the app) is no evidence
	const withFiles = [...per].filter(([, m]) => Object.keys(m).length);
	/** @type {Record<string, number>} */
	let floor = {};
	if (o.base) floor = { ...o.base.floor };
	else {
		const all = new Set(withFiles.flatMap(([, m]) => Object.keys(m)));
		const k = Math.floor((withFiles.length * floorPct) / 100);
		for (const f of all) {
			const counts = withFiles.map(([, m]) => m[f] || 0).sort((x, y) => x - y);
			if (counts[k]) floor[f] = counts[k];
		}
	}
	/** @type {Record<string, string[]>} */
	const suites = { ...(o.base?.suites || {}) };
	for (const [s, m] of withFiles) suites[s] = Object.keys(m).filter((f) => m[f] > (floor[f] || 0)).sort();
	/** @type {Record<string, string[]>} a merge has no counts for the committed suites: it keeps the committed heavy users */
	const heavy = { ...(o.base?.heavy || {}) };
	if (!o.base) {
		/** @type {Map<string, [string, number][]>} */
		const over = new Map();
		for (const [s, m] of withFiles) for (const f of suites[s]) over.set(f, [...(over.get(f) || []), [s, m[f]]]);
		for (const [f, l] of over) {
			if (l.length <= HEAVY_K * 2) continue;
			const kth = l.map(([, n]) => n).sort((x, y) => y - x)[HEAVY_K - 1];
			const atLeast = l.filter(([, n]) => n >= kth);
			const top = (atLeast.length <= HEAVY_K * 2 ? atLeast : l.filter(([, n]) => n > kth)).map(([s]) => s).sort();
			if (top.length) heavy[f] = top;
		}
	}
	const sorted = (/** @type {Record<string, any>} */ obj) => Object.fromEntries(Object.entries(obj).sort(([x], [y]) => (x < y ? -1 : 1)));
	return { comment: MAP_COMMENT, made: new Date().toISOString().slice(0, 10), commit: o.commit || o.base?.commit || '?', floor_pct: floorPct, records: Object.keys(suites).length, floor: sorted(floor), suites: sorted(suites), heavy: sorted(heavy) };
}

/**
 * On disk the suites name files by their index in one `files` table (a suite runs ~150 files past the floor:
 * spelled out, the map is ~2 MB); one file and one suite per line, so a regenerated map still diffs line by line.
 * @param {CoverageMap} m
 */
function formatMap(m) {
	const { suites, floor, heavy = {}, ...head } = m;
	const files = [...new Set(Object.values(suites).flat())].sort();
	const at = new Map(files.map((f, i) => [f, i]));
	const lines = Object.entries(suites).map(([s, fs]) => `\t\t${JSON.stringify(s)}: ${JSON.stringify(fs.map((f) => at.get(f)))}`);
	const heavyLines = Object.entries(heavy).map(([f, l]) => `\t\t${JSON.stringify(f)}: ${JSON.stringify(l)}`);
	return `{\n${Object.entries(head)
		.map(([k, v]) => `\t${JSON.stringify(k)}: ${JSON.stringify(v)},`)
		.join('\n')}\n\t"floor": ${JSON.stringify(floor)},\n\t"files": [\n${files.map((f) => `\t\t${JSON.stringify(f)}`).join(',\n')}\n\t],\n\t"suites": {\n${lines.join(',\n')}\n\t},\n\t"heavy": {\n${heavyLines.join(',\n')}\n\t}\n}\n`;
}

/** the committed text with each suite's file indices spelled back out @param {string} text @returns {CoverageMap} */
function parseMap(text) {
	const { files, ...m } = JSON.parse(text);
	if (files) m.suites = Object.fromEntries(Object.entries(m.suites).map(([s, ix]) => [s, /** @type {number[]} */ (ix).map((i) => files[i])]));
	return m;
}

/** @param {string} [file] @returns {CoverageMap|null} */
function loadMap(file = MAP_FILE) {
	return fs.existsSync(file) ? parseMap(fs.readFileSync(file, 'utf8')) : null;
}

/** @param {string[]} argv */
function mapCmd(argv) {
	if (argv[0] !== 'build') throw new Error('map build [--merge] [--floor-pct N] [--out file] <run-dir>...');
	const rest = argv.slice(1);
	const dirs = rest.filter((a, i) => !a.startsWith('--') && !['--floor-pct', '--out', '--commit'].includes(rest[i - 1]));
	const out = path.resolve(opt(rest, '--out') || MAP_FILE);
	const records = readCoverage(dirs);
	if (!records.length) throw new Error(`no coverage records (<suite>.json from an E2E_COVERAGE=1 run) in ${dirs.join(' ')}`);
	const base = rest.includes('--merge') ? loadMap(out) : null;
	const fp = opt(rest, '--floor-pct');
	const m = buildMap(records, { floorPct: fp ? Number(fp) : undefined, base, commit: opt(rest, '--commit') || commitOf(ROOT) });
	const text = formatMap(m);
	fs.writeFileSync(out, text);
	const empty = records.filter((r) => !Object.keys(r.files).length).map((r) => r.suite);
	const partial = records.filter((r) => r.uncollected).map((r) => r.suite);
	console.log(`map: ${records.length} records -> ${Object.keys(m.suites).length} suites, ${Object.keys(m.floor).length} boot-floor files, ${(text.length / 1024).toFixed(0)} KB -> ${out}`);
	if (empty.length) console.log(`  no app files (stay unmapped -> tier 1): ${empty.join(' ')}`);
	if (partial.length) console.log(`  a page closed without handing coverage in (partial): ${partial.join(' ')}`);
}

// ---------------------------------------------------------------- tiers (battery-tiers)

/**
 * TIER 1 GATES THE RELEASE, TIER 2 RUNS AFTER THE TAG. Tier 1 is picked by what changed and what covers it:
 *  (a) every suite whose map entry holds a changed file (src/, or npm:<package> when the lockfile moved it);
 *  (b) every suite added or changed in tests/e2e, and every suite that requires a changed shared .cjs there;
 *  (c) battery.json `tier1_always` (CI smoke, the network/two-peer core, join/save/edit/play) + `--also`
 *      (the release's focused union suites);
 *  (d) every desk suite with no map entry (new since the map, a modules flight, a node-only suite);
 *  (e) a SHARED file — named in battery.json `tier1_always_files`, or run past the floor by more than
 *      `tier1_shared_suites` mapped suites (default 16 = HEAVY_K * 2, the line above which the map names heavy users) (App.svelte, the stores, the editor shell, helpers.cjs) — pulls its suites in only
 *      while tier 1 stays under `tier1_cap` of the desk suite-minutes, smallest first; one that would cross
 *      the cap is reported and left to the always-set and tier 2 — except its HEAVY users (the map's
 *      `heavy`), which come along whatever the cap.
 * Tier 2 = everything else. Pure: the caller hands it the diff.
 * @typedef {{ src: string[], added: string[], changedSuites: string[], support: string[], packages: string[], other: string[] }} Change
 * @typedef {{ name: string, secs: number, why: string[] }} Pick
 * @typedef {{ tier1: Pick[], tier2: Pick[], shared: { file: string, suites: number, taken: boolean }[], uncovered: string[], bootOnly: string[], other: string[],
 *   cap: number, secs: { tier1: number, tier2: number } }} Tiers
 */

/** @param {string} file @param {string[]} patterns exact paths, or prefixes ending in `/` */
function matchesAny(file, patterns) {
	return patterns.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));
}

/**
 * @param {DeskBattery & { tier1_always?: string[], tier1_always_files?: string[], tier1_cap?: number, tier1_shared_suites?: number }} b
 * @param {CoverageMap|null} map @param {Change} change @param {{ also?: string[], requires?: Record<string, string[]> }} [o]
 * @returns {Tiers}
 */
function selectTiers(b, map, change, o = {}) {
	const entries = deskEntries(b);
	const names = new Set(entries.map(([n]) => n));
	const secsOf = Object.fromEntries(entries);
	const total = entries.reduce((t, [, s]) => t + s, 0);
	const cap = b.tier1_cap ?? 0.3;
	const sharedSuites = b.tier1_shared_suites ?? HEAVY_K * 2;
	/** @type {Map<string, string[]>} */
	const why = new Map();
	const add = (/** @type {string} */ n, /** @type {string} */ reason) => {
		if (!names.has(n)) return;
		const w = why.get(n) || [];
		if (!w.includes(reason)) w.push(reason);
		why.set(n, w);
	};
	const mapped = map ? Object.keys(map.suites).filter((s) => names.has(s)) : [];
	/** @type {Map<string, string[]>} file -> the suites that cover it */
	const users = new Map();
	for (const s of mapped) for (const f of /** @type {CoverageMap} */ (map).suites[s]) users.set(f, [...(users.get(f) || []), s]);
	const alwaysFiles = b.tier1_always_files || [];
	const isShared = (/** @type {string} */ f) => matchesAny(f, alwaysFiles) || (users.get(f) || []).length > sharedSuites;
	// (b) the suites themselves, and what requires a changed support file
	for (const n of change.added) add(n, 'added');
	for (const n of change.changedSuites) add(n, 'changed');
	/** @type {{ file: string, list: string[] }[]} */
	const shared = [];
	for (const f of change.support) {
		const list = Object.entries(o.requires || {})
			.filter(([, req]) => req.includes(f))
			.map(([s]) => s)
			.filter((s) => names.has(s));
		if (matchesAny(f, alwaysFiles) || list.length > sharedSuites) shared.push({ file: f, list });
		else for (const s of list) add(s, `requires ${path.basename(f)}`);
	}
	// (c) the always-set, (d) no map entry
	for (const n of [...(b.tier1_always || []), ...(o.also || [])]) add(n, 'always');
	for (const [n] of entries) if (!map || !(n in map.suites)) add(n, 'unmapped');
	// (a) covered files; (e) shared ones wait
	/** @type {string[]} */
	const uncovered = [];
	/** @type {string[]} */
	const bootOnly = [];
	for (const f of [...change.src, ...change.packages]) {
		const list = users.get(f) || [];
		if (!list.length) (map && map.floor[f] ? bootOnly : uncovered).push(f);
		else if (isShared(f)) {
			for (const s of map?.heavy?.[f] || []) add(s, `heavy ${f}`);
			shared.push({ file: f, list });
		} else for (const s of list) add(s, `covers ${f}`);
	}
	const secs = () => [...why.keys()].reduce((t, n) => t + (secsOf[n] || 0), 0);
	shared.sort((x, y) => x.list.length - y.list.length || (x.file < y.file ? -1 : 1));
	/** @type {Tiers['shared']} */
	const sharedOut = [];
	for (const s of shared) {
		const extra = s.list.filter((n) => !why.has(n)).reduce((t, n) => t + (secsOf[n] || 0), 0);
		const taken = (secs() + extra) / (total || 1) <= cap;
		if (taken) for (const n of s.list) add(n, `shared ${s.file}`);
		sharedOut.push({ file: s.file, suites: s.list.length, taken });
	}
	const tier1 = entries.filter(([n]) => why.has(n)).map(([name, s]) => ({ name, secs: s, why: /** @type {string[]} */ (why.get(name)) }));
	const tier2 = entries.filter(([n]) => !why.has(n)).map(([name, s]) => ({ name, secs: s, why: [] }));
	const sum = (/** @type {Pick[]} */ l) => l.reduce((t, p) => t + p.secs, 0);
	return { tier1, tier2, shared: sharedOut, uncovered, bootOnly, other: change.other, cap, secs: { tier1: sum(tier1), tier2: sum(tier2) } };
}

/** @param {string} dir @param {string[]} args */
function git(dir, args) {
	return require('child_process').execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
}

/** the top-level packages whose locked version differs between two lockfiles @param {string} a @param {string} b */
function lockChanges(a, b) {
	const pk = (/** @type {string} */ t) => {
		try {
			return JSON.parse(t).packages || {};
		} catch {
			return {};
		}
	};
	const x = pk(a);
	const y = pk(b);
	/** @type {Set<string>} */
	const out = new Set();
	for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
		const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(k);
		if (m && x[k]?.version !== y[k]?.version) out.add('npm:' + m[1]);
	}
	return [...out].sort();
}

/** which tests/e2e support files (.cjs and fixtures) each suite reaches, through require('./x') chains and by name @param {string} root */
function suiteRequires(root) {
	const dir = path.join(root, 'tests', 'e2e');
	const files = fs.readdirSync(dir).filter((f) => /\.c?js$/.test(f));
	/** @type {Record<string, string[]>} direct */
	const direct = {};
	for (const f of files) {
		const t = fs.readFileSync(path.join(dir, f), 'utf8');
		direct[f] = [...t.matchAll(/require\(\s*['"]\.\/([^'"]+?)(?:\.cjs)?['"]\s*\)/g)].map((m) => (m[1].endsWith('.js') ? m[1] : m[1] + '.cjs'));
	}
	/** @type {Record<string, string[]>} */
	const out = {};
	for (const f of files.filter((x) => x.endsWith('.test.cjs'))) {
		const seen = new Set();
		const stack = [f];
		while (stack.length) {
			const cur = /** @type {string} */ (stack.pop());
			for (const d of direct[cur] || []) if (!seen.has(d)) seen.add(d), stack.push(d);
		}
		out[f.slice(0, -'.test.cjs'.length)] = [...seen].map((d) => `tests/e2e/${d}`);
	}
	return out;
}

/**
 * the diff between two refs, sorted for selectTiers. A suite file required by another suite (lock-settings-b
 * runs lock-settings.test.cjs) is also a support file of that one.
 * @param {string} gitDir @param {string} base @param {string} head @returns {Change}
 */
function changeOf(gitDir, base, head) {
	const lines = git(gitDir, ['diff', '--name-status', '-M', `${base}..${head}`]).split('\n').filter(Boolean);
	/** @type {Change} */
	const c = { src: [], added: [], changedSuites: [], support: [], packages: [], other: [] };
	for (const l of lines) {
		const [st, ...paths] = l.split('\t');
		const p = paths[paths.length - 1];
		const suite = /^tests\/e2e\/([^/]+)\.test\.cjs$/.exec(p);
		if (st === 'D' && !p.startsWith('src/')) continue;
		if (p.startsWith('src/')) {
			c.src.push(p);
			// a rename: the map may still know the file by its old name
			if (st.startsWith('R') && paths[0].startsWith('src/')) c.src.push(paths[0]);
		} else if (suite) (st === 'A' || st.startsWith('C') ? c.added : c.changedSuites).push(suite[1]);
		if (suite || p.startsWith('tests/e2e/')) {
			if (p.startsWith('tests/e2e/') && !/\.(json|md)$/.test(p) && st !== 'A') c.support.push(p);
		} else if (p === 'package-lock.json') c.packages = lockChanges(gitShow(gitDir, base, p), gitShow(gitDir, head, p));
		else if (!p.startsWith('src/')) c.other.push(p);
	}
	return c;
}

/** @param {string} dir @param {string} ref @param {string} file */
function gitShow(dir, ref, file) {
	try {
		return git(dir, ['show', `${ref}:${file}`]);
	} catch {
		return '';
	}
}

/** @param {string[]} argv */
function tiersOf(argv) {
	const b = /** @type {any} */ (load(opt(argv, '--battery')));
	const root = path.resolve(opt(argv, '--root') || ROOT);
	const base = opt(argv, '--base');
	if (!base) throw new Error('tiers: --base <previous release tag>');
	const head = opt(argv, '--head') || 'HEAD';
	const gitDir = path.resolve(opt(argv, '--git') || process.env.BATTERY_GIT || root);
	const map = loadMap(opt(argv, '--map') || path.join(root, 'tests', 'e2e', 'coverage-map.json'));
	const also = (opt(argv, '--also') || '').split(',').filter(Boolean);
	const change = changeOf(gitDir, base, head);
	const t = selectTiers(b, map, change, { also, requires: suiteRequires(root) });
	return { base, head: git(gitDir, ['rev-parse', '--short', head]).trim(), made: new Date().toISOString(), map: map ? `${map.commit} ${map.made}` : 'none', change, ...t };
}

/** @param {Tiers & { base: string, head: string }} t */
function tiersSummary(t) {
	const n = t.tier1.length + t.tier2.length;
	const min = (/** @type {number} */ s) => Math.round(s / 60);
	const reasons = { covers: 0, heavy: 0, added: 0, changed: 0, requires: 0, always: 0, unmapped: 0, shared: 0 };
	for (const p of t.tier1) {
		const k = /** @type {keyof typeof reasons} */ (p.why[0].split(' ')[0]);
		if (k in reasons) reasons[k]++;
	}
	return `TIERS ${t.base}..${t.head}: tier 1 = ${t.tier1.length}/${n} suites (${Math.round((100 * t.tier1.length) / (n || 1))} %), ${min(t.secs.tier1)} suite-min (${Math.round((100 * t.secs.tier1) / (t.secs.tier1 + t.secs.tier2 || 1))} %); tier 2 = ${t.tier2.length} suites, ${min(t.secs.tier2)} suite-min (battery.json seconds) · tier 1 by ${Object.entries(reasons)
		.filter(([, v]) => v)
		.map(([k, v]) => `${k} ${v}`)
		.join(', ')}`;
}

/** @param {string[]} argv */
function tiersCmd(argv) {
	const t = tiersOf(argv);
	const save = opt(argv, '--save');
	if (save) fs.writeFileSync(path.resolve(save), JSON.stringify(t, null, 1));
	const list = opt(argv, '--list-out');
	if (list) fs.writeFileSync(path.resolve(list), (opt(argv, '--tier') === '2' ? t.tier2 : t.tier1).map((p) => p.name).join('\n') + '\n');
	console.log(tiersSummary(t));
	const c = t.change;
	console.log(`  diff: ${c.src.length} src files, ${c.added.length} suites added, ${c.changedSuites.length} changed, ${c.support.length} support files, ${c.packages.length} packages, ${c.other.length} other paths`);
	for (const s of t.shared) console.log(`  shared ${s.file}: ${s.suites} suites ${s.taken ? 'pulled in' : `LEFT TO TIER 2 (would pass the ${Math.round(t.cap * 100)} % cap)`}`);
	if (t.bootOnly.length) console.log(`  boot-only (every suite runs it the same way; the always-set covers a break): ${t.bootOnly.join(' ')}`);
	if (t.uncovered.length) console.log(`  executed by no mapped suite: ${t.uncovered.join(' ')}`);
	if (argv.includes('--verbose')) for (const p of t.tier1) console.log(`  T1 ${p.name} (${p.secs}s) ${p.why.join('; ')}`);
}

// ---------------------------------------------------------------- the release record (battery-tiers)

/**
 * $BATTERY_STATE/releases.jsonl, one line per release:
 * {version, base, tier1: {suites, suite_min, wall_min, reds, new}, tier2: {…}, escapes: [{suite, check, real, severity}], date}.
 * `record` UPSERTS by version (tier 1 at release, tier 2 when it lands, escapes when the integrator classifies);
 * `record --check` is the next release's gate: the newest release's tier 2 must be recorded and every NEW
 * tier-2 red classified, and it says WIDEN TIER 1 when tier 2 found 2+ real bugs in the last 5 releases.
 * @typedef {{ suites: number, suite_min: number, wall_min: number, reds: number, new: number, new_suites?: string[] }} TierRecord
 * @typedef {{ suite: string, check: string, real: boolean|null, severity: string }} Escape
 * @typedef {{ version: string, base: string, tier1?: TierRecord, tier2?: TierRecord, escapes: Escape[], date: string }} ReleaseRecord
 */

const RELEASES = () => path.join(STATE, 'releases.jsonl');

/** @returns {ReleaseRecord[]} */
function readReleases() {
	const f = RELEASES();
	return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

/** a tier's numbers from its run folders (both halves), NEW against the base tag's baseline when one exists @param {string[]} dirs @param {string} base @param {Record<string, number>} secsOf */
function tierRecord(dirs, base, secsOf) {
	const runs = readRuns(dirs);
	const results = runs.flatMap((r) => r.results);
	const blFile = path.join(STATE, 'baselines', `${base}.json`);
	const fresh = fs.existsSync(blFile) ? classify(JSON.parse(fs.readFileSync(blFile, 'utf8')), runs).fresh.map((f) => f.name) : [];
	return {
		suites: results.length,
		suite_min: Math.round(results.reduce((t, r) => t + (secsOf[r.name] || 0), 0) / 60),
		wall_min: Math.round(runs.reduce((t, r) => t + r.secs, 0) / 60),
		reds: results.filter((r) => r.status === 'red').length,
		new: fresh.length,
		new_suites: fresh
	};
}

/** @param {ReleaseRecord[]} rows @returns {string[]} problems; WIDEN as the last one when the escape rule fires */
function releaseCheck(rows) {
	const out = [];
	const last = rows[rows.length - 1];
	if (last) {
		if (!last.tier2) out.push(`${last.version}: tier 2 not recorded — run it on the tag (battery-desk run --tier 2) and record it before this union merges`);
		else {
			const open = (last.tier2.new_suites || []).filter((s) => !last.escapes.some((e) => e.suite === s && e.real !== null));
			if (open.length) out.push(`${last.version}: tier-2 NEW reds not classified: ${open.join(' ')} (record --version ${last.version} --escape <suite>:<real yes|no>:<serious|minor|none>:<check>)`);
		}
	}
	const real = rows.slice(-5).flatMap((r) => r.escapes.filter((e) => e.real));
	if (real.length >= 2) out.push(`WIDEN TIER 1: tier 2 found ${real.length} real bugs in the last ${Math.min(5, rows.length)} releases (${real.map((e) => e.suite).join(' ')}) — add their files to tier1_always_files or their suites to tier1_always`);
	return out;
}

/** @param {string[]} argv */
function recordCmd(argv) {
	const rows = readReleases();
	if (argv.includes('--check')) {
		const p = releaseCheck(rows);
		for (const l of p) console.log(l);
		if (!p.length) console.log(rows.length ? `${rows[rows.length - 1].version}: tier 2 recorded and classified` : 'no release recorded yet');
		process.exit(p.some((l) => !l.startsWith('WIDEN')) ? 1 : 0);
	}
	const version = opt(argv, '--version');
	if (!version) throw new Error('record --version X [--base tag] [--tier1 dir,dir] [--tier2 dir,dir] [--escape suite:real:severity:check]... | record --check');
	const b = load(opt(argv, '--battery'));
	const secsOf = Object.fromEntries(deskEntries(b));
	const i = rows.findIndex((r) => r.version === version);
	/** @type {ReleaseRecord} */
	const row = i >= 0 ? rows[i] : { version, base: '', escapes: [], date: new Date().toISOString().slice(0, 10) };
	row.base = opt(argv, '--base') || row.base;
	if (!row.base) throw new Error('record: --base <previous tag> (once per version)');
	for (const t of /** @type {const} */ (['tier1', 'tier2'])) {
		const d = opt(argv, `--${t}`);
		if (d) row[t] = tierRecord(d.split(','), row.base, secsOf);
	}
	argv.forEach((a, k) => {
		if (a !== '--escape') return;
		const [suite, real, severity, ...check] = (argv[k + 1] || '').split(':');
		const e = { suite, real: real === 'yes' ? true : real === 'no' ? false : null, severity: severity || 'none', check: check.join(':') };
		row.escapes = [...row.escapes.filter((x) => !(x.suite === e.suite && x.check === e.check)), e];
	});
	if (i >= 0) rows[i] = row;
	else rows.push(row);
	fs.mkdirSync(STATE, { recursive: true });
	fs.writeFileSync(RELEASES(), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
	console.log(JSON.stringify(row));
}

if (require.main === module) {
	const [cmd, ...argv] = process.argv.slice(2);
	try {
		if (cmd === 'run') run(argv);
		else if (cmd === 'queue') queueCmd(argv);
		else if (cmd === 'queue-worker') queueWorker(argv);
		else if (cmd === 'baseline' && argv[0] === 'save' && argv[1]) baselineSave(argv[1], argv.slice(2));
		else if (cmd === 'diff') diff(argv);
		else if (cmd === 'flakes') flakes(argv);
		else if (cmd === 'import') importRun(argv);
		else if (cmd === 'map') mapCmd(argv);
		else if (cmd === 'tiers') tiersCmd(argv);
		else if (cmd === 'record') recordCmd(argv);
		else if (cmd === 'coverage') {
			const c = coverage(/** @type {DeskBattery} */ (load()), e2eFiles());
			for (const n of c.unlisted) console.log(`unlisted: ${n} — add it to tests/e2e/battery.json suites, or to exclude with a reason`);
			// listed-but-absent is information, not a failure: a feat branch carries the list of a
			// release whose suites have not merged into it yet, and both runners report them as gone
			for (const n of c.missing) console.log(`(listed, no file here: ${n})`);
			for (const n of c.both) console.log(`both: ${n} is a suite AND excluded`);
			process.exit(c.unlisted.length + c.both.length ? 1 : 0);
		} else {
			console.error('usage: battery-desk.cjs run --half A|B [--of N] [--only a,b] [--list f] [--out d] [--name n] [--root tree] [--no-retry]\n' + '       | run --tier 1|2 --base <tag> [--head ref] [--git dir | --selection tiers.json] [--also a,b] [--half A|B]\n' +
					'       | queue --workers N --port P [--only a,b] [--list f] [--tier 1|2 --base <tag>] [--out d] [--name n] [--root tree] [--resume] [--no-retry] [--slot "prefix {dir} {port} --"]\n' +
					'       | baseline save <tag> <out-dir>... | diff [--baseline tag|file] <out-dir>... | flakes [--days N] | coverage\n' +
					'       | import <battery.sh summary.txt> --logs <dir> [--retry <summary.txt> [--retry-logs dir]] [--name n] [--out dir]\n' +
					'       | map build [--merge] [--floor-pct N] <run-dir>... | tiers --base <tag> [--head ref] [--also a,b] [--save f] [--list-out f --tier 1|2] [--verbose]\n' +
					'       | record --version X --base <tag> [--tier1 d,d] [--tier2 d,d] [--escape suite:yes|no:severity:check] | record --check');
			process.exit(2);
		}
	} catch (e) {
		console.error(`battery-desk: ${/** @type {Error} */ (e).message}`);
		process.exit(2);
	}
}

module.exports = { makeQueue, longestFirst, treeId, linkTree, resumeFrom, normalise, fingerprints, classify, coverage, e2eFiles, deskEntries, half, buildMap, formatMap, parseMap, selectTiers, readCoverage, changeOf, lockChanges, suiteRequires, releaseCheck };
