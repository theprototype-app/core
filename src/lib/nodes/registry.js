// 2.0 N1 — THE NODE DEFINITION REGISTRY. A core node type used to live in four places that had to
// agree by hand: its palette entry (nodeCatalog.js), its card (Nodes.svelte CORE_NODE_TYPES), its
// socket types (flowSockets OUTPUT / INPUT / OUTPUT_HANDLES) and its value (a case in flowRuntime's
// evalNodeBody switch) — "a new node type has TWO registries and only one of them complains" (B7).
// Now ONE definition per type, one file per palette group (`families/<group>.js`, palette order =
// file order), and the four places are GENERATED from it (`index.js`). A definition missing a
// required half fails `npm run build` (the `node-registry-check` plugin in vite.config.ts runs
// `registryErrors`), not silently at run time.
//
// A pure LEAF (imports nothing): the shapes, the split of a definition into its palette SPEC and its
// runtime halves, and the checks. The tick model does not change: `eval` is the old case body,
// handed the same locals (`x`) and flowRuntime's helpers (`rt`).

/**
 * A1: `kind: 'text'` is a free-text param. It writes on COMMIT (change/blur),
 * never per keystroke — a node edit replicates the whole node, so an input-time
 * write is one broadcast per character. `placeholder`/`maxLength` are hints for it.
 *
 * 21-B B6: `inputs` declares NAMED target sockets (trigger, force, target…) and
 * `inputLabels` gives one a friendlier label than its wire name. A spec with
 * `inputs` renders its sockets as labelled ROWS instead of by pixel offset.
 * 21-F2: `label` is optional and the KEY is still the default, because a key like
 * `initial` or `invert` reads perfectly well on a card. It exists for the ones that do
 * not — a flag whose meaning is a sentence ("reset each round") cannot be a camelCase
 * identifier without becoming a riddle.
 * 21-B B7: `note` is one line of prose the CARD renders under its rows. It exists for the
 * facts a socket label cannot carry and that get filed as bugs otherwise — "my peer does
 * not see it", "my copies vanished when I stopped the sim". HudNode had hand-rolled
 * exactly this for `hudscreen`; a spec field means the next such node needs no card of
 * its own to say its one important thing.
 * @typedef {{ key: string, kind: 'range' | 'select' | 'toggle' | 'text' | 'number' | 'color' | 'vector3' | 'code', label?: string, doc?: string, group?: string, socket?: boolean, min?: number, max?: number, step?: number, options?: string[], placeholder?: string, maxLength?: number, legacy?: any, showIf?: Record<string, string[]> }} NodeParam
 * @typedef {{ type: string, label: string, defaults: Record<string, any>, params?: NodeParam[], inputs?: string[], inputLabels?: Record<string, string>, note?: string, defaultsBy?: Record<string, Record<string, Record<string, any>>> }} NodeSpec
 */

/**
 * The old evalNodeBody locals, handed to a definition's `eval` unchanged.
 * @typedef {{ d: any, input: (handle: string, fallback: any) => any, time: number, ctx: any, allNodes: any[], allEdges: any[], seen: Set<any> }} EvalLocals
 * `rt` = flowRuntime's helper bag (a TYPE reference only: nothing here imports the runtime).
 * @typedef {(node: any, x: EvalLocals, rt: import('../flowRuntime.js').FlowRuntimeHelpers) => any} NodeEval
 */

/**
 * `out` = the type of the node's unnamed output (`effect` = it drives an Object Selector, the old
 * fallback, now said out loud); `in` = typed named inputs (`_default` = an unnamed target handle);
 * `outHandles` = named outputs whose type is not the node's.
 * @typedef {{ out: string, in?: Record<string, string>, outHandles?: Record<string, string> }} NodeSockets
 */

/**
 * One node type: its palette spec (every key that is not a half below) plus its halves.
 * `eval: null` = a non-effect output with NO pulled value: consumers read its trigger log
 * (a stamp-edge source) — declared, so the check can tell it from a forgotten eval.
 * `tick` / `trigger` / `wire` / `referenceJs` are the optional slots N3 fills (the effect APPLY
 * path still lives in flowRuntime; `wire` validates a node's data on `nodecreate` when present).
 * @typedef {NodeSpec & { sockets: NodeSockets, card: string, eval?: NodeEval | null, tick?: any, trigger?: any, wire?: (data: any) => boolean, referenceJs?: string, v?: number }} NodeDef
 * @typedef {{ group: string, nodes: NodeDef[] }} NodeFamily
 */

/** the keys of a definition that are NOT its palette spec */
export const HALVES = ['sockets', 'card', 'eval', 'tick', 'trigger', 'wire', 'referenceJs', 'v'];

/** the socket types a definition may name */
export const SOCKET_TYPES = [
	'number',
	'vector3',
	'boolean',
	'color',
	'object',
	'event',
	'effect',
	'any'
];

/** every card component Nodes.svelte can render a core node with (its CARDS map has exactly these keys) */
export const CARD_KEYS = /** @type {const} */ ([
	'AnimationNode',
	'HudNode',
	'OnClickNode',
	'EffectNode',
	'GameCameraNode',
	'ContactNode',
	'BinaryNode',
	'TimelineSeqNode',
	'ObjectPairNode',
	'GamepadNode',
	'FlowIONode',
	'VelocityNode',
	'Vector3Node',
	'TravelNode',
	'ToggleNode',
	'ToggleAnimNode',
	'TimerNode',
	'TimeNode',
	'SwitcherNode',
	'SoundNode',
	'SliderNode',
	'SequenceNode',
	'SelectNode',
	'ScriptNode',
	'RandomNode',
	'PlayAnimNode',
	'PathPatrolNode',
	'PathEventNode',
	'ParticleNode',
	'OnHitNode',
	'OnClapNode',
	'ObjectSelectorNode',
	'ObjectFlowNode',
	'NumberNode',
	'MoveInputNode',
	'MapRangeNode',
	'LoopNode',
	'KeyPressNode',
	'CounterNode',
	'ColorPickerNode',
	'ColliderNode',
	'CodeRefNode',
	'BlendSpeedNode',
	'BehaviourNode',
	'AnimStateNode'
]);

/** a definition's palette spec: its own keys minus the halves, in its own order @param {NodeDef} def @returns {NodeSpec} */
export function specOf(def) {
	/** @type {any} */
	const spec = {};
	for (const key of Object.keys(def))
		if (!HALVES.includes(key)) spec[key] = /** @type {any} */ (def)[key];
	return spec;
}

/**
 * Build the registry from the families, in order.
 * @param {NodeFamily[]} families
 * @returns {{ defs: Map<string, NodeDef & { group: string }>, groups: { group: string, items: NodeSpec[] }[], specs: Map<string, NodeSpec> }}
 */
export function buildRegistry(families) {
	/** @type {Map<string, NodeDef & { group: string }>} */
	const defs = new Map();
	/** @type {Map<string, NodeSpec>} */
	const specs = new Map();
	const groups = [];
	for (const family of families) {
		const items = [];
		for (const def of family.nodes) {
			// a duplicate keeps the FIRST definition (registryErrors names it)
			if (defs.has(def.type)) continue;
			defs.set(def.type, Object.assign(Object.create(null), def, { group: family.group }));
			const spec = specOf(def);
			specs.set(def.type, spec);
			items.push(spec);
		}
		groups.push({ group: family.group, items });
	}
	return { defs, groups, specs };
}

/**
 * What is wrong with the families, one line per problem (empty = every definition is whole).
 * Required: `type`, `label`, `defaults`, a family `group`, `sockets.out` (a known type), `card` (a
 * known card key) and, for a non-effect `out`, an `eval` (a function, or `null` said on purpose).
 * @param {NodeFamily[]} families @returns {string[]}
 */
export function registryErrors(families) {
	/** @type {string[]} */
	const errors = [];
	const seen = new Map();
	for (const family of families) {
		if (!family || typeof family.group !== 'string' || !family.group) {
			errors.push('a family has no group name');
			continue;
		}
		if (!Array.isArray(family.nodes)) {
			errors.push(`family ${family.group}: nodes is not an array`);
			continue;
		}
		for (const def of family.nodes) {
			const where = `${family.group} › ${def?.type ?? '(no type)'}`;
			if (!def || typeof def.type !== 'string' || !/^[a-z0-9]+$/.test(def.type)) {
				errors.push(`${where}: type must be lowercase letters/digits`);
				continue;
			}
			if (seen.has(def.type))
				errors.push(`${where}: defined twice (also in ${seen.get(def.type)})`);
			seen.set(def.type, family.group);
			if (typeof def.label !== 'string' || !def.label)
				errors.push(`${where}: no label (the palette spec)`);
			if (!def.defaults || typeof def.defaults !== 'object' || Array.isArray(def.defaults))
				errors.push(`${where}: no defaults object (the palette spec)`);
			const s = def.sockets;
			if (!s || typeof s !== 'object') errors.push(`${where}: no sockets`);
			else {
				if (!SOCKET_TYPES.includes(s.out))
					errors.push(`${where}: sockets.out "${s.out}" is not a socket type`);
				for (const [h, t] of Object.entries(s.in ?? {}))
					if (!SOCKET_TYPES.includes(t)) errors.push(`${where}: input ${h} has type "${t}"`);
				for (const [h, t] of Object.entries(s.outHandles ?? {}))
					if (!SOCKET_TYPES.includes(t)) errors.push(`${where}: output ${h} has type "${t}"`);
				if (s.out !== 'effect' && def.eval === undefined)
					errors.push(
						`${where}: a ${s.out} output needs an eval (or eval: null for a stamp-edge source)`
					);
			}
			if (!(/** @type {readonly string[]} */ (CARD_KEYS).includes(def.card)))
				errors.push(`${where}: card "${def.card}" is not one of CARD_KEYS`);
			if (def.eval != null && typeof def.eval !== 'function')
				errors.push(`${where}: eval is not a function`);
			if (def.wire != null && typeof def.wire !== 'function')
				errors.push(`${where}: wire is not a function`);
			if (def.referenceJs != null && typeof def.referenceJs !== 'string')
				errors.push(`${where}: referenceJs is not a string`);
			// 2.0-n3c: `v` = the definition's version (absent = 1); bump it when a saved node of this type
			// must be told apart from one made before (a changed default, a changed meaning)
			if (def.v !== undefined && !(Number.isInteger(def.v) && def.v >= 1))
				errors.push(`${where}: v must be an integer >= 1`);
		}
	}
	return errors;
}
