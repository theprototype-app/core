// 34 R3 (D2) — THE DERIVED NODE VIEW: analyze()'s structure as read-only flow nodes.
//
// A pure LEAF (no imports). One-way: code -> view (proposal §4.4: no round-trip; the only write
// back is a param's literal, analyze.setParamLiteral). Columns, left to right:
//
//   0  ⚡ events (one per handler, its payload fields listed)  ·  ◆ params (knobs)
//   1  ƒ handlers and methods
//   2  ▣ state fields (live values)  ·  ⊕ kit calls (named and typed exactly as the kit's
//      generated node — T3)  ·  ⏱ timers  ·  ✋ payload actions (refuse)
//
// Edges: event → handler, param → the function (or timer) that reads it, function → state it
// writes (solid) and state → function it reads (dashed), function → method it calls, function →
// timer → the method the timer runs, function → kit call, function → action.
// Every node carries `data.view` = {kind, key} so the live layer (BehaviourView.svelte) can lay
// values and the fired glow on it without re-deriving the graph.

const COL_X = [0, 290, 580];
const ROW_H = { event: 96, param: 86, fn: 64, state: 58, kit: 70, timer: 58, action: 50 };

/** @param {string} s */
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * @param {any} model analyze()'s result
 * @returns {{nodes: any[], edges: any[]}}
 */
export function deriveGraph(model) {
	/** @type {any[]} */ const nodes = [];
	/** @type {any[]} */ const edges = [];
	if (!model) return { nodes, edges };
	const y = [0, 0, 0];
	/** @param {number} col @param {string} id @param {string} kind @param {any} data */
	const add = (col, id, kind, data) => {
		if (nodes.some((n) => n.id === id)) return id;
		nodes.push({
			id,
			type: 'bview',
			position: { x: COL_X[col], y: y[col] },
			draggable: false,
			connectable: false,
			deletable: false,
			selectable: false,
			data: { ...data, view: { kind, key: data.key ?? id } }
		});
		y[col] += /** @type {any} */ (ROW_H)[kind] ?? 56;
		return id;
	};
	/** @param {string} source @param {string} target @param {string} kind */
	const link = (source, target, kind) => {
		const id = source + '>' + target;
		if (edges.some((e) => e.id === id)) return;
		edges.push({
			id,
			source,
			target,
			type: 'smoothstep',
			animated: false,
			selectable: false,
			class: 'bview-edge bview-edge-' + kind,
			data: { kind },
			...(kind === 'read' ? { style: 'stroke-dasharray: 4 3; opacity: 0.6' } : {})
		});
	};

	const fns = [
		...(model.handlers ?? []).map((/** @type {any} */ h) => ({ ...h, fid: 'h:' + h.name, title: 'on.' + h.name, handler: true })),
		...(model.methods ?? []).map((/** @type {any} */ m) => ({ ...m, fid: 'm:' + m.name, title: m.name + '()', handler: false }))
	];

	// column 0: events, then params
	for (const h of model.handlers ?? []) {
		const ev = h.event;
		add(0, 'e:' + h.name, 'event', {
			key: h.name,
			label: ev?.label ?? 'on.' + h.name,
			sub: ev ? (ev.input ? 'wired input' : ev.piece ? 'kit.' + ev.piece + '.' + ev.event : ev.name) + (ev.local ? ' · local' : ' · authority') : 'unknown event',
			outputs: Object.entries(ev?.payload ?? {}).map(([k, t]) => k + ': ' + t),
			line: h.line,
			unknown: !ev
		});
	}
	for (const p of model.params ?? []) {
		add(0, 'p:' + p.key, 'param', {
			key: p.key,
			label: p.key,
			value: p.value,
			ptype: p.type,
			min: p.min,
			max: p.max,
			step: p.step,
			unit: p.unit ?? '',
			editable: !!p.range,
			line: p.line
		});
	}
	// column 1: functions
	for (const f of fns) add(1, f.fid, 'fn', { key: f.handler ? 'on.' + f.name : f.name, label: f.title, handler: f.handler, random: f.random, line: f.line });
	for (const h of model.handlers ?? []) link('e:' + h.name, 'h:' + h.name, 'event');
	// column 2: state first (stable order), then per function its kit calls, timers, actions
	for (const s of model.state ?? []) add(2, 's:' + s.key, 'state', { key: s.key, label: 'state.' + s.key, init: s.init, line: s.line });
	for (const f of fns) {
		for (const k of f.reads?.params ?? []) if (nodes.some((n) => n.id === 'p:' + k)) link('p:' + k, f.fid, 'param');
		for (const k of f.writes ?? []) {
			add(2, 's:' + k, 'state', { key: k, label: 'state.' + k, init: undefined });
			link(f.fid, 's:' + k, 'write');
		}
		for (const k of f.reads?.state ?? []) {
			if (f.writes?.includes(k)) continue; // the write edge already joins them
			add(2, 's:' + k, 'state', { key: k, label: 'state.' + k, init: undefined });
			link('s:' + k, f.fid, 'read');
		}
		for (const m of f.calls ?? []) if (nodes.some((n) => n.id === 'm:' + m)) link(f.fid, 'm:' + m, 'call');
		(f.timers ?? []).forEach((/** @type {any} */ t, /** @type {number} */ i) => {
			const tid = add(2, 't:' + f.fid + ':' + i, 'timer', {
				key: f.fid + ':' + i,
				label: 'after' + (t.params?.length ? ' ' + t.params.join(', ') : ''),
				method: t.method,
				line: t.line
			});
			link(f.fid, tid, 'timer');
			for (const k of t.params ?? []) if (nodes.some((n) => n.id === 'p:' + k)) link('p:' + k, tid, 'param');
			if (t.method && nodes.some((n) => n.id === 'm:' + t.method)) link(tid, 'm:' + t.method, 'call');
		});
		for (const k of f.kit ?? []) {
			const kid = add(2, 'k:' + k.piece + '.' + k.call, 'kit', {
				key: k.piece + '.' + k.call,
				label: k.label,
				sub: 'Kit: ' + cap(k.piece) + (k.type ? ' · ' + k.type : ' · code only'),
				nodeType: k.type,
				kitKind: k.kind,
				line: k.line
			});
			link(f.fid, kid, 'kit');
		}
		for (const a of f.actions ?? []) {
			const aid = add(2, 'a:' + f.fid + ':' + a, 'action', { key: f.fid + ':' + a, label: a + '()', line: f.line });
			link(f.fid, aid, 'action');
		}
		// 36 (U10): an emitted event output (`this.emit('holeSunk')`) — the wire out to the graph
		for (const e of f.emits ?? []) {
			const xid = add(2, 'x:' + e, 'action', { key: 'emit:' + e, label: 'emit ' + e + ' ⚡', line: f.line });
			link(f.fid, xid, 'action');
		}
	}
	// vertical balance: centre the shorter columns on the tallest
	const tallest = Math.max(...y);
	for (const n of nodes) {
		const col = COL_X.indexOf(n.position.x);
		n.position.y += Math.max(0, (tallest - y[col]) / 2);
	}
	return { nodes, edges };
}

/** a value for a node face: short, one line @param {any} v */
export function formatValue(v) {
	if (v === undefined) return '—';
	if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
	if (typeof v === 'string') return JSON.stringify(v.length > 24 ? v.slice(0, 23) + '…' : v);
	try {
		const s = JSON.stringify(v);
		return s.length > 28 ? s.slice(0, 27) + '…' : s;
	} catch {
		return String(v);
	}
}
