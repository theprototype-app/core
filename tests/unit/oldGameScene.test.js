// @ts-nocheck — partial fixtures (payload rows with only the fields under test)
// 36 (U10, 36-int-123): a core game saved before its rules moved onto the Main graph.
import { describe, test, expect } from 'vitest';
import { oldRulesGame, RULES_GAMES, RETIRED_GAME_NODES } from '../../src/lib/oldGameScene.js';

const marker = (name) => ({ object: { name: 'Root', children: [{ name: 'Course', children: [{ name }] }] } });
const rulesNode = (code) => ({ id: 'r', type: 'behaviour', data: { name: 'Rules', code } });

describe('oldRulesGame', () => {
	test('a 1.22 Mini Golf (marker, golfinfo HUD wiring, no rules node) is an old copy', () => {
		const payload = {
			objects: [marker('Mini golf game')],
			graphs: { scene: { nodes: [{ id: 'g', type: 'golfinfo', data: {} }, { id: 'h', type: 'hudtext', data: {} }], edges: [] } }
		};
		expect(oldRulesGame(payload)?.name).toBe('Mini Golf');
		expect(RETIRED_GAME_NODES.has('golfinfo')).toBe(true);
	});

	test('the 1.23 scene (a rules node that calls the engine piece) is not', () => {
		for (const g of RULES_GAMES) {
			const payload = {
				objects: [marker(g.marker)],
				graphs: { scene: { nodes: [rulesNode('on: { start() { kit.' + g.piece + '.reset(); } }')], edges: [] } }
			};
			expect(oldRulesGame(payload)).toBeNull();
		}
	});

	test('counterfactual: a behaviour that does NOT call this game\'s piece leaves the copy old', () => {
		const payload = {
			objects: [marker('Sky Run game')],
			graphs: { 'obj-1': { nodes: [rulesNode('kit.golf.hit([0,0,1])')], edges: [] } }
		};
		expect(oldRulesGame(payload)?.piece).toBe('skyrun');
	});

	test('a scene with no game marker is never flagged, whatever its graphs hold', () => {
		expect(oldRulesGame({ objects: [marker('Box')], graphs: { scene: { nodes: [{ type: 'golfinfo' }] } } })).toBeNull();
		expect(oldRulesGame({})).toBeNull();
		expect(oldRulesGame(null)).toBeNull();
	});
});
