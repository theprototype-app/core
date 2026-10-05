// @ts-nocheck — test glue (plain arrays of recorded calls)
// 36 (U10, 36-games-graphs) — a behaviour WIRED INTO its graph: declared inputs (event sockets
// that run handlers), outputs (state values + emitted events), engine pieces a module lends the
// rules (`kit.<piece>.*`), and the socket reader the card and the connection check share.
import { describe, it, expect } from 'vitest';
import { problems, inputsOf, outputsOf } from '../../src/lib/behaviours/define.js';
import { analyze } from '../../src/lib/behaviours/analyze.js';
import { createBehaviourRuntime } from '../../src/lib/behaviours/core.js';
import { compileBehaviour, dataUrlImporter } from '../../src/lib/behaviours/source.js';
import { provideEngine, engineSpecs, engineFaces, enginesKey, reserveEngineNames, enginesDebug } from '../../src/lib/behaviours/engines.js';
import { behaviourSockets } from '../../src/lib/behaviours/sockets.js';
import { registerBehaviourSockets, behaviourSocketType, isValidFlowConnection } from '../../src/lib/flowSockets.js';
import { createBehaviourSim } from './sim/behaviourSim.js';

const RULES = `export default behaviour({
	name: 'Rules',
	params: { maxStrokes: 8 },
	state: { strokes: 0, title: '', done: false, card: [] },
	inputs: ['play', 'menu'],
	outputs: ['strokes', 'title', 'done', 'holeSunk'],
	on: {
		play() { this.state.strokes = 0; this.state.title = 'Hole 1'; this.emit('holeSunk'); },
		menu() { this.state.title = ''; },
		'golf.stopped'({ pos }) { this.state.strokes += 1; if (this.state.strokes >= this.params.maxStrokes) this.state.done = true; }
	},
	nudge() { kit.golf.hit([1, 0, 0]); this.emit('stray'); }
});`;

describe('behaviour format — inputs / outputs', () => {
	it('accepts name lists, refuses junk and an input with no handler', () => {
		const ok = { inputs: ['go'], outputs: ['score', 'won'], on: { go() {} } };
		expect(problems(ok)).toEqual([]);
		expect(inputsOf(ok)).toEqual(['go']);
		expect(outputsOf(ok)).toEqual(['score', 'won']);
		expect(problems({ inputs: 'start', on: {} }).join()).toMatch(/inputs must be a list/);
		expect(problems({ outputs: ['a b'] }).join()).toMatch(/is not a name/);
		expect(problems({ outputs: ['a', 'a'] }).join()).toMatch(/twice/);
		expect(problems({ inputs: ['go'], on: {} }).join()).toMatch(/input "go" has no on.go handler/);
	});
});

describe('analyze — the sockets a behaviour declares', () => {
	const specs = [{ piece: 'golf', group: 'Golf', calls: [{ name: 'hit', kind: 'action', label: 'Hit the ball' }, { name: 'stopped', kind: 'event', label: 'On ball stopped' }] }];
	const m = analyze(RULES, specs);
	it('reads inputs and types each output (state value by its literal, else an event)', () => {
		expect(m.ok).toBe(true);
		expect(m.inputs).toEqual(['play', 'menu']);
		expect(m.outputs).toEqual([
			{ name: 'strokes', kind: 'value', type: 'number' },
			{ name: 'title', kind: 'value', type: 'any' },
			{ name: 'done', kind: 'value', type: 'boolean' },
			{ name: 'holeSunk', kind: 'event', type: 'event' }
		]);
	});
	it('a declared input resolves as a wired event (no "no such event" warning); emits are traced', () => {
		const play = m.handlers.find((/** @type {any} */ h) => h.name === 'play');
		expect(play.event.key).toBe('input.play');
		expect(play.emits).toEqual(['holeSunk']);
		expect(m.lint.some((/** @type {any} */ f) => /on\.play/.test(f.message))).toBe(false);
		// a built-in event name cannot be an input (on.start runs once at start)
		expect(analyze(`export default behaviour({ inputs: ['start'], on: { start() {} } });`).ok).toBe(false);
		expect(problems({ inputs: ['start'], on: { start() {} } }).join()).toMatch(/built-in event/);
	});
	it('an engine call is typed by its spec, and an undeclared emit is a warning', () => {
		const nudge = m.methods.find((/** @type {any} */ x) => x.name === 'nudge');
		expect(nudge.kit[0]).toMatchObject({ piece: 'golf', call: 'hit', label: 'Hit the ball', kind: 'action' });
		expect(m.lint.some((/** @type {any} */ f) => /emit\('stray'\)/.test(f.message))).toBe(true);
		expect(m.handlers.find((/** @type {any} */ h) => h.name === 'golf.stopped').event.key).toBe('golf.stopped');
	});
	it('behaviourSockets() is the card + connection view of it, memoized per text', () => {
		const s = behaviourSockets(RULES);
		expect(s.inputs.map((x) => x.name)).toEqual(['play', 'menu']);
		expect(s.outputs.find((x) => x.name === 'holeSunk')).toMatchObject({ type: 'event', kind: 'event' });
		expect(behaviourSockets(RULES)).toBe(s);
	});
});

describe('flowSockets — a behaviour node is typed through the registered reader', () => {
	it('types its handles, lets an untyped value feed a number input, refuses junk', () => {
		const node = { id: 'b', type: 'behaviour', data: { code: RULES } };
		expect(behaviourSocketType(node, 'strokes', 'output')).toBe(null); // nothing registered yet
		registerBehaviourSockets((n) => behaviourSockets(String(n?.data?.code ?? '')));
		expect(behaviourSocketType(node, 'strokes', 'output')).toBe('number');
		expect(behaviourSocketType(node, 'play', 'input')).toBe('event');
		const nodes = [node, { id: 'btn', type: 'hudbutton', data: {} }, { id: 'm', type: 'math', data: {} }, { id: 'sel', type: 'objectselector', data: {} }];
		expect(isValidFlowConnection({ source: 'btn', target: 'b', targetHandle: 'play' }, nodes)).toBe(true);
		expect(isValidFlowConnection({ source: 'b', sourceHandle: 'strokes', target: 'm', targetHandle: 'a' }, nodes)).toBe(true);
		expect(isValidFlowConnection({ source: 'b', sourceHandle: 'title', target: 'm', targetHandle: 'a' }, nodes)).toBe(true);
		expect(isValidFlowConnection({ source: 'b', sourceHandle: 'title', target: 'sel' }, nodes)).toBe(false);
	});
});

describe('engine pieces — a module lends the rules its helpers', () => {
	it('provide / faces / emit / dispose; a kit piece name is refused; the key moves', () => {
		reserveEngineNames(['round', 'score']);
		expect(() => provideEngine({ piece: 'round', group: 'x', calls: [{ name: 'a', kind: 'action', label: 'A' }] }, { a() {} })).toThrow(/kit piece/);
		expect(() => provideEngine({ piece: 'zz', group: 'x', calls: [{ name: 'a', kind: 'action', label: 'A' }] }, {})).toThrow(/no function/);
		const k0 = enginesKey();
		const hits = [];
		const golf = provideEngine({ piece: 'golf', group: 'Golf', calls: [
			{ name: 'hit', kind: 'action', label: 'Hit' }, { name: 'speed', kind: 'value', label: 'Speed', vtype: 'number' }, { name: 'stopped', kind: 'event', label: 'Stopped' }
		] }, { hit: (/** @type {any} */ v) => hits.push(v), speed: () => 2.5 }, 'minigolf');
		expect(enginesKey()).not.toBe(k0);
		expect(engineSpecs().map((s) => s.piece)).toContain('golf');
		const offs = [];
		const face = engineFaces({ onDispose: (fn) => offs.push(fn) }).golf;
		face.hit([1, 2, 3]);
		expect(hits).toEqual([[1, 2, 3]]);
		expect(face.speed()).toBe(2.5);
		const heard = [];
		expect(golf.listening('stopped')).toBe(0);
		face.onStopped((/** @type {any} */ p) => heard.push(p));
		expect(golf.listening('stopped')).toBe(1);
		expect(offs.length).toBe(1); // the listener is journaled (T2)
		expect(golf.emit('stopped', { pos: [0, 0, 0] })).toBe(1);
		expect(heard).toEqual([{ pos: [0, 0, 0] }]);
		offs[0]();
		expect(golf.emit('stopped', {})).toBe(0);
		golf.dispose();
		expect(enginesDebug().some((p) => p.piece === 'golf')).toBe(false);
		expect(golf.emit('stopped', {})).toBe(0);
	});

	it('a behaviour runtime calls the engine and hears its event — on the authority only', async () => {
		const sent = [];
		let authority = true;
		const golf = provideEngine({ piece: 'golf', group: 'Golf', calls: [{ name: 'hit', kind: 'action', label: 'Hit' }, { name: 'stopped', kind: 'event', label: 'Stopped' }] }, { hit() {} }, 'm');
		const emits = [];
		const rt = createBehaviourRuntime({
			me: () => 'a',
			now: () => 1000,
			isAuthority: () => authority,
			send: (m) => sent.push(m),
			specs: () => engineSpecs(),
			emit: (id, name) => emits.push(id + '#' + name)
		});
		const { def, scope } = await compileBehaviour(RULES, dataUrlImporter);
		const inst = rt.start('rules', def, { kit: engineFaces({}) });
		scope.bind(inst.ctx.kit);
		expect(inst.problems).toEqual([]);
		// the engine event runs the handler and its state replicates
		golf.emit('stopped', { pos: [0, 0, 0] });
		expect(rt.stateOf('rules').strokes).toBe(1);
		expect(sent.length).toBeGreaterThan(0);
		// a wired input runs its handler and the handler's emit reaches the host
		expect(rt.input('rules', 'play')).toBe(true);
		expect(rt.stateOf('rules')).toMatchObject({ strokes: 0, title: 'Hole 1' });
		expect(emits).toEqual(['rules#holeSunk']);
		expect(rt.input('rules', 'nope')).toBe(false);
		// a non-authority: the event and the input are both refused, nothing emitted
		authority = false;
		golf.emit('stopped', {});
		rt.input('rules', 'play');
		expect(rt.stateOf('rules').strokes).toBe(0);
		expect(emits.length).toBe(1);
		golf.dispose();
		rt.stop('rules');
		scope.dispose();
	});
});

describe('on.load — every peer, read-only', () => {
	it('runs once per peer at load (and after a source edit); a state write there is put back', async () => {
		const SRC = `export default behaviour({
			state: { n: 0 },
			on: { load() { this.state.n = 99; kit.round.phase(); } }
		});`;
		const sim = createBehaviourSim({ peers: ['a', 'b'] });
		await sim.load('l', SRC);
		sim.advance(2500);
		sim.settle();
		expect(sim.peer('a').bhv.live('l').fired['on.load'].n).toBe(1);
		expect(sim.peer('b').bhv.live('l').fired['on.load'].n).toBe(1);
		expect(sim.states('l')).toEqual([JSON.stringify({ n: 0 }), JSON.stringify({ n: 0 })]);
		expect(analyze(SRC).handlers[0].event).toMatchObject({ name: 'load', local: true });
	});
});

describe('logic sim — a wired input offered on every peer runs ONCE, state reaches all', () => {
	it('three peers each see the press; the authority acts; every peer reads the outputs', async () => {
		const SRC = `export default behaviour({
			state: { presses: 0, label: 'menu' },
			inputs: ['startPressed'],
			outputs: ['presses', 'label', 'started'],
			on: { startPressed() { this.state.presses += 1; this.state.label = 'playing'; this.emit('started'); } }
		});`;
		const sim = createBehaviourSim({ peers: ['a', 'b', 'c'] });
		await sim.load('r', SRC);
		sim.advance(2500); // past the joiner grace: the authority may act
		sim.settle();
		// flowRuntime offers the stamp on EVERY peer (each sees the replicated press once)
		for (const id of ['a', 'b', 'c']) sim.peer(id).bhv.input('r', 'startPressed');
		sim.settle();
		expect(sim.states('r')).toEqual(Array(3).fill(JSON.stringify({ presses: 1, label: 'playing' })));
		const emits = ['a', 'b', 'c'].map((id) => (sim.peer(id).emits ?? []).length);
		expect(emits).toEqual([1, 0, 0]); // only the authority fires the output pulse (it replicates)
	});
});

describe('logic sim — a press that lands while the authority is moving', () => {
	it('is held by the peer that becomes the authority, runs once, and never twice', async () => {
		const SRC = `export default behaviour({
			state: { presses: 0 },
			inputs: ['go'],
			on: { go() { this.state.presses += 1; } }
		});`;
		const sim = createBehaviourSim({ peers: ['a', 'b'] });
		await sim.load('r', SRC);
		sim.advance(2500);
		sim.settle();
		// the press reaches b first; b is not the authority (a is) — held, not lost
		sim.initiator = 'b'; // …and the authority moves to b (Play started b's simulation)
		const stamp = 1234.5;
		sim.peer('b').bhv.input('r', 'go', {}, stamp);
		sim.advance(200);
		sim.settle();
		expect(JSON.parse(sim.states('r')[1]).presses).toBe(1);
		// a sees the same stamp later (it is not the authority now): nothing more happens
		sim.peer('a').bhv.input('r', 'go', {}, stamp);
		sim.initiator = 'a'; // the authority moves back to a, which saw the document
		sim.advance(200);
		sim.settle();
		expect(sim.states('r')).toEqual([JSON.stringify({ presses: 1 }), JSON.stringify({ presses: 1 })]);
		// a NEW press runs again
		sim.peer('a').bhv.input('r', 'go', {}, stamp + 1);
		sim.settle();
		expect(JSON.parse(sim.states('r')[0]).presses).toBe(2);
	});
});

