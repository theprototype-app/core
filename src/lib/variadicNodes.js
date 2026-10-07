// 37 (R6): variadic logic nodes. A LEAF (no imports), because flowSockets, flowRuntime,
// nodeGroups' callers and the node cards all ask it, and flowSockets must stay cycle-free.
//
// Two node families grow a socket list the author edits:
//
// 1. MATH and GATE take N typed inputs (2..8), named a..h. `a`/`b` keep their ids and their
//    manual fields, so every saved node is byte-identical (`data.sockets` absent = 2). The
//    extra sockets c..h have no manual value: wired ones join the fold, unwired ones are
//    skipped. Only the foldable ops use them (FOLD_MATH / FOLD_GATE); the other ops ignore
//    them and the card greys them out.
//
// 2. SWITCHER becomes an N-way MULTIPLEXER. Each item gets an input socket `in<i>` typed by
//    the node's `vtype` (number/boolean/vector3/color/object). The named `value` output
//    carries the selected item's input. The unnamed output stays the selected INDEX, so
//    every saved Switcher wire reads what it always read. An `index` input lets a graph drive
//    the choice, overriding the radio.
//
// Removing a socket (or a switcher item from the middle) RENAMES the sockets after it.
// `socketRemovalPlan` is the pure answer to "which wires go, which move, what does every
// group's IO list become". variadicEdit.js applies it as one undoable, replicated step.

/** math/gate input socket names, in order @type {readonly string[]} */
export const INPUT_LETTERS = Object.freeze(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
export const MIN_SOCKETS = 2;
export const MAX_SOCKETS = INPUT_LETTERS.length;
/** the switcher's item cap: one socket per item, 16 keeps the card on one screen */
export const MAX_SWITCHER_ITEMS = 16;

/** the per-socket type of each variadic node family @type {Record<string, string>} */
export const VARIADIC_TYPES = Object.freeze({ math: 'number', gate: 'boolean' });

/** ops that fold over every input. sub/div fold LEFT (a - b - c), as a calculator does @type {readonly string[]} */
export const FOLD_MATH = Object.freeze(['add', 'sub', 'mul', 'div', 'min', 'max']);
/** xor over N inputs = an ODD number of them true (parity), the chained-XOR reading @type {readonly string[]} */
export const FOLD_GATE = Object.freeze(['and', 'or', 'xor']);

/** what a Switcher's item sockets may carry @type {readonly string[]} */
export const SWITCHER_TYPES = Object.freeze(['number', 'boolean', 'vector3', 'color', 'object']);

/** @param {string} type */
export function isVariadic(type) {
	return type === 'math' || type === 'gate';
}

/** How many inputs a math/gate node shows (2 when unset, clamped to 2..8). @param {any} data */
export function socketCount(data) {
	const n = Math.round(Number(data?.sockets));
	return Number.isFinite(n) ? Math.min(Math.max(n, MIN_SOCKETS), MAX_SOCKETS) : MIN_SOCKETS;
}

/** The input socket names a math/gate node shows. @param {any} data */
export function variadicInputs(data) {
	return INPUT_LETTERS.slice(0, socketCount(data));
}

/** Does this op fold over the extra sockets? @param {string} type @param {string|undefined} op */
export function opFolds(type, op) {
	if (type === 'math') return FOLD_MATH.includes(op ?? 'add');
	if (type === 'gate') return FOLD_GATE.includes(op ?? 'and');
	return false;
}

/**
 * Fold numbers left to right with a math op. `values[0]` is a, then b, then each wired extra.
 * div by 0 reads 0 (the two-input rule), so one stray zero does not poison the graph with Infinity.
 * @param {string} op @param {number[]} values
 */
export function foldMath(op, values) {
	if (!values.length) return 0;
	let acc = values[0];
	for (let i = 1; i < values.length; i++) {
		const v = values[i];
		if (op === 'sub') acc -= v;
		else if (op === 'mul') acc *= v;
		else if (op === 'div') acc = v !== 0 ? acc / v : 0;
		else if (op === 'min') acc = Math.min(acc, v);
		else if (op === 'max') acc = Math.max(acc, v);
		else acc += v;
	}
	return acc;
}

/** Fold booleans with a gate op. @param {string} op @param {boolean[]} values */
export function foldGate(op, values) {
	if (op === 'or') return values.some(Boolean);
	if (op === 'xor') return values.filter(Boolean).length % 2 === 1;
	return values.length > 0 && values.every(Boolean);
}

// --- the switcher -------------------------------------------------------------

/** @param {any} data @returns {string[]} */
export function switcherItems(data) {
	return Array.isArray(data?.items) && data.items.length ? data.items.map(String) : ['cube', 'pyramid'];
}
/** @param {any} data */
export function switcherVType(data) {
	return SWITCHER_TYPES.includes(data?.vtype) ? data.vtype : 'number';
}
/** @param {number} i */
export function switcherHandle(i) {
	return 'in' + i;
}
/** `in3` -> 3, anything else -> -1 @param {string|null|undefined} handle */
export function switcherIndexOf(handle) {
	const m = typeof handle === 'string' ? /^in(\d+)$/.exec(handle) : null;
	return m ? Number(m[1]) : -1;
}
/** The selected index from the radio (legacy `shape` saves included), clamped. @param {any} data */
export function switcherRadioIndex(data) {
	const items = switcherItems(data);
	const raw = data?.index ?? Math.max(items.indexOf(data?.shape ?? 'cube'), 0);
	const n = Math.round(Number(raw));
	return Math.min(Math.max(Number.isFinite(n) ? n : 0, 0), items.length - 1);
}

/**
 * A DATA-declared socket type for these nodes, or null when the static table answers.
 * Kept here so flowSockets (input + output checks), the group typing and the cards share one rule.
 * @param {any} node @param {string|null|undefined} handle @param {'input'|'output'} dir
 * @returns {string|null}
 */
export function dataSocketType(node, handle, dir) {
	if (node?.type !== 'switcher') return null;
	if (dir === 'output') return handle === 'value' ? switcherVType(node.data) : null;
	if (handle === 'index') return 'number';
	return switcherIndexOf(handle) >= 0 ? switcherVType(node.data) : null;
}

/**
 * Does `handle` still exist on `node`? False for a math/gate letter past the node's count and
 * a switcher `in<i>` past its items. Every other node and handle says true: this is only the
 * filter that lets a group drop the IO entry of a socket that was removed.
 * @param {any} node @param {string|null|undefined} handle @param {'in'|'out'} dir
 */
export function variadicSocketExists(node, handle, dir) {
	if (!node || dir !== 'in' || !handle) return true;
	if (isVariadic(node.type)) {
		const at = INPUT_LETTERS.indexOf(handle);
		return at < 0 || at < socketCount(node.data);
	}
	if (node.type === 'switcher') {
		const at = switcherIndexOf(handle);
		return at < 0 || at < switcherItems(node.data).length;
	}
	return true;
}

/**
 * The plan for removing ONE input socket of a variadic node: the socket at `index`
 * (a letter's position for math/gate, the item position for a switcher). Pure.
 *
 * Sockets after it shift down one name (d -> c, in4 -> in3), so a wire keeps feeding the
 * same VALUE it fed. Each moved wire is deleted and re-created under its new canonical id,
 * because peers dedupe edges by id. Every group whose IO list names one of the node's sockets
 * gets that list rewritten the same way: the removed socket's entry goes, the moved ones
 * are renamed. A name the user typed survives the move.
 *
 * @param {any} node the variadic node @param {any[]} nodes every node of its graph
 * @param {any[]} edges every edge of its graph @param {number} index the socket to remove
 * @param {(source: string, sourceHandle: string|null|undefined, target: string, targetHandle: string|null|undefined) => string} edgeIdOf
 * @returns {null | {data: Record<string, any>, deleteEdges: any[], createEdges: any[], groups: {id: string, before: any, after: any}[]}}
 */
export function socketRemovalPlan(node, nodes, edges, index, edgeIdOf) {
	if (!node) return null;
	/** @type {string[]} */
	let names;
	/** @type {Record<string, any>} */
	let data;
	if (isVariadic(node.type)) {
		names = variadicInputs(node.data);
		if (names.length <= MIN_SOCKETS || index < 0 || index >= names.length) return null;
		data = { sockets: names.length - 1 };
	} else if (node.type === 'switcher') {
		const items = switcherItems(node.data);
		if (items.length <= 1 || index < 0 || index >= items.length) return null;
		names = items.map((_, i) => switcherHandle(i));
		const nextItems = items.filter((_, i) => i !== index);
		// the radio keeps pointing at the SAME item when one before it goes
		const sel = switcherRadioIndex(node.data);
		const nextSel = sel > index ? sel - 1 : sel === index ? 0 : sel;
		data = { items: nextItems, index: nextSel, shape: nextItems[nextSel] };
	} else return null;
	// a math/gate letter's manual value moves with its socket too (a <- b when a goes)
	/** @type {Record<string, string|null>} old handle -> new handle (null = removed) */
	const rename = {};
	for (let i = index; i < names.length; i++) rename[names[i]] = i === index ? null : names[i - 1];
	if (isVariadic(node.type)) {
		// only a and b carry a manual field; one that inherits from a socket WITHOUT one (c..h)
		// takes the node's default, never the value of the socket that just left
		const fallback = node.type === 'gate' ? false : 0;
		for (let i = index; i < Math.min(names.length - 1, MIN_SOCKETS); i++) {
			const from = names[i + 1];
			data[names[i]] = INPUT_LETTERS.indexOf(from) < MIN_SOCKETS ? (node.data?.[from] ?? fallback) : fallback;
		}
	}
	const deleteEdges = [];
	const createEdges = [];
	for (const e of edges) {
		if (e.target !== node.id || !(e.targetHandle in rename)) continue;
		deleteEdges.push(e);
		const to = rename[e.targetHandle];
		if (to) createEdges.push({ ...e, id: edgeIdOf(e.source, e.sourceHandle, e.target, to), targetHandle: to });
	}
	const groups = [];
	for (const g of nodes) {
		if (g?.type !== 'group') continue;
		const inputs = g.data?.inputs ?? [];
		if (!inputs.some((/** @type {any} */ io) => io?.to?.[0] === node.id && io.to[1] in rename)) continue;
		const after = [];
		for (const io of inputs) {
			if (io?.to?.[0] !== node.id || !(io.to[1] in rename)) {
				after.push(io);
				continue;
			}
			const to = rename[io.to[1]];
			if (!to) continue;
			// a default name is the handle itself: follow the rename; a typed name is kept
			after.push({ ...io, key: node.id + '|' + to, to: [node.id, to], name: io.name === io.to[1] ? to : io.name });
		}
		groups.push({ id: g.id, before: { inputs }, after: { inputs: after } });
	}
	return { data, deleteEdges, createEdges, groups };
}
