// @ts-nocheck — test glue
// 92-correct row 3: per-player behaviour state. playerJoined / playerLeft run on the authority once
// per player (remembered in the replicated document, so a new authority does not re-announce), and a
// Game Value `for: me` shows each player their own entry of a map keyed by peer id.
import { describe, it, expect } from 'vitest';
import { createBehaviourRuntime } from '../../src/lib/behaviours/core.js';
import { compileBehaviour, dataUrlImporter } from '../../src/lib/behaviours/source.js';
import { resolveEvent } from '../../src/lib/behaviours/events.js';
import { entryFor } from '../../src/lib/nodes/families/game.js';

const TEAMS = `export default behaviour({
	name: 'Teams',
	state: { team: {}, red: 0, blue: 0, joins: 0 },
	inputs: ['scored'],
	outputs: ['team', 'red', 'blue'],
	on: {
		playerJoined({ by }) {
			this.state.joins += 1;
			if (this.state.team[by]) return;
			const reds = Object.values(this.state.team).filter((t) => t === 'Red').length;
			const blues = Object.values(this.state.team).filter((t) => t === 'Blue').length;
			this.state.team[by] = reds <= blues ? 'Red' : 'Blue';
		},
		playerLeft({ by }) { delete this.state.team[by]; },
		scored({ by }) { if (this.state.team[by] === 'Red') this.state.red += 1; else if (this.state.team[by] === 'Blue') this.state.blue += 1; }
	},
	who() { return this.players(); }
});`;

/** a runtime with a host whose player list and authority the test moves */
function host(players, authority = { v: true }) {
	const sent = [];
	const rt = createBehaviourRuntime({
		me: () => 'a',
		now: () => 1000,
		isAuthority: () => authority.v,
		players: () => players.list,
		send: (m) => sent.push(m),
		specs: () => []
	});
	return { rt, sent };
}

describe('playerJoined / playerLeft', () => {
	it('resolve as built-in events with a `by` payload', () => {
		expect(resolveEvent('playerJoined', [])).toMatchObject({ key: 'playerJoined', local: false, payload: { by: 'string' } });
		expect(resolveEvent('playerLeft', [])).toMatchObject({ key: 'playerLeft' });
	});
	it('announce each player once, keep teams even, and score for the clicker\'s team', async () => {
		const players = { list: ['a'] };
		const { rt, sent } = host(players);
		const { def } = await compileBehaviour(TEAMS, dataUrlImporter);
		const inst = rt.start('t', def, {});
		expect(inst.problems).toEqual([]);
		rt.tick();
		expect(rt.stateOf('t').team).toEqual({ a: 'Red' });
		players.list = ['a', 'b'];
		rt.tick();
		rt.tick();
		expect(rt.stateOf('t').team).toEqual({ a: 'Red', b: 'Blue' });
		expect(rt.stateOf('t').joins).toBe(2);
		expect(inst.ctx.players()).toEqual(['a', 'b']);
		rt.input('t', 'scored', { by: 'b' }, 5);
		rt.input('t', 'scored', { by: 'b' }, 6);
		rt.input('t', 'scored', { by: 'a' }, 7);
		expect(rt.stateOf('t')).toMatchObject({ red: 1, blue: 2 });
		// the document that replicates remembers who was announced
		const last = sent[sent.length - 1];
		expect(Object.keys(last.inputs).filter((k) => k.startsWith('player:')).sort()).toEqual(['player:a', 'player:b']);
		players.list = ['a'];
		rt.tick();
		expect(rt.stateOf('t').team).toEqual({ a: 'Red' });
	});
	it('a new authority carrying the document does not announce the same players again', async () => {
		const players = { list: ['a', 'b'] };
		const first = host(players);
		const { def } = await compileBehaviour(TEAMS, dataUrlImporter);
		first.rt.start('t', def, {});
		first.rt.tick();
		const doc = first.sent[first.sent.length - 1];
		expect(first.rt.stateOf('t').joins).toBe(2);
		const second = host(players);
		second.rt.receive(doc);
		const { def: def2 } = await compileBehaviour(TEAMS, dataUrlImporter);
		second.rt.start('t', def2, {});
		second.rt.tick();
		expect(second.rt.stateOf('t').joins).toBe(2);
		expect(second.rt.stateOf('t').team).toEqual({ a: 'Red', b: 'Blue' });
	});
	it('a non-authority announces nothing', async () => {
		const players = { list: ['a', 'b'] };
		const { rt } = host(players, { v: false });
		const { def } = await compileBehaviour(TEAMS, dataUrlImporter);
		rt.start('t', def, {});
		rt.tick();
		expect(rt.stateOf('t').team).toEqual({});
	});
});

describe('Game Value for: me (entryFor)', () => {
	it('takes this player\'s entry of a map keyed by peer id', () => {
		expect(entryFor({ a: 'Red', b: 'Blue' }, 'b')).toBe('Blue');
		expect(entryFor('{"a":3,"b":5}', 'a')).toBe(3);
		expect(entryFor({ a: 'Red' }, 'c')).toBe('');
	});
	it('anything that is not a map is shown as it is', () => {
		expect(entryFor(7, 'a')).toBe(7);
		expect(entryFor('Red', 'a')).toBe('Red');
		expect(entryFor([1, 2], 'a')).toEqual([1, 2]);
		expect(entryFor('{not json', 'a')).toBe('{not json');
	});
});
