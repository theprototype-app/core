#!/usr/bin/env node
// deps-auto — THE E2E BATTERY, SHARDED, ON GITHUB-HOSTED RUNNERS.
//
// The battery is the list an integrator runs before a release: tests/e2e/battery.json holds it
// (suite → seconds measured on a GitHub runner, or twice the desk time until one has run), the
// suites a public runner must skip (`skip`: they need the self-hosted signaling box, a hosts-file
// origin or a built app) and the ones that run but do not gate (`optional`: red or flaky on
// SwiftShader with the same red on the unchanged base — the reason is on the line). A red CHECK that
// tests/e2e/quarantine.json lists (test-health-1: per check, with an owner and a review date, read through
// scripts/ci/quarantine.cjs) does not gate either. Nothing here names a suite; the list is data, refreshed
// from the integrators' battery runs (`refresh`).
//
//   node scripts/ci/battery.cjs plan                      # the required + optional matrices for GITHUB_OUTPUT
//   node scripts/ci/battery.cjs run --set required --shard 3 --of 14   # one shard (serves the app + the signaling server)
//   node scripts/ci/battery.cjs run --set confirm --from <dir> --shard 1 --of 3   # re-run a run's required reds
//   node scripts/ci/battery.cjs report <results-dir>      # merge shard results → summary, exit 1 on a required red
//   node scripts/ci/battery.cjs refresh [--list f]... [--summary f]... [--results dir]...
//
// Two sets, two matrices: the REQUIRED suites gate (deps-gate waits for them, sized to finish inside the hour);
// the OPTIONAL ones run in their own shards AFTER the required ones (the free-plan runner cap is 20 jobs), are
// reported, and gate nothing. Sharding is longest-first onto the least-loaded shard, by name on ties: every shard
// computes the same assignment from the same file, so the plan job only says how many shards there are.
// A required red is NOT retried on its shard: the CONFIRM step re-runs every required red (and whatever the deadline
// left unrun) on fresh runners, two tries; green there = `flaky` (reported, not a red). An optional red is never
// retried, and its run is cut at the deadline (they are the slow ones: a red waits out its timeouts).
// A required red whose every failed check is quarantined = `quarantined` (reported in its own tier, not a red).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const quarantine = require('./quarantine.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const BATTERY = path.join(ROOT, 'tests', 'e2e', 'battery.json');

/**
 * @typedef {{ comment?: string, refs: Record<string, {repo: string, ref: string}>, shards: {target_minutes: number, max: number, min: number, par?: number},
 *   pc?: {games: string[], levels: string[]}, skip: Record<string, string>, optional: Record<string, string>, setup: Record<string, string>,
 *   suites: Record<string, number>, modules?: Record<string, number>, desk?: Record<string, string[]>, exclude?: Record<string, string[]>,
 *   tiers?: string, tier1_always?: string[], tier1_always_files?: string[], tier1_cap?: number, tier1_shared_suites?: number }} Battery
 * @typedef {{ name: string, status: 'pass'|'flaky'|'quarantined'|'fail'|'timeout'|'gone'|'notrun', required: boolean, rc: number|null, secs: number,
 *   retrySecs?: number, pass: number, fail: number, last: string, shard: number }} SuiteResult
 */

/** @returns {Battery} */
function load(file = BATTERY) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** the suites a runner executes, longest first (name breaks ties so every shard agrees) @param {Battery} b */
function runnable(b) {
	return Object.entries(b.suites)
		.filter(([name]) => !(name in b.skip))
		.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
}

/** @typedef {'required'|'optional'|'all'} BatterySet */

/** the runnable suites of one set, longest first @param {Battery} b @param {BatterySet} set @returns {[string, number][]} */
function suitesOf(b, set) {
	return runnable(b).filter(([n]) => set === 'all' || (set === 'optional') === n in b.optional);
}

/** @param {Battery} b @param {BatterySet} [set] @returns {number} */
function shardCount(b, set = 'required') {
	const env = Number(process.env[set === 'optional' ? 'BATTERY_OPTIONAL_SHARDS' : 'BATTERY_SHARDS'] || 0);
	if (env > 0) return env;
	const total = suitesOf(b, set).reduce((t, [, s]) => t + s, 0);
	if (!total) return 0;
	// `par` suites run side by side on one runner, so a shard holds par x target_minutes of suite time
	const n = Math.ceil(total / (b.shards.target_minutes * 60 * (b.shards.par || 1)));
	return Math.max(set === 'optional' ? 1 : b.shards.min, Math.min(b.shards.max, n));
}

/**
 * Longest first onto the least-loaded shard, name breaking ties, so every shard computes the same split.
 * `all` (a local run) queues each shard's optional suites after its required ones, balanced on their own.
 * @param {Battery} b @param {number} of @param {BatterySet} [set] @returns {{suites: string[], secs: number}[]}
 */
function assign(b, of, set = 'required') {
	const shards = Array.from({ length: of }, () => ({ suites: /** @type {string[]} */ ([]), secs: 0, load: 0 }));
	const lpt = (/** @type {[string, number][]} */ list) => {
		for (const s of shards) s.load = 0;
		for (const [name, secs] of list) {
			let best = 0;
			for (let i = 1; i < of; i++) if (shards[i].load < shards[best].load) best = i;
			shards[best].suites.push(name);
			shards[best].load += secs;
			shards[best].secs += secs;
		}
	};
	if (set === 'all') {
		lpt(suitesOf(b, 'required'));
		lpt(suitesOf(b, 'optional'));
	} else lpt(suitesOf(b, set));
	return shards.map(({ suites, secs }) => ({ suites, secs }));
}

/** pass/fail lines the way the integrators' battery.sh counts them @param {string} log */
function counts(log) {
	const lines = log.split('\n');
	const pass = lines.filter((l) => /^\s*(✓|PASS|ok)/.test(l)).length;
	const fail = lines.filter((l) => /^\s*(✗|FAIL|not ok)/.test(l)).length;
	const last = (lines.filter((l) => l.trim()).pop() || '').slice(0, 160);
	return { pass, fail, last };
}

/** @param {string[]} argv @param {string} flag */
function opt(argv, flag) {
	const i = argv.indexOf(flag);
	return i >= 0 ? argv[i + 1] : undefined;
}

/** @param {string[]} argv @param {string} flag */
function opts(argv, flag) {
	/** @type {string[]} */
	const out = [];
	argv.forEach((a, i) => a === flag && argv[i + 1] && out.push(argv[i + 1]));
	return out;
}

// ---------------------------------------------------------------- serving the app

/**
 * a 200 from the dev server (self-signed TLS, so no verification). `vite --host localhost` may listen on ::1
 * only while node resolves localhost to 127.0.0.1, so both loopbacks are asked.
 * @param {string} url @returns {Promise<boolean>}
 */
async function reachable(url) {
	const u = new URL(url);
	/** @param {string} host @returns {Promise<boolean>} */
	const ask = (host) =>
		new Promise((resolve) => {
			const opts = { host, port: u.port, path: u.pathname, headers: { host: u.host }, servername: u.hostname, rejectUnauthorized: false, timeout: 300000 };
			const req = require('https').get(opts, (res) => {
				res.resume();
				res.on('end', () => resolve(res.statusCode === 200));
			});
			req.on('timeout', () => req.destroy());
			req.on('error', () => resolve(false));
		});
	return (await ask('::1')) || (await ask('127.0.0.1'));
}

/** @param {number} port @param {string} logFile */
async function serve(port, logFile) {
	const out = fs.openSync(logFile, 'a');
	const child = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort', '--host', 'localhost'], {
		cwd: ROOT,
		stdio: ['ignore', out, out],
		detached: true
	});
	const url = `https://localhost:${port}/`;
	for (let i = 0; i < 120; i++) {
		if (await reachable(url)) break;
		await new Promise((r) => setTimeout(r, 1000));
	}
	// the first SSR + the client graph are the slow ones; a second load warms the optimised deps
	await reachable(url);
	return child;
}

/** @param {import('child_process').ChildProcess | null} child */
function stop(child) {
	if (child?.pid) {
		try {
			process.kill(-child.pid, 'SIGTERM');
		} catch {}
	}
}

// ---------------------------------------------------------------- one suite

/** @param {string} name @param {number} est @param {string} out @param {string} tag @param {number} capMs */
function runSuite(name, est, out, tag, capMs) {
	const file = path.join(ROOT, 'tests', 'e2e', name + '.test.cjs');
	const ev = path.join(out, 'evidence', name);
	fs.mkdirSync(ev, { recursive: true });
	const logFile = path.join(out, 'logs', `${name}${tag}.log`);
	const log = fs.openSync(logFile, 'w');
	// every evidence variable the suites read points OUTSIDE the served tree (an .html artefact
	// inside it full-reloads the app mid-test) and is kept only when the suite fails
	const env = { ...process.env, EVIDENCE_DIR: ev, EVIDENCE: ev, OUT: ev, SHOT_DIR: ev, SHOTS_DIR: ev };
	const timeout = Math.max(60000, Math.min(capMs, Math.min(1800, Math.max(600, Math.round(est * 3))) * 1000));
	const t0 = Date.now();
	return new Promise((resolve) => {
		const child = spawn('node', [file], { cwd: ROOT, env, stdio: ['ignore', log, log], detached: true });
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-(child.pid || 0), 'SIGKILL');
			} catch {}
		}, timeout);
		child.on('exit', (code) => {
			clearTimeout(timer);
			fs.closeSync(log);
			const text = fs.readFileSync(logFile, 'utf8');
			if (timedOut) fs.appendFileSync(logFile, `\n[battery] TIMEOUT after ${timeout / 1000}s\n`);
			resolve({ rc: timedOut ? null : code, secs: Math.round((Date.now() - t0) / 1000), timedOut, text, ...counts(text) });
		});
	});
}

/** @param {string[]} argv */
async function run(argv) {
	const b = load();
	const q = quarantine.load();
	const qErrors = quarantine.validate(q);
	if (qErrors.length) {
		for (const e of qErrors) console.error('quarantine.json: ' + e);
		process.exit(2);
	}
	const of = Number(opt(argv, '--of') || shardCount(b, /** @type {BatterySet} */ (opt(argv, '--set') === 'optional' ? 'optional' : 'required')));
	const shard = Number(opt(argv, '--shard') || 1);
	const out = path.resolve(opt(argv, '--out') || process.env.BATTERY_OUT || path.join(ROOT, '..', 'battery-out'));
	const port = Number(opt(argv, '--port') || 5173);
	const only = opt(argv, '--only');
	fs.mkdirSync(path.join(out, 'logs'), { recursive: true });
	const set = /** @type {BatterySet | 'confirm'} */ (opt(argv, '--set') || 'all');
	// --set confirm --from <dir>: the required reds of a finished run (and what its deadline left unrun), re-run on
	// THIS fresh runner — part `shard` of `of` takes every of-th one. A red that passes here was the shard's load.
	const from = opt(argv, '--from');
	const reds = () =>
		walk(path.resolve(/** @type {string} */ (from)))
			.filter((f) => /results-\d+\.json$/.test(f))
			.flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')).results.filter(isRed).map((/** @type {SuiteResult} */ r) => r.name))
			.sort()
			.filter((_, i) => i % of === shard - 1);
	const mine = only ? only.split(',') : set === 'confirm' ? reds() : assign(b, of, set)[shard - 1].suites;
	// the suites' own default is a hosts-file origin: say where the app is
	const url = (process.env.APP_URL ||= `https://localhost:${port}/`);
	let server = argv.includes('--serve') && mine.length ? await serve(port, path.join(out, 'logs', 'dev-server.log')) : null;
	// the two-peer suites meet on a signaling server: with no .env a localhost app picks the local-dev
	// one on :9001, so --serve brings it (a public runner never touches the self-hosted or the public box)
	const signal = require(path.join(ROOT, 'tests', 'e2e', 'localSignal.cjs'));
	let signalChild = server ? await signal.ensureSignalServer() : null;
	/** @type {SuiteResult[]} */
	const results = [];
	const par = Number(opt(argv, '--par') || b.shards.par || 1);
	// a second try only in the confirm step: on a FRESH runner it says something a same-shard retry does not (a
	// loaded shard fails the same suite twice), and a shard without retries stays inside its estimate
	const retry = set === 'confirm' || argv.includes('--retry');
	// past the deadline no suite starts: the rest report `notrun` instead of the job being killed with nothing said
	const dl = Number(opt(argv, '--deadline') || 0);
	const deadline = dl ? Date.now() + dl * 60000 : Infinity;
	const save = () => fs.writeFileSync(path.join(out, `${set === 'confirm' ? 'confirm' : 'results'}-${shard}.json`), JSON.stringify({ shard, of, set, results }, null, 1));
	console.log(`shard ${shard}/${of}: ${mine.length} suites, est ${Math.round(mine.reduce((t, s) => t + (b.suites[s] || 60), 0) / 60)} min, ${par} at a time`);
	/** @type {Promise<any> | null} */
	let agentSetup = null;
	const queue = [...mine];
	const worker = async () => {
		for (let name = queue.shift(); name; name = queue.shift()) {
			const required = !(name in b.optional);
			if (!fs.existsSync(path.join(ROOT, 'tests', 'e2e', name + '.test.cjs'))) {
				results.push({ name, status: 'gone', required: false, rc: null, secs: 0, pass: 0, fail: 0, last: 'no such suite (refresh battery.json)', shard });
				continue;
			}
			if (Date.now() > deadline) {
				results.push({ name, status: 'notrun', required, rc: null, secs: 0, pass: 0, fail: 0, last: 'shard deadline passed before it started', shard });
				continue;
			}
			// a dead dev server turns every later suite red for the wrong reason: bring it back first
			if (server && !(await reachable(url))) {
				console.log(`[battery] dev server unreachable before ${name}: restarting`);
				stop(server);
				server = await serve(port, path.join(out, 'logs', 'dev-server.log'));
			}
			if (server && !(await signal.signalUp())) {
				console.log(`[battery] signaling server down before ${name}: restarting`);
				signalChild = await signal.ensureSignalServer();
			}
			// a suite's extra install happens once, on the shard that holds it
			if (b.setup[name] === 'agent' && !fs.existsSync(path.join(ROOT, 'tools', 'agent', 'node_modules'))) {
				agentSetup ||= new Promise((res) => spawn('npm', ['ci', '--no-audit', '--no-fund'], { cwd: path.join(ROOT, 'tools', 'agent'), stdio: 'inherit' }).on('exit', res));
				await agentSetup;
			}
			const est = b.suites[name] || 60;
			// an optional red is slow to fail: never let one run far past the deadline
			let r = await runSuite(name, est, out, '', required ? Infinity : deadline + 300000 - Date.now());
			/** @type {SuiteResult['status']} */
			let status = r.rc === 0 ? 'pass' : r.timedOut ? 'timeout' : 'fail';
			/** @type {number|undefined} */
			let retrySecs;
			// only a suite that gates earns a second run (an optional red is expected and only reported)
			if (status !== 'pass' && required && retry && Date.now() < deadline) {
				const again = await runSuite(name, est, out, '.retry', Infinity);
				retrySecs = again.secs;
				if (again.rc === 0) status = 'flaky';
				else r = again;
			}
			/** @type {string[]} */
			let quarantinedChecks = [];
			if (required && (status === 'fail' || status === 'timeout')) {
				const v = quarantine.classify(q, name, r.text, { timedOut: r.timedOut });
				if (v.quarantined) {
					status = 'quarantined';
					quarantinedChecks = v.whole ? ['(whole suite)'] : v.failed;
				}
			}
			const last = quarantinedChecks.length ? 'quarantined: ' + quarantinedChecks.join(' | ').slice(0, 140) : r.last;
			results.push({ name, status, required, rc: r.rc, secs: r.secs, retrySecs, pass: r.pass, fail: r.fail, last, shard });
			save();
			if (status === 'pass' || status === 'flaky' || status === 'quarantined') fs.rmSync(path.join(out, 'evidence', name), { recursive: true, force: true });
			console.log(`${name} ${status}${required ? '' : ' (optional)'} rc=${r.rc} pass~${r.pass} fail~${r.fail} ${r.secs}s${retrySecs ? ` retry ${retrySecs}s` : ''} :: ${last}`);
		}
	};
	await Promise.all(Array.from({ length: par }, worker));
	stop(server);
	signal.stopSignalServer(signalChild);
	save();
	const red = results.filter(isRed);
	if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, table(results, `Shard ${shard}/${of}`));
	process.exit(red.length ? 1 : 0);
}

/** a red that gates: a required suite that failed, timed out or never ran @param {SuiteResult} r */
const isRed = (r) => r.required && (r.status === 'fail' || r.status === 'timeout' || r.status === 'notrun');

// ---------------------------------------------------------------- the report

/** @param {SuiteResult[]} results @param {string} title */
function table(results, title) {
	const req = results.filter(isRed);
	const opt = results.filter((r) => !r.required && (r.status === 'fail' || r.status === 'timeout'));
	const quar = results.filter((r) => r.status === 'quarantined');
	const flaky = results.filter((r) => r.status === 'flaky');
	const secs = results.reduce((t, r) => t + r.secs + (r.retrySecs || 0), 0);
	const row = (/** @type {SuiteResult} */ r) => `| ${r.name} | ${r.status} | ${r.shard} | ${r.pass}/${r.fail} | ${r.secs}s | ${r.last.replace(/\|/g, '\\|')} |`;
	const head = '| suite | status | shard | ✓/✗ | time | last line |\n|---|---|---|---|---|---|\n';
	let md = `### ${title}: ${results.length} suites, ${req.length} required red, ${opt.length} optional red, ${quar.length} quarantined, ${flaky.length} flaky (${Math.round(secs / 60)} suite-min)\n\n`;
	if (req.length) md += `**Required reds**\n\n${head}${req.map(row).join('\n')}\n\n`;
	if (opt.length) md += `<details><summary>Optional reds (do not gate)</summary>\n\n${head}${opt.map(row).join('\n')}\n\n</details>\n\n`;
	if (quar.length) md += `<details><summary>Quarantined reds (tests/e2e/quarantine.json — do not gate)</summary>\n\n${head}${quar.map(row).join('\n')}\n\n</details>\n\n`;
	if (flaky.length) md += `<details><summary>Flaky (green on the retry)</summary>\n\n${head}${flaky.map(row).join('\n')}\n\n</details>\n\n`;
	const gone = results.filter((r) => r.status === 'gone');
	if (gone.length) md += `Listed but gone (refresh tests/e2e/battery.json): ${gone.map((r) => r.name).join(', ')}\n\n`;
	return md;
}

/** @param {string[]} argv */
function report(argv) {
	const dir = path.resolve(argv[0] || '.');
	/** @type {SuiteResult[]} */
	const all = [];
	let of = 0;
	const seen = new Set();
	for (const f of walk(dir).filter((f) => /results-\d+\.json$/.test(f))) {
		const r = JSON.parse(fs.readFileSync(f, 'utf8'));
		of = r.of;
		seen.add(r.shard);
		all.push(...r.results);
	}
	// a red the confirm step saw pass on a fresh runner is a flake of that shard, not a red of the change
	for (const f of walk(dir).filter((f) => /confirm-\d+\.json$/.test(f))) {
		for (const c of JSON.parse(fs.readFileSync(f, 'utf8')).results) {
			const r = all.find((x) => x.name === c.name);
			if (!r || !isRed(r) || !(c.status === 'pass' || c.status === 'flaky')) continue;
			if (r.status === 'notrun') Object.assign(r, { ...c, shard: r.shard, last: `ran in the confirm step — ${c.last}` });
			else Object.assign(r, { status: 'flaky', last: `green on a fresh runner (confirm ${c.secs}s) — ${r.last}` });
		}
	}
	const b = load();
	const missing = Array.from({ length: of || shardCount(b) }, (_, i) => i + 1).filter((s) => !seen.has(s));
	let md = table(all, 'e2e battery');
	const qWarn = quarantine.warnings(quarantine.load(), all, Object.keys(b.suites));
	if (qWarn.length) md += `<details><summary>Quarantine to review (${qWarn.length})</summary>\n\n${qWarn.map((w) => '- ' + w).join('\n')}\n\n</details>\n\n`;
	if (missing.length) md += `**Shards with no results (crashed or cancelled): ${missing.join(', ')}**\n`;
	if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
	else console.log(md);
	// measured seconds, for `refresh --results` on a later day
	fs.writeFileSync(path.join(dir, 'durations.json'), JSON.stringify(Object.fromEntries(all.filter((r) => r.status === 'pass').map((r) => [r.name, r.secs])), null, 1));
	process.exit(all.filter(isRed).length || missing.length ? 1 : 0);
}

/** @param {string} dir @returns {string[]} */
function walk(dir) {
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

// ---------------------------------------------------------------- refresh from battery runs

// One suite per line, so a refresh reads as a diff of names and seconds.
/** @param {Battery} b */
function write(b) {
	/** @param {Record<string, any>} o @param {string} pad */
	const obj = (o, pad) =>
		'{\n' +
		Object.keys(o)
			.sort()
			.map((k) => `${pad}\t${JSON.stringify(k)}: ${JSON.stringify(o[k])}`)
			.join(',\n') +
		`\n${pad}}`;
	const body = [
		`\t"comment": ${JSON.stringify(b.comment || '')}`,
		`\t"refs": ${obj(b.refs, '\t')}`,
		`\t"shards": ${JSON.stringify(b.shards)}`,
		`\t"pc": ${JSON.stringify(b.pc || { games: [], levels: [] })}`,
		`\t"skip": ${obj(b.skip, '\t')}`,
		`\t"optional": ${obj(b.optional, '\t')}`,
		`\t"setup": ${obj(b.setup, '\t')}`,
		`\t"suites": ${obj(b.suites, '\t')}`
	];
	// the desk battery's keys (battery-desk.cjs): written only when present, so a file without them stays byte-identical
	if (b.modules) body.push(`\t"modules": ${obj(b.modules, '\t')}`);
	if (b.desk) body.push(`\t"desk": ${obj(b.desk, '\t')}`);
	if (b.exclude) body.push(`\t"exclude": ${obj(Object.fromEntries(Object.entries(b.exclude).map(([k, v]) => [k, [...v].sort()])), '\t')}`);
	// battery-tiers (battery-desk.cjs tiers): the tier-1 always-set, shared-core files and caps, kept as written
	for (const k of /** @type {const} */ (['tiers', 'tier1_always', 'tier1_always_files', 'tier1_cap', 'tier1_shared_suites'])) if (b[k] !== undefined) body.push(`\t${JSON.stringify(k)}: ${JSON.stringify(b[k])}`);
	fs.writeFileSync(BATTERY, `{\n${body.join(',\n')}\n}\n`);
}

/** @param {string[]} argv */
function refresh(argv) {
	const b = load();
	const lists = opts(argv, '--list');
	if (lists.length) {
		// the integrator's battery lists ARE the battery: names not in them leave, new ones arrive at 120 s
		const all = lists.flatMap((f) => fs.readFileSync(f, 'utf8').split(/\s+/).filter(Boolean));
		const names = new Set(all.filter((n) => !n.startsWith('MOD:')));
		b.suites = Object.fromEntries([...names].map((n) => [n, b.suites[n] ?? 120]));
		// the modules repo's flights (MOD:x) are the desk battery's, never a runner's
		const mods = all.filter((n) => n.startsWith('MOD:')).map((n) => n.slice(4));
		if (mods.length) b.modules = Object.fromEntries(mods.map((m) => [m, b.modules?.[m] ?? 600]));
		// a suite that joined the battery is no longer excluded
		if (b.exclude) for (const k of Object.keys(b.exclude)) b.exclude[k] = b.exclude[k].filter((/** @type {string} */ n) => !names.has(n));
	}
	/** @type {Record<string, number[]>} */
	const desk = {};
	for (const f of opts(argv, '--summary')) {
		for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
			const m = /^(\S+) rc=0 pass~\d+ fail~\d+ (\d+)s/.exec(line);
			if (m) (desk[m[1]] ||= []).push(Number(m[2]));
		}
	}
	const median = (/** @type {number[]} */ v) => v.sort((x, y) => x - y)[Math.floor(v.length / 2)];
	// a desk second is about two runner seconds (measured: the e2e-smoke suites on ubuntu-latest vs the Deck)
	for (const [n, v] of Object.entries(desk)) if (n in b.suites) b.suites[n] = Math.round(2 * median(v));
	// --results <dir>...: seconds measured on the runners, the MEDIAN across every durations.json found — one
	// suite's time moves by half from run to run on a shared runner, so a single run balances badly
	/** @type {Record<string, number[]>} */
	const ran = {};
	for (const dir of opts(argv, '--results'))
		for (const f of walk(path.resolve(dir)).filter((f) => f.endsWith('durations.json')))
			for (const [n, s] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')))) (ran[n] ||= []).push(Number(s));
	for (const [n, v] of Object.entries(ran)) if (n in b.suites) b.suites[n] = Math.round(median(v));
	// --red <dir>... --reason "…": suites red in those runs' results (fail / timeout / flaky) become optional with
	// the reason — for runs on unchanged code, i.e. what this runner cannot pass reliably. --green <dir>: a suite
	// that passed there is never moved.
	const redDirs = opts(argv, '--red');
	if (redDirs.length) {
		const reason = opt(argv, '--reason') || 'red on the GitHub runner (SwiftShader) with unchanged code';
		/** @param {string} dir @param {(r: SuiteResult) => boolean} f */
		const names = (dir, f) => new Set(walk(path.resolve(dir)).filter((x) => /results-\d+\.json$/.test(x)).flatMap((x) => JSON.parse(fs.readFileSync(x, 'utf8')).results.filter(f).map((/** @type {SuiteResult} */ r) => r.name)));
		const green = new Set(opts(argv, '--green').flatMap((d) => [...names(d, (r) => r.status === 'pass' || r.status === 'flaky')]));
		for (const d of redDirs)
			for (const n of names(d, (r) => r.status === 'fail' || r.status === 'timeout' || r.status === 'flaky')) if (n in b.suites && !green.has(n) && !(n in b.optional)) b.optional[n] = reason;
	}
	for (const k of Object.keys(b.optional)) if (!(k in b.suites)) delete b.optional[k];
	write(b);
	console.log(`battery.json: ${Object.keys(b.suites).length} suites, ${Object.keys(b.skip).length} skipped, ${Object.keys(b.optional).length} optional, ${shardCount(b)} shards`);
	for (const w of quarantine.warnings(quarantine.load(), [], Object.keys(b.suites))) console.log('warning: ' + w);
}

// ---------------------------------------------------------------- plan

function plan() {
	const b = load();
	let line = '';
	for (const set of /** @type {BatterySet[]} */ (['required', 'optional'])) {
		const of = shardCount(b, set);
		const include = assign(b, of, set).map((s, i) => ({ shard: i + 1, of, suites: s.suites.length, est: Math.round(s.secs / 60 / (b.shards.par || 1)) }));
		const key = set === 'required' ? 'matrix' : 'optional_matrix';
		// an empty matrix is an error in a workflow: the optional job skips on optional_shards=0 instead
		line += `${key}=${JSON.stringify({ include: include.length ? include : [{ shard: 0, of: 0, suites: 0, est: 0 }] })}\n${set}_shards=${of}\n`;
		console.log(`${set}: ${of} shards\n` + include.map((s) => `  shard ${s.shard}: ${s.suites} suites ~${s.est} min`).join('\n'));
	}
	if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, line);
}

if (require.main === module) {
	const [cmd, ...argv] = process.argv.slice(2);
	if (cmd === 'plan') plan();
	else if (cmd === 'run') run(argv);
	else if (cmd === 'report') report(argv);
	else if (cmd === 'refresh') refresh(argv);
	else {
		console.error('usage: battery.cjs plan | run --shard N --of M [--set required|optional|all|confirm --from <dir>] [--serve] [--port P] [--par K] [--deadline MIN] [--only a,b] | report <dir> | refresh [--list f] [--summary f] [--results dir] [--red dir --reason r [--green dir]]');
		process.exit(2);
	}
}

module.exports = { load, assign, shardCount, runnable, counts };
