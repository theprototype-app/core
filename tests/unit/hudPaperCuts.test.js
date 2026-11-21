// @ts-nocheck — plain fixtures
// 102b-hud (row 14): the HUD and logic paper cuts — Set Variable's toggle and text ops through the
// authority's apply and the wire check, Get Variable's text output, the button's sound list and
// value field, the HUD Button node's value handle, the Show / Hide Element node's declaration, and
// the module api additions (game.setState, physics.placeBody).
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { gameState, applyGameVarOp, gameVar } from '../../src/lib/gameState.js';
import { validateWireMessage } from '../../src/lib/wireValidate.js';
import { GAME_SOUNDS } from '../../src/lib/gameSfx.js';
import { BUTTON_SOUNDS, kindDef as hudKindDef } from '../../src/lib/hudKinds.js';
import game from '../../src/lib/nodes/families/game.js';
import hud from '../../src/lib/nodes/families/hud.js';
import { sdkGame } from '../../src/lib/sdk/game.js';
import { sdkPhysics } from '../../src/lib/sdk/physics.js';

const def = (fam, type) => fam.nodes.find((n) => n.type === type);
beforeEach(() => gameState.update((s) => ({ ...s, vars: {}, varOps: [] })));

describe('Set Variable: flags and text', () => {
	it('toggle flips a flag once per event', () => {
		expect(applyGameVarOp({ rid: 'var:t:1', name: 'door', op: 'toggle', value: 0 })).toBe(true);
		expect(applyGameVarOp({ rid: 'var:t:1', name: 'door', op: 'toggle', value: 0 })).toBe(false);
		expect(gameVar('door')).toBe(1);
		applyGameVarOp({ rid: 'var:t:2', name: 'door', op: 'toggle', value: 0 });
		expect(gameVar('door')).toBe(0);
	});
	it('text holds words, capped', () => {
		applyGameVarOp({ rid: 'var:x:1', name: 'code', op: 'text', value: 'RED-7' });
		expect(get(gameState).vars.code).toBe('RED-7');
		applyGameVarOp({ rid: 'var:x:2', name: 'code', op: 'text', value: 'y'.repeat(300) });
		expect(get(gameState).vars.code.length).toBe(200);
	});
	it('the wire takes the new ops, text only as a string', () => {
		const ok = (d) => validateWireMessage({ type: 'gamevarop', ...d });
		expect(ok({ rid: 'r', name: 'n', op: 'toggle', value: 0 })).toBe(true);
		expect(ok({ rid: 'r', name: 'n', op: 'text', value: 'hi' })).toBe(true);
		expect(ok({ rid: 'r', name: 'n', op: 'text', value: 3 })).toBe(false);
		expect(ok({ rid: 'r', name: 'n', op: 'text', value: 'z'.repeat(201) })).toBe(false);
		expect(ok({ rid: 'r', name: 'n', op: 'set', value: 'hi' })).toBe(false);
		expect(ok({ rid: 'r', name: 'n', op: 'drop', value: 1 })).toBe(false);
	});
	it('the node offers the ops; its value socket takes text', () => {
		const sv = def(game, 'setvariable');
		expect(sv.params.find((p) => p.key === 'op').options).toEqual(['set', 'add', 'subtract', 'toggle', 'text']);
		expect(sv.sockets.in.value).toBe('any');
		expect(sv.defaults).toEqual({ name: 'score', value: 0, op: 'set', scope: 'shared' }); // saved scenes unchanged
	});
	it('Get Variable reads text with output: text, a number otherwise', () => {
		const gv = def(game, 'getvariable');
		const rt = { viewGameVar: () => 'RED-7', num: (v) => (Number.isFinite(Number(v)) ? Number(v) : 0) };
		expect(gv.eval({}, { d: { name: 'code', output: 'text' } }, rt)).toBe('RED-7');
		expect(gv.eval({}, { d: { name: 'code' } }, rt)).toBe(0);
	});
});

describe('HUD buttons: a click sound and a value', () => {
	it('every offered sound is a real game sound; the default is silent', () => {
		for (const s of BUTTON_SOUNDS) if (s !== 'none') expect(GAME_SOUNDS).toContain(s);
		const button = hudKindDef('button');
		expect(button.fields.map((f) => f.key)).toEqual(expect.arrayContaining(['sound', 'value']));
		expect(button.defaults.sound).toBeUndefined(); // a saved button stays silent
	});
	it('HUD Button gives its pulse and the value', () => {
		const hb = def(hud, 'hudbutton');
		expect(hb.sockets.outHandles).toEqual({ value: 'any' });
		const out = hb.eval({ id: 'b' }, { ctx: { triggers: { b: { lastT: 10 } } }, time: 10.1, d: {} }, { num: Number, hudButtonValue: () => '3' });
		expect(out).toEqual({ __default: 1, __handles: { value: '3' } });
	});
	it('Show / Hide Element: a trigger or a wired visible, hide by default', () => {
		const hv = def(hud, 'hudvisible');
		expect(hv.sockets.in).toEqual({ trigger: 'event', visible: 'number' });
		expect(hv.defaults.action).toBe('hide');
	});
});

describe('module api (DEVX #19, #39)', () => {
	const ctx = { moduleId: 'm', moduleName: 'M', onDispose: () => () => {}, owned: (_k, off) => off };
	it('game.setState moves the shell, refuses an unknown state, is idempotent', () => {
		const api = sdkGame(ctx).game;
		expect(api.setState('bogus')).toBe(false);
		expect(api.setState('playing')).toBe(true);
		const round = get(gameState).round;
		expect(api.setState('playing')).toBe(true);
		expect(get(gameState).round).toBe(round);
		expect(api.setState('over', 'won')).toBe(true);
		expect(get(gameState)).toMatchObject({ state: 'over', outcome: 'won' });
		api.setState('menu');
	});
	it('physics.placeBody needs a running simulation here', () => {
		expect(sdkPhysics(ctx).physics.placeBody('u', [0, 1, 0])).toBe(false);
	});
});
