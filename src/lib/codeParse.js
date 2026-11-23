// 36-code (plan 75.4 + B6) — THE CODE WORKSPACE'S PARSE CHECK, split out of codeTabs.js (102-boot-diet).
//
//   - THE PARSE CHECK run on save (75.4) — a Script node body, a behaviour module, JSON,
//   - B6: graph JSON -> a validated replacement graph, or one error with a line. Invalid
//     JSON never applies.
//
// A LEAF that imports acorn (~34 KB gz). Nothing on a page's boot may import it statically: the
// workspace's save path and the problems pane load it on use (codeWorkspace.saveCodeTab awaits it).

import { parse } from 'acorn';

/** @typedef {import('./codeTabs').CodeError} CodeError */

/** @param {any} e @param {number} [lineOffset] @returns {CodeError} */
function acornError(e, lineOffset = 0) {
	const msg = String(e?.message ?? e).replace(/\s*\(\d+:\d+\)\s*$/, '');
	return {
		message: msg,
		line: Math.max(1, (e?.loc?.line ?? 1) - lineOffset),
		col: (e?.loc?.column ?? 0) + 1
	};
}

/**
 * Does this source PARSE? Syntax only — the lint and the runtime say the rest, at their own
 * time. `script` = a Script node body (a function body: a top-level `return` is legal),
 * `behaviour` = an ES module (`export default behaviour({…})`), `json` = JSON.
 * @param {string} code @param {'script' | 'behaviour' | 'json'} kind
 * @returns {CodeError | null}
 */
export function parseCheck(code, kind) {
	const src = String(code ?? '');
	if (kind === 'json') {
		try {
			JSON.parse(src);
			return null;
		} catch (e) {
			return jsonError(src, e);
		}
	}
	try {
		parse(src, {
			ecmaVersion: 'latest',
			sourceType: kind === 'behaviour' ? 'module' : 'script',
			allowReturnOutsideFunction: kind === 'script',
			locations: true
		});
		return null;
	} catch (e) {
		return acornError(e);
	}
}

/** JSON.parse's message -> a line, across engines: V8 says "position N" (newer ones also
 * "line L column C"), Firefox "at line L column C" @param {string} src @param {any} e @returns {CodeError} */
function jsonError(src, e) {
	const message = String(e?.message ?? e);
	const lc = /line (\d+) column (\d+)/i.exec(message);
	if (lc) return { message: cleanJsonMessage(message), line: Number(lc[1]), col: Number(lc[2]) };
	const pos = /position (\d+)/i.exec(message);
	if (pos) {
		const before = src.slice(0, Number(pos[1]));
		const line = before.split('\n').length;
		return {
			message: cleanJsonMessage(message),
			line,
			col: before.length - before.lastIndexOf('\n')
		};
	}
	// current V8 names neither ("Unexpected token '}', ...\"b\": \n}\" is not valid JSON"):
	// JSON is (nearly) a JS expression, so acorn finds the spot; what acorn accepts and JSON
	// does not is a trailing comma or a non-JSON literal, located by pattern
	try {
		parse('(' + src + '\n)', { ecmaVersion: 'latest', locations: true });
	} catch (pe) {
		const at = acornError(pe);
		return {
			message: cleanJsonMessage(message).replace(/, ".*$/s, ''),
			line: at.line,
			col: at.col
		};
	}
	const trailing = /,\s*[}\]]/.exec(src) ?? /'|\bundefined\b|\/\//.exec(src);
	const line = trailing ? src.slice(0, trailing.index).split('\n').length : 1;
	return {
		message: trailing?.[0].startsWith(',') ? 'Trailing comma' : cleanJsonMessage(message),
		line
	};
}
/** @param {string} m */
const cleanJsonMessage = (m) =>
	m.replace(/^JSON\.parse:\s*/, '').replace(/\s*\(line \d+ column \d+\)$/, '');

/** @param {string} src @param {string} needle find the line a node/edge id first appears on */
function lineOf(src, needle) {
	const i = src.indexOf(JSON.stringify(needle));
	return i < 0 ? 1 : src.slice(0, i).split('\n').length;
}

/**
 * Turn an edited graph JSON into the graph to apply — or ONE error naming a line. Nothing
 * here touches a store: the caller applies `nodes`/`edges` and broadcasts the removals.
 * A node with no position keeps the one it had (`current`), or takes a free slot below the
 * graph (the FlowCode rule: xyflow dereferences `node.position` on adopt). Edges must join
 * nodes that exist — a dangling edge is refused rather than drawn to nowhere on every peer.
 * @param {string} text
 * @param {{nodes: any[], edges: any[]}} current the live graph (serialized)
 * @returns {{ok: true, nodes: any[], edges: any[], removedNodes: string[], removedEdges: string[], changed: boolean}
 *   | {ok: false, error: CodeError}}
 */
export function parseGraphJson(text, current) {
	const syntax = parseCheck(text, 'json');
	if (syntax) return { ok: false, error: syntax };
	/** @type {any} */
	const doc = JSON.parse(text);
	const fail = (/** @type {string} */ message, line = 1) => ({
		ok: /** @type {false} */ (false),
		error: { message, line }
	});
	if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.nodes))
		return fail('Expected an object like { "nodes": [...], "edges": [...] }');
	if (doc.edges !== undefined && !Array.isArray(doc.edges))
		return fail('"edges" must be an array', lineOf(text, 'edges'));
	const ids = new Set();
	for (const [i, n] of doc.nodes.entries()) {
		if (!n || typeof n !== 'object' || Array.isArray(n))
			return fail('nodes[' + i + '] is not an object');
		if (typeof n.id !== 'string' || !n.id) return fail('nodes[' + i + '] needs a string "id"');
		if (typeof n.type !== 'string' || !n.type)
			return fail('node "' + n.id + '" needs a string "type"', lineOf(text, n.id));
		if (ids.has(n.id)) return fail('two nodes share the id "' + n.id + '"', lineOf(text, n.id));
		if (
			n.data !== undefined &&
			(typeof n.data !== 'object' || n.data === null || Array.isArray(n.data))
		)
			return fail('node "' + n.id + '": "data" must be an object', lineOf(text, n.id));
		if (
			n.position !== undefined &&
			!(Number.isFinite(n.position?.x) && Number.isFinite(n.position?.y))
		)
			return fail('node "' + n.id + '": "position" must be {x, y} numbers', lineOf(text, n.id));
		ids.add(n.id);
	}
	const edges = doc.edges ?? [];
	const edgeIds = new Set();
	for (const [i, e] of edges.entries()) {
		if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id)
			return fail('edges[' + i + '] needs a string "id"');
		if (edgeIds.has(e.id)) return fail('two edges share the id "' + e.id + '"', lineOf(text, e.id));
		edgeIds.add(e.id);
		if (!ids.has(e.source))
			return fail('edge "' + e.id + '": no node "' + e.source + '"', lineOf(text, e.id));
		if (!ids.has(e.target))
			return fail('edge "' + e.id + '": no node "' + e.target + '"', lineOf(text, e.id));
	}
	const had = new Map((current.nodes ?? []).map((n) => [n.id, n.position]));
	const placed = doc.nodes.filter((/** @type {any} */ n) => n.position);
	const bottom = Math.max(0, ...placed.map((/** @type {any} */ n) => Number(n.position.y) || 0));
	let row = 0;
	const nodes = doc.nodes.map((/** @type {any} */ n) => {
		const out = { ...n, data: n.data ?? {} };
		if (!n.position)
			out.position = had.get(n.id) ?? {
				x: 60 + (row % 4) * 190,
				y: bottom + 130 + Math.floor(row++ / 4) * 130
			};
		return out;
	});
	const removedNodes = (current.nodes ?? []).map((n) => n.id).filter((id) => !ids.has(id));
	const removedEdges = (current.edges ?? []).map((e) => e.id).filter((id) => !edgeIds.has(id));
	const changed =
		JSON.stringify({ nodes: current.nodes ?? [], edges: current.edges ?? [] }) !==
		JSON.stringify({ nodes, edges });
	return { ok: true, nodes, edges, removedNodes, removedEdges, changed };
}
