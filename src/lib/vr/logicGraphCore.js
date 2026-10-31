// VR controls — 74 VH1: THE LOGIC GRAPH AS A VR PANEL, the pure half. A zero-import leaf (the vitest layer
// reads it): how a node CARD is laid out in graph units, which sockets it shows, the view transform between
// graph units and the panel canvas, what the laser is on, the connection a wire drag makes, and the fields
// the wrist pad edits. logicPanel.js owns the meshes, the hooks and every replicated write; logicPanelDraw.js
// paints what this file lays out.
//
// SOCKETS. On the desktop every node card places its own sockets (xyflow measures them from the DOM), and a
// headset has no DOM. The panel asks the socket tables instead (flowSockets, the catalog spec, a script's or
// a behaviour's declarations — gathered by logicPanel.js into `info`) and then adds every handle an EXISTING
// wire names, so a graph built on the desktop always draws all of its wires, whatever this list misses.
// Which wire is allowed is never decided here: isValidFlowConnection stays the one authority.
//
// UNITS. Graph units are the desktop's flow coordinates (a card is w-[150px] there), so a node moved in the
// headset lands where the desktop draws it. The canvas maps them through {s, ox, oy}: canvas = graph * s + o.

/** a card's width in graph units (the desktop card is 150; the headset card is a little wider for text) */
export const CARD_W = 170;
/** the title row */
export const HEAD_H = 30;
/** one socket row */
export const ROW_H = 22;
/** below the last row */
export const PAD_B = 8;
/** a note's size when it states none */
export const NOTE_DEFAULT = { w: 200, h: 80 };

/** @typedef {{id: string | null, label: string}} Socket */
/** @typedef {{inputs: Socket[], outputs: Socket[]}} Sockets */
/**
 * @typedef {{id: string, x: number, y: number, w: number, h: number, kind: 'node' | 'note' | 'group',
 *   inputs: {id: string | null, label: string, x: number, y: number}[],
 *   outputs: {id: string | null, label: string, x: number, y: number}[]}} CardLayout
 */

/** @param {any[]} list @param {any} id */
const hasId = (list, id) => list.some((s) => s.id === id);

/**
 * The sockets a card shows: what the tables declare (`info`), then every handle an existing wire names.
 * `info.unnamedIn` / `info.unnamedOut` = the card has the plain (handle-less) input / output.
 * @param {any} node
 * @param {{inputs?: string[], outputs?: string[], unnamedIn?: boolean, unnamedOut?: boolean, labels?: Record<string, string>}} info
 * @param {any[]} edges the graph's wires
 * @returns {Sockets}
 */
export function nodeSockets(node, info, edges) {
	/** @type {Socket[]} */
	const inputs = [];
	/** @type {Socket[]} */
	const outputs = [];
	const label = (/** @type {string} */ id) => info.labels?.[id] ?? id;
	if (info.unnamedIn) inputs.push({ id: null, label: '' });
	for (const id of info.inputs ?? []) if (id && !hasId(inputs, id)) inputs.push({ id, label: label(id) });
	if (info.unnamedOut) outputs.push({ id: null, label: '' });
	for (const id of info.outputs ?? []) if (id && !hasId(outputs, id)) outputs.push({ id, label: label(id) });
	for (const e of edges ?? []) {
		if (e.target === node.id) {
			const id = e.targetHandle ?? null;
			if (!hasId(inputs, id)) inputs.push({ id, label: id ? label(id) : '' });
		}
		if (e.source === node.id) {
			const id = e.sourceHandle ?? null;
			if (!hasId(outputs, id)) outputs.push({ id, label: id ? label(id) : '' });
		}
	}
	return { inputs, outputs };
}

/**
 * Lay a card out in graph units. The plain input / output sit on the title row (the desktop puts them at
 * the card's middle; on a headset the title row is where the eye already is); named sockets get a row each.
 * @param {any} node @param {Sockets} sockets @returns {CardLayout}
 */
export function cardLayout(node, sockets) {
	const x = node.position?.x ?? 0;
	const y = node.position?.y ?? 0;
	if (node.type === 'note') {
		const w = Number(node.data?.w) > 0 ? Number(node.data.w) : NOTE_DEFAULT.w;
		const h = Number(node.data?.h) > 0 ? Number(node.data.h) : NOTE_DEFAULT.h;
		return { id: node.id, x, y, w, h, kind: 'note', inputs: [], outputs: [] };
	}
	const namedIn = sockets.inputs.filter((s) => s.id !== null);
	const namedOut = sockets.outputs.filter((s) => s.id !== null);
	const rows = Math.max(namedIn.length, namedOut.length, 1);
	const h = HEAD_H + rows * ROW_H + PAD_B;
	const place = (/** @type {Socket[]} */ list, /** @type {number} */ sx) => {
		let row = 0;
		return list.map((s) => {
			const sy = s.id === null ? HEAD_H / 2 : HEAD_H + row++ * ROW_H + ROW_H / 2;
			return { id: s.id, label: s.label, x: x + sx, y: y + sy };
		});
	};
	return {
		id: node.id,
		x,
		y,
		w: CARD_W,
		h,
		kind: node.type === 'group' ? 'group' : 'node',
		inputs: place(sockets.inputs, 0),
		outputs: place(sockets.outputs, CARD_W)
	};
}

// ---- the view transform ------------------------------------------------------------------------------

/** @typedef {{s: number, ox: number, oy: number}} View */
/** @typedef {{x: number, y: number, w: number, h: number}} Rect */

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 2.5;

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * The view that fits `cards` into `area` (canvas px) with `pad` around, at most `maxScale` (a small graph is
 * not blown up past readable-and-pressable). An empty graph centres graph (0, 0).
 * @param {Rect[]} cards @param {Rect} area @param {{pad?: number, maxScale?: number}} [opts] @returns {View}
 */
export function fitView(cards, area, opts = {}) {
	const pad = opts.pad ?? 40;
	const maxScale = opts.maxScale ?? 1.4;
	if (!cards.length) return { s: 1, ox: area.x + area.w / 2, oy: area.y + area.h / 2 };
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const c of cards) {
		x0 = Math.min(x0, c.x);
		y0 = Math.min(y0, c.y);
		x1 = Math.max(x1, c.x + c.w);
		y1 = Math.max(y1, c.y + c.h);
	}
	const gw = Math.max(1, x1 - x0);
	const gh = Math.max(1, y1 - y0);
	const s = clamp(Math.min((area.w - pad * 2) / gw, (area.h - pad * 2) / gh), MIN_SCALE, maxScale);
	return { s, ox: area.x + area.w / 2 - (x0 + gw / 2) * s, oy: area.y + area.h / 2 - (y0 + gh / 2) * s };
}

/** @param {View} v @param {number} gx @param {number} gy */
export function toCanvas(v, gx, gy) {
	return { x: gx * v.s + v.ox, y: gy * v.s + v.oy };
}
/** @param {View} v @param {number} cx @param {number} cy */
export function toGraph(v, cx, cy) {
	return { x: (cx - v.ox) / v.s, y: (cy - v.oy) / v.s };
}
/** zoom by `factor` keeping canvas point (cx, cy) still @param {View} v @param {number} factor @param {number} cx @param {number} cy @returns {View} */
export function zoomAt(v, factor, cx, cy) {
	const s = clamp(v.s * factor, MIN_SCALE, MAX_SCALE);
	const g = toGraph(v, cx, cy);
	return { s, ox: cx - g.x * s, oy: cy - g.y * s };
}

// ---- what the laser is on ----------------------------------------------------------------------------

/**
 * @typedef {{kind: 'socket', node: string, dir: 'in' | 'out', id: string | null, x: number, y: number}
 *   | {kind: 'node', node: string} | {kind: 'empty'}} GraphHit
 */

/**
 * The thing under canvas point (px, py). Sockets first (within `radius` canvas px — a laser trembles, so a
 * socket is a disc much bigger than it is drawn), then the topmost card, then the empty graph.
 * @param {CardLayout[]} cards in paint order (last = on top) @param {View} v @param {number} px @param {number} py
 * @param {number} [radius] @returns {GraphHit}
 */
export function hitGraph(cards, v, px, py, radius = 18) {
	/** @type {GraphHit | null} */
	let best = null;
	let bestD = radius * radius;
	for (const c of cards) {
		for (const [dir, list] of /** @type {const} */ ([
			['in', c.inputs],
			['out', c.outputs]
		])) {
			for (const s of list) {
				const p = toCanvas(v, s.x, s.y);
				const d = (p.x - px) ** 2 + (p.y - py) ** 2;
				if (d <= bestD) {
					bestD = d;
					best = { kind: 'socket', node: c.id, dir, id: s.id, x: s.x, y: s.y };
				}
			}
		}
	}
	if (best) return best;
	const g = toGraph(v, px, py);
	for (let i = cards.length - 1; i >= 0; i--) {
		const c = cards[i];
		if (c.kind === 'note') continue; // a note is a backdrop: cards drawn over it win, and it is never dragged by its body here
		if (g.x >= c.x && g.x <= c.x + c.w && g.y >= c.y && g.y <= c.y + c.h) return { kind: 'node', node: c.id };
	}
	for (let i = cards.length - 1; i >= 0; i--) {
		const c = cards[i];
		if (c.kind === 'note' && g.x >= c.x && g.x <= c.x + c.w && g.y >= c.y && g.y <= c.y + 26 / Math.max(v.s, 0.01)) return { kind: 'node', node: c.id };
	}
	return { kind: 'empty' };
}

// ---- wires -------------------------------------------------------------------------------------------

/**
 * The connection a wire drag makes: from one socket, dropped on another. Either end may be the output; two
 * inputs, two outputs or one card are no connection (null).
 * @param {{node: string, dir: 'in' | 'out', id: string | null}} from
 * @param {{node: string, dir: 'in' | 'out', id: string | null} | null} to
 * @returns {{source: string, sourceHandle: string | null, target: string, targetHandle: string | null} | null}
 */
export function connectionOf(from, to) {
	if (!from || !to || from.node === to.node || from.dir === to.dir) return null;
	const out = from.dir === 'out' ? from : to;
	const inp = from.dir === 'out' ? to : from;
	return { source: out.node, sourceHandle: out.id ?? null, target: inp.node, targetHandle: inp.id ?? null };
}

/** the canonical edge id (MUST match the desktop's makeEdge: peer dedupe keys on it) @param {{source: string, sourceHandle?: string | null, target: string, targetHandle?: string | null}} c */
export function edgeIdOf(c) {
	return `e-${c.source}${c.sourceHandle ? '.' + c.sourceHandle : ''}-${c.target}${c.targetHandle ? '.' + c.targetHandle : ''}`;
}

/** the wires that end in one input socket @param {any[]} edges @param {string} node @param {string | null} handle */
export function edgesIntoSocket(edges, node, handle) {
	return (edges ?? []).filter((e) => e.target === node && (e.targetHandle ?? null) === (handle ?? null));
}

/**
 * A canvas bezier for a wire from an output point to an input point (the desktop's default edge shape): the
 * two control points pull out sideways by half the gap (at least 40 px).
 * @param {{x: number, y: number}} a @param {{x: number, y: number}} b
 */
export function wireCurve(a, b) {
	const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
	return { a, c1: { x: a.x + dx, y: a.y }, c2: { x: b.x - dx, y: b.y }, b };
}

// ---- the wrist pad's fields -----------------------------------------------------------------------------

/**
 * @typedef {{key: string, kind: 'number' | 'toggle' | 'select' | 'text' | 'color', label: string, value: any,
 *   min?: number, max?: number, step: number, options?: string[], wired?: boolean}} PadField
 */

/** keys a node's data carries that are never a value to edit */
const NOT_VALUES = new Set(['label', 'type', 'code', 'items', 'points', 'children', 'inputs', 'outputs', 'frame', 'w', 'h', 'title', 'text', 'color_', 'flowUuid']);

/** a default step for a number with no spec: whole numbers step 1, others 0.1 @param {any} v */
function guessStep(v) {
	return Number.isInteger(v) ? 1 : 0.1;
}

/**
 * The values the wrist pad edits for a node: the catalog's `params` (their kinds, ranges, options and
 * labels) and then any plain number / boolean / short text / colour in its defaults the params do not
 * name. Code, lists, points and nested data stay on the desktop. A param fed by a wire is marked `wired`
 * (the wire overrides the typed value — the desktop shows the live value there instead).
 * @param {any} node @param {any} spec the catalog NodeSpec (or null) @param {any[]} [edges]
 * @returns {PadField[]}
 */
export function padFields(node, spec, edges = []) {
	const data = node?.data ?? {};
	const defaults = spec?.defaults ?? {};
	/** @type {PadField[]} */
	const out = [];
	const seen = new Set();
	const wired = (/** @type {string} */ key) => (edges ?? []).some((e) => e.target === node?.id && e.targetHandle === key);
	const valueOf = (/** @type {string} */ key) => (key in data ? data[key] : defaults[key]);
	for (const p of spec?.params ?? []) {
		if (!p?.key || seen.has(p.key)) continue;
		const value = valueOf(p.key);
		const label = p.label ?? p.key;
		if (p.kind === 'range' || p.kind === 'number') {
			if (typeof value !== 'number' && value !== undefined) continue;
			out.push({ key: p.key, kind: 'number', label, value: value ?? 0, min: p.min, max: p.max, step: p.step ?? guessStep(value ?? 0), wired: wired(p.key) });
		} else if (p.kind === 'toggle') out.push({ key: p.key, kind: 'toggle', label, value: !!value, step: 1, wired: wired(p.key) });
		else if (p.kind === 'select' && Array.isArray(p.options) && p.options.length) out.push({ key: p.key, kind: 'select', label, value: value ?? p.options[0], options: p.options.map(String), step: 1 });
		else if (p.kind === 'text') out.push({ key: p.key, kind: 'text', label, value: value ?? '', step: 1 });
		else if (p.kind === 'color') out.push({ key: p.key, kind: 'color', label, value: value ?? '#ffffff', step: 1 });
		else continue; // code / vector3: the desktop's
		seen.add(p.key);
	}
	for (const key of Object.keys(defaults)) {
		if (seen.has(key) || NOT_VALUES.has(key)) continue;
		const value = valueOf(key);
		if (typeof value === 'number' && Number.isFinite(value)) out.push({ key, kind: 'number', label: key, value, step: key === 'step' ? 0.1 : (typeof data.step === 'number' && key === 'value' ? data.step || 1 : guessStep(defaults[key])), wired: wired(key) });
		else if (typeof value === 'boolean') out.push({ key, kind: 'toggle', label: key, value, step: 1, wired: wired(key) });
		else if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) out.push({ key, kind: 'color', label: key, value, step: 1 });
		else if (typeof value === 'string' && value.length <= 80) out.push({ key, kind: 'text', label: key, value, step: 1 });
		else continue;
		seen.add(key);
	}
	return out;
}

/** decimals a step needs (0.1 -> 1, 0.05 -> 2) @param {number} step */
function decimalsOf(step) {
	const s = String(step);
	const i = s.indexOf('.');
	return i < 0 ? 0 : Math.min(6, s.length - i - 1);
}

/**
 * One − / + press on a number field: `dir` steps of the field's step (`big` = ten of them), clamped to its
 * range and rounded to the step's decimals (0.1 + 0.2 is 0.3 on the card, not 0.30000000000000004).
 * @param {PadField} field @param {number} dir -1 | 1 @param {boolean} [big] @returns {number}
 */
export function stepNumber(field, dir, big = false) {
	const step = field.step > 0 ? field.step : 1;
	const raw = Number(field.value ?? 0) + dir * step * (big ? 10 : 1);
	const lo = typeof field.min === 'number' ? field.min : -Infinity;
	const hi = typeof field.max === 'number' ? field.max : Infinity;
	return Number(clamp(raw, lo, hi).toFixed(decimalsOf(step)));
}

/**
 * A typed number for a field (the VR keyboard's text): NaN-proof, clamped. Null = not a number.
 * @param {PadField} field @param {string} text @returns {number | null}
 */
export function parseNumber(field, text) {
	const v = Number(String(text ?? '').trim().replace(',', '.'));
	if (!Number.isFinite(v) || String(text ?? '').trim() === '') return null;
	const lo = typeof field.min === 'number' ? field.min : -Infinity;
	const hi = typeof field.max === 'number' ? field.max : Infinity;
	return clamp(v, lo, hi);
}

/** the next / previous option of a select field (wraps) @param {PadField} field @param {number} dir */
export function cycleOption(field, dir) {
	const opts = field.options ?? [];
	if (!opts.length) return field.value;
	const i = opts.indexOf(String(field.value));
	return opts[(((i < 0 ? 0 : i + dir) % opts.length) + opts.length) % opts.length];
}

/** the swatches a colour field cycles through on a headset (a picker wheel is a desktop control) */
export const PAD_SWATCHES = ['#ffffff', '#ff4000', '#ffb000', '#ffe14d', '#3fb950', '#2ec4b6', '#2563eb', '#8b5cf6', '#ec4899', '#111111'];
/** the next swatch after a colour (a colour not in the list starts at the first) @param {string} value @param {number} dir */
export function cycleSwatch(value, dir) {
	const i = PAD_SWATCHES.indexOf(String(value).toLowerCase());
	const n = PAD_SWATCHES.length;
	return PAD_SWATCHES[i < 0 ? 0 : (((i + dir) % n) + n) % n];
}

/** a field's value as the pad prints it @param {PadField} f */
export function fieldText(f) {
	if (f.kind === 'toggle') return f.value ? 'On' : 'Off';
	if (f.kind === 'number') return String(Number(Number(f.value).toFixed(decimalsOf(f.step > 0 ? f.step : 1))));
	return String(f.value ?? '');
}

/** where a new node lands: the centre of what the panel shows, nudged so a second add does not stack exactly
 * @param {View} v @param {Rect} area @param {number} count nodes added since the panel opened */
export function dropPoint(v, area, count) {
	const g = toGraph(v, area.x + area.w / 2, area.y + area.h / 2);
	const k = count % 6;
	return { x: Math.round(g.x - CARD_W / 2 + k * 24), y: Math.round(g.y - 30 + k * 24) };
}
