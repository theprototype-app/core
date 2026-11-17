// 2.0 N1 — the HUD family: ONE definition per node type. A definition is its palette
// entry (label, defaults, params, inputs, note — exactly what nodeCatalog lists) plus the halves that
// used to live elsewhere: `sockets` (flowSockets OUTPUT / INPUT / OUTPUT_HANDLES), `card` (the
// Nodes.svelte component key) and `eval` (evalNodeBody's case; runtime helpers come in as `rt`).
// A LEAF: nothing here imports the runtime. Adding a node = one entry in this file.
import * as shared from '../evalShared.js';

/** @type {import('../registry.js').NodeFamily} */
export default {
	group: 'HUD',
	nodes: [
		// show / hide / toggle a screen. LOCAL and per-peer BY DESIGN: one player can
		// sit on the start menu while another plays. Say so on the card, or it gets
		// reported as "my peer doesn't see the menu".
		{
			type: 'hudscreen',
			label: 'HUD Screen',
			defaults: { screen: '', action: 'show' },
			params: [
				{ key: 'screen', kind: 'text', placeholder: 'screen id', maxLength: 64 },
				{ key: 'action', kind: 'select', options: ['show', 'hide', 'toggle'] }
			],
			sockets: { out: 'effect', in: { trigger: 'event' } },
			// A3: ONE generic card for the whole HUD group (the ShaderNode precedent)
			card: 'HudNode'
		},
		// `format` is where the score actually gets rendered: '{v}' is the wired
		// number, so 'Gems: {v}' needs no string node and there is no string socket
		// type to invent.
		{
			type: 'hudtext',
			label: 'HUD Text',
			defaults: { element: '', format: '{v}', decimals: 0, value: 0 },
			params: [
				{ key: 'format', kind: 'text', placeholder: 'Gems: {v}', maxLength: 120 },
				{ key: 'decimals', kind: 'range', min: 0, max: 4, step: 1 }
			],
			// A3 HUD. `value` is the whole point: counter -> hudtext is a live score with no
			// new code, because Counter already counts replicated pulses and every number
			// source already reaches a named input through resolveInputs.
			// 36 (U10): `format` takes TEXT from a wire (a behaviour's state line, a script's words)
			sockets: { out: 'effect', in: { value: 'number', format: 'any' } },
			card: 'HudNode'
		},
		{
			type: 'hudbar',
			label: 'HUD Bar',
			defaults: { element: '', min: 0, max: 100, value: 0, format: '' },
			params: [
				{ key: 'min', kind: 'range', min: -1000, max: 1000, step: 1 },
				{ key: 'max', kind: 'range', min: -1000, max: 1000, step: 1 },
				{ key: 'format', kind: 'text', placeholder: 'optional label', maxLength: 80 }
			],
			sockets: { out: 'effect', in: { value: 'number', min: 'number', max: 'number' } },
			card: 'HudNode'
		},
		// EVENT out. A press goes through the existing replicated nodetrigger path
		// (fireHudButton), exactly like fireObjectClick — so event->number coercion,
		// Counter fan-in and triggerStampFor all work on it unchanged.
		{
			type: 'hudbutton', label: 'HUD Button', defaults: { element: '' },
			// A3 HUD: only the button and the timer produce anything. hudtext/hudbar/
			// hudscreen/hudlist are SINKS — they write into an element, so their output stays
			// the effect channel.
			sockets: { out: 'event' },
			card: 'HudNode',
			// 36 / DEVX #22: the press is the onclick pulse window — a wire
			eval: shared.evalPulseWindow
		},
		// counts DOWN from `duration` off the shared trigger stamp, so every peer
		// reads the same remaining time with no clock of its own
		{
			type: 'hudtimer',
			label: 'HUD Timer',
			defaults: { element: '', duration: 60, format: '{v}', decimals: 0, autostart: true },
			params: [
				{ key: 'duration', kind: 'range', min: 1, max: 600, step: 1 },
				{ key: 'format', kind: 'text', placeholder: '{v}s', maxLength: 80 },
				{ key: 'decimals', kind: 'range', min: 0, max: 2, step: 1 },
				{ key: 'autostart', kind: 'toggle' }
			],
			sockets: { out: 'number', in: { start: 'event', duration: 'number' } },
			card: 'HudNode',
			eval: shared.evalHudTimer
		},
		// A LIST is an element WRITTEN INTO by id, never a value that flows: the
		// socket system has no arrays, and every game wants a leaderboard. This node
		// names the element and its title; HUD Rows below fills it, as does the
		// element's own authored row list and `api.hud.rows`.
		{
			type: 'hudlist',
			label: 'HUD List',
			defaults: { element: '', title: '', rows: 5 },
			params: [
				{ key: 'title', kind: 'text', placeholder: 'optional title', maxLength: 80 },
				{ key: 'rows', kind: 'range', min: 1, max: 20, step: 1 }
			],
			sockets: { out: 'effect', in: { trigger: 'event' } },
			card: 'HudNode'
		},
		// 21-E7.1: the WRITER for a list. Set replaces the rows, Append adds one, Clear
		// empties it - all on the trigger's EDGE, because appending per frame would add
		// the same row sixty times a second.
		//
		// NOTHING IS SENT. The trigger stamp is already replicated and `text` is resolved
		// from the already-replicated graph, so every peer runs the same ops in the same
		// order and holds the same rows - the Counter argument. (A peer who joins later
		// never saw those edges, so rebuild from state with Set if that matters.)
		{
			type: 'hudrows',
			label: 'HUD Rows',
			defaults: { element: '', op: 'append', text: '' },
			params: [
				{ key: 'op', kind: 'select', options: ['set', 'append', 'clear'] },
				{ key: 'text', kind: 'text', placeholder: 'the row', maxLength: 120 }
			],
			// 21-E7.1: HUD Rows is a SINK like hudtext/hudlist - it writes into an element - so its
			// output stays the effect channel. Listed rather than left to the fallback, so the table
			// says so out loud (the movespeed/charcontroller precedent).
			// 21-E7.1: `text` is the ROW. There is no string socket type in this system, so it is
			// declared numeric like every other value handle - which accepts a number, an event and
			// a boolean through the coercion table, and a module value node declaring 'number' that
			// happens to return a string (a peer name). resolveInputs does not coerce the value, so
			// the row is whatever the source produced.
			sockets: { out: 'effect', in: { trigger: 'event', text: 'number' } },
			// 21-G1 fix, PRE-EXISTING since 21-E7 (ea46a7d): `hudrows` reached `nodeCatalog`
			// and never this map, so a node dragged out of the CORE HUD palette rendered as
			// UnknownNode — "this node comes from a module that isn't installed". Exactly the
			// two-registry gotcha, and `flow-unknown-node` was red on release/next for it.
			card: 'HudNode'
		},
		// 21-G4: THE LEADERBOARD, and it is the DERIVED counterpart to HUD Rows above.
		// That node is edge-driven because appending per frame is a memory leak; a
		// scoreboard has no events at all — it is a pure function of every peer's own
		// row plus the roster, both already replicated — so it runs every tick, writes
		// on CHANGE, and is right for a late joiner who witnessed no edges. `{name}`,
		// `{v}` and `{rank}` are the format tokens.
		{
			type: 'leaderboard',
			label: 'Leaderboard',
			defaults: { element: '', variable: 'laps', order: 'desc', format: '{name} — {v}', decimals: 0, limit: 10 },
			params: [
				{ key: 'variable', kind: 'text', placeholder: 'laps', maxLength: 40 },
				{ key: 'order', kind: 'select', options: ['desc', 'asc'] },
				{ key: 'format', kind: 'text', placeholder: '{name} — {v}', maxLength: 80 },
				{ key: 'decimals', kind: 'range', min: 0, max: 3, step: 1 },
				{ key: 'limit', kind: 'range', min: 1, max: 20, step: 1 }
			],
			// 21-G4: the derived scoreboard is a SINK for the same reason — it writes rows INTO a
			// list element and produces nothing a wire could carry.
			sockets: { out: 'effect' },
			// 21-G4: the derived scoreboard names an element like every other HUD node
			card: 'HudNode'
		},
		// 21-D4: the INPUT pair. Everything else in this group WRITES to the HUD;
		// these are the direction that did not exist - the HUD as a SOURCE.
		//
		// `read` is what a graph wants from one control: a slider gives a number, a
		// dropdown gives its index (for a Switcher) or its text, a toggle gives 1/0.
		// Deriving all of them from one field beats four node types.
		{
			type: 'hudinput',
			label: 'HUD Input',
			defaults: { element: '', read: 'value', fallback: 0 },
			params: [
				{ key: 'read', kind: 'select', options: ['value', 'index', 'text', 'on'] },
				{ key: 'fallback', kind: 'range', min: -1000, max: 1000, step: 1 }
			],
			// 21-D4: the HUD as a SOURCE. `read` decides what the number MEANS (a slider's
			// value, a dropdown's index, a toggle as 1/0) but the socket is a number either
			// way, so one type covers all four input kinds.
			sockets: { out: 'number', in: {} },
			card: 'HudNode',
			eval(node, { d }, rt) {
				// LOCAL read. A local value is per-peer BY DESIGN (my volume), and a shared one
				// is already replicated, so in both cases every peer reads its own store and
				// nothing about the read goes on the wire.
				const held = rt.hudValueOf(String(d.element ?? ''), undefined);
				const fallback = d.fallback ?? 0;
				if (held === undefined) return rt.num(fallback);
				switch (d.read ?? 'value') {
					case 'on':
						// a toggle as 1/0, so it can gate a Compare or scale a number
						return held === true || held === 'true' || rt.num(held) > 0 ? 1 : 0;
					case 'text':
						return String(held);
					case 'index': {
						// a dropdown's POSITION in its own option list, which is what a Switcher
						// wants. The options live on the ELEMENT, not on this node - the node
						// names an element and nothing more.
						const id = String(d.element ?? '');
						const el = rt.findHudElement(id);
						// 21-E7.6: a `tabs` element HOLDS the index, so looking a number up in a list
						// of words would answer the fallback forever. The registry says which kinds
						// are index-valued, so this is one read and not a kind list here.
						if (rt.isIndexValuedKind(String(el?.kind ?? ''))) return rt.num(held);
						// 21-E7.2: the LIVE list, not the authored one — a node feeding the options
						// must move the index with them, or a Switcher reads a stale position.
						const options = rt.hudOptionsOf(id, el);
						const at = options.indexOf(String(held));
						return at < 0 ? rt.num(fallback) : at;
					}
					default:
						return typeof held === 'boolean' ? (held ? 1 : 0) : rt.num(held);
				}
			}
		},
		// the other direction: a graph MOVES a control (a Reset button putting the
		// volume back, a difficulty the host sets). Effect in, so it fires on a
		// trigger edge rather than every frame.
		// 21-E7.2: it also carries the OPTIONS channel. Wire a list into `options` and it
		// REPLACES the dropdown's authored one live - which is how 'the peers in this
		// room' or 'the difficulties this scene ships' become a menu. Deliberately not a
		// node param: with nothing wired the handle resolves to undefined, nothing is
		// published, and the authored list stays in charge byte-for-byte.
		{
			type: 'hudset',
			label: 'HUD Set Input',
			defaults: { element: '', value: 0 },
			params: [{ key: 'value', kind: 'range', min: -1000, max: 1000, step: 1 }],
			// 21-E7.2: `options` joins it - same reasoning as hudrows' `text` about the missing
			// string type, and additive, so no saved edge moves.
			sockets: { out: 'effect', in: { trigger: 'event', value: 'number', options: 'number' } },
			card: 'HudNode'
		}
	]
};
