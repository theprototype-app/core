#!/usr/bin/env node
// Roadmap 2.0 N3a — THE RESULTS EVAL: does what an agent built WORK? (The roadmap 85 eval in core tests/agent-eval
// scores only which TOOL the agent picked.) For each task in tasks.mjs, N runs:
//
//   1. a fresh app page (A, "the person's tab") on APP_URL, its Claude connector paired to a fake relay (the e2e
//      seam tests/e2e/connectorFake.cjs: the tab's REAL dispatcher and tpAgent.exec answer every call);
//   2. the task's start scene, built through the same connector tools;
//   3. a fresh `claude -p` whose only MCP server is connector.mjs: the SHIPPED Worker catalog (cloud
//      worker-mcp, resolved by the Worker's own catalog.js / relay.js), each call relayed into page A;
//   4. the check plays the result (player.mjs): Play, walk, click, keys, a new round, a second peer for the sync
//      tasks, a reload for the "needs a reload" half point. Score 1 / 0.5 / 0;
//   5. recorded per run: score + why, tool calls (+ refused), wall time, tokens + cost, the form the agent wrote
//      (nodes, node text, behaviour), a screenshot of what it built.
//
//   APP_URL=https://theprototype.app:7052/ node eval/results.mjs [--runs 3] [--only a,b] [--model sonnet]
//       [--label baseline] [--out ../../test-results/2.0-n3a/eval] [--cloud <cloud checkout>] [--cloud-ref origin/main]
//       [--catalog-dir <dir with tools.json catalog.js relay.js>] [--max-turns 60] [--agent-timeout 1200]
//       [--no-agent]   (the start scene only: every check must score 0 — the counterfactual)
//       [--script <file.json>]   (instead of a model: a fixed list of {tool, args} per task id — proves a check can pass)
//
// It costs model tokens: NOT part of the release battery. `npm run eval:results` in tools/agent.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TASKS } from './tasks.mjs';
import * as P from './player.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.resolve(HERE, '..', '..', '..');
const req = createRequire(path.join(CORE, 'tests', 'e2e', 'helpers.cjs'));
const h = req('./helpers.cjs');
const { installProvider, fakeRelay, connectorPhase } = req('./connectorFake.cjs');

const argv = process.argv.slice(2);
const opt = (/** @type {string} */ name, /** @type {any} */ def) => {
	const i = argv.indexOf(name);
	return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (/** @type {string} */ name) => argv.includes(name);
const RUNS = Number(opt('--runs', '3'));
const MODEL = opt('--model', 'sonnet');
const LABEL = opt('--label', flag('--no-agent') ? 'start-scenes' : 'baseline');
const OUT = path.resolve(opt('--out', path.join(CORE, 'test-results', '2.0-n3a', 'eval')), LABEL);
const MAX_TURNS = Number(opt('--max-turns', '60'));
const AGENT_TIMEOUT_S = Number(opt('--agent-timeout', '1200'));
const ONLY = opt('--only', '') ? new Set(opt('--only', '').split(',')) : null;
const NO_AGENT = flag('--no-agent');
const SCRIPT = opt('--script', '')
	? JSON.parse(fs.readFileSync(opt('--script', ''), 'utf8'))
	: null;
// --replay <dir>: re-run the tool calls an earlier run RECORDED (<dir>/runs/<task>.r<k>.calls.jsonl) against
// a fresh start scene, no model: how a changed check scores builds agents already made. Ids the old run got
// back are mapped to the new ones by their order in each answer, start-scene uuids by object name.
const REPLAY = opt('--replay', '') ? path.resolve(opt('--replay', '')) : '';
const CLOUD = opt('--cloud', path.resolve(CORE, '..', 'cloud'));
const CLOUD_REF = opt('--cloud-ref', 'origin/main');
/** a smaller page renders faster on a software-GL box; the checks read the scene, not pixels */
const VIEWPORT = { width: Number(opt('--width', '960')), height: Number(opt('--height', '540')) };

fs.mkdirSync(path.join(OUT, 'runs'), { recursive: true });

/** the Worker catalog + its policy + its relay mapping, as shipped (cloud `CLOUD_REF`) or from a folder */
function catalogFiles() {
	const given = opt('--catalog-dir', '');
	if (given)
		return {
			tools: path.join(given, 'tools.json'),
			policy: path.join(given, 'catalog.js'),
			relay: path.join(given, 'relay.js'),
			ref: given
		};
	const dir = path.join(OUT, 'catalog');
	fs.mkdirSync(dir, { recursive: true });
	const show = (/** @type {string} */ p) =>
		execFileSync('git', ['-C', CLOUD, 'show', CLOUD_REF + ':' + p], { maxBuffer: 64 << 20 });
	fs.writeFileSync(path.join(dir, 'tools.json'), show('worker-mcp/catalog/tools.json'));
	fs.writeFileSync(path.join(dir, 'catalog.js'), show('worker-mcp/src/catalog.js'));
	fs.writeFileSync(path.join(dir, 'relay.js'), show('worker-mcp/src/relay.js'));
	const sha = execFileSync('git', ['-C', CLOUD, 'rev-parse', CLOUD_REF]).toString().trim();
	return {
		tools: path.join(dir, 'tools.json'),
		policy: path.join(dir, 'catalog.js'),
		relay: path.join(dir, 'relay.js'),
		ref: 'cloud ' + CLOUD_REF + ' ' + sha.slice(0, 10)
	};
}

/** what claude.ai's model is told (tests/agent-eval/run.mjs, plus the one line a test needs: nobody answers questions) */
function systemPrompt(/** @type {string} */ instructions) {
	return (
		'You are Claude in the claude.ai app, talking with a person (often by voice). The theprototype connector is connected to their open ' +
		'theprototype.app tab. Its server instructions:\n' +
		instructions +
		'\nDo what the person asks with the tools, then answer in one or two short spoken sentences. ' +
		'The person will judge the result by pressing Play and trying it; they are not available for questions, so where something is unclear choose the sensible option and build it.'
	);
}

const FILES = catalogFiles();
const CATALOG = JSON.parse(fs.readFileSync(FILES.tools, 'utf8'));
const SYSTEM = systemPrompt(CATALOG.instructions ?? '');
// scripts and replays call the tab the way the connector does: a family name (hud, run, set_look…) resolves to one
// fine tool first, by the Worker's own catalog.js
const POLICY = await import(pathToFileURL(path.resolve(FILES.policy)).href);
const COMPILED = POLICY.compileCatalog(CATALOG);
/** @param {any} tab @param {string} name @param {any} args */
async function familyCall(tab, name, args) {
	if (!COMPILED.byName.has(name))
		return { type: 'error', error: { code: 'unknown_tool', message: 'Unknown tool: ' + name } };
	const call = POLICY.resolveCall(COMPILED, name, args);
	if ('error' in call) return { type: 'error', error: { code: 'refused', message: call.error } };
	return tab.call(call.tool, call.args);
}

/** a bridge the connector stand-in posts fine calls to; `target` is the page's relay of the run in progress */
function startBridge() {
	/** @type {{call: (tool: string, args: any, timeoutMs: number) => Promise<any>} | null} */
	let target = null;
	const server = http.createServer((rq, rs) => {
		let body = '';
		rq.on('data', (d) => (body += d));
		rq.on('end', async () => {
			let frame;
			try {
				const { tool, args, timeoutMs } = JSON.parse(body);
				frame = target
					? await target.call(tool, args, Number(timeoutMs) || 120000)
					: {
							type: 'error',
							error: { code: 'gone', message: 'No theprototype tab is connected.' }
						};
			} catch (e) {
				frame = {
					type: 'error',
					error: { code: 'failed', message: String(/** @type {any} */ (e)?.message ?? e) }
				};
			}
			rs.writeHead(200, { 'content-type': 'application/json' });
			rs.end(JSON.stringify(frame));
		});
	});
	return new Promise((resolve) =>
		server.listen(0, '127.0.0.1', () => {
			const port = /** @type {any} */ (server.address()).port;
			resolve({
				url: `http://127.0.0.1:${port}/call`,
				set: (/** @type {any} */ t) => (target = t),
				close: () => server.close()
			});
		})
	);
}

/** the person's tab with its connector paired to the fake relay @param {any} browser @param {string} name */
async function personTab(browser, name) {
	const A = await h.setupPage(browser, name, { init: P.evalInit, context: { viewport: VIEWPORT } });
	await A.page.evaluate(() => window.__tp.test.v1.aiAssistantHidden.set(''));
	const relay = await fakeRelay(A.page);
	await installProvider(A.page);
	await A.page.locator('#connect-claude-button').click();
	await h.eventually(
		() => connectorPhase(A),
		(/** @type {string} */ p) => p === 'connected',
		name + ' connector connected',
		30000
	);
	let n = 0;
	/** @param {string} tool @param {any} args @param {number} [timeoutMs] */
	const call = async (tool, args, timeoutMs = 120000) => {
		const id = 'c' + ++n;
		relay.call(id, tool, args ?? {}, 'edit');
		const f = await relay.answer(id, timeoutMs + 5000);
		return (
			f ?? {
				type: 'error',
				error: { code: 'timeout', message: 'The theprototype tab did not answer in time.' }
			}
		);
	};
	return { A, relay, call };
}

/** run `claude -p` for one request @returns {Promise<any>} */
function runAgent(
	/** @type {string} */ say,
	/** @type {string} */ bridgeUrl,
	/** @type {string} */ stem
) {
	const log = stem + '.calls.jsonl';
	fs.rmSync(log, { force: true });
	const cfg = stem + '.mcp.json';
	fs.writeFileSync(
		cfg,
		JSON.stringify({
			mcpServers: {
				theprototype: {
					command: process.execPath,
					args: [
						path.join(HERE, 'connector.mjs'),
						FILES.tools,
						FILES.policy,
						FILES.relay,
						bridgeUrl,
						log
					]
				}
			}
		})
	);
	// an empty folder OUTSIDE any repo (inside core, `claude -p` loads core's CLAUDE.md)
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'n3a-agent-'));
	const args = [
		'-p',
		say,
		'--model',
		MODEL,
		'--mcp-config',
		cfg,
		'--strict-mcp-config',
		'--allowedTools',
		'mcp__theprototype',
		'--tools',
		'',
		'--setting-sources',
		'project',
		'--disable-slash-commands',
		'--no-session-persistence',
		'--system-prompt',
		SYSTEM,
		'--max-turns',
		String(MAX_TURNS),
		'--output-format',
		'json'
	];
	const t0 = Date.now();
	return new Promise((done) => {
		const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (err += d));
		const kill = setTimeout(() => child.kill('SIGTERM'), AGENT_TIMEOUT_S * 1000);
		child.on('close', (code) => {
			clearTimeout(kill);
			fs.writeFileSync(stem + '.agent.json', out + (err ? '\n--- stderr ---\n' + err : ''));
			/** @type {any} */
			let j = null;
			try {
				j = JSON.parse(out);
			} catch {}
			const calls = fs.existsSync(log)
				? fs
						.readFileSync(log, 'utf8')
						.trim()
						.split('\n')
						.filter(Boolean)
						.map((l) => JSON.parse(l))
				: [];
			fs.rmSync(cwd, { recursive: true, force: true });
			done({
				code,
				wallS: Math.round((Date.now() - t0) / 100) / 10,
				out: j,
				calls,
				timedOut: Date.now() - t0 >= AGENT_TIMEOUT_S * 1000 - 500
			});
		});
	});
}

/** the form the agent wrote, from its calls @param {any[]} calls */
function formOf(calls) {
	const ok = calls.filter((c) => !c.error);
	const f = new Set();
	for (const c of ok) {
		if (c.tool === 'create_behaviour' || c.tool === 'edit_behaviour') f.add('behaviour');
		if (c.tool === 'create_flow_nodes' || c.tool === 'update_flow_nodes') {
			if (typeof c.args?.text === 'string' && c.args.text.trim()) f.add('node text');
			if (Array.isArray(c.args?.nodes) && c.args.nodes.length) f.add('nodes');
		}
		if (c.tool === 'hud') f.add('hud');
		if (c.tool === 'game_setup') f.add('game_setup');
	}
	return [...f];
}

/** tokens from `claude -p --output-format json` @param {any} out */
function tokensOf(out) {
	const u = out?.usage ?? {};
	const input = Number(u.input_tokens ?? 0);
	const cacheWrite = Number(u.cache_creation_input_tokens ?? 0);
	const cacheRead = Number(u.cache_read_input_tokens ?? 0);
	const output = Number(u.output_tokens ?? 0);
	return {
		input,
		cacheWrite,
		cacheRead,
		output,
		total: input + cacheWrite + cacheRead + output,
		uncached: input + cacheWrite + output,
		costUsd: Number(out?.total_cost_usd ?? 0),
		turns: Number(out?.num_turns ?? 0)
	};
}

/** frames per second the page draws right now @param {any} page */
const fpsOf = (page) =>
	page
		.evaluate(
			() =>
				new Promise((r) => {
					let n = 0;
					const t0 = performance.now();
					const f = () => (performance.now() - t0 < 1000 ? (n++, requestAnimationFrame(f)) : r(n));
					requestAnimationFrame(f);
				})
		)
		.catch(() => -1);

/** a check with a time box @param {any} task @param {any} C */
async function runCheck(task, C) {
	const box = new Promise((r) =>
		setTimeout(() => r({ score: 0, why: 'check timed out (240 s)' }), 240000)
	);
	try {
		return await Promise.race([task.check(C), box]);
	} catch (e) {
		return {
			score: 0,
			why: 'check error: ' + String(/** @type {any} */ (e)?.message ?? e).slice(0, 300)
		};
	}
}

/** one task, one run @param {any} browser @param {any} bridge @param {any} task @param {number} k */
async function runOne(browser, bridge, task, k) {
	const stem = path.join(OUT, 'runs', `${task.id}.r${k}`);
	const t0 = Date.now();
	/** @type {any[]} */
	const notes = [];
	const tab = await personTab(browser, `A-${task.id}-${k}`);
	const { A } = tab;
	/** @type {Record<string, {uuid: string, name: string}>} */
	const refs = {};
	const S = {
		refs,
		/** @param {string} tool @param {any} args */
		call: async (tool, args) => {
			const f = await tab.call(tool, args);
			if (f.type !== 'result' || f.result?.error)
				throw new Error('setup ' + tool + ': ' + JSON.stringify(f).slice(0, 300));
			return f.result;
		},
		/** @param {any[]} objects */
		make: async (objects) => {
			const r = await S.call('create_objects', { objects });
			const created = r?.created ?? [];
			objects.forEach((o, i) => {
				const c = created.find((/** @type {any} */ x) => x?.name === o.name) ?? created[i];
				if (c?.uuid) refs[o.name] = { uuid: c.uuid, name: o.name };
			});
			return refs;
		}
	};
	let agent = null;
	let B = null;
	/** @type {any} */
	let verdict;
	try {
		await task.setup(S);
		await A.page.waitForTimeout(1500);
		/** @type {Record<string, any>} */
		const base = {};
		for (const [name, ref] of Object.entries(refs)) base[name] = await P.look(A.page, ref);
		// the agent (or a fixed script, or nothing)
		if (REPLAY) {
			const rec = [k, 1]
				.map((n) => path.join(REPLAY, 'runs', `${task.id}.r${n}.calls.jsonl`))
				.find((f) => fs.existsSync(f));
			const old = rec
				? fs
						.readFileSync(rec, 'utf8')
						.split('\n')
						.filter(Boolean)
						.map((l) => JSON.parse(l))
				: [];
			// uuids, and the HUD's own ids (text-1-1h8p, screen-1-azjk)
			const UUID =
				/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[a-z]+-\d+-[a-z0-9]{4}\b/g;
			/** @type {Map<string, string>} */
			const ids = new Map();
			// start-scene objects by name: the old run's own refs (saved since validate2), else whatever an old answer listed
			const oldRow = rec ? rec.replace(/\.calls\.jsonl$/, '.json') : '';
			if (oldRow && fs.existsSync(oldRow))
				for (const [name, r] of Object.entries(
					JSON.parse(fs.readFileSync(oldRow, 'utf8')).refs ?? {}
				))
					if (refs[name] && /** @type {any} */ (r)?.uuid)
						ids.set(/** @type {any} */ (r).uuid, refs[name].uuid);
			// start-scene objects by name, wherever an old answer listed them
			for (const c of old)
				for (const m of String(c.answer ?? '').matchAll(
					/"uuid":"([0-9a-f-]{36})","name":"([^"]+)"/g
				))
					if (refs[m[2]] && !ids.has(m[1])) ids.set(m[1], refs[m[2]].uuid);
			const remap = (/** @type {any} */ x) =>
				JSON.parse(JSON.stringify(x), (_k, val) =>
					typeof val === 'string' ? val.replace(UUID, (u) => ids.get(u) ?? u) : val
				);
			const calls = [];
			for (const c of old) {
				if (['screenshot', 'describe_node_types', 'status'].includes(c.tool)) continue;
				const f = await familyCall(tab, c.tool, remap(c.args));
				const got = JSON.stringify(f.result ?? f).slice(
					0,
					Math.max(600, String(c.answer ?? '').length)
				);
				const was = String(c.answer ?? '').match(UUID) ?? [];
				const now = got.match(UUID) ?? [];
				was.forEach((u, i) => {
					if (now[i] && !ids.has(u)) ids.set(u, now[i]);
				});
				calls.push({
					tool: c.tool,
					action: c.action,
					args: c.args,
					error:
						f.type !== 'result' || f.result?.error ? JSON.stringify(f).slice(0, 300) : undefined
				});
			}
			agent = { code: 0, wallS: 0, out: null, calls, replayed: rec ?? null };
		} else if (SCRIPT) {
			const steps = SCRIPT[task.id] ?? [];
			const calls = [];
			// "$Name" in a script's args = the uuid of the object called Name (start scene or created by the script);
			// "$@3.created.0.id" = a value from step 3's answer; "$@1:onclick" = the id of the first onclick node in it
			/** @type {any[]} */
			const answers = [];
			const find = (/** @type {any} */ x, /** @type {string} */ type) => {
				if (typeof x === 'string') {
					// node text: "<id> = onclick+ {…}"
					const m = x.match(new RegExp('([0-9a-f-]{36}) = ' + type + '\\b'));
					return m ? m[1] : null;
				}
				if (!x || typeof x !== 'object') return null;
				if (x.type === type && typeof x.id === 'string') return x.id;
				for (const v of Object.values(x)) {
					const hit = find(v, type);
					if (hit) return hit;
				}
				return null;
			};
			const fill = (/** @type {any} */ x) =>
				JSON.parse(JSON.stringify(x), (_k, val) => {
					if (typeof val !== 'string' || !val.includes('$')) return val;
					val = val
						.replace(
							/\$@(\d+):([a-z0-9-]+)/g,
							(_m, i, type) => find(answers[Number(i)], type) ?? _m
						)
						.replace(/\$@(\d+)((?:\.[A-Za-z0-9_]+)+)/g, (_m, i, p) => {
							// the path stops at the first string; what follows (".hit") is kept as written
							let o = answers[Number(i)];
							const keys = p.slice(1).split('.');
							for (let j = 0; j < keys.length; j++) {
								o = o?.[keys[j]];
								if (typeof o === 'string')
									return (
										o +
										keys
											.slice(j + 1)
											.map((x) => '.' + x)
											.join('')
									);
							}
							return _m;
						});
					for (const name of Object.keys(refs).sort((a, b) => b.length - a.length))
						val = val.split('$' + name).join(refs[name].uuid);
					return val;
				});
			for (const s of steps) {
				const f = await familyCall(tab, s.tool, fill(s.args));
				answers.push(f.result ?? null);
				for (const c of f.result?.created ?? [])
					if (c?.name && c?.uuid && !refs[c.name]) refs[c.name] = { uuid: c.uuid, name: c.name };
				calls.push({
					tool: s.tool,
					args: s.args,
					error:
						f.type !== 'result' || f.result?.error || f.result?.partial
							? JSON.stringify(f).slice(0, 400)
							: undefined
				});
			}
			agent = { code: 0, wallS: 0, out: null, calls, scripted: true };
		} else if (!NO_AGENT && !REPLAY) {
			bridge.set({ call: tab.call });
			agent = await runAgent(task.say, bridge.url, stem);
			bridge.set(null);
		}
		await A.page.waitForTimeout(1500);
		await P.leavePlay(A.page);
		await A.page.screenshot({ path: stem + '.built.png' }).catch(() => {});
		/** join B to A (A out of Play) */
		const joinB = async () => {
			await P.leavePlay(A.page);
			B = await h.setupPage(browser, `B-${task.id}-${k}`, {
				init: P.evalInit,
				context: { viewport: VIEWPORT }
			});
			await h.connect(B, A);
			await h.caughtUp?.(A, B, 60000).catch(() => {});
			await B.page.waitForTimeout(2000);
			return B.page;
		};
		if (task.sync === 'pair') await joinB();
		const C = {
			A: A.page,
			get B() {
				return B?.page ?? null;
			},
			refs,
			base,
			note: (/** @type {string} */ s) => notes.push(s),
			joinB,
			reload: async () => {
				await h.freshReload(A);
				await h.answerRestore(A, 'restore', 20000).catch(() => false);
				await A.page.waitForTimeout(3000);
			}
		};
		notes.push('fps ' + (await fpsOf(A.page)));
		verdict = await runCheck(task, C);
		if (verdict.score === 0 && !task.sync && task.reloadRetry !== false) {
			notes.push('first try: ' + verdict.why);
			await P.leavePlay(A.page).catch(() => {});
			await A.page.evaluate(() => window.__tp.test.v1.autosave.saveNow?.()).catch(() => {});
			await A.page.waitForTimeout(2500);
			await C.reload();
			const again = await runCheck(task, C);
			if (again.score > 0)
				verdict = { score: 0.5, why: 'works only after a reload: ' + again.why, reloaded: true };
			else notes.push('after a reload: ' + again.why);
		}
	} catch (e) {
		verdict = {
			score: 0,
			why: 'harness error: ' + String(/** @type {any} */ (e)?.message ?? e).slice(0, 300),
			harness: true
		};
	}
	const errors = h.pageErrors?.(A) ?? [];
	await A.page.screenshot({ path: stem + '.checked.png' }).catch(() => {});
	for (const p of [A, B]) await p?.ctx?.close().catch(() => {});
	const calls = agent?.calls ?? [];
	const row = {
		task: task.id,
		run: k,
		score: verdict.score,
		why: verdict.why,
		harness: !!verdict.harness,
		notes,
		calls: calls.length,
		refused: calls.filter((/** @type {any} */ c) => c.error).length,
		tools: calls.map(
			(/** @type {any} */ c) =>
				c.tool + (c.action ? '{' + c.action + '}' : '') + (c.error ? ' ✗' : '')
		),
		form: formOf(calls),
		agentWallS: agent?.wallS ?? 0,
		agentExit: agent?.code ?? null,
		agentTimedOut: !!agent?.timedOut,
		agentStop: agent?.out?.subtype ?? null,
		agentSaid: String(agent?.out?.result ?? '').slice(0, 400),
		tokens: tokensOf(agent?.out),
		totalWallS: Math.round((Date.now() - t0) / 1000),
		pageErrors: errors.slice(0, 5),
		refs,
		callErrors: calls
			.filter((/** @type {any} */ c) => c.error)
			.map((/** @type {any} */ c) => c.tool + ': ' + String(c.error).slice(0, 200))
	};
	fs.writeFileSync(stem + '.json', JSON.stringify(row, null, '\t'));
	console.log(
		`${LABEL} ${task.id.padEnd(15)} r${k}  ${String(row.score).padEnd(4)} ${row.why}  [${row.calls} calls, ${row.refused} refused, ${row.agentWallS}s, ${row.tokens.total} tok, form ${row.form.join('+') || '-'}]`
	);
	return row;
}

/** mean, min, max @param {number[]} xs */
const stats = (xs) => ({
	mean: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0,
	min: Math.min(...xs),
	max: Math.max(...xs)
});

/** the table for STATUS @param {any[]} rows */
function table(rows) {
	const tasks = [...new Set(rows.map((r) => r.task))];
	const runs = [...new Set(rows.map((r) => r.run))].sort();
	const lines = [];
	lines.push(
		`| task | ${runs.map((k) => 'r' + k).join(' | ')} | mean | calls (mean) | refused | agent s (mean) | tokens (mean) | form |`
	);
	lines.push(`|---|${runs.map(() => '---').join('|')}|---|---|---|---|---|---|`);
	for (const t of tasks) {
		const rs = rows.filter((r) => r.task === t);
		const sc = runs.map((k) => rs.find((r) => r.run === k)?.score ?? '-');
		const m = (/** @type {(r: any) => number} */ f) => Math.round(stats(rs.map(f)).mean);
		const forms = [...new Set(rs.flatMap((r) => r.form))].join(', ') || '-';
		lines.push(
			`| ${t} | ${sc.join(' | ')} | ${stats(rs.map((r) => r.score)).mean.toFixed(2)} | ${m((r) => r.calls)} | ${m((r) => r.refused)} | ${m((r) => r.agentWallS)} | ${m((r) => r.tokens.total)} | ${forms} |`
		);
	}
	const perRun = runs.map((k) => rows.filter((r) => r.run === k).reduce((a, r) => a + r.score, 0));
	const s = stats(perRun);
	lines.push('');
	lines.push(
		`**Total** per run: ${perRun.map((x, i) => 'r' + runs[i] + ' ' + x).join(' · ')} of ${tasks.length} → mean **${s.mean.toFixed(2)} / ${tasks.length}**, spread ${s.min}-${s.max} (${(s.max - s.min).toFixed(1)} points).`
	);
	const tok = rows.map((r) => r.tokens);
	const sum = (/** @type {string} */ k) => tok.reduce((a, t) => a + (t[k] ?? 0), 0);
	const n = runs.length || 1;
	lines.push(
		`Tokens per full run (${tasks.length} tasks, mean of ${n}): total ${Math.round(sum('total') / n).toLocaleString('en')} (input ${Math.round(sum('input') / n).toLocaleString('en')}, cache write ${Math.round(sum('cacheWrite') / n).toLocaleString('en')}, cache read ${Math.round(sum('cacheRead') / n).toLocaleString('en')}, output ${Math.round(sum('output') / n).toLocaleString('en')}); uncached (input + cache write + output) ${Math.round(sum('uncached') / n).toLocaleString('en')}; cost reported ${(sum('costUsd') / n).toFixed(2)} USD.`
	);
	return lines.join('\n');
}

// ------------------------------------------------------------------------------------------------ main
const todo = TASKS.filter((t) => !ONLY || ONLY.has(t.id));
const bridge = /** @type {any} */ (await startBridge());
const browser = await h.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const meta = {
	label: LABEL,
	model: NO_AGENT ? null : REPLAY ? 'replay ' + REPLAY : SCRIPT ? 'script' : MODEL,
	appUrl: h.URL,
	catalog: FILES.ref,
	catalogTools: CATALOG.tools?.length,
	coreRef: CATALOG.generator?.coreRef,
	maxTurns: MAX_TURNS,
	runs: RUNS,
	started: new Date().toISOString()
};
fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, '\t'));
console.log('n3a eval', JSON.stringify(meta));
/** @type {any[]} */
const rows = [];
for (let k = 1; k <= RUNS; k++)
	for (const task of todo) {
		rows.push(await runOne(browser, bridge, task, k));
		fs.writeFileSync(path.join(OUT, 'score.json'), JSON.stringify({ ...meta, rows }, null, '\t'));
	}
await browser.close();
bridge.close();
const md = `# N3a results — ${LABEL}\n\n${JSON.stringify(meta)}\n\n${table(rows)}\n`;
fs.writeFileSync(path.join(OUT, 'table.md'), md);
fs.writeFileSync(
	path.join(OUT, 'score.json'),
	JSON.stringify({ ...meta, finished: new Date().toISOString(), rows }, null, '\t')
);
console.log(md);
