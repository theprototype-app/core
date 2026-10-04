// 36 A5 — a fog the user set by hand keeps its reach; a preset's grows with the scene.
import { describe, it, expect } from 'vitest';
import { fogFarFor, mergeFogPatch, FOG_REACH_FACTOR } from '../../src/lib/fogReach.js';

describe('fogFarFor', () => {
	it("a PRESET's fog grows to the scene's reach", () => {
		expect(fogFarFor({ far: 50 }, 100)).toBe(100 * FOG_REACH_FACTOR);
		expect(fogFarFor({ far: 300 }, 10)).toBe(300);
	});
	it('an AUTHORED fog (fit:false) keeps exactly the far it was given', () => {
		// the report: Far set to 20 on a scene of radius 40 drew at 100
		expect(fogFarFor({ far: 20, fit: false }, 40)).toBe(20);
	});
	it('nonsense far draws nothing rather than NaN', () => {
		expect(fogFarFor(/** @type {any} */ ({}), 10)).toBe(0);
	});
});

describe('mergeFogPatch', () => {
	const preset = { color: '#a9c8e4', near: 60, far: 220 };
	it('naming near or far makes the fog authored, keeping the rest of it', () => {
		expect(mergeFogPatch(preset, { near: 2 })).toEqual({ color: '#a9c8e4', near: 2, far: 220, fit: false });
		expect(mergeFogPatch(preset, { far: 20 })).toEqual({ color: '#a9c8e4', near: 60, far: 20, fit: false });
	});
	it('a colour-only patch leaves the fog fitting as it did', () => {
		expect(mergeFogPatch(preset, { color: '#000000' })).toEqual({ ...preset, color: '#000000' });
		expect(mergeFogPatch({ ...preset, fit: false }, { color: '#000000' }).fit).toBe(false);
	});
	it('null removes it; a patch on no fog starts from a sensible base', () => {
		expect(mergeFogPatch(preset, null)).toBe(null);
		expect(mergeFogPatch(null, { far: 30 })).toEqual({ color: '#ffffff', near: 1, far: 30, fit: false });
	});
	it('the round trip the Inspector makes: edit near, then the next applyEnvironment keeps far', () => {
		const edited = mergeFogPatch(preset, { far: 20 });
		// counterfactual: the pre-36 rule (always grow) would have drawn this fog at 2.5 x radius
		expect(Math.max(edited.far, 40 * FOG_REACH_FACTOR)).toBe(100);
		expect(fogFarFor(edited, 40)).toBe(20);
	});
});
