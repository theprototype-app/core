#!/usr/bin/env node
// deps-auto — THE E2E BATTERY, SHARDED, ON GITHUB-HOSTED RUNNERS.
//
// The battery is the list an integrator runs before a release: tests/e2e/battery.json holds it
// (suite → seconds measured on a GitHub runner, or twice the desk time until one has run), the
// suites a public runner must skip (`skip`: they need the self-hosted signaling box, a hosts-file
// origin or a built app) and the ones that run but do not gate (`optional`: red or flaky on
// SwiftShader with the same red on the unchanged base — the reason is on the line). Nothing here
// names a suite; the list is data, refreshed from the integrators' battery runs (`refresh`).
//
//   node scripts/ci/battery.cjs plan                      # matrix JSON for GITHUB_OUTPUT
//   node scripts/ci/battery.cjs run --shard 3 --of 14     # run one shard (serves the app itself)
//   node scripts/ci/battery.cjs report <results-dir>      # merge shard results → summary, exit 1 on a required red
//   node scripts/ci/battery.cjs refresh [--list f]... [--summary f]... [--results dir]
//
// Sharding is longest-first onto the least-loaded shard, by name on ties: every shard computes the
// same assignment from the same file, so the plan job only has to say how many shards there are.
// A failed suite runs once more; green on the retry = `flaky` (reported, not a red).

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const BATTERY = path.join(ROOT, 'tests', 'e2e', 'battery.json');

/**
 * @typedef {{ comment?: string, refs: Record<string, {repo: string, ref: string}>, shards: {target_minutes: number, max: number, min: number},
 *   pc?: {games: string[], levels: string[]}, skip: Record<string, string>, optional: Record<string, string>, setup: Record<string, string>,
 *   suites: Record<string, number>, modules?: Record<string, number>, desk?: Record<string, string[]>, exclude?: Record<string, string[]> }} Battery
 * @typedef {{ name: string, status: 'pass'|'flaky'|'fail'|'timeout'|'gone', required: boolean, rc: number|null, secs: number,
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

/** @param {Battery} b @returns {number} */
function shardCount(b) {
	const env = Number(process.env.BATTERY_SHARDS || 0);
	if (env > 0) return env;
	const total = runnable(b).reduce((t, [, s]) => t + s, 0);
	const n = Math.ceil(total / (b.shards.target_minutes * 60));
	return Math.max(b.shards.min, Math.min(b.shards.max, n));
}

/** @param {Battery} b @param {number} of @returns {{suites: string[], secs: number}[]} */
function assign(b, of) {
	const shards = Array.from({ length: of }, () => ({ suites: /** @type {string[]} */ ([]), secs: 0 }));
	for (const [name, secs] of runnable(b)) {
		let best = 0;
		for (let i = 1; i < of; i++) if (shards[i].secs < shards[best].secs) best = i;
		shards[best].suites.push(name);
		shards[best].secs += secs;
	}
	return shards;
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

/** @param {string} name @param {number} est @param {string} out @param {string} tag */
function runSuite(name, est, out, tag) {
	const file = path.join(ROOT, 'tests', 'e2e', name + '.test.cjs');
	const ev = path.join(out, 'evidence', name);
	fs.mkdirSync(ev, { recursive: true });
	const logFile = path.join(out, 'logs', `${name}${tag}.log`);
	const log = fs.openSync(logFile, 'w');
	// every evidence variable the suites read points OUTSIDE the served tree (an .html artefact
	// inside it full-reloads the app mid-test) and is kept only when the suite fails
	const env = { ...process.env, EVIDENCE_DIR: ev, EVIDENCE: ev, OUT: ev, SHOT_DIR: ev, SHOTS_DIR: ev };
	const timeout = Math.min(1800, Math.max(300, Math.round(est * 3))) * 1000;
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
			resolve({ rc: timedOut ? null : code, secs: Math.round((Date.now() - t0) / 1000), timedOut, ...counts(text) });
		});
	});
}

/** @param {string[]} argv */
async function run(argv) {
	const b = load();
	const of = Number(opt(argv, '--of') || shardCount(b));
	const shard = Number(opt(argv, '--shard') || 1);
	const out = path.resolve(opt(argv, '--out') || process.env.BATTERY_OUT || path.join(ROOT, '..', 'battery-out'));
	const port = Number(opt(argv, '--port') || 5173);
	const only = opt(argv, '--only');
	fs.mkdirSync(path.join(out, 'logs'), { recursive: true });
	const mine = only ? only.split(',') : assign(b, of)[shard - 1].suites;
	const url = process.env.APP_URL || `https://localhost:${port}/`;
	let server = argv.includes('--serve') ? await serve(port, path.join(out, 'logs', 'dev-server.log')) : null;
	/** @type {SuiteResult[]} */
	const results = [];
	console.log(`shard ${shard}/${of}: ${mine.length} suites, est ${Math.round(mine.reduce((t, s) => t + (b.suites[s] || 60), 0) / 60)} min`);
	for (const name of mine) {
		const required = !(name in b.optional);
		if (!fs.existsSync(path.join(ROOT, 'tests', 'e2e', name + '.test.cjs'))) {
			results.push({ name, status: 'gone', required: false, rc: null, secs: 0, pass: 0, fail: 0, last: 'no such suite (refresh battery.json)', shard });
			continue;
		}
		// a dead dev server turns every later suite red for the wrong reason: bring it back first
		if (server && !(await reachable(url))) {
			console.log(`[battery] dev server unreachable before ${name}: restarting`);
			stop(server);
			server = await serve(port, path.join(out, 'logs', 'dev-server.log'));
		}
		// a suite's extra install happens once, on the shard that holds it
		if (b.setup[name] === 'agent' && !fs.existsSync(path.join(ROOT, 'tools', 'agent', 'node_modules'))) {
			spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: path.join(ROOT, 'tools', 'agent'), stdio: 'inherit' });
		}
		const est = b.suites[name] || 60;
		let r = await runSuite(name, est, out, '');
		/** @type {SuiteResult['status']} */
		let status = r.rc === 0 ? 'pass' : r.timedOut ? 'timeout' : 'fail';
		/** @type {number|undefined} */
		let retrySecs;
		if (status !== 'pass') {
			const again = await runSuite(name, est, out, '.retry');
			retrySecs = again.secs;
			if (again.rc === 0) status = 'flaky';
			else r = again;
		}
		const res = { name, status, required, rc: r.rc, secs: r.secs, retrySecs, pass: r.pass, fail: r.fail, last: r.last, shard };
		results.push(res);
		if (status === 'pass' || status === 'flaky') fs.rmSync(path.join(out, 'evidence', name), { recursive: true, force: true });
		console.log(`${name} ${status}${required ? '' : ' (optional)'} rc=${r.rc} pass~${r.pass} fail~${r.fail} ${r.secs}s${retrySecs ? ` retry ${retrySecs}s` : ''} :: ${r.last}`);
	}
	stop(server);
	fs.writeFileSync(path.join(out, `results-${shard}.json`), JSON.stringify({ shard, of, results }, null, 1));
	const red = results.filter((r) => r.required && (r.status === 'fail' || r.status === 'timeout'));
	if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, table(results, `Shard ${shard}/${of}`));
	process.exit(red.length ? 1 : 0);
}

// ---------------------------------------------------------------- the report

/** @param {SuiteResult[]} results @param {string} title */
function table(results, title) {
	const red = results.filter((r) => r.status === 'fail' || r.status === 'timeout');
	const req = red.filter((r) => r.required);
	const opt = red.filter((r) => !r.required);
	const flaky = results.filter((r) => r.status === 'flaky');
	const secs = results.reduce((t, r) => t + r.secs + (r.retrySecs || 0), 0);
	const row = (/** @type {SuiteResult} */ r) => `| ${r.name} | ${r.status} | ${r.shard} | ${r.pass}/${r.fail} | ${r.secs}s | ${r.last.replace(/\|/g, '\\|')} |`;
	const head = '| suite | status | shard | ✓/✗ | time | last line |\n|---|---|---|---|---|---|\n';
	let md = `### ${title}: ${results.length} suites, ${req.length} required red, ${opt.length} optional red, ${flaky.length} flaky (${Math.round(secs / 60)} suite-min)\n\n`;
	if (req.length) md += `**Required reds**\n\n${head}${req.map(row).join('\n')}\n\n`;
	if (opt.length) md += `<details><summary>Optional reds (do not gate)</summary>\n\n${head}${opt.map(row).join('\n')}\n\n</details>\n\n`;
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
	const b = load();
	const missing = Array.from({ length: of || shardCount(b) }, (_, i) => i + 1).filter((s) => !seen.has(s));
	let md = table(all, 'e2e battery');
	if (missing.length) md += `**Shards with no results (crashed or cancelled): ${missing.join(', ')}**\n`;
	if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
	else console.log(md);
	// measured seconds, for `refresh --results` on a later day
	fs.writeFileSync(path.join(dir, 'durations.json'), JSON.stringify(Object.fromEntries(all.filter((r) => r.status === 'pass').map((r) => [r.name, r.secs])), null, 1));
	const red = all.filter((r) => r.required && (r.status === 'fail' || r.status === 'timeout'));
	process.exit(red.length || missing.length ? 1 : 0);
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
	const results = opt(argv, '--results');
	if (results) {
		for (const f of walk(path.resolve(results)).filter((f) => f.endsWith('durations.json'))) {
			for (const [n, s] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')))) if (n in b.suites) b.suites[n] = Number(s);
		}
	}
	for (const k of Object.keys(b.optional)) if (!(k in b.suites)) delete b.optional[k];
	write(b);
	console.log(`battery.json: ${Object.keys(b.suites).length} suites, ${Object.keys(b.skip).length} skipped, ${Object.keys(b.optional).length} optional, ${shardCount(b)} shards`);
}

// ---------------------------------------------------------------- plan

function plan() {
	const b = load();
	const of = shardCount(b);
	const shards = assign(b, of);
	const include = shards.map((s, i) => ({ shard: i + 1, of, suites: s.suites.length, est: Math.round(s.secs / 60) }));
	const needs = [...new Set(Object.entries(b.setup).filter(([n]) => n in b.suites && !(n in b.skip)).map(([, v]) => v))];
	const line = `matrix=${JSON.stringify({ include })}\nshards=${of}\nsetup=${needs.join(',')}\n`;
	if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, line);
	console.log(line + include.map((s) => `shard ${s.shard}: ${s.suites} suites ~${s.est} min`).join('\n'));
}

if (require.main === module) {
	const [cmd, ...argv] = process.argv.slice(2);
	if (cmd === 'plan') plan();
	else if (cmd === 'run') run(argv);
	else if (cmd === 'report') report(argv);
	else if (cmd === 'refresh') refresh(argv);
	else {
		console.error('usage: battery.cjs plan | run --shard N --of M [--serve] [--port P] [--only a,b] | report <dir> | refresh [--list f] [--summary f] [--results dir]');
		process.exit(2);
	}
}

module.exports = { load, assign, shardCount, runnable, counts };
