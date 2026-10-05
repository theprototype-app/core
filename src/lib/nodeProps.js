// 36 (flow-revamp 200-202, contract G1): the PER-NODE PROPERTY SCHEMA — what the Flow ⚙ panel
// renders for the selected node, for EVERY node type.
//
// A spec's `params` list was already a property schema for the cards that are spec-driven
// (AnimationNode); everything else (Math's op, Number's value, a module node's options, a
// Script's input values, a Behaviour's params) was editable only where its card happened to
// draw a widget, so "change a gameplay number from the graph" depended on which card a node got.
// `propertyRows` answers one question for any node: which keys of its data are its PROPERTIES,
// of what kind, and is each one currently driven by a wire.
//
// Sources, in order (a key appears once, the first source wins):
//   1. the spec's `params` (PropSpec, graphContract.js) — authored labels, ranges, options
//   2. a Script v2's declared inputs: an unwired input's `value` is a property (editing it writes
//      the socket list back — `inputs[i].value`)
//   3. a Behaviour's `params` (from its source, `analyze`): editing rewrites the literal (the
//      knob path — ONE AST edit, one undo entry)
//   4. the spec's `defaults` the params did not name, kind inferred from the default's type
// Keys that are bookkeeping (label/type/note/code/…) are never properties.
//
// A LEAF: it imports nothing; the caller passes the spec, the node's edges and (for a behaviour)
// the analyzed model, so the whole decision is a unit-testable pure function.

/** data keys that are never a property row */
const BOOKKEEPING = new Set([
	'label', 'type', 'note', 'code', 'inputs', 'outputs', 'src', 'main', 'class', 'defId',
	'selected', 'items', 'shape', 'index', 'points', 'graphId', 'flowUuid', 'element', 'vtype'
]);

/** @typedef {import('./graphContract.js').PropSpec} PropSpec */
/**
 * @typedef {{
 *   key: string, kind: string, label: string, value: any, group: string,
 *   min?: number, max?: number, step?: number, options?: string[], doc?: string,
 *   placeholder?: string, maxLength?: number,
 *   wired: boolean, source: 'spec' | 'input' | 'behaviour' | 'default'
 * }} PropRow
 */

/** @param {any} v @returns {string | null} the kind a bare default value implies */
export function inferKind(v) {
	if (typeof v === 'boolean') return 'toggle';
	if (typeof v === 'number') return 'number';
	if (typeof v === 'string') return /^#[0-9a-f]{6}$/i.test(v) ? 'color' : 'text';
	if (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number')) return 'vector3';
	return null;
}

/** the kind a script socket's value edits as @param {string} type */
function socketKind(type) {
	if (type === 'boolean' || type === 'event') return 'toggle';
	if (type === 'vector3') return 'vector3';
	if (type === 'color') return 'color';
	if (type === 'object') return null; // an object input is a wire, never a typed value
	return 'number';
}

/**
 * The property rows of one node.
 * @param {any} node the flow node ({id, type, data})
 * @param {any} spec findNodeSpec(node.type) — null for a type nothing describes
 * @param {any[]} edges the edges INTO this node (any superset is fine; filtered here)
 * @param {{ behaviour?: any }} [extra] `behaviour`: analyze(node.data.code) for a behaviour node
 * @returns {PropRow[]}
 */
export function propertyRows(node, spec, edges, extra = {}) {
	if (!node) return [];
	const data = node.data ?? {};
	const wiredKeys = new Set(
		(edges ?? []).filter((e) => e && e.target === node.id && e.targetHandle).map((e) => e.targetHandle)
	);
	/** @type {PropRow[]} */
	const rows = [];
	const seen = new Set();
	/** @param {PropRow} row */
	const add = (row) => {
		if (seen.has(row.key)) return;
		seen.add(row.key);
		rows.push(row);
	};

	for (const p of /** @type {PropSpec[]} */ (spec?.params ?? [])) {
		if (!p || !p.key) continue;
		add({
			key: p.key,
			kind: p.kind,
			label: p.label ?? p.key,
			value: data[p.key] ?? spec?.defaults?.[p.key],
			group: p.group ?? '',
			min: p.min,
			max: p.max,
			step: p.step,
			options: p.options,
			doc: p.doc,
			placeholder: p.placeholder,
			maxLength: p.maxLength,
			wired: wiredKeys.has(p.key),
			source: 'spec'
		});
	}

	if (node.type === 'script' && Array.isArray(data.inputs))
		for (const s of data.inputs) {
			const kind = socketKind(s?.type);
			if (!s?.name || !kind) continue;
			add({
				key: s.name,
				kind,
				label: s.name,
				value: s.value,
				group: 'Inputs',
				wired: wiredKeys.has(s.name),
				source: 'input'
			});
		}

	if (node.type === 'behaviour' && extra.behaviour?.params)
		for (const p of extra.behaviour.params) {
			if (!p?.key || !p.range) continue; // only literals can be written back
			const kind = p.type === 'number' ? (p.min !== undefined && p.max !== undefined ? 'range' : 'number') : p.type === 'boolean' ? 'toggle' : p.type === 'string' ? 'text' : null;
			if (!kind) continue;
			add({
				key: p.key,
				kind,
				label: p.label ?? p.key,
				value: p.value,
				group: 'Params',
				min: p.min,
				max: p.max,
				step: p.step,
				doc: p.doc,
				wired: false,
				source: 'behaviour'
			});
		}

	for (const [key, def] of Object.entries(spec?.defaults ?? {})) {
		if (BOOKKEEPING.has(key) || seen.has(key)) continue;
		const kind = inferKind(def);
		if (!kind) continue;
		add({ key, kind, label: key, value: data[key] ?? def, group: '', wired: wiredKeys.has(key), source: 'default' });
	}
	return rows;
}

/**
 * Coerce a value typed into the panel to what the row stores. Returns undefined for "not a
 * valid value" (the panel then writes nothing — a half-typed number never replicates).
 * @param {PropRow} row @param {any} raw
 */
export function coerceProp(row, raw) {
	switch (row.kind) {
		case 'range':
		case 'number': {
			const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
			if (!Number.isFinite(n)) return undefined;
			let v = n;
			if (row.kind === 'range' && typeof row.min === 'number' && typeof row.max === 'number')
				v = Math.min(Math.max(v, Math.min(row.min, row.max)), Math.max(row.min, row.max));
			return v;
		}
		case 'toggle':
			return !!raw;
		case 'vector3': {
			const a = Array.isArray(raw) ? raw : String(raw).split(/[ ,]+/);
			const v = a.slice(0, 3).map((x) => parseFloat(String(x)));
			return v.length === 3 && v.every(Number.isFinite) ? v : undefined;
		}
		case 'color':
			return /^#[0-9a-f]{6}$/i.test(String(raw)) ? String(raw) : undefined;
		case 'select':
			return row.options && !row.options.includes(String(raw)) ? undefined : String(raw);
		default: {
			const s = String(raw ?? '');
			return row.maxLength ? s.slice(0, row.maxLength) : s;
		}
	}
}

/**
 * The node-data PATCH that sets one row (for 'spec' / 'default' rows: `{key: value}`; for a
 * script input: the socket list with that entry's value replaced). A behaviour row is NOT a data
 * patch — its caller rewrites the source literal (analyze.setParamLiteral).
 * @param {any} node @param {PropRow} row @param {any} value
 * @returns {Record<string, any> | null}
 */
export function propPatch(node, row, value) {
	if (row.source === 'behaviour') return null;
	if (row.source === 'input') {
		const inputs = (node.data?.inputs ?? []).map((/** @type {any} */ s) => (s?.name === row.key ? { ...s, value } : s));
		return { inputs };
	}
	return { [row.key]: value };
}
