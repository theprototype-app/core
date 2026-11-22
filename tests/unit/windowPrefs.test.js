// showhide-v8 §6: the Windows ▸ switches' pure halves — Snap to edges' arithmetic and the per-scene layout map.
import { describe, it, expect } from 'vitest';
import { snapRectToEdges, upsertSceneLayout, sceneLayoutOf, MAX_SCENE_LAYOUTS, SNAP_DISTANCE } from '../../src/lib/windowPrefs.js';
import { isLayoutKey } from '../../src/lib/uiLayoutsCore.js';

describe('snapRectToEdges', () => {
	it('pulls a window within the distance flush to the left/top and the right/bottom edges', () => {
		expect(snapRectToEdges(10, 12, 300, 200, 1280, 800)).toEqual({ left: 0, top: 0 });
		expect(snapRectToEdges(1280 - 300 - 9, 800 - 200 - 14, 300, 200, 1280, 800)).toEqual({ left: 980, top: 600 });
	});
	it('leaves a window further than the distance where it is (the counterfactual)', () => {
		const d = SNAP_DISTANCE + 1;
		expect(snapRectToEdges(d, d, 300, 200, 1280, 800)).toEqual({ left: d, top: d });
		expect(snapRectToEdges(1280 - 300 - d, 400, 300, 200, 1280, 800)).toEqual({ left: 1280 - 300 - d, top: 400 });
	});
	it('a window as wide as the screen keeps its left edge (its header) on screen', () => {
		expect(snapRectToEdges(5, 300, 1278, 200, 1280, 800).left).toBe(0);
	});
	it('also catches a window a little past an edge', () => {
		expect(snapRectToEdges(-8, -6, 300, 200, 1280, 800)).toEqual({ left: 0, top: 0 });
	});
});

describe('per-scene layouts', () => {
	it('the newest save of a scene replaces its old one and comes first', () => {
		let list = upsertSceneLayout([], 'Forest', { n: 1 });
		list = upsertSceneLayout(list, 'Castle', { n: 2 });
		list = upsertSceneLayout(list, 'Forest', { n: 3 });
		expect(list.map((r) => r.scene)).toEqual(['Forest', 'Castle']);
		expect(sceneLayoutOf(list, 'Forest')).toEqual({ n: 3 });
		expect(sceneLayoutOf(list, 'Nowhere')).toBeNull();
	});
	it('keeps only the most recent scenes', () => {
		let list = /** @type {{scene: string, layout: any}[]} */ ([]);
		for (let i = 0; i < MAX_SCENE_LAYOUTS + 3; i++) list = upsertSceneLayout(list, 's' + i, { i });
		expect(list).toHaveLength(MAX_SCENE_LAYOUTS);
		expect(sceneLayoutOf(list, 's0')).toBeNull();
		expect(sceneLayoutOf(list, 's' + (MAX_SCENE_LAYOUTS + 2))).toEqual({ i: MAX_SCENE_LAYOUTS + 2 });
	});
	it('the switches and the map are not part of a saved layout (a layout apply must not flip them)', () => {
		for (const k of ['windows:snapToEdges', 'windows:layoutLocked', 'windows:layoutPerScene', 'windows:sceneLayouts']) expect(isLayoutKey(k)).toBe(false);
		expect(isLayoutKey('win:explorer')).toBe(true);
	});
});
