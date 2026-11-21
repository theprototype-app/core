// 2.0 N1 — the Logic family: ONE definition per node type. A definition is its palette
// entry (label, defaults, params, inputs, note — exactly what nodeCatalog lists) plus the halves that
// used to live elsewhere: `sockets` (flowSockets OUTPUT / INPUT / OUTPUT_HANDLES), `card` (the
// Nodes.svelte component key) and `eval` (evalNodeBody's case; runtime helpers come in as `rt`).
// A LEAF: nothing here imports the runtime. Adding a node = one entry in this file.
import { BEHAVIOUR_STARTER } from '../../behaviours/starter.js';

/** @type {import('../registry.js').NodeFamily} */
export default {
	group: 'Logic',
	nodes: [
		{
			type: 'script',
			label: 'Script',
			defaults: {
				code:
					'// runs every frame on every peer (keep it deterministic)\n' +
					'// object: the connected THREE object; base: {pos, rot, scale, visible}\n' +
					'// data: this node\'s data (incl. wired a/b/c inputs); time: synced seconds\n' +
					'object.position.y = base.pos[1] + Math.sin(time * 2) * 0.5;\n'
			},
			sockets: { out: 'effect', in: { a: 'number', b: 'number', c: 'number' } },
			card: 'ScriptNode',
			eval(node, { d, time, input, ctx }, rt) {
				// 34 D3: a Script node with declared OUTPUTS is a value node — a pure function of
				// its declared inputs and the synced clock, read through a handle map exactly like
				// objectflow's. Without outputs it is an effect (applyAnimation) and has no value.
				const outputs = rt.scriptOutputs(d);
				if (!outputs.length) return undefined;
				// one run per node per tick: the card readout, and every consumer of every
				// handle, would otherwise each run the code again at the same instant
				const memo = rt.scriptValueMemo.get(node.id);
				if (memo && memo.time === time && memo.data === node.data) return memo.value;
				/** @type {Record<string, any>} */
				const inputs = {};
				for (const socket of rt.scriptInputs(d) ?? [])
					inputs[socket.name] = rt.scriptInputValue(socket, input(socket.name, socket.value), ctx);
				const value = rt.runScriptValue(node.id, d.code ?? '', inputs, time, outputs, rt.scriptApi(node.id, d.code ?? '', 'value', ctx));
				if (rt.scriptValueMemo.size > 500) rt.scriptValueMemo.clear(); // deleted nodes' entries
				rt.scriptValueMemo.set(node.id, { time, data: node.data, value });
				return value;
			}
		},
		// 34 R3 (D1): a BEHAVIOUR — game logic as a .js file in data.code (behaviours/app.js
		// loads it; the node has no sockets: it listens to kit events, and Open view shows its
		// derived live node view)
		{
			type: 'behaviour', label: 'Behaviour', defaults: { name: 'Behaviour', enabled: true, code: BEHAVIOUR_STARTER },
			sockets: { out: 'effect' },
			// 34 R3
			card: 'BehaviourNode',
			eval(node, _x, rt) {
				// 36 (U10): a behaviour's VALUE outputs are its replicated state fields (the `bhv`
				// document every peer holds), read by handle like objectflow's
				return { __handles: rt.behavioursRef?.behaviourState?.(node.id) ?? {} };
			}
		},
		// 36 (G1): a CODE LINK — names a module (or kit) file whose logic runs this game, so the
		// Main graph shows where every rule lives; double-click opens it read-only. Inert at
		// runtime (no sockets, no value, no effect).
		{
			type: 'coderef',
			label: 'Code link',
			defaults: { module: '', file: '', title: '' },
			params: [
				{ key: 'title', kind: 'text', placeholder: 'what this code does', maxLength: 80 },
				{ key: 'module', kind: 'text', placeholder: 'module id', maxLength: 60 },
				{ key: 'file', kind: 'text', placeholder: 'module.js', maxLength: 120 }
			],
			sockets: { out: 'effect' },
			// 36 (G1): a Main-graph link to module/kit code
			card: 'CodeRefNode'
		},
		// 133: pure logic on wired inputs (deterministic, no streaming)
		// 36 (flow-revamp 201): `params` = the ⓘ panel's schema (BinaryNode draws its own card)
		{
			type: 'math',
			label: 'Math',
			defaults: { op: 'add', a: 0, b: 0 },
			params: [
				{ key: 'op', kind: 'select', options: ['add', 'sub', 'mul', 'div', 'min', 'max', 'mod', 'pow', 'sin', 'cos', 'abs', 'round', 'floor', 'clamp', 'neg'] },
				{ key: 'a', kind: 'number' },
				{ key: 'b', kind: 'number' }
			],
			// 37 (R6): math and gate are VARIADIC — c..h are the extra sockets a node may grow
			// (variadicNodes.js). Declared here so a group routing one, and the socket colour, read the
			// right type (an undeclared gate handle would type as 'number').
			sockets: { out: 'number', in: { a: 'number', b: 'number', c: 'number', d: 'number', e: 'number', f: 'number', g: 'number', h: 'number' } },
			card: 'BinaryNode',
			// 2.0-n3c: the built-in's value as code (Convert to code; parity-tested)
			eval(node, { input, d, allEdges }, rt) {
				const a = rt.num(input('a', d.a ?? 0));
				const b = rt.num(input('b', d.b ?? 0));
				// 37 (R6): a foldable op takes every WIRED extra socket (c..h) too; an unwired extra is
				// skipped (it has no manual value). Two sockets = the 133 arithmetic, byte-identical.
				if (rt.socketCount(d) > 2 && rt.opFolds('math', d.op)) return rt.foldMath(d.op ?? 'add', [a, b, ...rt.variadicExtras(node, allEdges, input).map(rt.num)]);
				switch (d.op ?? 'add') {
					case 'sub': return a - b;
					case 'mul': return a * b;
					case 'div': return b !== 0 ? a / b : 0;
					case 'min': return Math.min(a, b);
					case 'max': return Math.max(a, b);
					case 'mod': return b !== 0 ? ((a % b) + b) % b : 0;
					// 36 (plan 56.4): the unary shapers a value graph needs between a slider and
					// a param. `b` scales sin/cos (0 = 1, so a fresh node reads sin(a)); `clamp`
					// keeps a inside [0, b] (b <= 0 = [0, 1]); `pow` is a^b.
					case 'pow': return Math.pow(a, b);
					case 'sin': return Math.sin(a) * (b || 1);
					case 'cos': return Math.cos(a) * (b || 1);
					case 'abs': return Math.abs(a);
					case 'round': return Math.round(a);
					case 'floor': return Math.floor(a);
					case 'clamp': return Math.min(Math.max(a, 0), b > 0 ? b : 1);
					case 'neg': return -a;
					default: return a + b;
				}
			}
		},
		{
			type: 'compare',
			label: 'Compare',
			defaults: { op: 'gt', a: 0, b: 0 },
			params: [
				{ key: 'op', kind: 'select', options: ['gt', 'lt', 'eq', 'gte', 'lte', 'neq'] },
				{ key: 'a', kind: 'number' },
				{ key: 'b', kind: 'number' }
			],
			sockets: { out: 'boolean', in: { a: 'number', b: 'number' } },
			card: 'BinaryNode',
			// 2.0-n3c: the built-in's value as code (Convert to code; parity-tested)
			eval(node, { input, d }, rt) {
				const a = rt.num(input('a', d.a ?? 0));
				const b = rt.num(input('b', d.b ?? 0));
				switch (d.op ?? 'gt') {
					case 'lt': return a < b;
					case 'eq': return a === b;
					case 'gte': return a >= b;
					case 'lte': return a <= b;
					case 'neq': return a !== b;
					default: return a > b;
				}
			}
		},
		{
			type: 'gate',
			label: 'Gate',
			defaults: { op: 'and', a: false, b: false },
			params: [
				{ key: 'op', kind: 'select', options: ['and', 'or', 'not', 'xor'] },
				{ key: 'a', kind: 'toggle' },
				{ key: 'b', kind: 'toggle' }
			],
			sockets: { out: 'boolean', in: { a: 'boolean', b: 'boolean', c: 'boolean', d: 'boolean', e: 'boolean', f: 'boolean', g: 'boolean', h: 'boolean' } },
			card: 'BinaryNode',
			// 2.0-n3c: the built-in's value as code (Convert to code; parity-tested)
			eval(node, { input, d, allEdges }, rt) {
				const a = rt.bool(input('a', d.a ?? false));
				const b = rt.bool(input('b', d.b ?? false));
				// 37 (R6): AND/OR/XOR over every wired extra socket (XOR = odd parity)
				if (rt.socketCount(d) > 2 && rt.opFolds('gate', d.op)) return rt.foldGate(d.op ?? 'and', [a, b, ...rt.variadicExtras(node, allEdges, input).map(rt.bool)]);
				switch (d.op ?? 'and') {
					case 'or': return a || b;
					case 'not': return !a;
					case 'xor': return a !== b;
					default: return a && b;
				}
			}
		},
		// 4.6: loop-closers from the NODES.md audit
		{
			type: 'maprange', label: 'Map Range', defaults: { inMin: 0, inMax: 1, outMin: 0, outMax: 1, clamp: true, a: 0 },
			sockets: { out: 'number', in: { a: 'number' } },
			card: 'MapRangeNode',
			// 2.0-n3c: the built-in's value as code (Convert to code; parity-tested)
			eval(node, { input, d }, rt) {
				// 4.6: remap a from [inMin..inMax] to [outMin..outMax] (optional clamp)
				const a = rt.num(input('a', d.a ?? 0));
				const inMin = rt.num(d.inMin ?? 0);
				const inMax = rt.num(d.inMax ?? 1);
				const outMin = rt.num(d.outMin ?? 0);
				const outMax = rt.num(d.outMax ?? 1);
				const span = inMax - inMin;
				let t = span === 0 ? 0 : (a - inMin) / span;
				if (d.clamp ?? true) t = Math.min(Math.max(t, 0), 1);
				return outMin + t * (outMax - outMin);
			}
		},
		// 4.6 -> 21-E4: Select grew N-WAY. a/b keep their handle ids, so every saved
		// 2-input graph is byte-identical (see the clamp note in evalNodeBody).
		{
			type: 'select', label: 'Select', defaults: { index: 0, a: 0, b: 0 },
			// 4.6: loop-closers
			// 21-E4: c/d are ADDITIVE - a/b keep their ids, so no saved edge moves
			sockets: { out: 'number', in: { index: 'number', a: 'number', b: 'number', c: 'number', d: 'number' } },
			card: 'SelectNode',
			// 2.0-n3c: the built-in's value as code (Convert to code; parity-tested)
			eval(node, { d, allEdges, input }, rt) {
				// 4.6: pick a or b by a wired index/boolean (switcher/compare pair-up).
				// 21-E4: N-WAY. The index is ROUNDED, which reproduces the old `< 0.5 ? a : b`
				// split exactly over the 0/1 range, and CLAMPED to the highest slot this node
				// actually uses - so a saved 2-input Select handed an out-of-range index still
				// lands on `b` the way it always did, while a graph that wires or sets c/d gets
				// four. That pair of rules is what keeps every existing Select byte-identical
				// (random -> select over four spawn points is the case it was grown for).
				const keys = ['a', 'b', 'c', 'd'];
				let last = 1;
				for (let i = 2; i < keys.length; i++)
					if (
						d[keys[i]] !== undefined ||
						allEdges.some((e) => e.target === node.id && e.targetHandle === keys[i])
					)
						last = i;
				const at = Math.min(last, Math.max(0, Math.round(rt.num(input('index', d.index ?? 0)))));
				return input(keys[at], d[keys[at]] ?? 0);
			}
		},
		// --- 21-E4: the logic a game LOOP is made of. Every trigger in this app is a
		// ~0.3s pulse and, before these, NOTHING turned a pulse into persistent state:
		// `counter` was the only stateful node and its op was a param, not an input. That
		// one gap blocked hide-on-collect, hold-to-show, one-shot doors and cooldowns at
		// the same time.
		//
		// THE UNBLOCK: a pulse becomes a boolean that HOLDS. Deterministic with no new
		// message - `set`/`reset` compare the replicated trigger STAMPS every peer
		// already has (most recent wins), which is strictly better than counting for a
		// late joiner: it converges on the very next pulse of either kind. `toggle` is
		// the one half that cannot be pure (a stamp is not a count) and takes the
		// counter precedent instead - counted in applyNodeTrigger, which every peer runs
		// from the same replicated stamp.
		{
			type: 'latch',
			label: 'Latch',
			defaults: { initial: false },
			inputs: ['set', 'reset', 'toggle'],
			inputLabels: { set: 'set - turn on', reset: 'reset - turn off', toggle: 'toggle - flip' },
			// 21-F2: `perRound` is the collectible RESET, opt-in per node. With it on, a
			// set/reset stamp from a previous round did not happen, so the latch falls
			// back to `initial` — which is how a collected gem comes back when the round
			// bumps or the game returns to its menu, with no reset edge to draw and
			// nothing sent. Off by default: a Latch in a graph with no game must not
			// change behaviour because somebody pressed Start.
			params: [
				{ key: 'initial', kind: 'toggle' },
				{ key: 'perRound', kind: 'toggle', label: 'reset each round' }
			],
			// 21-E4: the logic a game loop is made of. Latch is the only STATE node here -
			// a boolean that holds after the pulse that set it has expired. The other three
			// are event RESHAPERS, so they carry the event channel onward and everything
			// already wired to an event (Object Selector, Counter, a trigger input) accepts
			// them with no coercion table change.
			// 21-E4 logic nodes. Every socket here is an EVENT except delay's wired seconds:
			// these turn pulses into state and into other pulses, they never take values.
			sockets: { out: 'boolean', in: { set: 'event', reset: 'event', toggle: 'event' } },
			// 21-E4: the logic a game loop is made of. All spec-driven except Sequence,
			// which is the only one with several OUTPUTS and so needs its own four rows.
			card: 'AnimationNode',
			eval(node, { ctx, d }, rt) {
				// set/reset are a PURE most-recent-stamp-wins read of the replicated trigger
				// log, so two peers holding the same stamps cannot disagree - and a late joiner,
				// which arrives with an EMPTY log (the log is not part of the handshake),
				// converges on the very next set or reset it sees. That is strictly better than
				// counting, which would leave it permanently offset.
				// 21-F2: with `perRound` on, a stamp from a PREVIOUS round did not happen, so
				// the latch falls back to `initial` - which is what un-collects a collectible
				// when the round bumps or the game returns to its menu. Purity is untouched:
				// the extra input is the replicated round, not a state of our own.
				const setT = rt.freshStamp(node, rt.handleStamp(node, 'set', ctx));
				const resetT = rt.freshStamp(node, rt.handleStamp(node, 'reset', ctx));
				const base =
					setT === null && resetT === null
						? !!d.initial
						: (setT ?? -Infinity) >= (resetT ?? -Infinity); // a same-millisecond tie reads as SET
				// toggle PARITY is the half a stamp cannot carry (a stamp is not a count), so it
				// is counted in applyNodeTrigger - the counter precedent - and CLEARED there by
				// any set/reset, which is what lets the two halves compose instead of fighting.
				const own = ctx?.triggers?.[node.id];
				const flips = rt.roundStale(node, own?.lastT) ? 0 : (own?.count ?? 0);
				return flips % 2 === 0 ? base : !base;
			}
		},
		// "3 seconds after the door opens, close it", and every cooldown. PURE: the
		// output fires at stamp + seconds, which each peer reaches on its own clock from
		// the one shared stamp, so nothing is scheduled and nothing is sent.
		{
			type: 'delay',
			label: 'Delay',
			defaults: { seconds: 1, pulse: 0.3 },
			inputs: ['trigger', 'cancel'],
			inputLabels: { trigger: 'trigger', cancel: 'cancel - drop a pending pulse' },
			params: [{ key: 'seconds', kind: 'range', min: 0, max: 60, step: 0.1 }],
			sockets: { out: 'event', in: { trigger: 'event', cancel: 'event', seconds: 'number' } },
			card: 'AnimationNode',
			eval(node, { ctx, time, d }, rt) {
				// PURE, and it needs no state at all: the moment is stamp + seconds, the output
				// is a pulse window around it, and `cancel` is a stamp comparison.
				return rt.pulseAt(rt.scheduledFireAt(node, null, ctx), time, rt.num(d.pulse ?? 0.3));
			}
		},
		// chained steps off ONE pulse. Four fixed outputs, each at its CUMULATIVE offset
		// from the input stamp - derived exactly like Delay, so a step is a pure
		// function of (stamp, params, synced time). Its own card: four source handles.
		{
			type: 'sequence',
			label: 'Sequence',
			defaults: { delay1: 0, delay2: 0.5, delay3: 0.5, delay4: 0.5, pulse: 0.3 },
			inputs: ['trigger'],
			// all four step handles; outputType is per-NODE, not per-handle
			sockets: { out: 'event', in: { trigger: 'event' } },
			card: 'SequenceNode',
			eval(node, { ctx, time, d }, rt) {
				// four outputs, so the value is a HANDLE MAP (the objectflow shape) that
				// unwrapHandle picks apart by the reading edge's sourceHandle
				/** @type {Record<string, number>} */
				const handles = {};
				for (const step of rt.SEQUENCE_STEPS)
					handles[step] = rt.pulseAt(rt.scheduledFireAt(node, step, ctx), time, rt.num(d.pulse ?? 0.3));
				return { __handles: handles };
			}
		},
		// one-shot doors, first-visit triggers. The FIRST stamp is not derivable from a
		// trigger log that keeps only the LAST one, so this is the counter precedent:
		// applyNodeTrigger freezes the first stamp on the node's own entry and `rearm`
		// clears it.
		{
			type: 'once',
			label: 'Once',
			defaults: { pulse: 0.3 },
			inputs: ['trigger', 'rearm'],
			inputLabels: { trigger: 'trigger', rearm: 'rearm - allow it again' },
			// 21-F2: the Latch's flag, same rule — a Once frozen in a previous round
			// reads as armed again, so a collectible counts once PER ROUND
			params: [{ key: 'perRound', kind: 'toggle', label: 'reset each round' }],
			sockets: { out: 'event', in: { trigger: 'event', rearm: 'event' } },
			card: 'AnimationNode',
			eval(node, { ctx, time, d }, rt) {
				// the counter precedent: applyNodeTrigger writes this node's OWN entry on the
				// first pulse and freezes it at count 1, and `rearm` deletes it. A frozen stamp
				// is exactly what a downstream stamp-edge consumer needs in order to act once.
				// 21-F2: a `perRound` Once frozen in a previous round reads as ARMED again
				const entry = ctx?.triggers?.[node.id];
				if (!entry || entry.count !== 1 || rt.roundStale(node, entry.lastT)) return 0;
				return rt.pulseAt(entry.lastT, time, rt.num(d.pulse ?? 0.3));
			}
		},
		// 21-E5-era placement fix (2026-08-22): a Counter is not a trigger, it COUNTS
		// them — it is the only node in the old Triggers group with inputs of its own
		// (pulse/reset) and it outputs a number, so it belongs with the other stateful
		// logic (Latch/Delay/Sequence/Once) rather than among the event SOURCES.
		{
			type: 'counter', label: 'Counter', defaults: { op: 'up', step: 1 },
			// 21-E4: `reset` joins `pulse` on the SAME path - the counting lives inside
			// applyNodeTrigger, so the reset is one more handle it reads there (the `op`
			// param stays for a counter nobody wires a reset into).
			sockets: { out: 'number', in: { pulse: 'event', reset: 'event' } },
			card: 'CounterNode',
			eval(node, { ctx }, rt) {
				return ctx && ctx.triggers && ctx.triggers[node.id] ? ctx.triggers[node.id].count : 0;
			}
		},
		// 134: loops, timers, sensors + object actions (all deterministic)
		{
			type: 'loop',
			label: 'Loop',
			defaults: { from: 0, to: 1, rate: 1, mode: 'wrap' },
			params: [
				{ key: 'mode', kind: 'select', options: ['wrap', 'pingpong'] },
				{ key: 'from', kind: 'number' },
				{ key: 'to', kind: 'number' },
				{ key: 'rate', kind: 'number', step: 0.1 }
			],
			sockets: { out: 'number' },
			card: 'LoopNode',
			eval(node, { d, time }, rt) {
				const from = rt.num(d.from ?? 0);
				const to = rt.num(d.to ?? 1);
				const span = to - from;
				const phase = time * rt.num(d.rate ?? 1);
				if (d.mode === 'pingpong') {
					const p = ((phase % 2) + 2) % 2;
					return from + (p > 1 ? 2 - p : p) * span;
				}
				if (d.mode === 'once') return from + Math.min(Math.max(phase, 0), 1) * span;
				return from + (((phase % 1) + 1) % 1) * span; // wrap
			}
		},
		{
			type: 'timer', label: 'Timer', defaults: { delay: 1, a: 0 },
			sockets: { out: 'number', in: { a: 'number' } },
			card: 'TimerNode',
			eval(node, { d, allEdges, allNodes, time, ctx }, rt) {
				// delay line: re-evaluate the wired input at a clock-shifted time
				const delay = rt.num(d.delay ?? 1);
				const edge = rt.edgesInto(allEdges, node.id).find((e) => e.targetHandle === 'a');
				if (edge) {
					const v = rt.evalNode(
						rt.nodeById(allNodes, edge.source),
						allNodes,
						allEdges,
						time - delay,
						new Set([node.id]),
						ctx
					);
					return v !== undefined ? v : rt.num(d.a ?? 0);
				}
				return rt.num(d.a ?? 0);
			}
		},
		{
			type: 'distance', label: 'Distance', defaults: {},
			sockets: { out: 'number', in: { a: 'object', b: 'object' } },
			card: 'ObjectPairNode',
			eval(node, { input, d, ctx }, rt) {
				// 4.1: also accept a wired Vector3 LITERAL as a world point (the coercion
				// matrix allows vector3->object and lookat already honors it)
				const pa = rt.pointOf(input('a', d.a), ctx);
				const pb = rt.pointOf(input('b', d.b), ctx);
				return pa && pb ? pa.distanceTo(pb) : 0;
			}
		},
		{
			type: 'proximity',
			label: 'Proximity',
			defaults: { radius: 3 },
			// 78 F10: to: player — b is THIS peer's player (its body, feet to eye)
			params: [
				{ key: 'radius', kind: 'number', step: 0.1 },
				{ key: 'to', kind: 'select', options: ['object', 'player'], legacy: 'object', doc: 'object = the object wired into b; player = your own player (each peer reads its own)' }
			],
			sockets: { out: 'boolean', in: { a: 'object', b: 'object' } },
			card: 'ObjectPairNode',
			eval(node, { input, d, ctx }, rt) {
				const pa = rt.pointOf(input('a', d.a), ctx);
				// 78 F10: `to: player` measures to THIS peer's player — its body (feet..eye, the reach
				// rule), so a pad on the floor is near a standing player. LOCAL by design: each peer
				// reads its own player (the gamepadaxis rule); a SHARED reaction goes through On Enter.
				if (d.to === 'player') {
					const body = rt.gameFeelActive() ? rt.localPlayerBody() : null;
					return pa && body ? rt.bodyDistance(pa, body.eye, body.feetY) <= rt.num(d.radius ?? 3) : false;
				}
				const pb = rt.pointOf(input('b', d.b), ctx);
				return pa && pb ? pa.distanceTo(pb) <= rt.num(d.radius ?? 3) : false;
			}
		},
		{
			type: 'lookat', label: 'Look At', defaults: {},
			sockets: { out: 'effect', in: { target: 'object' } },
			card: 'EffectNode'
		},
		{
			type: 'setcolor', label: 'Set Color', defaults: { color: '#ff4000' },
			sockets: { out: 'effect', in: { color: 'color' } },
			card: 'EffectNode'
		},
		{
			type: 'visibility', label: 'Visibility', defaults: { on: true },
			sockets: { out: 'effect', in: { on: 'boolean' } },
			card: 'EffectNode'
		},
		// SH7: write a shader-graph uniform. `uniform` is the generated name the Shader
		// editor shows beside a uniform-backed param; the value rides a number socket, so
		// no recompile and no message of its own (the flow value is already replicated).
		{
			type: 'setuniform', label: 'Set Shader Uniform', defaults: { uniform: '', value: 0 },
			sockets: { out: 'effect', in: { value: 'number' } },
			card: 'EffectNode'
		},
		// 102 M7: drive one of the object's constraints (Inspector > Constraints) from a graph,
		// LOCAL per peer like setuniform: the value comes through the replicated graph
		{
			type: 'constraintweight', label: 'Set Constraint Weight', defaults: { constraint: '1', weight: 1 },
			sockets: { out: 'effect', in: { weight: 'number' } },
			card: 'EffectNode'
		},
		{
			type: 'constrainttarget', label: 'Set Constraint Target', defaults: { constraint: '1' },
			sockets: { out: 'effect', in: { target: 'object' } },
			card: 'EffectNode'
		}
	]
};
