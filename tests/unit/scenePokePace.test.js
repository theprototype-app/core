// @ts-nocheck
// fix-late-joiners row 1: while an ingest batch is open, scene pokes are paced by what a flush costs (3x, 16..1000 ms),
// so a big scene's object list does not eat the drain. Counterfactual: on v1.74.0 the batch cadence is a flat 16 ms.
import { describe, it, expect } from 'vitest';

const S = await import('../../src/stores/sceneStore.js');

const busy = (ms) => {
	const end = performance.now() + ms;
	while (performance.now() < end);
};
const settle = () => new Promise((r) => setTimeout(r, 0));
S.objectsGroup.set({ children: [] }); // an object, so every poke notifies (the app's objectsGroup is a THREE.Group)

describe('batch poke pacing', () => {
	it('a cheap flush keeps the frame cadence', async () => {
		S.flushScenePokes();
		S.pokeScene();
		await settle();
		expect(S.batchPokeInterval()).toBe(16);
	});

	it('a flush that costs 20 ms spaces the next batch flush ~60 ms out, and the cap holds', async () => {
		let heavy = 20;
		const off = S.objectsGroup.subscribe(() => busy(heavy));
		S.beginSceneBatch();
		S.pokeScene();
		await new Promise((r) => setTimeout(r, 40)); // the batch timer flushes
		expect(S.batchPokeInterval()).toBeGreaterThanOrEqual(55);
		expect(S.batchPokeInterval()).toBeLessThan(200);
		heavy = 400;
		S.flushScenePokes();
		S.pokeScene();
		S.flushScenePokes();
		await settle();
		expect(S.batchPokeInterval()).toBe(1000);
		S.endSceneBatch();
		off();
		heavy = 0;
		S.pokeScene();
		await settle();
		expect(S.batchPokeInterval()).toBe(16);
	});
});
