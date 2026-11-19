// 2.0 N1 — the Music family: ONE definition per node type. A definition is its palette
// entry (label, defaults, params, inputs, note — exactly what nodeCatalog lists) plus the halves that
// used to live elsewhere: `sockets` (flowSockets OUTPUT / INPUT / OUTPUT_HANDLES), `card` (the
// Nodes.svelte component key) and `eval` (evalNodeBody's case; runtime helpers come in as `rt`).
// A LEAF: nothing here imports the runtime. Adding a node = one entry in this file.

/** @type {import('../registry.js').NodeFamily} */
export default {
	group: 'Music',
	nodes: [
		// writes ONE param of the device this graph belongs to (or the object a Selector
		// names) — LOCAL per peer, the setcolor rule: the value already arrives through the
		// replicated graph, so it is never broadcast again
		// fix-batch-1: `value` is what the runtime writes (flowSockets types it) and had no
		// socket — found by the audit's undrawn-input guard, the docs-1 Q1 class
		{
			type: 'deviceparam', label: 'Device Param', defaults: { key: 'level', value: 0 }, inputs: ['value'], inputLabels: { value: 'value — wire an LFO, a slider' }, params: [{ key: 'key', kind: 'text', placeholder: 'param key (level, freq, ...)', maxLength: 40 }],
			// 23-B3: the music nodes (devicelevel / transportbeat are value nodes; their inputs
			// and output types come from the moduleNodeIO registry they register through)
			sockets: { out: 'effect', in: { value: 'number' } },
			// 23-B3 music: the spec-driven card, like the physics family above. A type in
			// nodeCatalog but NOT here falls through to UnknownNode — "this node comes from a
			// module that isn't installed" — which is what these four did from the palette.
			card: 'AnimationNode'
		},
		// the device's live output level, 0..1 — feeds core nodes and the HUD
		{
			type: 'devicelevel', label: 'Device Level', defaults: {},
			sockets: { out: 'effect' },
			card: 'AnimationNode'
		},
		// the shared transport as a number: beat, bar, phase (0..1 of the loop), bpm, playing
		{
			type: 'transportbeat', label: 'Transport', defaults: { read: 'beat' }, params: [{ key: 'read', kind: 'select', options: ['beat', 'bar', 'phase', 'bpm', 'playing', 'loopBeats'] }],
			sockets: { out: 'effect' },
			card: 'AnimationNode'
		},
		// a note-on per trigger pulse: the pulse is already the replicated event, so every
		// peer synthesizes the note itself (once per pulse per peer)
		// fix-batch-1: it drew NO socket, so a note could not be triggered by hand (the audit guard)
		{
			type: 'notetrigger', label: 'Note Trigger', defaults: { note: 60, velocity: 0.9 }, inputs: ['trigger', 'note', 'velocity'],
			sockets: { out: 'effect', in: { trigger: 'event', note: 'number', velocity: 'number' } },
			card: 'AnimationNode'
		}
	]
};
