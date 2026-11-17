# Nodes as code — N0 design (roadmap 2.0 N0, lane 2.0-n012)

One page. What a built-in node IS as code, how a graph reads as code and back, what the code view
shows, and what an agent writes later (N3). **The tick model does not change**: stamps, the trigger
log, `nodesync` hashes and the late-joiner rules stay the netcode; code is a VIEW of the graph.

## 1. One code shape for behaviours and nodes

A behaviour is already code with a derived node view (`src/lib/behaviours`: `export default
behaviour({...})`, acorn reads it, `graph.js` derives the read-only view). Nodes take the same
shape, so a reader (person, agent, the N3 override editor) learns ONE format:

```js
// a built-in, as reference JS (N3 writes these for the ~25 pure nodes; N1 only has the slot)
export default node({
	type: 'math',
	name: 'Math',
	inputs: { a: 'number', b: 'number' },          // sockets = the registry's `in`
	outputs: { out: 'number' },                     // the registry's `out` (+ named handles)
	params: { op: { value: 'add', options: ['add', 'sub', 'mul', 'div', 'min', 'max', 'mod'] }, a: 0, b: 0 },
	eval({ a, b }, { op }) {                        // pure: inputs + params (+ time) -> outputs
		switch (op) { case 'sub': return a - b; /* … */ default: return a + b; }
	}
});
```
`params` is the behaviour `params` format verbatim (a bare literal or `{value, min, max, step,
options}`); `inputs`/`outputs` are behaviour sockets with types. A stateful node (latch, once,
counter, delay, timer) reads its state from the TRIGGER LOG through `ctx` — never from a variable
it owns — so a late joiner derives the same value (the reason N3 needs parity tests, not trust).

## 2. A graph as code (the N2 view; the same text the agent reads)

Generated, read-only, one statement per node, sources first (topological, then by position):

```js
// Scene flow · generated from the graph · read-only
export default flow(({ onclick, latch, visibility, objectselector }) => {
	const click = onclick();                                    // #6f1c…  (jump target)
	const open = latch({ initial: false }, { set: click });    // #a03b…
	const show = visibility({}, { on: open });                  // #c9e2…
	objectselector({ selected: 'Door' }, { in: [show] });      // #0b77…
});
```
Rules (the generator and parser agree on them; `nodes/flowCode.js`):
- a node = `name(params?, wires?)` where `name` is the node TYPE; the binding is a readable variable
  (label → camelCase, else type + n, unique per graph); the trailing `// #<id>` keeps the node id.
- `params` = `node.data` minus catalog defaults (the AI view's rule, graphText `positions: false`);
- `wires` = `{ targetHandle: source }`; a named source handle reads `click.byMe`; the unnamed target
  handle is `in`; a multi fan-in handle is an array; a source never consumed is a bare statement.
- cycles (latch loops) are forward references — the code is a DECLARATION list, never executed by N2.
- positions, classes, editor-only kinds (group, note) are not logic: not in the code; the parser
  keeps them from the graph by id. Group boundary sockets read as `group("Name", …)` blocks (later).

**Round trip** graph → code → graph is exact on LOGIC: node ids, types, data, edges (source,
sourceHandle, target, targetHandle). Proven for 5 built-ins in `tests/unit/flowCode.test.js`:
math (maths), compare (compare), timer (timer), latch (latch), oscillate (motion).
graphText (34 D4, lossless JSON-as-lines, Ctrl+S applies) stays the DATA format; the code view is
the LOGIC reading. N4 decides whether format 2 stores code; N2 does not touch saved files.

## 3. The N1 registry this stands on

`src/lib/nodes/` holds ONE definition per core node type, one file per palette group (the family):
`{type, group, spec (catalog entry: label, defaults, params, inputs, inputLabels, note), out,
in?, outHandles?, card, eval?, referenceJs?}`. Generated from it: `nodeCatalog` (palette order =
file order), `Nodes.svelte` CORE_NODE_TYPES (card KEYS → components), `flowSockets` OUTPUT /
INPUT / OUTPUT_HANDLES, and `evalNodeBody` dispatches `def.eval(node, x)` (x = the old switch's
locals: `d`, `input`, `time`, `ctx`, graph arrays, and `rt`, flowRuntime's helper bag — so a
family file stays a LEAF and the tick model is untouched). Kit nodes are already generated
(`kit/catalog.js`) and module nodes keep `registerNodeDefs / registerValueNode / registerEffect` as
adapters onto the same lookups. A def missing `spec`, `group`, `out` or `card`, or a non-effect
`out` with no `eval`, fails `npm run build` (vite plugin `node-registry-check`). No wire row is
per type today (`nodecreate/nodedata` validate shape only), so `wire` stays an optional hook.

## 4. What an agent writes (N3, not built here)

- READS: `describe_node_types` and `list_scene` gain `code` (this view) behind the `codeView` flag.
- WRITES (N3): the same `node({...})` shape as an OVERRIDE of one built-in's `eval` (inputs,
  params, time, `ctx` state → outputs; the `mergePlayerResult` allowlist), and graph edits as
  `flow` statements that parse back through the same parser. Tool names unchanged.

## 5. Phone and VR
Read-only sheet of the same text (copy works; no editing on either). Jump line → node selects and
frames the node in the graph; node → line scrolls the sheet.
