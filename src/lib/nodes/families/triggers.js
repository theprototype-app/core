// 2.0 N1 — the Triggers family: ONE definition per node type. A definition is its palette
// entry (label, defaults, params, inputs, note — exactly what nodeCatalog lists) plus the halves that
// used to live elsewhere: `sockets` (flowSockets OUTPUT / INPUT / OUTPUT_HANDLES), `card` (the
// Nodes.svelte component key) and `eval` (evalNodeBody's case; runtime helpers come in as `rt`).
// A LEAF: nothing here imports the runtime. Adding a node = one entry in this file.
import { GAMEPAD_BUTTONS, GAMEPAD_AXES } from '../../gamepadPrefs';
import * as shared from '../evalShared.js';

/** @type {import('../registry.js').NodeFamily} */
export default {
	group: 'Triggers',
	nodes: [
		// 134: EVENT nodes — ride small replicated trigger messages, not state
		{
			type: 'onclick', label: 'On Click', defaults: { pulse: 0.3 },
			sockets: { out: 'event' },
			card: 'OnClickNode',
			eval: shared.evalPulseWindow
		},
		// 78 F2: a pointer, a phone tap or a VR laser over the object (Play / Interact). The
		// stamp replicates for `anyone` (everyone sees the bell swing) and stays on this peer
		// for `me`. `over` holds while the pointer stays.
		{
			type: 'onhover',
			label: 'On Hover',
			defaults: { on: 'enter', who: 'anyone', cooldown: 0, pulse: 0.3 },
			inputs: ['enabled'],
			inputLabels: { enabled: 'enabled - wire a boolean (unwired = on)' },
			params: [
				{ key: 'on', kind: 'select', options: ['enter', 'leave', 'over'] },
				{ key: 'who', kind: 'select', options: ['anyone', 'me'] },
				{ key: 'cooldown', kind: 'range', min: 0, max: 10, step: 0.1 }
			],
			note: 'Wire it into an Object Selector, or put it in the object\'s own flow. Mouse in Interact, the crosshair in Play, a tap on a phone, the laser in VR.',
			// 78 F2
			// 78 F2 / F3
			sockets: { out: 'event', in: { enabled: 'boolean' } },
			// 78 F2
			card: 'AnimationNode',
			eval(node, { ctx, time, d }, rt) {
				// 78 F2: the On Click window; an "over" node holds while its re-stamps keep coming
				const trig = ctx && ctx.triggers ? ctx.triggers[node.id] : null;
				const dt = trig ? time - trig.lastT : Infinity;
				const hold = d.on === 'over' ? Math.max(rt.OVER_WINDOW, rt.num(d.pulse ?? 0.3)) : rt.num(d.pulse ?? 0.3);
				return dt >= 0 && dt < hold ? 1 : 0;
			}
		},
		// 30b (core-games): a player picked the object up — desktop play/Interact carry or
		// a VR Interact grip (never an editor move). Towers' crates sound on the lift.
		{
			type: 'ongrab', label: 'On Grab', defaults: { pulse: 0.3 },
			// 30b (core-games)
			sockets: { out: 'event' },
			// 30b (core-games): the same pulse card
			card: 'OnClickNode',
			// 30b (core-games): the On Click window, fired on a player's grab
			eval: shared.evalPulseWindow
		},
		// H3: keyboard trigger — LOCAL key presses replicate as trigger pulses
		// (golden rule: never stream local state); held keys re-pulse so the
		// output stays high while held
		// 21-E3: `edge` picks WHICH moment fires. 'down' is the original pulse (held
		// keys re-pulse, so the output stays high while held - byte-identical for
		// every saved graph, absent = down). 'up' is the missing falling edge, the
		// other half of hold-to-show ("keypress(down) -> show, keypress(up) -> hide").
		// 'held' reads as a steady 1 while the key is down WITHOUT a toggle fighting
		// the re-stamp - the re-stamp stays its implementation, so it costs no wire.
		{
			type: 'keypress',
			label: 'Key Press',
			defaults: { code: 'KeyR', pulse: 0.3, edge: 'down' },
			// 53 (A6): `action` names the binding in the player's Accessibility ▸ Controls list
			params: [
				{ key: 'edge', kind: 'select', options: ['down', 'up', 'held'] },
				{ key: 'action', kind: 'text', placeholder: 'action name for players (e.g. Jump)', maxLength: 40 }
			],
			// H3
			sockets: { out: 'event' },
			card: 'KeyPressNode',
			eval(node, { ctx, time, d }, rt) {
				// H3 + 21-E3: LOCAL keys arrive as replicated trigger stamps. `edge` picks the
				// moment: 'down' pulses on press (held keys re-pulse, so it reads 1 while held -
				// the original behavior, byte-identical for saved graphs); 'up' pulses on
				// release; 'held' is the same window read but SAYS level - the re-stamp is its
				// implementation, so a peer derives the level from stamp freshness with no new
				// wire. All three are one window over one replicated stamp channel.
				const trig = ctx && ctx.triggers ? ctx.triggers[node.id] : null;
				const dt = trig ? time - trig.lastT : Infinity;
				return dt >= 0 && dt < rt.num(d.pulse ?? 0.3) ? 1 : 0;
			}
		},
		// 24-A A2: a hand (VR controller) or a walking player KNOCKED this body (A1's
		// probe). Fired on EVERY peer as the `hit` message is applied, stamped from the
		// message's own `at` — one message per knock, identical stamps everywhere, no
		// nodetrigger. `who` is read per peer against the hitter's id, which is how a
		// per-player count reaches setvariable scope:'player' without a second writer.
		// Its own card (OnHitNode): the pulse dot plus `speed` and `byMe` value outputs,
		// so a graph can scale a burst by how hard the hit was.
		{
			type: 'onhit',
			label: 'On Hit',
			defaults: { pulse: 0.3, minSpeed: 0, who: 'anyone' },
			params: [
				{ key: 'minSpeed', kind: 'range', min: 0, max: 10, step: 0.1 },
				{ key: 'who', kind: 'select', options: ['anyone', 'me', 'others'] }
			],
			// 24-A A2: the pulse is the unnamed handle; `speed`/`byMe` are named handles that
			// reach number/boolean inputs through the event coercion row (outputType is per NODE)
			sockets: { out: 'event' },
			// 24-A A2: its own card — the pulse dot PLUS speed/byMe value rows (the MoveInput
			// shape: several source handles need labelled rows, not one right-edge dot)
			card: 'OnHitNode',
			eval(node, { ctx, time, d }, rt) {
				// 24-A A2: the knock's trigger. fireObjectHit stamps this node on EVERY peer
				// from the hit message's own `at`, so the pulse agrees everywhere with no second
				// message; speed/byMe are the LAST accepted hit's, held until the next one.
				const trig = ctx && ctx.triggers ? ctx.triggers[node.id] : null;
				const dt = trig ? time - trig.lastT : Infinity;
				const info = rt.hitInfo.get(node.id);
				return {
					__default: dt >= 0 && dt < rt.num(d.pulse ?? 0.3) ? 1 : 0,
					__handles: { speed: info ? info.speed : 0, byMe: info && info.byMe ? 1 : 0 }
				};
			}
		},
		// B6: fires once when a body settles, and re-arms when it moves again.
		// Initiator-detected, replicated stamp — the On Impact shape.
		{
			type: 'onrest',
			label: 'On Rest',
			defaults: { pulse: 0.3, seconds: 0.5 },
			params: [{ key: 'seconds', kind: 'range', min: 0.1, max: 5, step: 0.1 }],
			// B6: a body settled
			sockets: { out: 'event' },
			// B6 (the onimpact precedent: a trigger with params)
			card: 'AnimationNode',
			// no pulled value: consumers read this node's trigger log (a stamp-edge source)
			eval: null
		},
		// 21-E5 THE GAMEPAD, moved here from Input (2026-08-22): both are things arriving
		// from OUTSIDE the graph — the player’s thumb — which is what this group means, and
		// what Input does NOT: everything left there is a value the AUTHOR dials or the app
		// computes. A pad button is the Key Press model verbatim (edges replicate as trigger
		// stamps, the held level is derived per peer), so a pad press drives a game exactly
		// the way a key does with no new message type. A DEFAULT MAPPING is already on (left
		// stick moves, right stick looks, d-pad + A drive the HUD ring), so these nodes are
		// for a game that wants its OWN bindings; E6's controller nodes override the default.
		{
			type: 'gamepadbutton',
			label: 'Gamepad Button',
			defaults: { button: 'GamepadA', pulse: 0.3, edge: 'down' },
			params: [
				{ key: 'button', kind: 'select', options: GAMEPAD_BUTTONS },
				{ key: 'edge', kind: 'select', options: ['down', 'up', 'held'] },
				{ key: 'action', kind: 'text', placeholder: 'action name for players (e.g. Jump)', maxLength: 40 }
			],
			// 21-E5: a pad button is an EVENT (the keypress channel), a stick is a NUMBER. Both
			// therefore reach every existing consumer with no coercion of their own.
			sockets: { out: 'event' },
			// 21-E5: ONE card for the pad group (the HudNode precedent)
			card: 'GamepadNode',
			eval(node, { ctx, time, d }, rt) {
				// 21-E5: the KEYPRESS MODEL VERBATIM, and that is the whole design. A pad press is
				// local hardware, so it publishes a replicated trigger STAMP and every peer reads the
				// same pulse window off the shared clock — no new message type, no streamed level.
				// 'down' pulses on press (the re-stamp below keeps it high while held), 'up' pulses on
				// release, 'held' is the same window SAID as a level.
				const trig = ctx && ctx.triggers ? ctx.triggers[node.id] : null;
				const dt = trig ? time - trig.lastT : Infinity;
				return dt >= 0 && dt < rt.num(d.pulse ?? 0.3) ? 1 : 0;
			}
		},
		// a stick is LOCAL: every peer reads its OWN pad, so this node evaluates to a
		// different number on each of them BY DESIGN (never streamed — golden rule 8).
		// `deadzone` here is the GAME's threshold on top of the device's dead centre in
		// Settings ▸ Input, hence the 0 default: one deadzone unless you ask for two.
		{
			type: 'gamepadaxis',
			label: 'Gamepad Axis',
			defaults: { axis: 'lx', deadzone: 0, invert: false, scale: 1 },
			params: [
				{ key: 'axis', kind: 'select', options: GAMEPAD_AXES },
				{ key: 'deadzone', kind: 'range', min: 0, max: 0.9, step: 0.05 },
				{ key: 'scale', kind: 'range', min: -4, max: 4, step: 0.1 },
				{ key: 'invert', kind: 'toggle' }
			],
			sockets: { out: 'number' },
			card: 'GamepadNode',
			eval(node, { d }, rt) {
				// 21-E5: LOCAL, and NEVER streamed. My stick is not your stick — the value comes from
				// hardware only this peer has, so each peer evaluates its OWN pad and a graph that
				// reads this node computes a DIFFERENT number per peer BY DESIGN (the hudinput /
				// velocity rule; golden rule 8 — never stream local state). A game that needs a
				// SHARED axis routes it through the E6 controller/possess authority, which is an
				// authoritative channel by construction. The node card says so out loud, because
				// otherwise this gets filed as a sync bug.
				if (!rt.inputRuntimeRef) return 0;
				const axes = rt.inputRuntimeRef.getGamepadAxes();
				// explicit locals rather than axes[d.axis]: dynamic string-indexing of a typed
				// object is a standing svelte-check baseline trap in this repo
				const which = String(d.axis ?? 'lx');
				const raw = rt.num(
					which === 'ly' ? axes.ly : which === 'rx' ? axes.rx : which === 'ry' ? axes.ry : axes.lx
				);
				// the node's deadzone is the GAME's threshold ON TOP of the device's dead centre
				// (Settings ▸ Input, already applied in the snapshot) — which is why it defaults to
				// 0, so by default exactly one deadzone is in play. A hard gate, not a rescale: a
				// game asking for "past half" means past half.
				const dz = Math.min(0.95, Math.max(0, rt.num(d.deadzone ?? 0)));
				const gated = Math.abs(raw) <= dz ? 0 : raw;
				const scaled = gated * rt.num(d.scale ?? 1);
				return d.invert ? -scaled : scaled;
			}
		}
	]
};
