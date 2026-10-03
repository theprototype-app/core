import { describe, it, expect } from 'vitest';
import fs from 'fs';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';
import {
	graphToText,
	graphsToText,
	textToGraph,
	parseGraphText,
	canonicalEdgeId,
	GraphTextError
} from '../../src/lib/graphText.js';

// 34 D4: the compact graph text must be the SAME DATA as the JSON. The acceptance test is the
// proposal's own exit proof: all seven shipped games' graphs round-trip byte-identically
// (fixture: scripts/graph-text-fixtures.cjs, scenes origin/main = the 1.19 games), and the
// text is the 2.3-2.6x smaller thing §4.2 measured. A fuzz section then covers every shape
// the games do NOT exercise (raw-line fallbacks, quoting, odd ids), because a fixture that
// never contains a case proves nothing about it.

const here = path.dirname(fileURLToPath(import.meta.url));
const GAMES = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, 'fixtures', 'game-graphs.json.gz'))).toString());

/** @param {any} g */
const roundTrip = (g) => textToGraph(graphToText(g));

describe('the seven games round-trip byte-identically', () => {
	/** @type {{game: string, nodes: number, edges: number, json: number, text: number}[]} */
	const rows = [];
	for (const [game, graphs] of Object.entries(GAMES)) {
		it(game, () => {
			for (const [key, graph] of Object.entries(graphs)) {
				const json = JSON.stringify(graph);
				const text = graphToText(graph);
				expect(JSON.stringify(textToGraph(text)), game + '/' + key).toBe(json);
				rows.push({ game, nodes: graph.nodes.length, edges: graph.edges.length, json: json.length, text: text.length });
			}
			// and the whole-world form (sections under @graph) as well
			const back = parseGraphText(graphsToText(graphs));
			expect(back.errors).toEqual([]);
			expect(JSON.stringify(back.graphs)).toBe(JSON.stringify(graphs));
		});
	}
	it('is more than 2x smaller than the JSON on every game, losslessly (measured 2.11-2.38x)', () => {
		// §4.2 measured 2.3-2.6x on the 1.17 graphs; the 1.19 games carry more default-valued
		// params (a HUD Text node spends `format: "", decimals: 0, value: 0`), which the lossless
		// form must keep and the AI view drops (see the defaults test below)
		for (const r of rows) {
			const ratio = r.json / r.text;
			expect(ratio, r.game + ' ratio ' + ratio.toFixed(2)).toBeGreaterThan(2.05);
		}
		// the measurement, for the handover table
		console.log(
			'\n' + rows.map((r) => [r.game, r.nodes, r.edges, r.json, r.text, (r.json / r.text).toFixed(2)].join('\t')).join('\n')
		);
	});
});

describe('the format', () => {
	const g = {
		nodes: [
			{ id: 'n1', type: 'number', position: { x: 10, y: -20.5 }, data: { label: 'Number', type: 'number', value: 3 }, class: 'w-[150px]' },
			{ id: 'vis', type: 'visibility', position: { x: 0, y: 0 }, data: { label: 'Show it' }, class: 'w-[150px]' }
		],
		edges: [{ id: 'e-n1-vis.on', source: 'n1', target: 'vis', targetHandle: 'on' }]
	};
	it('reads like the proposal: id = type "label" {params} @x,y and a.out -> b.in', () => {
		expect(graphToText(g)).toBe(
			'n1 = number+ "Number" {value: 3} @10,-20.5\nvis = visibility "Show it" @0,0\nn1 -> vis.on\n'
		);
	});
	it('the AI view drops layout and default labels, and parses back with them filled', () => {
		const text = graphToText(g, { positions: false, defaultLabel: (t) => (t === 'number' ? 'Number' : '') });
		expect(text).toBe('n1 = number+ {value: 3}\nvis = visibility "Show it"\nn1 -> vis.on\n');
		const back = textToGraph(text, { defaultLabel: (t) => (t === 'number' ? 'Number' : '') });
		expect(back.nodes[0].data).toEqual({ label: 'Number', type: 'number', value: 3 });
		expect(back.nodes[0].class).toBe('w-[150px]');
		expect('position' in back.nodes[0]).toBe(false);
	});
	it('the AI view drops params at their catalog default, and parsing fills them back', () => {
		const defaults = (/** @type {string} */ t) => (t === 'hudtext' ? { element: '', format: '', decimals: 0, value: 0 } : undefined);
		const h = { nodes: [{ id: 't', type: 'hudtext', position: { x: 0, y: 0 }, data: { label: 'Score', element: 'score', format: '', decimals: 0, value: 0 }, class: 'w-[150px]' }], edges: [] };
		const text = graphToText(h, { positions: false, defaults });
		expect(text).toBe('t = hudtext "Score" {element: "score"}\n');
		expect(textToGraph(text, { defaults }).nodes[0].data).toEqual(h.nodes[0].data);
		// the lossless form never drops a default
		expect(graphToText(h, { defaults })).toContain('decimals: 0');
	});
	it('keeps a non-canonical edge id, and mints the canonical one otherwise', () => {
		const e = { id: 'custom', source: 'a', target: 'b' };
		expect(graphToText({ nodes: [], edges: [e] })).toBe('a -> b #custom\n');
		expect(textToGraph('a.x -> b').edges[0]).toEqual({ id: 'e-a.x-b', source: 'a', target: 'b', sourceHandle: 'x' });
		expect(canonicalEdgeId({ source: 'a', target: 'b', targetHandle: 'on' })).toBe('e-a-b.on');
	});
	it('accepts comments, blank lines, trailing commas, and quoted keys', () => {
		const back = textToGraph('// a comment\n\n  a = spin {speed: 2, "odd key": [1, 2,],}\n');
		expect(back.nodes[0]).toEqual({ id: 'a', type: 'spin', data: { speed: 2, 'odd key': [1, 2] }, class: 'w-[150px]' });
	});
	it('reports every bad line with its number, and throws the first from textToGraph', () => {
		const { errors } = parseGraphText('a = spin\nb = spin {x: }\nc -> \nd = spin @1');
		expect(errors.map((e) => e.line)).toEqual([2, 3, 4]);
		expect(() => textToGraph('a = spin {x: }')).toThrow(GraphTextError);
	});
	it('refuses two sections where one graph was expected', () => {
		expect(() => textToGraph('@graph scene\na = spin\n@graph other\nb = spin\n')).toThrow(/one graph/);
	});
	it('kit calls are just node types — dotted names print bare', () => {
		const k = { nodes: [{ id: 'r', type: 'kit.round.start', position: { x: 0, y: 0 }, data: { label: 'Start round' }, class: 'w-[150px]' }], edges: [] };
		expect(graphToText(k)).toBe('r = kit.round.start "Start round" @0,0\n');
		expect(JSON.stringify(roundTrip(k))).toBe(JSON.stringify(k));
	});
});

describe('fuzz: shapes the games never use still round-trip', () => {
	let seed = 1234567;
	const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
	const pick = (/** @type {any[]} */ a) => a[Math.floor(rnd() * a.length)];
	const ids = ['a', 'B_2', 'with-dash', '1abc', 'has.dot', 'sp ace', 'quo"te', 'ünï', '', '__proto__x'];
	const strings = ['', 'plain', 'with "quotes"', 'line\nbreak', 'tab\there', ' sep', 'emoji 🎈', '{not:json}', '-> arrow', '// comment'];
	/** @param {number} depth @returns {any} */
	const value = (depth) => {
		const r = rnd();
		if (depth > 2 || r < 0.3) return pick([0, -1, 1.5, 1e21, 3.14159265358979, true, false, null, pick(strings)]);
		if (r < 0.6) return Array.from({ length: Math.floor(rnd() * 4) }, () => value(depth + 1));
		/** @type {Record<string, any>} */
		const o = {};
		for (let i = 0; i < 3; i++) o[pick(['k', 'two words', '1x', '$ok', 'label', 'type', 'class'])] = value(depth + 1);
		return o;
	};
	const node = () => {
		const type = pick(['spin', 'kit.score.add', 'mod-x-y', 'weird type']);
		/** @type {any} */
		const data = {};
		if (rnd() < 0.7) data.label = rnd() < 0.9 ? pick(strings) : 5;
		if (rnd() < 0.4) data.type = rnd() < 0.8 ? type : 'other';
		for (let i = 0; i < 3; i++) data[pick(['speed', 'code', 'points', 'a b', 'label'])] = value(0);
		/** @type {any} */
		const n = { id: pick(ids), type };
		if (rnd() < 0.9) n.position = { x: Math.round(rnd() * 2000 - 1000) / pick([1, 3, 7]), y: Math.round(rnd() * 900) };
		n.data = data;
		const c = rnd();
		if (c < 0.7) n.class = 'w-[150px]';
		else if (c < 0.85) n.class = pick(['w-[200px]', '', 'x "y"']);
		if (rnd() < 0.05) n.extra = { weird: true }; // forces the raw-line fallback
		if (rnd() < 0.05) return { type, id: n.id, data }; // keys out of order
		return n;
	};
	const edge = () => {
		/** @type {any} */
		const e = { id: '', source: pick(ids), target: pick(ids) };
		if (rnd() < 0.4) e.sourceHandle = pick(['out', 'step1', 'has.dot', 'sp ace']);
		if (rnd() < 0.7) e.targetHandle = pick(['on', 'trigger', 'a', 'odd-1']);
		e.id = rnd() < 0.8 ? canonicalEdgeId(e) : pick(['x1', 'e weird', 'e-a-b']);
		if (rnd() < 0.05) e.type = 'smoothstep';
		if (rnd() < 0.03) e.sourceHandle = '';
		return e;
	};
	it('400 random graphs', () => {
		for (let i = 0; i < 400; i++) {
			const g = {
				nodes: Array.from({ length: Math.floor(rnd() * 8) }, node),
				edges: Array.from({ length: Math.floor(rnd() * 8) }, edge)
			};
			const text = graphToText(g);
			let back;
			try {
				back = textToGraph(text);
			} catch (err) {
				throw new Error('graph ' + i + ' failed to parse: ' + err + '\n' + text);
			}
			expect(JSON.stringify(back), 'graph ' + i + '\n' + text).toBe(JSON.stringify(g));
		}
	});
});
