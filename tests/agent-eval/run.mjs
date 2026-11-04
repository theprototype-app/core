#!/usr/bin/env node
// Roadmap 85 eval set — every request in requests.json, one fresh `claude -p` each, against the mock
// connector (mock-connector.mjs) listing ONE Worker catalog; scored pass / partial / fail from the calls.
//
//   node tests/agent-eval/run.mjs <label> <worker tools.json> <worker src/catalog.js> <out dir> [--jobs 3] [--model sonnet] [--only a,b]
//
// Run it for the live catalog AND the release's (same model, same day) and put both scores in STATUS and the
// release notes: the point is to catch a tool listing that makes Claude pick worse, not an absolute number.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [label, catalogFile, policyFile, outDir] = process.argv.slice(2);
if (!outDir) throw new Error('usage: run.mjs <label> <worker tools.json> <worker src/catalog.js> <out dir>');
const opt = (name, def) => {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : def;
};
const jobs = Number(opt('--jobs', '3'));
const model = opt('--model', 'sonnet');
const only = opt('--only', '') ? new Set(opt('--only', '').split(',')) : null;
const { requests } = JSON.parse(fs.readFileSync(path.join(HERE, 'requests.json'), 'utf8'));
const policy = await import(pathToFileURL(path.resolve(policyFile)).href);
const catalog = policy.compileCatalog(JSON.parse(fs.readFileSync(catalogFile, 'utf8')));
const dir = path.resolve(outDir, label);
fs.mkdirSync(dir, { recursive: true });
// an empty folder OUTSIDE any repo: from inside one, `claude -p` loads its CLAUDE.md (core's is ~200k tokens)
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-eval-'));

/** calls that only look never count against a request */
const READS = new Set(['list_scene', 'status', 'screenshot', 'where_are_users', 'describe_node_types', 'what_can_you_do', 'list_materials', 'get_material', 'describe_shader_nodes', 'get_post', 'wait_for_edit', 'search_assets', 'list_hud', 'get_environment', 'inspect_runtime', 'validate_scene', 'logs']);

const SYSTEM =
	'You are Claude in the claude.ai app, talking with a person (often by voice). The theprototype connector is connected to their open ' +
	'theprototype.app tab. Its server instructions:\n' +
	catalog.instructions +
	'\nDo what the person asks with the tools, then answer in one or two short spoken sentences.';

/** @param {any} r */
function run(r) {
	const log = path.join(dir, r.id + '.jsonl');
	fs.rmSync(log, { force: true });
	const cfg = path.join(dir, r.id + '.mcp.json');
	fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { theprototype: { command: process.execPath, args: [path.join(HERE, 'mock-connector.mjs'), path.resolve(catalogFile), path.resolve(policyFile), log] } } }));
	const prompt = (r.setup ? '(Earlier in this conversation: ' + r.setup + ')\n\n' : '') + r.say;
	const args = ['-p', prompt, '--model', model, '--mcp-config', cfg, '--strict-mcp-config', '--allowedTools', 'mcp__theprototype', '--tools', '', '--setting-sources', 'project', '--disable-slash-commands', '--no-session-persistence', '--system-prompt', SYSTEM, '--max-turns', '8', '--output-format', 'json'];
	return new Promise((done) => {
		const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		child.stdout.on('data', (d) => (out += d));
		child.stderr.on('data', (d) => (out += d));
		child.on('close', (code) => {
			fs.writeFileSync(path.join(dir, r.id + '.out.json'), out);
			done({ code, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [] });
		});
	});
}

/** @param {any} want @param {any} c @param {any[]} before */
const matches = (want, c, before) => c.tool === want.tool && (!want.action || c.action === want.action) && !c.error && (!want.after || before.some((b) => b.tool === want.after));
/** @param {any} c */
const isRead = (c) => READS.has(c.tool) || READS.has(c.fine);

/** @param {any} r @param {any[]} calls @returns {'pass'|'partial'|'fail'} */
export function score(r, calls) {
	for (let i = 0; i < calls.length; i++) {
		if (!r.pass.some((w) => matches(w, calls[i], calls.slice(0, i)))) continue;
		const wrongFirst = calls.slice(0, i).some((c) => c.error || !isRead(c));
		return wrongFirst ? 'partial' : 'pass';
	}
	if ((r.partial ?? []).some((w) => calls.some((c, i) => matches(w, c, calls.slice(0, i))))) return 'partial';
	// a family call that reached the right family with a refused action still found the right tool
	if (r.pass.some((w) => calls.some((c) => c.tool === w.tool && w.action && c.error))) return 'partial';
	return 'fail';
}

const todo = requests.filter((r) => !only || only.has(r.id));
/** @type {Record<string, any>} */
const results = {};
let next = 0;
await Promise.all(
	Array.from({ length: Math.max(1, jobs) }, async () => {
		while (next < todo.length) {
			const r = todo[next++];
			const got = await run(r);
			results[r.id] = { score: score(r, got.calls), calls: got.calls.map((c) => c.tool + (c.action ? '{' + c.action + '}' : '') + (c.error ? ' ✗' : '')), code: got.code };
			console.log(label.padEnd(8), r.id.padEnd(14), results[r.id].score.padEnd(8), results[r.id].calls.join(' → '));
		}
	})
);
const tally = { pass: 0, partial: 0, fail: 0 };
for (const r of Object.values(results)) tally[/** @type {'pass'|'partial'|'fail'} */ (r.score)]++;
const total = todo.length;
const points = tally.pass + tally.partial / 2;
const summary = { label, model, catalog: catalog.version, tools: catalog.tools.length, when: new Date().toISOString(), ...tally, points, of: total, results };
fs.writeFileSync(path.join(dir, 'score.json'), JSON.stringify(summary, null, '\t'));
console.log(`${label}: ${tally.pass} pass, ${tally.partial} partial, ${tally.fail} fail = ${points}/${total} (${catalog.tools.length} tools, ${model})`);
