// 2.0 N1 — the Input family: ONE definition per node type. A definition is its palette
// entry (label, defaults, params, inputs, note — exactly what nodeCatalog lists) plus the halves that
// used to live elsewhere: `sockets` (flowSockets OUTPUT / INPUT / OUTPUT_HANDLES), `card` (the
// Nodes.svelte component key) and `eval` (evalNodeBody's case; runtime helpers come in as `rt`).
// A LEAF: nothing here imports the runtime. Adding a node = one entry in this file.

/** @type {import('../registry.js').NodeFamily} */
export default {
	group: 'Input',
	nodes: [
		{
			type: 'slider', label: 'Slider', defaults: { value: 20, min: 0, max: 40 },
			sockets: { out: 'number' },
			card: 'SliderNode',
			eval(node, { d }, rt) {
				// 4.4: adjustable min/max (data-seeded) — clamp so stale values can't escape
				const lo = rt.num(d.min ?? 0);
				const hi = rt.num(d.max ?? 40);
				return Math.min(Math.max(rt.num(d.value ?? 20), Math.min(lo, hi)), Math.max(lo, hi));
			}
		},
		{
			type: 'colorpicker', label: 'Color Picker', defaults: { color: '#ff4000' },
			sockets: { out: 'color' },
			card: 'ColorPickerNode',
			eval(node, { d }, rt) {
				return d.color ?? '#ffffff';
			}
		},
		{
			type: 'switcher', label: 'Switcher', defaults: { items: ['cube', 'pyramid'], index: 0, shape: 'cube' },
			// 4.4: a real value source (the selected index)
			// 37 (R6): the multiplexer's `index` drives the choice; its `in<i>` item sockets are typed by
			// the node's DATA (vtype), so they live in dataSocketType, not here
			sockets: { out: 'number', in: { index: 'number' } },
			card: 'SwitcherNode',
			eval(node, { d, allEdges, input }, rt) {
				// 4.4: a real value source — the selected item INDEX (pairs with select/compare).
				// 37 (R6): an N-way MULTIPLEXER as well. A wired `index` overrides the radio (rounded and
				// clamped, the Select rule), and the named `value` output carries the selected item's
				// input socket `in<i>`. The unnamed output stays the INDEX (`__default`), so every saved
				// Switcher wire reads exactly what it read before. A switcher with nothing wired into it
				// keeps returning the plain number, byte-identical.
				const items = rt.switcherItems(d);
				const into = rt.edgesInto(allEdges, node.id);
				const indexWired = into.some((e) => e.targetHandle === 'index');
				const at = indexWired
					? Math.min(Math.max(Math.round(rt.num(input('index', 0))), 0), items.length - 1)
					: rt.switcherRadioIndex(d);
				if (!indexWired && !into.some((e) => rt.switcherIndexOf(e.targetHandle) >= 0)) return at;
				return { __handles: { value: input(rt.switcherHandle(at), undefined), index: at }, __default: at };
			}
		},
		// 133: value inputs — feed consumer node handles (deterministic)
		{
			type: 'number', label: 'Number', defaults: { value: 1, step: 1 },
			sockets: { out: 'number' },
			card: 'NumberNode',
			eval(node, { d }, rt) {
				return rt.num(d.value ?? 0);
			}
		},
		{
			type: 'vector3', label: 'Vector3', defaults: { x: 0, y: 0, z: 0 },
			sockets: { out: 'vector3' },
			card: 'Vector3Node',
			eval(node, { d }, rt) {
				return [rt.num(d.x ?? 0), rt.num(d.y ?? 0), rt.num(d.z ?? 0)];
			}
		},
		{
			type: 'toggle', label: 'Toggle', defaults: { on: false },
			sockets: { out: 'boolean' },
			card: 'ToggleNode',
			eval(node, { d }, rt) {
				return !!d.on;
			}
		},
		// B6: it was ALREADY deterministic across peers — mulberry32 over the node
		// id and the synced clock — so a wired seed is the whole change
		{
			type: 'random',
			label: 'Random',
			defaults: { min: 0, max: 1, interval: 0, seed: 0, integer: false },
			inputs: ['seed', 'reroll'],
			params: [{ key: 'integer', kind: 'toggle' }],
			// B6
			sockets: { out: 'number', in: { seed: 'number', reroll: 'event' } },
			card: 'RandomNode',
			eval(node, { d, time, input, ctx }, rt) {
				const lo = rt.num(d.min ?? 0);
				const hi = rt.num(d.max ?? 1);
				const interval = rt.num(d.interval ?? 0);
				const roll = interval > 0 ? Math.floor(time / interval) : 0;
				// B6: it was ALREADY deterministic across peers (mulberry32 over the node
				// id and the synced clock) — a wired SEED is all seeded procedural
				// generation needed. A `reroll` event advances the sequence, so a graph
				// can ask for a new value without waiting for an interval to elapse.
				const seed = rt.num(input('seed', d.seed ?? 0));
				// 21-E4 follow-up: the reroll term is THE STAMP (in ms), not a count of
				// rerolls, and the difference is the whole determinism story. A count is
				// local: a LATE JOINER's log starts empty, so its count runs N behind for
				// ever and its rolls never re-converge - two peers spawning a "random spawn
				// point" in different places permanently, with nothing to heal it. The stamp
				// is replicated, so every peer that holds the same last-reroll stamp computes
				// the same number, and a joiner converges EXACTLY on the next reroll (the
				// latch set/reset property rather than the latch toggle-parity one).
				// Absent = 0, which is byte-identical to every graph saved before the input
				// worked at all.
				const trig = ctx && ctx.triggers ? ctx.triggers[node.id] : null;
				const rerolls = typeof trig?.lastT === 'number' ? Math.round(trig.lastT * 1000) >>> 0 : 0;
				const value = lo + rt.mulberry32(rt.hashString(node.id) + roll + seed + rerolls) * (hi - lo);
				return d.integer ? Math.floor(value) : value;
			}
		},
		{
			type: 'time',
			label: 'Time',
			defaults: { mode: 'sin', rate: 1 },
			// 36 (flow-revamp 201): the ⓘ panel's schema — the card keeps its own widgets
			params: [
				{ key: 'mode', kind: 'select', options: ['t', 'sin', 'saw', 'pingpong'] },
				{ key: 'rate', kind: 'number', step: 0.1 }
			],
			sockets: { out: 'number' },
			card: 'TimeNode',
			eval(node, { time, d }, rt) {
				const t = time * rt.num(d.rate ?? 1);
				if (d.mode === 'sin') return Math.sin(t);
				if (d.mode === 'saw') return ((t % 1) + 1) % 1;
				if (d.mode === 'pingpong') {
					const p = ((t % 2) + 2) % 2;
					return p > 1 ? 2 - p : p;
				}
				return time;
			}
		}
	]
};
