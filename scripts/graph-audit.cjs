#!/usr/bin/env node
// @ts-nocheck — a report generator over source text and scene zips, no app types involved
// scripts/graph-audit.cjs — roadmap 36 (36-dataflow, flow-revamp 199): the node catalog audit
// and the READABILITY probe for game graphs.
//
//   node scripts/graph-audit.cjs --catalog            markdown table of every core node type
//   node scripts/graph-audit.cjs --scenes a.tpscene … per-scene readability table (+ --json)
//
// The catalog half reads SOURCE TEXT (nodeCatalog imports moduleSDK, which imports the whole
// app, so it cannot be imported from node): the palette list, the card map in Nodes.svelte,
// the evaluator's `case` labels and the `valueTypes` list in flowRuntime, flowSockets' OUTPUT
// table and nodeDocs. It flags what the user hits as "a node that does nothing": a value type
// with no evaluator case (the wire looks right and reads undefined — DEVX #22's hudbutton), a
// palette type with no card (renders as "install the module"), no doc line.
//
// The scene half is the user's complaint made measurable ("nodes do not represent game logic,
// often not connected, cannot be double-clicked to see the code, functionality hidden
// elsewhere"): islands, isolated nodes, display-only wiring, module-owned node types (logic
// that lives in a module file), code nodes a user can open. 36-games-graphs runs it before
// and after regenerating a template.

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (/** @type {string} */ p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** @returns {{type: string, group: string, label: string, inputs: string[], params: string[], note: boolean}[]} */
function catalogTypes() {
	const src = read('src/lib/nodeCatalog.js');
	const out = [];
	let group = '';
	const lines = src.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const g = lines[i].match(/^\t\tgroup: '([^']+)'/);
		if (g) group = g[1];
		const t = lines[i].match(/\btype: '([a-z0-9_-]+)'/);
		if (!t || !group) continue;
		// the item literal: from this line to the line that closes it (brace depth back to 0)
		// a one-line item opens its brace on this line; a multi-line item opened it on the line
		// above (`{` alone), so the walk starts inside it at depth 1
		const start = lines[i].lastIndexOf('{', lines[i].indexOf('type:'));
		let depth = start < 0 ? 1 : 0;
		let body = '';
		for (let j = i; j < lines.length && j < i + 60; j++) {
			const chunk = j === i ? lines[j].slice(Math.max(0, start)) : lines[j];
			body += chunk + '\n';
			for (const ch of chunk) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
			if (depth <= 0 && j >= i) break;
		}
		const label = (body.match(/label: '([^']+)'/) || [])[1] ?? t[1];
		const inputs = ((body.match(/inputs: \[([^\]]*)\]/) || [])[1] ?? '')
			.split(',')
			.map((s) => s.trim().replace(/'/g, ''))
			.filter(Boolean);
		const params = [...body.matchAll(/key: '([^']+)'/g)].map((m) => m[1]);
		out.push({ type: t[1], group, label, inputs, params, note: /\bnote:/.test(body) });
	}
	// a type spelled twice (inside an options literal etc.) keeps its first row
	const seen = new Set();
	return out.filter((r) => (seen.has(r.type) ? false : (seen.add(r.type), true)));
}

function cardMap() {
	const src = read('src/components/editors/Nodes.svelte');
	const block = src.slice(src.indexOf('const CORE_NODE_TYPES'), src.indexOf('};', src.indexOf('const CORE_NODE_TYPES')));
	return Object.fromEntries([...block.matchAll(/^\s*'?([a-z0-9_-]+)'?: (\w+),/gm)].map((m) => [m[1], m[2]]));
}

function evaluatorInfo() {
	const src = read('src/lib/flowRuntime.js');
	const a = src.indexOf('function evalNodeBody');
	const b = src.indexOf('export function resolveInputs');
	const cases = new Set([...src.slice(a, b).matchAll(/case '([a-z0-9_-]+)'/g)].map((m) => m[1]));
	const vt = src.slice(src.indexOf('export const valueTypes'), src.indexOf('];', src.indexOf('export const valueTypes')));
	const valueTypes = new Set([...vt.matchAll(/'([a-z0-9_-]+)'/g)].map((m) => m[1]));
	return { cases, valueTypes };
}

function outputTable() {
	const src = read('src/lib/flowSockets.js');
	const block = src.slice(src.indexOf('const OUTPUT = {'), src.indexOf('};', src.indexOf('const OUTPUT = {')));
	return Object.fromEntries([...block.matchAll(/([a-z0-9_-]+): '([a-z0-9]+)'/g)].map((m) => [m[1], m[2]]));
}

function docKeys() {
	const src = read('src/lib/nodeDocs.js');
	return new Set([...src.matchAll(/^\t'?([a-z0-9_-]+)'?:/gm)].map((m) => m[1]));
}

function catalogReport() {
	const types = catalogTypes();
	const cards = cardMap();
	const { cases, valueTypes } = evaluatorInfo();
	const outs = outputTable();
	const docs = docKeys();
	const rows = [];
	const flags = { noCard: [], valueNoEval: [], evalNotListed: [], noDoc: [], noOutType: [] };
	for (const t of types) {
		const f = [];
		if (!cards[t.type]) (f.push('NO CARD'), flags.noCard.push(t.type));
		if (valueTypes.has(t.type) && !cases.has(t.type)) (f.push('VALUE WITHOUT EVALUATOR'), flags.valueNoEval.push(t.type));
		if (cases.has(t.type) && !valueTypes.has(t.type) && !['script', 'number', 'slider', 'colorpicker', 'objectselector', 'switcher'].includes(t.type))
			(f.push('evaluated but not a listed value source'), flags.evalNotListed.push(t.type));
		if (!docs.has(t.type)) (f.push('no doc'), flags.noDoc.push(t.type));
		if (!outs[t.type]) flags.noOutType.push(t.type);
		rows.push(
			`| ${t.type} | ${t.group} | ${cards[t.type] ?? '—'} | ${outs[t.type] ?? '—'} | ${t.inputs.join(' ') || '—'} | ${t.params.join(' ') || '—'} | ${cases.has(t.type) ? 'yes' : '—'} | ${f.join('; ') || 'OK'} |`
		);
	}
	return { types, flags, rows };
}

// ---------------------------------------------------------------- scenes
const DISPLAY = new Set(['hudtext', 'hudbutton', 'hudscreen', 'hudbar', 'hudtimer', 'hudrows', 'leaderboard', 'hudinput', 'hudset', 'announce']);
const CODE = new Set(['script', 'behaviour', 'customnode', 'coderef']);

function sceneReport(file, core) {
	const { unzipSync, strFromU8 } = require('fflate');
	const zip = unzipSync(fs.readFileSync(file));
	const s = JSON.parse(strFromU8(zip['session.json']));
	const graphs = s.graphs && Object.keys(s.graphs).length ? s.graphs : { scene: { nodes: s.nodes ?? [], edges: s.edges ?? [] } };
	const modules = (s.modules ?? []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
	let N = [];
	let E = [];
	for (const [gid, g] of Object.entries(graphs)) {
		N = N.concat((g.nodes ?? []).map((n) => ({ ...n, __graph: gid })));
		E = E.concat(g.edges ?? []);
	}
	const adj = new Map(N.map((n) => [n.id, new Set()]));
	for (const e of E) {
		adj.get(e.source)?.add(e.target);
		adj.get(e.target)?.add(e.source);
	}
	const seen = new Set();
	const comps = [];
	for (const n of N) {
		if (seen.has(n.id)) continue;
		let size = 0;
		const stack = [n.id];
		while (stack.length) {
			const id = stack.pop();
			if (seen.has(id)) continue;
			seen.add(id);
			size++;
			stack.push(...(adj.get(id) ?? []));
		}
		comps.push(size);
	}
	const isolated = N.filter((n) => !(adj.get(n.id)?.size));
	const moduleTypes = N.filter((n) => !core.has(n.type) && !n.type.startsWith('kit-') && !CODE.has(n.type));
	const display = N.filter((n) => DISPLAY.has(n.type));
	const code = N.filter((n) => CODE.has(n.type));
	const kit = N.filter((n) => n.type.startsWith('kit-'));
	// "display wiring": a pair whose only job is module value -> HUD text
	const displayPairs = E.filter((e) => {
		const a = N.find((n) => n.id === e.source);
		const b = N.find((n) => n.id === e.target);
		return a && b && !core.has(a.type) && DISPLAY.has(b.type);
	}).length;
	const largest = Math.max(0, ...comps);
	return {
		scene: path.basename(file).replace(/\.tpscene$/, ''),
		modules,
		nodes: N.length,
		edges: E.length,
		graphs: Object.keys(graphs).length,
		islands: comps.length,
		largestPct: N.length ? Math.round((100 * largest) / N.length) : 0,
		isolated: isolated.length,
		displayPct: N.length ? Math.round((100 * display.length) / N.length) : 0,
		displayPairs,
		moduleNodes: moduleTypes.length,
		moduleTypes: [...new Set(moduleTypes.map((n) => n.type))],
		kitNodes: kit.length,
		codeNodes: code.length,
		mainLinks: N.filter((n) => n.data?.main).length
	};
}

function main() {
	const args = process.argv.slice(2);
	if (args.includes('--catalog')) {
		const { types, flags, rows } = catalogReport();
		console.log(`# Core node catalog — ${types.length} palette types\n`);
		console.log('| type | group | card | out | inputs | params | evaluator | verdict |');
		console.log('|---|---|---|---|---|---|---|---|');
		rows.forEach((r) => console.log(r));
		console.log('\n## Flags');
		for (const [k, v] of Object.entries(flags)) console.log(`- **${k}** (${v.length}): ${v.join(', ') || '—'}`);
		return;
	}
	const si = args.indexOf('--scenes');
	if (si >= 0) {
		const core = new Set(catalogTypes().map((t) => t.type));
		const files = args.slice(si + 1).filter((a) => !a.startsWith('--'));
		const reports = files.map((f) => sceneReport(f, core));
		if (args.includes('--json')) return console.log(JSON.stringify(reports, null, 1));
		console.log('| scene | modules | nodes | edges | islands | largest island | isolated | HUD share | module→HUD wires | module-owned nodes | kit | code nodes | Main links |');
		console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
		for (const r of reports)
			console.log(
				`| ${r.scene} | ${r.modules.join(' ')} | ${r.nodes} | ${r.edges} | ${r.islands} | ${r.largestPct}% | ${r.isolated} | ${r.displayPct}% | ${r.displayPairs} | ${r.moduleNodes} (${r.moduleTypes.join(' ')}) | ${r.kitNodes} | ${r.codeNodes} | ${r.mainLinks} |`
			);
		return;
	}
	console.log('usage: graph-audit.cjs --catalog | --scenes <file.tpscene ...> [--json]');
}

if (require.main === module) main();
module.exports = { catalogReport, sceneReport, catalogTypes };
