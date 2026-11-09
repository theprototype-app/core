// 85 N1 / N2 / N4 — Oscillate, the tweens (Move / Rotate / Scale To) and the light nodes, on the
// real functions flowRuntime calls each frame. The peer story is "a pure function of replicated
// stamps + the shared clock", so most of this asserts PURITY (same inputs, same pose) and the
// reversal / parity rules that make two peers agree.
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
	ease,
	EASINGS,
	oscillateAt,
	tweenEvents,
	tweenProgress,
	easedPosition,
	openEvent,
	lightLevel,
	cycleColour,
	parseColours,
	pivotPoint
} from '../../src/lib/motion/tweenCore.js';
import { applyOscillate, applyTween, tweenPosition, pivotLocal, rotateAbout, localBounds } from '../../src/lib/motion/tweenNodes.js';
import { applyLightSwitch, applyLightIntensity, applyLightCycle, pruneLightNodes, resetLightNodes } from '../../src/lib/motion/lightNodes.js';
import { runParkHooks } from '../../src/lib/parkHooks.js';

const close = (/** @type {number} */ a, /** @type {number} */ b, eps = 1e-6) => Math.abs(a - b) < eps;

describe('easing', () => {
	it('every easing starts at 0 and ends at 1; unknown = smooth', () => {
		for (const name of EASINGS) {
			expect(close(ease(name, 0), 0)).toBe(true);
			expect(close(ease(name, 1), 1)).toBe(true);
		}
		expect(ease('nonsense', 0.3)).toBe(ease('smooth', 0.3));
		expect(ease('linear', 0.25)).toBe(0.25);
		// back overshoots, smooth never does
		const peak = Math.max(...Array.from({ length: 101 }, (_, i) => ease('back', i / 100)));
		expect(peak).toBeGreaterThan(1.05);
		expect(Math.max(...Array.from({ length: 101 }, (_, i) => ease('smooth', i / 100)))).toBeLessThanOrEqual(1);
	});
});

describe('oscillateAt (N1)', () => {
	it('free-running sine: a pure function of the clock, one period apart = same value', () => {
		const d = { amplitude: 30, period: 2 };
		expect(close(oscillateAt(d, 0.5, null), 30)).toBe(true);
		expect(close(oscillateAt(d, 1000.5, null), oscillateAt(d, 0.5, null), 1e-6)).toBe(true);
		// huge session clock stays precise
		expect(close(oscillateAt(d, 86398.5, null), 30, 1e-3)).toBe(true);
	});
	it('a wired trigger with no stamp yet rests; after the stamp it swings and damps to exactly 0', () => {
		const d = { amplitude: 40, period: 1, damping: 2 };
		expect(oscillateAt(d, 50, null, true)).toBe(0);
		expect(Math.abs(oscillateAt(d, 100.25, 100, true))).toBeGreaterThan(20);
		expect(Math.abs(oscillateAt(d, 103.25, 100, true))).toBeLessThan(0.2);
		expect(oscillateAt(d, 110.25, 100, true)).toBe(0);
		expect(oscillateAt(d, 99, 100, true)).toBe(0); // before the stamp
	});
	it('bob never goes below rest; triangle peaks at the amplitude', () => {
		for (let t = 0; t < 2; t += 0.05) expect(oscillateAt({ amplitude: 1, period: 1, wave: 'bob' }, t, null)).toBeGreaterThanOrEqual(0);
		expect(close(oscillateAt({ amplitude: 2, period: 4, wave: 'triangle' }, 1, null), 2)).toBe(true);
	});
});

describe('tweenProgress (N2)', () => {
	const go = (/** @type {number} */ t) => ({ t, dir: /** @type {1} */ (1) });
	const ret = (/** @type {number} */ t) => ({ t, dir: /** @type {0} */ (0) });
	it('nothing happened = at rest; a trigger goes there in `duration` seconds', () => {
		expect(tweenProgress([], 5, 1).raw).toBe(0);
		expect(tweenProgress([go(10)], 10.5, 1).raw).toBeCloseTo(0.5);
		const done = tweenProgress([go(10)], 12, 1);
		expect(done.raw).toBe(1);
		expect(done.moving).toBe(false);
	});
	it('a reversal half-way turns back from where it was, at the same speed (no jump)', () => {
		// went at 10, sent back at 10.4 (stood at 0.4) -> 0.4 s to get home
		const at = tweenProgress([go(10), ret(10.4)], 10.4, 1);
		expect(at.raw).toBeCloseTo(0.4);
		expect(tweenProgress([go(10), ret(10.4)], 10.6, 1).raw).toBeCloseTo(0.2);
		expect(tweenProgress([go(10), ret(10.4)], 10.8, 1).raw).toBe(0);
	});
	it('eased position is continuous across a reversal', () => {
		const ev = [go(10), ret(10.5)];
		const before = easedPosition(tweenProgress([go(10)], 10.5, 1), 'smooth');
		const after = easedPosition(tweenProgress(ev, 10.5001, 1), 'smooth');
		expect(Math.abs(before - after)).toBeLessThan(0.01);
	});
	it('pingpong runs from the newest go, and runs from the clock when nothing is wired', () => {
		expect(tweenProgress([go(10)], 11.5, 1, 'pingpong').raw).toBeCloseTo(0.5);
		expect(tweenProgress([go(10)], 11.75, 1, 'pingpong').dir).toBe(0);
		expect(tweenProgress([], 3.25, 1, 'loop', true).raw).toBeCloseTo(0.25);
		expect(tweenProgress([], 3.25, 1, 'loop', false).raw).toBe(0); // wired but never fired: rest
		// a newer back stops the cycle and returns
		expect(tweenProgress([go(10), ret(20)], 30, 1, 'pingpong').raw).toBe(0);
	});
	it('tweenEvents: toggle parity decides its direction; ties read as "go"', () => {
		expect(tweenEvents({ toggle: 5, toggleCount: 1 })).toEqual([go(5)]);
		expect(tweenEvents({ toggle: 5, toggleCount: 2 })).toEqual([ret(5)]);
		expect(tweenEvents({ trigger: 3, back: 3 }).at(-1)).toEqual(go(3));
	});
	it('openEvent: an already-true boolean stands at the goal; quick flips keep two events', () => {
		let held = openEvent(undefined, true, 100);
		expect(tweenProgress(held.events, 100, 1).raw).toBe(1);
		held = openEvent(held, false, 101);
		held = openEvent(held, true, 101.3);
		expect(held.events.length).toBe(2);
		// went back for 0.3 s from 1 -> 0.7, now heading home again
		expect(tweenProgress(held.events, 101.3, 1).raw).toBeCloseTo(0.7);
		expect(tweenProgress(held.events, 101.5, 1).raw).toBeCloseTo(0.9);
		// no change = the same object (nothing to re-render)
		expect(openEvent(held, true, 200)).toBe(held);
	});
	it('two peers holding the same stamps draw the same position at the same clock (PURITY)', () => {
		const s = { trigger: 50, back: 50.3, toggle: null, toggleCount: 0, openWired: false, anyWired: true, amountWired: false };
		const a = tweenPosition('peerA|x', { duration: 1, easing: 'back' }, 50.45, s);
		const b = tweenPosition('peerB|x', { duration: 1, easing: 'back' }, 50.45, s);
		expect(a.pos).toBe(b.pos);
	});
	it('amount wired drives the position by hand', () => {
		const s = { trigger: null, back: null, toggle: null, toggleCount: 0, openWired: false, anyWired: false, amountWired: true };
		expect(tweenPosition('k', { amount: 0.25 }, 0, s).pos).toBe(0.25);
	});
});

describe('pivots', () => {
	it('pivotPoint picks a face centre of the local bounds; origin = null', () => {
		const box = { min: [-0.5, 0, -0.05], max: [0.5, 2, 0.05] };
		expect(pivotPoint('left', box)).toEqual([-0.5, 1, 0]);
		expect(pivotPoint('top', box)).toEqual([0, 2, 0]);
		expect(pivotPoint('origin', box)).toBe(null);
		expect(pivotPoint('top', null)).toBe(null);
	});
	it('a door rotated 90 degrees about its LEFT edge keeps the hinge where it was', () => {
		const door = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 0.1));
		door.position.set(3, 1, 0);
		const hingeBefore = new THREE.Vector3(-0.5, 0, 0).applyMatrix4((door.updateMatrix(), door.matrix.clone()));
		rotateAbout(door, 'y', Math.PI / 2, pivotLocal(door, 'left'));
		door.updateMatrix();
		const hingeAfter = new THREE.Vector3(-0.5, 0, 0).applyMatrix4(door.matrix);
		expect(hingeAfter.distanceTo(hingeBefore)).toBeLessThan(1e-6);
		// the free edge moved from x 3.5 to the hinge's x, out along z
		const free = new THREE.Vector3(0.5, 0, 0).applyMatrix4(door.matrix);
		expect(free.x).toBeCloseTo(2.5);
		expect(Math.abs(free.z)).toBeCloseTo(1);
	});
	it('a scaled object scales its pivot with it; origin falls back to userData.origin', () => {
		const g = new THREE.Group();
		g.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2)));
		expect(localBounds(g)?.max).toEqual([1, 1, 1]);
		g.userData.origin = [0, -1, 0];
		expect(pivotLocal(g, 'origin')).toEqual([0, -1, 0]);
		expect(pivotLocal(new THREE.Group(), 'top')).toEqual([0, 0, 0]); // no mesh: centre
	});
});

describe('applyTween / applyOscillate (THREE)', () => {
	const baseOf = (/** @type {any} */ o) => ({ pos: o.position.toArray(), rot: [o.rotation.x, o.rotation.y, o.rotation.z], scale: o.scale.toArray() });
	it('Move To: offset, world point and an object goal', () => {
		const root = new THREE.Group();
		const box = new THREE.Mesh(new THREE.BoxGeometry());
		const goal = new THREE.Object3D();
		goal.position.set(10, 0, 0);
		root.add(box, goal);
		box.position.set(1, 0, 0);
		const base = baseOf(box);
		applyTween('moveto', box, base, { x: 0, y: 2, z: 0 }, 0.5, { root });
		expect(box.position.toArray()).toEqual([1, 1, 0]);
		box.position.fromArray(base.pos);
		applyTween('moveto', box, base, { x: 5, y: 0, z: 0, space: 'world' }, 1, { root });
		expect(box.position.x).toBeCloseTo(5);
		box.position.fromArray(base.pos);
		applyTween('moveto', box, base, { to: goal.uuid }, 1, { root });
		expect(box.position.x).toBeCloseTo(10);
	});
	it('Rotate To: angle about a pivot; pos 0 leaves the pose alone', () => {
		const box = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 0.1));
		const base = baseOf(box);
		applyTween('rotateto', box, base, { axis: 'y', angle: 90, pivot: 'origin' }, 0, { root: null });
		expect(box.rotation.y).toBe(0);
		applyTween('rotateto', box, base, { axis: 'y', angle: 90, pivot: 'origin' }, 1, { root: null });
		expect(box.rotation.y).toBeCloseTo(Math.PI / 2);
	});
	it('Scale To with pivot bottom grows from the foot', () => {
		const plant = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
		const base = baseOf(plant);
		applyTween('scaleto', plant, base, { factor: 3, axis: 'all', pivot: 'bottom' }, 1, { root: null });
		expect(plant.scale.y).toBeCloseTo(3);
		// the foot (local y -0.5) stays at world y -0.5
		plant.updateMatrix();
		expect(new THREE.Vector3(0, -0.5, 0).applyMatrix4(plant.matrix).y).toBeCloseTo(-0.5);
	});
	it('Oscillate swings a sign about its top; position bobs along the parent axis', () => {
		const sign = new THREE.Mesh(new THREE.BoxGeometry(1, 0.5, 0.05));
		const v = applyOscillate(sign, { amplitude: 30, period: 2, axis: 'z', pivot: 'top' }, 0.5, { start: null, armed: false });
		expect(v).toBeCloseTo(30);
		expect(sign.rotation.z).toBeCloseTo((30 * Math.PI) / 180);
		sign.updateMatrix();
		// the hook (top centre) did not move
		expect(new THREE.Vector3(0, 0.25, 0).applyMatrix4(sign.matrix).distanceTo(new THREE.Vector3(0, 0.25, 0))).toBeLessThan(1e-6);
		const buoy = new THREE.Object3D();
		applyOscillate(buoy, { property: 'position', axis: 'y', amplitude: 0.5, period: 4, wave: 'bob' }, 2, { start: null, armed: false });
		expect(buoy.position.y).toBeCloseTo(0.5);
	});
});

describe('light nodes (N4)', () => {
	const lamp = () => {
		const g = new THREE.Group();
		const light = new THREE.PointLight(0xffffff, 3);
		const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.1), new THREE.MeshStandardMaterial({ emissive: 0xffeeaa, emissiveIntensity: 2 }));
		g.add(light, bulb);
		return { g, light, bulb };
	};
	const S = { trigger: null, back: null, toggle: null, toggleCount: 0, open: [], onWired: false };
	it('switch: off by back, faded, authored intensity x level, glow included', () => {
		resetLightNodes();
		const { g, light, bulb } = lamp();
		expect(applyLightSwitch(g, { on: true, fade: 1 }, 10, 'n|a', S)).toBe(1);
		expect(light.intensity).toBe(3);
		const s = { ...S, back: 10 };
		applyLightSwitch(g, { on: true, fade: 1 }, 10.5, 'n|a', s);
		expect(light.intensity).toBeGreaterThan(0);
		expect(light.intensity).toBeLessThan(3);
		applyLightSwitch(g, { on: true, fade: 1 }, 12, 'n|a', s);
		expect(light.intensity).toBe(0);
		expect(bulb.material.emissiveIntensity).toBe(0);
		// it never compounds: back on = the AUTHORED 3, not 0 x anything
		applyLightSwitch(g, { on: true, fade: 0 }, 13, 'n|a', { ...S, trigger: 13, back: 10 });
		expect(light.intensity).toBe(3);
		expect(bulb.material.emissiveIntensity).toBe(2);
	});
	it('an Inspector edit while driven becomes the authored value; prune hands it back', () => {
		resetLightNodes();
		const { g, light } = lamp();
		applyLightIntensity(g, { level: 0.5, fade: 0 }, 1, 'n|b');
		expect(light.intensity).toBe(1.5);
		light.intensity = 8; // the user drags the slider
		applyLightIntensity(g, { level: 0.5, fade: 0 }, 2, 'n|b');
		expect(light.intensity).toBe(4);
		pruneLightNodes(new Set());
		expect(light.intensity).toBe(8);
	});
	it('a save (the park) sees the authored values, then the driven ones come back', () => {
		resetLightNodes();
		const { g, light } = lamp();
		applyLightSwitch(g, { on: false, fade: 0 }, 1, 'n|c', S);
		expect(light.intensity).toBe(0);
		const unpark = runParkHooks();
		expect(light.intensity).toBe(3);
		unpark();
		expect(light.intensity).toBe(0);
		resetLightNodes();
		expect(light.intensity).toBe(3);
	});
	it('intensity fades from where it stood when the level changes', () => {
		resetLightNodes();
		const { g, light } = lamp();
		applyLightIntensity(g, { level: 1, fade: 2 }, 0, 'n|d');
		applyLightIntensity(g, { level: 0, fade: 2 }, 1, 'n|d');
		applyLightIntensity(g, { level: 0, fade: 2 }, 2, 'n|d');
		expect(light.intensity).toBeCloseTo(1.5);
		applyLightIntensity(g, { level: 0, fade: 2 }, 3.5, 'n|d');
		expect(light.intensity).toBe(0);
	});
	it('colour cycle: pure of the clock; list mode blends; colours parse', () => {
		resetLightNodes();
		expect(parseColours('#f00, #00ff88 nonsense #123')).toEqual(['#ff0000', '#00ff88', '#112233']);
		expect(cycleColour({ mode: 'list', colors: '#ff0000, #0000ff', period: 2, step: true }, 0.1)).toEqual([1, 0, 0]);
		expect(cycleColour({ mode: 'list', colors: '#ff0000, #0000ff', period: 2, step: true }, 1.1)).toEqual([0, 0, 1]);
		const { g, light } = lamp();
		applyLightCycle(g, { mode: 'rainbow', period: 3 }, 0, 'n|e');
		expect(light.color.getHex()).toBe(0xff0000);
		pruneLightNodes(new Set());
		expect(light.color.getHex()).toBe(0xffffff);
	});
	it('lightLevel: initial on, no events = 1; a switch event fades', () => {
		expect(lightLevel([], 5, 0.3, true)).toBe(1);
		expect(lightLevel([], 5, 0.3, false)).toBe(0);
		expect(lightLevel([{ t: 5, dir: 0 }], 5.15, 0.3, true)).toBeCloseTo(0.5);
	});
});
