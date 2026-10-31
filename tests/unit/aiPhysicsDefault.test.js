import { describe, it, expect } from 'vitest';
import { aiCreatePhysics } from '../../src/lib/ai/aiPhysicsDefault.js';

// fix-live F-4 (test flight T8): AI-made objects stay put in Play unless asked for physics
describe('F-4 AI create physics default', () => {
	const stamped = { mode: 'dynamic', mass: 1 }; // what the Add-menu builder gives a Box
	it('turns the builder\'s dynamic default to static when nothing was asked', () => {
		expect(aiCreatePhysics({ kind: 'primitive', primitive: 'Box' }, stamped)).toEqual({ mode: 'static' });
		expect(aiCreatePhysics({ physics: 'static' }, stamped)).toEqual({ mode: 'static' });
	});
	it('leaves objects the builder did not make dynamic alone (lights, groups, terrain)', () => {
		expect(aiCreatePhysics({ kind: 'light' }, undefined)).toBeNull();
		expect(aiCreatePhysics({}, { mode: 'auto' })).toBeNull();
	});
	it('keeps dynamic when asked, with the asked mass', () => {
		expect(aiCreatePhysics({ physics: 'dynamic' }, stamped)).toBeNull(); // already dynamic, mass 1
		expect(aiCreatePhysics({ physics: 'dynamic', mass: 4 }, stamped)).toEqual({ mode: 'dynamic', mass: 4 });
		expect(aiCreatePhysics({ mass: 2.5 }, stamped)).toEqual({ mode: 'dynamic', mass: 2.5 });
		expect(aiCreatePhysics({ physics: 'dynamic' }, undefined)).toEqual({ mode: 'dynamic', mass: 1 });
	});
	it('ignores a junk mass and caps a huge one', () => {
		expect(aiCreatePhysics({ mass: -1 }, stamped)).toEqual({ mode: 'static' });
		expect(aiCreatePhysics({ mass: 'heavy' }, stamped)).toEqual({ mode: 'static' });
		expect(aiCreatePhysics({ mass: 1e9 }, stamped)).toEqual({ mode: 'dynamic', mass: 10000 });
	});
});
