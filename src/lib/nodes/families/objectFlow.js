// 2.0 N1 — the Object Flow family: ONE definition per node type. A definition is its palette
// entry (label, defaults, params, inputs, note — exactly what nodeCatalog lists) plus the halves that
// used to live elsewhere: `sockets` (flowSockets OUTPUT / INPUT / OUTPUT_HANDLES), `card` (the
// Nodes.svelte component key) and `eval` (evalNodeBody's case; runtime helpers come in as `rt`).
// A LEAF: nothing here imports the runtime. Adding a node = one entry in this file.

/** @type {import('../registry.js').NodeFamily} */
export default {
	group: 'Object Flow',
	nodes: [
		{
			type: 'flowinput', label: 'Flow Input', defaults: { name: 'value', vtype: 'number', fallback: 0 },
			// H5 fallback; the live check reads data.vtype
			sockets: { out: 'number' },
			card: 'FlowIONode',
			eval(node, { d }, rt) {
				// value injected by the scene graph's embedded Object Flow node this
				// tick; falls back to the node's own default param
				const injected = rt.graphInputs[node.__graph]?.[d.name ?? 'value'];
				return injected !== undefined ? injected : d.fallback ?? rt.typedFallback(d.vtype);
			}
		},
		{
			type: 'flowoutput', label: 'Flow Output', defaults: { name: 'out', fallback: 0 },
			sockets: { out: 'effect' },
			card: 'FlowIONode',
			eval(node, { input, d }, rt) {
				// a Flow Output IS its wired input (lets the tick + readouts reuse eval)
				return input('value', d.fallback ?? 0);
			}
		},
		{
			type: 'objectflow', label: 'Object Flow', defaults: { flowUuid: '' },
			sockets: { out: 'effect' },
			card: 'ObjectFlowNode',
			eval(node, { d }, rt) {
				// the embedded node exposes the target flow's outputs as named handles,
				// computed at the END of the previous tick (one-frame latency)
				return { __handles: rt.graphOutputs[d.flowUuid] ?? {} };
			}
		}
	]
};
