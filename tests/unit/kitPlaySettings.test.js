// 34 R2 — the kit's rules reach EVERY input path through ONE place: resolvePlaySettings lays
// kit.rules (session-wide) over the scene's play block and its publishers. Desktop Play's reach
// (playInteract), the VR grip (vr/grip.js) and the VR teleport bounds (vr/locomotion.js) all read
// it, so this check is the whole of their wiring.
import { describe, it, expect, beforeEach } from 'vitest';
import { resolvePlaySettings } from '../../src/lib/playSettings.js';
import { kit, kitPlayRules, kitCheckGrab, resetKit } from '../../src/lib/kit/runtime.js';
import { setScenePhysics } from '../../src/lib/scenePhysics.js';

describe('resolvePlaySettings + kit.rules', () => {
	beforeEach(() => resetKit());
	it('with no kit rule the scene play block decides (byte-unchanged behaviour)', () => {
		setScenePhysics({ play: { reach: 1.5 } });
		expect(resolvePlaySettings(null).reach).toBe(1.5);
		expect(kitPlayRules()).toEqual({ reach: null, jump: null, bounds: null });
	});
	it("a kit reach and bounds win over the scene's", () => {
		setScenePhysics({ play: { reach: 1.5, bounds: { min: [-1, 0, -1], max: [1, 2, 1] } } });
		// offline: no peer id, so this app is its own authority and the write applies at once
		kit.impls.rules.setReach(2.2);
		kit.impls.rules.setBounds([-9, 0, -9], [9, 5, 9]);
		const s = resolvePlaySettings(null);
		expect(s.reach).toBe(2.2);
		expect(s.bounds).toEqual({ min: [-9, 0, -9], max: [9, 5, 9] });
		expect(s.boundsOwner).toBe(null);
	});
	it('kitCheckGrab is the rules piece', () => {
		kit.impls.rules.setReach(1);
		expect(kitCheckGrab({ point: [3, 1, 0], eye: [0, 1.7, 0], feetY: 0, silent: true })?.ok).toBe(false);
	});
	it('a scene clear (resetKit) hands the decision back to the scene', () => {
		setScenePhysics({ play: { reach: 1.5 } });
		kit.impls.rules.setReach(3);
		resetKit();
		expect(resolvePlaySettings(null).reach).toBe(1.5);
	});
});
